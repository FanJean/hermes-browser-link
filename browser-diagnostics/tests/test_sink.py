from __future__ import annotations

import json
import multiprocessing
import os
import stat
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from browser_diagnostics import JsonlDiagnosticSink, UnsafeLogPath, make_event


def event_for(index: int):
    return make_event(
        component="native_bridge",
        event_type="request_state",
        task_id=f"task-{index}",
        request_id=f"request-{index}",
        connection_id="connection-shared",
        generation="generation-1",
        status="succeeded",
        duration_ms=float(index),
        error_code=None,
        timestamp="2026-09-22T00:00:00.000Z",
    )


def process_writer(root: str, start: int, count: int):
    sink = JsonlDiagnosticSink(root, max_bytes=2_000_000, max_files=5)
    for index in range(start, start + count):
        sink.write(event_for(index))


class SinkTests(unittest.TestCase):
    def test_sink_creates_private_directory_and_log_permissions(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            sink = JsonlDiagnosticSink(root)
            sink.write(event_for(1))

            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root / "events.jsonl").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((root / ".browser-diagnostics.lock").stat().st_mode), 0o600)

    def test_sink_refuses_a_symlink_root_or_symlink_log(self):
        with tempfile.TemporaryDirectory() as parent:
            parent_path = Path(parent)
            target = parent_path / "target"
            target.mkdir()
            linked_root = parent_path / "linked"
            linked_root.symlink_to(target, target_is_directory=True)
            with self.assertRaises(UnsafeLogPath):
                JsonlDiagnosticSink(linked_root)

            intermediate = parent_path / "intermediate"
            intermediate.symlink_to(target, target_is_directory=True)
            with self.assertRaises(UnsafeLogPath):
                JsonlDiagnosticSink(intermediate / "nested")
            self.assertFalse((target / "nested").exists())

            root = parent_path / "real"
            root.mkdir(mode=0o700)
            victim = parent_path / "victim"
            victim.write_text("unchanged", encoding="utf-8")
            (root / "events.jsonl").symlink_to(victim)
            with self.assertRaises(UnsafeLogPath):
                JsonlDiagnosticSink(root)
            self.assertEqual(victim.read_text(encoding="utf-8"), "unchanged")

    def test_concurrent_process_and_thread_writes_remain_complete_json_lines(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            processes = [
                multiprocessing.Process(target=process_writer, args=(str(root), offset, 40))
                for offset in (0, 100, 200)
            ]
            for process in processes:
                process.start()
            for process in processes:
                process.join(20)
                self.assertEqual(process.exitcode, 0)

            sink = JsonlDiagnosticSink(root, max_bytes=2_000_000, max_files=5)
            threads = [
                threading.Thread(target=lambda start=start: [sink.write(event_for(i)) for i in range(start, start + 40)])
                for start in (300, 400, 500)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(20)
                self.assertFalse(thread.is_alive())

            records = sink.read_validated_events()
            self.assertEqual(len(records), 240)
            self.assertEqual(len({record["request_id"] for record in records}), 240)

    def test_rotation_is_size_bounded_and_retention_is_capped(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            sink = JsonlDiagnosticSink(root, max_bytes=700, max_files=3)
            for index in range(30):
                sink.write(event_for(index))

            owned_logs = sorted(root.glob("events*.jsonl"))
            self.assertLessEqual(len(owned_logs), 3)
            for path in owned_logs:
                self.assertLessEqual(path.stat().st_size, 700)
            self.assertGreater(len(sink.read_validated_events()), 0)

    def test_corrupt_active_log_is_discarded_and_new_writes_recover(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            sink = JsonlDiagnosticSink(root)
            sink.write(event_for(1))
            with (root / "events.jsonl").open("ab") as stream:
                stream.write(b'{"body":"raw-secret"}\nnot-json\n')

            recovered = JsonlDiagnosticSink(root)
            recovered.write(event_for(2))

            records = recovered.read_validated_events()
            self.assertEqual([record["status"] for record in records], ["recovered", "succeeded"])
            self.assertEqual(records[-1]["request_id"], "request-2")
            self.assertFalse(list(root.glob("corrupt.*.jsonl")))
            for path in root.iterdir():
                if path.is_file():
                    self.assertNotIn(b"raw-secret", path.read_bytes())

    def test_export_bundle_contains_only_validated_events_and_no_raw_secrets(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            output = Path(parent) / "exports"
            sink = JsonlDiagnosticSink(root)
            sink.write(event_for(1))
            with (root / "events.jsonl").open("ab") as stream:
                stream.write(b'{"cookie":"super-secret-cookie"}\n')

            bundle = sink.export_bundle(output, "safe-export.zip")
            self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o600)
            with zipfile.ZipFile(bundle) as archive:
                names = sorted(archive.namelist())
                payload = b"\n".join(archive.read(name) for name in names)
            self.assertEqual(names, ["events.jsonl", "manifest.json"])
            self.assertNotIn(b"super-secret-cookie", payload)
            self.assertIn(b"browser.diagnostics/v1", payload)

    def test_export_name_rejects_path_and_crlf_injection(self):
        with tempfile.TemporaryDirectory() as parent:
            sink = JsonlDiagnosticSink(Path(parent) / "diagnostics")
            for name in ("../escape.zip", "nested/export.zip", "bad\r\nname.zip"):
                with self.subTest(name=name), self.assertRaises(UnsafeLogPath):
                    sink.export_bundle(Path(parent) / "exports", name)

    def test_cleanup_removes_only_module_owned_files(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "diagnostics"
            sink = JsonlDiagnosticSink(root, max_bytes=700, max_files=3)
            for index in range(20):
                sink.write(event_for(index))
            unrelated = root / "keep-me.txt"
            unrelated.write_text("keep", encoding="utf-8")

            removed = sink.cleanup()

            self.assertTrue(removed)
            self.assertTrue(unrelated.exists())
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")
            self.assertFalse(any(root.glob("events*.jsonl")))
            self.assertFalse(any(root.glob("corrupt.*.jsonl")))


if __name__ == "__main__":
    unittest.main()
