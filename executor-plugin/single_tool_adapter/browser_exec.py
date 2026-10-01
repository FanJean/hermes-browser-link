"""Hermes browser_exec 接管：已绑定原生任务的会话改由任务级 CDP 网关驱动 Browser Use CLI。

只使用 Hermes 公开的 ``register_tool(..., override=True)``（需要操作者授予 tools.override）与
Browser Use CLI 公开的 ``BU_CDP_WS`` 连接约定，不修改 Hermes 或 Browser Use 源码。
未绑定任务的会话保持 Hermes 原行为；已绑定任务在智能审批模式先确认本次脚本。
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
from typing import Any, Callable

_DEFAULT_TIMEOUT_S = 300
_MIN_TIMEOUT_S = 5
_MAX_TIMEOUT_S = 1800
_STDERR_CAP_CHARS = 4000
_TASK_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
_SESSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_NOTE = ("\n\n当前会话已绑定 Hermes 浏览器插件的共享任务时，代码驱动的是该任务的工作页："
         "全部访问直接执行；智能审批会先显示本次脚本批准请求，批准后以相同参数重试；再次执行同一脚本需新 request_id。"
         "凭据填写过的页面不能执行脚本；upload_file 可使用用户指定的本地文件。")


def _accepted_kwargs(handler: Callable, kwargs: dict) -> dict:
    try:
        parameters = inspect.signature(handler).parameters
    except (TypeError, ValueError):
        return kwargs
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in parameters}


def _error(message: str, code: str, **extra: Any) -> str:
    return json.dumps({"success": False, "error": message, "code": code, **extra}, ensure_ascii=False)


def find_cli(hermes_home: Path) -> list[str] | None:
    """与 Hermes 相同的查找顺序：Hermes 自带 bin、PATH、~/.local/bin，最后 uvx。"""
    probes = [str(hermes_home / "bin"), None, str(Path.home() / ".local" / "bin")]
    for name, argv in (("browser-use", lambda b: [b]), ("uvx", lambda b: [b, "browser-use"])):
        for probe in probes:
            found = shutil.which(name, path=probe)
            if found:
                return argv(found)
    return None


def _redact(text: str) -> str:
    try:
        from agent.redact import redact_sensitive_text
        return redact_sensitive_text(text or "", force=True)
    except Exception:
        return text or ""


def _clamp(timeout_s: Any) -> int:
    try:
        return max(_MIN_TIMEOUT_S, min(int(timeout_s), _MAX_TIMEOUT_S))
    except (TypeError, ValueError):
        return _DEFAULT_TIMEOUT_S


class BrowserExecAdapter:
    def __init__(self, runtime: Any, script_bridge: Any, hermes_home: Path, *, runner: Callable | None = None,
                 cli_finder: Callable | None = None):
        self.runtime = runtime
        self.bridge = script_bridge
        self.home = Path(hermes_home)
        self.runner = runner or self._run_cli
        self.cli_finder = cli_finder or (lambda: find_cli(self.home))

    def binding(self, session_id: str | None):
        """只信任宿主为可信会话建立的脚本通道绑定；模型参数不能指定任务。"""
        if not session_id:
            return None
        with self.bridge._guard:
            bound = self.bridge._bindings.get(session_id)
            if not bound or bound[5].is_set():
                return None
            return bound[0], bound[1]

    def has_bindings(self) -> bool:
        with self.bridge._guard:
            return any(not item[5].is_set() for item in self.bridge._bindings.values())

    def workspace(self, task_id: str | None) -> Path:
        safe = _TASK_SAFE.sub("_", str(task_id or "default"))[:80] or "default"
        path = self.home / "cache" / "browser-use" / "workspace" / safe
        path.mkdir(parents=True, exist_ok=True)
        return path

    def run(self, args: dict, *, owner: str, native_task: str, hermes_task: str | None) -> str:
        code = args.get("code")
        if not isinstance(code, str) or not code.strip():
            return _error("No code provided.", "invalid_arguments")
        session = args.get("session") or ""
        if session and (not isinstance(session, str) or not _SESSION.fullmatch(session)):
            return _error("Invalid session name.", "invalid_arguments")
        client_request_id = args.get('request_id', '')
        if client_request_id and (not isinstance(client_request_id, str) or not _REQUEST_ID.fullmatch(client_request_id)):
            return _error('Invalid request_id.', 'invalid_arguments')
        if args.get("local"):
            return _error("local=true 不适用于已绑定的共享浏览器任务。", "invalid_arguments")
        workspace = self.workspace(hermes_task)
        cli = self.cli_finder()
        if not cli:
            return _error("browser-use CLI not found. Install it with `uv tool install browser-use`.", "cli_missing",
                          outcome_unknown=False)
        # 中文注释：脚本摘要和会话名绑定单次审批；重查使用同一 requestId，网关资格只消费一次。
        code_digest = hashlib.sha256(code.encode()).hexdigest()
        request_id = "browser-exec-" + hashlib.sha256(f"{native_task}:{session}:{code_digest}:{client_request_id}".encode()).hexdigest()
        try:
            permit = self.runtime.call("shared.run", {"owner": owner, "taskId": native_task,
                                                       "requestId": request_id, "action": "gateway.authorize",
                                                       "codeDigest": code_digest})
        except Exception as exc:
            code_name = str(getattr(exc, "code", "") or "gateway_unavailable")
            if code_name == 'approval_consumed':
                return _error('本次脚本批准已使用；再次执行请传新的 request_id。', code_name, outcome_unknown=False)
            return _error("无法确认本次调试脚本；未执行任何代码。", code_name, outcome_unknown=False)
        if isinstance(permit, dict) and permit.get("status") in {"approval_required", "approved", "executing", "denied", "expired", "revoked"}:
            return json.dumps({"success": False, **permit}, ensure_ascii=False)
        if not isinstance(permit, dict) or permit.get("authorized") is not True:
            return _error("脚本授权回执无效；未执行任何代码。", "gateway_unavailable", outcome_unknown=False)
        try:
            gateway = self.runtime.call("shared.cdp_gateway", {"owner": owner, "taskId": native_task,
                                                               "workspace": str(workspace), "requestId": request_id,
                                                               "codeDigest": code_digest})
        except Exception as exc:
            code_name = str(getattr(exc, "code", "") or "gateway_unavailable")
            messages = {
                "task_paused": "用户已接管，任务已暂停；请等待用户继续，未执行任何代码。",
                "approval_required": "本次调试脚本需要重新审批；未执行任何代码。",
                "credential_mode_conflict": "当前页发生过凭据填写，请使用新的任务页。未执行任何代码。",
                "instance_unavailable": "绑定的浏览器未连接。未执行任何代码。",
            }
            return _error(messages.get(code_name, "无法建立任务浏览器网关；未执行任何代码。"), code_name,
                          outcome_unknown=False)
        url = gateway.get("wsUrl") if isinstance(gateway, dict) else None
        if not isinstance(url, str) or not url.startswith("ws://127.0.0.1:"):
            # 中文注释：无效地址也立即回收刚签发的临时网关。
            try:
                self.runtime.call("shared.cdp_gateway_close", {"owner": owner, "taskId": native_task})
            except Exception:
                pass
            return _error("任务网关返回无效地址；未执行任何代码。", "gateway_unavailable", outcome_unknown=False)
        env = {key: value for key, value in os.environ.items()
               if key not in {"PYTHONPATH", "PYTHONHOME", "BU_CDP_URL", "BU_CDP_WS", "BU_BROWSER_ID", "BU_AUTOSPAWN"}}
        # 中文注释：每个任务代次一个独立 harness 守护进程名，避免复用连到其他浏览器的旧守护进程。
        digest = hashlib.sha256(f"{native_task}:{url}".encode()).hexdigest()[:12]
        harness = f"hermes-{session or 'task'}-{digest}"[:64]
        env.update(BU_CDP_WS=url, BU_NAME=harness, BH_AGENT_WORKSPACE=str(workspace),
                   ANONYMIZED_TELEMETRY="false", BH_TELEMETRY="0")
        timeout = _clamp(args.get("timeout_s", _DEFAULT_TIMEOUT_S))
        started = time.time()
        try:
            proc = self.runner(cli, code, env, timeout)
        except subprocess.TimeoutExpired:
            return _error(f"browser-use exec timed out after {timeout}s; the page may have changed. "
                          "Check the page before retrying.", "timeout", outcome_unknown=True, workspace=str(workspace))
        except OSError as exc:
            return _error(f"Failed to launch browser-use CLI: {exc.__class__.__name__}", "cli_failed",
                          outcome_unknown=False)
        finally:
            # 中文注释：批准的调试脚本完成或失败后立即关闭临时网关与事件订阅。
            try:
                self.runtime.call("shared.cdp_gateway_close", {"owner": owner, "taskId": native_task})
            except Exception:
                pass
        result = {"success": proc.returncode == 0, "exit_code": proc.returncode,
                  "output": _redact(proc.stdout), "workspace": str(workspace),
                  "backend": "hermes-native-task", "harness": harness, "elapsed_s": round(time.time() - started, 2)}
        if session:
            result["session"] = session
        stderr = _redact((proc.stderr or "").strip())
        if len(stderr) > _STDERR_CAP_CHARS:
            stderr = stderr[:_STDERR_CAP_CHARS] + "\n… (stderr truncated)"
        if stderr:
            result["stderr"] = stderr
        return json.dumps(result, ensure_ascii=False)

    @staticmethod
    def _run_cli(cmd: list, code: str, env: dict, timeout: int):
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", env=env, start_new_session=True)
        try:
            stdout, stderr = proc.communicate(input=code, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            raise
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def register_browser_exec_override(ctx: Any, runtime: Any, script_bridge: Any, hermes_home: Path, *,
                                   lease_arg: str, lease_error: type, registry: Any = None):
    """browser_exec 存在时用公开 override 接管；返回适配器或 None（此 Hermes 版本没有该工具）。"""
    if registry is None:
        from tools.registry import registry
        try:
            import importlib
            importlib.import_module("tools.browser_use_cli")
        except Exception:
            pass
    original = registry.get_entry("browser_exec")
    if original is None or original.is_async:
        return None
    adapter = BrowserExecAdapter(runtime, script_bridge, hermes_home)
    authority = runtime.authority

    def handler(args, *, session_id=None, task_id=None, **context):
        public = args
        lease = None
        if isinstance(args, dict) and lease_arg in args:
            public = {key: value for key, value in args.items() if key != lease_arg}
            try:
                lease = authority.consume("browser_exec", args, session_id=session_id)
            except lease_error:
                return _error("缺少可信会话身份，已拒绝。", "session_identity_required")
        bound = adapter.binding(session_id)
        if bound is None:
            # 中文注释：未绑定原生任务的会话继续使用 Hermes 自身的 browser_exec，行为不变。
            return original.handler(public, **_accepted_kwargs(original.handler,
                                                               {"session_id": session_id, "task_id": task_id, **context}))
        if lease is None:
            return _error("缺少可信工具调用身份，已拒绝。", "tool_call_identity_required")
        return adapter.run(public if isinstance(public, dict) else {}, owner=bound[0], native_task=bound[1],
                           hermes_task=task_id)

    original_check = original.check_fn

    def check_fn():
        if adapter.has_bindings():
            return True
        return True if original_check is None else original_check()

    schema = json.loads(json.dumps(original.schema))
    # 中文注释：可选请求编号区分相同脚本的多次独立审批；同一次审批重查保持编号不变。
    schema.setdefault('parameters', {}).setdefault('properties', {})['request_id'] = {
        'type': 'string', 'minLength': 1, 'maxLength': 128}
    description = str(schema.get("description") or original.description or "")
    description = re.sub(r"\n\n\(The browser-use CLI is not installed yet\.[^)]*\)", "", description)
    schema["description"] = description + _NOTE
    ctx.register_tool(name="browser_exec", toolset=original.toolset, schema=schema, handler=handler,
                      check_fn=check_fn, requires_env=list(original.requires_env or []),
                      description=schema["description"], emoji=original.emoji, override=True)
    authority.lease_tools(["browser_exec"], passthrough=True)
    return adapter
