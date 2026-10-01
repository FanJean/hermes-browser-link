"""Hermes native registration for browser-link.

Uses only Hermes' public plugin API; no Hermes or Browser Use source is patched.
- browser_shared_*, browser_shared_open and browser_shared_script are this plugin's own tools.
- Hermes' official browser_* tools are taken over with register_tool(override=True)
  only when the operator granted this plugin ``tools.override``. Sessions not
  bound to a ready native task keep Hermes' built-in behavior.
"""
from __future__ import annotations

import hashlib
import importlib.util
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)
_PLUGIN_ROOT = Path(__file__).resolve().parent


def _load_native_tools():
    native_path = _PLUGIN_ROOT / "native_tools.py"
    native_name = "hermes_browser_native_tools_" + hashlib.sha256(
        str(native_path).encode("utf-8")
    ).hexdigest()[:16]
    native = sys.modules.get(native_name)
    if native is None:
        spec = importlib.util.spec_from_file_location(native_name, native_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("native browser tools could not be loaded")
        native = importlib.util.module_from_spec(spec)
        sys.modules[native_name] = native
        try:
            spec.loader.exec_module(native)
        except Exception:
            sys.modules.pop(native_name, None)
            raise
    return native


_SKILLS = (
    ("use-my-browser", "Standard workflow and safety rules for working in the user's logged-in Chrome/Edge"),
    ("batch-scrape", "Paging, extraction, de-duplication and saving with browser_shared_script"),
    ("troubleshoot", "What to do for each browser plugin error code and status"),
)
_SENSITIVE_DEFAULT = "Never fill password, payment or one-time-code fields yourself; the user fills them in the browser."
_SENSITIVE_VAULT = ("For login password or one-time-code fields, check browser_vault_list first; if nothing fits, the user "
                    "enters it in the trusted browser UI. Payment fields are always filled by the user.")
_PROMPT = (
    "When you need to work in the user's own browser (their logged-in Chrome/Edge), first read "
    "browser-link:use-my-browser with skill_view; for bulk paging and collection read "
    "browser-link:batch-scrape, and for errors read browser-link:troubleshoot. "
    "Use the open receipt summary first; batch multi-step page work in one browser_shared_script and read back there. "
    "Wait with wait_for or wait_for_load, not time.sleep. " + _SENSITIVE_DEFAULT
)


def _register_guidance(ctx, *, vault_enabled=False) -> None:
    """Skills plus a two-sentence pointer; plugin skills are not listed in the
    prompt by Hermes, so the pointer is how the model finds them."""
    register_skill = getattr(ctx, "register_skill", None)
    if callable(register_skill):
        for name, description in _SKILLS:
            register_skill(name, _PLUGIN_ROOT / "skills" / name / "SKILL.md", description=description)
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if callable(register_section):
        # 中文注释：只有官方 Vault 工具真实启用后才提示模型使用私有填写路径。
        prompt = _PROMPT.replace(_SENSITIVE_DEFAULT, _SENSITIVE_VAULT) if vault_enabled else _PROMPT
        register_section("browser-link.guide", prompt)


def register(ctx) -> None:
    """Register namespaced tools, the script tool and the trusted owner lease hook."""
    from hermes_constants import get_hermes_home

    home = get_hermes_home().expanduser().resolve()
    native = _load_native_tools()
    native_runtime = native.runtime_module()
    profile = native_runtime.get_native_profile_runtime(home, _PLUGIN_ROOT)

    host_bridge_module = native_runtime.load_module(
        _PLUGIN_ROOT / "script_lane" / "host_bridge.py", "hermes_browser_script_host_bridge_")
    script_bridge = host_bridge_module.HostBridge(profile, _PLUGIN_ROOT)
    ctx.on_unload(script_bridge.close)
    script_tool = native_runtime.load_module(
        _PLUGIN_ROOT / "script_lane" / "tool.py", "hermes_browser_script_tool_")
    script_tool.register(ctx, script_bridge, profile, home, lease_error=native_runtime.OwnerLeaseError,
                         bridge_denied=host_bridge_module.BridgeDenied)

    # 中文注释：网站工具共享脚本通道与宿主租约，不注册独立执行器。
    site_tools = native_runtime.load_module(_PLUGIN_ROOT / 'site_tools/tools.py', 'hermes_browser_site_tools_')
    site_tools.register(ctx, script_bridge, profile, home, lease_error=native_runtime.OwnerLeaseError,
                        bridge_denied=host_bridge_module.BridgeDenied)

    integration = native_runtime.load_module(
        _PLUGIN_ROOT / "single_tool_adapter" / "integration.py",
        "hermes_browser_single_tool_integration_",
    )
    bridges = [script_bridge]
    vault_enabled = False
    if ctx.has_capability("tools.override"):
        single_bridge, overridden = integration.register_official_overrides(
            ctx, profile, lease_arg=native_runtime.OWNER_LEASE_ARG, lease_error=native_runtime.OwnerLeaseError)
        bridges.append(single_bridge)
        logger.info("browser-link: official browser tools routed for bound sessions: %s", ", ".join(overridden))
        exec_module = native_runtime.load_module(
            _PLUGIN_ROOT / "single_tool_adapter" / "browser_exec.py", "hermes_browser_exec_adapter_")
        if exec_module.register_browser_exec_override(
                ctx, profile, script_bridge, home, lease_arg=native_runtime.OWNER_LEASE_ARG,
                lease_error=native_runtime.OwnerLeaseError) is not None:
            logger.info("browser-link: browser_exec routed to the task CDP gateway for bound sessions")
        # 中文注释：Vault 覆盖另有显式配置；未开启时官方原工具保持原样。
        get_config = getattr(ctx, "get_config", None)
        vault_setting = get_config("vault_tools.enabled", False) if callable(get_config) else False
        if type(vault_setting) is not bool:
            raise ValueError("vault_tools.enabled must be a boolean")
        if vault_setting:
            vault_integration = native_runtime.load_module(
                _PLUGIN_ROOT / "vault_adapter" / "integration.py", "hermes_browser_vault_integration_")
            vault_bindings, vault_adapter = vault_integration.create_vault_integration(profile)
            names = vault_integration.register_vault_overrides(
                ctx, profile, vault_bindings, vault_adapter, lease_arg=native_runtime.OWNER_LEASE_ARG,
                lease_error=native_runtime.OwnerLeaseError)
            bridges.append(vault_bindings)
            vault_enabled = True
            logger.info("browser-link: official Vault tools routed for bound sessions: %s", ", ".join(names))
    host_bridge = integration.HostBindingCoordinator(*bridges)
    open_tool = native_runtime.load_module(_PLUGIN_ROOT / "open_tool.py", "hermes_browser_open_tool_")
    open_tool.register(ctx, profile, host_bridge, lease_error=native_runtime.OwnerLeaseError)

    # 中文注释：能力参考与只读排障使用同一可信会话租约。
    reference = native_runtime.load_module(_PLUGIN_ROOT / 'reference.py', 'hermes_browser_reference_')
    reference.register(ctx, profile, home, lease_error=native_runtime.OwnerLeaseError)
    _register_guidance(ctx, vault_enabled=vault_enabled)
    native.register_native_context(
        ctx,
        profile,
        cleanup=lambda: native_runtime.release_native_profile_runtime(home, profile),
        host_bridge=host_bridge,
    )


__all__ = ["register"]
