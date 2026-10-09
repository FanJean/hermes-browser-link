"""官方 Vault 工具与任务绑定的私有本机传输。

This module is imported only by the trusted host plugin. Secret-bearing values
are sent solely via NativeProfileRuntime.vault_private_call over vault.sock;
this module never uses the normal bridge RPC or page-script APIs.
"""
from __future__ import annotations

import importlib.util
import importlib
import inspect
import json
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def _load(path: Path, prefix: str):
    name = prefix + str(abs(hash(str(path.resolve()))))
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Vault integration unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module

_adapter_module = _load(ROOT / "adapter.py", "hermes_native_vault_adapter_")
_source_module = _load(ROOT / "official_source.py", "hermes_native_vault_source_")
VaultAdapter = _adapter_module.VaultAdapter
OfficialVaultSource = _source_module.OfficialVaultSource

VAULT_TOOL_NAMES = (
    "browser_vault_list", "browser_vault_unlock", "browser_vault_fill",
    "browser_vault_save_login", "browser_vault_enter_code",
)

def _obj(properties=None, required=()):
    return {"type": "object", "properties": properties or {},
            "required": list(required), "additionalProperties": False}

VAULT_TOOL_SCHEMAS = {
    "browser_vault_list": {
        "description": "List saved vault items as safe metadata only. Secret values are never returned.",
        "parameters": _obj(),
    },
    "browser_vault_unlock": {
        "description": "Ask the user to unlock a password manager through its masked official UI; the master password never enters the conversation.",
        "parameters": _obj({"backend": {"type": "string", "enum": ["onepassword", "bitwarden"]}}, ("backend",)),
    },
    "browser_vault_fill": {
        "description": "从已有 Vault 句柄经私有通道填写当前任务工作页的登录密码；连接授权不替代 Vault 解锁及来源校验，再次独立填写需新 request_id。支付卡和地址暂不支持。结果未知时不得重试。",
        "parameters": _obj({"handle": {"type": "string", "minLength": 1, "maxLength": 512},
                            "request_id": {"type": "string", "minLength": 1, "maxLength": 128}}, ("handle",)),
    },
    "browser_vault_save_login": {
        "description": "Ask the user through the official masked UI to save a login, then fill through the private native channel. Connection authorization does not replace the official masked user prompt or origin checks; use a new request_id for another save. Never accept credentials through chat.",
        "parameters": _obj({"label": {"type": "string", "maxLength": 160},
                            "request_id": {"type": "string", "minLength": 1, "maxLength": 128}}),
    },
    "browser_vault_enter_code": {
        "description": "Enter a saved or user-provided one-time code through the official masked UI and private native channel; the code never enters the conversation. Connection authorization does not replace the official masked code prompt or origin checks; use a new request_id for another fill.",
        "parameters": _obj({"handle": {"type": "string", "maxLength": 512},
                            "request_id": {"type": "string", "minLength": 1, "maxLength": 128}}),
    },
}


def _valid_task(runtime, owner: str, task_id: str) -> dict:
    task = runtime.call("shared.get", {"owner": owner, "taskId": task_id})
    browsers = runtime.call("browser.list", {})
    if (not isinstance(task, dict) or task.get("id") != task_id
            or task.get("state") != "ready"
            or not isinstance(task.get("instanceId"), str)
            or type(task.get("generation")) is not int or task["generation"] < 1
            or type(task.get("modeGeneration")) is not int or task["modeGeneration"] < 1
            or not isinstance(task.get("tabIds"), list)
            or not isinstance(task.get("workTabs"), list)
            or not isinstance(task.get("allowedOrigins"), list)
            or not task["allowedOrigins"]):
        raise ValueError("Vault task scope denied")
    if not isinstance(browsers, list) or not any(
            isinstance(row, dict) and row.get("instanceId") == task["instanceId"]
            and row.get("connected") is True for row in browsers):
        raise ValueError("Vault browser disconnected")
    seen = set()
    for row in task["workTabs"]:
        if (not isinstance(row, dict) or type(row.get("tabId")) is not int
                or row["tabId"] < 0 or row["tabId"] in seen
                or row["tabId"] not in task["tabIds"]):
            raise ValueError("Vault work-tab scope denied")
        seen.add(row["tabId"])
    return task


