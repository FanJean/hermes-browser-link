"""Sensitive fields are filled by the person, never typed by the bridge.

In-process daemon with a synthetic extension; no browser or socket is used.
"""
import tempfile
import threading
import time
import unittest
from pathlib import Path

from daemon import BridgeDaemon, ProtocolError


class ManualInputTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._persist_tasks = lambda: None
        self.daemon._notify_tasks_changed = lambda _instance: None
        self.daemon.extensions["browser-a"] = {"instanceId": "browser-a", "browser": "edge", "version": "t"}
        self.executed = []
        self.assessment = {"targetAssessment": "sensitive", "fieldKind": "password"}
        self.daemon._extension_call = self.extension_call
        self.seed()

    def seed(self, mode="smart"):
        now = time.time()
        self.daemon.tasks["task-a"] = {
            "id": "task-a", "owner": "owner-a", "title": "登录", "instanceId": "browser-a", "browser": "edge",
            "state": "ready", "generation": 1, "modeGeneration": 1, "activeMode": mode,
            "allowedOrigins": ["https://example.test"],
            "tabIds": [7], "agentTabIds": [7], "workTabs": [], "workspaceState": "ready",
            "requestHistory": [], "createdAt": now, "updatedAt": now, "isolation": "shared-profile",
        }
        self.daemon.task_locks["task-a"] = threading.RLock()
        self.daemon.cleanup_locks["task-a"] = threading.Lock()
        self.daemon.dedupe["task-a"] = {}
        self.daemon.tab_leases[("browser-a", 7)] = "task-a"

    def extension_call(self, _extension, method, params, **_):
        if method == "browser.assess":
            return dict(self.assessment)
        if method == "browser.execute":
            self.executed.append(dict(params))
            return {"ok": True, "filled": True, "tabId": params.get("tabId")}
        raise AssertionError(method)

    def fill(self, request_id="fill-1", text="model-guess"):
        return self.daemon._dispatch_client("shared.run", {
            "owner": "owner-a", "taskId": "task-a", "requestId": request_id, "action": "fill",
            "tabId": 7, "selector": "#password", "text": text})

    def approvals(self):
        return self.daemon._dispatch_extension("browser-a", "extension.approvals", {})

    def decide(self, approve):
        pending = self.approvals()[0]
        return self.daemon._dispatch_extension("browser-a", "extension.decide", {
            "taskId": "task-a", "nonce": pending["nonce"], "digest": pending["digest"], "approve": approve})

    def test_sensitive_field_asks_the_person_and_is_never_dispatched(self):
        result = self.fill()
        self.assertEqual(result["status"], "user_input_required")
        self.assertEqual(result["fieldKind"], "password")
        self.assertEqual(self.executed, [])
        listed = self.approvals()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["kind"], "manual_input")
        self.assertEqual(listed[0]["fieldKind"], "password")
        self.assertNotIn("text", listed[0]["request"], "a model-supplied value must not reach the panel")
        # Asking again returns the same pending request, not a second one.
        self.assertEqual(self.fill()["status"], "user_input_required")
        self.assertEqual(len(self.approvals()), 1)

    def test_filled_by_user_completes_the_same_request_without_typing(self):
        self.fill()
        self.assertEqual(self.decide(True), {"status": "completed"})
        result = self.fill()
        self.assertEqual(result, {"status": "completed_by_user", "filledBy": "user", "fieldKind": "password"})
        self.assertEqual(self.executed, [])
        self.assertEqual(self.approvals(), [])

    def test_declined_is_a_definite_rejection(self):
        self.fill()
        self.assertEqual(self.decide(False), {"status": "denied"})
        with self.assertRaises(ProtocolError) as caught:
            self.fill()
        self.assertEqual(caught.exception.code, "user_input_declined")
        self.assertEqual(self.executed, [])

    def test_full_access_still_asks_the_person(self):
        self.seed(mode="full")
        self.assertEqual(self.fill()["status"], "user_input_required")
        self.assertEqual(self.executed, [])

    def test_unanswered_request_expires(self):
        self.fill()
        for pending in self.daemon.action_approvals.values():
            pending["expiresAt"] = time.time() - 1
        with self.assertRaises(ProtocolError) as caught:
            self.fill()
        self.assertEqual(caught.exception.code, "approval_expired")

    def test_payment_and_otp_kinds_are_reported(self):
        for kind in ("payment", "otp", "bogus"):
            with self.subTest(kind=kind):
                self.assessment = {"targetAssessment": "sensitive", "fieldKind": kind}
                result = self.fill(request_id=f"fill-{kind}")
                self.assertEqual(result["fieldKind"], kind if kind != "bogus" else "sensitive")

    def test_ordinary_field_keeps_the_normal_approval_flow(self):
        self.assessment = {"targetAssessment": "ordinary"}
        result = self.fill()
        self.assertEqual(result["status"], "approval_required")
        self.assertEqual(self.approvals()[0]["kind"], "action")
        self.assertIn("text", self.approvals()[0]["request"])


if __name__ == "__main__":
    unittest.main()
