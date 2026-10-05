"""Route Hermes' original individual browser tools into a trusted native task.

This adapter never registers or overrides a tool name. The host binds a ready
native task to a trusted Hermes session, and the upstream router seam invokes
``dispatch`` from the original registry handler. Unsupported operations are
claimed and rejected; they are never sent to a different browser backend.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
from dataclasses import dataclass, field
from typing import Any


UNHANDLED = object()

# The names come from the pinned upstream tools/browser_tool.py registry table
# plus browser_cdp_tool.py. Being claimed does not imply being supported.
OFFICIAL_BROWSER_TOOLS = frozenset({
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_scroll", "browser_back", "browser_press", "browser_get_images",
    "browser_vision", "browser_console", "browser_cdp", "browser_dialog",
})

# A deliberate native subset. click/type use a ref from the most recent native
# semantic snapshot and therefore cannot silently reinterpret a stale ref.
SUPPORTED_TOOLS = frozenset({
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_scroll", "browser_back", "browser_press",
    # 中文注释：console 表达式与 CDP 使用任务已有授权；dialog 仍走普通审批。
    "browser_get_images", "browser_vision", "browser_console", "browser_cdp", "browser_dialog",
})

_ARGUMENT_KEYS = {
    "browser_navigate": ({"url"}, {"url"}),
    "browser_snapshot": (set(), {"full"}),
    "browser_click": ({"ref"}, {"ref"}),
    "browser_type": ({"ref", "text"}, {"ref", "text"}),
    "browser_scroll": ({"direction"}, {"direction"}),
    "browser_back": (set(), set()),
    "browser_press": ({"key"}, {"key"}),
    "browser_get_images": (set(), set()),
    "browser_vision": ({"question"}, {"question", "annotate"}),
    "browser_console": (set(), {"clear", "expression"}),
    "browser_cdp": ({"method"}, {"method", "params", "target_id", "frame_id", "timeout"}),
    "browser_dialog": ({"action"}, {"action", "prompt_text", "dialog_id"}),
}

_CODE_MESSAGES = {
    "approval_required": "请在浏览器扩展中确认这次操作；确认后用完全相同的工具参数再次查询，不会重新执行。",
    "user_input_required": "这是敏感字段（密码、支付或验证码），已在浏览器中提醒用户亲自填写；不要自己填写或索要内容。用户完成后用完全相同的工具参数再次查询。",
    "user_input_declined": "用户选择不填写该敏感字段，未执行。",
    "approval_denied": "用户拒绝了这次操作，未执行。",
    "approval_expired": "这次确认已过期，未执行；不会自动重试。",
    "approval_revoked": "这次确认已撤销；请先检查页面状态，不要自动重试。",
    "forbidden": "当前会话无权访问此浏览器任务。",
    "invalid_state": "浏览器任务未就绪；请先查看任务状态。",
    "task_closed": "任务已结束；请重新 browser_shared_open。",
    "task_paused": "用户已接管，任务已暂停；请等待用户继续，不会自动重试。",
    "invalid_url": "网址格式不受支持。",
    "origin_denied": "网址不在已批准的来源范围内。",
    "tab_required": "当前任务没有唯一的工作标签页；请先创建或明确绑定一个工作页。",
    "foreign_tab": "标签页不属于当前浏览器任务。",
    "instance_unavailable": "浏览器扩展未连接；请检查连接后读取任务状态。",
    "request_id_conflict": "请求编号已用于不同参数，拒绝重放。",
    "request_outcome_unavailable": "操作结果无法确认；请先核实任务状态，禁止自动重试。",
    "needs_sync": "浏览器任务需要先核实或恢复；不会重放操作。",
    "extension_timeout": "浏览器响应超时，操作结果可能不确定；禁止自动重试。",
    "extension_disconnected": "浏览器连接中断，操作结果可能不确定；禁止自动重试。",
    "workspace_unknown": "工作页归属或操作结果不确定；禁止自动重试。",
    "permission_denied": "浏览器未授权此操作。",
    "target_unavailable": "页面目标不可用；请重新读取页面，若位于 iframe 则使用 frame token。",
    "stale_reference": "页面引用已失效；请重新读取页面。",
    "document_changed": "页面内容已变化；请重新读取页面。",
    "site_changed": "读取期间页面切换了网站；结果未返回，请重新申请该网站的读取权限。",
    "page_not_ready": "页面仍在加载；稍等后在同一页面重新读取，不要重新打开页面。",
    "invalid_arguments": "浏览器工具参数无效。",
    "unsupported_operation": "当前共享浏览器适配器不支持此官方浏览器操作；未切换到其他浏览器。",
    "session_identity_required": "缺少可信会话身份，已拒绝浏览器操作。",
    "tool_call_identity_required": "缺少可信工具调用身份，已拒绝浏览器操作。",
    "task_not_ready": "绑定的浏览器任务不再就绪；请由宿主核实后重新绑定。",
    "binding_conflict": "此会话已绑定其他浏览器任务；请先由宿主解除原绑定。",
    "binding_missing": "此会话没有绑定共享浏览器任务。",
    "tab_ambiguous": "当前任务有多个工作标签页；请由宿主明确绑定一个标签页。",
    "stale_generation": "浏览器任务代次已变化；请由宿主重新核实并绑定。",
    "pending_action": "上一项操作仍待确认；请先处理该确认，再用完全相同的工具参数查询。",
    "outcome_unknown": "操作结果无法确认；请先核实页面状态，禁止自动重试。",
    "invalid_response": "浏览器返回了不完整或不匹配的结果；请先核实任务状态。",
    "bridge_error": "共享浏览器操作失败；请检查连接和授权状态。",
    "browser_access_required": "任务访问已失效；请核对任务状态。未派发。",
    "frame_not_supported": "当前 frame 不支持主上下文执行。未派发。",
    "cdp_method_denied": "CDP 方法名称无效；未执行。",
    "credential_mode_conflict": "此页面发生过凭据填写，不能执行任意 JS/CDP。",
    "js_timeout": "JavaScript 超时；已发生的页面副作用无法回滚，先核实页面，不要自动重试。",
    "cdp_error": "浏览器返回了 CDP 协议错误。",
    "no_dialog": "当前页面没有打开的 JS 对话框。",
    "dialog_open": "页面有 JS 对话框阻塞，请先用 browser_dialog 处理。",
    "target_occluded": "目标被其他元素遮挡，未点击；请处理遮挡后重新读取。",
    "target_disabled": "目标已禁用；未派发。",
    "target_hidden": "目标处于隐藏或 inert 区域；未派发。",
    "target_zero_size": "目标没有可操作尺寸；未派发。",
    "target_out_of_viewport": "目标不在视口内；未派发。",
    "reference_target_missing": "旧引用在当前文档没有唯一目标；请重新读取。",
    "reference_target_ambiguous": "旧引用匹配多个目标；请缩小范围后重新读取。",
    "closed_shadow_unavailable": "封闭 Shadow DOM 无法访问；请改用可见坐标操作。",
    "cross_origin_frame_unavailable": "该跨域子框架当前无法操作；请重新读取 frame 目录。",
    "target_unstable": "目标位置持续变化，未派发；请稍后重新读取。",
    "unsupported_frame_transform": "目标所在 frame 有旋转或倾斜变换，暂不支持；未派发。",
    "interaction_highlight_failed": "页面高亮确认失败；请先核实页面状态，不要自动重试。",
    "tab_out_of_scope": "当前工作页已离开授权网站（任务与标签组仍保留）；请用 browser_navigate 导航回授权网站，或用 browser_shared_open 打开新网站。",
    "redirected_out_of_scope": "页面跳转到任务范围外；请用返回的来源调用 browser_shared_open 新开任务。",
}

_SAFE_BRIDGE_CODES = frozenset(_CODE_MESSAGES) | frozenset({
    "api_not_approved", "api_url_denied", "execution_denied", "invalid_action",
    "invalid_params", "target_unavailable", "screenshot_expired", "stale_screenshot",
    "origin_mismatch", "lease_conflict", "approval_stale", "request_history_full",
})
_SCRIPT_REJECTIONS = frozenset({"browser_access_required", "frame_not_supported", "cdp_method_denied",
                                  "credential_mode_conflict", "no_dialog", "dialog_open"})
_DETERMINISTIC_REJECTIONS = frozenset({
    "forbidden", "invalid_state", "task_closed", "invalid_url", "origin_denied", "tab_required",
    "foreign_tab", "request_id_conflict", "approval_denied", "approval_expired", "user_input_declined",
    "approval_revoked", "invalid_action", "invalid_params", "permission_denied",
    "stale_reference", "document_changed", "site_changed", "target_unavailable", "page_not_ready",
    "browser_access_required", "frame_not_supported", "cdp_method_denied", "credential_mode_conflict",
    "target_occluded", "target_unstable", "unsupported_frame_transform",
    "target_disabled", "target_hidden", "target_zero_size", "target_out_of_viewport",
    "reference_target_missing", "reference_target_ambiguous",
    "closed_shadow_unavailable", "cross_origin_frame_unavailable",
    "no_dialog", "dialog_open",
    "redirected_out_of_scope",
})
_MAX_LOCAL_CALLS = 128
_MAX_RENDER_CHARS = 14_000
_SEMANTIC_COVERAGE_FIELDS = frozenset({
    "scanned", "matched", "returned", "omitted", "filtered", "truncated", "offset",
    "complete", "traversalComplete", "scope", "skippedFrames", "unsupportedCanvas",
})


class AdapterBindError(RuntimeError):
    """A trusted host could not bind the requested native task."""


@dataclass
class _Pending:
    fingerprint: str
    request_id: str


@dataclass
class _SessionBinding:
    session_id: str
    owner: str
    task_id: str
    instance_id: str
    generation: int
    tab_id: int | None
    explicit_tab: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)
    pending: _Pending | None = None
    outcome_unknown: bool = False
    snapshot_id: str | None = None
    semantic_binding: dict | None = None
    refs: dict[str, str] = field(default_factory=dict)
    call_ids: dict[str, tuple[str, str]] = field(default_factory=dict)
    revoked: bool = False
    # 中文注释：仅保存本次工具调用的封闭保护元数据，不能保存规则或网页原文。
    shield_metadata: dict = field(default_factory=dict)


class SingleToolAdapter:
    """Trusted adapter for the official Hermes individual browser tool entries.

    ``bind``/``unbind`` are host-only lifecycle methods. Never expose them as
    model tools and never pass the model's ``task_id`` as the native task ID.
    """

    def __init__(self, runtime: Any, *, authorization_check=None, strict_unbound: bool = False):
        self.runtime = runtime
        self.authorization_check = authorization_check
        self.strict_unbound = strict_unbound
        self._lock = threading.RLock()
        self._bindings: dict[str, _SessionBinding] = {}
        # 中文注释：当前绑定是指针；其他任务的引用和未知结果围栏继续保留。
        self._task_bindings = {}
        self._closed = False

    def _authorized(self) -> bool:
        if self.authorization_check is None:
            return True
        try:
            return self.authorization_check() is not False
        except Exception:
            return False

    def has_bindings(self) -> bool:
        with self._lock:
            return not self._closed and bool(self._bindings)

    def claims(self, session_id: str | None, action: str | None = None) -> bool:
        if action is not None and action not in OFFICIAL_BROWSER_TOOLS:
            return False
        if not isinstance(session_id, str) or not session_id:
            return False
        with self._lock:
            binding = self._bindings.get(session_id)
            return not self._closed and (
                (binding is not None and not binding.revoked) or self.strict_unbound
            )

    def available(self, action: str, session_id: str | None = None, **_identity: Any) -> bool:
        if action not in SUPPORTED_TOOLS or not self.claims(session_id, action) or not self._authorized():
            return False
        with self._lock:
            binding = self._bindings.get(session_id) if isinstance(session_id, str) else None
            return not self._closed and binding is not None and not binding.revoked

    def bind(
        self, session_id: str, task_id: str, *, owner: str | None = None,
        tab_id: int | None = None,
    ) -> dict:
        """Bind a host-selected task after checking trusted session and generation.

        The optional owner is accepted only as an equality check against the
        profile authority. It is never used as the source of task ownership.
        """
        if not isinstance(session_id, str) or not session_id or not isinstance(task_id, str) or not task_id:
            raise AdapterBindError("trusted session and task identifiers are required")
        with self._lock:
            if self._closed:
                raise AdapterBindError("native browser adapter is closed")
        if not self._authorized():
            raise AdapterBindError("native browser adapter authorization is unavailable")
        if tab_id is not None and (type(tab_id) is not int or tab_id < 0):
            raise AdapterBindError("trusted work-tab identifier is invalid")
        try:
            resolved_owner = self.runtime.authority.owner_for_session(session_id)
            if not isinstance(resolved_owner, str) or not resolved_owner or (
                    owner is not None and owner != resolved_owner):
                raise AdapterBindError("trusted session owner mismatch")
            task = self.runtime.call("shared.get", {"owner": resolved_owner, "taskId": task_id})
            self._validate_ready_task(task, task_id)
            self._validate_connected_instance(task["instanceId"])
        except AdapterBindError:
            raise
        except Exception as exc:
            raise AdapterBindError("native task ownership, readiness, or browser connection could not be verified") from exc

        agent_tabs = self._agent_tabs(task)
        if tab_id is not None and tab_id not in agent_tabs:
            raise AdapterBindError("explicit tab is not a task-created agent work tab")
        selected_tab = tab_id if tab_id is not None else (agent_tabs[0] if len(agent_tabs) == 1 else None)
        with self._lock:
            if self._closed:
                raise AdapterBindError("native browser adapter is closed")
            previous = self._task_bindings.get(session_id, {}).get(task_id)
            if previous is not None and (
                    previous.owner, previous.task_id, previous.instance_id, previous.generation
            ) != (resolved_owner, task_id, task["instanceId"], task["generation"]):
                raise AdapterBindError("session already has a different native task generation")
            if previous is not None:
                with previous.lock:
                    if tab_id is not None and previous.tab_id != tab_id:
                        self._clear_snapshot(previous)
                    if tab_id is not None:
                        previous.tab_id = tab_id
                        previous.explicit_tab = True
                if tab_id is not None or session_id not in self._bindings:
                    self._bindings[session_id] = previous
                return {"bound": True, "taskId": task_id, "instanceId": previous.instance_id, "generation": previous.generation, "tabId": previous.tab_id}
            binding = _SessionBinding(
                session_id=session_id, owner=resolved_owner, task_id=task_id,
                instance_id=task["instanceId"], generation=task["generation"],
                tab_id=selected_tab, explicit_tab=tab_id is not None,
            )
            if tab_id is not None or session_id not in self._bindings:
                self._bindings[session_id] = binding
            self._task_bindings.setdefault(session_id, {})[task_id] = binding
        return {
            "bound": True, "taskId": task_id, "instanceId": binding.instance_id,
            "generation": binding.generation, "tabId": selected_tab,
        }

    def unbind(
        self, session_id: str, *, task_id: str | None = None,
        generation: int | None = None,
    ) -> bool:
        """Revoke only the matching local task generation, if supplied."""
        with self._lock:
            current = self._task_bindings.get(session_id, {}).get(task_id) if task_id else self._bindings.get(session_id)
            if current is None or (task_id is not None and current.task_id != task_id) or (
                    generation is not None and current.generation != generation):
                return False
            current.revoked = True
            tasks = self._task_bindings.get(session_id, {})
            tasks.pop(current.task_id, None)
            if self._bindings.get(session_id) is current:
                self._bindings.pop(session_id, None)
                if tasks:
                    self._bindings[session_id] = next(reversed(tasks.values()))
        with current.lock:
            current.refs.clear()
            current.semantic_binding = None
            current.snapshot_id = None
            current.pending = None
            current.outcome_unknown = True
        return True

    def close(self) -> None:
        """Revoke every local session binding; leave shared tasks/browser untouched."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            bindings = [binding for tasks in self._task_bindings.values() for binding in tasks.values()]
            for binding in bindings:
                binding.revoked = True
            self._bindings.clear()
            self._task_bindings.clear()
        for binding in bindings:
            with binding.lock:
                binding.revoked = True
                binding.refs.clear()
                binding.semantic_binding = None
                binding.snapshot_id = None
                binding.pending = None
                binding.outcome_unknown = True

    def dispatch(
        self, action: str, args: Any, *, session_id: str | None = None,
        tool_call_id: str | None = None, task_id: str | None = None, **_untrusted: Any,
    ) -> str | object:
        """Execute from the original official tool route, returning its JSON string contract.

        ``task_id`` and other extra kwargs are deliberately ignored: Hermes' task
        context is not the native browser task identity.
        """
        if action not in OFFICIAL_BROWSER_TOOLS:
            return UNHANDLED
        with self._lock:
            binding = self._bindings.get(session_id) if isinstance(session_id, str) else None
        if not self._authorized():
            if binding is not None:
                self.unbind(session_id, task_id=binding.task_id, generation=binding.generation)
            return self._error("permission_denied")
        if binding is None:
            return self._error("binding_missing") if self.strict_unbound else UNHANDLED
        if not isinstance(args, dict):
            return self._error("invalid_arguments")
        argument_error = self._validate_arguments(action, args)
        if argument_error:
            return self._error(argument_error)
        if action not in SUPPORTED_TOOLS:
            return self._error("unsupported_operation", unsupported=True)
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return self._error("tool_call_identity_required")
        if len(tool_call_id) > 256:
            return self._error("tool_call_identity_required")

        with binding.lock:
            if binding.revoked:
                return self._error("binding_missing")
            # A snapshot is the way to check an uncertain result: it is allowed
            # and, when it succeeds, lifts the fence. Writes stay refused.
            if binding.outcome_unknown and action != "browser_snapshot":
                return self._error("outcome_unknown", outcome_unknown=True)
            try:
                current_task = self._verified_task(binding)
                tab_id = self._resolve_tab(binding, current_task)
            except _AdapterFailure as failure:
                return self._error(failure.code, outcome_unknown=failure.outcome_unknown, **failure.details)
            except Exception:
                return self._error("bridge_error", outcome_unknown=False)
            binding.shield_metadata = {}
            try:
                raw = self._dispatch_supported(binding, current_task, tab_id, action, args, tool_call_id)
                result = raw if isinstance(raw, dict) else json.loads(raw)
                # 中文注释：官方 snapshot、JS 和视觉路径不能丢失扩展的站点约束及遮罩审计。
                result.update(binding.shield_metadata)
                if result.get("success") is True:
                    # 中文注释：读取实际工作页地址；失败不把已完成的写入误报成可重试失败。
                    try:
                        rows = self.runtime.call("shared.run", {"owner": binding.owner, "taskId": binding.task_id,
                            "requestId": tool_call_id + ":tab-info", "action": "tabs"})
                        row = next((row for row in rows if row.get("id") == tab_id), {})
                    except Exception:
                        row = {}
                        result['tab_info_status'] = 'unavailable'
                    metadata = result.get("native_adapter")
                    result["native_adapter"] = metadata if isinstance(metadata, dict) else {"execution": metadata or "shared-profile"}
                    result["native_adapter"]["tab"] = {"tab_id": tab_id, "url": row.get("url"), **({"title": row["title"]} if row.get("title") else {})}
                return self._json(result)
            except _AdapterFailure as failure:
                return self._error(failure.code, outcome_unknown=failure.outcome_unknown, **failure.details)
            except Exception:
                # Never leak browser text or internal exception messages.
                binding.outcome_unknown = True
                self._clear_snapshot(binding)
                return self._error("outcome_unknown", outcome_unknown=True)

    def _dispatch_supported(self, binding, task, tab_id, action, args, call_id) -> str:
        if action == "browser_navigate":
            receipt = self._run(binding, task, tab_id, "navigate", call_id, {"url": args["url"]}, write=True)
            result = {
                "success": True,
                "url": receipt["url"],
                "ready": receipt["ready"],
                "native_adapter": {"execution": "shared-profile", "page_title": "not provided by native controller"},
            }
            self._clear_snapshot(binding)
            if receipt["ready"] in {'interactive', 'complete'}:
                try:
                    snap = self._run(binding, task, tab_id, "semantic_snapshot", call_id + ":snapshot", {}, write=False)
                    formatted = self._format_snapshot(binding, snap)
                    result["snapshot"] = formatted["snapshot"]
                    result["element_count"] = formatted["element_count"]
                    result["native_adapter"]["snapshot"] = "Page Semantics v2 interactive subset"
                    result["snapshot_coverage"] = formatted["coverage"]
                except _AdapterFailure as failure:
                    # Navigation itself succeeded; expose the bounded read failure separately.
                    result["snapshot_error"] = failure.code
            return self._json(result)

        if action == "browser_snapshot":
            if args.get("full", False) is True:
                return self._error("unsupported_operation", unsupported=True,
                                   detail="full page snapshots are not equivalent to the native interactive semantic subset")
            snap = self._run(binding, task, tab_id, "semantic_snapshot", call_id, {}, write=False)
            formatted = self._format_snapshot(binding, snap)
            binding.outcome_unknown = False
            return self._json(formatted)

        if action == "browser_scroll":
            if args.get("direction") not in {"up", "down"}:
                return self._error("invalid_arguments")
            # 中文注释：滚动会改变页面状态，回执丢失后必须阻止继续写入和自动重放。
            self._run(binding, task, tab_id, "scroll", call_id, {"direction": args["direction"]}, write=True)
            return self._json({"success": True, "scrolled": args["direction"], "native_adapter": "shared-profile"})

        if action == "browser_back":
            receipt = self._run(binding, task, tab_id, "back", call_id, {}, write=True)
            self._clear_snapshot(binding)
            return self._json({"success": True, "url": receipt.get("url"), "ready": receipt.get("ready"),
                               "native_adapter": "shared-profile"})

        if action == "browser_get_images":
            receipt = self._run(binding, task, tab_id, "images", call_id, {}, write=False)
            images = receipt.get("images") if isinstance(receipt.get("images"), list) else []
            return self._json({"success": True, "images": _redact(images), "count": receipt.get("count", len(images)),
                               "native_adapter": "shared-profile"})

        if action == "browser_console":
            if isinstance(args.get("expression"), str):
                receipt = self._run(binding, task, tab_id, "js.evaluate", call_id,
                                    {"expression": args["expression"], "world": "main"}, write=True)
                if receipt.get("ok") is False:
                    exception = receipt.get("exception") if isinstance(receipt.get("exception"), dict) else {}
                    return self._json({"success": False, "error": "JavaScript exception: " + str(exception.get("text", ""))[:300]})
                value = receipt.get("value", receipt.get("description"))
                return self._json({"success": True, "result": value, "result_type": type(value).__name__,
                                   "native_adapter": "task page main world"})
            receipt = self._run(binding, task, tab_id, "console", call_id,
                                {"clear": True} if args.get("clear") is True else {}, write=False)
            messages = [{"type": row.get("type", "log"), "text": _redact(row.get("text", "")), "source": "console"}
                        for row in receipt.get("messages", []) if isinstance(row, dict)]
            errors = [{"message": _redact(row.get("message", "")), "source": "exception"}
                      for row in receipt.get("errors", []) if isinstance(row, dict)]
            return self._json({"success": True, "console_messages": messages, "js_errors": errors,
                               "total_messages": len(messages), "total_errors": len(errors),
                               "native_adapter": {"collecting_since": "first console read on this page",
                                                  "dropped": receipt.get("dropped", 0)}})

        if action == "browser_cdp":
            # 中文注释：官方 frame_id 在本任务中使用 frame_catalog 发出的短期 frameToken；扩展重验祖先和文档。
            routing = {"frameToken": args["frame_id"]} if args.get("frame_id") else (
                {"targetId": args["target_id"]} if args.get("target_id") else {})
            if "timeout" in args:
                routing["timeoutMs"] = round(args["timeout"] * 1000)
            receipt = self._run(binding, task, tab_id, "cdp.send", call_id,
                                {"method": args["method"], "params": args.get("params") or {}, **routing}, write=True)
            return self._json({"success": True, "method": args["method"],
                               **({"frame_id": args["frame_id"]} if args.get("frame_id") else {}),
                               **({"target_id": args["target_id"]} if args.get("target_id") else {}),
                               "result": receipt})

        if action == "browser_dialog":
            if args.get("action") not in {"accept", "dismiss"}:
                return self._error("invalid_arguments")
            payload = {"accept": args["action"] == "accept"}
            if payload["accept"] and isinstance(args.get("prompt_text"), str):
                payload["promptText"] = args["prompt_text"]
            receipt = self._run(binding, task, tab_id, "dialog", call_id, payload, write=True)
            self._clear_snapshot(binding)
            return self._json({"success": True, "action": args["action"], "dialog": receipt.get("dialog", {})})

        if action == "browser_vision":
            if args.get("annotate") is not True:
                receipt = self._run(binding, task, tab_id, "screenshot", call_id, {}, write=False)
                return self._vision(receipt, args["question"])
            # 中文注释：先取交互语义快照建立 @eN 引用，再让扩展在安全截图上画 [N]；[N] 与后续 browser_click 的 @eN 一致。
            snap = self._run(binding, task, tab_id, "semantic_snapshot", call_id + ":annotate-snapshot",
                             {"options": {"mode": "interactive", "viewport": True}}, write=False)
            formatted = self._format_snapshot(binding, snap)
            labels = [{"label": int(alias[2:]), "ref": native_ref} for alias, native_ref in binding.refs.items()]
            receipt = self._run(binding, task, tab_id, "screenshot", call_id, {"annotate": {
                "binding": dict(binding.semantic_binding), "snapshotId": binding.snapshot_id, "labels": labels}}, write=False)
            known = {row["label"] for row in labels}
            annotations = [{"label": f"[{row['label']}]", "ref": f"@e{row['label']}",
                            "box": {key: round(float(row[key]), 1) for key in ("x", "y", "width", "height")}}
                           for row in receipt.get("annotations", []) if isinstance(row, dict) and row.get("label") in known]
            # 中文注释：未绘制的隐藏/移动目标不保留文字引用或后续可操作绑定。
            visible_refs = {row['ref'] for row in annotations}
            binding.refs = {alias: native for alias, native in binding.refs.items() if alias in visible_refs}
            snapshot = '\n'.join(line for line in formatted['snapshot'].splitlines()
                if any(line.endswith(f'[{alias}]') for alias in visible_refs))
            return self._vision(receipt, args["question"], annotations=annotations, snapshot=snapshot)

        if action == "browser_press":
            # The official tool presses a key on the focused element; the native
            # press still applies its key allowlist and sensitive-field rules.
            receipt = self._run(binding, task, tab_id, "press", call_id, {"selector": ":focus", "key": args["key"]}, write=True)
            self._clear_snapshot(binding)
            if isinstance(receipt, dict) and receipt.get("status") == "completed_by_user":
                return self._json({"success": True, "filled_by": "user", "note": "用户已在页面中亲自完成该输入。"})
            return self._json({"success": True, "pressed": args["key"], "native_adapter": "shared-profile"})

        requested_ref = args["ref"]
        ref = requested_ref if requested_ref.startswith("@") else f"@{requested_ref}"
        native_ref = binding.refs.get(ref)
        if native_ref is None or not binding.snapshot_id or not binding.semantic_binding:
            return self._error("stale_reference")
        semantic_binding = dict(binding.semantic_binding)
        snapshot_id = binding.snapshot_id
        self._clear_snapshot(binding)
        if action == "browser_click":
            receipt = self._run(binding, task, tab_id, "ref_click", call_id, {
                "binding": semantic_binding,
                "snapshotId": snapshot_id,
                "ref": native_ref,
            }, write=True)
            return self._json({
                "success": True, "clicked": ref, "delivery": receipt["kind"],
                **({"relocated": True} if receipt.get("relocated") is True else {}),
                **({"fallback_reason": receipt["fallbackReason"]} if isinstance(receipt.get("fallbackReason"), str) else {}),
                "popupOwnership": receipt.get("popupOwnership", "uncertain"),
                "native_adapter": "Page Semantics v2 ref",
                # 中文注释：点击已派发且页面跳出授权网站时如实告知，后续读取会返回 tab_out_of_scope。
                **({"navigated_out_of_scope": True, "next": "browser_navigate 回授权网站或 browser_shared_open 新网站"}
                   if receipt.get("outOfScope") is True else {}),
                # 中文注释：点击打开了 JS 对话框时如实告知，模型用 browser_dialog 处理后再继续。
                **({"dialog": {key: str(receipt["dialogOpened"].get(key, ""))[:500] for key in ("type", "message")},
                    "next": "browser_dialog"} if isinstance(receipt.get("dialogOpened"), dict) else {}),
            })
        receipt = self._run(binding, task, tab_id, "ref_fill", call_id, {
            "binding": semantic_binding,
            "snapshotId": snapshot_id,
            "ref": native_ref,
            "text": args["text"],
        }, write=True)
        try:
            from agent.display import redact_browser_typed_text_for_display, redact_tool_args_for_display
            safe_args = redact_tool_args_for_display("browser_type", {"text": args["text"]}) or {}
            typed_display = safe_args.get("text")
            if not isinstance(typed_display, str):
                typed_display = "[redacted]"
            typed_display = redact_browser_typed_text_for_display(typed_display, args["text"])
            if not isinstance(typed_display, str):
                typed_display = "[redacted]"
        except Exception:
            typed_display = "[redacted]"
        if receipt.get("status") == "completed_by_user":
            return self._json({
                "success": True, "element": ref, "filled_by": "user", "field_kind": receipt.get("fieldKind"),
                "note": "用户已在页面中亲自填写该字段；内容未经过 Hermes。",
            })
        return self._json({
            "success": True, "typed": typed_display, "element": ref,
            **({"relocated": True} if receipt.get("relocated") is True else {}),
            "delivery": receipt["kind"], "native_adapter": "Page Semantics v2 ref",
        })

    def _run(self, binding, task, tab_id, native_action, tool_call_id, arguments, *, write):
        if not isinstance(tool_call_id, str) or not tool_call_id:
            raise _AdapterFailure("tool_call_identity_required")
        request_args = {"action": native_action, **arguments}
        fingerprint = json.dumps(
            {"taskId": binding.task_id, "generation": binding.generation,
             "tabId": tab_id, **request_args},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        )
        if binding.pending is not None:
            if binding.pending.fingerprint != fingerprint:
                raise _AdapterFailure("pending_action")
            request_id = binding.pending.request_id
        else:
            prior = binding.call_ids.get(tool_call_id)
            if prior is not None:
                if prior[0] != fingerprint:
                    raise _AdapterFailure("request_id_conflict")
                request_id = prior[1]
            else:
                identity = json.dumps(
                    {"sessionId": binding.session_id, "taskId": binding.task_id,
                     "toolCallId": tool_call_id},
                    sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                )
                request_id = "single-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
                binding.call_ids[tool_call_id] = (fingerprint, request_id)
                if len(binding.call_ids) > _MAX_LOCAL_CALLS:
                    binding.call_ids.pop(next(iter(binding.call_ids)))
        payload = {
            "owner": binding.owner,
            "taskId": binding.task_id,
            "requestId": request_id,
            "action": native_action,
            "tabId": tab_id,
            **arguments,
        }
        try:
            receipt = self.runtime.call("shared.run", payload)
        except Exception as exc:
            code = getattr(exc, "code", None)
            code = code if isinstance(code, str) and code in _SAFE_BRIDGE_CODES else (
                "interaction_highlight_failed" if isinstance(code, str) and code.startswith("interaction_highlight_") else "bridge_error")
            data = getattr(exc, "data", None)
            data = data if isinstance(data, dict) else {}
            explicit_unknown = data.get("outcomeUnknown")
            unknown = explicit_unknown if type(explicit_unknown) is bool else (
                write and code not in _DETERMINISTIC_REJECTIONS
            )
            if unknown:
                binding.outcome_unknown = True
                binding.pending = None
                self._clear_snapshot(binding)
            elif code in {"approval_denied", "approval_expired", "approval_revoked"}:
                binding.pending = None
            details = ({'final_origin': data['finalOrigin']}
                       if code == 'redirected_out_of_scope' and isinstance(data.get('finalOrigin'), str) else
                       {'candidates': data['candidates']} if code in {'reference_target_missing', 'reference_target_ambiguous'} and isinstance(data.get('candidates'), list) else
                       {'obstruction': data['obstruction']} if code == 'target_occluded' and isinstance(data.get('obstruction'), dict) else None)
            raise _AdapterFailure(code, outcome_unknown=unknown, details=details) from exc
        if not isinstance(receipt, dict):
            binding.outcome_unknown = True
            self._clear_snapshot(binding)
            raise _AdapterFailure("invalid_response", outcome_unknown=write)
        if receipt.get("status") in {"approval_required", "approved", "executing", "user_input_required"}:
            if receipt.get("requestId") != request_id:
                binding.outcome_unknown = True
                self._clear_snapshot(binding)
                raise _AdapterFailure("invalid_response", outcome_unknown=True)
            binding.pending = _Pending(fingerprint=fingerprint, request_id=request_id)
            if write:
                self._clear_snapshot(binding)
            raise _AdapterFailure("user_input_required" if receipt["status"] == "user_input_required"
                                  else "approval_required", outcome_unknown=False)
        if receipt.get("status") in {"denied", "expired", "revoked"}:
            binding.pending = None
            failure_code = {
                "denied": "approval_denied",
                "expired": "approval_expired",
                "revoked": "approval_revoked",
            }[receipt["status"]]
            raise _AdapterFailure(failure_code)
        if native_action != "js.evaluate" and (receipt.get("ok") is False or "error" in receipt):
            explicit_unknown = receipt.get("outcomeUnknown")
            unknown = explicit_unknown if type(explicit_unknown) is bool else write
            if unknown:
                binding.outcome_unknown = True
            self._clear_snapshot(binding)
            raise _AdapterFailure("execution_denied", outcome_unknown=unknown)
        binding.pending = None
        if native_action == "navigate":
            if (type(receipt.get("tabId")) is not int or receipt["tabId"] != tab_id
                    or not isinstance(receipt.get("url"), str) or receipt.get("ready") not in {'loading', 'interactive', 'complete'}):
                binding.outcome_unknown = True
                raise _AdapterFailure("invalid_response", outcome_unknown=True)
        elif native_action == "semantic_snapshot":
            self._validate_semantic_snapshot(receipt, task)
        elif native_action == "scroll":
            # 中文注释：只有目标标签及方向匹配的明确回执才能向官方工具报告成功。
            if (type(receipt.get("tabId")) is not int or receipt["tabId"] != tab_id
                    or receipt.get("scrolled") is not True or receipt.get("direction") != arguments["direction"]):
                binding.outcome_unknown = True
                self._clear_snapshot(binding)
                raise _AdapterFailure("invalid_response", outcome_unknown=True)
        elif native_action == "ref_click":
            # 中文注释：可信或后台合成点击都必须由页面监听确认，未送达和部分送达不能宣称成功。
            if (receipt.get("clicked") is not True or receipt.get("delivery") != "confirmed"
                    or receipt.get("kind") not in {"trusted-input", "dom-synthetic"}
                    or (receipt.get("kind") == "dom-synthetic" and not isinstance(receipt.get("fallbackReason"), str))):
                binding.outcome_unknown = True
                self._clear_snapshot(binding)
                raise _AdapterFailure("invalid_response", outcome_unknown=True)
        elif native_action == "ref_fill" and receipt.get("status") == "completed_by_user":
            pass  # The person typed it in the page; nothing was dispatched by us.
        elif native_action == "ref_fill":
            if receipt.get("filled") is not True or receipt.get("kind") != "dom-synthetic":
                binding.outcome_unknown = True
                self._clear_snapshot(binding)
                raise _AdapterFailure("invalid_response", outcome_unknown=True)
        metadata = self._shield_metadata(receipt)
        if binding.shield_metadata.get('contentFilter', {}).get('siteAutomationRestricted') is True:
            metadata.setdefault('contentFilter', {})['siteAutomationRestricted'] = True
        binding.shield_metadata.update(metadata)
        return receipt

    @staticmethod
    def _shield_metadata(receipt):
        # 中文注释：按类型和固定字段转发，拒绝配置、原文和未知审计字段；遮罩名称使用固定显示文字。
        result = {}
        flags = receipt.get('contentFilter')
        if isinstance(flags, dict):
            safe = {key: flags[key] for key in ('enabled', 'siteAutomationRestricted') if type(flags.get(key)) is bool}
            if type(flags.get('removedSegments')) is int and 0 <= flags['removedSegments'] <= 1_000_000:
                safe['removedSegments'] = flags['removedSegments']
            result['contentFilter'] = safe
        if isinstance(receipt.get('masked'), list):
            result['masked'] = [{'kind': row['kind'], 'role': row['role'], 'name': '已屏蔽区域'}
                for row in receipt['masked'][:512] if isinstance(row, dict)
                and row.get('kind') in {'content_shield', 'sensitive_field', 'uninspectable_frame'}
                and row.get('role') in {'region', 'iframe', 'textbox', 'input', 'textarea', 'combobox', 'select', 'div', 'span'}]
        for key in ('omittedMoving', 'omittedMasked'):
            if type(receipt.get(key)) is int and 0 <= receipt[key] <= 10000:
                result[key] = receipt[key]
        return result

    @staticmethod
    def _vision(receipt, question, annotations=None, snapshot=None):
        """保存原生安全截图后交给 Hermes 自身的视觉路径；截图前已拒绝含敏感值的页面。"""
        import base64
        import uuid
        data = receipt.get("data") if isinstance(receipt, dict) else None
        if not isinstance(data, str) or not data:
            raise _AdapterFailure("invalid_response")
        try:
            from hermes_constants import get_hermes_dir
            directory = get_hermes_dir("cache/screenshots", "browser_screenshots")
        except Exception:
            from pathlib import Path
            directory = Path.home() / ".hermes" / "cache" / "screenshots"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"browser_screenshot_{uuid.uuid4().hex}.png"
        path.write_bytes(base64.b64decode(data))
        # 中文注释：标注模式同时返回 [N]→@eN 对照与交互快照文本，供后续点击使用同一引用。
        extra = {} if annotations is None else {"annotations": annotations, "snapshot": snapshot}
        try:
            from tools.vision_tools import _should_use_native_vision_fast_path
            from tools import browser_tool_vision as vision
            if _should_use_native_vision_fast_path():
                data = {"path": str(path), **({"annotations": annotations} if annotations is not None else {})}
                result = vision._native_vision_result(path, question, annotations is not None, {"success": True, "data": data}, None)
                if snapshot is not None and isinstance(result, dict):
                    result.setdefault("meta", {})["snapshot"] = snapshot
                return result
            analysis = vision._analyze_screenshot_with_aux_llm(path, question)
            return json.dumps({"success": True, "analysis": analysis or "Vision analysis returned no content.",
                               "screenshot_path": str(path), **extra}, ensure_ascii=False)
        except Exception:
            return json.dumps({"success": True, "analysis": None, "screenshot_path": str(path),
                               "note": "截图已保存；Hermes 视觉分析不可用，可用 MEDIA:<path> 查看。", **extra}, ensure_ascii=False)

    def _format_snapshot(self, binding, receipt):
        self._validate_semantic_snapshot(receipt, {"id": binding.task_id})
        items = receipt["items"]
        lines = []
        refs = {}
        rendered_items = 0
        for item in items:
            native_ref = item.get("ref")
            if not isinstance(native_ref, str) or not native_ref or native_ref in refs.values():
                continue
            alias = f"@e{rendered_items + 1}"
            role = item.get("role") if isinstance(item.get("role"), str) else "element"
            name = item.get("name") if isinstance(item.get("name"), str) else ""
            line = f"[{role}{' inferred' if item.get('inferred') is True else ''}] {name} [{alias}]"
            if sum(len(part) + 1 for part in lines) + len(line) > _MAX_RENDER_CHARS:
                break
            lines.append(line)
            refs[alias] = native_ref
            rendered_items += 1
        coverage = self._safe_coverage(receipt["coverage"])
        if rendered_items < len(items):
            coverage["complete"] = False
            coverage["adapterRendered"] = rendered_items
            coverage["adapterOmitted"] = len(items) - rendered_items
        binding.refs = refs
        binding.snapshot_id = receipt["snapshotId"]
        binding.semantic_binding = dict(receipt["binding"])
        return {
            "success": True,
            "snapshot": "\n".join(lines),
            "element_count": rendered_items,
            "native_adapter": "Page Semantics v2 interactive subset; refs are valid only until the next snapshot or page action",
            "snapshot_coverage": coverage,
            "coverage": coverage,
        }

    @staticmethod
    def _safe_coverage(coverage):
        if not isinstance(coverage, dict):
            return {}
        safe = {}
        for key, value in coverage.items():
            if key not in _SEMANTIC_COVERAGE_FIELDS:
                continue
            if key in {"complete", "traversalComplete"}:
                if type(value) is bool:
                    safe[key] = value
            elif key == "scope":
                if isinstance(value, str):
                    safe[key] = value[:160]
            elif type(value) is int and 0 <= value <= 1_000_000_000:
                safe[key] = value
        return safe

    @staticmethod
    def _validate_semantic_snapshot(receipt, task):
        binding = receipt.get("binding")
        if (receipt.get("version") != 2 or not isinstance(receipt.get("snapshotId"), str)
                or not receipt["snapshotId"] or not isinstance(binding, dict)
                or binding.get("taskId") != task.get("id")
                or not isinstance(binding.get("documentId"), str) or not binding["documentId"]
                or not isinstance(binding.get("leaseId"), str) or not binding["leaseId"]
                or not isinstance(receipt.get("items"), list)
                or not isinstance(receipt.get("coverage"), dict)):
            raise _AdapterFailure("invalid_response", outcome_unknown=False)
        if any(not isinstance(item, dict) for item in receipt["items"]):
            raise _AdapterFailure("invalid_response", outcome_unknown=False)

    def _verified_task(self, binding):
        try:
            owner = self.runtime.authority.owner_for_session(binding.session_id)
            if owner != binding.owner:
                raise _AdapterFailure("forbidden")
            task = self.runtime.call("shared.get", {"owner": owner, "taskId": binding.task_id})
            self._validate_ready_task(task, binding.task_id)
            if task["instanceId"] != binding.instance_id or task["generation"] != binding.generation:
                raise _AdapterFailure("stale_generation")
            self._validate_connected_instance(binding.instance_id)
            return task
        except _AdapterFailure:
            raise
        except Exception as exc:
            code = getattr(exc, "code", None)
            if code == "forbidden":
                raise _AdapterFailure("forbidden") from exc
            if code in {"not_found", "invalid_state"}:
                raise _AdapterFailure("task_not_ready") from exc
            raise _AdapterFailure("bridge_error") from exc

    def _validate_connected_instance(self, instance_id):
        rows = self.runtime.call("browser.list", {})
        if not isinstance(rows, list) or not any(
                isinstance(row, dict) and row.get("instanceId") == instance_id
                and row.get("connected") is True for row in rows):
            raise _AdapterFailure("instance_unavailable")

    @staticmethod
    def _validate_ready_task(task, task_id):
        # 中文注释：暂停任务保留绑定，明确拒绝当前派发。
        if isinstance(task, dict) and task.get("id") == task_id and task.get("state") == "paused":
            raise _AdapterFailure("task_paused")
        if (not isinstance(task, dict) or task.get("id") != task_id
                or task.get("state") != "ready" or not isinstance(task.get("instanceId"), str)
                or not task.get("instanceId") or type(task.get("generation")) is not int
                or task["generation"] < 1):
            raise _AdapterFailure("task_not_ready")

    @staticmethod
    def _agent_tabs(task):
        # ``shared.get`` hides agentTabIds. Public workTabs records only tabs
        # created by the task workspace; tabIds also includes user-selected
        # grants, so it must never be promoted into adapter control authority.
        if "agentTabIds" in task:
            raw = task.get("agentTabIds")
        else:
            work_tabs = task.get("workTabs")
            raw = [item.get("tabId") for item in work_tabs if isinstance(item, dict)] \
                if isinstance(work_tabs, list) else []
        if not isinstance(raw, list):
            return []
        return [tab for tab in raw if type(tab) is int and tab >= 0 and tab in task.get("tabIds", [])]

    def _resolve_tab(self, binding, task):
        agent_tabs = self._agent_tabs(task)
        if binding.explicit_tab and binding.tab_id is not None:
            if binding.tab_id not in agent_tabs:
                raise _AdapterFailure("foreign_tab")
            return binding.tab_id
        if len(agent_tabs) == 1:
            binding.tab_id = agent_tabs[0]
            return binding.tab_id
        if not agent_tabs:
            raise _AdapterFailure("tab_required")
        rows = self.runtime.call("shared.run", {"owner": binding.owner, "taskId": binding.task_id,
            "requestId": "tab-candidates-" + __import__('secrets').token_hex(12), "action": "tabs"})
        raise _AdapterFailure("tab_ambiguous", details={"tabs": [{"tab_id": row["id"], "url": row.get("url")} for row in rows if row.get("id") in agent_tabs]})

    @staticmethod
    def _validate_arguments(action, args):
        spec = _ARGUMENT_KEYS.get(action)
        if spec is None:
            return "invalid_arguments"
        required, allowed = spec
        if set(args) - allowed or required - set(args):
            return "invalid_arguments"
        if action == "browser_navigate":
            value = args.get("url")
            if not isinstance(value, str) or not value or len(value) > 4096:
                return "invalid_arguments"
        elif action == "browser_snapshot":
            if "full" in args and type(args["full"]) is not bool:
                return "invalid_arguments"
        elif action in {"browser_click", "browser_type"}:
            ref = args.get("ref")
            if not isinstance(ref, str) or not ref or len(ref) > 256:
                return "invalid_arguments"
            if action == "browser_type" and (not isinstance(args.get("text"), str) or len(args["text"]) > 100000):
                return "invalid_arguments"
        elif action == "browser_scroll":
            if args.get("direction") not in {"up", "down"}:
                return "invalid_arguments"
        elif action == "browser_press":
            if not isinstance(args.get("key"), str) or not args["key"] or len(args["key"]) > 128:
                return "invalid_arguments"
        elif action == "browser_vision":
            if not isinstance(args.get("question"), str) or len(args["question"]) > 4000:
                return "invalid_arguments"
            if "annotate" in args and type(args["annotate"]) is not bool:
                return "invalid_arguments"
        elif action == "browser_console":
            if "clear" in args and type(args["clear"]) is not bool:
                return "invalid_arguments"
            if "expression" in args and (not isinstance(args["expression"], str) or len(args["expression"]) > 10000):
                return "invalid_arguments"
        elif action == "browser_dialog":
            if args.get("action") not in {"accept", "dismiss"} or (
                    "prompt_text" in args and (not isinstance(args["prompt_text"], str) or len(args["prompt_text"]) > 10000)):
                return "invalid_arguments"
        elif action == "browser_cdp":
            if not isinstance(args.get("method"), str) or not args["method"] or len(args["method"]) > 200:
                return "invalid_arguments"
            if "params" in args and not isinstance(args["params"], dict):
                return "invalid_arguments"
            if "frame_id" in args and (not isinstance(args["frame_id"], str) or not 1 <= len(args["frame_id"]) <= 128):
                return "invalid_arguments"
            if "target_id" in args and (not isinstance(args["target_id"], str) or not 1 <= len(args["target_id"]) <= 128):
                return "invalid_arguments"
            if "target_id" in args and "frame_id" in args:
                return "invalid_arguments"
            if "timeout" in args and (isinstance(args["timeout"], bool) or not isinstance(args["timeout"], (int, float))
                                      or not math.isfinite(args["timeout"]) or not 0.1 <= args["timeout"] <= 60):
                return "invalid_arguments"
        return None

    @staticmethod
    def _clear_snapshot(binding):
        binding.refs.clear()
        binding.snapshot_id = None
        binding.semantic_binding = None

    @classmethod
    def _error(cls, code, *, outcome_unknown=False, unsupported=False, detail=None, tabs=None, final_origin=None, candidates=None, obstruction=None):
        message = _CODE_MESSAGES.get(code, _CODE_MESSAGES["bridge_error"])
        payload = {
            "success": False,
            "error": message,
            "code": code if code in _SAFE_BRIDGE_CODES else "bridge_error",
            "retryable": code in {"stale_reference", "document_changed", "page_not_ready"}
                        and outcome_unknown is False,
            "outcome_unknown": outcome_unknown is True,
        }
        if code == "approval_required":
            payload["resume_instruction"] = "确认完成后，以相同工具和完全相同参数再次查询；不得改参重发。"
        if unsupported:
            payload["unsupported"] = True
        if isinstance(detail, str) and detail and code == "unsupported_operation":
            payload["detail"] = detail[:240]
        if tabs is not None:
            payload["tabs"] = tabs
        if code == 'redirected_out_of_scope' and isinstance(final_origin, str):
            payload['final_origin'] = final_origin
        # 中文注释：适配器错误只返回固定形状的脱敏候选和遮挡信息。
        if code in {'reference_target_missing', 'reference_target_ambiguous'} and isinstance(candidates, list):
            payload['candidates'] = [{'role': row['role'][:40], 'name': row['name'][:80]}
                                     for row in candidates[:5] if isinstance(row, dict)
                                     and isinstance(row.get('role'), str) and isinstance(row.get('name'), str)]
        if code == 'target_occluded' and isinstance(obstruction, dict) and isinstance(obstruction.get('role'), str) and isinstance(obstruction.get('name'), str):
            payload['obstruction'] = {'role': obstruction['role'][:40], 'name': obstruction['name'][:80]}
            button = obstruction.get('closeButton')
            binding = button.get('binding') if isinstance(button, dict) else None
            if isinstance(binding, dict) and all(isinstance(binding.get(key), str) for key in ('taskId', 'documentId', 'leaseId')) and all(isinstance(button.get(key), str) for key in ('snapshotId', 'ref', 'name')):
                payload['obstruction']['closeButton'] = {'binding': {key: binding[key] for key in ('taskId', 'documentId', 'leaseId')}, 'snapshotId': button['snapshotId'], 'ref': button['ref'], 'role': 'button', 'name': button['name'][:80]}
        return cls._json(payload)

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _redact(value):
    try:
        from tools.browser_tool_snapshot import _redact_browser_output
        return _redact_browser_output(value)
    except Exception:
        return value


class _AdapterFailure(Exception):
    def __init__(self, code, *, outcome_unknown=False, details=None):
        super().__init__(code)
        self.code = code if code in _SAFE_BRIDGE_CODES else "bridge_error"
        self.outcome_unknown = outcome_unknown
        self.details = details or {}
