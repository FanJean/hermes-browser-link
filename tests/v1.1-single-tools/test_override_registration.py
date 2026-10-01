"""Official browser_* takeover through Hermes' public register_tool(override=True).

No Hermes source is imported or patched: the registry, context and URL policy
module are synthetic. Verifies the fallback, identity and preflight contract.
"""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "executor-plugin"
sys.path.insert(0, str(PLUGIN))
import native_runtime  # noqa: E402

integration = native_runtime.load_module(PLUGIN / "single_tool_adapter" / "integration.py",
                                         "override_integration_under_test_")


class Registry:
    def __init__(self, names):
        self.calls = []
        self.entries = {}
        for name in names:
            def original(args, task_id=None, _name=name):
                self.calls.append((_name, args, task_id))
                return json.dumps({"built_in": _name})
            self.entries[name] = types.SimpleNamespace(
                toolset="browser", schema={"name": name}, handler=original, check_fn=lambda: False,
                requires_env=[], is_async=False, description=name, emoji="🌐")

    def get_entry(self, name):
        return self.entries.get(name)


class Context:
    def __init__(self):
        self.registered = {}
        self.unload = []

    def register_tool(self, **kwargs):
        self.registered[kwargs["name"]] = kwargs

    def on_unload(self, callback):
        self.unload.append(callback)


class OverrideRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = types.SimpleNamespace(
            authority=native_runtime.NativeOwnerAuthority(Path(self.temp.name) / "authority"),
            call=lambda *_a, **_k: self.fail("unbound sessions must not reach the bridge"))
        self.registry = Registry(["browser_navigate", "browser_click", "browser_vision"])
        self.ctx = Context()
        self.host, self.names = integration.register_official_overrides(
            self.ctx, self.runtime, lease_arg=native_runtime.OWNER_LEASE_ARG,
            lease_error=native_runtime.OwnerLeaseError, registry=self.registry)

    def call(self, name, args, *, session_id="session-a", tool_call_id="call-1"):
        hook = self.runtime.authority.pre_tool_call(name, args, session_id=session_id, tool_call_id=tool_call_id)
        if hook is not None:
            self.assertEqual(hook["action"], "modify", hook)
            args = {**args, **hook["args"]}
        return self.ctx.registered[name]["handler"](args, session_id=session_id, task_id="hermes-task")

    def test_only_existing_official_tools_are_registered_with_override(self):
        self.assertEqual(set(self.names), {"browser_navigate", "browser_click", "browser_vision"})
        for entry in self.ctx.registered.values():
            self.assertIs(entry["override"], True)
            self.assertEqual(entry["toolset"], "browser")
        self.assertEqual(len(self.ctx.unload), 1)

    def test_unbound_session_keeps_the_built_in_handler_with_clean_args(self):
        result = json.loads(self.call("browser_navigate", {"url": "https://example.com/"}))
        self.assertEqual(result, {"built_in": "browser_navigate"})
        name, args, task_id = self.registry.calls[-1]
        self.assertEqual(args, {"url": "https://example.com/"})
        self.assertEqual(task_id, "hermes-task")

    def test_missing_identity_is_passed_through_not_blocked(self):
        self.assertIsNone(self.runtime.authority.pre_tool_call(
            "browser_navigate", {"url": "https://example.com/"}, session_id="", tool_call_id=""))
        handler = self.ctx.registered["browser_navigate"]["handler"]
        self.assertEqual(json.loads(handler({"url": "https://example.com/"}, session_id=None)),
                         {"built_in": "browser_navigate"})

    def test_forged_lease_is_rejected_and_never_reaches_any_browser(self):
        handler = self.ctx.registered["browser_click"]["handler"]
        result = json.loads(handler({"ref": "e1", native_runtime.OWNER_LEASE_ARG: "forged"}, session_id="session-a"))
        self.assertIs(result["success"], False)
        self.assertEqual(result["error"], "缺少可信会话身份，已拒绝浏览器操作。")
        self.assertIs(result["outcome_unknown"], False)
        self.assertEqual(self.registry.calls, [])

    def test_bound_session_is_authoritative_and_uses_the_trusted_call_id(self):
        dispatched = []
        self.host.claims = lambda session_id, action=None: session_id == "session-a"
        self.host.dispatch = lambda name, args, **identity: dispatched.append((name, args, identity)) or '{"ok":true}'
        self.assertEqual(json.loads(self.call("browser_click", {"ref": "e1"})), {"ok": True})
        self.assertEqual(dispatched, [("browser_click", {"ref": "e1"},
                                       {"session_id": "session-a", "tool_call_id": "call-1"})])
        self.assertEqual(self.registry.calls, [], "a bound session never falls back to another browser")

    def test_bound_navigation_applies_hermes_url_policy_first(self):
        dispatched = []
        self.host.claims = lambda session_id, action=None: True
        self.host.dispatch = lambda *a, **k: dispatched.append(a) or '{"ok":true}'
        policy = types.ModuleType("tools.browser_tool")
        policy.evaluate_url_safety = lambda url: {"success": False, "error": "blocked"} if "169.254" in url else None
        tools = types.ModuleType("tools")
        previous = {name: sys.modules.get(name) for name in ("tools", "tools.browser_tool")}
        sys.modules.update({"tools": tools, "tools.browser_tool": policy})
        try:
            blocked = json.loads(self.call("browser_navigate", {"url": "http://169.254.169.254/"}, tool_call_id="c1"))
            allowed = json.loads(self.call("browser_navigate", {"url": "https://example.com/"}, tool_call_id="c2"))
        finally:
            for name, module in previous.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
        self.assertEqual(blocked, {"success": False, "error": "blocked"})
        self.assertEqual(allowed, {"ok": True})
        self.assertEqual(len(dispatched), 1)

    def test_bound_navigation_fails_closed_without_the_url_policy(self):
        self.host.claims = lambda session_id, action=None: True
        self.host.dispatch = lambda *a, **k: self.fail("must not dispatch without URL policy")
        previous = sys.modules.get("tools.browser_tool")
        sys.modules["tools.browser_tool"] = None  # import raises
        try:
            result = json.loads(self.call("browser_navigate", {"url": "https://example.com/"}))
        finally:
            if previous is None:
                sys.modules.pop("tools.browser_tool", None)
            else:
                sys.modules["tools.browser_tool"] = previous
        self.assertEqual(result["code"], "url_policy_unavailable")
        self.assertIs(result["outcome_unknown"], False)

    def test_check_fn_advertises_tools_while_a_session_is_bound(self):
        check = self.ctx.registered["browser_click"]["check_fn"]
        self.assertFalse(check())
        self.host.has_bindings = lambda: True
        self.assertTrue(check())


if __name__ == "__main__":
    unittest.main()
