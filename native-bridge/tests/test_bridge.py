import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))

from client import BridgeClient, BridgeError, ensure_service  # noqa: E402
from tests.support import stop_fixture_daemon  # noqa: E402


class BridgeIntegrationTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes" / "cache" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="bn-", dir=scratch)
        self.home = Path(self.temp.name) / "h"

    def tearDown(self):
        stop_fixture_daemon(self.home)
        self.temp.cleanup()

    def test_ensure_service_starts_real_uds_with_private_permissions(self):
        ensure_service(self.home)
        client = BridgeClient(self.home)
        try:
            self.assertEqual(client.call("health", {}), {"ok": True, "protocolVersion": 1})
        finally:
            client.close()

        data_dir = self.home / "plugin-data" / "browser-link-native"
        socket_path = data_dir / "bridge.sock"
        token_path = data_dir / "token"
        self.assertTrue(stat.S_ISSOCK(socket_path.stat().st_mode))
        self.assertEqual(stat.S_IMODE(data_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(socket_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)
        self.assertGreaterEqual(len(token_path.read_text().strip()), 32)

    def test_native_host_framing_registers_extension_over_real_uds(self):
        ensure_service(self.home)
        data_dir = self.home / "plugin-data" / "browser-link-native"
        origin = "chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/"
        (data_dir / "host-config.json").write_text(
            json.dumps({"allowedOrigins": [origin]}), encoding="utf-8"
        )
        env = dict(os.environ, HERMES_HOME=str(self.home))
        process = subprocess.Popen(
            [sys.executable, str(BRIDGE_DIR / "host.py"), origin],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        assert process.stdin is not None and process.stdout is not None
        hello = {
            "id": "hello-1",
            "method": "extension.hello",
            "params": {"instanceId": "chrome-profile-a", "browser": "chrome", "version": "0.1.0"},
        }
        payload = json.dumps(hello, separators=(",", ":")).encode()
        process.stdin.write(struct.pack("<I", len(payload)) + payload)
        process.stdin.flush()
        size = struct.unpack("<I", process.stdout.read(4))[0]
        response = json.loads(process.stdout.read(size))
        self.assertEqual(response, {"id": "hello-1", "result": {"connected": True}})

        client = BridgeClient(self.home)
        try:
            self.assertEqual(
                client.call("browser.list", {}),
                [{"instanceId": "chrome-profile-a", "browser": "chrome", "version": "0.1.0", "connected": True,
                  # 中文注释：旧握手未声明能力，宿主应明确返回空列表。
                  "features": [], "consentStatus": "unknown", "accessRequestSupported": False}],
            )
        finally:
            client.close()
            process.terminate()
            process.wait(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()

    def test_native_host_rejects_non_allowlisted_origin_without_token_output(self):
        data_dir = self.home / "plugin-data" / "browser-link-native"
        data_dir.mkdir(parents=True, exist_ok=True)
        token = "never-print-this-token"
        (data_dir / "token").write_text(token)
        allowed = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        (data_dir / "host-config.json").write_text(json.dumps({"allowedOrigins": [allowed]}))
        env = dict(os.environ, HERMES_HOME=str(self.home))
        completed = subprocess.run(
            [sys.executable, str(BRIDGE_DIR / "host.py"), "chrome-extension://pppppppppppppppppppppppppppppppp/"],
            input=b"",
            capture_output=True,
            env=env,
            timeout=2,
        )
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(completed.stdout, b"")
        self.assertNotIn(token.encode(), completed.stderr)

    def test_concurrent_startup_has_one_daemon(self):
        def start():
            ensure_service(self.home)

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _index: start(), range(8)))
        data_dir = self.home / "plugin-data" / "browser-link-native"
        pid = int((data_dir / "daemon.pid").read_text())
        self.assertGreater(pid, 0)
        process_list = subprocess.run(
            ["ps", "-axo", "pid=,command="], check=True, capture_output=True, text=True
        ).stdout.splitlines()
        marker = f"daemon.py --home {self.home}"
        matching = [line for line in process_list if marker in line]
        self.assertEqual(len(matching), 1, matching)
        ensure_service(self.home)
        self.assertEqual(int((data_dir / "daemon.pid").read_text()), pid)

    def test_installer_stages_chrome_and_edge_manifests_only_in_isolated_home(self):
        isolated_home = Path(self.temp.name) / "mac-home"
        origin = "chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/"
        subprocess.run(
            [
                sys.executable,
                str(BRIDGE_DIR / "install.py"),
                "stage",
                "--home",
                str(isolated_home),
                "--extension-origin",
                origin,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        manifest_paths = [
            isolated_home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.browser_link.json",
            isolated_home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.hermes.browser_link.json",
        ]
        for manifest_path in manifest_paths:
            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest["name"], "com.hermes.browser_link")
            self.assertEqual(manifest["type"], "stdio")
            self.assertEqual(manifest["allowed_origins"], [origin])
            host_path = Path(manifest["path"])
            self.assertTrue(host_path.is_file())
            self.assertTrue(os.access(host_path, os.X_OK))
            self.assertTrue(str(host_path).startswith(str(isolated_home)))
        config = isolated_home / ".hermes/plugin-data/browser-link-native/host-config.json"
        self.assertEqual(json.loads(config.read_text()), {"allowedOrigins": [origin]})

    def test_client_does_not_replay_request_after_response_is_lost(self):
        data_dir = self.home / "plugin-data" / "browser-link-native"
        data_dir.mkdir(parents=True, mode=0o700)
        token = "test-token-value"
        (data_dir / "token").write_text(token)
        # 中文注释：丢回执夹具必须先满足真实客户端的私有令牌权限，否则根本没有发送动作。
        (data_dir / "token").chmod(0o600)
        socket_path = data_dir / "bridge.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(8)
        server.settimeout(0.2)
        seen_requests = []
        stopped = threading.Event()

        def serve():
            while not stopped.is_set():
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                reader = connection.makefile("rb")
                try:
                    json.loads(reader.readline())
                    request = json.loads(reader.readline())
                    if request["method"] == "health":
                        response = {
                            "id": request["id"],
                            "result": {"ok": True, "protocolVersion": 1},
                        }
                        connection.sendall(json.dumps(response, separators=(",", ":")).encode() + b"\n")
                    else:
                        seen_requests.append(request)
                finally:
                    reader.close()
                    connection.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        client = BridgeClient(self.home, timeout=1)
        try:
            with self.assertRaises(BridgeError) as caught:
                client.call(
                    "shared.create",
                    {
                        "owner": "owner",
                        "title": "must-not-replay",
                        "instanceId": "instance",
                        "allowedOrigins": ["https://example.com"],
                    },
                )
            self.assertEqual(caught.exception.code, "outcome_unknown")
            self.assertEqual(len(seen_requests), 1)
        finally:
            client.close()
            stopped.set()
            thread.join(timeout=1)
            server.close()


if __name__ == "__main__":
    unittest.main()
