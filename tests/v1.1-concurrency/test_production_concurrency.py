"""V1.1 concurrency regressions through the production daemon dispatcher."""
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
BRIDGE_DIR = ROOT / "native-bridge"
sys.path.insert(0, str(BRIDGE_DIR))

from client import BridgeClient, BridgeError, ensure_service  # noqa: E402
from tests.support import stop_fixture_daemon  # noqa: E402

ORIGIN = "https://example.test"
INSTANCE = {"chrome": "chrome-synthetic", "edge": "edge-synthetic"}


class DroppingResponseProxy:
    """Forward a real client request to the daemon, then drop its response."""

    def __init__(self, daemon_socket, proxy_socket, request_id):
        self.daemon_socket = str(daemon_socket)
        self.proxy_socket = str(proxy_socket)
        self.request_id = request_id
        self.ready = threading.Event()
        self.stopping = threading.Event()
        self.error = None
        self.dropped_request_count = 0
        self.dropped_response = None
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._listener.bind(self.proxy_socket)
        os.chmod(self.proxy_socket, 0o600)
        self._listener.listen(8)
        self._listener.settimeout(0.1)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        if not self.ready.wait(2):
            raise RuntimeError("response-loss proxy did not start")

    @staticmethod
    def _line(reader):
        line = reader.readline(1024 * 1024 + 1)
        if not line:
            raise EOFError
        if len(line) > 1024 * 1024 or not line.endswith(b"\n"):
            raise ValueError("invalid proxy frame")
        return line

    def _serve_connection(self, client):
        backend = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            backend.connect(self.daemon_socket)
            client_reader = client.makefile("rb")
            backend_reader = backend.makefile("rb")
            hello = self._line(client_reader)
            backend.sendall(hello)
            while not self.stopping.is_set():
                try:
                    line = self._line(client_reader)
                except EOFError:
                    return
                request = json.loads(line)
                backend.sendall(line)
                response_line = self._line(backend_reader)
                response = json.loads(response_line)
                if (request.get("method") == "shared.run"
                        and request.get("params", {}).get("requestId") == self.request_id):
                    self.dropped_request_count += 1
                    self.dropped_response = response
                    # The daemon has finished dispatch and produced its result;
                    # simulate only loss of that response on the client leg.
                    return
                client.sendall(response_line)
        finally:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.close()
            try:
                backend.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            backend.close()

    def _serve(self):
        self.ready.set()
        while not self.stopping.is_set():
            try:
                client, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self._serve_connection(client)
            except (OSError, EOFError, ValueError, json.JSONDecodeError) as error:
                if not self.stopping.is_set():
                    self.error = error

    def close(self):
        self.stopping.set()
        self._listener.close()
        self._thread.join(timeout=2)
        try:
            Path(self.proxy_socket).unlink()
        except FileNotFoundError:
            pass


