import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import socket
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Any

from client import _probe, ensure_service

MAX_LINE = 1024 * 1024


@contextmanager
def temporary_bridge_home():
    # 中文注释：不绕过指定 TMPDIR；短随机目录保留真实 UDS 覆盖，不再写系统 /tmp。
    root = Path(tempfile.gettempdir()).resolve()
    for _ in range(100):
        home = root / uuid.uuid4().hex[:3]
        if len(os.fsencode(home / 'plugin-data/browser-link-native/bridge.sock')) > 103:
            raise ValueError('TMPDIR is too long for a fixture bridge socket')
        try:
            home.mkdir(mode=0o700)
            break
        except FileExistsError:
            continue
    else:
        raise RuntimeError('could not allocate a private fixture home')
    try:
        yield home
    finally:
        shutil.rmtree(home)


def encode_line(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


def read_line(reader):
    line = reader.readline(MAX_LINE + 1)
    if not line:
        raise EOFError
    return json.loads(line)


def stop_fixture_daemon(home: Path, extra_daemons=()):
    data_dir = Path(home) / "plugin-data" / "browser-link-native"
    pid_path = data_dir / "daemon.pid"
    if not pid_path.exists():
        return
    raw = pid_path.read_text(encoding="ascii").strip()
    pid = int(raw)
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    candidates = (Path(__file__).resolve().parents[1] / "daemon.py",
                  Path(home) / "plugins/browser-link/native_bridge/daemon.py",
                  data_dir / "host-bin/daemon.py", *map(Path, extra_daemons))
    expected = any(command.stdout.strip().endswith(f" {candidate} --home {Path(home).resolve()}")
                   for candidate in candidates)
    # 中文注释：PID 文件只含数字；认证探活和完整启动命令均匹配后才允许清理临时 daemon。
    if command.returncode != 0 or not expected or not _probe(Path(home)):
        raise RuntimeError("refusing to stop unverified fixture daemon")
    if pid_path.read_text(encoding="ascii").strip() != raw:
        raise RuntimeError("fixture daemon PID changed during verification")
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 3
    while pid_path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    if pid_path.exists() and pid_path.read_text(encoding="ascii").strip() == raw:
        raise RuntimeError("fixture daemon did not terminate")


class ExtensionPeer:
    def __init__(self, home: Path, instance_id="instance-a", browser="chrome", capabilities=None):
        ensure_service(home)
        self.home = Path(home)
        data_dir = self.home / "plugin-data" / "browser-link-native"
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(3)
        self.socket.connect(str(data_dir / "bridge.sock"))
        self.reader = self.socket.makefile("rb")
        self.write_lock = threading.Lock()
        token = (data_dir / "token").read_text().strip()
        self.send({"role": "extension", "token": token, "origin": "chrome-extension://test/"})
        hello_params: dict[str, Any] = {"instanceId": instance_id, "browser": browser, "version": "0.1.0"}
        if capabilities is not None:
            hello_params["capabilities"] = dict(capabilities)
        result = self.request("extension.hello", hello_params)
        if not isinstance(result, dict) or result.get("connected") is not True:
            raise AssertionError(result)
        self.hello_result = result
        self.connection_generation = result.get("connectionGeneration")

    def send(self, value):
        with self.write_lock:
            self.socket.sendall(encode_line(value))

    def next_message(self):
        return read_line(self.reader)

    def request(self, method, params):
        request_id = "ext:" + uuid.uuid4().hex
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            message = self.next_message()
            if message.get("id") == request_id:
                if "error" in message:
                    return {"error": message["error"]}
                return message.get("result")
            if "id" not in message:
                continue
            raise AssertionError(f"unexpected server request while waiting: {message}")

    def receive_request(self, method):
        while True:
            message = self.next_message()
            if "id" not in message:
                continue
            if message.get("method") != method:
                raise AssertionError(f"expected {method}, got {message}")
            return message

    def respond(self, request, result=None, error=None):
        value = {"id": request["id"]}
        if error is not None:
            value["error"] = error
        else:
            value["result"] = result
        self.send(value)

    def close(self):
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.reader.close()
        self.socket.close()
