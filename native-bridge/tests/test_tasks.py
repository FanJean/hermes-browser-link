import os
import json
from pathlib import Path
import sys
import os
import tempfile
import time
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))

from client import BridgeClient, BridgeError  # noqa: E402
from daemon import BridgeDaemon, _safe_error_data  # noqa: E402
from tests.support import ExtensionPeer, stop_fixture_daemon  # noqa: E402


class RedirectScopeTests(unittest.TestCase):
    def test_complex_ui_error_summary_is_closed_at_daemon_boundary(self):
        # 中文注释：daemon 只转发已脱敏的候选及关闭按钮引用。
        binding = {'taskId': 't', 'documentId': 'd', 'leaseId': 'l', 'secret': 'SECRET_CANARY'}
        safe = _safe_error_data({'outcomeUnknown': False,
            'candidates': [{'role': 'button', 'name': '保存', 'value': 'SECRET_CANARY'}],
            'obstruction': {'role': 'dialog', 'name': '遮挡层', 'value': 'SECRET_CANARY',
                'closeButton': {'binding': binding, 'snapshotId': 's', 'ref': 'r', 'name': '关闭', 'value': 'SECRET_CANARY'}},
            'pageException': 'SECRET_CANARY'})
        self.assertEqual(safe['candidates'], [{'role': 'button', 'name': '保存'}])
        self.assertEqual(safe['obstruction']['closeButton']['binding'],
                         {'taskId': 't', 'documentId': 'd', 'leaseId': 'l'})
        self.assertNotIn('SECRET_CANARY', json.dumps(safe))

    def test_scope_error_fields_are_closed_at_daemon_boundary(self):
        # 中文注释：1.4.4 跨站诊断只放行纯来源、固定提示和短标识符，路径、查询、凭据与自由文本一律丢弃。
        hint = '同站用 goto_url，新站用 browser_shared_open。'
        safe = _safe_error_data({'currentOrigin': 'https://tools.example', 'scopeHint': hint,
                                 'stage': 'overlay', 'reasonCode': 'initialization_exception'})
        self.assertEqual(safe, {'currentOrigin': 'https://tools.example', 'scopeHint': hint,
                                'stage': 'overlay', 'reasonCode': 'initialization_exception'})
        for bad in ('https://tools.example/path?q=SECRET_CANARY', 'https://u:p@tools.example', 'javascript:alert(1)'):
            self.assertNotIn('currentOrigin', _safe_error_data({'currentOrigin': bad}))
        dropped = _safe_error_data({'scopeHint': 'SECRET_CANARY', 'stage': 'Overlay SECRET_CANARY', 'reasonCode': 'x' * 80})
        self.assertEqual(dropped, {})

    def test_www_variant_is_exact_and_same_protocol(self):
        # 中文注释：守护进程只登记扩展回执中的同协议 apex/www 来源。
        check = BridgeDaemon._www_redirect_origin
        self.assertEqual(check('https://example.com/a', 'https://www.example.com/b'),
                         'https://www.example.com')
        self.assertEqual(check('https://www.example.com/a', 'https://example.com/b'),
                         'https://example.com')
        for final in ('https://shop.example.com/', 'https://other.test/',
                      'http://www.example.com/', 'https://www.example.com:8443/'):
            self.assertIsNone(check('https://example.com/a', final))

    def test_owned_tab_event_adds_only_www_origin(self):
        # 中文注释：导航通知先于建页回执时，租约与代次仍约束来源扩充。
        daemon = BridgeDaemon.__new__(BridgeDaemon)
        daemon.state_lock = threading.RLock()
        task = {'id': 'task', 'instanceId': 'edge', 'generation': 1, 'state': 'ready',
                'allowedOrigins': ['https://example.com'], 'tabIds': [7], 'agentTabIds': [7]}
        daemon.tasks = {'task': task}
        daemon.tab_leases = {('edge', 7): 'task'}
        daemon._revoke_api_locked = lambda _: None
        daemon._persist_tasks = lambda: None
        daemon._public_task = lambda item: item
        result = daemon._handle_tab_event('edge', {'taskId': 'task', 'generation': 1,
            'tabId': 7, 'event': 'navigated', 'documentGeneration': 1,
            'url': 'https://www.example.com/path'})
        self.assertEqual(result['allowedOrigins'], ['https://example.com', 'https://www.example.com'])


