"""Scratch-only measurements for NativeProfileRuntime's UDS setup path."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import signal
import socket as socket_module
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from tests.support import temporary_bridge_home

SCRATCH = Path(os.environ.get("TMPDIR", tempfile.gettempdir())).resolve()
CLIENT_PATH = ROOT / "native-bridge" / "client.py"
RUNTIME_PATH = ROOT / "executor-plugin" / "native_runtime.py"
HEALTH_RESULT = {"ok": True, "protocolVersion": 1}


def _load_native_runtime():
    name = "runtime_performance_native_runtime"
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(name, RUNTIME_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load production native_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


class ConnectionMonitor:
    """Instrument the real client module without changing daemon sources."""

    def __init__(self, client_module):
        self.client_module = client_module
        self.metrics = self._empty_metrics()
        self.metrics_lock = threading.Lock()
        self.local = threading.local()
        self.original_probe = client_module._probe
        raw_socket = socket_module.socket
        monitor = self

        class CountingSocket:
            def __init__(self, *args, **kwargs):
                self.inner = raw_socket(*args, **kwargs)
                self.is_probe = bool(getattr(monitor.local, "inside_probe", False))

            def connect(self, address):
                monitor.increment("connect_attempts")
                try:
                    result = self.inner.connect(address)
                except OSError:
                    raise
                monitor.increment("successful_connections")
                if self.is_probe:
                    monitor.increment("probe_connections")
                return result

            def sendall(self, data):
                if self.is_probe:
                    try:
                        request = json.loads(data.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        request = None
                    if isinstance(request, dict) and request.get("method") == "health":
                        monitor.increment("health_probe_requests")
                return self.inner.sendall(data)

            def __getattr__(self, name):
                return getattr(self.inner, name)

        def counted_probe(home):
            self.increment("probe_calls")
            previous = bool(getattr(self.local, "inside_probe", False))
            self.local.inside_probe = True
            try:
                return self.original_probe(home)
            finally:
                self.local.inside_probe = previous

        self.original_socket_module = client_module.socket
        client_module.socket = types.SimpleNamespace(
            socket=CountingSocket,
            AF_UNIX=socket_module.AF_UNIX,
            SOCK_STREAM=socket_module.SOCK_STREAM,
        )
        client_module._probe = counted_probe

    @staticmethod
    def _empty_metrics():
        return {
            "probe_calls": 0,
            "health_probe_requests": 0,
            "connect_attempts": 0,
            "successful_connections": 0,
            "probe_connections": 0,
        }

    def increment(self, key):
        with self.metrics_lock:
            self.metrics[key] += 1

    def reset(self):
        with self.metrics_lock:
            self.metrics = self._empty_metrics()

    def restore(self):
        self.client_module._probe = self.original_probe
        self.client_module.socket = self.original_socket_module


class FaultingScratchBridge:
    """Tiny UDS fault fixture for sent-request disconnect and ID mismatch."""

    def __init__(self, home, mode):
        self.home = Path(home)
        self.mode = mode
        self.data_dir = self.home / "plugin-data" / "browser-link-native"
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.data_dir, 0o700)
        token_path = self.data_dir / "token"
        token_path.write_text("scratch-test-token", encoding="ascii")
        os.chmod(token_path, 0o600)
        self.socket_path = self.data_dir / "bridge.sock"
        self.server = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        self.server.bind(str(self.socket_path))
        self.server.listen(8)
        self.server.settimeout(0.1)
        self.stop_event = threading.Event()
        self.requests = []
        self.errors = []
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @staticmethod
    def _read_line(reader):
        line = reader.readline(1024 * 1024 + 1)
        if not line:
            raise EOFError("fixture client closed")
        return json.loads(line)

    @staticmethod
    def _send(connection, value):
        connection.sendall(json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n")

    def _serve(self):
        while not self.stop_event.is_set():
            try:
                connection, _ = self.server.accept()
            except socket_module.timeout:
                continue
            except OSError:
                return
            reader = connection.makefile("rb")
            try:
                hello = self._read_line(reader)
                request = self._read_line(reader)
                self.requests.append({"hello": hello, "request": request})
                if hello != {"role": "client", "token": "scratch-test-token"}:
                    self.errors.append("client auth frame mismatch")
                    continue
                request_id = request.get("id")
                if request.get("method") == "health":
                    if self.mode == "mismatch" and len(self.requests) == 1:
                        self._send(connection, {"id": "wrong-response-id", "result": HEALTH_RESULT})
                    else:
                        self._send(connection, {"id": request_id, "result": HEALTH_RESULT})
                elif request.get("method") == "shared.run" and self.mode == "disconnect":
                    # The operation reached the server, but no reply is delivered.
                    continue
                else:
                    self.errors.append("unexpected fixture request method")
            except (OSError, EOFError, ValueError, json.JSONDecodeError) as exc:
                if not self.stop_event.is_set():
                    self.errors.append(type(exc).__name__)
            finally:
                reader.close()
                connection.close()

    def close(self):
        self.stop_event.set()
        self.server.close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise AssertionError("faulting UDS fixture did not stop")


class ScratchExtensionPeer:
    """Minimal extension-role peer attached only to this test's scratch daemon."""

    def __init__(self, home, client_module, instance_id):
        self.home = Path(home)
        client_module.ensure_service(self.home)
        data_dir = self.home / "plugin-data" / "browser-link-native"
        self.socket = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        self.socket.settimeout(3)
        self.socket.connect(str(data_dir / "bridge.sock"))
        self.reader = self.socket.makefile("rb")
        self.write_lock = threading.Lock()
        self._send({"role": "extension", "token": (data_dir / "token").read_text(encoding="ascii").strip(),
                    "origin": "chrome-extension://scratch/"})
        result = self.request("extension.hello", {
            "instanceId": instance_id, "browser": "chrome", "version": "test"
        })
        if result != {"connected": True}:
            raise AssertionError("scratch extension registration failed")

    def _send(self, value):
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
        with self.write_lock:
            self.socket.sendall(payload)

    def _next(self):
        line = self.reader.readline(1024 * 1024 + 1)
        if not line:
            raise EOFError("scratch daemon disconnected extension peer")
        return json.loads(line)

    def request(self, method, params):
        request_id = "ext:" + os.urandom(12).hex()
        self._send({"id": request_id, "method": method, "params": params})
        while True:
            message = self._next()
            if message.get("id") == request_id:
                if "error" in message:
                    raise AssertionError("scratch extension request failed: " + str(message["error"].get("code")))
                return message.get("result")
            if "id" in message:
                raise AssertionError("unexpected response while waiting for extension request")

    def receive_request(self, method):
        while True:
            message = self._next()
            if "id" not in message:
                continue
            if message.get("method") != method:
                raise AssertionError("expected " + method + ", got " + str(message.get("method")))
            return message

    def respond(self, request, result=None, error=None):
        response = {"id": request["id"]}
        if error is not None:
            response["error"] = error
        else:
            response["result"] = result
        self._send(response)

    def close(self):
        try:
            self.socket.shutdown(socket_module.SHUT_RDWR)
        except OSError:
            pass
        self.reader.close()
        self.socket.close()


class NativeRuntimeConnectionBudgetTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.home = self.enterContext(temporary_bridge_home())
        socket_path = self.home / "plugin-data" / "browser-link-native" / "bridge.sock"
        self.assertLessEqual(len(os.fsencode(socket_path)), 103, str(socket_path))

        self.runtime_module = _load_native_runtime()
        self.client_module = self.runtime_module.load_module(
            CLIENT_PATH, "runtime_performance_real_client_"
        )
        # 中文注释：测试持有自己创建的 Popen，不依赖系统进程扫描，也不终止其他 daemon。
        self.processes = []
        self.original_spawn = self.client_module._spawn_detached
        def spawn_owned(argv):
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            self.processes.append(process)
        self.client_module._spawn_detached = spawn_owned
        self.monitor = ConnectionMonitor(self.client_module)
        self.profile = self.runtime_module.NativeProfileRuntime(
            self.home, ROOT / "executor-plugin"
        )
        self.profile._client_module = self.client_module

    def tearDown(self):
        self.profile.close()
        self.monitor.restore()
        self._stop_scratch_daemon()
        self.client_module._spawn_detached = self.original_spawn

    def _stop_scratch_daemon(self):
        pid_path = self.home / "plugin-data" / "browser-link-native" / "daemon.pid"
        if not pid_path.is_file():
            return
        try:
            pid = int(pid_path.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            self.fail("scratch daemon pid file is unreadable; refusing broad process cleanup")
        process = next((process for process in self.processes if process.pid == pid), None)
        self.assertIsNotNone(process, 'only a fixture-owned process may be stopped')
        process.terminate()
        process.wait(timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and pid_path.exists():
            time.sleep(0.02)
        self.assertFalse(pid_path.exists(), "scratch daemon did not remove its pid file on shutdown")

    def test_first_call_starts_a_cold_scratch_daemon(self):
        result = self.profile.call("health", {})

        self.assertEqual(result, HEALTH_RESULT)
        pid_path = self.home / "plugin-data" / "browser-link-native" / "daemon.pid"
        self.assertTrue(pid_path.is_file())
        self.assertGreater(self.monitor.metrics["probe_calls"], 0)
        self.assertGreater(self.monitor.metrics["health_probe_requests"], 0)
        self.assertEqual(
            self.monitor.metrics["successful_connections"],
            self.monitor.metrics["health_probe_requests"] + 1,
        )

    def test_profile_call_recovers_after_scratch_daemon_restart(self):
        self.client_module.ensure_service(self.home)
        self.profile.call("health", {})
        old_pid_path = self.home / "plugin-data" / "browser-link-native" / "daemon.pid"
        self.assertTrue(old_pid_path.is_file())
        self._stop_scratch_daemon()
        self.monitor.reset()
        # 中文注释：空闲长连接在发送前就能发现 daemon 已关闭，请求未发出，直接重连而不是报告未知。
        result = self.profile.call("health", {})
        self.assertEqual(result, HEALTH_RESULT)
        new_pid_path = self.home / "plugin-data" / "browser-link-native" / "daemon.pid"
        self.assertTrue(new_pid_path.is_file())
        new_pid = int(new_pid_path.read_text(encoding="ascii").strip())
        self.assertGreater(new_pid, 0)
        self.assertGreater(self.monitor.metrics["health_probe_requests"], 0)
        self.assertEqual(
            self.monitor.metrics["successful_connections"],
            self.monitor.metrics["health_probe_requests"] + 1,
        )

    def test_sent_write_disconnect_is_unknown_and_never_replayed(self):
        bridge = FaultingScratchBridge(self.home, "disconnect")
        try:
            with self.assertRaises(self.client_module.BridgeError) as caught:
                self.profile.call("shared.run", {
                    "owner": "scratch-owner",
                    "taskId": "scratch-task",
                    "requestId": "one-write-only",
                    "action": "click",
                    "tabId": 1,
                    "selector": "#submit",
                })

            self.assertEqual(caught.exception.code, "outcome_unknown")
            dispatched = [item["request"] for item in bridge.requests
                          if item["request"].get("method") == "shared.run"]
            self.assertEqual(len(dispatched), 1)
            self.assertEqual(bridge.errors, [])
        finally:
            bridge.close()

    def test_response_id_mismatch_still_fails_closed(self):
        bridge = FaultingScratchBridge(self.home, "mismatch")
        try:
            with self.assertRaises(self.client_module.BridgeError) as caught:
                self.profile.call("health", {})

            self.assertEqual(caught.exception.code, "protocol_error")
            self.assertEqual(len(bridge.requests), 1)
            self.assertEqual(bridge.requests[0]["request"]["method"], "health")
            self.assertEqual(bridge.requests[0]["request"]["method"], "health")
            self.assertEqual(bridge.errors, [])
        finally:
            bridge.close()

    def test_daemon_still_rejects_a_foreign_owner(self):
        peer = ScratchExtensionPeer(self.home, self.client_module, "owner-scope-instance")
        try:
            task = self.profile.call("shared.create", {
                "owner": "trusted-owner",
                "title": "scratch owner check",
                "instanceId": "owner-scope-instance",
                "allowedOrigins": ["https://example.test"],
            })
            with self.assertRaises(self.client_module.BridgeError) as caught:
                self.profile.call("shared.get", {
                    "owner": "foreign-owner",
                    "taskId": task["id"],
                })

            self.assertEqual(caught.exception.code, "forbidden")
        finally:
            peer.close()

    def test_concurrent_cancel_can_finish_while_a_write_is_in_flight(self):
        peer = ScratchExtensionPeer(self.home, self.client_module, "cancel-instance")
        try:
            origins = ["https://example.test"]
            task = self.profile.call("shared.create", {
                "owner": "cancel-owner",
                "title": "scratch concurrent cancellation",
                "instanceId": "cancel-instance",
                "allowedOrigins": origins,
            })
            approved = peer.request("extension.approve", {
                "taskId": task["id"], "tabIds": [21], "allowedOrigins": origins
            })
            self.assertEqual(approved["state"], "ready")
            mode = peer.request("extension.mode", {
                "taskId": task["id"], "mode": "full", "generation": 1, "modeGeneration": 1
            })
            self.assertEqual(mode["activeMode"], "full")
            self.monitor.reset()

            with ThreadPoolExecutor(max_workers=2) as pool:
                running = pool.submit(self.profile.call, "shared.run", {
                    "owner": "cancel-owner",
                    "taskId": task["id"],
                    "requestId": "one-in-flight-write",
                    "action": "new_tab",
                    "url": "https://example.test/new",
                })
                execute = peer.receive_request("browser.execute")
                cancelling = pool.submit(self.profile.call, "shared.cancel", {
                    "owner": "cancel-owner", "taskId": task["id"]
                })
                release = peer.receive_request("browser.release")
                self.assertTrue(release["params"]["closeAgentTabs"])
                peer.respond(release, {"released": True})
                self.assertEqual(cancelling.result(timeout=3)["state"], "cancelled")
                self.assertFalse(running.done(), "in-flight write unexpectedly completed before its response")

                peer.respond(execute, {"tabId": 99, "url": "https://example.test/new"})
                late_cleanup = peer.receive_request("browser.release")
                self.assertFalse(late_cleanup["params"]["closeAgentTabs"])
                peer.respond(late_cleanup, {"released": True})
                with self.assertRaises(self.client_module.BridgeError) as caught:
                    running.result(timeout=3)
                self.assertEqual(caught.exception.code, "cancelled")

            self.assertEqual(self.monitor.metrics["probe_calls"], 0)
            self.assertEqual(self.monitor.metrics["health_probe_requests"], 0)
            self.assertEqual(self.monitor.metrics["successful_connections"], 2)
        finally:
            peer.close()

    def test_javascript_client_deadline_exceeds_daemon_deadline_then_resets(self):
        # 中文注释：用真实 socket 核对长脚本期限，无需实际等待 60 秒；普通调用必须恢复原期限。
        peer = ScratchExtensionPeer(self.home, self.client_module, 'js-deadline')
        try:
            origins = ['https://example.test']
            task = self.profile.call('shared.create', {'owner': 'js-owner', 'title': 'deadline',
                'instanceId': 'js-deadline', 'allowedOrigins': origins})
            peer.request('extension.approve', {'taskId': task['id'], 'tabIds': [21], 'allowedOrigins': origins})
            peer.request('extension.mode', {'taskId': task['id'], 'mode': 'full', 'generation': 1, 'modeGeneration': 1})
            with ThreadPoolExecutor(max_workers=1) as pool:
                running = pool.submit(self.profile.call, 'shared.run', {'owner': 'js-owner', 'taskId': task['id'],
                    'requestId': 'long-js', 'action': 'js.evaluate', 'tabId': 21,
                    'expression': '1', 'timeoutMs': 60000})
                execute = peer.receive_request('browser.execute')
                try:
                    client = next(client for thread, client in self.profile._thread_clients.items()
                                  if thread is not threading.current_thread())
                    self.assertGreater(client._socket.gettimeout(), 75)
                finally:
                    peer.respond(execute, {'value': 1})
                    running.result(timeout=3)
                self.assertEqual(pool.submit(self.profile.call, 'health', {}).result(timeout=3), HEALTH_RESULT)
                self.assertEqual(client._socket.gettimeout(), 35)
        finally:
            peer.close()

    def test_healthy_rpcs_reuse_one_connection_without_probe(self):
        self.client_module.ensure_service(self.home)
        self.monitor.reset()

        result = self.profile.call("health", {})

        self.assertEqual(result, HEALTH_RESULT)
        self.assertEqual(self.profile.call("health", {}), HEALTH_RESULT)
        self.assertEqual(self.monitor.metrics["successful_connections"], 1)
        self.assertEqual(self.monitor.metrics["probe_connections"], 0)
        self.assertEqual(self.monitor.metrics["probe_calls"], 0)
        self.assertEqual(self.monitor.metrics["health_probe_requests"], 0)


if __name__ == "__main__":
    unittest.main()
