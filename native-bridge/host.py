#!/usr/bin/env python3
"""Chromium Native Messaging host forwarding framed JSON to the local UDS."""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import socket
import struct
import sys
import threading
from typing import Any, ContextManager, Dict

from client import ensure_service

_MAX_MESSAGE = 1024 * 1024


class _NativePipe:
    """可取消的无缓冲管道，避免退出时争用 Python 标准流的缓冲锁。"""

    def __init__(self, fd: int, stopped: threading.Event):
        self.fd = fd
        self.stopped = stopped

    def _wait(self, *, writing: bool = False) -> None:
        while not self.stopped.is_set():
            readable, writable, _ = select.select(
                [] if writing else [self.fd], [self.fd] if writing else [], [], 0.1
            )
            if readable or writable:
                return
        raise EOFError

    def read(self, size: int) -> bytes:
        while True:
            self._wait()
            try:
                return os.read(self.fd, size)
            except BlockingIOError:
                continue

    def write(self, payload: bytes) -> None:
        remaining = memoryview(payload)
        while remaining:
            self._wait(writing=True)
            try:
                written = os.write(self.fd, remaining)
            except BlockingIOError:
                continue
            remaining = remaining[written:]

    def flush(self) -> None:
        # 中文注释：os.write 已直接写入管道，无 Python 缓冲需要刷新。
        pass


def _read_exact(stream, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_native_message(stream) -> Dict[str, Any]:
    size = struct.unpack("<I", _read_exact(stream, 4))[0]
    if size > _MAX_MESSAGE:
        raise ValueError("native message exceeds limit")
    value = json.loads(_read_exact(stream, size))
    if not isinstance(value, dict):
        raise ValueError("native message must be an object")
    return value


def write_native_message(stream, value: Dict[str, Any], lock: threading.Lock) -> None:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_MESSAGE:
        raise ValueError("native message exceeds limit")
    with lock:
        stream.write(struct.pack("<I", len(payload)))
        stream.write(payload)
        stream.flush()


def _read_json_line(reader) -> Dict[str, Any]:
    line = reader.readline(_MAX_MESSAGE + 1)
    if not line:
        raise EOFError
    if len(line) > _MAX_MESSAGE or not line.endswith(b"\n"):
        raise ValueError("invalid bridge frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("bridge frame must be an object")
    return value


def _write_json_line(sock: socket.socket, value: Dict[str, Any], lock: ContextManager[Any]) -> None:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > _MAX_MESSAGE:
        raise ValueError("bridge frame exceeds limit")
    with lock:
        sock.sendall(payload + b"\n")


def _load_allowed_origins(data_dir: Path) -> set[str]:
    config_path = data_dir / "host-config.json"
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return set()
    origins = value.get("allowedOrigins", []) if isinstance(value, dict) else []
    return {origin for origin in origins if isinstance(origin, str)}


def main() -> int:
    if len(sys.argv) < 2:
        return 2
    origin = sys.argv[1]
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
    data_dir = home / "plugin-data" / "browser-link-native"
    if origin not in _load_allowed_origins(data_dir):
        return 3

    ensure_service(home)
    token = (data_dir / "token").read_text(encoding="ascii").strip()
    bridge = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bridge.connect(str(data_dir / "bridge.sock"))
    bridge_reader = bridge.makefile("rb")
    socket_write_lock = threading.RLock()
    native_write_lock = threading.Lock()

    stopped = threading.Event()
    input_fd, output_fd = sys.stdin.fileno(), sys.stdout.fileno()
    native_input = _NativePipe(input_fd, stopped)
    native_output = _NativePipe(output_fd, stopped)

    def native_to_bridge() -> None:
        try:
            while not stopped.is_set():
                _write_json_line(bridge, read_native_message(native_input), socket_write_lock)
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            stopped.set()
            try:
                bridge.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def bridge_to_native() -> None:
        try:
            while not stopped.is_set():
                write_native_message(native_output, _read_json_line(bridge_reader), native_write_lock)
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            stopped.set()

    input_thread = threading.Thread(target=native_to_bridge)
    output_thread = threading.Thread(target=bridge_to_native)
    original_blocking = {fd: os.get_blocking(fd) for fd in (input_fd, output_fd)}
    try:
        # 中文注释：半截帧和浏览器不读输出时也不能阻止线程收到退出信号。
        for fd in original_blocking:
            os.set_blocking(fd, False)
        # 中文注释：两泵启动后才宣布连接；锁让浏览器提前发送的帧仍排在认证之后。
        with socket_write_lock:
            input_thread.start()
            output_thread.start()
            try:
                _write_json_line(bridge, {"role": "extension", "token": token, "origin": origin}, socket_write_lock)
            except OSError:
                stopped.set()
        stopped.wait()
    finally:
        stopped.set()
        try:
            bridge.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        # 中文注释：先唤醒 socket 读写并等待两个线程结束，再关闭 reader；标准流不提前关闭。
        for thread in (input_thread, output_thread):
            if thread.ident is not None:
                thread.join()
        bridge_reader.close()
        bridge.close()
        for fd, blocking in original_blocking.items():
            os.set_blocking(fd, blocking)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
