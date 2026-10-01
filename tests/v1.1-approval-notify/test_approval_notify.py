"""Action-approval notification through the real native dispatcher; no browser launch."""
from __future__ import annotations

import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-bridge"))
from daemon import BridgeDaemon, ProtocolError


class ApprovalNotificationTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes" / "cache" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        now = time.time()
        self.task = dict(id="task", owner="owner", title="test", instanceId="browser",
                         browser="chrome", state="ready", generation=1, modeGeneration=1,
                         activeMode="smart", allowedOrigins=["https://example.com"],
                         tabIds=[7], agentTabIds=[],
                         requestHistory=[], createdAt=now, updatedAt=now, isolation="shared-profile")
        self.daemon.tasks["task"] = self.task
        self.daemon.task_locks["task"] = threading.RLock()
        self.daemon.cleanup_locks["task"] = threading.Lock()
        self.daemon.tab_leases[("browser", 7)] = "task"
        self.daemon.dedupe["task"] = {}
        self.daemon.extensions["browser"] = {"instanceId": "browser"}
        self.executed = []
        self.daemon._extension_call = lambda *_args, **_kwargs: self.executed.append(1) or {"ok": True}
        self.params = dict(owner="owner", taskId="task", requestId="one", action="click",
                           tabId=7, selector="#submit")

    def connect_extension(self):
        self.daemon.extensions.pop("browser")  # Replace synthetic entry via real hello.
        host, peer = socket.socketpair()
        peer.settimeout(2)
        reader = peer.makefile("rb")
        host_reader = host.makefile("rb")
        def dispatch():
            try:
                self.daemon._serve_extension(host, host_reader, "chrome-extension://test")
            except (EOFError, OSError):
                pass  # The test closes its own transport after its assertions.
            finally:
                host_reader.close()
        thread = threading.Thread(target=dispatch, daemon=True)
        thread.start()
        def close():
            try:
                peer.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            reader.close()
            peer.close()
            host.close()
            thread.join(2)
            self.assertFalse(thread.is_alive(), "extension dispatcher did not stop")
        self.addCleanup(close)
        peer.sendall(b'{"id":"hello","method":"extension.hello","params":{"instanceId":"browser","browser":"chrome","version":"1"}}\n')
        self.assertEqual(json.loads(reader.readline())["result"], {"connected": True})
        return peer, reader, thread

    def test_new_request_notifies_real_dispatcher_without_holding_either_lock(self):
        peer, reader, thread = self.connect_extension()
        callback_done = threading.Event()
        notification_started = threading.Event()
        observed = []
        original = self.daemon._notify_tasks_changed

        def receiver():
            try:
                self.assertTrue(notification_started.wait(1))
                changed = json.loads(reader.readline())
                observed.append(changed)
                peer.sendall(b'{"id":"approvals","method":"extension.approvals","params":{}}\n')
                reply = json.loads(reader.readline())
                # 中文注释：hello 的异步刷新通知可以交错，响应必须按请求 ID 读取。
                while reply.get('id') != 'approvals':
                    self.assertEqual(reply.get('method'), 'tasks.changed')
                    reply = json.loads(reader.readline())
                observed.append(reply)
                # A second client must be able to re-enter this very task while the
                # synchronous notifier waits, not just acquire the global lock.
                repeated = self.daemon._dispatch_client("shared.run", dict(self.params))
                observed.append(repeated)
            finally:
                callback_done.set()

        def synchronous_notification(instance_id):
            # 中文注释：hello 的收组通知不代表有待审批动作；只对本次动作通知检查可重入性。
            if not self.daemon.action_approvals:
                original(instance_id)
                return
            notification_started.set()
            original(instance_id)
            if not callback_done.wait(1):
                raise AssertionError("notification blocked dispatcher or task re-entry")

        self.daemon._notify_tasks_changed = synchronous_notification
        handler = threading.Thread(target=receiver, daemon=True)
        handler.start()
        self.addCleanup(lambda: handler.join(2))
        result = self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(result["status"], "approval_required")
        self.assertTrue(callback_done.is_set())
        self.assertEqual(observed[0], {"method": "tasks.changed", "params": {}})
        self.assertEqual(observed[1]["id"], "approvals")
        self.assertEqual(len(observed[1]["result"]), 1)
        self.assertEqual(observed[1]["result"][0]["request"]["requestId"], "one")
        self.assertEqual(observed[2], result)
        self.assertEqual(self.executed, [])
        self.assertTrue(thread.is_alive())

    def test_repeat_request_notifies_once_and_does_not_replay_after_denial(self):
        notifications = []
        self.daemon._notify_tasks_changed = notifications.append
        first = self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(notifications, ["browser"])
        self.assertEqual(self.daemon._dispatch_client("shared.run", dict(self.params)), first)
        self.assertEqual(notifications, ["browser"])
        approval = self.daemon._dispatch_extension("browser", "extension.approvals", {})[0]
        self.assertEqual(len(approval["request"]), 5)
        self.assertEqual(len(self.task["requestHistory"]), 1)
        # 中文注释：同步读盘测试显式等待异步快照刷新。
        self.daemon._flush_tasks()
        persisted = json.loads(self.daemon.tasks_path.read_text())
        self.assertEqual(persisted["tasks"][0]["requestHistory"], self.task["requestHistory"])
        self.assertNotIn(approval["nonce"], self.daemon.tasks_path.read_text())
        self.assertEqual(self.daemon._dispatch_extension("browser", "extension.decide", dict(
            taskId="task", nonce=approval["nonce"], digest=approval["digest"], approve=False)),
            {"status": "denied"})
        with self.assertRaises(ProtocolError) as denied:
            self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(denied.exception.code, "approval_denied")
        self.assertEqual(notifications, ["browser"])
        self.assertEqual(self.executed, [])
        another = dict(self.params, requestId="two")
        self.assertEqual(self.daemon._dispatch_client("shared.run", another)["status"], "approval_required")
        self.assertEqual(notifications, ["browser", "browser"])

    def test_disconnected_notification_socket_preserves_pending_and_no_replay(self):
        class ClosedSocket:
            def sendall(self, _data):
                raise BrokenPipeError("extension disconnected")
        self.daemon.extensions["browser"] = dict(socket=ClosedSocket(), sendLock=threading.Lock())
        first = self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(first["status"], "approval_required")
        self.assertEqual(self.daemon._dispatch_client("shared.run", dict(self.params)), first)
        self.assertEqual(len(self.daemon.action_approvals), 1)
        self.assertEqual(len(self.task["requestHistory"]), 1)
        self.assertEqual(self.executed, [])
        self.daemon._flush_tasks()
        restored = BridgeDaemon(Path(self.temp.name))
        restored._load_tasks()
        self.assertEqual(len(restored.tasks["task"]["requestHistory"]), 1)
        self.assertEqual(restored.action_approvals, {})

    def test_real_disconnect_revokes_pending_without_replaying_action(self):
        peer, reader, thread = self.connect_extension()
        first = self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(first["status"], "approval_required")
        self.assertEqual(json.loads(reader.readline()), {"method": "tasks.changed", "params": {}})
        peer.shutdown(socket.SHUT_RDWR)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("browser", self.daemon.extensions)
        self.assertEqual(self.task["state"], "needs_sync")
        self.assertEqual(self.daemon.action_approvals, {})
        with self.assertRaises(ProtocolError) as revoked:
            self.daemon._dispatch_client("shared.run", dict(self.params))
        self.assertEqual(revoked.exception.code, "approval_revoked")
        self.assertEqual(self.executed, [])


if __name__ == "__main__":
    unittest.main()
