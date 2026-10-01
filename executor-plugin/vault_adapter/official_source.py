"""按需调用 Hermes 官方 Vault 后端和遮盖输入界面。

Construction/import does not load a vault, prompt, or register tools. Methods are
called only after a host invokes the adapter with a trusted session identity.
"""
from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import urlsplit


class VaultPromptUnavailable(RuntimeError):
    """The current surface cannot present the requested masked prompt."""


class OfficialVaultSource:
    """Adapt the official ``agent.vault_backends`` interfaces to VaultAdapter."""

    def __init__(self, *, dependencies: Optional[dict] = None):
        self._dependencies = dependencies

    def _deps(self) -> dict:
        if self._dependencies is None:
            from agent.vault_backends import backend_for_handle, enabled_backends
            from agent.vault_backends.unlock import (
                can_prompt_here,
                get_code_prompt_callback,
                get_save_login_prompt_callback,
                get_unlock_prompt_callback,
            )
            from agent.vault_store import get_vault_store
            from agent.redact import register_vault_redaction_value
            from tools.approval_prompt import request_elicitation_consent
            self._dependencies = {
                "backend_for_handle": backend_for_handle,
                "enabled_backends": enabled_backends,
                "can_prompt_here": can_prompt_here,
                "get_code_prompt_callback": get_code_prompt_callback,
                "get_save_login_prompt_callback": get_save_login_prompt_callback,
                "get_unlock_prompt_callback": get_unlock_prompt_callback,
                "get_vault_store": get_vault_store,
                "register_vault_redaction_value": register_vault_redaction_value,
                "request_elicitation_consent": request_elicitation_consent,
            }
        return self._dependencies

    def list(self) -> dict:
        deps = self._deps()
        items, locked, errors = [], [], []
        for backend in deps["enabled_backends"]():
            if backend.needs_unlock and not backend.is_unlocked():
                locked.append({
                    "backend": backend.name,
                    "display_name": backend.display_name,
                    "unlock": "browser_vault_unlock" if deps["can_prompt_here"]()
                              else "unavailable_in_this_session",
                })
                continue
            try:
                metas = backend.list_items()
            except Exception:
                errors.append({"backend": backend.name})
                continue
            for meta in metas:
                row = _meta_dict(meta)
                allowed = row.get("allowed_origins") or []
                item = {
                    "handle": row.get("handle"),
                    "kind": row.get("kind"),
                    "label": row.get("label", ""),
                    "origin": row.get("origin"),
                    "backend": backend.name,
                    "available": row.get("kind") == "login" or bool(row.get("origin")),
                }
                if len(allowed) > 1:
                    item["allowed_origins"] = allowed
                if row.get("has_otp") or backend.needs_unlock:
                    item["two_factor"] = (
                        "automatic" if row.get("has_otp")
                        else "automatic if the manager stores a TOTP seed, otherwise user prompted"
                    )
                if row.get("identifier") is not None:
                    item["identifier"] = row["identifier"]
                    item["identifier_type"] = row.get("identifier_type")
                items.append(item)
        result = {"success": True, "items": items}
        if locked:
            result["locked"] = locked
        if errors:
            result["errors"] = errors
        return result

    def unlock(self, backend_name: str) -> dict:
        deps = self._deps()
        backend = next((item for item in deps["enabled_backends"]()
                        if item.name == backend_name and item.needs_unlock), None)
        if backend is None:
            return {"success": False, "error_type": "unlock_failed"}
        if backend.is_unlocked():
            return {"success": True, "backend": backend.name, "already_unlocked": True}
        if not deps["can_prompt_here"]():
            return {"success": False, "error_type": "unlock_unavailable"}
        prompt = deps["get_unlock_prompt_callback"]()
        master = prompt(backend.name, backend.display_name) if prompt else ""
        if not master:
            return {"success": False, "error_type": "unlock_cancelled"}
        try:
            backend.unlock(master)
        except Exception:
            return {"success": False, "error_type": "unlock_failed"}
        finally:
            del master
        return {"success": True, "backend": backend.name}

    def ensure_unlocked(self, handle: str) -> dict:
        backend = self._deps()["backend_for_handle"](handle)
        if backend is None:
            return {"success": False, "error_type": "unlock_required"}
        if not backend.needs_unlock or backend.is_unlocked():
            return {"success": True, "backend": backend.name}
        return self.unlock(backend.name)

    def get_meta(self, handle: str) -> Optional[dict]:
        backend = self._deps()["backend_for_handle"](handle)
        if backend is None:
            return None
        meta = backend.get_meta(handle)
        return _meta_dict(meta) if meta is not None else None

    def resolve(self, handle: str, kind: str) -> dict:
        backend = self._deps()["backend_for_handle"](handle)
        if backend is None:
            raise ValueError("vault item unavailable")
        meta = backend.get_meta(handle)
        if meta is None or _meta_dict(meta).get("kind") != kind:
            raise ValueError("vault item unavailable")
        if kind == "login":
            return {"password": backend.resolve_password(handle)}
        if kind in {"payment", "address"}:
            return backend.resolve_secret(handle)
        raise ValueError("vault item unavailable")

    def otp(self, handle: str) -> Optional[str]:
        backend = self._deps()["backend_for_handle"](handle)
        if backend is None:
            return None
        meta = backend.get_meta(handle)
        if meta is None or _meta_dict(meta).get("kind") != "login":
            return None
        return backend.resolve_otp(handle)

    def prompt_code(self, origin: str) -> Optional[str]:
        deps = self._deps()
        if not deps["can_prompt_here"]():
            raise VaultPromptUnavailable("masked prompt unavailable")
        prompt = deps["get_code_prompt_callback"]()
        if prompt is None:
            raise VaultPromptUnavailable("masked prompt unavailable")
        site = _host(origin)
        return prompt(site, "")

    def prompt_login(self, origin: str) -> Optional[dict]:
        deps = self._deps()
        if not deps["can_prompt_here"]():
            raise VaultPromptUnavailable("masked prompt unavailable")
        prompt = deps["get_save_login_prompt_callback"]()
        if prompt is None:
            raise VaultPromptUnavailable("masked prompt unavailable")
        site = _host(origin)
        answer = prompt(origin, site)
        return answer if isinstance(answer, dict) else None

    def save(self, origin: str, label: str, identifier: str, password: str) -> str:
        id_type = "email" if "@" in identifier else (
            "phone" if identifier.lstrip("+").isdigit() else "username"
        )
        meta = self._deps()["get_vault_store"]().add_item(
            "login", label,
            {"identifier_type": id_type, "identifier": identifier, "password": password},
            origin=origin,
        )
        return str(meta.id)

    def confirm_payment(self, label: str, origin: str) -> bool:
        consent = self._deps()["request_elicitation_consent"](
            "Fill payment card '%s' on %s" % (label, origin),
            "The agent wants to enter your saved card details into this checkout page. "
            "The card number and CVC never enter the conversation. Approve only if you intend to pay here.",
            surface="vault-payment", title="Confirm payment card fill?",
        )
        return consent == "accept"

    def register_secret(self, value: str) -> None:
        self._deps()["register_vault_redaction_value"](value)


def _meta_dict(meta: Any) -> dict:
    if meta is None:
        return {}
    if hasattr(meta, "to_dict") and callable(meta.to_dict):
        raw = meta.to_dict()
    elif isinstance(meta, dict):
        raw = dict(meta)
    else:
        raw = {
            key: getattr(meta, key)
            for key in (
                "id", "kind", "label", "origin", "created_at", "identifier",
                "identifier_type", "has_otp", "allowed_origins",
            )
            if hasattr(meta, key)
        }
    if not isinstance(raw, dict):
        return {}
    result = dict(raw)
    if "handle" not in result and isinstance(result.get("id"), str):
        result["handle"] = result["id"]
    return result


def _host(origin: str) -> str:
    try:
        return urlsplit(origin).hostname or origin
    except Exception:
        return origin