class TaskTests(unittest.TestCase):
    def setUp(self):
        # HOME may be isolated with a scratch symlink by the regression runner.
        # ExtensionPeer connects using this path verbatim, unlike BridgeClient.
        # A gate HOME nests deeply, so also consider its (short) TMPDIR and use
        # whichever keeps the Unix socket path within the macOS limit.
        default = Path(tempfile.gettempdir())
        default.mkdir(parents=True, exist_ok=True)
        candidates = [default.resolve()]
        if os.environ.get("TMPDIR") and Path(os.environ["TMPDIR"]).is_dir():
            candidates.append(Path(os.environ["TMPDIR"]).resolve())
        scratch = min(candidates, key=lambda path: len(str(path)))
        self.temp = tempfile.TemporaryDirectory(prefix="bn-", dir=scratch)
        self.home = Path(self.temp.name) / "h"
        self.clients = []
        self.peers = []

    def client(self):
        client = BridgeClient(self.home)
        self.clients.append(client)
        return client

    def extension(self, *args, **kwargs):
        peer = ExtensionPeer(self.home, *args, **kwargs)
        self.peers.append(peer)
        return peer

    def tearDown(self):
        for peer in self.peers:
            peer.close()
        for client in self.clients:
            client.close()
        stop_fixture_daemon(self.home)
        self.temp.cleanup()

    def test_fixture_socket_path_is_canonical_and_fits_macos_uds(self):
        socket_path = self.home / "plugin-data" / "browser-link-native" / "bridge.sock"
        self.assertEqual(socket_path, socket_path.resolve())
        self.assertLessEqual(len(os.fsencode(socket_path)), 103)

    def test_owner_is_private_and_tab_lease_conflict_is_rejected(self):
        extension = self.extension("shared-profile", "chrome")
        alice = self.client()
        bob = self.client()
        origins = ["https://example.com"]
        first = alice.call(
            "shared.create",
            {"owner": "session-alice", "title": "Alice task", "instanceId": "shared-profile", "allowedOrigins": origins},
        )
        second = bob.call(
            "shared.create",
            {"owner": "session-bob", "title": "Bob task", "instanceId": "shared-profile", "allowedOrigins": origins},
        )
        self.assertNotIn("owner", first)
        self.assertEqual(first["state"], "pending_approval")
        listed = extension.request("extension.tasks", {})
        self.assertEqual({item["id"] for item in listed}, {first["id"], second["id"]})
        self.assertTrue(all("owner" not in item for item in listed))

        approved = extension.request(
            "extension.approve",
            {"taskId": first["id"], "tabIds": [9], "allowedOrigins": origins},
        )
        self.assertEqual(approved["state"], "ready")
        conflict = extension.request(
            "extension.approve",
            {"taskId": second["id"], "tabIds": [9], "allowedOrigins": origins},
        )
        self.assertEqual(conflict["error"]["code"], "lease_conflict")

        with self.assertRaises(BridgeError) as caught:
            bob.call("shared.get", {"owner": "session-bob", "taskId": first["id"]})
        self.assertEqual(caught.exception.code, "forbidden")

    def test_new_task_run_waits_for_explicit_ready_state(self):
        # 中文注释：固定停在待批准状态，验证开启访问后立刻运行不会得到含糊错误或派发动作。
        extension = self.extension("preparing-profile", "chrome")
        client = self.client()
        params = {"owner": "fresh-owner", "title": "fresh", "instanceId": "preparing-profile",
                  "allowedOrigins": ["https://example.com"]}
        task = client.call("shared.create", params)
        self.assertEqual(task["state"], "pending_approval")
        run = {"owner": params["owner"], "taskId": task["id"], "requestId": "first-run", "action": "tabs"}
        with self.assertRaises(BridgeError) as caught:
            client.call("shared.run", run)
        self.assertEqual(caught.exception.code, "task_preparing")
        self.assertIn("ready", str(caught.exception))
        self.assertEqual(caught.exception.data["outcomeUnknown"], False)
        self.assertEqual(caught.exception.data["retryable"], True)
        self.assertEqual(client.call("shared.get", {"owner": params["owner"], "taskId": task["id"]})["state"], "pending_approval")
        extension.request("extension.approve", {"taskId": task["id"], "tabIds": [9],
                                                "allowedOrigins": params["allowedOrigins"]})
        self.assertEqual(client.call("shared.get", {"owner": params["owner"], "taskId": task["id"]})["state"], "ready")
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(client.call, "shared.run", run)
            command = extension.receive_request("browser.execute")
            self.assertEqual(command["params"]["requestId"], "first-run")
            extension.respond(command, [])
            self.assertEqual(running.result(timeout=2), [])

    def test_run_deduplicates_and_cancel_does_not_affect_peer_task(self):
        extension = self.extension("shared-profile", "chrome")
        client = self.client()
        origins = ["https://example.com"]
        first = client.call(
            "shared.create",
            {"owner": "owner-a", "title": "first", "instanceId": "shared-profile", "allowedOrigins": origins},
        )
        second = client.call(
            "shared.create",
            {"owner": "owner-b", "title": "second", "instanceId": "shared-profile", "allowedOrigins": origins},
        )
        approved_first = extension.request("extension.approve", {"taskId": first["id"], "tabIds": [1], "allowedOrigins": origins})
        approved_second = extension.request("extension.approve", {"taskId": second["id"], "tabIds": [2], "allowedOrigins": origins})
        # 中文注释：此用例测请求去重与任务隔离；切到全部访问后快照不再等待首次站点审批。
        for approved in (approved_first, approved_second):
            extension.request('extension.mode', {'taskId': approved['id'], 'generation': approved['generation'],
                                                 'modeGeneration': approved['modeGeneration'], 'mode': 'full'})

        run_params = {
            "owner": "owner-a",
            "taskId": first["id"],
            "requestId": "request-1",
            "action": "snapshot",
            "tabId": 1,
        }
        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(client.call, "shared.run", run_params)
            command = extension.receive_request("browser.execute")
            self.assertEqual(command["params"]["taskId"], first["id"])
            self.assertEqual(command["params"]["generation"], 1)
            self.assertEqual(command["params"]["requestId"], "request-1")
            self.assertEqual(command["params"]["allowedOrigins"], origins)
            extension.respond(command, {"snapshot": "ok"})
            self.assertEqual(running.result(timeout=2), {"snapshot": "ok"})

            duplicate = pool.submit(client.call, "shared.run", run_params)
            self.assertEqual(duplicate.result(timeout=0.5), {"snapshot": "ok"})

            with self.assertRaises(BridgeError) as conflict:
                client.call("shared.run", dict(run_params, action="click", selector="#other"))
            self.assertEqual(conflict.exception.code, "request_id_conflict")

            with self.assertRaises(BridgeError) as foreign:
                client.call("shared.run", dict(run_params, requestId="foreign", tabId=2))
            self.assertEqual(foreign.exception.code, "foreign_tab")

            cancelling = pool.submit(
                client.call, "shared.cancel", {"owner": "owner-a", "taskId": first["id"]}
            )
            release = extension.receive_request("browser.release")
            self.assertEqual(release["params"]["taskId"], first["id"])
            extension.respond(release, {"released": True})
            self.assertEqual(cancelling.result(timeout=2)["state"], "cancelled")

            peer_run = pool.submit(
                client.call,
                "shared.run",
                {
                    "owner": "owner-b",
                    "taskId": second["id"],
                    "requestId": "peer-1",
                    "action": "snapshot",
                    "tabId": 2,
                },
            )
            peer_command = extension.receive_request("browser.execute")
            self.assertEqual(peer_command["params"]["taskId"], second["id"])
            extension.respond(peer_command, {"peer": "still-running"})
            self.assertEqual(peer_run.result(timeout=2), {"peer": "still-running"})

    def test_disconnect_requires_fresh_resume_and_approval(self):
        extension = self.extension("reconnect-profile", "edge")
        client = self.client()
        origins = ["https://example.com"]
        task = client.call(
            "shared.create",
            {"owner": "owner-r", "title": "reconnect", "instanceId": "reconnect-profile", "allowedOrigins": origins},
        )
        extension.request("extension.approve", {"taskId": task["id"], "tabIds": [4], "allowedOrigins": origins})
        extension.close()

        deadline = time.time() + 2
        current = None
        while time.time() < deadline:
            current = client.call("shared.get", {"owner": "owner-r", "taskId": task["id"]})
            if current["state"] == "needs_sync":
                break
            time.sleep(0.02)
        self.assertEqual(current["state"], "needs_sync")
        self.assertEqual(current["tabIds"], [])

        replacement = self.extension("reconnect-profile", "edge")
        resumed = client.call("shared.resume", {"owner": "owner-r", "taskId": task["id"]})
        self.assertEqual(resumed["state"], "pending_approval")
        self.assertEqual(resumed["generation"], 2)
        approved = replacement.request(
            "extension.approve",
            {"taskId": task["id"], "tabIds": [4], "allowedOrigins": origins},
        )
        self.assertEqual(approved["state"], "ready")
        self.assertEqual(approved["generation"], 2)

    def test_late_invalid_open_result_does_not_revoke_the_resumed_task(self):
        # 中文注释：旧建页回执失败只属于旧代次，不能撤销已完成重新批准的新代次。
        extension = self.extension("late-result", "chrome")
        client = self.client()
        task = client.call("shared.create", {"owner": "late-owner", "title": "late result",
            "instanceId": "late-result", "allowedOrigins": ["https://example.com"]})
        grant = {"taskId": task["id"], "tabIds": [8], "allowedOrigins": ["https://example.com"]}
        extension.request("extension.approve", grant)
        extension.request("extension.mode", {"taskId": task["id"], "generation": 1, "modeGeneration": 1, "mode": "full"})
        control = self.client()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(client.call, "shared.run", {"owner": "late-owner", "taskId": task["id"],
                "action": "official.new_tab", "url": "https://example.com", "requestId": "old-open"})
            execute = extension.receive_request("browser.execute")
            extension.request("extension.stop", {"taskId": task["id"], "generation": 1})
            resumed = control.call("shared.resume", {"owner": "late-owner", "taskId": task["id"]})
            extension.request("extension.approve", {**grant, "generation": resumed["generation"]})
            extension.respond(execute, {})
            cleanup = extension.receive_request("browser.release")
            self.assertEqual(cleanup["params"]["generation"], 1)
            extension.respond(cleanup, {"released": True})
            with self.assertRaises(BridgeError):
                running.result(timeout=3)
        current = control.call("shared.get", {"owner": "late-owner", "taskId": task["id"]})
        self.assertEqual((current["state"], current["generation"], current["tabIds"]), ("ready", 2, [8]))

    def test_extension_stop_and_access_revocation_are_durable_before_ack(self):
        # 中文注释：停止回执返回即应有终态快照，不能把 100ms 合并窗口中的崩溃恢复为可继续任务。
        extension = self.extension('durable-stop', 'chrome')
        client = self.client()
        for method in ('extension.stop', 'extension.revoke_access'):
            task = client.call('shared.create', {'owner': 'durable-owner', 'title': method,
                'instanceId': 'durable-stop', 'allowedOrigins': ['https://example.com']})
            params = {'taskId': task['id'], 'generation': 1} if method == 'extension.stop' else {}
            extension.request(method, params)
            persisted = json.loads((self.home / 'plugin-data/browser-link-native/tasks.json').read_text())
            saved = next(row for row in persisted['tasks'] if row['id'] == task['id'])
            self.assertEqual(saved['state'], 'cancelled')
            if method == 'extension.revoke_access':
                self.assertTrue(saved['accessRevoked'])

    def test_late_tab_event_cannot_revoke_a_resumed_generation(self):
        # 中文注释：走真实 socket 的旧关闭通知不能清除新代次同一页的租约。
        extension = self.extension("event-profile", "chrome")
        client = self.client()
        task = client.call("shared.create", {"owner": "event-owner", "title": "events",
            "instanceId": "event-profile", "allowedOrigins": ["https://example.com"]})
        grant = {"taskId": task["id"], "tabIds": [8], "allowedOrigins": ["https://example.com"]}
        extension.request("extension.approve", grant)
        extension.request("extension.stop", {"taskId": task["id"], "generation": 1})
        resumed = client.call("shared.resume", {"owner": "event-owner", "taskId": task["id"]})
        extension.request("extension.approve", {**grant, "generation": resumed["generation"]})
        rejected = extension.request("extension.tab_event", {"taskId": task["id"], "generation": 1,
            "tabId": 8, "event": "closed", "documentGeneration": 2})
        self.assertEqual(rejected.get("error", {}).get("code"), "approval_stale")
        current = client.call("shared.get", {"owner": "event-owner", "taskId": task["id"]})
        self.assertEqual((current["state"], current["tabIds"]), ("ready", [8]))

    def test_same_instance_replacement_revokes_old_authority(self):
        first = self.extension("replace-profile", "chrome")
        client = self.client()
        origins = ["https://example.com"]
        task = client.call(
            "shared.create",
            {"owner": "owner-x", "title": "replace", "instanceId": "replace-profile", "allowedOrigins": origins},
        )
        first.request("extension.approve", {"taskId": task["id"], "tabIds": [8], "allowedOrigins": origins})
        self.extension("replace-profile", "chrome")
        deadline = time.time() + 2
        while time.time() < deadline:
            current = client.call("shared.get", {"owner": "owner-x", "taskId": task["id"]})
            if current["state"] == "needs_sync":
                break
            time.sleep(0.02)
        self.assertEqual(current["state"], "needs_sync")
        self.assertEqual(current["tabIds"], [])

    def test_restart_persists_metadata_and_marks_nonterminal_task_needs_sync(self):
        extension = self.extension("persist-profile", "chrome")
        client = self.client()
        origins = ["https://example.com"]
        task = client.call(
            "shared.create",
            {"owner": "owner-p", "title": "persist me", "instanceId": "persist-profile", "allowedOrigins": origins},
        )
        extension.request("extension.approve", {"taskId": task["id"], "tabIds": [12], "allowedOrigins": origins})
        data_dir = self.home / "plugin-data" / "browser-link-native"
        stop_fixture_daemon(self.home)
        deadline = time.time() + 3
        while time.time() < deadline and (data_dir / "daemon.pid").exists():
            time.sleep(0.02)
        self.assertFalse((data_dir / "daemon.pid").exists())

        client.close()
        client = self.client()
        restored = client.call("shared.get", {"owner": "owner-p", "taskId": task["id"]})
        self.assertEqual(restored["state"], "needs_sync")
        self.assertEqual(restored["title"], "persist me")
        self.assertEqual(restored["tabIds"], [])
        persisted = data_dir / "tasks.json"
        self.assertTrue(persisted.exists())
        self.assertEqual(persisted.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("snapshot", persisted.read_text())

    def test_cross_browser_tab_ids_do_not_alias_and_extension_controls_are_isolated(self):
        chrome = self.extension("chrome-instance", "chrome")
        edge = self.extension("edge-instance", "edge")
        client = self.client()
        origins = ["https://example.com"]
        chrome_task = client.call(
            "shared.create",
            {"owner": "chrome-owner", "title": "chrome", "instanceId": "chrome-instance", "allowedOrigins": origins},
        )
        edge_task = client.call(
            "shared.create",
            {"owner": "edge-owner", "title": "edge", "instanceId": "edge-instance", "allowedOrigins": origins},
        )
        self.assertEqual(
            chrome.request("extension.approve", {"taskId": chrome_task["id"], "tabIds": [5], "allowedOrigins": origins})["state"],
            "ready",
        )
        self.assertEqual(
            edge.request("extension.approve", {"taskId": edge_task["id"], "tabIds": [5], "allowedOrigins": origins})["state"],
            "ready",
        )

        rejected_task = client.call(
            "shared.create",
            {"owner": "reject-owner", "title": "reject", "instanceId": "chrome-instance", "allowedOrigins": origins},
        )
        rejected = chrome.request("extension.reject", {"taskId": rejected_task["id"]})
        self.assertEqual(rejected["state"], "failed")

        stopped = chrome.request("extension.stop", {"taskId": chrome_task["id"]})
        self.assertEqual(stopped["state"], "cancelled")
        still_ready = client.call("shared.get", {"owner": "edge-owner", "taskId": edge_task["id"]})
        self.assertEqual(still_ready["state"], "ready")

    def test_cancel_during_new_tab_returns_promptly_and_preserves_uncertain_racing_tab(self):
        extension = self.extension("race-profile", "chrome")
        runner = self.client()
        controller = self.client()
        origins = ["https://example.com"]
        task = runner.call(
            "shared.create",
            {"owner": "race-owner", "title": "race", "instanceId": "race-profile", "allowedOrigins": origins},
        )
        extension.request("extension.approve", {"taskId": task["id"], "tabIds": [21], "allowedOrigins": origins})
        # This race concerns an executing write, not an unanswered smart-mode
        # approval. Explicit trusted extension consent starts the write.
        mode = extension.request('extension.mode', {'taskId': task['id'], 'mode': 'full', 'generation': 1, 'modeGeneration': 1})
        self.assertEqual(mode['activeMode'], 'full')
        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(
                runner.call,
                "shared.run",
                {
                    "owner": "race-owner",
                    "taskId": task["id"],
                    "requestId": "new-tab-race",
                    "action": "new_tab",
                    "url": "https://example.com/new",
                },
            )
            execute = extension.receive_request("browser.execute")
            cancelling = pool.submit(
                controller.call,
                "shared.cancel",
                {"owner": "race-owner", "taskId": task["id"]},
            )
            first_release = extension.receive_request("browser.release")
            self.assertTrue(first_release["params"]["closeAgentTabs"])
            extension.respond(first_release, {"released": True})
            self.assertEqual(cancelling.result(timeout=1)["state"], "cancelled")

            extension.respond(execute, {"tabId": 99, "url": "https://example.com/new"})
            cleanup = extension.receive_request("browser.release")
            # A late write is uncertain; deletion is not replayed without
            # explicit read-only ownership reconciliation.
            self.assertFalse(cleanup["params"]["closeAgentTabs"])
            extension.respond(cleanup, {"released": True})
            with self.assertRaises(BridgeError) as cancelled:
                running.result(timeout=2)
            self.assertEqual(cancelled.exception.code, "cancelled")


if __name__ == "__main__":
    unittest.main()
