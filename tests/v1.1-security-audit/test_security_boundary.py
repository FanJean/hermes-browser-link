"""Synthetic attacks through real plugin registration, FD bridge and daemon dispatch.

No browser, installer, real account, credential material, or user profile is used.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "executor-plugin"
SCRATCH = Path.home() / ".hermes" / "cache" / "scratch"
SCRATCH.mkdir(parents=True, exist_ok=True, mode=0o700)
sys.path.insert(0, str(ROOT / "native-bridge"))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402


def load_module(path: Path, label: str):
    name = f"security_audit_{label}_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load production module: {path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class DispatchClient:
    """Plugin-client seam; every call enters the production daemon dispatcher."""

    def __init__(self, daemon):
        self.daemon = daemon
        self.calls = []
        self.lock = threading.Lock()

    def call(self, method, params):
        with self.lock:
            self.calls.append((method, dict(params)))
        return self.daemon._dispatch_client(method, params)


class PluginContext:
    def __init__(self):
        self.tools = {}
        self.hooks = {}
        self.cleanups = []

    def get_config(self, key, default=None):
        return default

    def has_capability(self, name):
        # The script lane needs no tools.override; official tool takeover is
        # covered by tests/v1.1-single-tools/test_override_registration.py.
        return False

    def register_tool(self, *, name, **kwargs):
        self.tools[name] = kwargs

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def on_unload(self, callback):
        self.cleanups.append(callback)


class SecurityBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v11-security-", dir=SCRATCH)
        self.home = Path(self.temp.name) / "hermes-home"
        self.daemon = BridgeDaemon(self.home)
        self.daemon._persist_tasks = lambda: None
        self.daemon._notify_tasks_changed = lambda _instance: None
        self.daemon.extensions["browser-A"] = {
            "instanceId": "browser-A", "browser": "chrome", "version": "synthetic"
        }
        self.extension_calls = []
        self.executed = threading.Event()
        self.daemon._extension_call = self.synthetic_extension_call

        native_tools = load_module(PLUGIN / "native_tools.py", "native_tools")
        native_runtime = native_tools.runtime_module()
        self.profile = native_runtime.get_native_profile_runtime(self.home, PLUGIN)
        self.profile._client = DispatchClient(self.daemon)
        self.profile._client_module = None
        self.owner_a = self.profile.authority.owner_for_session("session-A")
        self.owner_b = self.profile.authority.owner_for_session("session-B")
        self._seed_task("task-A", self.owner_a, 71)
        self._seed_task("task-B", self.owner_b, 72)

        self.context = PluginContext()
        self.plugin = load_module(PLUGIN / "__init__.py", "plugin")
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.home
        with patch.dict(sys.modules, {"hermes_constants": constants}):
            self.plugin.register(self.context)
        self.launches = []
        self.unloaded = False

    def tearDown(self):
        for launch in self.launches:
            if not launch._closed.is_set():
                launch.close()
        if not self.unloaded:
            self.unload_plugin()
        self.temp.cleanup()

    def _seed_task(self, task_id, owner, tab_id):
        now = time.time()
        task = {
            "id": task_id, "owner": owner, "title": "synthetic task",
            "instanceId": "browser-A", "browser": "chrome", "state": "ready",
            "generation": 1, "modeGeneration": 1, "activeMode": "smart",
            "allowedOrigins": ["https://fixture.test"],
            "tabIds": [tab_id], "agentTabIds": [],
            "workTabs": [], "workspaceState": "ready", "requestHistory": [],
            "createdAt": now, "updatedAt": now, "isolation": "shared-profile",
        }
        self.daemon.tasks[task_id] = task
        self.daemon.task_locks[task_id] = threading.RLock()
        self.daemon.cleanup_locks[task_id] = threading.Lock()
        self.daemon.dedupe[task_id] = {}
        self.daemon.tab_leases[("browser-A", tab_id)] = task_id
        return task

    def synthetic_extension_call(self, _extension, method, params, **_kwargs):
        self.extension_calls.append((method, dict(params)))
        if method == "browser.release":
            return {"released": True, "cleanupState": "succeeded",
                    "remainingTabIds": [], "preservedTabIds": [], "unknownTabIds": []}
        if method == "browser.assess":
            return {"targetAssessment": "ordinary"}
        if method == "browser.execute":
            self.executed.set()
            action = params.get("action")
            if action == "official.new_tab":
                return {"targetId": "synthetic-chrome-target-73", "tabId": 73,
                        "groupId": 7, "windowId": 8}
            if action == "official.ready_state":
                return {"readyState": "interactive"}
            return {"clicked": True, "tabId": params.get("tabId")}
        raise AssertionError(f"unexpected production daemon extension method: {method}")

    def tool(self, name, args, *, session="session-A", call_id=None):
        call_id = call_id or "synthetic-call-" + uuid.uuid4().hex
        hook = self.context.hooks["pre_tool_call"]
        decision = hook(name, dict(args), session_id=session, tool_call_id=call_id)
        if not decision or decision.get("action") != "modify":
            return {"hook": decision}, None
        patched = {**args, **decision["args"]}
        raw = self.context.tools[name]["handler"](
            patched, session_id=session, tool_call_id=call_id
        )
        return json.loads(raw), patched

    def get_task(self, task_id="task-A", *, session="session-A"):
        result, _ = self.tool("browser_shared_get", {"task_id": task_id}, session=session)
        return result

    def prepare_fd(self, *, session="session-A", task_id="task-A", call_id=None):
        # The first unload callback the plugin registers is the script lane's
        # HostBridge.close; use that exact production instance.
        bridge = self.context.cleanups[0].__self__
        self.assertEqual(type(bridge).__name__, "HostBridge")
        self.assertIn("browser_shared_script", self.context.tools)
        launch = bridge.prepare(
            session_id=session, tool_call_id=call_id or "fd-call-" + uuid.uuid4().hex,
            task_id=task_id, workspace=str(SCRATCH), code="pass",
        )
        self.launches.append(launch)
        return launch

    @staticmethod
    def fd_request(launch, request):
        with socket.socket(fileno=os.dup(launch.fd)) as client:
            with client.makefile("rwb") as stream:
                stream.write((json.dumps(request, separators=(",", ":")) + "\n").encode())
                stream.flush()
                return json.loads(stream.readline())

    def unload_plugin(self):
        if self.unloaded:
            return
        for cleanup in reversed(self.context.cleanups):
            cleanup()
        self.unloaded = True

    def test_forged_owner_cross_session_task_and_replayed_owner_lease_fail_closed(self):
        bound = self.get_task()
        self.assertEqual(bound["sessionBinding"], "ready")

        forged, _ = self.tool("browser_shared_get", {"task_id": "task-A", "owner": self.owner_b})
        self.assertEqual(forged["hook"]["action"], "block")

        # Reuse a trusted one-shot lease from session-A under session-B.
        hook = self.context.hooks["pre_tool_call"]
        issued = hook("browser_shared_get", {"task_id": "task-A"},
                      session_id="session-A", tool_call_id="cross-session")
        patched = {"task_id": "task-A", **issued["args"]}
        replayed_cross_session = json.loads(self.context.tools["browser_shared_get"]["handler"](
            patched, session_id="session-B"))
        self.assertEqual(replayed_cross_session["code"], "owner_denied")
        replayed = json.loads(self.context.tools["browser_shared_get"]["handler"](
            patched, session_id="session-A"))
        self.assertEqual(replayed["code"], "owner_denied")

        # A same-session lease cannot be retargeted to another task after the hook.
        issued = hook("browser_shared_get", {"task_id": "task-A"},
                      session_id="session-A", tool_call_id="retarget-task")
        mutated = {"task_id": "task-B", **issued["args"]}
        retargeted = json.loads(self.context.tools["browser_shared_get"]["handler"](
            mutated, session_id="session-A"))
        self.assertEqual(retargeted["code"], "owner_denied")

        foreign_task = self.get_task("task-B")
        self.assertEqual(foreign_task["bridgeCode"], "forbidden")
        self.assertNotIn("owner", foreign_task)

    def test_real_fd_is_pinned_to_bound_task_and_old_generation_is_fenced(self):
        self.assertEqual(self.get_task()["sessionBinding"], "ready")
        # Simulate the explicit browser-extension full-mode decision; this test
        # is about FD/task/generation fencing, not smart-mode confirmation.
        self.daemon._dispatch_extension("browser-A", "extension.mode", {
            "taskId": "task-A", "mode": "full", "generation": 1, "modeGeneration": 1,
        })
        launch = self.prepare_fd(task_id="task-B")  # Model/task argument cannot retarget host binding.
        opened = self.fd_request(launch, {
            "op": "official.new_tab", "args": ["https://fixture.test/work"]
        })
        self.assertTrue(opened["ok"], opened)
        self.assertEqual(opened["value"], "synthetic-chrome-target-73")
        ready = self.fd_request(launch, {"op": "official.ready_state", "args": []})
        self.assertEqual(ready["value"], {"readyState": "interactive"})
        official_calls = [p for method, p in self.extension_calls if method == "browser.execute"]
        self.assertEqual([p["taskId"] for p in official_calls], ["task-A", "task-A"])
        self.assertEqual([p["generation"] for p in official_calls], [1, 1])

        cancelled, _ = self.tool("browser_shared_cancel", {"task_id": "task-A"})
        self.assertEqual(cancelled["state"], "cancelled")
        resumed, _ = self.tool("browser_shared_resume", {"task_id": "task-A"})
        self.assertEqual(resumed["generation"], 2)
        self.assertEqual(resumed["state"], "pending_approval")
        self.daemon._dispatch_extension("browser-A", "extension.approve", {
            "taskId": "task-A", "tabIds": [71],
            "allowedOrigins": ["https://fixture.test"],
        })
        before = len([p for method, p in self.extension_calls if method == "browser.execute"])
        stale_fd = self.fd_request(launch, {"op": "official.ready_state", "args": []})
        self.assertFalse(stale_fd["ok"])
        # 中文注释：只返回固定文案，不含内部异常原文。
        self.assertIn(stale_fd["error"], {'浏览器操作结果不确定；不要自动重放。', '浏览器操作未执行，可重新读取页面后重试。'})
        after = len([p for method, p in self.extension_calls if method == "browser.execute"])
        self.assertEqual(after, before, "revoked generation reached the extension")

    def test_model_cannot_self_approve_and_daemon_approval_is_scoped_and_one_shot(self):
        self.assertEqual(self.get_task()["sessionBinding"], "ready")
        launch = self.prepare_fd()
        malicious = self.fd_request(launch, {
            "op": "extension.decide",
            "args": [{"taskId": "task-A", "nonce": "model-nonce",
                      "digest": "model-digest", "approve": True}],
        })
        self.assertFalse(malicious["ok"])
        before_calls = sum(method == "shared.run" for method, _ in self.profile._client.calls)

        click = {"task_id": "task-A", "request_id": "click-v1", "action": "click",
                 "tab_id": 71, "selector": "#synthetic"}
        pending, _ = self.tool("browser_shared_run", click)
        self.assertEqual(pending["status"], "approval_required")
        self.assertFalse(self.executed.is_set())
        forged, _ = self.tool("browser_shared_run", {**click, "approval": {
            "nonce": "model-nonce", "digest": "model-digest"}})
        self.assertEqual(forged["code"], "invalid_fields")
        self.assertEqual(forged["fields"], ["approval"])
        self.assertEqual(sum(method == "shared.run" for method, _ in self.profile._client.calls), before_calls + 1)
        with self.assertRaises(ProtocolError) as direct_self_approval:
            self.daemon._dispatch_client("shared.run", {
                "owner": self.owner_a, "taskId": "task-A", "requestId": "direct-forged",
                "action": "click", "tabId": 71, "selector": "#synthetic",
                "approval": {"nonce": "model-nonce", "digest": "model-digest"},
            })
        self.assertEqual(direct_self_approval.exception.code, "invalid_params")

        approval_v1 = self.daemon._dispatch_extension("browser-A", "extension.approvals", {})[0]
        decision = {"taskId": "task-A", "nonce": approval_v1["nonce"],
                    "digest": approval_v1["digest"], "approve": True}
        for instance, changes in (("browser-B", {}), ("browser-A", {"digest": "wrong-digest"})):
            with self.assertRaises(ProtocolError) as denied:
                self.daemon._dispatch_extension(instance, "extension.decide", {**decision, **changes})
            self.assertEqual(denied.exception.code, "approval_stale")

        # Revoke generation 1 through the registered tool, then resume as gen 2.
        cancelled, _ = self.tool("browser_shared_cancel", {"task_id": "task-A"})
        self.assertEqual(cancelled["state"], "cancelled")
        resumed, _ = self.tool("browser_shared_resume", {"task_id": "task-A"})
        self.assertEqual(resumed["generation"], 2)
        with self.assertRaises(ProtocolError) as stale_generation:
            self.daemon._dispatch_extension("browser-A", "extension.decide", decision)
        self.assertEqual(stale_generation.exception.code, "approval_stale")
        self.daemon._dispatch_extension("browser-A", "extension.approve", {
            "taskId": "task-A", "tabIds": [71],
            "allowedOrigins": ["https://fixture.test"],
        })

        click_v2 = {**click, "request_id": "click-v2"}
        pending_v2, _ = self.tool("browser_shared_run", click_v2)
        self.assertEqual(pending_v2["status"], "approval_required")
        approval_v2 = self.daemon._dispatch_extension("browser-A", "extension.approvals", {})[0]
        self.assertEqual(approval_v2["generation"], 2)
        self.assertEqual(self.daemon._dispatch_extension("browser-A", "extension.decide", {
            "taskId": "task-A", "nonce": approval_v2["nonce"],
            "digest": approval_v2["digest"], "approve": True,
        }), {"status": "approved"})
        self.assertTrue(self.executed.wait(2), "approved synthetic action was not dispatched")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and ("task-A", __import__("hashlib").sha256(
                b"click-v2").hexdigest()) in self.daemon.action_approvals:
            time.sleep(0.005)
        self.assertEqual(len([1 for method, p in self.extension_calls
                              if method == "browser.execute" and p.get("requestId") == "click-v2"]), 1)

        # Identical tool request returns its cached result, never a second write.
        self.tool("browser_shared_run", click_v2)
        self.assertEqual(len([1 for method, p in self.extension_calls
                              if method == "browser.execute" and p.get("requestId") == "click-v2"]), 1)
        with self.assertRaises(ProtocolError) as decision_replay:
            self.daemon._dispatch_extension("browser-A", "extension.decide", {
                "taskId": "task-A", "nonce": approval_v2["nonce"],
                "digest": approval_v2["digest"], "approve": True,
            })
        self.assertEqual(decision_replay.exception.code, "approval_stale")
        changed, _ = self.tool("browser_shared_run", {**click_v2, "selector": "#changed"})
        self.assertEqual(changed["bridgeCode"], "request_id_conflict")

    def test_plugin_unload_closes_idle_inherited_fd_server(self):
        self.assertEqual(self.get_task()["sessionBinding"], "ready")
        launch = self.prepare_fd()
        self.assertTrue(launch._thread.is_alive())
        self.unload_plugin()
        self.assertTrue(launch._revoked.is_set(), "unload did not revoke the host binding")
        calls_before = len([p for method, p in self.extension_calls if method == "browser.execute"])
        residual_fd = self.fd_request(launch, {"op": "official.ready_state", "args": []})
        self.assertFalse(residual_fd["ok"])
        # 中文注释：只返回固定文案，不含内部异常原文。
        self.assertIn(residual_fd["error"], {'浏览器操作结果不确定；不要自动重放。', '浏览器操作未执行，可重新读取页面后重试。'})
        self.assertEqual(
            len([p for method, p in self.extension_calls if method == "browser.execute"]),
            calls_before,
            "revoked residual FD dispatched to the extension",
        )
        # 中文注释：回执与线程退出是两个事件，允许有界收尾，但不能永久残留。
        launch._thread.join(timeout=1)
        self.assertFalse(
            launch._thread.is_alive(),
            "plugin unload left the idle inherited-FD server thread/socket alive",
        )

    def test_plugin_unload_closes_channel_without_another_helper_request(self):
        # 中文注释：空闲脚本不再发请求时，卸载也必须主动回收通道。
        self.assertEqual(self.get_task()["sessionBinding"], "ready")
        launch = self.prepare_fd()
        self.unload_plugin()
        launch._thread.join(timeout=1)
        self.assertFalse(launch._thread.is_alive())


if __name__ == "__main__":
    unittest.main(verbosity=2)
