"""Shared native v2 wire contract tests; no personal profile state."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "executor-plugin"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class RecordingClient:
    def __init__(self):
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        return {"ok": True, "echo": params}


class NativeV2WireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = load(PLUGIN / "native_tools.py", "native_v2_tools")
        cls.runtime_module = cls.tools.runtime_module()

    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.client = RecordingClient()
        self.runtime = self.runtime_module.NativeProfileRuntime(
            Path(self.tmp.name), PLUGIN, bridge_client=self.client
        )

    def invoke(self, args):
        name = "browser_shared_run"
        decision = self.runtime.authority.pre_tool_call(
            name, args, session_id="native-v2-session", tool_call_id="native-v2-call"
        )
        self.assertEqual(decision["action"], "modify")
        bounded = {**args, **decision["args"]}
        return json.loads(
            self.tools.make_tool_handler(name, self.runtime)(
                bounded, session_id="native-v2-session"
            )
        )

    def test_schema_exposes_public_actions_with_connection_authorization(self):
        actions = set(
            self.tools.TOOL_SCHEMAS["browser_shared_run"]["parameters"]["properties"]["action"]["enum"]
        )
        expected = {
            # 当前共享桥接公开滚动与历史返回动作。
            "navigate", "snapshot", "click", "fill", "press", "screenshot", "tabs", "new_tab",
            "scroll", "back",
            "popup_catalog", "popup_adopt",
            "page.parse", "semantic_snapshot", "frame_catalog", "ref_click", "ref_fill", "ref_press", "ref_set_checked", "ref_select_option", "api_request",
            "interaction.capture", "interaction.bounds", "interaction.click",
            "interaction.drag_coordinates", "interaction.drag_elements",
            "files.upload",
            # 中文注释：连接授权后直接执行，凭据互斥与特殊确认不随模式开关移除。
            "js.evaluate", "cdp.send", "cdp.events",
            # 中文注释：官方 get_images/console/dialog 对应的原生动作。
            "images", "console", "dialog",
        }
        self.assertEqual(actions, expected)
        self.assertTrue({"evaluate", "raw_cdp", "javascript"}.isdisjoint(actions))
        description = self.tools.TOOL_SCHEMAS["browser_shared_run"]["description"]
        self.assertIn("浏览器连接授权后", description)
        self.assertNotIn("智能审批", description)
        self.assertIn("凭据填写", description)
        self.assertIn("全部访问也必须明确确认", description)
        self.assertIn("paths", self.tools.TOOL_SCHEMAS["browser_shared_run"]["parameters"]["properties"])

    def test_semantic_snapshot_and_ref_actions_map_exact_wire_fields(self):
        cases = [
            (
                {
                    "task_id": "task-1",
                    "action": "semantic_snapshot",
                    "tab_id": 7,
                    "options": {
                        "mode": "interactive",
                        "query": "Confirm",
                        "roles": ["button"],
                        "viewport": True,
                        "budget": 1200,
                    },
                },
                {"options"},
            ),
            (
                {
                    "task_id": "task-1",
                    "action": "ref_click",
                    "tab_id": 7,
                    "binding": {
                        "taskId": "task-1",
                        "documentId": "loader-1",
                        "leaseId": "lease-1",
                    },
                    "snapshot_id": "snapshot-1",
                    "ref": "namespace:e1",
                },
                {"binding", "snapshotId", "ref"},
            ),
            (
                {
                    "task_id": "task-1",
                    "action": "ref_fill",
                    "tab_id": 7,
                    "binding": {
                        "taskId": "task-1",
                        "documentId": "loader-1",
                        "leaseId": "lease-1",
                    },
                    "snapshot_id": "snapshot-1",
                    "ref": "namespace:e2",
                    "text": "draft",
                },
                {"binding", "snapshotId", "ref", "text"},
            ),
            (
                # 中文注释：语义按键必须把绑定引用和按键原样送入可信 daemon。
                {"task_id": "task-1", "action": "ref_press", "tab_id": 7,
                 "binding": {"taskId": "task-1", "documentId": "loader-1", "leaseId": "lease-1"},
                 "snapshot_id": "snapshot-1", "ref": "namespace:e5", "key": "ArrowDown"},
                {"binding", "snapshotId", "ref", "key"},
            ),
            (
                {"task_id": "task-1", "action": "ref_set_checked", "tab_id": 7,
                 "binding": {"taskId": "task-1", "documentId": "loader-1", "leaseId": "lease-1"},
                 "snapshot_id": "snapshot-1", "ref": "namespace:e3", "checked": True},
                {"binding", "snapshotId", "ref", "checked"},
            ),
            (
                {"task_id": "task-1", "action": "ref_select_option", "tab_id": 7,
                 "binding": {"taskId": "task-1", "documentId": "loader-1", "leaseId": "lease-1"},
                 "snapshot_id": "snapshot-1", "ref": "namespace:e4", "by": "label", "values": ["甲"]},
                {"binding", "snapshotId", "ref", "by", "values"},
            ),
            (
                # 中文注释：index 选择器传零基整数，不经 JSON/daemon 转换为字符串。
                {"task_id": "task-1", "action": "ref_select_option", "tab_id": 7,
                 "binding": {"taskId": "task-1", "documentId": "loader-1", "leaseId": "lease-1"},
                 "snapshot_id": "snapshot-1", "ref": "namespace:e4", "by": "index", "values": [0, 2]},
                {"binding", "snapshotId", "ref", "by", "values"},
            ),
        ]
        for args, keys in cases:
            with self.subTest(action=args["action"]):
                result = self.invoke(args)
                self.assertNotIn("error", result)
                method, params = self.client.calls[-1]
                self.assertEqual(method, "shared.run")
                self.assertEqual(params["requestId"], "native-v2-call")
                for key in keys:
                    self.assertIn(key, params)

    def test_screenshot_bound_interactions_map_exact_wire_fields(self):
        endpoint_from = {"point": {"x": 10, "y": 20}, "expectedRef": "ref-from"}
        endpoint_to = {"point": {"x": 30, "y": 40}, "expectedRef": "ref-to"}
        cases = [
            (
                {"task_id": "task-1", "tab_id": 7, "action": "interaction.capture"},
                {"tabId": 7},
            ),
            (
                {"task_id": "task-1", "tab_id": 7, "action": "interaction.bounds",
                 "screenshot_id": "shot-1", "selector": "#button"},
                {"tabId": 7, "screenshotId": "shot-1", "selector": "#button"},
            ),
            (
                {"task_id": "task-1", "tab_id": 7, "action": "interaction.click",
                 "screenshot_id": "shot-1", "point": {"x": 10, "y": 20}, "expected_ref": "ref-1"},
                {"tabId": 7, "screenshotId": "shot-1", "point": {"x": 10, "y": 20},
                 "expectedRef": "ref-1"},
            ),
            (
                {"task_id": "task-1", "tab_id": 7, "action": "interaction.drag_coordinates",
                 "screenshot_id": "shot-1", "from": endpoint_from, "to": endpoint_to,
                 "mode": "pointer", "steps": 4},
                {"tabId": 7, "screenshotId": "shot-1", "from": endpoint_from, "to": endpoint_to,
                 "mode": "pointer", "steps": 4},
            ),
            (
                {"task_id": "task-1", "tab_id": 7, "action": "interaction.drag_elements",
                 "screenshot_id": "shot-1", "source": "#source", "target": "#target",
                 "mode": "html5-synthetic", "steps": 4},
                {"tabId": 7, "screenshotId": "shot-1", "source": "#source", "target": "#target",
                 "mode": "html5-synthetic", "steps": 4},
            ),
        ]
        for args, expected_fields in cases:
            with self.subTest(action=args["action"]):
                result = self.invoke(args)
                self.assertNotIn("error", result)
                method, params = self.client.calls[-1]
                self.assertEqual(method, "shared.run")
                self.assertEqual(params["requestId"], "native-v2-call")
                self.assertEqual(params["action"], args["action"])
                for key, value in expected_fields.items():
                    self.assertEqual(params[key], value)

    def test_malformed_nested_authority_or_coordinates_fail_before_rpc(self):
        cases = [
            {
                "task_id": "task-1",
                "action": "ref_click",
                "tab_id": 7,
                "binding": {"taskId": "task-1", "documentId": "d", "leaseId": "l", "owner": "forged"},
                "snapshot_id": "s",
                "ref": "r",
            },
            {
                "task_id": "task-1",
                "action": "interaction.click",
                "tab_id": 7,
                "screenshot_id": "shot",
                "point": {"x": float("nan"), "y": 1},
                "expected_ref": "r",
            },
            {
                "task_id": "task-1",
                "action": "interaction.drag_coordinates",
                "tab_id": 7,
                "screenshot_id": "shot",
                "from": {"point": {"x": 1, "y": 2}},
                "to": {"point": {"x": 3, "y": 4}, "expectedRef": "r2"},
            },
        ]
        for args in cases:
            with self.subTest(action=args["action"]):
                result = self.invoke(args)
                self.assertEqual(result.get("code"), "invalid_fields")
        self.assertEqual(self.client.calls, [])


if __name__ == "__main__":
    unittest.main()
