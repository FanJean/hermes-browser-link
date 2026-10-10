from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "executor-plugin"))

from single_tool_adapter.adapter import SingleToolAdapter


class FakeAuthority:
    def owner_for_session(self, session_id):
        return f"owner:{session_id}"


class FakeRuntime:
    def __init__(self):
        self.authority = FakeAuthority()
        self.calls = []
        self.task = {
            "id": "task-native",
            "state": "ready",
            "instanceId": "chrome-1",
            "generation": 4,
            "tabIds": [12],
            "agentTabIds": [12],
        }
        self.snapshot = {
            "version": 2,
            "binding": {"taskId": "task-native", "documentId": "doc-1", "leaseId": "lease-1"},
            "snapshotId": "snapshot-1",
            "items": [{"ref": "native-ref-opaque", "role": "button", "name": "Save"}],
            "coverage": {"complete": True, "returned": 1},
        }

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == "shared.get":
            if params != {"owner": "owner:session-a", "taskId": "task-native"}:
                raise AssertionError(f"unexpected task lookup: {params!r}")
            return dict(self.task)
        if method == "browser.list":
            return [{"instanceId": "chrome-1", "connected": True}]
        if method == "shared.run":
            # 中文注释：成功回执新增真实工作页元信息查询。
            if params["action"] == "tabs":
                return [{"id": tab, "url": "https://example.com/", "title": "Example"} for tab in self.task["agentTabIds"]]
            if params["action"] == "navigate":
                return {"tabId": params["tabId"], "url": params["url"], "ready": "complete"}
            if params["action"] == "semantic_snapshot":
                return dict(self.snapshot)
            if params["action"] == "ref_click":
                return {"clicked": True, "kind": "trusted-input", "delivery": "confirmed", "popupOwnership": "uncertain"}
            if params["action"] == "ref_fill":
                return {"filled": True, "kind": "dom-synthetic"}
            if params["action"] == "scroll":
                return {"tabId": params["tabId"], "scrolled": True, "direction": params["direction"]}
            if params["action"] == "back":
                return {"tabId": params["tabId"], "url": "https://example.com/previous", "ready": True}
            if params["action"] == "press":
                return {"ok": True, "pressed": True, "tabId": params["tabId"]}
            if params["action"] == "screenshot":
                labels = params.get("annotate", {}).get("labels", [])
                return {"data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                        **({"annotations": [{"label": row["label"], "x": 10, "y": 20, "width": 30, "height": 12} for row in labels]}
                           if "annotate" in params else {})}
            if params["action"] == "images":
                return {"images": [{"src": "https://example.com/a.png", "alt": "A", "width": 1, "height": 1}], "count": 1}
            if params["action"] == "console":
                return {"messages": [{"type": "log", "text": "hello"}], "errors": [{"message": "boom"}], "dropped": 0}
            if params["action"] == "dialog":
                return {"handled": True, "action": "accept", "dialog": {"type": "confirm", "message": "Sure?"}}
            if params["action"] in {"js.evaluate", "cdp.send"}:
                error = RuntimeError("browser access not enabled")
                error.code = "browser_access_required"
                error.data = {"outcomeUnknown": False}
                raise error
        raise AssertionError(f"unexpected native method or action: {method!r} {params!r}")