class ProductionConcurrencyTests(unittest.TestCase):
    """Real daemon/client/Bridge/Executor; only browser APIs are synthetic."""

    def setUp(self):
        scratch = (Path(tempfile.gettempdir())).resolve()
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="c12-", dir=scratch)
        self.work = Path(self.temp.name)
        self.home = self.work / "h"
        self.home.mkdir()
        self.socket_path = self.home / "plugin-data" / "browser-link-native" / "bridge.sock"
        self.assertLess(len(os.fsencode(self.socket_path)), 104, "fixture AF_UNIX path exceeds macOS limit")
        self.peer = None
        self.reader_thread = None
        self.messages = queue.Queue()
        self.backlog = []
        self.control_lock = threading.Lock()
        self.next_control_id = 0
        self.clients = []
        self.proxy = None
        self.owner_prefix = f"c12-{uuid.uuid4().hex[:12]}"

        ensure_service(self.home)
        self.assertEqual(self.rpc("health", {}), {"ok": True, "protocolVersion": 1})
        self.peer = subprocess.Popen(
            ["node", str(Path(__file__).with_name("bridge_executor_peer.mjs")), str(self.home)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.stderr_lines = []
        self.reader_thread = threading.Thread(target=self._read_peer, daemon=True)
        self.reader_thread.start()
        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.stderr_thread.start()
        ready = self._wait_message(lambda item: item.get("type") == "ready", 15)
        self.assertEqual(set(ready["instances"]), set(INSTANCE.values()))
        self.tasks = {}
        for browser in ("chrome", "edge"):
            for ordinal, tab_id in ((1, 71), (2, 72)):
                owner = f"{self.owner_prefix}-{browser}-{ordinal}"
                task = self.rpc("shared.create", {
                    "owner": owner,
                    "title": f"synthetic {browser} task {ordinal}",
                    "instanceId": INSTANCE[browser],
                    "allowedOrigins": [ORIGIN],
                })
                self.assertEqual(task["state"], "pending_approval")
                entry = {"browser": browser, "ordinal": ordinal, "tabId": tab_id,
                         "owner": owner, "id": task["id"], "generation": task["generation"]}
                self.tasks[(browser, ordinal)] = entry
                approved = self.control("approve", instanceId=INSTANCE[browser],
                                        taskId=task["id"], tabId=tab_id)
                self.assertEqual(approved["state"], "ready")
                full = self.control("mode", instanceId=INSTANCE[browser],
                                    taskId=task["id"], generation=task["generation"])
                self.assertEqual(full["activeMode"], "full")

    def _read_peer(self):
        assert self.peer is not None and self.peer.stdout is not None
        for line in self.peer.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError as error:
                self.messages.put({"type": "invalid_json", "line": line, "error": str(error)})

    def _read_stderr(self):
        assert self.peer is not None and self.peer.stderr is not None
        for line in self.peer.stderr:
            self.stderr_lines.append(line.rstrip())

    def _wait_message(self, predicate, timeout):
        deadline = time.monotonic() + timeout
        while True:
            for index, item in enumerate(self.backlog):
                if predicate(item):
                    return self.backlog.pop(index)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stderr = "\n".join(self.stderr_lines[-30:])
                self.fail(f"timed out waiting for synthetic peer message; stderr={stderr}")
            try:
                item = self.messages.get(timeout=remaining)
            except queue.Empty:
                self.fail("timed out waiting for synthetic peer message")
            if predicate(item):
                return item
            self.backlog.append(item)

    def control(self, command, **params):
        with self.control_lock:
            self.next_control_id += 1
            request_id = self.next_control_id
            assert self.peer is not None and self.peer.stdin is not None
            self.peer.stdin.write(json.dumps({"id": request_id, "command": command, **params}) + "\n")
            self.peer.stdin.flush()
            response = self._wait_message(
                lambda item: item.get("type") == "response" and item.get("id") == request_id, 10)
            if "error" in response:
                raise AssertionError(f"synthetic peer {command} failed: {response['error']}")
            return response.get("result")

    def _client(self, timeout=8):
        client = BridgeClient(self.home, timeout=timeout)
        self.clients.append(client)
        return client

    def rpc(self, method, params):
        client = self._client()
        try:
            return client.call(method, params)
        finally:
            client.close()

    def run_params(self, task, request_id, action="tabs", **extra):
        params = {
            "owner": task["owner"],
            "taskId": task["id"],
            "requestId": request_id,
            "action": action,
            **extra,
        }
        if action not in {"tabs", "new_tab", "official.new_tab"}:
            params.setdefault("tabId", task["tabId"])
        return params

    def _run_task(self, task, request_id, action="tabs", **extra):
        return self.rpc("shared.run", self.run_params(task, request_id, action, **extra))

    def stats(self, browser):
        return self.control("stats", instanceId=INSTANCE[browser])

    def wait_task_state(self, task, state, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = self.rpc("shared.get", {"owner": task["owner"], "taskId": task["id"]})
            if current.get("state") == state:
                return current
            time.sleep(0.02)
        self.fail(f"task {task['id']} did not reach {state}: {current.get('state')} / {current.get('lastError')}")

    def test_open_select_subagent_isolation_and_close_cross_complete_native_stack(self):
        # 中文注释：从可信工具租约到真实 daemon/Bridge/Executor/工作区，验证父子会话、显式选页与正常清理。
        plugin = ROOT / 'executor-plugin'
        sys.path.insert(0, str(plugin))
        try:
            import native_runtime
        finally:
            sys.path.remove(str(plugin))
        profile = native_runtime.NativeProfileRuntime(self.home, plugin)
        script = native_runtime.load_module(plugin / 'script_lane/host_bridge.py', 'audit_script_')
        integration = native_runtime.load_module(plugin / 'single_tool_adapter/integration.py', 'audit_binding_')
        opener = native_runtime.load_module(plugin / 'open_tool.py', 'audit_open_')
        tools = native_runtime.load_module(plugin / 'native_tools.py', 'audit_tools_')
        script_bridge = script.HostBridge(profile, plugin)
        bridge = integration.HostBindingCoordinator(script_bridge)
        profile.authority.lease_tools(('browser_shared_open', 'browser_shared_use_tab'))
        open_handler = opener.make_handler(profile, bridge, lease_error=native_runtime.OwnerLeaseError)
        select_handler = opener.make_use_tab_handler(profile, bridge, lease_error=native_runtime.OwnerLeaseError)
        def invoke(name, args, session):
            hook = profile.authority.pre_tool_call(name, args, session_id=session, tool_call_id=uuid.uuid4().hex)
            self.assertEqual(hook['action'], 'modify')
            handler = (open_handler if name == 'browser_shared_open' else select_handler if name == 'browser_shared_use_tab'
                       else tools.make_tool_handler(name, profile, host_bridge=bridge))
            return json.loads(handler({**args, **hook['args']}, session_id=session))
        try:
            self.control('consent', instanceId=INSTANCE['chrome'], enabled=True)
            parent = invoke('browser_shared_open', {'url': ORIGIN + '/parent'}, 'parent-session')
            child = invoke('browser_shared_open', {'url': ORIGIN + '/child'}, 'subagent-session')
            second = invoke('browser_shared_open', {'url': ORIGIN + '/second'}, 'parent-session')
            self.assertEqual(parent['task_id'], second['task_id'])
            self.assertNotEqual(parent['task_id'], child['task_id'])
            self.assertNotEqual(parent['tab_id'], child['tab_id'])
            self.assertEqual(invoke('browser_shared_use_tab', {'tab_id': parent['tab_id']}, 'subagent-session')['code'], 'foreign_tab')
            self.assertTrue(invoke('browser_shared_use_tab', {'tab_id': second['tab_id']}, 'parent-session')['success'])
            denied = invoke('browser_shared_get', {'task_id': parent['task_id']}, 'subagent-session')
            self.assertEqual(denied['bridgeCode'], 'forbidden')
            for session, opened in [('parent-session', parent), ('subagent-session', child)]:
                result = invoke('browser_shared_run', {'task_id': opened['task_id'], 'request_id': uuid.uuid4().hex,
                    'action': 'navigate', 'tab_id': opened['tab_id'], 'url': ORIGIN + '/' + session}, session)
                self.assertNotIn('error', result)
            observed = self.stats('chrome')['tabs']
            self.assertEqual(observed[str(parent['tab_id'])]['url'], ORIGIN + '/parent-session')
            self.assertEqual(observed[str(child['tab_id'])]['url'], ORIGIN + '/subagent-session')
            self.assertFalse(observed[str(parent['tab_id'])]['active'])
            self.assertEqual(observed[str(parent['tab_id'])]['groupId'], observed[str(second['tab_id'])]['groupId'])
            self.assertNotEqual(observed[str(parent['tab_id'])]['groupId'], observed[str(child['tab_id'])]['groupId'])
            closed = invoke('browser_shared_close', {'task_id': parent['task_id']}, 'parent-session')
            self.assertEqual((closed['state'], closed['cleanupState']), ('closed', 'succeeded'))
            observed = self.stats('chrome')['tabs']
            self.assertNotIn(str(parent['tab_id']), observed)
            self.assertNotIn(str(second['tab_id']), observed)
            self.assertIn(str(child['tab_id']), observed)
            self.assertIn('71', observed)
            # 中文注释：会话结束和子代理结束走真实注册钩子，只清理对应 owner，不依赖模型主动 close。
            import types
            hooks = {}
            ctx = types.SimpleNamespace(register_hook=lambda name, callback: hooks.update({name: callback}),
                register_tool=lambda **kwargs: None, on_unload=lambda callback: None)
            tools.register_native_context(ctx, profile, host_bridge=bridge)
            self.assertIn('on_session_finalize', hooks)
            self.assertIn('subagent_stop', hooks)
            # 中文注释：1.4.3 起每轮结束与 /stop 也注册钩子；未发 completed 信号时 finalize 仍立即关闭。
            self.assertIn('on_session_end', hooks)
            self.assertIn('agent_loop_stopped', hooks)
            final = invoke('browser_shared_open', {'url': ORIGIN + '/final'}, 'parent-session')
            issued = profile.authority.pre_tool_call('browser_shared_get', {'task_id': final['task_id']},
                session_id='parent-session', tool_call_id='unused-before-finalize')
            hooks['on_session_finalize'](session_id='parent-session')
            with self.assertRaises(native_runtime.OwnerLeaseError):
                profile.authority.consume('browser_shared_get', {'task_id': final['task_id'], **issued['args']},
                    session_id='parent-session')
            observed = self.stats('chrome')['tabs']
            self.assertNotIn(str(final['tab_id']), observed)
            self.assertIn(str(child['tab_id']), observed)
            hooks['subagent_stop'](parent_session_id='parent-session', child_session_id='subagent-session')
            self.assertNotIn(str(child['tab_id']), self.stats('chrome')['tabs'])
        finally:
            script_bridge.close()
            profile.close()

    def test_browser_mode_downgrade_keeps_tasks_and_isolated_browser(self):
        # 中文注释：真实 client → daemon → Bridge → Executor 链路；切换模式保留旧任务，其他浏览器不受影响。
        old = self.tasks[("chrome", 1)]
        self._run_task(old, "before-revoke")
        self.control("consent", instanceId=INSTANCE["chrome"], enabled=False)
        pending = self.rpc("shared.create", {"owner": old["owner"], "title": "smart-task",
            "instanceId": INSTANCE["chrome"], "allowedOrigins": [ORIGIN]})
        for task in (old, {**pending, "owner": old["owner"]}):
            current = self.wait_task_state(task, "ready")
            self.assertEqual(current["activeMode"], "smart")
            self._run_task(task, "after-downgrade")
        pending_write = self._run_task(old, "smart-write", "click", selector="#save")
        self.assertEqual(pending_write["status"], "approval_required")
        self.control("consent", instanceId=INSTANCE["chrome"], enabled=True)
        current = self.rpc("shared.get", {"owner": old["owner"], "taskId": old["id"]})
        self.assertEqual(current["activeMode"], "full")
        fresh = self.rpc("shared.create", {"owner": old["owner"], "title": "fresh",
            "instanceId": INSTANCE["chrome"], "allowedOrigins": [ORIGIN]})
        # 中文注释：任务变更通知与自动授权异步进行；只在明确 ready 后运行新任务。
        self.wait_task_state({**fresh, "owner": old["owner"]}, "ready")
        self.assertEqual(self._run_task({**fresh, "owner": old["owner"]}, "fresh-read"), [])
        self.assertEqual(len(self._run_task(self.tasks[("edge", 1)], "edge-still-ready")), 1)

    def test_mode_change_during_inflight_read_does_not_replay(self):
        # 中文注释：人为挂起浏览器 API，切换模式后只让在途读取完成或明确报错，不重放。
        task = self.tasks[("chrome", 1)]
        self.control("pause_get", instanceId=INSTANCE["chrome"], tabId=task["tabId"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(self._run_task, task, "revoked-inflight")
            self._wait_message(lambda item: item.get("type") == "get_entered", 5)
            stopped = pool.submit(self.control, "consent", instanceId=INSTANCE["chrome"], enabled=False)
            self.control("resume_get", instanceId=INSTANCE["chrome"], tabId=task["tabId"])
            stopped.result(timeout=5)
            try:
                running.result(timeout=5)
            except BridgeError as caught:
                self.assertFalse(caught.data.get("outcomeUnknown"))
            current = self.rpc("shared.get", {"owner": task["owner"], "taskId": task["id"]})
            self.assertEqual(current["activeMode"], "smart")

    def test_two_browsers_each_keep_two_task_leases_with_same_numeric_tab_ids(self):
        for ordinal in (1, 2):
            chrome = self.tasks[("chrome", ordinal)]
            edge = self.tasks[("edge", ordinal)]
            self.assertEqual(chrome["tabId"], edge["tabId"])
            self.assertNotEqual(chrome["id"], edge["id"])
        self.control("reset_counts", instanceId=INSTANCE["chrome"])
        self.control("reset_counts", instanceId=INSTANCE["edge"])

        request_ids = {(browser, ordinal): f"duplicate-{browser}-{ordinal}-{uuid.uuid4().hex}"
                       for browser in ("chrome", "edge") for ordinal in (1, 2)}
        keys = list(request_ids)
        simultaneous_keys = [key for key in keys for _ in range(2)]
        # 中文注释：在途重复请求立即返回未知，完成后的重复请求返回缓存结果；两种情况都只派发一次。
        def duplicate_call(key):
            try:
                return self._run_task(self.tasks[key], request_ids[key])
            except BridgeError as exc:
                self.assertEqual(exc.code, 'request_outcome_unavailable')
                return None
        with ThreadPoolExecutor(max_workers=8) as pool:
            duplicate_results = list(pool.map(
                duplicate_call, simultaneous_keys))
        first_results = []
        for index, key in enumerate(keys):
            result, duplicate = duplicate_results[index * 2:index * 2 + 2]
            if result is None:
                result, duplicate = duplicate, result
            if duplicate is not None:
                self.assertEqual(duplicate, result)
            self.assertIsNotNone(result)
            first_results.append(result)
            self.assertEqual([row["id"] for row in result], [self.tasks[key]["tabId"]])
            self.assertIn(f"/{key[0]}/{key[1]}", result[0]["url"])
        for browser in ("chrome", "edge"):
            observed = self.stats(browser)["gets"]
            self.assertEqual(observed, {"71": 1, "72": 1}, f"duplicate dispatched again on {browser}: {observed}")

        task = self.tasks[("chrome", 1)]
        with self.assertRaises(BridgeError) as conflict:
            self.rpc("shared.run", self.run_params(task, request_ids[("chrome", 1)], "snapshot"))
        self.assertEqual(conflict.exception.code, "request_id_conflict")

    def test_cancelled_inflight_task_does_not_interrupt_sibling_or_other_browser(self):
        cancelled = self.tasks[("chrome", 1)]
        self.control("pause_get", instanceId=INSTANCE["chrome"], tabId=cancelled["tabId"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            inflight = pool.submit(self._run_task, cancelled, f"inflight-{uuid.uuid4().hex}")
            self._wait_message(lambda item: item.get("type") == "get_entered"
                               and item.get("instanceId") == INSTANCE["chrome"]
                               and item.get("tabId") == cancelled["tabId"], 5)
            result = self.rpc("shared.cancel", {"owner": cancelled["owner"], "taskId": cancelled["id"]})
            self.assertEqual(result["state"], "cancelled")

            unaffected = [self.tasks[("chrome", 2)], self.tasks[("edge", 1)], self.tasks[("edge", 2)]]
            with ThreadPoolExecutor(max_workers=3) as peers:
                peer_results = list(peers.map(
                    lambda task: self._run_task(task, f"survivor-{uuid.uuid4().hex}"), unaffected))
            for task, tabs in zip(unaffected, peer_results):
                self.assertEqual([tab["id"] for tab in tabs], [task["tabId"]])

            self.control("resume_get", instanceId=INSTANCE["chrome"], tabId=cancelled["tabId"])
            with self.assertRaises(BridgeError) as caught:
                inflight.result(timeout=5)
            self.assertEqual(caught.exception.code, "permission_denied")
            self.assertEqual(caught.exception.data, {"outcomeUnknown": False, "retryable": False})

        for task in unaffected:
            current = self.rpc("shared.get", {"owner": task["owner"], "taskId": task["id"]})
            self.assertEqual(current["state"], "ready")

    def test_reconnect_resumes_only_with_next_generation_and_fresh_approval(self):
        chrome_tasks = [self.tasks[("chrome", 1)], self.tasks[("chrome", 2)]]
        edge_task = self.tasks[("edge", 1)]
        self.control("disconnect", instanceId=INSTANCE["chrome"])
        for task in chrome_tasks:
            current = self.wait_task_state(task, "needs_sync")
            self.assertEqual(current["generation"], 1)
            self.assertEqual(current["tabIds"], [])
        edge_current = self.rpc("shared.get", {"owner": edge_task["owner"], "taskId": edge_task["id"]})
        self.assertEqual(edge_current["state"], "ready")

        self.control("reconnect", instanceId=INSTANCE["chrome"])
        for task in chrome_tasks:
            resumed = self.rpc("shared.resume", {"owner": task["owner"], "taskId": task["id"]})
            self.assertEqual(resumed["state"], "pending_approval")
            self.assertEqual(resumed["generation"], 2)
            task["generation"] = 2
            approved = self.control("approve", instanceId=INSTANCE["chrome"],
                                    taskId=task["id"], tabId=task["tabId"])
            self.assertEqual(approved["generation"], 2)
            full = self.control("mode", instanceId=INSTANCE["chrome"],
                                taskId=task["id"], generation=2)
            self.assertEqual(full["activeMode"], "full")
            tabs = self._run_task(task, f"generation-two-{uuid.uuid4().hex}")
            self.assertEqual([tab["id"] for tab in tabs], [task["tabId"]])

        stats = self.stats("chrome")
        for task in chrome_tasks:
            local = next(row for row in stats["executorTasks"] if row["id"] == task["id"])
            self.assertEqual(local["generation"], 2)
            self.assertFalse(local["revoked"])
            self.assertEqual(local["leasedTabIds"], [task["tabId"]])
        still_live = self._run_task(edge_task, f"edge-after-chrome-reconnect-{uuid.uuid4().hex}")
        self.assertEqual([tab["id"] for tab in still_live], [edge_task["tabId"]])

    def test_lost_client_response_is_unknown_and_retry_reads_cached_outcome_without_replay(self):
        task = self.tasks[("edge", 2)]
        request_id = f"lost-response-{uuid.uuid4().hex}"
        target_url = f"{ORIGIN}/after-lost-response"
        params = self.run_params(task, request_id, "navigate", url=target_url)
        proxy_data = self.work / "proxy" / "plugin-data" / "browser-link-native"
        proxy_data.mkdir(parents=True)
        (proxy_data / "token").write_text((self.home / "plugin-data" / "browser-link-native" / "token").read_text().strip() + "\n")
        os.chmod(proxy_data / "token", 0o600)
        proxy_socket = proxy_data / "bridge.sock"
        self.assertLess(len(os.fsencode(proxy_socket)), 104, "proxy AF_UNIX path exceeds macOS limit")
        self.proxy = DroppingResponseProxy(self.socket_path, proxy_socket, request_id)

        lost_client = BridgeClient(self.work / "proxy", timeout=8)
        try:
            with self.assertRaises(BridgeError) as caught:
                lost_client.call("shared.run", params)
            self.assertEqual(caught.exception.code, "outcome_unknown")
        finally:
            lost_client.close()
        self.assertEqual(self.proxy.dropped_request_count, 1)
        self.assertEqual(self.proxy.dropped_response.get("result", {}).get("url"), target_url)

        stats = self.stats("edge")
        self.assertEqual(stats["updates"].get("72"), 1)
        self.assertEqual(stats["tabs"]["72"]["url"], target_url)
        retry = self.rpc("shared.run", params)
        self.assertEqual(retry, self.proxy.dropped_response["result"])
        after = self.stats("edge")
        self.assertEqual(after["updates"].get("72"), 1, "same request ID replayed navigation")
        self.assertEqual(after["tabs"]["72"]["url"], target_url)

    def tearDown(self):
        if self.peer is not None and self.peer.poll() is None:
            try:
                self.peer.terminate()
                self.peer.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.peer.kill()
                self.peer.wait(timeout=2)
        if self.reader_thread is not None:
            self.reader_thread.join(timeout=1)
        if hasattr(self, "stderr_thread"):
            self.stderr_thread.join(timeout=1)
        if self.peer is not None:
            for stream in (self.peer.stdin, self.peer.stdout, self.peer.stderr):
                if stream is not None:
                    stream.close()
        for client in self.clients:
            try:
                client.close()
            except Exception:
                pass
        if self.proxy is not None:
            self.proxy.close()
        stop_fixture_daemon(self.home)
        self.temp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
