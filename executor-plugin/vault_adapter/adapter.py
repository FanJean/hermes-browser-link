"""Hermes 五个 Vault 工具的模型不可见值适配层。

This module is deliberately not registered as a tool. The trusted host supplies
(1) the Vault source, (2) a native-task binding resolver, and (3) a distinct
private secret-fill port. Secrets are never sent through NativeProfileRuntime,
ordinary browser RPC/FDs, Python-script helpers, subprocess argv, or tool results.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit


TOOLS = frozenset({
    "browser_vault_list",
    "browser_vault_unlock",
    "browser_vault_fill",
    "browser_vault_save_login",
    "browser_vault_enter_code",
})
UNLOCK_BACKENDS = frozenset({"onepassword", "bitwarden"})
LOGIN_FIELDS = {"password": "current-password"}
CONTROL_KEYS = frozenset({
    "index", "type", "name", "label", "autocomplete", "maxLength", "formIndex",
})


@dataclass(frozen=True)
class NativeScope:
    """Host-derived scope; none of these identity fields come from model args."""

    session_id: str
    owner: str
    task_id: str
    instance_id: str
    generation: int
    mode_generation: int
    tab_id: int
    allowed_origins: Tuple[str, ...]
    active_mode: str


class _Refused(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class VaultAdapter:
    """Adapt Vault operations to a separately authorized native private port.

    ``host.resolve_vault_binding(session_id)`` must return the host's currently
    selected owner/task/instance/generation/modeGeneration/tab binding. The
    native runtime and extension are re-read on every call, and the private
    port must be a typed private client whose daemon and extension independently
    re-check that scope while writing. The host constructs
    and injects this adapter; model-controlled names or IDs are rejected.

    Source protocol (all methods run only in the trusted host): ``list()``,
    ``unlock(backend)``, ``get_meta(handle)``, ``resolve(handle, kind)``,
    ``otp(handle)``, ``prompt_code(origin)``, ``prompt_login(origin)``,
    ``save(origin, label, identifier, password)``, ``confirm_payment(label,
    origin)``, and ``register_secret(value)``. The private port exposes
    ``inspect(scope)`` and ``fill(scope, expected_origin=..., nonce=..., document_generation=...,
    fills=...)``. No fallback to ordinary RPC or page scripts is permitted.
    """

    def __init__(self, runtime: Any, host: Any, source: Any, private_port: Any):
        self.runtime = runtime
        self.host = host
        self.source = source
        self.private_port = private_port

    def invoke(self, tool: str, args: Any, *, session_id: str = "") -> str:
        try:
            if tool not in TOOLS:
                raise _Refused("unsupported_tool")
            if not isinstance(args, dict):
                raise _Refused("invalid_arguments")
            self._validate_args(tool, args)
            if tool == "browser_vault_list":
                out = self._list()
            elif tool == "browser_vault_unlock":
                out = self._unlock(args["backend"])
            elif tool == "browser_vault_fill":
                scope = self._scope(session_id)
                handle = args.get("handle")
                if not isinstance(handle, str):
                    raise _Refused("invalid_arguments")
                out = self._fill(scope, handle, self._authorize(scope, 'fill', handle, args.get('request_id')))
            elif tool == "browser_vault_save_login":
                scope = self._scope(session_id)
                label = args.get("label", "")
                if not isinstance(label, str):
                    raise _Refused("invalid_arguments")
                out = self._save_login(scope, label, self._authorize(scope, 'save_login', label, args.get('request_id')))
            else:
                scope = self._scope(session_id)
                handle = args.get("handle", "")
                if not isinstance(handle, str):
                    raise _Refused("invalid_arguments")
                out = self._enter_code(scope, handle, self._authorize(scope, 'enter_code', handle, args.get('request_id')))
        except _Refused as exc:
            out = self._error(exc.code)
        except Exception:
            # Do not stringify/log exceptions here: Vault/backend exceptions can
            # contain secret material. A transport failure after dispatch is
            # handled separately as outcome_unknown in _write_private().
            out = self._error("operation_failed")
        return json.dumps(out, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _validate_args(tool: str, args: Mapping[str, Any]) -> None:
        fields = {
            "browser_vault_list": set(),
            "browser_vault_unlock": {"backend"},
            "browser_vault_fill": {"handle", "request_id"},
            "browser_vault_save_login": {"label", "request_id"},
            "browser_vault_enter_code": {"handle", "request_id"},
        }[tool]
        if set(args) - fields:
            raise _Refused("invalid_arguments")
        if 'request_id' in args and not _valid_text(args['request_id'], 128):
            raise _Refused('invalid_arguments')
        if tool == "browser_vault_unlock":
            if args.get("backend") not in UNLOCK_BACKENDS:
                raise _Refused("invalid_arguments")
        if tool in {"browser_vault_fill", "browser_vault_enter_code"}:
            handle = args.get("handle", "")
            if (tool == "browser_vault_fill" and not _valid_text(handle, 512)
                    or tool == "browser_vault_enter_code" and handle != "" and not _valid_text(handle, 512)):
                raise _Refused("invalid_arguments")
        if tool == "browser_vault_save_login" and not _valid_text(args.get("label", ""), 160, allow_empty=True):
            raise _Refused("invalid_arguments")

    def _list(self) -> dict:
        raw = self.source.list()
        if not isinstance(raw, dict):
            raise _Refused("vault_unavailable")
        out = {"success": raw.get("success") is True, "items": []}
        rows = raw.get("items")
        if not isinstance(rows, list):
            rows = []
        allowed = (
            "handle", "kind", "label", "origin", "allowed_origins", "backend",
            "identifier", "identifier_type", "available", "two_factor",
        )
        for row in rows:
            if not isinstance(row, dict):
                continue
            projected = {key: row[key] for key in allowed if key in row and _safe_metadata(row[key])}
            # 中文注释：当前接管仅支持登录条目；未验收的支付和地址条目不提供可用句柄。
            if (isinstance(projected.get("handle"), str)
                    and projected.get("kind") == "login"):
                out["items"].append(projected)
        locked = raw.get("locked")
        if isinstance(locked, list):
            out["locked"] = [
                {key: row[key] for key in ("backend", "display_name", "unlock")
                 if key in row and _safe_metadata(row[key])}
                for row in locked if isinstance(row, dict)
            ]
        errors = raw.get("errors")
        if isinstance(errors, list):
            out["errors"] = [
                {"backend": row.get("backend", "unknown"), "error": "backend unavailable"}
                for row in errors if isinstance(row, dict)
            ]
        if not out["items"]:
            out["hint"] = "No saved vault items are available."
        return out

    def _unlock(self, backend: str) -> dict:
        result = self.source.unlock(backend)
        if not isinstance(result, dict):
            raise _Refused("unlock_failed")
        out = {"success": result.get("success") is True, "backend": backend}
        if result.get("already_unlocked") is True:
            out["already_unlocked"] = True
        error_type = result.get("error_type")
        if error_type in {"unlock_cancelled", "unlock_failed", "unlock_unavailable"}:
            out["error_type"] = error_type
        if not out["success"] and "error_type" not in out:
            out["error_type"] = "unlock_failed"
        return out

    def _scope(self, session_id: str) -> NativeScope:
        if not isinstance(session_id, str) or not session_id:
            raise _Refused("binding_denied")
        resolver = getattr(self.host, "resolve_vault_binding", None)
        if not callable(resolver):
            raise _Refused("binding_denied")
        binding = resolver(session_id)
        if not isinstance(binding, dict):
            raise _Refused("binding_denied")
        required = ("owner", "task_id", "instance_id", "generation", "mode_generation", "tab_id")
        if any(key not in binding for key in required):
            raise _Refused("binding_denied")
        owner, task_id, instance_id = binding["owner"], binding["task_id"], binding["instance_id"]
        generation, mode_generation, tab_id = (
            binding["generation"], binding["mode_generation"], binding["tab_id"]
        )
        if (not _valid_text(owner, 256) or not _valid_text(task_id, 256)
                or not _valid_text(instance_id, 256) or not _nonnegative_int(generation)
                or not _nonnegative_int(mode_generation) or not _nonnegative_int(tab_id)):
            raise _Refused("binding_denied")
        authority = getattr(getattr(self.runtime, "authority", None), "owner_for_session", None)
        if callable(authority) and authority(session_id) != owner:
            raise _Refused("binding_denied")
        try:
            task = self.runtime.call("shared.get", {"owner": owner, "taskId": task_id})
            browsers = self.runtime.call("browser.list", {})
        except Exception:
            raise _Refused("binding_denied")
        if (not isinstance(task, dict) or task.get("id") != task_id
                or task.get("state") != "ready" or task.get("instanceId") != instance_id
                or not _nonnegative_int(task.get("generation")) or task.get("generation") != generation
                or not _nonnegative_int(task.get("modeGeneration")) or task.get("modeGeneration") != mode_generation
                or not isinstance(task.get("tabIds"), list) or tab_id not in task["tabIds"]
                or not isinstance(task.get("workTabs"), list)
                or (not any(isinstance(row, dict) and row.get("tabId") == tab_id
                            for row in task["workTabs"]) and tab_id not in task.get('adoptedPopupTabIds', []))
                or not isinstance(task.get("allowedOrigins"), list)):
            raise _Refused("binding_denied")
        if task.get('activeMode') not in {'smart', 'full'}:
            raise _Refused('binding_denied')
        if (not isinstance(browsers, list) or not any(
                isinstance(row, dict) and row.get("instanceId") == instance_id
                and row.get("connected") is True for row in browsers)):
            raise _Refused("binding_denied")
        allowed = _canonical_origins(task["allowedOrigins"])
        if not allowed:
            raise _Refused("binding_denied")
        return NativeScope(
            session_id=session_id, owner=owner, task_id=task_id,
            instance_id=instance_id, generation=generation,
            mode_generation=mode_generation, tab_id=tab_id,
            allowed_origins=tuple(allowed),
            active_mode=task['activeMode'],
        )

    def _authorize(self, scope: NativeScope, action: str, value: str, client_request_id: str | None = None) -> dict | None:
        if scope.active_mode == 'full':
            return None
        # 中文注释：智能审批只接收句柄摘要；密码与验证码仍只走私有通道。
        handle_digest = hashlib.sha256(value.encode()).hexdigest()
        request_id = 'vault-' + hashlib.sha256(
            f'{scope.task_id}:{scope.session_id}:{action}:{handle_digest}:{client_request_id or ""}'.encode()).hexdigest()
        try:
            receipt = self.runtime.call('shared.run', {
                'owner': scope.owner, 'taskId': scope.task_id, 'requestId': request_id,
                'action': 'vault.authorize', 'tabId': scope.tab_id,
                'vaultAction': action, 'handleDigest': handle_digest})
        except Exception as exc:
            if getattr(exc, 'code', None) == 'approval_consumed':
                raise _Refused('approval_consumed')
            raise _Refused('approval_unavailable')
        if isinstance(receipt, dict) and receipt.get('status') in {
                'approval_required', 'approved', 'executing', 'denied', 'expired', 'revoked'}:
            code = {'denied': 'approval_denied', 'expired': 'approval_expired',
                    'revoked': 'approval_revoked'}.get(receipt['status'], 'approval_required')
            raise _Refused(code)
        if not isinstance(receipt, dict) or receipt.get('authorized') is not True:
            raise _Refused('approval_unavailable')
        return {'requestId': request_id, 'handleDigest': handle_digest, 'vaultAction': action}

    def _inspect(self, scope: NativeScope) -> dict:
        inspector = getattr(self.private_port, "inspect", None)
        if not callable(inspector):
            raise _Refused("secure_path_unavailable")
        try:
            receipt = inspector(scope)
        except Exception:
            raise _Refused("secure_path_unavailable")
        if not isinstance(receipt, dict):
            raise _Refused("scope_changed")
        # Reject value-bearing or unknown inspection fields, rather than
        # attempting to redact page data after it has crossed the boundary.
        allowed_keys = {
            "taskId", "instanceId", "generation", "modeGeneration", "tabId",
            "origin", "nonce", "documentGeneration", "controls",
        }
        if set(receipt) - allowed_keys:
            raise _Refused("scope_changed")
        if (receipt.get("taskId") != scope.task_id
                or receipt.get("instanceId") != scope.instance_id
                or receipt.get("generation") != scope.generation
                or receipt.get("modeGeneration") != scope.mode_generation
                or receipt.get("tabId") != scope.tab_id
                or not _valid_text(receipt.get("nonce"), 128)
                or not _nonnegative_int(receipt.get("documentGeneration"))):
            raise _Refused("scope_changed")
        origin = _canonical_page_origin(receipt.get("origin"))
        if origin is None or origin not in scope.allowed_origins:
            raise _Refused("origin_mismatch")
        if self._scope(scope.session_id) != scope:
            raise _Refused("binding_denied")
        controls = _controls(receipt.get("controls"))
        return {
            "origin": origin,
            "nonce": receipt["nonce"],
            "document_generation": receipt["documentGeneration"],
            "controls": controls,
        }

    def _prepare_handle(self, handle: str) -> None:
        prepare = getattr(self.source, "ensure_unlocked", None)
        if not callable(prepare):
            return
        try:
            result = prepare(handle)
        except Exception:
            raise _Refused("unlock_failed")
        if not isinstance(result, dict) or result.get("success") is not True:
            code = result.get("error_type") if isinstance(result, dict) else None
            if code in {"unlock_required", "unlock_cancelled", "unlock_unavailable", "unlock_failed"}:
                raise _Refused(code)
            raise _Refused("unlock_failed")

    def _meta(self, handle: str) -> dict:
        try:
            meta = self.source.get_meta(handle)
        except Exception:
            raise _Refused("vault_unavailable")
        if not isinstance(meta, dict) or meta.get("kind") != "login":
            raise _Refused("vault_item_unavailable")
        return meta

    def _allowed_item_origins(self, meta: Mapping[str, Any]) -> Tuple[str, ...]:
        candidates = meta.get("allowed_origins")
        if not isinstance(candidates, (list, tuple)) or not candidates:
            candidates = [meta.get("origin")]
        normalized = _canonical_origins(candidates)
        if not normalized:
            raise _Refused("no_origin")
        return tuple(normalized)

    def _fill(self, scope: NativeScope, handle: str, approval: dict | None = None) -> dict:
        self._prepare_handle(handle)
        meta = self._meta(handle)
        inspected = self._inspect(scope)
        if inspected["origin"] not in self._allowed_item_origins(meta):
            raise _Refused("origin_mismatch")
        kind = meta["kind"]
        target_tokens = _target_tokens(inspected["controls"])
        if not target_tokens:
            raise _Refused("no_fillable_fields")
        try:
            secrets_map = self.source.resolve(handle, kind)
        except Exception:
            raise _Refused("vault_unavailable")
        if not isinstance(secrets_map, dict):
            raise _Refused("vault_unavailable")
        clean = {
            field: value for field, value in secrets_map.items()
            if field in LOGIN_FIELDS and isinstance(value, str) and value
        }
        fills = _make_fills(kind, target_tokens, clean)
        if not fills:
            raise _Refused("no_fillable_fields")
        self._register_values(clean.values())
        self._recheck_before_write(scope, inspected)
        receipt = self._write_private(scope, inspected, fills, approval)
        if receipt.get("refused") == "origin_changed":
            raise _Refused("origin_changed")
        count = receipt.get("filled")
        if type(count) is not int or count < 0 or count > len(fills):
            raise _Refused("outcome_unknown")
        out = {
            "success": count > 0,
            "filled_fields": count,
            "kind": kind,
            "origin": inspected["origin"],
        }
        return out

    def _enter_code(self, scope: NativeScope, handle: str, approval: dict | None = None) -> dict:
        inspected = self._inspect(scope)
        if handle:
            meta = self._meta(handle)
            if meta.get("kind") != "login":
                raise _Refused("vault_item_unavailable")
            if inspected["origin"] not in self._allowed_item_origins(meta):
                raise _Refused("origin_mismatch")
        code_controls = [
            control for control in inspected["controls"]
            if "one-time-code" in control["autocomplete"].lower().split()
        ]
        if not code_controls:
            raise _Refused("no_code_field")
        code = None
        if handle:
            try:
                code = self.source.otp(handle)
            except Exception:
                code = None
        if not isinstance(code, str) or not code:
            prompt = getattr(self.source, "prompt_code", None)
            if not callable(prompt):
                raise _Refused("prompt_unavailable")
            try:
                code = prompt(inspected["origin"])
            except Exception as exc:
                code = None
                if type(exc).__name__ == "VaultPromptUnavailable":
                    raise _Refused("prompt_unavailable")
                raise _Refused("prompt_failed")
            if not isinstance(code, str):
                raise _Refused("code_declined")
        code = code.strip().replace(" ", "").replace("-", "")
        if not code or len(code) > 32:
            raise _Refused("code_declined")
        self._register_values((code,))
        fills = [{"index": code_controls[0]["index"], "token": "one-time-code", "value": code}]
        self._recheck_before_write(scope, inspected)
        receipt = self._write_private(scope, inspected, fills, approval)
        if receipt.get("refused") == "origin_changed":
            raise _Refused("origin_changed")
        count = receipt.get("filled")
        if type(count) is not int or count < 0 or count > 1:
            raise _Refused("outcome_unknown")
        return {
            "success": count == 1,
            "filled_fields": count,
            "origin": inspected["origin"],
        }

    def _save_login(self, scope: NativeScope, label: str, approval: dict | None = None) -> dict:
        inspected = self._inspect(scope)
        if inspected["origin"] not in scope.allowed_origins:
            raise _Refused("origin_mismatch")
        if not any(_is_password_control(control) for control in inspected["controls"]):
            raise _Refused("no_fillable_fields")
        prompt = getattr(self.source, "prompt_login", None)
        save = getattr(self.source, "save", None)
        if not callable(prompt) or not callable(save):
            raise _Refused("prompt_unavailable")
        try:
            answer = prompt(inspected["origin"])
        except Exception as exc:
            if type(exc).__name__ == "VaultPromptUnavailable":
                raise _Refused("prompt_unavailable")
            raise _Refused("prompt_failed")
        if isinstance(answer, dict):
            identifier = answer.get("identifier")
            password = answer.get("password")
        elif isinstance(answer, (tuple, list)) and len(answer) == 2:
            identifier, password = answer
        else:
            raise _Refused("save_declined")
        try:
            identifier_clean = identifier.strip() if isinstance(identifier, str) else ""
            if (not identifier_clean or len(identifier_clean) > 512
                    or not isinstance(password, str) or not password):
                raise _Refused("save_declined")
            id_type = "email" if "@" in identifier_clean else (
                "phone" if identifier_clean.lstrip("+").isdigit() else "username"
            )
            self._register_values((password,))
            handle = save(inspected["origin"], label.strip() or _host_label(inspected["origin"]),
                          identifier_clean, password)
            if not _valid_text(handle, 512):
                raise _Refused("save_failed")
        except _Refused:
            raise
        except Exception:
            raise _Refused("save_failed")
        finally:
            if isinstance(answer, dict):
                answer.clear()
        # Match the official save-login path: resolve the just-saved item again
        # by opaque handle, then use the same private native fill route.
        filled = self._fill(scope, handle, approval)
        return {
            "success": filled.get("success") is True,
            "handle": handle,
            "origin": inspected["origin"],
            "identifier": identifier_clean,
            "identifier_type": id_type,
        }

    def _register_values(self, values: Iterable[str]) -> None:
        register = getattr(self.source, "register_secret", None)
        if not callable(register):
            raise _Refused("secure_path_unavailable")
        try:
            for value in values:
                if value:
                    register(value)
        except Exception:
            raise _Refused("secure_path_unavailable")

    def _recheck_before_write(self, scope: NativeScope, previous: dict) -> None:
        # 中文注释：填写前重新核对宿主绑定；文档与来源由私有端口及扩展在派发前再次核对。
        current_scope = self._scope(scope.session_id)
        if current_scope != scope:
            raise _Refused("scope_changed")

    def _write_private(self, scope: NativeScope, inspected: dict, fills: list, approval: dict | None = None) -> dict:
        writer = getattr(self.private_port, "fill", None)
        if not callable(writer):
            raise _Refused("secure_path_unavailable")
        try:
            receipt = writer(scope, expected_origin=inspected["origin"], nonce=inspected["nonce"],
                             document_generation=inspected["document_generation"], fills=fills,
                             **({'approval': approval} if approval is not None else {}))
        except Exception:
            # The write may already have reached the native extension. Never
            # expose the exception text and never replay an uncertain write.
            raise _Refused("outcome_unknown")
        if not isinstance(receipt, dict) or set(receipt) - {"filled", "refused"}:
            raise _Refused("outcome_unknown")
        if "refused" in receipt:
            if receipt["refused"] == "origin_changed":
                raise _Refused("origin_changed")
            if receipt["refused"] == "inspection_stale":
                raise _Refused("scope_changed")
            raise _Refused("outcome_unknown")
        return receipt

    @staticmethod
    def _error(code: str) -> dict:
        return {"success": False, "error_type": code}


def _target_tokens(controls: Sequence[dict]) -> dict:
    tokens = {}
    for control in controls:
        if _is_password_control(control):
            tokens.setdefault("current-password", control["index"])
    return tokens


def _make_fills(kind: str, targets: Mapping[str, int], values: Mapping[str, str]) -> list:
    # 中文注释：首版只把登录密码交给固定字段类型的私有填写动作。
    password = values.get("password")
    if kind != "login" or "current-password" not in targets or not isinstance(password, str) or not password:
        return []
    return [{"index": targets["current-password"], "token": "current-password", "value": password}]


def _is_password_control(control: Mapping[str, Any]) -> bool:
    autocomplete = control["autocomplete"].lower().split()
    return "new-password" not in autocomplete and "one-time-code" not in autocomplete and (
        control["type"].lower() == "password"
    )


def _controls(raw: Any) -> list:
    if not isinstance(raw, list) or len(raw) > 500:
        raise _Refused("scope_changed")
    out = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) - CONTROL_KEYS:
            raise _Refused("scope_changed")
        index = item.get("index")
        if not _nonnegative_int(index) or index in seen:
            raise _Refused("scope_changed")
        seen.add(index)
        clean = {"index": index}
        for key in ("type", "name", "label", "autocomplete"):
            value = item.get(key, "")
            if not isinstance(value, str) or len(value) > 4096:
                raise _Refused("scope_changed")
            clean[key] = value
        for key in ("maxLength", "formIndex"):
            if key in item and item[key] is not None:
                if not _nonnegative_int(item[key]):
                    raise _Refused("scope_changed")
                clean[key] = item[key]
        out.append(clean)
    return out


def _canonical_origins(values: Iterable[Any]) -> list:
    out = []
    for value in values:
        normalized = _canonical_url_origin(value)
        if normalized is None:
            return []
        if normalized not in out:
            out.append(normalized)
    return out


def _canonical_page_origin(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = _canonical_url_origin(value)
    if normalized != value:
        return None
    return normalized


def _canonical_url_origin(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value or "*" in value:
        return None
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return None
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        port = parsed.port
    except (ValueError, UnicodeError):
        return None
    if ":" in host and not host.startswith("["):
        host = "[" + host + "]"
    default_port = 80 if scheme == "http" else 443
    port_suffix = "" if port is None or port == default_port else ":%d" % port
    return "%s://%s%s" % (scheme, host, port_suffix)


def _host_label(origin: str) -> str:
    try:
        return urlsplit(origin).hostname or "site"
    except Exception:
        return "site"


def _valid_text(value: Any, limit: int, allow_empty: bool = False) -> bool:
    return isinstance(value, str) and len(value) <= limit and (allow_empty or bool(value.strip()))


def _nonnegative_int(value: Any) -> bool:
    return type(value) is int and value >= 0


def _safe_metadata(value: Any) -> bool:
    if value is None or isinstance(value, (str, int, bool)):
        return not isinstance(value, str) or len(value) <= 4096
    if isinstance(value, (list, tuple)):
        return len(value) <= 32 and all(_safe_metadata(item) for item in value)
    return False
