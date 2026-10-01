"""Host-owned registration of the single-tool adapter via Hermes' public tool override API."""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import sys
import threading
from pathlib import Path
from typing import Any


def _adapter_class():
    try:
        from .adapter import SingleToolAdapter
        return SingleToolAdapter
    except ImportError:
        path = Path(__file__).with_name("adapter.py").resolve()
        name = "hermes_browser_single_tool_adapter_" + hashlib.sha256(
            str(path).encode("utf-8")
        ).hexdigest()[:16]
        module = sys.modules.get(name)
        if module is None:
            spec = importlib.util.spec_from_file_location(name, path)
            if spec is None or spec.loader is None:
                raise RuntimeError("native single-tool adapter could not be loaded")
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                spec.loader.exec_module(module)
            except Exception:
                sys.modules.pop(name, None)
                raise
        return module.SingleToolAdapter


class _NativeHostAdapter:
    """中文注释：保存会话的多个任务，并维护官方工具的当前绑定指针。"""

    def __init__(self, adapter):
        self.adapter = adapter
        self._guard = threading.RLock()
        self._bindings: dict[str, tuple[str, str, int]] = {}
        self._task_bindings = {}
        self._uninstaller = None

    def claims(self, session_id, action=None):
        return self.adapter.claims(session_id, action)

    def available(self, action, *, session_id=None, **identity):
        return self.adapter.available(action, session_id=session_id, **identity)

    def dispatch(self, action, args, **identity):
        return self.adapter.dispatch(action, args, **identity)

    def bind(self, session_id, task_id=None, *, owner=None, tab_id=None):
        # 中文注释：适配器自行验证 owner、任务代次和工作页租约。
        with self._guard:
            receipt = self.adapter.bind(session_id, task_id, owner=owner, tab_id=tab_id)
            current = (owner, task_id, receipt['generation'])
            if tab_id is not None or session_id not in self._bindings:
                self._bindings[session_id] = current
            self._task_bindings.setdefault(session_id, {})[task_id] = current
            return receipt

    def unbind(self, session_id, *, task_id=None):
        with self._guard:
            tasks = self._task_bindings.get(session_id, {})
            selected = [task_id] if task_id else list(tasks)
            for key in selected:
                current = tasks.pop(key, None)
                if current:
                    self.adapter.unbind(session_id, task_id=key, generation=current[2])
            current = self._bindings.get(session_id)
            if current and current[1] in selected:
                self._bindings.pop(session_id, None)
                if tasks:
                    self._bindings[session_id] = next(reversed(tasks.values()))
            return bool(selected)

    def has_bindings(self):
        return self.adapter.has_bindings()

    def close(self):
        self.adapter.close()
        with self._guard:
            self._bindings.clear()
            self._task_bindings.clear()

    def set_uninstaller(self, uninstall):
        self._uninstaller = uninstall

    def unregister(self):
        uninstall, self._uninstaller = self._uninstaller, None
        try:
            if callable(uninstall):
                uninstall()
        finally:
            self.close()


class HostBindingCoordinator:
    """Compose script and single-tool bindings for native task lifecycle hooks."""

    def __init__(self, *bridges):
        self.bridges = tuple(bridge for bridge in bridges if bridge is not None)
        if not self.bridges:
            raise ValueError("at least one host binding bridge is required")
        self._guard = threading.RLock()
        self._bindings: dict[str, tuple[str, str]] = {}
        self._task_bindings = {}

    def bind(self, session_id, *, owner, task_id, tab_id=None):
        # 中文注释：新增任务不撤销旧任务；只有完整绑定后才更新当前指针。
        with self._guard:
            completed = []
            try:
                for bridge in self.bridges:
                    receipt = bridge.bind(session_id, owner=owner, task_id=task_id, **({'tab_id': tab_id} if tab_id is not None else {}))
                    completed.append(bridge)
                if tab_id is not None or session_id not in self._bindings:
                    self._bindings[session_id] = (owner, task_id)
                self._task_bindings.setdefault(session_id, {})[task_id] = (owner, task_id)
                return receipt
            except Exception:
                if task_id not in self._task_bindings.get(session_id, {}):
                    for bridge in reversed(completed):
                        bridge.unbind(session_id, task_id=task_id)
                raise

    def use_tab(self, session_id, *, owner, tab_id):
        with self._guard:
            matches = []
            for bound_owner, task_id in self._task_bindings.get(session_id, {}).values():
                if owner != bound_owner:
                    continue
                runtime = next(bridge.runtime if hasattr(bridge, 'runtime') else bridge.adapter.runtime for bridge in self.bridges)
                task = runtime.call('shared.get', {'owner': owner, 'taskId': task_id})
                owned = [row.get('tabId') for row in task.get('workTabs', []) if isinstance(row, dict)]
                if tab_id in owned:
                    matches.append(task_id)
            if len(matches) != 1:
                raise RuntimeError('tab is missing or ambiguous across bound tasks')
            return self.bind(session_id, owner=owner, task_id=matches[0], tab_id=tab_id)

    def unbind(self, session_id, *, task_id=None):
        with self._guard:
            tasks = self._task_bindings.get(session_id, {})
            selected = [task_id] if task_id else list(tasks)
            for key in selected:
                tasks.pop(key, None)
                for bridge in reversed(self.bridges):
                    bridge.unbind(session_id, task_id=key)
            current = self._bindings.get(session_id)
            if current and current[1] in selected:
                self._bindings.pop(session_id, None)
                if tasks:
                    self._bindings[session_id] = next(reversed(tasks.values()))
            return bool(selected)

    def has_bindings(self):
        with self._guard:
            return bool(self._bindings)


