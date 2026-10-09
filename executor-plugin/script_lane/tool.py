"""browser_shared_script: the plugin's own Python batch tool.

Runs model-written Python in a fresh interpreter against the session's bound
native task, without touching Hermes' browser_exec. The child gets a scrubbed
environment (no API keys or Hermes secrets), a per-session workspace and one
socket to the trusted host bridge.
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import selectors
import time
import subprocess
import sys
from pathlib import Path

TOOL_NAME = 'browser_shared_script'
MAX_CODE_CHARS = 200_000
MAX_OUTPUT_CHARS = 20_000
DEFAULT_TIMEOUT_S = 720
MAX_TIMEOUT_S = 3600

SCHEMA = {
    'description': (
        '同一页两步以上时，在本会话已就绪的任务中运行一次 Python 脚本并读回核对（填表、翻页、提取、保存）。脚本内可用 new_tab、goto_url、'
        'read_page、wait_for_element、click_element、fill_element、scroll、semantic_snapshot、screenshot、reconcile、wait_pending 等函数，'
        '连接授权后普通动作直接执行，仍校验任务归属、来源与租约，敏感操作保留独立确认。page_text/read_page 返回 dict，读 elements/items 字段，不能切片 dict；wait_for timeout 上限 60 秒，先检查 satisfied。JS 用 evaluate(function, arguments) 传值。stdout 只打印目标项、coverage、计数和文件路径，大提取物保存在脚本工作区。用法与模板见技能 browser-link:batch-scrape。'),
    'parameters': {
        'type': 'object',
        'properties': {
            'code': {'type': 'string', 'minLength': 1, 'maxLength': MAX_CODE_CHARS},
            'timeout_s': {'type': 'integer', 'minimum': 1, 'maximum': MAX_TIMEOUT_S},
            'resume_checkpoint': {'type': 'object',
                                  'description': 'Hermes 明确提供的业务检查点；脚本用 load_checkpoint() 读取，不自动重放旧动作。'},
        },
        'required': ['code'],
        'additionalProperties': False,
    },
}


def _error(message, code, *, outcome_unknown=False):
    return json.dumps({'error': message, 'code': code, 'retryable': False,
                       'outcome_unknown': outcome_unknown}, ensure_ascii=False)


def _clip(text):
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    return text[:MAX_OUTPUT_CHARS], True


def _valid_checkpoint(value):
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    try:
        return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) <= 65536
    except (TypeError, ValueError):
        return False


def workspace_for(hermes_home: Path, owner: str) -> Path:
    """One private directory per trusted session owner; never model-chosen."""
    digest = hashlib.sha256(owner.encode('utf-8')).hexdigest()[:24]
    root = Path(hermes_home) / 'plugin-data' / 'browser-link-native' / 'scripts'
    path = root / digest
    for directory in (root, path, path / 'tmp'):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    return path


def _collect_output(process, code, timeout_s):
    """中文注释：同时排空双输出流，只保留固定字节前缀，打印量不会扩大宿主缓冲。"""
    budget = MAX_OUTPUT_CHARS * 4
    kept = {"stdout": bytearray(), "stderr": bytearray()}
    counts = {"stdout": 0, "stderr": 0}
    source = memoryview(code.encode("utf-8"))
    offset = 0
    deadline = time.monotonic() + timeout_s
    timed_out = False
    with selectors.DefaultSelector() as selector:
        for stream, name in ((process.stdin, "stdin"), (process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_WRITE if name == "stdin" else selectors.EVENT_READ, name)
        while selector.get_map():
            now = time.monotonic()
            if now >= deadline:
                if timed_out:
                    break
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                deadline = now + 2
            for key, _ in selector.select(min(0.1, max(0, deadline - now))):
                stream, name = key.fileobj, key.data
                try:
                    if name == "stdin":
                        if offset < len(source):
                            offset += os.write(stream.fileno(), source[offset:offset + 16384])
                        if offset < len(source):
                            continue
                    else:
                        chunk = os.read(stream.fileno(), 65536)
                        if chunk:
                            counts[name] += len(chunk)
                            kept[name].extend(chunk[:max(0, budget - len(kept[name]))])
                            continue
                except BlockingIOError:
                    continue
                except BrokenPipeError:
                    pass
                selector.unregister(stream)
                stream.close()
        for key in list(selector.get_map().values()):
            key.fileobj.close()
    # 中文注释：输出流关闭不代表进程退出，继续使用原期限等待，超时后杀掉整个脚本进程组。
    try:
        process.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
    # 中文注释：截断在 UTF-8 完整字符处解码，再遵守工具字符预算。
    texts = {name: data.decode("utf-8", errors="ignore") for name, data in kept.items()}
    clipped = {name: counts[name] > len(kept[name]) or len(texts[name]) > MAX_OUTPUT_CHARS for name in kept}
    return texts["stdout"][:MAX_OUTPUT_CHARS], texts["stderr"][:MAX_OUTPUT_CHARS], timed_out, clipped, counts


def run_script(bridge, *, session_id, tool_call_id, workspace: Path, code: str, timeout_s: int,
               resume_checkpoint=None, python=sys.executable, export_roots='') -> dict:
    launch = bridge.prepare(session_id=session_id, tool_call_id=tool_call_id,
                            workspace=str(workspace), code=code,resume_checkpoint=resume_checkpoint)
    env = {
        'PATH': os.defpath, 'HOME': str(workspace), 'TMPDIR': str(workspace / 'tmp'),
        'LANG': 'C.UTF-8', 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
        'HERMES_BROWSER_FD': str(launch.fd),
        'HERMES_BROWSER_EXPORT_ROOTS': export_roots,
    }
    child = Path(__file__).with_name('child.py')
    process = None
    try:
        process = subprocess.Popen(
            [python, '-I', '-u', str(child)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=str(workspace), env=env, pass_fds=(launch.fd,),
            start_new_session=True)
        stdout, stderr, timed_out, clipped, counts = _collect_output(process, code, timeout_s)
    finally:
        # 中文注释：正常退出或宿主读取失败也回收同组子孙进程，避免后台副作用越过本次脚本生命周期。
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
        launch.close()
    completion = launch.receipt
    stdout_truncated, stderr_truncated = clipped['stdout'], clipped['stderr']
    return {'exit_code': process.returncode, 'timed_out': timed_out, 'stdout': stdout, 'stderr': stderr,
            'stdout_truncated': stdout_truncated, 'stderr_truncated': stderr_truncated,
            'output_bytes': counts,
            # 中文注释：前缀不是完整业务结果；明确输出类别与工作区续读方法。
            'truncation': [{'category': name + '_prefix', 'reason': 'output_limit',
                            'continuation': '将完整提取物存到脚本工作区，下一脚本按路径和范围续读；本前缀未证明已读完。'}
                           for name, truncated in clipped.items() if truncated],
            'last_operation': completion['last_operation'],
            'resumeSummary': completion.get('resumeSummary'),
            # 中文注释：退出码不能覆盖待审批、待人工输入或未知操作结果。
            'execution_complete': completion['execution_complete'] and not timed_out and process.returncode == 0,
            'outcome_unknown': completion['outcome_unknown'] or timed_out or process.returncode != 0}


def _export_roots(shared_home: Path):
    # 中文注释：进程环境优先；非默认 profile 读取共享桥接 home 的 .env。
    configured = os.environ.get('HERMES_BROWSER_EXPORT_ROOTS')
    if configured is not None:
        return configured
    try:
        for line in (Path(shared_home) / '.env').read_text(encoding='utf-8').splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and key.strip() == 'HERMES_BROWSER_EXPORT_ROOTS':
                return value.strip().strip('"\'')
    except (OSError, UnicodeError):
        pass
    return ''


def make_handler(bridge, authority, hermes_home: Path, *, lease_error, bridge_denied, python=sys.executable,
                 shared_home=None):
    def handler(args, *, session_id=None, **_):
        try:
            lease = authority.consume(TOOL_NAME, args, session_id=session_id)
        except lease_error:
            return _error('缺少可信会话身份，已拒绝脚本。', 'session_identity_required')
        code = args.get('code')
        timeout_s = args.get('timeout_s', DEFAULT_TIMEOUT_S)
        checkpoint = args.get('resume_checkpoint')
        # 中文注释：参数错误区分缺失与无效，只返回字段名，不回显脚本或检查点。
        if 'code' not in args:
            return json.dumps({'error': '缺少脚本字段。', 'code': 'missing_fields', 'fields': ['code'], 'outcome_unknown': False, 'retryable': False}, ensure_ascii=False)
        invalid = []
        if not isinstance(code, str) or not code or len(code) > MAX_CODE_CHARS:
            invalid.append('code')
        if type(timeout_s) is not int or not 1 <= timeout_s <= MAX_TIMEOUT_S:
            invalid.append('timeout_s')
        if not _valid_checkpoint(checkpoint):
            invalid.append('resume_checkpoint')
        if invalid:
            return json.dumps({'error': '脚本参数不符合契约。', 'code': 'invalid_fields', 'fields': invalid, 'outcome_unknown': False, 'retryable': False}, ensure_ascii=False)
        try:
            workspace = workspace_for(hermes_home, lease.owner)
            result = run_script(bridge, session_id=session_id, tool_call_id=lease.tool_call_id,
                                workspace=workspace, code=code, timeout_s=timeout_s,
                                resume_checkpoint=checkpoint, python=python,
                                export_roots=_export_roots(shared_home or hermes_home))
        except bridge_denied as error:
            # 中文注释：任务仍存在，等待用户继续；不能把暂停当作绑定缺失。
            if getattr(error, 'code', None) == 'task_paused':
                return _error('用户已接管，任务已暂停；请等待用户继续，不会自动重试。', 'task_paused')
            return _error('当前会话没有就绪的共享浏览器任务，或同一会话已有脚本在运行；'
                          '请先用 browser_shared_create/get 让任务就绪。', 'binding_missing')
        return json.dumps(result, ensure_ascii=False)
    return handler


def register(ctx, bridge, runtime, hermes_home: Path, *, lease_error, bridge_denied):
    runtime.authority.lease_tools((TOOL_NAME,))
    ctx.register_tool(name=TOOL_NAME, toolset='browser-link', schema=SCHEMA,
                      handler=make_handler(bridge, runtime.authority, hermes_home,
                                           lease_error=lease_error, bridge_denied=bridge_denied,
                                           shared_home=runtime.bridge_home),
                      description=SCHEMA['description'], emoji='🐍')