class SingleToolAdapterTests(unittest.TestCase):
    def test_complex_ui_snapshot_and_relocation_survive_official_adapter(self):
        # 中文注释：原生语义回执经官方工具适配后保留 canvas 数量、推断标记和重定位。
        runtime = FakeRuntime()
        runtime.snapshot['coverage']['unsupportedCanvas'] = 1
        runtime.snapshot['items'][0]['inferred'] = True
        original = runtime.call
        def call(method, params):
            if method == 'shared.run' and params['action'] == 'ref_click':
                return {'clicked': True, 'kind': 'trusted-input', 'delivery': 'confirmed', 'relocated': True}
            return original(method, params)
        runtime.call = call
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        snap = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='complex-snapshot'))
        self.assertEqual(snap['coverage']['unsupportedCanvas'], 1)
        self.assertIn('[button inferred]', snap['snapshot'])
        clicked = json.loads(adapter.dispatch('browser_click', {'ref': '@e1'}, session_id='session-a', tool_call_id='complex-click'))
        self.assertIs(clicked['relocated'], True)

    def test_official_click_exposes_popup_identity_without_extra_oauth_url_data(self):
        runtime = FakeRuntime()
        call = runtime.call
        def with_popup(method, params):
            if method == 'shared.run' and params['action'] == 'ref_click':
                return {'clicked': True, 'kind': 'trusted-input', 'delivery': 'confirmed',
                    'popupOpened': {'candidateRef': 'ref', 'origin': 'https://accounts.google.com',
                                    'windowType': 'popup', 'tabId': 2, 'url': 'PRIVATE_CANARY', 'nonce': 'PRIVATE_CANARY'},
                    'popupNextStep': '选择登录窗口重读'}
            return call(method, params)
        runtime.call = with_popup
        adapter = SingleToolAdapter(runtime);adapter.bind('session-a', 'task-native')
        adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='source-snapshot')
        result = json.loads(adapter.dispatch('browser_click', {'ref': '@e1'}, session_id='session-a', tool_call_id='oauth-click'))
        self.assertEqual(result['popupOpened']['tabId'], 2)
        self.assertEqual(result['popupNextStep'], '选择登录窗口重读')
        self.assertNotIn('PRIVATE_CANARY', json.dumps(result))

    def test_adopted_login_tab_can_bind_and_closed_popup_reads_latest_source(self):
        runtime = FakeRuntime()
        runtime.task.update(tabIds=[12, 2], adoptedPopupTabIds=[2], popupSources={'2': 12})
        adapter = SingleToolAdapter(runtime)
        from single_tool_adapter.integration import HostBindingCoordinator, _NativeHostAdapter
        coordinator = HostBindingCoordinator(_NativeHostAdapter(adapter))
        coordinator.bind('session-a', owner='owner:session-a', task_id='task-native', tab_id=12)
        coordinator.use_tab('session-a', owner='owner:session-a', tab_id=2)
        first = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='login-read'))
        self.assertTrue(first['success'])
        runtime.task.update(tabIds=[12], adoptedPopupTabIds=[], popupReturns={'2': 12})
        runtime.snapshot['binding']['documentId'] = 'new-source-document'
        second = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='source-read'))
        self.assertEqual(second['popupClosed'], {'returnedTo': 12})
        self.assertTrue(second['success'])
        reads = [p['tabId'] for method, p in runtime.calls if method == 'shared.run' and p['action'] == 'semantic_snapshot']
        self.assertEqual(reads, [2, 12])
        self.assertEqual(adapter._bindings['session-a'].semantic_binding['documentId'], 'new-source-document')
        adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='next-source-read')
        self.assertEqual([p['tabId'] for method, p in runtime.calls if method == 'shared.run' and p['action'] == 'semantic_snapshot'][-1], 12)

    def test_package_exports_adapter_and_host_registration_api(self):
        from single_tool_adapter import SingleToolAdapter as PublicAdapter
        from single_tool_adapter import register_official_overrides

        self.assertIs(PublicAdapter, SingleToolAdapter)
        self.assertTrue(callable(register_official_overrides))

    # 中文注释：公开单工具不能把暂停误报为普通未就绪或成功。
    def test_paused_task_returns_explicit_rejection(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        runtime.task["state"] = "paused"
        result = json.loads(adapter.dispatch("browser_snapshot", {}, session_id="session-a", tool_call_id="paused"))
        self.assertEqual(result["code"], "task_paused")
        self.assertIn("已暂停", result["error"])
        self.assertEqual([p for m, p in runtime.calls if m == "shared.run"], [])

    def test_official_navigate_uses_trusted_task_and_owned_tab(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        raw = adapter.dispatch(
            "browser_navigate",
            {"url": "https://example.test/path"},
            session_id="session-a",
            tool_call_id="call-1",
            task_id="model-controlled-task-id",
        )

        result = json.loads(raw)
        self.assertTrue(result["success"])
        self.assertEqual(result["url"], "https://example.test/path")
        run_calls = [payload for method, payload in runtime.calls if method == "shared.run"]
        navigate_payload = next(payload for payload in run_calls if payload["action"] == "navigate")
        self.assertEqual(navigate_payload["owner"], "owner:session-a")
        self.assertEqual(navigate_payload["taskId"], "task-native")
        self.assertEqual(navigate_payload["tabId"], 12)
        self.assertEqual(navigate_payload["url"], "https://example.test/path")
        self.assertNotIn("model-controlled-task-id", json.dumps(navigate_payload))
        self.assertIn("snapshot", result, "official navigate returns an automatic compact page snapshot")

    def test_public_task_projection_binds_only_recorded_agent_work_tabs(self):
        runtime = FakeRuntime()
        runtime.task.pop("agentTabIds")
        runtime.task["tabIds"] = [12, 13]
        runtime.task["workTabs"] = [{"tabId": 12, "groupId": 5, "windowId": 1}]
        adapter = SingleToolAdapter(runtime)

        receipt = adapter.bind("session-a", "task-native")

        self.assertEqual(receipt["tabId"], 12)

    def test_public_task_projection_never_promotes_a_user_selected_tab(self):
        runtime = FakeRuntime()
        runtime.task.pop("agentTabIds")
        runtime.task["workTabs"] = []
        adapter = SingleToolAdapter(runtime)
        receipt = adapter.bind("session-a", "task-native")
        self.assertIsNone(receipt["tabId"])

        result = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="call-user-tab",
        ))

        self.assertEqual(result["code"], "tab_required")
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 0)

    def test_vision_annotate_labels_map_to_snapshot_refs(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HERMES_HOME": home, "HOME": home}):
            raw = adapter.dispatch("browser_vision", {"question": "what is shown", "annotate": True},
                                   session_id="session-a", tool_call_id="call-vision")
        result = raw if isinstance(raw, dict) else json.loads(raw)
        annotations = result.get("annotations") or result.get("meta", {}).get("annotations")
        self.assertEqual(annotations, [{"label": "[1]", "ref": "@e1", "box": {"x": 10.0, "y": 20.0, "width": 30.0, "height": 12.0}}])
        sent = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual([row["action"] for row in sent], ["semantic_snapshot", "screenshot", "tabs"])
        self.assertEqual(sent[1]["annotate"], {"binding": runtime.snapshot["binding"], "snapshotId": "snapshot-1",
                                               "labels": [{"label": 1, "ref": "native-ref-opaque"}]})
        self.assertNotEqual(sent[0]["requestId"], sent[1]["requestId"])
        # 中文注释：标注编号可直接用于后续点击，映射到同一语义引用。
        clicked = json.loads(adapter.dispatch("browser_click", {"ref": "@e1"}, session_id="session-a", tool_call_id="call-click"))
        self.assertTrue(clicked["success"])
        self.assertEqual(runtime.calls[-2][1]["ref"], "native-ref-opaque")

    def test_images_console_dialog_map_to_native_reads_and_js_uses_browser_access(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        call = lambda tool, args, call_id: json.loads(adapter.dispatch(tool, args, session_id="session-a", tool_call_id=call_id))
        self.assertEqual(call("browser_get_images", {}, "c1")["count"], 1)
        console = call("browser_console", {}, "c2")
        self.assertEqual(console["console_messages"], [{"type": "log", "text": "hello", "source": "console"}])
        self.assertEqual(console["total_errors"], 1)
        dialog = call("browser_dialog", {"action": "accept"}, "c3")
        self.assertEqual(dialog["dialog"]["message"], "Sure?")
        sent = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual(sent[-2]["accept"], True)
        denied = call("browser_console", {"expression": "document.title"}, "c4")
        self.assertEqual(denied["code"], "browser_access_required")
        self.assertFalse(denied["outcome_unknown"])
        self.assertEqual(sent[-2]["action"], "dialog")
        self.assertEqual(runtime.calls[-1][1]["world"], "main")
        # 中文注释：确定性拒绝不冻结会话，后续只读操作仍可执行。
        self.assertEqual(call("browser_get_images", {}, "c5")["count"], 1)
        self.assertEqual(call("browser_cdp", {"method": "DOM.getDocument"}, "c6")["code"], "browser_access_required")

    def test_cdp_frame_id_uses_scoped_token_and_other_target_arguments_fail_closed(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        dispatch = lambda args, call_id: json.loads(adapter.dispatch(
            "browser_cdp", args, session_id="session-a", tool_call_id=call_id))
        # 中文注释：frame_id 只能作为本任务 frame_catalog 的短期 token 转交扩展重验。
        result = dispatch({"method": "DOM.getDocument", "frame_id": "frame-token-1"}, "frame-call")
        self.assertEqual(result["code"], "browser_access_required")
        sent = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual(sent[-1]["frameToken"], "frame-token-1")
        self.assertEqual(sent[-1]["tabId"], 12)
        count = len(sent)
        self.assertEqual(dispatch({"method": "DOM.getDocument", "target_id": "page-target"}, "target-call")["code"],
                         "browser_access_required")
        sent = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual(sent[-1]["targetId"], "page-target")
        count = len(sent)
        self.assertEqual(dispatch({"method": "DOM.getDocument", "timeout": 5}, "timeout-call")["code"],
                         "browser_access_required")
        sent = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual(sent[-1]["timeoutMs"], 5000)
        count = len(sent)
        self.assertEqual(dispatch({"method": "DOM.getDocument", "timeout": 0.01}, "bad-timeout")["code"],
                         "invalid_arguments")
        self.assertEqual(len([params for method, params in runtime.calls if method == "shared.run"]), count)

    def test_scroll_back_and_press_run_on_the_bound_work_tab(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        scrolled = json.loads(adapter.dispatch("browser_scroll", {"direction": "down"},
                                               session_id="session-a", tool_call_id="call-scroll"))
        back = json.loads(adapter.dispatch("browser_back", {}, session_id="session-a", tool_call_id="call-back"))
        pressed = json.loads(adapter.dispatch("browser_press", {"key": "Enter"},
                                              session_id="session-a", tool_call_id="call-press"))
        self.assertEqual((scrolled["success"], scrolled["scrolled"]), (True, "down"))
        self.assertEqual(back["url"], "https://example.com/previous")
        self.assertEqual(pressed["pressed"], "Enter")
        runs = [params for method, params in runtime.calls if method == "shared.run"]
        self.assertEqual([run["action"] for run in runs], ["scroll", "tabs", "back", "tabs", "press", "tabs"])
        self.assertTrue(all(run["tabId"] == 12 and run["taskId"] == "task-native" for run in runs if run["action"] != "tabs"))
        self.assertEqual(runs[4]["selector"], ":focus", "official press targets the focused element")

    def test_scroll_rejects_an_unknown_direction_without_calling_the_browser(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        result = json.loads(adapter.dispatch("browser_scroll", {"direction": "sideways"},
                                             session_id="session-a", tool_call_id="call-bad"))
        self.assertFalse(result["success"])
        self.assertEqual([m for m, _ in runtime.calls].count("shared.run"), 0)

    def test_scroll_missing_or_invalid_receipt_fences_further_writes(self):
        # 中文注释：适配层跨运行时派发后丢失回执，不能把有副作用的滚动当成只读动作重放。
        for failure in (TimeoutError("synthetic transport failure"), {}, {"scrolled": False},
                        {"tabId": 99, "scrolled": True, "direction": "down"}):
            with self.subTest(failure=type(failure).__name__):
                runtime = FakeRuntime()
                original = runtime.call
                dispatched = []

                def call(method, params):
                    if method == "shared.run" and params["action"] == "scroll":
                        dispatched.append(dict(params))
                        if isinstance(failure, Exception):
                            raise failure
                        return failure
                    return original(method, params)

                runtime.call = call
                adapter = SingleToolAdapter(runtime)
                adapter.bind("session-a", "task-native")
                result = json.loads(adapter.dispatch("browser_scroll", {"direction": "down"},
                                                    session_id="session-a", tool_call_id="scroll-1"))
                self.assertFalse(result["success"])
                self.assertTrue(result["outcome_unknown"])
                self.assertFalse(result["retryable"])
                repeated = json.loads(adapter.dispatch("browser_scroll", {"direction": "down"},
                                                      session_id="session-a", tool_call_id="scroll-2"))
                self.assertEqual(repeated["code"], "outcome_unknown")
                self.assertEqual(len(dispatched), 1)

    def test_snapshot_checks_an_uncertain_result_and_lifts_the_fence(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter._bindings["session-a"].outcome_unknown = True
        refused = json.loads(adapter.dispatch("browser_back", {}, session_id="session-a", tool_call_id="call-1"))
        self.assertEqual(refused["code"], "outcome_unknown")
        snap = json.loads(adapter.dispatch("browser_snapshot", {}, session_id="session-a", tool_call_id="call-2"))
        self.assertIn("snapshot", snap)
        self.assertFalse(adapter._bindings["session-a"].outcome_unknown)
        back = json.loads(adapter.dispatch("browser_back", {}, session_id="session-a", tool_call_id="call-3"))
        self.assertTrue(back["success"])

    def test_full_snapshot_request_is_explicitly_unsupported(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        result = json.loads(adapter.dispatch(
            "browser_snapshot", {"full": True}, session_id="session-a", tool_call_id="call-full-snapshot",
        ))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "unsupported_operation")
        self.assertTrue(result["unsupported"])
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 0)

    def test_unbound_session_is_left_for_original_router_fallback(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)

        result = adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="another-session", tool_call_id="call-2",
        )

        self.assertIs(result, d_unhandled())
        self.assertEqual(runtime.calls, [])

    def test_task_state_change_is_classified_as_not_ready_without_replay(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        runtime.task["state"] = "needs_sync"

        result = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="call-not-ready",
        ))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "task_not_ready")
        self.assertFalse(result["outcome_unknown"])
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 0)

    def test_stale_native_generation_fails_closed_before_dispatch(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        runtime.task["generation"] = 5

        result = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="call-stale",
        ))

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "stale_generation")
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 0)

    def test_snapshot_refs_are_translated_to_the_exact_native_binding(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        snapshot_result = json.loads(adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-snapshot",
        ))
        click_result = json.loads(adapter.dispatch(
            "browser_click", {"ref": "@e1"}, session_id="session-a", tool_call_id="call-click",
        ))

        self.assertIn("[@e1]", snapshot_result["snapshot"])
        self.assertTrue(click_result["success"])
        click_payload = next(
            payload for method, payload in runtime.calls
            if method == "shared.run" and payload["action"] == "ref_click"
        )
        self.assertEqual(click_payload["binding"], runtime.snapshot["binding"])
        self.assertEqual(click_payload["snapshotId"], "snapshot-1")
        self.assertEqual(click_payload["ref"], "native-ref-opaque")

    def test_click_that_leaves_the_site_is_reported_and_later_reads_explain_it(self):
        class LeavingRuntime(FakeRuntime):
            left = False
            def call(self, method, params):
                if method == "shared.run" and params["action"] == "ref_click":
                    self.calls.append((method, dict(params)))
                    self.left = True
                    return {"clicked": True, "kind": "trusted-input", "delivery": "confirmed", "popupOwnership": "uncertain",
                            "documentChanged": True, "outOfScope": True}
                if method == "shared.run" and params["action"] == "semantic_snapshot" and self.left:
                    self.calls.append((method, dict(params)))
                    error = RuntimeError("private detail")
                    error.code = "tab_out_of_scope"
                    error.data = {"outcomeUnknown": False}
                    raise error
                return super().call(method, params)

        runtime = LeavingRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter.dispatch("browser_snapshot", {}, session_id="session-a", tool_call_id="call-snapshot")
        click = json.loads(adapter.dispatch("browser_click", {"ref": "@e1"}, session_id="session-a", tool_call_id="call-click"))
        read = json.loads(adapter.dispatch("browser_snapshot", {}, session_id="session-a", tool_call_id="call-after"))

        self.assertTrue(click["success"])
        self.assertTrue(click["navigated_out_of_scope"])
        self.assertFalse(read["success"])
        self.assertEqual(read["code"], "tab_out_of_scope")
        self.assertFalse(read["outcome_unknown"])
        self.assertNotIn("private detail", json.dumps(read))

    def test_confirmed_background_synthetic_click_is_reported_without_claiming_trust(self):
        class BackgroundRuntime(FakeRuntime):
            def call(self, method, params):
                if method == "shared.run" and params["action"] == "ref_click":
                    self.calls.append((method, dict(params)))
                    return {"clicked": True, "kind": "dom-synthetic", "delivery": "confirmed",
                            "fallbackReason": "background_tab_input_unreliable"}
                return super().call(method, params)

        # 中文注释：官方工具可接受已确认的后台合成事件，但必须显式保留交付类型与回退原因。
        adapter = SingleToolAdapter(BackgroundRuntime())
        adapter.bind("session-a", "task-native")
        adapter.dispatch("browser_snapshot", {}, session_id="session-a", tool_call_id="background-snapshot")
        result = json.loads(adapter.dispatch(
            "browser_click", {"ref": "@e1"}, session_id="session-a", tool_call_id="background-click"))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["delivery"], "dom-synthetic")
        self.assertEqual(result["fallback_reason"], "background_tab_input_unreliable")

    def test_snapshot_coverage_filters_unrecognized_native_fields(self):
        runtime = FakeRuntime()
        runtime.snapshot["coverage"]["unexpected"] = {"credential": "must-not-be-rendered"}
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        result = json.loads(adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-coverage",
        ))

        self.assertNotIn("unexpected", result["coverage"])
        self.assertNotIn("credential", json.dumps(result))
        self.assertEqual(result["coverage"]["complete"], True)

    def test_official_ref_without_at_prefix_matches_hermes_normalization(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-snapshot",
        )

        result = json.loads(adapter.dispatch(
            "browser_click", {"ref": "e1"}, session_id="session-a", tool_call_id="call-click-bare",
        ))

        self.assertTrue(result["success"], result)
        self.assertEqual(result["clicked"], "@e1")
        click_payload = next(
            payload for method, payload in runtime.calls
            if method == "shared.run" and payload["action"] == "ref_click"
        )
        self.assertEqual(click_payload["ref"], "native-ref-opaque")

    def test_type_uses_the_exact_native_binding_before_invalidating_refs(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-snapshot",
        )

        result = json.loads(adapter.dispatch(
            "browser_type", {"ref": "@e1", "text": "saved"},
            session_id="session-a", tool_call_id="call-type",
        ))

        self.assertTrue(result["success"])
        type_payload = next(
            payload for method, payload in runtime.calls
            if method == "shared.run" and payload["action"] == "ref_fill"
        )
        self.assertEqual(type_payload["binding"], runtime.snapshot["binding"])
        self.assertEqual(type_payload["snapshotId"], "snapshot-1")
        self.assertEqual(type_payload["ref"], "native-ref-opaque")
        self.assertEqual(type_payload["text"], "saved")

    def test_type_result_matches_official_redacted_contract_and_marks_native_semantics(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-snapshot",
        )
        agent = types.ModuleType("agent")
        agent.__path__ = []
        display = types.ModuleType("agent.display")
        display.redact_tool_args_for_display = lambda name, args: {"text": "[hidden]"}
        display.redact_browser_typed_text_for_display = lambda value, typed: value

        with patch.dict(sys.modules, {"agent": agent, "agent.display": display}):
            result = json.loads(adapter.dispatch(
                "browser_type", {"ref": "@e1", "text": "sensitive-sentinel"},
                session_id="session-a", tool_call_id="call-type-redacted",
            ))

        self.assertEqual(result["typed"], "[hidden]")
        self.assertEqual(result["element"], "@e1")
        self.assertEqual(result["delivery"], "dom-synthetic")
        self.assertNotIn("sensitive-sentinel", json.dumps(result))

    def test_close_revokes_all_session_bindings_without_touching_runtime(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        adapter.close()

        self.assertFalse(adapter.has_bindings())
        self.assertIs(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="call-after-close",
        ), d_unhandled())
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 0)

    def test_restarted_adapter_reuses_request_id_for_the_same_official_tool_call(self):
        runtime = FakeRuntime()
        first_adapter = SingleToolAdapter(runtime)
        first_adapter.bind("session-a", "task-native")
        first_adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="persisted-call",
        )
        first_id = next(
            params["requestId"] for method, params in runtime.calls
            if method == "shared.run" and params["action"] == "navigate"
        )

        runtime.task["generation"] = 5
        resumed_adapter = SingleToolAdapter(runtime)
        resumed_adapter.bind("session-a", "task-native")
        resumed_adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/"},
            session_id="session-a", tool_call_id="persisted-call",
        )
        request_ids = [
            params["requestId"] for method, params in runtime.calls
            if method == "shared.run" and params["action"] == "navigate"
        ]

        self.assertEqual(len(request_ids), 2)
        self.assertEqual(request_ids, [first_id, first_id])

    def test_reused_tool_call_id_with_new_arguments_conflicts_after_adapter_restart(self):
        class DurableRuntime(FakeRuntime):
            def __init__(self):
                super().__init__()
                self.requests = {}
                self.navigation_effects = 0

            def call(self, method, params):
                if method == "shared.run":
                    request_id = params["requestId"]
                    fingerprint = json.dumps(
                        {key: value for key, value in params.items() if key not in {"owner", "requestId"}},
                        sort_keys=True, separators=(",", ":"),
                    )
                    prior = self.requests.get(request_id)
                    if prior is not None:
                        if prior[0] != fingerprint:
                            self.calls.append((method, dict(params)))
                            error = RuntimeError("request id reused with different payload")
                            error.code = "request_id_conflict"
                            error.data = {}
                            raise error
                        self.calls.append((method, dict(params)))
                        return prior[1]
                    result = super().call(method, params)
                    self.requests[request_id] = (fingerprint, result)
                    if params["action"] == "navigate":
                        self.navigation_effects += 1
                    return result
                return super().call(method, params)

        runtime = DurableRuntime()
        first_adapter = SingleToolAdapter(runtime)
        first_adapter.bind("session-a", "task-native")
        first_adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/first"},
            session_id="session-a", tool_call_id="replayed-call-id",
        )
        resumed_adapter = SingleToolAdapter(runtime)
        resumed_adapter.bind("session-a", "task-native")

        result = json.loads(resumed_adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/second"},
            session_id="session-a", tool_call_id="replayed-call-id",
        ))

        self.assertEqual(result["code"], "request_id_conflict")
        self.assertFalse(result["outcome_unknown"])
        self.assertEqual(runtime.navigation_effects, 1)

    def test_approval_resume_reuses_identical_native_request_id(self):
        class ApprovalRuntime(FakeRuntime):
            def __init__(self):
                super().__init__()
                self.navigate_requests = []

            def call(self, method, params):
                if method == "shared.run" and params["action"] == "navigate":
                    self.calls.append((method, dict(params)))
                    self.navigate_requests.append(dict(params))
                    if len(self.navigate_requests) == 1:
                        return {"status": "approval_required", "requestId": params["requestId"]}
                    return {"tabId": params["tabId"], "url": params["url"], "ready": "complete"}
                return super().call(method, params)

        runtime = ApprovalRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        args = {"url": "https://example.test/confirm"}

        first = json.loads(adapter.dispatch(
            "browser_navigate", args, session_id="session-a", tool_call_id="call-pending",
        ))
        resumed = json.loads(adapter.dispatch(
            "browser_navigate", args, session_id="session-a", tool_call_id="call-resume",
        ))

        self.assertEqual(first["code"], "approval_required")
        self.assertTrue(resumed["success"])
        self.assertEqual(len(runtime.navigate_requests), 2)
        self.assertEqual(runtime.navigate_requests[0]["requestId"], runtime.navigate_requests[1]["requestId"])
        self.assertEqual(runtime.navigate_requests[0]["url"], runtime.navigate_requests[1]["url"])

    def test_revoked_approval_is_not_reported_as_expiry(self):
        class RevokedRuntime(FakeRuntime):
            def call(self, method, params):
                if method == "shared.run" and params["action"] == "navigate":
                    self.calls.append((method, dict(params)))
                    return {"status": "revoked", "requestId": params["requestId"]}
                return super().call(method, params)

        runtime = RevokedRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        result = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/revoked"},
            session_id="session-a", tool_call_id="call-revoked",
        ))

        self.assertEqual(result["code"], "approval_revoked")
        self.assertFalse(result["outcome_unknown"])
        self.assertFalse(result["retryable"])

    def test_write_timeout_is_unknown_and_never_replayed(self):
        class TimeoutRuntime(FakeRuntime):
            def call(self, method, params):
                if method == "shared.run" and params["action"] == "navigate":
                    self.calls.append((method, dict(params)))
                    error = RuntimeError("private transport detail")
                    error.code = "extension_timeout"
                    error.data = {}
                    raise error
                return super().call(method, params)

        runtime = TimeoutRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")

        first = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/timeout"},
            session_id="session-a", tool_call_id="call-timeout",
        ))
        repeated = json.loads(adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/timeout"},
            session_id="session-a", tool_call_id="call-timeout",
        ))

        self.assertEqual(first["code"], "extension_timeout")
        self.assertTrue(first["outcome_unknown"])
        self.assertEqual(repeated["code"], "outcome_unknown")
        self.assertEqual([method for method, _ in runtime.calls].count("shared.run"), 1)
        self.assertNotIn("private transport detail", json.dumps(first))

    def test_different_action_cannot_replace_pending_approval(self):
        class PendingRuntime(FakeRuntime):
            def call(self, method, params):
                if method == "shared.run" and params["action"] == "navigate":
                    self.calls.append((method, dict(params)))
                    return {"status": "approval_required", "requestId": params["requestId"]}
                return super().call(method, params)

        runtime = PendingRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind("session-a", "task-native")
        adapter.dispatch(
            "browser_navigate", {"url": "https://example.test/pending"},
            session_id="session-a", tool_call_id="call-pending",
        )

        blocked = json.loads(adapter.dispatch(
            "browser_snapshot", {}, session_id="session-a", tool_call_id="call-other",
        ))

        self.assertEqual(blocked["code"], "pending_action")
        self.assertEqual([payload["action"] for method, payload in runtime.calls if method == "shared.run"], ["navigate"])


