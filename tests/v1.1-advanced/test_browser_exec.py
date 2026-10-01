"""browser_exec 接管的离线测试：合成注册表与运行器，不启动 CLI 或浏览器。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("v11_browser_exec", ROOT / "executor-plugin/single_tool_adapter/browser_exec.py")
browser_exec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser_exec)

LEASE = "__hermes_owner_lease"


class LeaseError(Exception):
    pass


class Authority:
    def __init__(self):
        self.leased = []

    def consume(self, name, args, session_id=None):
        if args.get(LEASE) != "good":
            raise LeaseError()
        return SimpleNamespace(tool_call_id="call-1")

    def lease_tools(self, names, passthrough=False):
        self.leased.append((tuple(names), passthrough))


class Runtime:
    def __init__(self, gateway=None, error=None, permit=None):
        self.authority = Authority()
        self.calls = []
        self.gateway, self.error, self.permit = gateway, error, permit

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "shared.run":
            return self.permit if self.permit is not None else {"authorized": True}
        if self.error:
            raise self.error
        if method == "shared.cdp_gateway_close":
            return {"closed": True}
        return self.gateway


class Bridge:
    def __init__(self, bindings):
        self._guard = threading.RLock()
        self._bindings = bindings


class Context:
    def __init__(self):
        self.registered = {}

    def register_tool(self, **kwargs):
        self.registered[kwargs["name"]] = kwargs


class Registry:
    def __init__(self, handler):
        self.entry = SimpleNamespace(handler=handler, is_async=False, check_fn=lambda: False, toolset="browser-use",
                                     schema={"name": "browser_exec", "description": "Drive a browser.\n\n(The browser-use CLI is not installed yet. Install it.)",
                                             "parameters": {"type": "object", "properties": {"code": {"type": "string"}}}},
                                     requires_env=[], description="", emoji="🌐")

    def get_entry(self, name):
        return self.entry if name == "browser_exec" else None


class BrowserExecTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.original_calls = []

    def register(self, runtime, bindings):
        registry = Registry(lambda args, **kw: self.original_calls.append((args, kw)) or '{"original":true}')
        ctx = Context()
        adapter = browser_exec.register_browser_exec_override(
            ctx, runtime, Bridge(bindings), Path(self.tmp.name), lease_arg=LEASE, lease_error=LeaseError, registry=registry)
        return ctx.registered["browser_exec"], adapter

    def test_unbound_session_keeps_hermes_behavior(self):
        runtime = Runtime()
        tool, _ = self.register(runtime, {})
        self.assertEqual(tool["handler"]({"code": "print(1)"}, session_id="s", task_id="t"), '{"original":true}')
        self.assertEqual(self.original_calls[0][1]["task_id"], "t")
        self.assertEqual(runtime.calls, [])
        self.assertNotIn("not installed yet", tool["schema"]["description"])
        self.assertEqual(runtime.authority.leased, [(("browser_exec",), True)])

    def test_bound_smart_session_requests_script_approval_without_running(self):
        # 中文注释：智能审批在启动 CLI 前返回等待批准，并绑定脚本摘要。
        runtime = Runtime(permit={"status": "approval_required", "requestId": "pending"})
        revoked = threading.Event()
        tool, adapter = self.register(runtime, {"s": ("owner-1", "task-1", "inst", None, None, revoked)})
        adapter.runner = lambda *a: self.fail("CLI must not start")
        adapter.cli_finder = lambda: ["/bin/browser-use"]
        result = json.loads(tool["handler"]({"code": "print(1)", LEASE: "good"}, session_id="s", task_id="t"))
        self.assertEqual(result["status"], "approval_required")
        self.assertEqual(runtime.calls[0][0], "shared.run")
        self.assertEqual(runtime.calls[0][1]["action"], "gateway.authorize")
        self.assertEqual(self.original_calls, [], "a bound session never falls back to another browser")
        self.assertEqual(json.loads(tool["handler"]({"code": "x"}, session_id="s"))["code"], "tool_call_identity_required")

    def test_bound_session_runs_cli_against_the_task_gateway(self):
        runtime = Runtime(gateway={"wsUrl": "ws://127.0.0.1:5555/devtools/browser/tok", "expiresAt": 1})
        tool, adapter = self.register(runtime, {"s": ("owner-1", "task-1", "inst", None, None, threading.Event())})
        seen = {}

        def runner(cmd, code, env, timeout):
            seen.update(cmd=cmd, code=code, env=env, timeout=timeout)
            return subprocess.CompletedProcess(cmd, 0, "title=Example token=abc\n", "")

        adapter.runner = runner
        adapter.cli_finder = lambda: ["/bin/browser-use"]
        result = json.loads(tool["handler"]({"code": "print(page_info())", "timeout_s": 9999, LEASE: "good"},
                                            session_id="s", task_id="hermes-task"))
        self.assertTrue(result["success"])
        self.assertEqual(result["backend"], "hermes-native-task")
        self.assertEqual(seen["env"]["BU_CDP_WS"], "ws://127.0.0.1:5555/devtools/browser/tok")
        self.assertTrue(seen["env"]["BU_NAME"].startswith("hermes-task-"))
        self.assertEqual(seen["timeout"], 1800)
        self.assertNotIn("PYTHONPATH", seen["env"])
        workspace = Path(seen["env"]["BH_AGENT_WORKSPACE"])
        self.assertEqual(workspace.name, "hermes-task")
        self.assertEqual(runtime.calls[1][1]["workspace"], str(workspace))
        self.assertEqual(runtime.calls[-1][0], "shared.cdp_gateway_close")
        revoked = threading.Event()
        revoked.set()
        tool2, _ = self.register(runtime, {"s": ("owner-1", "task-1", "inst", None, None, revoked)})
        self.assertEqual(tool2["handler"]({"code": "x"}, session_id="s"), '{"original":true}')


if __name__ == "__main__":
    unittest.main()
