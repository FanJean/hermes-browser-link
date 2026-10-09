"""Daemon-side native v2 validation and no-replay tests."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import socket
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "native-bridge"
sys.path.insert(0, str(BRIDGE))
try:
    spec = importlib.util.spec_from_file_location("native_v2_daemon", BRIDGE / "daemon.py")
    assert spec is not None and spec.loader is not None
    daemon_module = importlib.util.module_from_spec(spec)
    sys.modules["native_v2_daemon"] = daemon_module
    spec.loader.exec_module(daemon_module)
finally:
    sys.path.remove(str(BRIDGE))


class SafeIdleExitTests(unittest.TestCase):
    def setUp(self):
        self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')

    def tick(self, now):
        with patch.object(daemon_module.time, 'monotonic', return_value=now):
            return self.daemon._try_idle_exit()

    def test_safe_idle_exit_waits_full_default_grace(self):
        grace = daemon_module._DAEMON_IDLE_GRACE_SECONDS
        self.assertFalse(self.tick(10))
        self.assertFalse(self.tick(10 + grace - .01))
        self.assertTrue(self.tick(10 + grace))
        self.assertTrue(self.daemon.stop_event.is_set())

    def test_safe_idle_exit_requires_verified_terminal_tasks(self):
        clean = {'state': 'closed', 'cleanupState': 'succeeded', 'requestHistory': []}
        blocked = [
            {**clean, 'state': state} for state in
            ('ready', 'running', 'paused', 'needs_sync', 'pending_approval', 'authorizing', 'future')
        ] + [
            {**clean, 'cleanupState': state} for state in ('pending', 'unknown', 'failed', None)
        ] + [
            {**clean, 'currentOperation': operation} for operation in
            (None, {}, {'state': 'running'}, {'state': 'pending'}, {'state': 'unknown'}, {'state': 'future'})
        ] + [
            {**clean, 'requestHistory': history} for history in
            (None, {}, [{}], [{'state': state} for state in ('dispatched',)],
             [{'state': 'awaiting_approval'}], [{'state': 'awaiting_human'}], [{'state': 'unknown'}])
        ] + [{**clean, 'operationTimeline': [{'state': 'unknown'}]},
             {**clean, 'idlePendingHuman': True}, {**clean, 'vaultPermit': {'pending': True}}]
        for task in blocked:
            with self.subTest(task=task):
                self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')
                self.daemon.tasks['task'] = task
                self.assertFalse(self.tick(10))
                self.assertFalse(self.tick(100))
                self.assertFalse(self.daemon.stop_event.is_set())
                self.assertEqual(self.daemon.tasks['task'], task)
        for state in ('closed', 'cancelled', 'failed'):
            with self.subTest(terminal=state):
                self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')
                self.daemon.tasks['task'] = {**clean, 'state': state,
                    'currentOperation': {'state': 'succeeded'},
                    'requestHistory': [{'state': 'confirmed'}, {'state': 'rejected'}]}
                self.assertFalse(self.tick(10))
                self.assertTrue(self.tick(100))

    def test_safe_idle_exit_blocks_pending_state_and_persistence(self):
        for field, value in (
                ('extensions', {'ext': {'pending': {'r': {}}}}),
                ('tab_leases', {('ext', 7): 'task'}), ('inflight_requests', {'r': {}}),
                ('preparing_requests', {'r': {}}), ('action_approvals', {'r': {}}),
                ('api_credentials', {'task': {}}), ('api_connections', {'task': object()}),
                ('pending_journal', [{}]), ('persist_dirty', True),
                ('persist_error', OSError('fixture')), ('persist_timer', object())):
            with self.subTest(field=field):
                self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')
                self.assertFalse(self.tick(10))
                setattr(self.daemon, field, value)
                self.assertFalse(self.tick(100))
                self.assertFalse(self.daemon.stop_event.is_set())
        self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')
        self.daemon.persist_lock.acquire()
        try:
            self.assertFalse(self.tick(10))
            self.assertFalse(self.tick(100))
        finally:
            self.daemon.persist_lock.release()

    def test_safe_idle_exit_preserves_private_nonce_and_mirror_pending(self):
        for pending in ('nonce', 'mirror', 'relay'):
            with self.subTest(pending=pending):
                self.daemon = daemon_module.BridgeDaemon(Path(tempfile.gettempdir()) / 'idle-unit')
                if pending == 'nonce':
                    self.daemon.vault_private._nonces[('session', 'task', 7)] = {'expiresAt': 0}
                elif pending == 'mirror':
                    self.daemon.cookie_mirror.operations['fixture'] = {'status': 'preparing'}
                else:
                    self.daemon.cookie_mirror.relay.chunks['fixture'] = (0, [])
                self.assertFalse(self.tick(10))
                self.assertFalse(self.tick(100))
                self.assertFalse(self.daemon.stop_event.is_set())


    def test_safe_idle_exit_counts_unauthenticated_accepted_connections(self):
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as directory:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(Path(directory) / 's'))
                server.listen(1)
                server.setblocking(False)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                    peer.connect(str(Path(directory) / 's'))
                    conn = self.daemon._accept_connection(server)
                    self.assertIsNotNone(conn)
                    assert conn is not None
                    try:
                        self.assertFalse(self.tick(10))
                        self.assertFalse(self.tick(100))
                    finally:
                        conn.close()
                        self.daemon._connection_closed(conn)
                    self.assertFalse(self.tick(101))
                    self.assertFalse(self.tick(130))
                    self.assertTrue(self.tick(131))
                    self.assertIsNone(self.daemon._accept_connection(server))

    def test_safe_idle_exit_counts_private_unauthenticated_socket(self):
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as directory:
            self.daemon = daemon_module.BridgeDaemon(Path(directory))
            self.daemon._prepare_data_dir()
            self.daemon.vault_private.socket_path = Path(directory) / 'v'
            self.daemon.vault_private.start()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                    peer.connect(str(self.daemon.vault_private.socket_path))
                    deadline = time.monotonic() + 1
                    while not self.daemon.lifecycle_connections and time.monotonic() < deadline:
                        time.sleep(.005)
                    self.assertEqual(len(self.daemon.lifecycle_connections), 1)
                    self.assertFalse(self.tick(10))
                    self.assertFalse(self.tick(100))
                    peer.shutdown(socket.SHUT_RDWR)
                deadline = time.monotonic() + 1
                while self.daemon.lifecycle_connections and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertFalse(self.daemon.lifecycle_connections)
            finally:
                self.daemon.stop_event.set()
                self.daemon.vault_private.close()

    def test_safe_idle_exit_waits_for_admitted_background_worker(self):
        entered = daemon_module.threading.Event()
        release = daemon_module.threading.Event()
        def work():
            entered.set()
            release.wait(2)
        worker = self.daemon._start_lifecycle_worker(work)
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(self.tick(10))
            self.assertFalse(self.tick(100))
        finally:
            release.set()
            if worker is not None:
                worker.join(2)
        self.assertFalse(self.tick(101))
        self.assertTrue(self.tick(131))
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._start_lifecycle_worker(work)

    def test_safe_idle_exit_refuses_request_dispatch_after_latch(self):
        self.assertFalse(self.tick(10))
        self.assertTrue(self.tick(100))
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.daemon._dispatch_client('health', {})
        self.assertEqual(caught.exception.code, 'service_stopping')

    def test_safe_idle_exit_waits_for_expired_mirror_cleanup_on_old_connection(self):
        # 中文注释：断开的扩展仍可能有后台清理；删除 operation 不能代表收尾完成。
        ext = {'sendLock': daemon_module.threading.RLock(),
               'pendingLock': daemon_module.threading.Lock(), 'pending': {},
               'socket': socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)}
        ext['socket'].close()
        self.daemon.cookie_mirror.operations['fixture'] = {
            'transferId': 'fixture', 'status': 'preparing',
            'sourceConnection': ext, 'targetConnection': ext}
        ext['sendLock'].acquire()
        worker = daemon_module.threading.Thread(target=self.daemon.cookie_mirror.expire, args=('fixture',))
        worker.start()
        try:
            deadline = time.monotonic() + 1
            while not ext['pending'] and time.monotonic() < deadline:
                time.sleep(.001)
            self.assertTrue(ext['pending'])
            self.assertFalse(self.daemon.cookie_mirror.operations)
            self.assertFalse(self.tick(10))
            self.assertFalse(self.tick(40))
            self.assertTrue(worker.is_alive())
        finally:
            ext['sendLock'].release()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(self.tick(50))
        self.assertTrue(self.tick(80))


class NativeV2DaemonTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.daemon = daemon_module.BridgeDaemon(Path(self.tmp.name))
        now = time.time()
        self.task = {
            "id": "task-v2",
            "owner": "owner-v2",
            "title": "native v2",
            "instanceId": "instance-v2",
            "browser": "chrome",
            "state": "ready",
            "generation": 4,
            "allowedOrigins": ["https://example.com"],
            "tabIds": [7],
            "agentTabIds": [],
            "requestHistory": [],
            "createdAt": now,
            "updatedAt": now,
            "isolation": "shared-profile",
        }
        self.daemon.tasks[self.task["id"]] = self.task
        self.daemon.task_locks[self.task["id"]] = daemon_module.threading.RLock()
        self.daemon.dedupe[self.task["id"]] = {}
        self.daemon.tab_leases[(self.task["instanceId"], 7)] = self.task["id"]
        self.extension = {"instanceId": "instance-v2"}
        self.daemon.extensions[self.task["instanceId"]] = self.extension
        self.calls = []

        def extension_call(extension, method, params, timeout=15.0):
            self.calls.append((extension, method, params, timeout))
            return {"ok": True, "action": params["action"]}

        self.daemon._extension_call = extension_call
        self.daemon._persist_tasks = lambda: None
        # Synthetic transport has no socket; notifications do not execute actions.
        self.daemon._notify_tasks_changed = lambda _instance_id: None

    def run_action(self, request_id, action, **extra):
        return self.daemon._dispatch_client(
            "shared.run",
            {
                "owner": "owner-v2",
                "taskId": "task-v2",
                "requestId": request_id,
                "action": action,
                "tabId": 7,
                **extra,
            },
        )

    def test_persisted_operation_ledger_separates_pending_confirmed_and_unknown(self):
        def status(request_id, owner="owner-v2"):
            return self.daemon._dispatch_client("shared.operation_status", {
                "owner": owner, "taskId": "task-v2", "requestId": request_id})
        # 中文注释：只暴露请求摘要和派发状态；读取状态不会再次调用扩展。
        self.run_action("read-ledger", "snapshot")
        confirmed = status("read-ledger")
        self.assertEqual((confirmed["state"], confirmed["dispatched"], confirmed["generation"]),
                         ("confirmed", True, 4))
        self.assertNotIn("read-ledger", str(confirmed))
        self.run_action("pending-ledger", "click", selector="#confirm")
        pending = status("pending-ledger")
        self.assertEqual((pending["state"], pending["dispatched"]), ("awaiting_approval", False))
        before = len(self.calls)
        status("pending-ledger")
        self.assertEqual(len(self.calls), before)
        with self.assertRaises(daemon_module.ProtocolError):
            status("read-ledger", owner="foreign")

    def test_operation_ledger_survives_restart_without_replaying_result(self):
        self.daemon.data_dir.mkdir(parents=True, mode=0o700)
        self.daemon._persist_tasks = daemon_module.BridgeDaemon._persist_tasks.__get__(self.daemon)
        self.run_action("persisted-read", "snapshot")
        # 中文注释：确认快照的正常重启先刷新；未刷新崩溃由 journal-recovery 覆盖。
        self.daemon._flush_tasks()
        restored = daemon_module.BridgeDaemon(Path(self.tmp.name))
        restored._load_tasks()
        status = restored._dispatch_client("shared.operation_status", {
            "owner": "owner-v2", "taskId": "task-v2", "requestId": "persisted-read"})
        # 中文注释：重启后保留确认步骤，但原响应不再可重放；任务须重新同步。
        self.assertEqual((status['state'], status['dispatched']), ('confirmed', True))
        self.assertEqual(restored.tasks['task-v2']['state'], 'needs_sync')
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            restored._dispatch_client('shared.run', {'owner': 'owner-v2', 'taskId': 'task-v2',
                'requestId': 'persisted-read', 'action': 'snapshot', 'tabId': 7})
        self.assertEqual(caught.exception.code, 'request_outcome_unavailable')

    # 中文注释：AX 读取参数先在 daemon 验证，非法请求不能触发扩展或审批。
    def test_accessibility_requires_root_and_nonpaged_interactive_mode(self):
        validate = daemon_module.BridgeDaemon._validate_run_params
        validate('semantic_snapshot', {'tabId': 7, 'options': {'root': '#panel', 'accessibility': True}})
        for options in ({'accessibility': True}, {'root': '#panel', 'accessibility': 'yes'},
                        {'root': '#panel', 'accessibility': True, 'mode': 'table'},
                        {'root': '#panel', 'accessibility': True, 'cursor': 'old'},
                        {'root': '#panel', 'accessibility': True, 'baselineId': 'old'}):
            with self.subTest(options=options), self.assertRaises(daemon_module.ProtocolError):
                validate('semantic_snapshot', {'tabId': 7, 'options': options})

    def test_v1_actions_are_forwarded_with_trusted_generation_origin_and_single_approval(self):
        result = self.run_action(
            "semantic-1",
            "semantic_snapshot",
            options={"mode": "interactive", "budget": 1200},
        )
        self.assertEqual(result["action"], "semantic_snapshot")
        _, method, params, _ = self.calls[-1]
        self.assertEqual(method, "browser.execute")
        self.assertEqual(params["generation"], 4)
        self.assertEqual(params["allowedOrigins"], ["https://example.com"])

        command = dict(selector="#confirm")
        before = len(self.calls)
        pending = self.run_action("click-1", "click", **command)
        self.assertEqual(pending["status"], "approval_required")
        self.assertEqual(pending["requestId"], "click-1")
        self.assertNotIn("action", pending)
        self.assertNotIn("nonce", pending)
        self.assertEqual(self.task["state"], "ready")
        self.assertEqual(self.run_action("click-1", "click", **command), pending)
        self.assertEqual(len(self.calls), before)

        # Only the trusted extension channel can retrieve/decide this exact request.
        approvals = self.daemon._dispatch_extension("instance-v2", "extension.approvals", {})
        self.assertEqual(len(approvals), 1)
        approval = approvals[0]
        self.assertEqual(approval["request"], dict(
            taskId="task-v2", requestId="click-1", action="click", tabId=7, **command,
        ))
        self.assertEqual(approval["generation"], 4)
        self.assertEqual(approval["modeGeneration"], 1)
        self.assertEqual(approval["digest"], pending["digest"])
        self.assertEqual(approval["expiresAt"], pending["expiresAt"])
        decision = dict(taskId="task-v2", nonce=approval["nonce"], digest=approval["digest"], approve=True)
        self.assertEqual(
            self.daemon._dispatch_extension("instance-v2", "extension.decide", decision),
            {"status": "approved"},
        )
        # Bounded wait for the real worker; querying never creates a new request ID.
        deadline = time.monotonic() + 2
        while True:
            with self.daemon.state_lock:
                finished = not self.daemon.action_approvals
            if finished or time.monotonic() >= deadline:
                break
            time.sleep(.005)
        self.assertTrue(finished, "approval worker did not finish")
        result = self.run_action("click-1", "click", **command)
        self.assertEqual(result, {"ok": True, "action": "click"})
        self.assertEqual(len(self.calls), before + 1)
        extension, method, params, _ = self.calls[-1]
        self.assertIs(extension, self.extension)
        self.assertEqual(method, "browser.execute")
        self.assertEqual(params, dict(
            **approval["request"], generation=4, modeGeneration=1,
            allowedOrigins=["https://example.com"],
            approval={"nonce": approval["nonce"], "digest": approval["digest"]},
        ))
        for _ in range(3):
            self.assertEqual(self.run_action("click-1", "click", **command), result)
        with self.assertRaises(daemon_module.ProtocolError) as replay:
            self.daemon._dispatch_extension("instance-v2", "extension.decide", decision)
        self.assertEqual(replay.exception.code, "approval_stale")
        with self.assertRaises(daemon_module.ProtocolError) as conflict:
            self.run_action("click-1", "click", selector="#other")
        self.assertEqual(conflict.exception.code, "request_id_conflict")
        self.assertEqual(len(self.calls), before + 1)
        self.assertEqual(self.task.get("activeMode", "smart"), "smart")
        self.assertEqual(self.daemon._dispatch_extension("instance-v2", "extension.approvals", {}), [])

    def test_daemon_rejects_malformed_fields_and_unsupported_actions_before_extension(self):
        cases = [
            ("semantic_snapshot", {"options": {"mode": "interactive", "owner": "forged"}}, "invalid_params"),
            ("ref_click", {"binding": {"taskId": "task-v2", "documentId": "d", "leaseId": "l"}, "snapshotId": "s"}, "invalid_params"),
        ]
        cases.append(("interaction.capture", {"unexpected": True}, "invalid_params"))
        cases.extend((action, {}, "invalid_params") for action in (
            "interaction.bounds", "interaction.click",
            "interaction.drag_coordinates", "interaction.drag_elements",
        ))
        cases.extend((action, {}, "invalid_action") for action in ("js", "cdp"))
        # 中文注释：无效语义按键在批准或派发前必须被拒绝。
        cases.append(("ref_press", {"binding": {"taskId": "task-v2", "documentId": "d", "leaseId": "l"},
                                      "snapshotId": "s", "ref": "r", "key": "Delete"}, "invalid_params"))
        cases.append(("ref_press", {"binding": {"taskId": "task-v2", "documentId": "d", "leaseId": "l"},
                                      "snapshotId": "s", "ref": "r", "key": ["Enter"]}, "invalid_params"))
        for index, (action, extra, code) in enumerate(cases):
            with self.subTest(action=action):
                self.task["state"] = "ready"
                with self.assertRaises(daemon_module.ProtocolError) as caught:
                    self.run_action(f"invalid-{index}", action, **extra)
                self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.calls, [])

    def test_file_upload_requires_registered_artifact_before_smart_approval_or_dispatch(self):
        artifact_id = '12345678-1234-1234-1234-123456789abc'
        with self.assertRaises(daemon_module.ProtocolError) as smart:
            self.run_action('file-smart', 'files.upload', selector='#file', artifactIds=[artifact_id])
        # 中文注释：智能审批不会绕过文件登记，缺失文件在弹窗前明确拒绝。
        self.assertEqual(smart.exception.code, 'artifact_unavailable')
        self.task['activeMode'] = 'full'
        with self.assertRaises(daemon_module.ProtocolError) as missing:
            self.run_action('file-missing', 'files.upload', selector='#file', artifactIds=[artifact_id])
        # 中文注释：无登记 ID 不会触发 CDP 文件选择，也不会被当成空文件上传。
        self.assertEqual(missing.exception.code, 'artifact_unavailable')
        self.assertEqual(self.calls, [])

    def test_timeout_preserves_task_and_same_request_is_not_replayed(self):
        dispatches = []

        def timeout_call(_extension, method, _params, **_kwargs):
            dispatches.append(method)
            raise daemon_module.ProtocolError("extension_timeout", "fixture timeout")

        self.daemon._extension_call = timeout_call
        # 中文注释：只读和写动作都缓存超时，但只有写动作的执行结果不确定。
        self.task['activeMode'] = 'full'
        for action, extra in [('screenshot', {}), ('click', {'selector': '#button'})]:
            with self.subTest(action=action):
                request_id = 'timeout-' + action
                before = len(dispatches)
                with self.assertRaises(daemon_module.ProtocolError) as first:
                    self.run_action(request_id, action, **extra)
                self.assertEqual(first.exception.code, 'extension_timeout')
                if action == 'screenshot':
                    self.assertIs(first.exception.data['outcomeUnknown'], False)
                self.assertEqual(self.task['state'], 'ready')
                self.assertEqual(self.task['generation'], 4)
                self.assertEqual(self.daemon.tab_leases[('instance-v2', 7)], 'task-v2')
                with self.assertRaises(daemon_module.ProtocolError) as replay:
                    self.run_action(request_id, action, **extra)
                self.assertEqual(replay.exception.code, 'extension_timeout')
                self.assertEqual(replay.exception.data, first.exception.data)
                self.assertEqual(dispatches[before:], ['browser.execute'])

    def test_disconnection_marks_needs_sync_and_same_request_is_not_replayed(self):
        # 中文注释：断线与单次超时不同，仍须撤销代次、释放扩展状态并拒绝重放。
        dispatches = []

        def disconnected_call(_extension, method, _params, **_kwargs):
            dispatches.append(method)
            raise daemon_module.ProtocolError('extension_disconnected', 'fixture disconnected')

        self.daemon._extension_call = disconnected_call
        with self.assertRaises(daemon_module.ProtocolError) as first:
            self.run_action("unknown-1", "screenshot")
        self.assertEqual(first.exception.code, "extension_disconnected")
        self.assertEqual(self.task["state"], "needs_sync")
        with self.assertRaises(daemon_module.ProtocolError) as replay:
            self.run_action("unknown-1", "screenshot")
        self.assertEqual(replay.exception.code, "request_outcome_unavailable")
        self.assertEqual(dispatches.count("browser.execute"), 1)
        self.assertEqual(dispatches.count("browser.release"), 1)


if __name__ == "__main__":
    unittest.main()