def d_unhandled():
    from single_tool_adapter.adapter import UNHANDLED
    return UNHANDLED


if __name__ == "__main__":
    unittest.main()

class MultiTabTests(unittest.TestCase):
    def test_implicit_tab_becomes_ambiguous_and_explicit_choice_clears_refs(self):
        # 中文注释：新增第二个页后不能继续把旧的隐式页当作当前页。
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        runtime.task['agentTabIds'] = [12, 13]
        runtime.task['tabIds'] = [12, 13]
        result = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='ambiguous'))
        self.assertEqual(result['code'], 'tab_ambiguous')
        self.assertEqual([row['tab_id'] for row in result['tabs']], [12, 13])
        adapter.bind('session-a', 'task-native', tab_id=13)
        result = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='selected'))
        self.assertEqual(result['native_adapter']['tab']['tab_id'], 13)
        self.assertEqual(result['native_adapter']['tab']['url'], 'https://example.com/')
        adapter.bind('session-a', 'task-native', tab_id=12)
        self.assertFalse(adapter._bindings['session-a'].refs)

    def test_two_tasks_survive_switch_and_task_revocation(self):
        runtime = FakeRuntime()
        original = runtime.call
        def call(method, params):
            if method == 'shared.get' and params['taskId'] == 'second':
                return {**runtime.task, 'id': 'second', 'tabIds': [21], 'agentTabIds': [21]}
            return original(method, params)
        runtime.call = call
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native', tab_id=12)
        first = adapter._bindings['session-a']
        first.outcome_unknown = True
        adapter.bind('session-a', 'second', tab_id=21)
        adapter.bind('session-a', 'task-native', tab_id=12)
        self.assertIs(adapter._bindings['session-a'], first)
        self.assertTrue(first.outcome_unknown)
        adapter.unbind('session-a', task_id='second')
        self.assertIs(adapter._bindings['session-a'], first)



    # 中文注释：真实官方 adapter 的最终工具投影必须保留扩展约束，测试不启动个人视觉服务。
    def test_content_shield_metadata_reaches_official_outputs(self):
        class ShieldRuntime(FakeRuntime):
            def call(self, method, params):
                if method == 'shared.run' and params['action'] == 'js.evaluate':
                    result = {'ok': True, 'value': '[已屏蔽区域]'}
                else:
                    result = super().call(method, params)
                if method == 'shared.run' and isinstance(result, dict):
                    result = {**result, 'contentFilter': {'enabled': True, 'removedSegments': 1,
                        'siteAutomationRestricted': True, 'private': 'CONFIG_CANARY'},
                        'masked': [{'kind': 'content_shield', 'role': 'region', 'name': '已屏蔽区域', 'private': 'CONFIG_CANARY'}],
                        'omittedMoving': 0, 'omittedMasked': 1}
                return result
        runtime = ShieldRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        for action, args in [('browser_snapshot', {}), ('browser_navigate', {'url': 'https://example.test/'}),
                             ('browser_console', {'expression': 'document.body.textContent'}),
                             ('browser_vision', {'question': 'test', 'annotate': True})]:
            with self.subTest(action=action), patch.object(adapter, '_vision', return_value={'success': True}):
                result = json.loads(adapter.dispatch(action, args, session_id='session-a', tool_call_id='shield-' + action))
                self.assertTrue(result['contentFilter']['siteAutomationRestricted'])
                self.assertTrue(result['contentFilter']['enabled'])
                self.assertEqual(result['omittedMasked'], 1)
                self.assertEqual(result['masked'][0]['kind'], 'content_shield')
                self.assertNotIn('CONFIG_CANARY', json.dumps(result))

    def test_annotated_vision_omits_hidden_refs_from_snapshot_and_binding(self):
        # 中文注释：图片未画出的隐藏引用也不能残留在官方快照文字或后续点击绑定。
        class HiddenRuntime(FakeRuntime):
            def call(self, method, params):
                result = super().call(method, params)
                if method == 'shared.run' and params['action'] == 'screenshot':
                    result['annotations'] = result['annotations'][:1]
                return result
        runtime = HiddenRuntime()
        runtime.snapshot['items'].append({'ref': 'hidden-ref', 'role': 'textbox', 'name': ''})
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        with patch.object(adapter, '_vision', side_effect=lambda receipt, question, **extra: {'success': True, **extra}):
            result = json.loads(adapter.dispatch('browser_vision', {'question': 'test', 'annotate': True},
                session_id='session-a', tool_call_id='hidden-vision'))
        self.assertNotIn('[@e2]', result['snapshot'])
        self.assertNotIn('@e2', adapter._bindings['session-a'].refs)
        self.assertIn('[@e1]', result['snapshot'])

