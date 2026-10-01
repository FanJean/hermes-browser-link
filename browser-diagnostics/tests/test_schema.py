from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from browser_diagnostics import SCHEMA_VERSION, UnsafeDiagnosticField, make_event


def base_event(**overrides):
    values = {
        "component": "native_bridge",
        "event_type": "request_state",
        "task_id": "task_opaque-1",
        "request_id": "req_opaque-1",
        "connection_id": "conn_opaque-1",
        "generation": "gen_opaque-1",
        "status": "running",
        "duration_ms": 12.5,
        "error_code": None,
                "action": None,
                "stage": None,
    }
    values.update(overrides)
    return values


class SchemaTests(unittest.TestCase):
    def test_machine_readable_contract_matches_python_event_shape(self):
        contract = json.loads((ROOT / "schema-v1.json").read_text(encoding="utf-8"))
        event = make_event(**base_event(), timestamp="2026-09-22T00:00:00.000Z")
        self.assertEqual(contract["$id"], SCHEMA_VERSION)
        self.assertEqual(set(contract["required"]), set(event))
        self.assertFalse(contract["additionalProperties"])
        for component in contract["properties"]["component"]["enum"]:
            make_event(**base_event(component=component))
        for event_type in contract["properties"]["event_type"]["enum"]:
            make_event(**base_event(event_type=event_type))
        for status in contract["properties"]["status"]["enum"]:
            make_event(**base_event(status=status))
        for error_code in contract["properties"]["error_code"]["oneOf"][1]["enum"]:
            make_event(**base_event(error_code=error_code))

    def test_make_event_emits_only_the_versioned_allowlisted_schema(self):
        event = make_event(**base_event(), timestamp="2026-09-22T00:00:00.000Z")

        self.assertEqual(
            event,
            {
                "schema_version": SCHEMA_VERSION,
                "timestamp": "2026-09-22T00:00:00.000Z",
                "component": "native_bridge",
                "event_type": "request_state",
                "task_id": "task_opaque-1",
                "request_id": "req_opaque-1",
                "connection_id": "conn_opaque-1",
                "generation": "gen_opaque-1",
                "status": "running",
                "duration_ms": 12.5,
                "error_code": None,
                "action": None,
                "stage": None,
            },
        )

    def test_make_event_rejects_every_non_allowlisted_field(self):
        cases = [
            {"exception": "Bearer secret"},
            {"url": "https://example.test/?token=secret"},
            {"headers": {"authorization": "secret"}},
            {"body": {"password": "secret"}},
            {"page_text": "secret"},
            {"metadata": {"nested": {"cookie": "secret"}}},
        ]
        for extra in cases:
            with self.subTest(extra=extra), self.assertRaises(UnsafeDiagnosticField):
                make_event(**base_event(), **extra)

    def test_duration_rejects_non_finite_numbers(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value), self.assertRaises(UnsafeDiagnosticField):
                make_event(**base_event(duration_ms=value))

    def test_identifiers_and_error_codes_reject_path_query_and_crlf_injection(self):
        cases = [
            ("task_id", "../escape"),
            ("request_id", "request\r\ninjected"),
            ("connection_id", "connection/child"),
            ("generation", "generation?query=secret"),
            ("error_code", "FAIL\r\nINJECTED"),
            ("error_code", "PASSWORD_RAW_SECRET"),
        ]
        for field, value in cases:
            with self.subTest(field=field), self.assertRaises(UnsafeDiagnosticField):
                make_event(**base_event(**{field: value}))


if __name__ == "__main__":
    unittest.main()
