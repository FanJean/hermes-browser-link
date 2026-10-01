from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from browser_diagnostics import observe_action


class BrokenSink:
    def write(self, event):
        raise OSError("diagnostic disk unavailable")


class CollectingSink:
    def __init__(self):
        self.events = []

    def write(self, event):
        self.events.append(event)


CONTEXT = {
    "component": "native_bridge",
    "event_type": "action_state",
    "task_id": "task-opaque",
    "request_id": "request-opaque",
    "connection_id": "connection-opaque",
    "generation": "generation-opaque",
}


class RuntimeTests(unittest.TestCase):
    def test_sink_failure_does_not_change_unknown_result_identity(self):
        unknown_result = object()
        returned = observe_action(lambda: unknown_result, BrokenSink(), CONTEXT)
        self.assertIs(returned, unknown_result)

    def test_sink_failure_does_not_swallow_action_exception(self):
        action_error = RuntimeError("password=raw-secret")

        def fail():
            raise action_error

        with self.assertRaises(RuntimeError) as caught:
            observe_action(fail, BrokenSink(), CONTEXT)
        self.assertIs(caught.exception, action_error)

    def test_exception_text_is_never_recorded_and_invalid_classifier_falls_back(self):
        sink = CollectingSink()
        action_error = RuntimeError("cookie=raw-secret")

        def fail():
            raise action_error

        with self.assertRaises(RuntimeError):
            observe_action(fail, sink, CONTEXT, classify_error=lambda error: "INVALID code")

        serialized = repr(sink.events)
        self.assertNotIn("raw-secret", serialized)
        self.assertNotIn("cookie=", serialized)
        self.assertEqual([event["status"] for event in sink.events], ["running", "failed"])
        self.assertEqual(sink.events[-1]["error_code"], "UNCLASSIFIED_ERROR")


if __name__ == "__main__":
    unittest.main()