class NativeVaultPrivatePort:
    """Fixed typed operations over the separate authenticated vault.sock."""
    def __init__(self, profile_runtime):
        self._runtime = profile_runtime

    @staticmethod
    def _scope(scope):
        return {
            "sessionId": scope.session_id,
            "owner": scope.owner,
            "taskId": scope.task_id,
            "instanceId": scope.instance_id,
            "generation": scope.generation,
            "modeGeneration": scope.mode_generation,
            "tabId": scope.tab_id,
            "allowedOrigins": list(scope.allowed_origins),
        }

    def _call(self, operation, params):
        call = getattr(self._runtime, "vault_private_call", None)
        if not callable(call):
            raise RuntimeError("private Vault port unavailable")
        return call(operation, params)

    def inspect(self, scope):
        return self._call("inspect", {"scope": self._scope(scope)})

    def fill(self, scope, *, expected_origin, nonce, document_generation, fills, approval=None):
        # 中文注释：当前私有端口只开放登录密码与一次性验证码，拒绝混合字段。
        tokens = {row.get("token") for row in fills}
        if tokens not in ({"current-password"}, {"one-time-code"}):
            raise RuntimeError("Vault field kind unavailable")
        # 中文注释：智能审批资格随私有填充请求传递，秘密值仍不进入普通桥接协议。
        return self._call("fill", {
            "scope": self._scope(scope), "expectedOrigin": expected_origin,
            "nonce": nonce, "documentGeneration": document_generation,
            "kind": "otp" if tokens == {"one-time-code"} else "login",
            "fills": fills, **({'approval': approval} if approval is not None else {}),
        })

    def revoke_binding(self, session_id, owner, task_id):
        try:
            return self._call("revoke", {
                "sessionId": session_id, "owner": owner, "taskId": task_id,
            })
        except Exception:
            return None


class VaultBindingRegistry:
    """Only a current daemon workTab may become the host Vault target."""
    def __init__(self, runtime, private_port):
        self.runtime = runtime
        self.private_port = private_port
        self._guard = threading.RLock()
        self._bindings = {}
        self._task_bindings = {}

    def _owner(self, session_id):
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("Vault session unavailable")
        owner_for_session = getattr(getattr(self.runtime, "authority", None), "owner_for_session", None)
        if not callable(owner_for_session):
            raise ValueError("Vault authority unavailable")
        return owner_for_session(session_id)

    def claims(self, session_id):
        # 中文注释：已绑定任务但尚无工作页时仍接管工具调用，避免落回 Hermes 的另一浏览器。
        with self._guard:
            return session_id in self._bindings

    def bind(self, session_id, *, owner, task_id, tab_id=None):
        if owner != self._owner(session_id):
            raise ValueError("Vault owner mismatch")
        task = _valid_task(self.runtime, owner, task_id)
        rows = task['workTabs']
        eligible = [row['tabId'] for row in rows] + task.get('adoptedPopupTabIds', [])
        if tab_id is not None and (type(tab_id) is not int or tab_id not in task['tabIds']
                or tab_id not in eligible):
            raise ValueError('Vault target is not a daemon workTab')
        with self._guard:
            # 中文注释：只共享任务/页选择元信息；切页时撤销旧私有 nonce，不复用凭据检查。
            previous = self._task_bindings.get(session_id, {}).get(task_id)
            selected = tab_id
            explicit = tab_id is not None
            if previous and selected is None and previous.get('explicit_tab') and (
                    previous['generation'], previous['mode_generation']) == (task['generation'], task['modeGeneration']):
                if previous.get('tab_id') in eligible:
                    selected, explicit = previous['tab_id'], True
            if selected is None and len(rows) == 1:
                selected = rows[0]['tabId']
            saved = {'owner': owner, 'task_id': task_id, 'instance_id': task['instanceId'],
                     'generation': task['generation'], 'mode_generation': task['modeGeneration'],
                     'tab_id': selected, 'explicit_tab': explicit}
            self._task_bindings.setdefault(session_id, {})[task_id] = saved
            current = self._bindings.get(session_id)
            if explicit or current is None or current['task_id'] == task_id:
                if current and (current['task_id'], current['tab_id']) != (task_id, selected):
                    self.private_port.revoke_binding(session_id, owner, current['task_id'])
                self._bindings[session_id] = saved
        return selected is not None

    def select_tab(self, session_id, *, owner, task_id, tab_id):
        _valid_task(self.runtime, owner, task_id)
        self.bind(session_id, owner=owner, task_id=task_id, tab_id=tab_id)
        return True

    def resolve_vault_binding(self, session_id):
        owner = self._owner(session_id)
        with self._guard:
            saved = self._bindings.get(session_id)
            saved = dict(saved) if saved else None
        if not saved or saved["owner"] != owner:
            return None
        try:
            task = _valid_task(self.runtime, owner, saved["task_id"])
        except Exception:
            return None
        if (saved["instance_id"] != task["instanceId"]
                or saved["generation"] != task["generation"]):
            return None
        if saved["mode_generation"] != task["modeGeneration"]:
            # 中文注释：模式切换后重新从 daemon 读取代次，不沿用旧私有检查 nonce。
            saved["mode_generation"] = task["modeGeneration"]
            with self._guard:
                if self._bindings.get(session_id, {}).get("task_id") == saved["task_id"]:
                    self._bindings[session_id] = dict(saved)
        work_tabs = task["workTabs"]
        tab_id = saved.get("tab_id")
        if not saved.get("explicit_tab") and len(work_tabs) != 1:
            return None
        if tab_id is None and len(work_tabs) == 1:
            tab_id = work_tabs[0]["tabId"]
        if (type(tab_id) is not int or tab_id not in task["tabIds"]
                or (not any(row["tabId"] == tab_id for row in work_tabs) and tab_id not in task.get('adoptedPopupTabIds', []))):
            return None
        return {
            "owner": owner, "task_id": task["id"], "instance_id": task["instanceId"],
            "generation": task["generation"], "mode_generation": task["modeGeneration"],
            "tab_id": tab_id,
        }

    def unbind(self, session_id, task_id=None):
        with self._guard:
            tasks = self._task_bindings.get(session_id, {})
            selected = [task_id] if task_id else list(tasks)
            for key in selected:
                binding = tasks.pop(key, None)
                if binding:
                    self.private_port.revoke_binding(session_id, binding['owner'], key)
            current = self._bindings.get(session_id)
            if current and current['task_id'] in selected:
                self._bindings.pop(session_id, None)
                if tasks:
                    self._bindings[session_id] = next(reversed(tasks.values()))

    def close(self):
        with self._guard:
            sessions = list(self._task_bindings)
        for session_id in sessions:
            self.unbind(session_id)


