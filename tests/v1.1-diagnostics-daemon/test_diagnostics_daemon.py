"""Vertical synthetic route -> production daemon dispatcher -> diagnostics projection.

No browser, Hermes process, installed package, or personal diagnostics are used.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = ROOT / "executor-plugin"
for entry in (ROOT / "native-bridge", ROOT / "browser-diagnostics" / "python"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from browser_diagnostics import JsonlDiagnosticSink  # noqa: E402
from daemon import BridgeDaemon, ProtocolError  # noqa: E402

API_PATH = PLUGIN_ROOT / "dashboard" / "plugin_api.py"
PREFIX = "/api/plugins/browser-link/shared/tasks"
TASK_ID = "task-diagnostics-A"
INSTANCE_ID = "instance-diagnostics-A"
SECRET_URL = "https://private.invalid/path?token=diagnostics-secret"
SECRET_ERROR = f"sensitive exception text {SECRET_URL}"


def _load_api():
    name = "diagnostics_daemon_api_" + hashlib.sha256(str(API_PATH).encode()).hexdigest()[:16]
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, API_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("dashboard API module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


class ProductionDaemonRPC:
    """Only adapt the call shape; dispatch through BridgeDaemon's real router."""

    def __init__(self, daemon):
        self.daemon = daemon
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        return self.daemon._dispatch_client(method, params)


class DiagnosticsDaemonIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "hermes-home"
        self.daemon = BridgeDaemon(self.home)
        self.daemon._prepare_data_dir()
        notification_sender, self.notification_peer = socket.socketpair()
        self.addCleanup(notification_sender.close)
        self.addCleanup(self.notification_peer.close)

        self.api = _load_api()
        native_tools = self.api._native_tools()
        runtime_module = native_tools.runtime_module()
        self.rpc = ProductionDaemonRPC(self.daemon)
        self.runtime = runtime_module.NativeProfileRuntime(
            self.home, PLUGIN_ROOT, bridge_client=self.rpc
        )
        self.owner = self.runtime.authority.ui_owner()
        task = {
            "id": TASK_ID,
            "owner": self.owner,
            "title": "synthetic diagnostics task",
            "instanceId": INSTANCE_ID,
            "browser": "chrome",
            "state": "ready",
            "generation": 1,
            # 中文注释：诊断用例验证已授权动作记录；首次网站批准由权限专用用例覆盖。
            "activeMode": "full",
            "modeGeneration": 1,
            "allowedOrigins": ["https://example.com"],
                        "tabIds": [7],
            "agentTabIds": [],
            "requestHistory": [],
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "isolation": "shared-profile",
        }
        self.daemon.tasks[TASK_ID] = task
        self.daemon.task_locks[TASK_ID] = threading.RLock()
        self.daemon.cleanup_locks[TASK_ID] = threading.Lock()
        self.daemon.dedupe[TASK_ID] = {}
        self.daemon.tab_leases[(INSTANCE_ID, 7)] = TASK_ID
        self.daemon.extensions[INSTANCE_ID] = {
            "instanceId": INSTANCE_ID,
            "browser": "chrome",
            "version": "synthetic",
            "pendingLock": threading.Lock(),
            "pending": {},
            "sendLock": threading.Lock(),
            "socket": notification_sender,
        }
        self.daemon._persist_tasks()
        # 中文注释：快照异步写入，文件读回断言须等待显式刷新。
        self.daemon._flush_tasks()

        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/browser-link")
        self.client = TestClient(app)
        setattr(self.api, "_native_profile_runtime", lambda: self.runtime)

    def run_snapshot(self, request_id, *, fail=False, write=False):
        def extension_call(_extension, _method, params, timeout=15.0):
            if fail:
                raise ProtocolError("extension_timeout", SECRET_ERROR)
            return {"text": "synthetic page readback", "requestId": params["requestId"]}

        self.daemon._extension_call = extension_call
        params = {
            "owner": self.owner,
            "taskId": TASK_ID,
            "requestId": request_id,
            "action": "click" if write else "snapshot",
            "tabId": 7,
        }
        if write:
            self.daemon.tasks[TASK_ID]["activeMode"] = "full"
            params["selector"] = "#synthetic"
        return self.daemon._dispatch_client("shared.run", params)

    def diagnostic_path(self):
        return self.daemon.data_dir / "diagnostics"

    def event_files_snapshot(self, root=None):
        root = root or self.diagnostic_path()
        if not root.exists():
            return {}
        return {
            path.name: path.read_bytes()
            for path in root.iterdir()
            if path.is_file() and (path.name == "events.jsonl" or path.name.startswith("events."))
        }

    def test_route_reads_real_daemon_request_events_with_bounded_pagination(self):
        self.run_snapshot("private-request-one")
        self.run_snapshot("private-request-two")
        before_logs = self.event_files_snapshot()
        before_tasks = self.daemon.tasks_path.read_bytes()

        first = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"limit": "1", "cursor": "0"}
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual([event["status"] for event in first.json()["events"]], ["succeeded"])
        self.assertTrue(first.json()["has_more"])
        self.assertEqual(first.json()["next_cursor"], 1)

        second = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"limit": "1", "cursor": "1"}
        )
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual([event["status"] for event in second.json()["events"]], ["succeeded"])
        self.assertFalse(second.json()["has_more"])
        self.assertIsNone(second.json()["next_cursor"])

        calls = [params for method, params in self.rpc.calls if method == "shared.diagnostics"]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], {
            "owner": self.owner,
            "taskId": TASK_ID,
            "limit": 1,
            "cursor": 0,
        })
        for response in (first, second):
            self.assertNotIn(self.owner, response.text)
            self.assertNotIn("private-request-one", response.text)
            self.assertNotIn("private-request-two", response.text)
            self.assertTrue(all(set(row) == {
                "timestamp", "component", "event_type", "status", "duration_ms", "error_code"
            } for row in response.json()["events"]))
        self.assertEqual(self.event_files_snapshot(), before_logs)
        self.assertEqual(self.daemon.tasks_path.read_bytes(), before_tasks)

    def test_request_hash_is_derived_and_only_registered_hash_is_queryable(self):
        request_id = "raw-request-id-must-not-be-stored"
        self.run_snapshot(request_id)
        request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest()

        response = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"requestIdHash": request_hash}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["events"]), 1)
        self.assertNotIn(request_hash, response.text)
        self.assertNotIn(request_id, response.text)
        self.assertEqual(self.rpc.calls[-1], ("shared.diagnostics", {
            "owner": self.owner,
            "taskId": TASK_ID,
            "limit": 50,
            "cursor": 0,
            "requestIdHash": request_hash,
        }))

        with self.assertRaises(ProtocolError) as missing_hash:
            self.daemon._dispatch_client("shared.diagnostics", {
                "owner": self.owner,
                "taskId": TASK_ID,
                "requestIdHash": "f" * 64,
                "limit": 50,
                "cursor": 0,
            })
        self.assertEqual(missing_hash.exception.code, "not_found")

    def test_daemon_rejects_forged_owner_unknown_fields_and_invalid_pagination(self):
        base = {"owner": self.owner, "taskId": TASK_ID, "limit": 50, "cursor": 0}
        cases = [
            (dict(base, owner="script-asserted-owner"), "forbidden"),
            (dict(base, taskId="missing-task"), "not_found"),
            (dict(base, url=SECRET_URL), "invalid_params"),
            (dict(base, session_id="script-asserted-session"), "invalid_params"),
            (dict(base, limit=True), "invalid_params"),
            (dict(base, limit=101), "invalid_params"),
            (dict(base, cursor=-1), "invalid_params"),
            (dict(base, cursor=10**20), "invalid_params"),
            (dict(base, requestId="raw-request-id"), "invalid_params"),
            (dict(base, requestIdHash="A" * 64), "invalid_params"),
            (dict(base, requestIdHash=None), "invalid_params"),
        ]
        for params, expected_code in cases:
            with self.subTest(params=sorted(params)):
                with self.assertRaises(ProtocolError) as caught:
                    self.daemon._dispatch_client("shared.diagnostics", params)
                self.assertEqual(caught.exception.code, expected_code)

        calls_before = list(self.rpc.calls)
        response = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics?owner=script-asserted-owner"
        )
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("script-asserted-owner", response.text)
        self.assertEqual(self.rpc.calls, calls_before)

    def test_request_failure_logs_fixed_code_without_url_or_exception_text(self):
        request_id = "private-failing-request"
        with self.assertRaises(ProtocolError):
            self.run_snapshot(request_id, fail=True, write=True)
        request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
        raw_logs = "\n".join(path.read_text(encoding="ascii") for path in self.diagnostic_path().glob("events*.jsonl"))
        self.assertNotIn(request_id, raw_logs)
        self.assertNotIn(SECRET_URL, raw_logs)
        self.assertNotIn(SECRET_ERROR, raw_logs)

        response = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"requestIdHash": request_hash}
        )
        self.assertEqual(response.status_code, 200, response.text)
        event = response.json()["events"][-1]
        self.assertEqual(event["status"], "unknown")
        self.assertEqual(event["error_code"], "TIMEOUT")
        self.assertNotIn(SECRET_URL, response.text)
        self.assertNotIn(SECRET_ERROR, response.text)

    def test_read_only_timeout_remains_known_failed_diagnostic(self):
        request_id = "private-read-only-timeout"
        with self.assertRaises(ProtocolError):
            self.run_snapshot(request_id, fail=True)
        request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest()

        response = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"requestIdHash": request_hash}
        )

        self.assertEqual(response.status_code, 200, response.text)
        event = response.json()["events"][-1]
        self.assertEqual(event["status"], "failed")
        self.assertEqual(event["error_code"], "TIMEOUT")
        self.assertNotIn(SECRET_URL, response.text)
        self.assertNotIn(SECRET_ERROR, response.text)

    def test_empty_log_file_is_not_reported_as_provided_history(self):
        root = self.diagnostic_path()
        JsonlDiagnosticSink(root, max_bytes=4096, max_files=5)
        log_path = root / "events.jsonl"
        log_path.write_bytes(b"")
        log_path.chmod(0o600)
        before = log_path.read_bytes()

        response = self.client.get(f"{PREFIX}/{TASK_ID}/diagnostics")

        self.assertEqual(response.status_code, 503)
        self.assertIn("未提供", response.json()["detail"])
        self.assertEqual(log_path.read_bytes(), before)

    def test_absent_logs_are_reported_as_not_provided_without_creating_them(self):
        self.assertFalse(self.diagnostic_path().exists())

        response = self.client.get(f"{PREFIX}/{TASK_ID}/diagnostics")

        self.assertEqual(response.status_code, 503)
        self.assertIn("未提供", response.json()["detail"])
        self.assertFalse(self.diagnostic_path().exists())
        self.assertEqual(self.event_files_snapshot(), {})

    def test_real_daemon_cancel_writes_owner_scoped_task_state_event(self):
        request_id = "request-before-cancel"
        self.run_snapshot(request_id)
        self.daemon._extension_call = lambda *_args, **_kwargs: {
            "released": True,
            "cleanupState": "succeeded",
            "remainingTabIds": [],
            "preservedTabIds": [],
            "unknownTabIds": [],
        }

        cancelled = self.daemon._dispatch_client("shared.cancel", {
            "owner": self.owner,
            "taskId": TASK_ID,
        })
        response = self.client.get(f"{PREFIX}/{TASK_ID}/diagnostics")

        self.assertEqual(cancelled["state"], "cancelled")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [event["event_type"] for event in response.json()["events"]],
            ["request_state", "task_state"],
        )
        self.assertEqual(response.json()["execution_state"], "cancelled")
        self.assertEqual(response.json()["cleanup_state"], "succeeded")

        request_hash = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
        filtered = self.client.get(
            f"{PREFIX}/{TASK_ID}/diagnostics", params={"requestIdHash": request_hash}
        )
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual([event["event_type"] for event in filtered.json()["events"]], ["request_state"])

    def test_read_after_daemon_restart_uses_existing_logs_without_writer_recovery(self):
        self.run_snapshot("persisted-request")
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.rpc = ProductionDaemonRPC(restored)
        self.runtime._client = self.rpc
        root = restored.data_dir / "diagnostics"
        before_logs = self.event_files_snapshot(root)
        restored._flush_tasks()
        before_tasks = restored.tasks_path.read_bytes()

        response = self.client.get(f"{PREFIX}/{TASK_ID}/diagnostics")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([event["status"] for event in response.json()["events"]], ["succeeded"])
        self.assertIsNone(restored.diagnostics)
        self.assertEqual(self.event_files_snapshot(root), before_logs)
        self.assertEqual(restored.tasks_path.read_bytes(), before_tasks)


if __name__ == "__main__":
    unittest.main()