def _adapter_module():
    return sys.modules[_adapter_class().__module__]


def _accepted_kwargs(handler, kwargs):
    """Mirror Hermes' plugin contract: pass only context kwargs the handler declares."""
    try:
        parameters = inspect.signature(handler).parameters
    except (TypeError, ValueError):
        return kwargs
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return kwargs
    kinds = {inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY}
    return {k: v for k, v in kwargs.items() if k in parameters and parameters[k].kind in kinds}


def _navigate_preflight(url):
    """Apply Hermes' own public URL safety policy (secret-bearing and blocked
    addresses) before a bound navigation, as the built-in handler would.
    Fails closed when the policy cannot be loaded."""
    try:
        from tools.browser_tool import evaluate_url_safety
    except Exception:
        return json.dumps({"success": False, "error": "Hermes URL safety policy unavailable; navigation refused.",
                           "code": "url_policy_unavailable", "retryable": False, "outcome_unknown": False},
                          ensure_ascii=False)
    error = evaluate_url_safety(url) if isinstance(url, str) else None
    return json.dumps(error, ensure_ascii=False) if error is not None else None


def _make_override(name, original, host, authority, lease_arg, lease_error, error_json):
    def handler(args, *, session_id=None, **context):
        public = args
        lease = None
        if isinstance(args, dict) and lease_arg in args:
            public = {key: value for key, value in args.items() if key != lease_arg}
            try:
                lease = authority.consume(name, args, session_id=session_id)
            except lease_error:
                return error_json("session_identity_required")
        if host.claims(session_id, name):
            # A bound session is authoritative: never fall back to another browser.
            if lease is None:
                return error_json("tool_call_identity_required")
            if name == "browser_navigate" and isinstance(public, dict):
                blocked = _navigate_preflight(public.get("url"))
                if blocked is not None:
                    return blocked
            return host.dispatch(name, public, session_id=session_id, tool_call_id=lease.tool_call_id)
        # Not bound to a native task: Hermes' own built-in behavior, unchanged.
        return original.handler(public, **_accepted_kwargs(original.handler, {"session_id": session_id, **context}))
    return handler


def register_official_overrides(ctx: Any, runtime: Any, *, lease_arg: str, lease_error: type,
                                registry: Any = None):
    """Take over Hermes' official browser tools through the public plugin API.

    Uses ``ctx.register_tool(..., override=True)``, which Hermes only allows
    after the operator grants this plugin ``tools.override``. No Hermes source
    is patched. Sessions that the host bound to a ready native task are
    served by the adapter; every other session keeps the original built-in
    handler, so users who never bind a task see no behavior change.
    Returns ``(host_adapter, overridden_names)``.
    """
    if not callable(getattr(ctx, "on_unload", None)):
        raise RuntimeError("Hermes plugin lifecycle does not expose on_unload")
    if registry is None:
        from tools.registry import registry
        # Plugins may load before Hermes imports its browser tools. Importing
        # these public modules registers the originals (a no-op if already
        # imported), so takeover never depends on load order.
        for module_name in ("tools.browser_tool", "tools.browser_cdp_tool", "tools.browser_dialog_tool"):
            try:
                importlib.import_module(module_name)
            except Exception:
                pass
    module = _adapter_module()
    adapter = module.SingleToolAdapter(runtime, strict_unbound=False)
    host = _NativeHostAdapter(adapter)
    authority = runtime.authority

    def error_json(code):
        return adapter._error(code)

    overridden = []
    try:
        for name in sorted(module.OFFICIAL_BROWSER_TOOLS):
            original = registry.get_entry(name)
            if original is None:
                continue  # not present in this Hermes version
            if original.is_async:
                continue  # keep the contract simple: built-in browser tools are synchronous
            original_check = original.check_fn

            def check_fn(original_check=original_check):
                if host.has_bindings():
                    return True
                return True if original_check is None else original_check()

            ctx.register_tool(
                name=name, toolset=original.toolset, schema=original.schema,
                handler=_make_override(name, original, host, authority, lease_arg, lease_error, error_json),
                check_fn=check_fn, requires_env=list(original.requires_env or []),
                description=original.description, emoji=original.emoji, override=True,
            )
            overridden.append(name)
        authority.lease_tools(overridden, passthrough=True)
        ctx.on_unload(host.close)
    except Exception:
        host.close()
        raise
    return host, tuple(overridden)