def make_vault_tool_handler(tool_name, profile_runtime, adapter, owner_lease_arg):
    if tool_name not in VAULT_TOOL_SCHEMAS:
        raise ValueError("unknown Vault tool")
    def handler(args, *, session_id=None, **_):
        try:
            profile_runtime.authority.consume(tool_name, args, session_id=session_id)
        except Exception:
            return json.dumps({"success": False, "error_type": "binding_denied"}, separators=(",", ":"))
        public_args = {key: value for key, value in args.items() if key != owner_lease_arg}
        return adapter.invoke(tool_name, public_args, session_id=session_id or "")
    return handler


def create_vault_integration(profile_runtime, *, source=None, private_port=None, bindings=None):
    port = private_port or NativeVaultPrivatePort(profile_runtime)
    registry = bindings or VaultBindingRegistry(profile_runtime, port)
    vault_source = source or OfficialVaultSource()
    adapter = VaultAdapter(profile_runtime, registry, vault_source, port)
    return registry, adapter


def register_vault_overrides(ctx, profile_runtime, bindings, adapter, *, lease_arg, lease_error):
    """只在操作者启用时覆盖官方名称；未绑定会话继续调用官方原实现。"""
    if not ctx.has_capability("tools.override"):
        raise PermissionError("Vault override requires tools.override")
    from tools.registry import registry
    importlib.import_module("tools.browser_vault_tool")
    profile_runtime.authority.lease_tools(VAULT_TOOL_NAMES, passthrough=True)
    registered = []

    def accepted(handler, values):
        parameters = inspect.signature(handler).parameters
        if any(item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values()):
            return values
        return {key: value for key, value in values.items() if key in parameters}

    for name in VAULT_TOOL_NAMES:
        original = registry.get_entry(name)
        if original is None or original.is_async:
            raise RuntimeError("official Vault tool unavailable")
        schema = VAULT_TOOL_SCHEMAS[name]

        def handler(args, *, session_id=None, _name=name, _original=original, **context):
            public = {key: value for key, value in args.items() if key != lease_arg} if isinstance(args, dict) else args
            lease = None
            if isinstance(args, dict) and lease_arg in args:
                try:
                    lease = profile_runtime.authority.consume(_name, args, session_id=session_id)
                except lease_error:
                    return json.dumps({"success": False, "error_type": "binding_denied"}, separators=(",", ":"))
            if bindings.claims(session_id):
                if lease is None:
                    return json.dumps({"success": False, "error_type": "binding_denied"}, separators=(",", ":"))
                return adapter.invoke(_name, public, session_id=session_id or "")
            # 中文注释：未绑定本插件任务的会话保留 Hermes 官方 Vault 行为。
            return _original.handler(public, **accepted(_original.handler, {"session_id": session_id, **context}))

        ctx.register_tool(name=name, toolset="browser-link", schema=schema,
                          handler=handler, description=schema["description"], emoji="🔐", override=True)
        registered.append(name)
    ctx.on_unload(bindings.close)
    return tuple(registered)
