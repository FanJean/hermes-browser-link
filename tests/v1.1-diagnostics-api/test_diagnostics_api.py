"""Synthetic public-route tests for task diagnostics API wiring."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = ROOT / "executor-plugin"
DIAGNOSTICS_PYTHON = ROOT / "browser-diagnostics" / "python"
if str(DIAGNOSTICS_PYTHON) not in sys.path:
    sys.path.insert(0, str(DIAGNOSTICS_PYTHON))

from browser_diagnostics import JsonlDiagnosticSink
from browser_diagnostics.schema import make_event

PREFIX = "/api/plugins/browser-link/shared/tasks"
REQUEST_HASH = "a" * 64


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


class SyntheticDiagnosticsBridge:
    """In-memory daemon boundary backed by the real JSONL projection."""

    def __init__(self, tasks, projection):
        self.tasks = tasks
        self.projection = projection
        self.calls = []
        self.diagnostics_result_override: dict[str, Any] | None = None
        self.diagnostics_error: BaseException | None = None

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == "shared.list":
            return [dict(task) for task in self.tasks.values() if task["owner"] == params["owner"]]
        if method == "shared.diagnostics":
            if self.diagnostics_error is not None:
                raise self.diagnostics_error
            if self.diagnostics_result_override is not None:
                return self.diagnostics_result_override
            task = self.tasks.get(params["taskId"])
            if task is None or task["owner"] != params["owner"]:
                raise PermissionError("private owner and diagnostics path")
            return self.projection.query(
                task,
                params["owner"],
                params["taskId"],
                params.get("requestIdHash"),
                limit=params["limit"],
                cursor=params["cursor"],
            )
        raise RuntimeError("unsupported synthetic bridge method")


class DiagnosticsApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.api = _load_module("diagnostics_api_under_test", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
        self.projection_module = _load_module("diagnostics_projection_under_test", PLUGIN_ROOT / "task_diagnostics.py")
        self.sink = JsonlDiagnosticSink(Path(self.tmp.name) / "diagnostics", max_bytes=4096, max_files=5)
        self.projection = self.projection_module.TaskDiagnosticProjection(self.sink)
        self.bridge = SyntheticDiagnosticsBridge({}, self.projection)

        tools = self.api._native_tools()
        runtime_module = tools.runtime_module()
        self.runtime = runtime_module.NativeProfileRuntime(
            Path(self.tmp.name) / "hermes-home", PLUGIN_ROOT, bridge_client=self.bridge
        )
        self.runtime.authority.pre_tool_call(
            "browser_shared_list", {}, session_id="trusted-diagnostics-session", tool_call_id="call-1"
        )
        self.owner = self.runtime.authority.owner_for_session("trusted-diagnostics-session")
        self.task_id = "task-diagnostics"
        self.task = {
            "id": self.task_id,
            "owner": self.owner,
            "state": "ready",
            "cleanupState": "succeeded",
            "requestHistory": [{"requestIdHash": REQUEST_HASH, "payloadHash": "b" * 64}],
        }
        self.bridge.tasks[self.task_id] = self.task
        setattr(self.api, "_native_profile_runtime", lambda: self.runtime)

        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/browser-link")
        self.client = TestClient(app)

    def _write_event(self, status, *, task_id=None, request_id=REQUEST_HASH):
        self.sink.write(make_event(
            timestamp="2026-09-23T10:00:00.000Z",
            component="native_bridge",
            event_type="request_state",
            task_id=self.task_id if task_id is None else task_id,
            request_id=request_id,
            status=status,
            duration_ms=12.5,
        ))

    # 中文注释：用户接管是已知 paused 状态，不应投影为未知或被 API 拒绝。
    def test_paused_task_remains_paused_in_diagnostics(self):
        self.task["state"] = "paused"
        response = self.client.get(f"{PREFIX}/{self.task_id}/diagnostics")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["execution_state"], "paused")

    def test_real_api_route_returns_real_log_projection_in_bounded_pages(self):
        self._write_event("running")
        self._write_event("succeeded")
        before = {
            path.name: path.read_bytes()
            for path in Path(self.sink.root).iterdir()
            if path.is_file()
        }

        first = self.client.get(
            f"{PREFIX}/{self.task_id}/diagnostics",
            params={"requestIdHash": REQUEST_HASH, "limit": "1", "cursor": "0"},
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), {
            "events": [{
                "timestamp": "2026-09-23T10:00:00.000Z",
                "component": "native_bridge",
                "event_type": "request_state",
                "status": "running",
                "duration_ms": 12.5,
                "error_code": None,
                "action": None,
            }],
            "execution_state": "ready",
            "cleanup_state": "succeeded",
            "has_more": True,
            "next_cursor": 1,
        })
        second = self.client.get(
            f"{PREFIX}/{self.task_id}/diagnostics",
            params={"requestIdHash": REQUEST_HASH, "limit": "1", "cursor": "1"},
        )
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual([event["status"] for event in second.json()["events"]], ["succeeded"])
        self.assertFalse(second.json()["has_more"])
        diagnostic_calls = [call for call in self.bridge.calls if call[0] == "shared.diagnostics"]
        self.assertEqual(len(diagnostic_calls), 2)
        for _, params in diagnostic_calls:
            self.assertEqual(params, {
                "owner": self.owner,
                "taskId": self.task_id,
                "requestIdHash": REQUEST_HASH,
                "limit": 1,
                "cursor": params["cursor"],
            })
            self.assertNotIn("requestId", params)
        after = {
            path.name: path.read_bytes()
            for path in Path(self.sink.root).iterdir()
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertNotIn(self.owner, first.text)
        self.assertNotIn(REQUEST_HASH, first.text)

    def test_malformed_diagnostics_projection_is_rejected_without_secret_leak(self):
        secret_url = "https://private.invalid/path?token=diagnostics-secret"
        self.bridge.diagnostics_result_override = {
            "events": [{
                "timestamp": "2026-09-23T10:00:00.000Z",
                "component": "native_bridge",
                "event_type": "request_state",
                "status": "failed",
                "duration_ms": 1,
                "error_code": "INTERNAL_ERROR",
                "url": secret_url,
            }],
            "execution_state": "ready",
            "cleanup_state": "succeeded",
            "has_more": False,
            "next_cursor": None,
        }

        response = self.client.get(f"{PREFIX}/{self.task_id}/diagnostics")

        self.assertEqual(response.status_code, 503)
        self.assertNotIn(secret_url, response.text)
        self.assertNotIn("diagnostics-secret", response.text)

    def test_unavailable_diagnostics_service_is_reported_as_not_provided_safely(self):
        secret = "private owner token https://private.invalid/?access_token=secret-value"
        self.bridge.diagnostics_error = RuntimeError(secret)

        response = self.client.get(f"{PREFIX}/{self.task_id}/diagnostics")

        self.assertEqual(response.status_code, 503)
        self.assertIn("未提供", response.json()["detail"])
        self.assertNotIn("private", response.text)
        self.assertNotIn("secret-value", response.text)

    def test_query_allowlist_rejects_identity_raw_request_ids_and_invalid_pages_before_rpc(self):
        bad_queries = [
            "?owner=private-owner",
            "?session_id=private-session",
            "?requestId=raw-request-secret",
            "?url=https%3A%2F%2Fprivate.invalid%2F%3Ftoken%3Dquery-secret",
            "?requestIdHash=" + "A" * 64,
            "?requestIdHash=",
            "?limit=0",
            "?limit=101",
            "?limit=1&limit=2",
            "?cursor=-1",
            "?cursor=1&cursor=2",
        ]
        for query in bad_queries:
            with self.subTest(query=query):
                self.bridge.calls.clear()
                response = self.client.get(f"{PREFIX}/{self.task_id}/diagnostics{query}")
                self.assertEqual(response.status_code, 422, response.text)
                self.assertNotIn("private-owner", response.text)
                self.assertNotIn("query-secret", response.text)
                self.assertEqual(self.bridge.calls, [])

    def test_task_lookup_requires_one_registered_owner_and_never_uses_http_owner(self):
        foreign_id = "foreign-unregistered"
        self.bridge.tasks[foreign_id] = {
            "id": foreign_id,
            "owner": "unregistered-owner",
            "state": "ready",
            "cleanupState": "unknown",
            "requestHistory": [],
        }
        self.bridge.calls.clear()

        missing = self.client.get(f"{PREFIX}/{foreign_id}/diagnostics")
        supplied_owner = self.client.get(f"{PREFIX}/{self.task_id}/diagnostics?owner={self.owner}")

        self.assertEqual(missing.status_code, 404)
        self.assertEqual(supplied_owner.status_code, 422)
        self.assertFalse(any(method == "shared.diagnostics" for method, _ in self.bridge.calls))
        self.assertNotIn(self.owner, supplied_owner.text)

    def test_ambiguous_task_id_across_registered_owners_fails_closed(self):
        self.runtime.authority.pre_tool_call(
            "browser_shared_list", {}, session_id="another-trusted-session", tool_call_id="call-2"
        )
        other_owner = self.runtime.authority.owner_for_session("another-trusted-session")
        self.bridge.tasks["duplicate-task"] = {
            "id": "duplicate-task",
            "owner": self.owner,
            "state": "ready",
            "cleanupState": "unknown",
            "requestHistory": [],
        }
        self.bridge.tasks["duplicate-task-other"] = {
            "id": "duplicate-task",
            "owner": other_owner,
            "state": "ready",
            "cleanupState": "unknown",
            "requestHistory": [],
        }
        self.bridge.calls.clear()

        response = self.client.get(f"{PREFIX}/duplicate-task/diagnostics")

        self.assertEqual(response.status_code, 404)
        self.assertFalse(any(method == "shared.diagnostics" for method, _ in self.bridge.calls))
