"""官方 Vault 登录工具到私有填写端口的合成适配验证。"""

import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "executor-plugin"))
from vault_adapter.adapter import VaultAdapter  # noqa: E402
from vault_adapter.integration import VAULT_TOOL_NAMES, register_vault_overrides  # noqa: E402


class Runtime:
    def __init__(self):
        self.authority = type("Authority", (), {"owner_for_session": lambda self, session: "owner"})()
        self.task = {"id": "task", "state": "ready", "instanceId": "browser", "generation": 3,
                     "modeGeneration": 2, "activeMode": "full", "tabIds": [7],
                     "workTabs": [{"tabId": 7, "groupId": 1, "windowId": 2}],
                     "allowedOrigins": ["https://example.test"]}
        self.permit = {"status": "approval_required"}
        self.approvals = []

    def call(self, method, params):
        if method == "shared.get":
            return dict(self.task)
        if method == "browser.list":
            return [{"instanceId": "browser", "connected": True}]
        if method == 'shared.run':
            self.approvals.append(params)
            return dict(self.permit)
        raise AssertionError("unexpected ordinary RPC")


class Host:
    def resolve_vault_binding(self, session_id):
        if session_id != "session":
            return None
        return {"owner": "owner", "task_id": "task", "instance_id": "browser", "generation": 3,
                "mode_generation": 2, "tab_id": 7}


class Source:
    def __init__(self):
        self.registered = []

    def list(self):
        return {"success": True, "items": [
            {"handle": "login", "kind": "login", "origin": "https://example.test", "label": "Test"},
            {"handle": "card", "kind": "payment", "origin": "https://example.test", "label": "Card"},
        ]}

    def get_meta(self, handle):
        return {"kind": "login" if handle == "login" else "payment", "origin": "https://example.test"}

    def resolve(self, handle, kind):
        assert handle == "login" and kind == "login"
        return {"password": "SyntheticSecret!"}

    def register_secret(self, value):
        self.registered.append(value)


class Port:
    def __init__(self):
        self.fills = []

    def inspect(self, scope):
        return {"taskId": scope.task_id, "instanceId": scope.instance_id,
                "generation": scope.generation, "modeGeneration": scope.mode_generation, "tabId": scope.tab_id,
                "origin": "https://example.test", "nonce": "a" * 48, "documentGeneration": 4,
                "controls": [{"index": 0, "type": "password", "name": "password", "label": "Password",
                              "autocomplete": "current-password", "maxLength": None, "formIndex": 0}]}

    def fill(self, scope, **kwargs):
        self.fills.append(kwargs)
        return {"filled": 1}


class VaultAdapterTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.source = Source()
        self.port = Port()
        self.adapter = VaultAdapter(self.runtime, Host(), self.source, self.port)

    def invoke(self, name, args):
        return json.loads(self.adapter.invoke(name, args, session_id="session"))

    def test_login_secret_is_blind_to_tool_result(self):
        # 中文注释：列表只给登录句柄，私有填写接收密码，普通工具结果不含密码。
        listed = self.invoke("browser_vault_list", {})
        self.assertEqual([item["handle"] for item in listed["items"]], ["login"])
        result = self.invoke("browser_vault_fill", {"handle": "login"})
        self.assertEqual(result["filled_fields"], 1)
        self.assertEqual(self.port.fills[0]["fills"][0]["value"], "SyntheticSecret!")
        self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertEqual(self.source.registered, ["SyntheticSecret!"])

    def test_scope_change_and_payment_are_refused(self):
        self.runtime.task["modeGeneration"] = 4
        self.assertEqual(self.invoke("browser_vault_fill", {"handle": "login"})["error_type"], "binding_denied")
        self.runtime.task["modeGeneration"] = 2
        self.assertEqual(self.invoke("browser_vault_fill", {"handle": "card"})["error_type"], "vault_item_unavailable")
        self.assertEqual(self.port.fills, [])

    def test_smart_fill_waits_for_approval_then_uses_private_port(self):
        # 中文注释：拒绝或等待期间不解析秘密，批准后只向私有端口传摘要凭证。
        self.runtime.task['activeMode'] = 'smart'
        pending = self.invoke('browser_vault_fill', {'handle': 'login'})
        self.assertEqual(pending['error_type'], 'approval_required')
        self.assertEqual(self.source.registered, [])
        self.assertEqual(self.port.fills, [])
        self.runtime.permit = {'authorized': True}
        filled = self.invoke('browser_vault_fill', {'handle': 'login'})
        self.assertTrue(filled['success'])
        approval = self.port.fills[0]['approval']
        self.assertEqual(approval['vaultAction'], 'fill')
        self.assertEqual(self.runtime.approvals[0]['handleDigest'], approval['handleDigest'])
        self.assertNotIn('SyntheticSecret!', json.dumps(self.runtime.approvals))

    def test_override_keeps_unbound_official_handler(self):
        # 中文注释：已绑定任务使用私有适配器；未绑定会话仍调用 Hermes 原 Vault 工具。
        entries = {name: types.SimpleNamespace(is_async=False, handler=lambda args, **kwargs: "official")
                   for name in VAULT_TOOL_NAMES}
        registry = types.SimpleNamespace(get_entry=lambda name: entries[name])
        tools = types.ModuleType("tools")
        registry_module = types.ModuleType("tools.registry")
        registry_module.registry = registry
        official_module = types.ModuleType("tools.browser_vault_tool")

        class Authority:
            def lease_tools(self, names, *, passthrough):
                self.names, self.passthrough = names, passthrough

            def consume(self, name, args, *, session_id):
                return types.SimpleNamespace(tool_call_id="call")

        class Context:
            def __init__(self):
                self.tools = {}

            def has_capability(self, name):
                return name == "tools.override"

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs

            def on_unload(self, callback):
                self.unload = callback

        context = Context()
        profile = types.SimpleNamespace(authority=Authority())
        bindings = types.SimpleNamespace(claims=lambda session: session == "session", close=lambda: None)
        adapted = types.SimpleNamespace(invoke=lambda name, args, **kwargs: "private")
        with patch.dict(sys.modules, {"tools": tools, "tools.registry": registry_module,
                                      "tools.browser_vault_tool": official_module}):
            names = register_vault_overrides(context, profile, bindings, adapted,
                                             lease_arg="_lease", lease_error=ValueError)
        self.assertEqual(set(names), set(VAULT_TOOL_NAMES))
        self.assertTrue(profile.authority.passthrough)
        handler = context.tools["browser_vault_fill"]["handler"]
        self.assertTrue(context.tools["browser_vault_fill"]["override"])
        self.assertEqual(handler({"handle": "login", "_lease": "token"}, session_id="session"), "private")
        self.assertEqual(handler({"handle": "login"}, session_id="other"), "official")
        self.assertEqual(json.loads(handler({"handle": "login"}, session_id="session"))["error_type"], "binding_denied")


if __name__ == "__main__":
    unittest.main()

class VaultMultiBindingTests(unittest.TestCase):
    def test_switch_revokes_old_nonce_and_unbind_preserves_other_task(self):
        from vault_adapter.integration import VaultBindingRegistry
        runtime = Runtime()
        original = runtime.call
        def call(method, params):
            if method == 'shared.get' and params['taskId'] == 'second':
                return {**runtime.task, 'id': 'second', 'tabIds': [8],
                        'workTabs': [{'tabId': 8, 'groupId': 2, 'windowId': 2}]}
            return original(method, params)
        runtime.call = call
        revoked = []
        port = types.SimpleNamespace(revoke_binding=lambda *args: revoked.append(args))
        registry = VaultBindingRegistry(runtime, port)
        registry.bind('session', owner='owner', task_id='task', tab_id=7)
        registry.bind('session', owner='owner', task_id='second')
        self.assertEqual(registry.resolve_vault_binding('session')['task_id'], 'task')
        registry.bind('session', owner='owner', task_id='second', tab_id=8)
        self.assertIn(('session', 'owner', 'task'), revoked)
        registry.unbind('session', task_id='task')
        self.assertEqual(registry.resolve_vault_binding('session')['tab_id'], 8)
        with self.assertRaises(ValueError):
            registry.bind('session', owner='owner', task_id='second', tab_id=9)

    def test_implicit_multiple_tabs_never_become_credential_target(self):
        from vault_adapter.integration import VaultBindingRegistry
        runtime = Runtime()
        registry = VaultBindingRegistry(runtime, types.SimpleNamespace(revoke_binding=lambda *_: None))
        registry.bind('session', owner='owner', task_id='task')
        runtime.task['tabIds'].append(8)
        runtime.task['workTabs'].append({'tabId': 8, 'groupId': 1, 'windowId': 2})
        self.assertIsNone(registry.resolve_vault_binding('session'))
