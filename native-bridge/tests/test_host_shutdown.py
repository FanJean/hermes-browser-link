"""用真实管道与隔离 UDS 验证 Native host 的消息帧和退出。"""

import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest


BRIDGE_DIR = Path(__file__).resolve().parents[1]
ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"


class NativeHostShutdownTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hs-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name)
        data = home / "plugin-data" / "browser-link-native"
        data.mkdir(parents=True)
        (data / "token").write_text("fixture-token", encoding="ascii")
        (data / "host-config.json").write_text(json.dumps({"allowedOrigins": [ORIGIN]}))
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(str(data / "bridge.sock"))
        server.listen(1)
        server.settimeout(2)
        # 中文注释：只连接测试套接字，绝不启动或重启用户的 Hermes daemon。
        script = "import sys; sys.path.insert(0, sys.argv.pop(1)); import host; host.ensure_service = lambda home: None; raise SystemExit(host.main())"
        self.process = subprocess.Popen(
            [sys.executable, "-c", script, str(BRIDGE_DIR), ORIGIN],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, "HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.addCleanup(self._cleanup_process)
        self.peer, _ = server.accept()
        self.addCleanup(self.peer.close)
        self.peer.settimeout(2)
        self.reader = self.peer.makefile("rb")
        self.addCleanup(self.reader.close)
        hello = json.loads(self.reader.readline())
        self.assertEqual(hello, {"role": "extension", "token": "fixture-token", "origin": ORIGIN})

    def _cleanup_process(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()

    def _close_bridge(self):
        self.peer.shutdown(socket.SHUT_RDWR)

    def _assert_clean_exit(self):
        # 中文注释：旧实现会等待约一秒后 abort，先终止超时夹具，避免制造系统崩溃弹窗。
        try:
            code = self.process.wait(timeout=0.8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
            self.fail("Native host 在断连后未及时退出")
        stderr = self.process.stderr.read()
        self.assertEqual(code, 0, stderr.decode(errors="replace"))
        self.assertEqual(stderr, b"")

    def test_bridge_eof_with_browser_input_still_open(self):
        self._close_bridge()
        self._assert_clean_exit()

    def test_bridge_eof_during_partial_native_header(self):
        self.process.stdin.write(b"\x20\x00")
        self.process.stdin.flush()
        self._close_bridge()
        self._assert_clean_exit()

    def test_bridge_eof_during_partial_native_payload(self):
        self.process.stdin.write(struct.pack("<I", 32) + b'{"id":')
        self.process.stdin.flush()
        self._close_bridge()
        self._assert_clean_exit()

    def test_browser_eof_while_bridge_waits_for_message(self):
        self.process.stdin.close()
        self._assert_clean_exit()

    def test_browser_eof_during_partial_bridge_frame(self):
        self.peer.sendall(b'{"id":')
        self.process.stdin.close()
        self._assert_clean_exit()

    def test_browser_eof_when_browser_does_not_drain_output(self):
        payload = json.dumps({"result": "x" * 256_000}).encode() + b"\n"
        self.peer.sendall(payload)
        self.assertTrue(select.select([self.process.stdout], [], [], 2)[0])
        self.process.stdin.close()
        self._assert_clean_exit()

    def test_broken_browser_output(self):
        self.process.stdout.close()
        self.peer.sendall(b'{"result":true}\n')
        self._assert_clean_exit()

    def test_oversized_native_frame_is_rejected(self):
        self.process.stdin.write(struct.pack("<I", 1024 * 1024 + 1))
        self.process.stdin.flush()
        self._assert_clean_exit()
        self.assertEqual(self.reader.read(), b"")

    def test_invalid_bridge_frame_is_rejected(self):
        self.peer.sendall(b"[]\n")
        self._assert_clean_exit()
        self.assertEqual(self.process.stdout.read(), b"")

    def test_fragmented_native_frame_and_large_response_are_preserved(self):
        request = {"id": "request-1", "method": "extension.tasks", "params": {}}
        payload = json.dumps(request).encode()
        framed = struct.pack("<I", len(payload)) + payload
        for chunk in (framed[:2], framed[2:9], framed[9:]):
            self.process.stdin.write(chunk)
            self.process.stdin.flush()
        self.assertEqual(json.loads(self.reader.readline()), request)
        response = {"id": "request-1", "result": "中文" * 60_000}
        self.peer.sendall(json.dumps(response, ensure_ascii=False).encode() + b"\n")
        deadline = time.monotonic() + 2

        def read_exact(size):
            chunks = []
            while size:
                remaining = max(0, deadline - time.monotonic())
                self.assertTrue(select.select([self.process.stdout], [], [], remaining)[0])
                chunk = os.read(self.process.stdout.fileno(), size)
                self.assertTrue(chunk)
                chunks.append(chunk)
                size -= len(chunk)
            return b"".join(chunks)

        size = struct.unpack("<I", read_exact(4))[0]
        self.assertEqual(json.loads(read_exact(size)), response)
        self.process.stdin.close()
        self._assert_clean_exit()


class NativeHostHistoryIntegrationTests(unittest.TestCase):
    def test_large_history_cleanup_over_real_host_and_daemon_keeps_connection_open(self):
        sys.path.insert(0, str(BRIDGE_DIR))
        from client import ensure_service
        from tests.support import stop_fixture_daemon

        temp = tempfile.TemporaryDirectory(prefix="hh-", dir="/tmp")
        self.addCleanup(temp.cleanup)
        home = Path(temp.name).resolve()
        data = home / "plugin-data" / "browser-link-native"
        data.mkdir(parents=True, mode=0o700)
        operation = {"action": "snapshot", "state": "succeeded", "startedAt": 1, "completedAt": 2, "durationMs": 1000}
        tasks = [{"id": f"history-{index}", "owner": "fixture-owner", "instanceId": "fixture-browser",
                  "title": "fixture-history", "browser": "chrome", "state": "closed", "generation": 1,
                  "allowedOrigins": ["https://example.test"], "tabIds": [], "agentTabIds": [],
                  "createdAt": 1, "updatedAt": 2, "cleanupState": "succeeded", "workspaceState": "closed",
                  "operationTimeline": [operation] * 32} for index in range(500)]
        path = data / "tasks.json"
        path.write_text(json.dumps({"version": 1, "tasks": tasks}))
        path.chmod(0o600)
        (data / "host-config.json").write_text(json.dumps({"allowedOrigins": [ORIGIN]}))
        ensure_service(home)
        self.addCleanup(stop_fixture_daemon, home)
        process = subprocess.Popen([sys.executable, str(BRIDGE_DIR / "host.py"), ORIGIN],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, "HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"})

        def cleanup_process():
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        self.addCleanup(cleanup_process)

        def request(request_id, method, params):
            payload = json.dumps({"id": request_id, "method": method, "params": params}).encode()
            process.stdin.write(struct.pack("<I", len(payload)) + payload)
            process.stdin.flush()
            deadline = time.monotonic() + 2

            def read_exact(size):
                result = bytearray()
                while len(result) < size:
                    self.assertTrue(select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0])
                    chunk = os.read(process.stdout.fileno(), size - len(result))
                    self.assertTrue(chunk)
                    result.extend(chunk)
                return result

            while True:
                size = struct.unpack("<I", read_exact(4))[0]
                self.assertLess(size, 1024 * 1024)
                response = json.loads(read_exact(size))
                if response.get('method') == 'tasks.changed':
                    continue
                self.assertEqual(response['id'], request_id)
                return response['result']

        hello = request("hello", "extension.hello", {"instanceId": "fixture-browser", "browser": "edge", "version": "fixture"})
        self.assertTrue(hello['connected'])
        records = request("cleanup", "extension.tasks", {"includeClosed": True})
        self.assertEqual(len(records), 500)
        self.assertTrue(all(set(row) == {'id', 'instanceId', 'generation', 'state', 'tabIds'} for row in records))
        self.assertEqual(request("normal-read", "extension.tasks", {}), [])
        # 中文注释：清理响应后连接仍可用，磁盘上的完整历史详情没有被裁剪。
        self.assertEqual(json.loads(path.read_text())['tasks'][0]['operationTimeline'], [operation] * 32)
        process.stdin.close()
        self.assertEqual(process.wait(timeout=0.8), 0)
        self.assertEqual(process.stderr.read(), b"")


if __name__ == "__main__":
    unittest.main()
