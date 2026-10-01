"""Offline task-scoped diagnostic projection tests; no browser or personal logs."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "browser-diagnostics" / "python"))
from browser_diagnostics import JsonlDiagnosticSink
from browser_diagnostics.schema import make_event


def load_projection():
    spec = importlib.util.spec_from_file_location("task_diagnostics", ROOT / "executor-plugin" / "task_diagnostics.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TaskDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.sink = JsonlDiagnosticSink(Path(self.tmp.name) / "diagnostics", max_bytes=512, max_files=5)
        self.tasks = {"task-A": {"id": "task-A", "owner": "owner-A", "state": "cancelled",
                                  "cleanupState": "unknown", "requestHistory": [
                                      {"requestIdHash": "a" * 64, "payloadHash": "b" * 64}]},
                      "task-B": {"id": "task-B", "owner": "owner-B", "state": "closed",
                                  "cleanupState": "succeeded", "requestHistory": []}}

    def event(self, request="corr-A", status="unknown", **overrides):
        return make_event(timestamp="2026-09-23T10:00:00.000Z", component="native_bridge",
                          event_type="request_state", request_id=request, status=status,
                          **overrides)

    def test_fixed_event_written_to_real_sink_is_read_back_only_for_bound_task(self):
        module = load_projection()
        projection = module.TaskDiagnosticProjection(self.sink)
        projection.bind(self.tasks, "owner-A", "task-A", "corr-A", request_id_hash="a" * 64)
        self.sink.write(self.event())
        self.sink.write(self.event(request="unbound", status="succeeded"))
        before = {path.name: path.read_bytes() for path in Path(self.sink.root).iterdir() if path.is_file()}
        result = projection.query(self.tasks, "owner-A", "task-A", request_id_hash="a" * 64)
        after = {path.name: path.read_bytes() for path in Path(self.sink.root).iterdir() if path.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(result["events"], [{"timestamp": "2026-09-23T10:00:00.000Z",
                                             "component": "native_bridge", "event_type": "request_state",
                                             "status": "unknown", "duration_ms": None,
                                             "error_code": None, "action": None}])
        self.assertEqual(result["execution_state"], "cancelled")
        self.assertEqual(result["cleanup_state"], "unknown")
        self.assertEqual(projection.query(self.tasks, "owner-B", "task-B")["events"], [])
        with self.assertRaises(module.DiagnosticTaskNotFound):
            projection.query(self.tasks, "owner-B", "task-A")
        with self.assertRaises(module.DiagnosticTaskNotFound):
            projection.bind(self.tasks, "owner-B", "task-A", "corr-A", request_id_hash="a" * 64)

    def test_pages_are_capped_and_advance_only_within_the_task(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "pages", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink, max_page_size=2)
        projection.bind(self.tasks, "owner-A", "task-A", "corr-A", request_id_hash="a" * 64)
        for status in ("running", "succeeded", "unknown"):
            sink.write(self.event(status=status))

        first = projection.query(self.tasks, "owner-A", "task-A", "a" * 64, limit=2)
        second = projection.query(self.tasks, "owner-A", "task-A", "a" * 64, limit=2,
                                  cursor=first["next_cursor"])
        self.assertEqual([item["status"] for item in first["events"]], ["running", "succeeded"])
        self.assertTrue(first["has_more"])
        self.assertEqual([item["status"] for item in second["events"]], ["unknown"])
        self.assertFalse(second["has_more"])
        with self.assertRaises(module.DiagnosticCapacityError):
            projection.query(self.tasks, "owner-A", "task-A", "a" * 64, limit=3)

    def test_request_binding_registry_has_a_hard_capacity(self):
        module = load_projection()
        projection = module.TaskDiagnosticProjection(self.sink, max_bindings=1)
        projection.bind(self.tasks, "owner-A", "task-A", "corr-A", request_id_hash="a" * 64)
        with self.assertRaises(module.DiagnosticCapacityError):
            projection.bind(self.tasks, "owner-A", "task-A", "corr-B", request_id_hash="a" * 64)

    def test_persistent_hashed_events_do_not_consume_legacy_binding_capacity(self):
        module = load_projection()
        projection = module.TaskDiagnosticProjection(self.sink, max_bindings=1)
        projection.record(
            self.tasks, "owner-A", "task-A", request_id="corr-A", request_id_hash="a" * 64,
            component="native_bridge", event_type="request_state", status="running",
        )
        projection.bind(self.tasks, "owner-A", "task-A", "legacy-correlation", request_id_hash="a" * 64)
        with self.assertRaises(module.DiagnosticCapacityError):
            projection.bind(self.tasks, "owner-A", "task-A", "another-correlation", request_id_hash="a" * 64)

    def test_record_persists_allowlisted_event_for_a_later_readback(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "recorded", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        projection.record(
            self.tasks, "owner-A", "task-A", request_id="corr-A", request_id_hash="a" * 64,
            component="native_bridge", event_type="request_state", status="unknown",
            duration_ms=12.5, error_code="TIMEOUT",
        )

        result = module.TaskDiagnosticProjection(sink).query(self.tasks, "owner-A", "task-A", "a" * 64)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["status"], "unknown")
        self.assertEqual(result["events"][0]["duration_ms"], 12.5)
        self.assertEqual(result["events"][0]["error_code"], "TIMEOUT")
        self.assertEqual(sink.read_validated_events()[0]["request_id"], "a" * 64)

    def test_single_trusted_task_snapshot_is_accepted_for_record_and_query(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "single-task", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        task = self.tasks["task-A"]
        projection.record(
            task, "owner-A", "task-A", request_id="corr-A", request_id_hash="a" * 64,
            component="native_bridge", event_type="request_state", status="running",
        )
        result = module.TaskDiagnosticProjection(sink).query(task, "owner-A", "task-A", "a" * 64)
        self.assertEqual([event["status"] for event in result["events"]], ["running"])

    def test_unrecognized_or_malformed_states_remain_unknown(self):
        module = load_projection()
        malformed = dict(self.tasks)
        malformed["task-A"] = dict(self.tasks["task-A"], state={"phase": "future"}, cleanupState=["done"])
        projection = module.TaskDiagnosticProjection(self.sink)
        result = projection.query(malformed, "owner-A", "task-A")
        self.assertEqual(result["execution_state"], "unknown")
        self.assertEqual(result["cleanup_state"], "unknown")

    def test_concurrent_records_are_serialized_and_all_read_back(self):
        from concurrent.futures import ThreadPoolExecutor

        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "concurrent", max_bytes=1_048_576, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)

        def emit(index):
            projection.record(
                self.tasks, "owner-A", "task-A", request_id="corr-A", request_id_hash="a" * 64,
                component="native_bridge", event_type="action_state", status="succeeded",
                duration_ms=index,
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(emit, range(64)))
        result = projection.query(self.tasks, "owner-A", "task-A", "a" * 64, limit=100)
        self.assertEqual(len(result["events"]), 64)
        self.assertEqual({event["duration_ms"] for event in result["events"]}, set(range(64)))

    def test_persisted_event_files_stay_within_sink_byte_and_file_limits(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "bounded", max_bytes=512, max_files=2)
        projection = module.TaskDiagnosticProjection(sink)
        for index in range(40):
            projection.record(
                self.tasks, "owner-A", "task-A", request_id="corr-A", request_id_hash="a" * 64,
                component="native_bridge", event_type="action_state", status="succeeded",
                duration_ms=index,
            )
        event_files = [path for path in Path(sink.root).iterdir() if path.name.startswith("events")]
        self.assertLessEqual(len(event_files), 2)
        self.assertTrue(all(path.stat().st_size <= 512 for path in event_files))
        self.assertLessEqual(sum(path.stat().st_size for path in event_files), 1024)

    def test_raw_exceptions_and_url_parameters_never_reach_disk_or_query(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "private", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        secret = "https://private.invalid/path?token=do-not-store"

        class SensitiveError(RuntimeError):
            def __str__(self):
                raise AssertionError("exception text must never be stringified")

        projection.record_exception(
            self.tasks, "owner-A", "task-A", request_id="corr-safe", request_id_hash="a" * 64,
            component="native_bridge", event_type="request_state", error=SensitiveError(secret),
        )
        raw = (Path(sink.root) / "events.jsonl").read_text(encoding="ascii")
        result = projection.query(self.tasks, "owner-A", "task-A", "a" * 64)
        self.assertNotIn(secret, raw)
        self.assertNotIn("SensitiveError", raw)
        self.assertNotIn("token=do-not-store", raw)
        self.assertEqual(result["events"][0]["error_code"], "UNCLASSIFIED_ERROR")
        self.assertNotIn("request_id", result["events"][0])
        with self.assertRaises(TypeError):
            projection.record(
                self.tasks, "owner-A", "task-A", component="native_bridge",
                event_type="request_state", status="failed", url=secret,
            )
        with self.assertRaises(module.UnsafeDiagnosticField):
            projection.record(
                self.tasks, "owner-A", "task-A", component="native_bridge",
                event_type="request_state", status="finished",
            )
        with self.assertRaises(module.UnsafeDiagnosticField):
            projection.record(
                self.tasks, "owner-A", "task-A", component="native_bridge",
                event_type="request_state", status="failed", request_id=secret,
                request_id_hash="a" * 64,
            )
        self.assertEqual(len(sink.read_validated_events()), 1)

    def test_query_does_not_recover_or_rewrite_malformed_storage(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "read-only", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        active = Path(sink.root) / "events.jsonl"
        active.write_bytes(b"malformed untrusted line\n")
        active.chmod(0o600)
        before = {path.name: path.read_bytes() for path in Path(sink.root).iterdir() if path.is_file()}

        result = projection.query(self.tasks, "owner-A", "task-A")

        after = {path.name: path.read_bytes() for path in Path(sink.root).iterdir() if path.is_file()}
        self.assertEqual(result["events"], [])
        self.assertEqual(after, before)

    def test_query_skips_schema_invalid_json_without_mutating_it(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "invalid-event", max_bytes=4096, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        invalid = self.event()
        invalid["component"] = []
        active = Path(sink.root) / "events.jsonl"
        active.write_bytes(json.dumps(invalid).encode("ascii") + b"\n")
        active.chmod(0o600)
        before = active.read_bytes()

        result = projection.query(self.tasks, "owner-A", "task-A")

        self.assertEqual(result["events"], [])
        self.assertEqual(active.read_bytes(), before)

    def test_query_refuses_non_private_event_files_without_changing_permissions(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "perms", max_bytes=4096, max_files=5)
        sink.write(self.event())
        projection = module.TaskDiagnosticProjection(sink)
        active = Path(sink.root) / "events.jsonl"
        active.chmod(0o644)
        before_mode = active.stat().st_mode & 0o777

        with self.assertRaises(module.DiagnosticStorageError):
            projection.query(self.tasks, "owner-A", "task-A")
        self.assertEqual(active.stat().st_mode & 0o777, before_mode)

    def test_query_fails_closed_on_storage_over_limit_without_rewriting_it(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "oversized", max_bytes=512, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        active = Path(sink.root) / "events.jsonl"
        active.write_bytes(b"x" * 513)
        active.chmod(0o600)
        before = active.read_bytes()

        with self.assertRaises(module.DiagnosticStorageError):
            projection.query(self.tasks, "owner-A", "task-A")
        self.assertEqual(active.read_bytes(), before)

    def test_query_rejects_a_single_event_line_over_the_hard_cap(self):
        module = load_projection()
        sink = JsonlDiagnosticSink(Path(self.tmp.name) / "long-line", max_bytes=131_072, max_files=5)
        projection = module.TaskDiagnosticProjection(sink)
        active = Path(sink.root) / "events.jsonl"
        active.write_bytes(b"x" * (64 * 1024 + 1))
        active.chmod(0o600)

        with self.assertRaises(module.DiagnosticStorageError):
            projection.query(self.tasks, "owner-A", "task-A")


if __name__ == "__main__":
    unittest.main()