# 中文注释：树形展示增加上下文与状态，但每个动作别名仍绑定到原 native ref。
class TreeSnapshotTests(unittest.TestCase):
    def test_snapshot_shows_only_fixed_action_capabilities(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        runtime.snapshot['items'][0]['actions'] = ['click', 'fill', 'PRIVATE_ACTION_CANARY', {'value': 'PRIVATE_OBJECT_CANARY'}]
        result = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='capabilities'))
        self.assertIn('操作：点击/填写', result['snapshot'])
        self.assertNotIn('PRIVATE_', result['snapshot'])

    def test_tree_context_states_and_alias_binding(self):
        runtime = FakeRuntime()
        adapter = SingleToolAdapter(runtime)
        adapter.bind('session-a', 'task-native')
        runtime.snapshot['items'] = [
            {'ref': 'ref-a', 'role': 'button', 'name': '更多', 'expanded': False,
             'context': [{'ref': 'region', 'role': 'main', 'name': '版本'}, {'ref': 'record-a', 'role': 'article', 'name': '版本 A'}]},
            {'ref': 'ref-b', 'role': 'button', 'name': '更多', 'expanded': True,
             'context': [{'ref': 'region', 'role': 'main', 'name': '版本'}, {'ref': 'record-b', 'role': 'article', 'name': '版本 B'}]},
        ]
        result = json.loads(adapter.dispatch('browser_snapshot', {}, session_id='session-a', tool_call_id='tree'))
        self.assertIn('版本 A', result['snapshot'])
        self.assertIn('版本 B', result['snapshot'])
        self.assertIn('未展开', result['snapshot'])
        self.assertIn('（展开）', result['snapshot'])
        self.assertEqual(result['snapshot'].count('[main] 版本'), 1)
        self.assertEqual(result['element_count'], 2)
