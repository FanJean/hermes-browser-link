#!/usr/bin/env python3
"""Profile-scoped Unix socket daemon for the native browser bridge."""

from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
from collections import OrderedDict
import errno
import fcntl
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import tempfile
import threading
import time
import uuid
import sys

# 中文注释：只在浏览器调用期间释放任务锁，异常也先重新加锁再记录结果。
@contextmanager
def _outside_task_lock(lock):
    lock.release()
    try:
        yield
    finally:
        lock.acquire()


# Source checkout and installed host-bin use explicit local package roots.
_diag_source = Path(__file__).resolve().parent.parent / "browser-diagnostics" / "python"
if _diag_source.is_dir():
    sys.path.insert(0, str(_diag_source))
try:
    from browser_diagnostics import JsonlDiagnosticSink
    from browser_diagnostics.schema import make_event
except ImportError:
    JsonlDiagnosticSink = None
    make_event = None
try:
    from browser_diagnostics.sink import _thread_lock_for as _diagnostic_thread_lock_for
except ImportError:
    _diagnostic_thread_lock_for = None

# Source checkout places the projection under executor-plugin; the release
# package places it at the browser-link root beside native_bridge/.
_projection_roots = (
    Path(__file__).resolve().parent,
    Path(__file__).resolve().parent.parent,
    Path(__file__).resolve().parent.parent / "executor-plugin",
)
for _projection_root in _projection_roots:
    if (_projection_root / "task_diagnostics.py").is_file():
        sys.path.insert(0, str(_projection_root))
        break
try:
    from task_diagnostics import TaskDiagnosticProjection
except ImportError:
    TaskDiagnosticProjection = None
from typing import Any, Dict
from urllib.parse import urlsplit
from api_client import ApiClient, ApiDenied
from artifacts import ArtifactStore, ArtifactError, LOCAL_PATH_ORIGIN
from downloads import DownloadRegistry, DownloadError, new_download_key, public_record as public_download
from cdp_gateway import CdpGateway, GatewayDenied
from vault_private import VaultPrivateService, remove_stale_socket

V1_ACTIONS = frozenset({
    'navigate', 'snapshot', 'click', 'fill', 'press', 'screenshot', 'tabs', 'new_tab',
    'page.observe', 'page.parse', 'semantic_snapshot', 'frame_catalog', 'ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option', 'api_request',
    'interaction.capture', 'interaction.bounds', 'interaction.click',
    'interaction.drag_coordinates', 'interaction.drag_elements',
    'files.upload',
    'official.ready_state', 'official.goto_url', 'official.new_tab',
    'scroll', 'back',
    # 中文注释：页面执行（JavaScript / CDP）；复用既有浏览器完整访问。
    'js.evaluate', 'cdp.send', 'cdp.events', 'network.inspect', 'gateway.authorize', 'vault.authorize',
    'images', 'console', 'dialog',
})
SCRIPT_ACTIONS = frozenset({'js.evaluate', 'cdp.send', 'cdp.events', 'network.inspect'})
# 中文注释：这些动作可能返回当前任务页内容；tabs 只列任务租约页，单独保留直接读取。
SITE_READ_ACTIONS = frozenset({'snapshot', 'screenshot', 'page.observe', 'page.parse', 'semantic_snapshot', 'frame_catalog',
                               'interaction.capture', 'interaction.bounds', 'official.ready_state', 'images', 'console'})
SITE_NAV_ACTIONS = frozenset({'navigate', 'new_tab', 'official.goto_url', 'official.new_tab'})
_TOOL_RESULT_LIMIT = 900 * 1024

_MAX_LINE = 1024 * 1024
_DEFAULT_REQUEST_HISTORY_LIMIT = 4096
_DIAGNOSTIC_ROTATED_RE = re.compile(r"^events\.(\d{6})\.jsonl$")
_MAX_DIAGNOSTIC_CURSOR = 10**20 - 1


class ProtocolError(Exception):
    def __init__(self, code: str, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = _safe_error_data(data)


_SCOPE_HINT = '同站用 goto_url，新站用 browser_shared_open。'


def _safe_error_data(data: Any) -> dict:
    if not isinstance(data, dict):
        return {}
    safe = {key: data[key] for key in ("outcomeUnknown", "retryable") if type(data.get(key)) is bool}
    # 中文注释：错误摘要只保留已脱敏的角色、名称和关闭按钮引用。
    rows = data.get('candidates')
    if isinstance(rows, list):
        safe['candidates'] = [{'role': row['role'][:40], 'name': row['name'][:80]}
                              for row in rows[:5] if isinstance(row, dict)
                              and isinstance(row.get('role'), str) and isinstance(row.get('name'), str)]
    obstruction = data.get('obstruction')
    if isinstance(obstruction, dict) and isinstance(obstruction.get('role'), str) and isinstance(obstruction.get('name'), str):
        safe['obstruction'] = {'role': obstruction['role'][:40], 'name': obstruction['name'][:80]}
        button = obstruction.get('closeButton')
        binding = button.get('binding') if isinstance(button, dict) else None
        if (isinstance(binding, dict) and all(isinstance(binding.get(key), str) for key in ('taskId', 'documentId', 'leaseId'))
                and all(isinstance(button.get(key), str) for key in ('snapshotId', 'ref', 'name'))):
            safe['obstruction']['closeButton'] = {
                'binding': {key: binding[key] for key in ('taskId', 'documentId', 'leaseId')},
                'snapshotId': button['snapshotId'], 'ref': button['ref'], 'role': 'button', 'name': button['name'][:80]}
    # 中文注释：跨站错误只允许完整来源；路径、查询、凭据与片段均不进入协议数据。
    for key in ('finalOrigin', 'currentOrigin'):
        value = data.get(key)
        if isinstance(value, str):
            try:
                parsed = urlsplit(value)
                if (parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password
                        and not parsed.path and not parsed.query and not parsed.fragment
                        and value == f'{parsed.scheme}://{parsed.netloc}'):
                    safe[key] = value
            except ValueError:
                pass
    # 中文注释：恢复提示只放行固定文案；阶段与原因码只放行短的小写标识符。
    if data.get('scopeHint') == _SCOPE_HINT:
        safe['scopeHint'] = _SCOPE_HINT
    for key in ('stage', 'reasonCode'):
        value = data.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,47}', value):
            safe[key] = value
    return safe


class BridgeDaemon:
    def __init__(self, home: Path, request_history_limit: int = _DEFAULT_REQUEST_HISTORY_LIMIT):
        if not isinstance(request_history_limit, int) or isinstance(request_history_limit, bool) or request_history_limit < 1:
            raise ValueError("request_history_limit must be a positive integer")
        self.home = home.resolve()
        self.data_dir = self.home / "plugin-data" / "browser-link-native"
        self.socket_path = self.data_dir / "bridge.sock"
        self.token_path = self.data_dir / "token"
        self.tasks_path = self.data_dir / "tasks.json"
        self.pid_path = self.data_dir / "daemon.pid"
        self.lock_path = self.data_dir / "daemon.lock"
        self.stop_event = threading.Event()
        self.server: socket.socket | None = None
        self.lock_file = None
        self.state_lock = threading.RLock()
        self.extensions: Dict[str, Dict[str, Any]] = {}
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.tab_leases: Dict[tuple[str, int], str] = {}
        self.task_locks: Dict[str, threading.RLock] = {}
        self.cleanup_locks: Dict[str, threading.Lock] = {}
        # Ephemeral proof from a read-only browser check; never persist across reconnect.
        self.cleanup_proofs: Dict[str, tuple[int, Any, tuple[int, ...]]] = {}
        self.inflight_requests = {}
        self.preparing_requests = {}
        self.dedupe: Dict[str, Dict[str, tuple[str, str | None, Any]]] = {}
        self.persist_lock = threading.Lock()
        self.persist_timer = None
        self.persist_dirty = False
        self.persist_error = None
        self.pending_journal = []
        self.journal_path = self.data_dir / 'requests.jsonl'
        self.primary_path = self.data_dir / 'primary-browser.json'
        self.task_log_dir = self.data_dir / 'task-logs'
        self.task_log_lock = threading.Lock()
        # 中文注释：结果缓存只在内存中保留，任务账本与防重放指纹独立保存。
        self.result_cache = OrderedDict()
        self.result_cache_bytes = 0
        self.page_results = OrderedDict()
        self.request_history_limit = request_history_limit
        self.api_client = ApiClient()
        self.api_credentials = {}
        self.api_connections = {}
        # Ephemeral approvals: never serialize pending payloads, nonces or grants.
        self.action_approvals = {}
        self.approval_ttl = 120.0
        # A person typing a password or code needs longer than a yes/no decision.
        self.manual_input_ttl = 600.0
        self.diagnostics = None
        self.diagnostic_projection = None
        self.diagnostic_connection = uuid.uuid4().hex
        self.download_registry = DownloadRegistry(self.home)
        self.cdp_gateway = CdpGateway(self._gateway_call, self._gateway_validate, self._gateway_create_tab)
        # 中文注释：凭据填写只经独立套接字进入 daemon，不开放普通客户端 RPC。
        self.vault_private = VaultPrivateService(self)
        # 中文注释：计时归常驻 daemon 管理；非负秒数可为小数，便于临时 profile 验收。
        self.idle_close_seconds = self._idle_seconds('HERMES_BROWSER_IDLE_CLOSE_SECONDS', 600)
        self.task_idle_timeout_seconds = self._idle_seconds('HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS', 3600)

    @staticmethod
    def _idle_seconds(name, default):
        value = float(os.environ.get(name, default))
        if not math.isfinite(value) or value < 0:
            raise ValueError(f'{name} must be a finite non-negative number')
        return value

    def _session_activity(self, owner, task_id=None):
        # 中文注释：任意可信调用取消整个会话的宽限；兜底空闲时间只更新实际被调用的任务。
        with self.state_lock:
            now = time.time()
            cancelled = False
            for task in self.tasks.values():
                if task['owner'] != owner or task['state'] in {'closed', 'cancelled'}:
                    continue
                cancelled = cancelled or 'idleCloseAt' in task
                task.pop('idleCloseAt', None)
                if task_id is None or task['id'] == task_id:
                    task['lastActivityAt'] = now
                self._persist_tasks()
            return cancelled

    def _session_end(self, params):
        if set(params) != {'owner'}:
            raise ProtocolError('invalid_params', 'invalid session end')
        owner = self._required_string(params, 'owner')
        with self.state_lock:
            deadline = time.time() + self.idle_close_seconds
            for task in self.tasks.values():
                if task['owner'] == owner and task['state'] not in {'closed', 'cancelled'}:
                    # 中文注释：重复完成信号不能延长已启动的宽限；再调用会先移除截止时间。
                    task.setdefault('idleCloseAt', deadline)
            self._persist_tasks()
        self._sweep_idle_tasks()
        return {'accepted': True}

    def _pending_human(self, task):
        # 中文注释：暂停状态和仍有效的人工批准/敏感填写请求均不能被空闲扫描关闭。
        return task['state'] == 'paused' or task.get('idleRecoveryState') == 'paused' or any(
            key[0] == task['id'] and entry.get('generation') == task['generation']
            and entry.get('status') in {'user_input_required', 'approval_required'}
            and entry.get('expiresAt', 0) > time.time()
            for key, entry in self.action_approvals.items())

    def _idle_due(self, task, now):
        eligible = task['state'] == 'ready' or (task['state'] == 'needs_sync' and task.get('idleRecoveryState') == 'ready')
        if task['state'] in {'closed', 'cancelled', 'running'} or self._pending_human(task):
            return False
        return (task.get('idleCloseAt', math.inf) <= now or (eligible and
                task.get('lastActivityAt', task.get('createdAt', now)) + self.task_idle_timeout_seconds <= now))

    def _sweep_idle_tasks(self):
        # 中文注释：候选快照只用于排队；释放前在状态锁内再次验证活动时间、代次和暂停状态。
        with self.state_lock:
            candidates = [(t['id'], t['owner'], t['generation'], t.get('idleCloseAt'), t.get('lastActivityAt'))
                          for t in self.tasks.values() if self._idle_due(t, time.time())]
        for task_id, owner, generation, deadline, activity in candidates:
            try:
                self._release_task({'owner': owner, 'taskId': task_id}, 'closed', True,
                                   handoff_if_pending=True, idle_check=(generation, deadline, activity))
                self._flush_tasks()
            except (ProtocolError, OSError):
                logging.getLogger('browser-link').warning('空闲任务关闭结果未确认，请核对清理状态。')

    def _idle_watch(self):
        # 中文注释：启动即扫描；独立线程避免浏览器的有界清理阻塞 socket 接收。
        while not self.stop_event.is_set():
            self._sweep_idle_tasks()
            self.stop_event.wait(0.5)

    def _primary_browser(self):
        # 中文注释：所有 profile 读取同一 daemon 数据目录；配置只保留实例 ID 与浏览器类型。
        try:
            value = json.loads(_read_private_regular(self.primary_path).decode('utf-8'))
        except FileNotFoundError:
            return None
        if (not isinstance(value, dict) or set(value) != {'instanceId', 'browser'}
                or not isinstance(value['instanceId'], str) or not value['instanceId']
                or value['browser'] not in {'chrome', 'edge'}):
            raise ProtocolError('invalid_state', '主要链接配置无效')
        return value

    def _set_primary_browser(self, instance_id):
        with self.state_lock:
            extension = self.extensions.get(instance_id)
            if extension is None:
                raise ProtocolError('instance_unavailable', '浏览器未连接')
            value = {'instanceId': instance_id, 'browser': extension['browser']}
            self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            _atomic_write_private(self.primary_path, (json.dumps(value) + '\n').encode('utf-8'))
            instances = list(self.extensions)
        for current in instances:
            self._notify_tasks_changed(current)
        return value

    def _task_log_path(self, task_id):
        return self.task_log_dir / (_sha256(task_id) + '.jsonl')

    def _append_task_log(self, task_id, operation, target_summary=None):
        # 中文注释：日志只写固定动作和结构性目标，不读取选择器、输入值或页面正文。
        action = operation['action']
        target = ('textbox · 名称未提供' if action in {'fill', 'ref_fill'} else
                  'button · 名称未提供' if action in {'click', 'ref_click'} else
                  '敏感字段' if action == 'vault.fill' else '页面或任务')
        if (isinstance(target_summary, dict) and isinstance(target_summary.get('role'), str)
                and isinstance(target_summary.get('name'), str)):
            role = target_summary['role'][:32]
            name = target_summary['name'][:48]
            target = '敏感字段' if name == '敏感字段' else f'{role} · {name or "名称未提供"}'
        row = {'time': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(operation['startedAt'])) + 'Z',
               'action': action, 'target': target, 'durationMs': operation.get('durationMs', 0),
               'result': operation['state'] if operation['state'] != 'failed' else operation.get('errorCode', 'error')}
        encoded = (json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        with self.task_log_lock:
            if self.task_log_dir.is_symlink():
                raise ProtocolError('invalid_state', 'task log directory is a symlink')
            self.task_log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = _open_private_regular(self._task_log_path(task_id), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, 'ab') as stream:
                stream.write(encoded)
            self._prune_task_logs()

    def _prune_task_logs(self):
        # 中文注释：保留最近七天且总量不超过 10 MiB；优先删除最旧任务文件。
        files = sorted((path for path in self.task_log_dir.glob('*.jsonl') if path.is_file() and not path.is_symlink()),
                       key=lambda path: path.stat().st_mtime)
        cutoff = time.time() - 7 * 86400
        total = sum(path.stat().st_size for path in files)
        for path in files:
            info = path.stat()
            if info.st_mtime < cutoff or total > 10 * 1024 * 1024:
                total -= info.st_size
                path.unlink()

    def _read_task_log(self, task_id, limit):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ProtocolError('invalid_params', 'invalid task log limit')
        try:
            with self.task_log_lock:
                if self.task_log_dir.is_symlink():
                    raise ProtocolError('invalid_state', 'task log directory is a symlink')
                lines = _read_private_regular(self._task_log_path(task_id)).splitlines()
        except FileNotFoundError:
            return []
        return [json.loads(line) for line in lines[-limit:]]

    def _diagnostic_writer(self):
        if JsonlDiagnosticSink is None:
            return None, None
        if self.diagnostics is None:
            self.diagnostics = JsonlDiagnosticSink(self.data_dir / "diagnostics", max_bytes=1048576, max_files=5)
        if self.diagnostic_projection is None and TaskDiagnosticProjection is not None:
            self.diagnostic_projection = TaskDiagnosticProjection(self.diagnostics)
        return self.diagnostics, self.diagnostic_projection

    def _diagnostic(self, event_type, status, request_id=None, duration_ms=None, error_code=None, action=None):
        # No caller payload, IDs, URLs, exceptions or metadata enter this seam.
        try:
            sink, _projection = self._diagnostic_writer()
            if sink is None or make_event is None:
                return
            sink.write(make_event(component="native_bridge", event_type=event_type,
                status=status, request_id=request_id, connection_id=self.diagnostic_connection,
                duration_ms=duration_ms, error_code=error_code, action=action))
        except Exception:
            pass

    @staticmethod
    def _diagnostic_error_code(error: Exception) -> str:
        if isinstance(error, ProtocolError):
            return error.code if re.fullmatch(r'[a-z][a-z0-9_]{0,63}', error.code) else 'PROTOCOL_ERROR'
        if isinstance(error, TimeoutError):
            return "TIMEOUT"
        if isinstance(error, PermissionError):
            return "PERMISSION_DENIED"
        if isinstance(error, ConnectionError):
            return "DISCONNECTED"
        if isinstance(error, ValueError):
            return "VALIDATION_ERROR"
        if isinstance(error, OSError):
            return "TRANSPORT_ERROR"
        return "UNCLASSIFIED_ERROR"

    def _record_task_request_diagnostic(self, params, status, duration_ms, error_code=None):
        """Record only a request already committed to daemon-owned history."""
        try:
            if TaskDiagnosticProjection is None or not isinstance(params, dict):
                return
            request_id = params.get("requestId")
            if not isinstance(request_id, str) or not request_id.strip():
                return
            try:
                task = self._owned_task({"owner": params.get("owner"), "taskId": params.get("taskId")})
            except ProtocolError:
                return

            request_hash = _sha256(request_id)
            fingerprint = json.dumps(
                {key: value for key, value in params.items() if key not in {"owner", "requestId"}},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            payload_hash = _sha256(fingerprint)
            task_id = task["id"]
            with self.state_lock:
                current = self.tasks.get(task_id)
                if current is None or current.get("owner") != task.get("owner"):
                    return
                history = current.get("requestHistory")
                if not isinstance(history, list) or not any(
                    isinstance(entry, dict)
                    and entry.get("requestIdHash") == request_hash
                    and entry.get("payloadHash") == payload_hash
                    for entry in history
                ):
                    return
                snapshot = dict(current)
                snapshot["requestHistory"] = [dict(entry) for entry in history if isinstance(entry, dict)]
                owner = current["owner"]
                generation = current.get("generation")

            _sink, projection = self._diagnostic_writer()
            if projection is None:
                return
            projection.record(
                snapshot,
                owner,
                task_id,
                component="native_bridge",
                event_type="request_state",
                status=status,
                request_id=request_hash,
                request_id_hash=request_hash,
                connection_id=self.diagnostic_connection,
                generation=str(generation) if type(generation) is int and generation >= 0 else None,
                duration_ms=duration_ms,
                error_code=error_code,
                action=params.get('action') if params.get('action') in V1_ACTIONS else None,
            )
        except Exception:
            # Diagnostics are best-effort and never change the browser result.
            pass

    def _record_task_state_diagnostic(self, task, status):
        """Persist one owner-scoped state event from a task held under state_lock."""
        try:
            if TaskDiagnosticProjection is None or not isinstance(task, dict):
                return
            owner = task.get("owner")
            task_id = task.get("id")
            if not isinstance(owner, str) or not isinstance(task_id, str):
                return
            snapshot = dict(task)
            history = task.get("requestHistory", [])
            snapshot["requestHistory"] = [dict(entry) for entry in history if isinstance(entry, dict)] if isinstance(history, list) else []
            _sink, projection = self._diagnostic_writer()
            if projection is None:
                return
            generation = task.get("generation")
            projection.record(
                snapshot,
                owner,
                task_id,
                component="native_bridge",
                event_type="task_state",
                status=status,
                connection_id=self.diagnostic_connection,
                generation=str(generation) if type(generation) is int and generation >= 0 else None,
            )
        except Exception:
            # State persistence and browser cleanup must not depend on diagnostics.
            pass

    def _diagnostic_projection_for_read(self):
        """Build a projection over existing files without sink initialization."""
        if (JsonlDiagnosticSink is None or TaskDiagnosticProjection is None
                or _diagnostic_thread_lock_for is None):
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided")
        root = self.data_dir / "diagnostics"
        try:
            info = os.lstat(root)
            if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
                raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided")
            names = os.listdir(root)
        except FileNotFoundError:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided") from None
        except OSError:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided") from None
        log_names = [name for name in names if name == "events.jsonl" or _DIAGNOSTIC_ROTATED_RE.fullmatch(name)]
        if not log_names:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided")
        has_event_bytes = False
        try:
            for name in log_names:
                event_info = os.lstat(root / name)
                if (stat.S_ISLNK(event_info.st_mode) or not stat.S_ISREG(event_info.st_mode)
                        or event_info.st_uid != os.getuid() or stat.S_IMODE(event_info.st_mode) & 0o077):
                    raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided")
                has_event_bytes = has_event_bytes or event_info.st_size > 0
        except OSError:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided") from None
        if not has_event_bytes:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided")

        sink = self.diagnostics
        if sink is None or Path(sink.root) != root:
            # TaskDiagnosticProjection only needs this sink's bounded metadata,
            # canonical root and shared thread lock. Avoid JsonlDiagnosticSink's
            # constructor here because it creates/repairs files on read paths.
            sink = object.__new__(JsonlDiagnosticSink)
            sink.root = root
            sink.max_bytes = 1048576
            sink.max_files = 5
            sink._thread_lock = _diagnostic_thread_lock_for(root)
        return TaskDiagnosticProjection(sink)

    def _shared_diagnostics(self, params):
        required = {"owner", "taskId", "limit", "cursor"}
        allowed = required | {"requestIdHash"}
        if set(params) - allowed or required - set(params):
            raise ProtocolError("invalid_params", "invalid diagnostics query")
        owner = self._required_string(params, "owner")
        task_id = self._required_string(params, "taskId")
        request_hash = params.get("requestIdHash")
        if "requestIdHash" in params and not _is_sha256(request_hash):
            raise ProtocolError("invalid_params", "invalid diagnostics query")
        limit = params.get("limit")
        cursor = params.get("cursor")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ProtocolError("invalid_params", "invalid diagnostics page")
        if type(cursor) is not int or not 0 <= cursor <= _MAX_DIAGNOSTIC_CURSOR:
            raise ProtocolError("invalid_params", "invalid diagnostics page")

        task = self._owned_task({"owner": owner, "taskId": task_id})
        with self.state_lock:
            current = self.tasks.get(task_id)
            if current is None:
                raise ProtocolError("not_found", "task not found")
            if current.get("owner") != owner:
                raise ProtocolError("forbidden", "task belongs to another owner")
            snapshot = dict(current)
            history = current.get("requestHistory", [])
            snapshot["requestHistory"] = [dict(entry) for entry in history if isinstance(entry, dict)] if isinstance(history, list) else []
        try:
            projection = self._diagnostic_projection_for_read()
            return projection.query(snapshot, snapshot["owner"], snapshot["id"], request_hash,
                                    limit=limit, cursor=cursor)
        except PermissionError:
            raise ProtocolError("not_found", "task diagnostics unavailable") from None
        except ValueError:
            raise ProtocolError("invalid_params", "invalid diagnostics query") from None
        except OSError:
            raise ProtocolError("diagnostics_unavailable", "diagnostics are not provided") from None


    def run(self) -> int:
        self._prepare_data_dir()
        lock_fd = _open_private_regular(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        self.lock_file = os.fdopen(lock_fd, "a+")
        try:
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0

        token = self._ensure_token()
        self._load_tasks()
        self._prepare_socket_path()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server = server
        server.bind(str(self.socket_path))
        os.chmod(self.socket_path, 0o600)
        server.listen(64)
        server.settimeout(0.2)
        _atomic_write_private(self.pid_path, str(os.getpid()).encode("ascii"))

        try:
            self.vault_private.start()
            threading.Thread(target=self._idle_watch, daemon=True).start()
            while not self.stop_event.is_set():
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self._serve_connection, args=(conn, token), daemon=True).start()
        finally:
            self.vault_private.close()
            self._flush_tasks()
            server.close()
            for path in (self.socket_path, self.pid_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        return 0

    def _prepare_data_dir(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = os.lstat(self.data_dir)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise RuntimeError("browser-link-native data path must be a real directory")
        if info.st_uid != os.getuid():
            raise RuntimeError("browser-link-native data directory has the wrong owner")
        os.chmod(self.data_dir, 0o700)

    def _prepare_socket_path(self) -> None:
        # 中文注释：run() 已取得独占锁，旧 daemon 崩溃（如 SIGKILL）遗留的套接字无人监听时才清理后重建。
        try:
            info = os.lstat(self.socket_path)
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(info.st_mode):
            raise RuntimeError("refusing to replace a non-socket bridge path")
        remove_stale_socket(self.socket_path, "refusing to replace an existing bridge socket")

    def stop(self, *_args) -> None:
        self.cdp_gateway.close()
        self.stop_event.set()

    def _ensure_token(self) -> str:
        try:
            fd = _open_private_regular(self.token_path, os.O_RDWR, 0o600)
        except FileNotFoundError:
            fd = _open_private_regular(
                self.token_path,
                os.O_RDWR | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        with os.fdopen(fd, "r+", encoding="ascii") as handle:
            token = handle.read(4097).strip()
            if token:
                return token
            token = secrets.token_urlsafe(32)
            handle.seek(0)
            handle.truncate()
            handle.write(token + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            return token

    def _load_tasks(self) -> None:
        try:
            raw_bytes = _read_private_regular(self.tasks_path)
        except FileNotFoundError:
            raw_bytes = b'{"version":1,"tasks":[]}'
        raw = json.loads(raw_bytes.decode("utf-8"))
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("tasks"), list):
            raise RuntimeError("invalid tasks persistence file")
        # 中文注释：派发日志先于浏览器副作用落盘；快照未合并时也能恢复请求指纹。
        try:
            journal = _read_private_regular(self.journal_path)
        except FileNotFoundError:
            journal = b''
        # 中文注释：崩溃留下的半行必须截断，避免后续追加与半行拼接；完整坏行仍拒绝启动。
        if journal and not journal.endswith(b'\n'):
            journal = journal[:journal.rfind(b'\n') + 1]
            _atomic_write_private(self.journal_path, journal)
        tasks = {task['id']: task for task in raw['tasks']}
        for line in journal.splitlines(keepends=True):
            if not line.endswith(b'\n'):
                # 中文注释：未完成的最后一行不可能通过派发前 fsync，不视为已派发记录。
                break
            record = json.loads(line)
            task_id, entry = record['task']['id'], record['entry']
            if not _is_sha256(entry.get('requestIdHash')) or not _is_sha256(entry.get('payloadHash')):
                raise RuntimeError('invalid request journal')
            task = tasks.setdefault(task_id, record['task'])
            history = task.setdefault('requestHistory', [])
            previous = next((row for row in history if row.get('requestIdHash') == entry['requestIdHash']), None)
            if previous is not None and previous.get('payloadHash') != entry['payloadHash']:
                raise RuntimeError('request journal fingerprint conflict')
            if previous is None:
                history.append(entry)
            else:
                previous.update(entry)
        raw['tasks'] = list(tasks.values())
        changed = False
        for item in raw["tasks"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("owner"), str):
                raise RuntimeError("invalid persisted task")
            task = dict(item)
            # 中文注释：重启会撤销执行授权，但保留原空闲时刻和 ready/暂停区别供启动扫描使用。
            task.setdefault('lastActivityAt', task.get('updatedAt', task.get('createdAt', time.time())))
            if task.pop('idlePendingHuman', False):
                task['idleRecoveryState'] = 'paused'
            elif task.get('state') in {'ready', 'paused'}:
                task['idleRecoveryState'] = task['state']
            if task.get("currentOperation", {}).get("state") == "running":
                task["currentOperation"]["state"] = "unknown"
            task['activeMode'] = 'smart'
            task['modeGeneration'] = task.get('modeGeneration', 1) + 1
            task['readOrigins'] = []
            history = task.get("requestHistory", [])
            if not isinstance(history, list) or len(history) > self.request_history_limit:
                raise RuntimeError("invalid persisted request history")
            restored_dedupe: Dict[str, tuple[str, str | None, Any]] = {}
            for entry in history:
                if not isinstance(entry, dict):
                    raise RuntimeError("invalid persisted request history")
                request_hash = entry.get("requestIdHash")
                payload_hash = entry.get("payloadHash")
                if not _is_sha256(request_hash) or not _is_sha256(payload_hash):
                    raise RuntimeError("invalid persisted request history")
                restored_dedupe[request_hash] = (payload_hash, None, None)
            task["requestHistory"] = history
            if task.get("state") not in {"cancelled", "closed", "failed", "needs_sync"}:
                task["state"] = "needs_sync"
                task["tabIds"] = []
                task["agentTabIds"] = []
                task["updatedAt"] = time.time()
                changed = True
            task.setdefault("agentTabIds", [])
            if task.get("state") in {"cancelled", "closed"} and task.get("cleanupState") not in {"succeeded", "pending", "unknown", "failed"}:
                task["cleanupState"] = "unknown"
                task["cleanupReason"] = "legacy_unverified"
                changed = True
            task["workspaceState"] = "unknown" if task.get("state") == "needs_sync" else task.get("workspaceState", "ready")
            self.tasks[task["id"]] = task
            self.task_locks[task["id"]] = threading.RLock()
            self.cleanup_locks[task["id"]] = threading.Lock()
            self.dedupe[task["id"]] = restored_dedupe
        if changed:
            self._persist_tasks()

    def _ledger_record(self, task, entry):
        # 中文注释：仅保存原有任务元数据和哈希账本，不记录动作参数或页面结果。
        return {'task': copy.deepcopy({k: v for k, v in task.items() if k not in {'activeMode', 'requestHistory'}}),
                'entry': dict(entry)}

    def _append_journal(self, records):
        if not records:
            return
        encoded = b''.join((json.dumps(row, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8') for row in records)
        existed = self.journal_path.exists()
        fd = _open_private_regular(self.journal_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'ab') as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        if not existed:
            directory = os.open(self.data_dir, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    def _persist_dispatched(self, task, entry):
        with self.state_lock:
            record = self._ledger_record(task, entry)
        # 中文注释：IO 不持全局状态锁；fsync 返回后才允许调用扩展。
        with self.persist_lock:
            if self.persist_error is not None:
                raise RuntimeError('task persistence unavailable')
            self._append_journal([record])

    def _persist_tasks(self) -> None:
        # 中文注释：短窗口合并整表快照；派发账本由独立同步追加保证持久性。
        with self.state_lock:
            self.persist_dirty = True
            if self.persist_timer is None:
                self.persist_timer = threading.Timer(0.1, self._flush_tasks)
                self.persist_timer.daemon = True
                self.persist_timer.start()

    def _flush_tasks(self):
        # 中文注释：统一写锁保证快照不会倒序覆盖，拍照后释放状态锁再执行文件 IO。
        with self.persist_lock:
            with self.state_lock:
                timer, self.persist_timer = self.persist_timer, None
                if timer is not None:
                    timer.cancel()
                payload = copy.deepcopy({'version': 1, 'tasks': [{k: v for k, v in task.items() if k != 'activeMode'} for task in self.tasks.values()]})
                # 中文注释：人工请求本身不持久化；只保存暂停保护标记，重启后需显式恢复，不自动关闭 CAPTCHA 页。
                for row in payload['tasks']:
                    if row['state'] not in {'closed', 'cancelled'} and self._pending_human(self.tasks[row['id']]):
                        row['idlePendingHuman'] = True
                records, self.pending_journal = self.pending_journal, []
                self.persist_dirty = False
            try:
                self._append_journal(records)
                encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
                _atomic_write_private(self.tasks_path, encoded)
                # 中文注释：快照落盘后压缩日志。持写锁期间无法追加新派发记录；快照前已追加的派发条目
                # 必然已在任务账本中（先入账本再追加日志），因此截断不会丢失派发前落盘的指纹。
                if self.journal_path.exists():
                    _atomic_write_private(self.journal_path, b'')
            except Exception as exc:
                self.persist_error = exc
                raise

    def _serve_connection(self, conn: socket.socket, token: str) -> None:
        reader = conn.makefile("rb")
        try:
            hello = _read_line(reader)
            role = hello.get("role")
            if hello.get("token") != token or role not in {"client", "extension"}:
                return
            if role == "extension":
                self._serve_extension(conn, reader, str(hello.get("origin", "")))
            else:
                self._serve_client(conn, reader)
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            reader.close()
            conn.close()

    def _serve_client(self, conn: socket.socket, reader) -> None:
        while not self.stop_event.is_set():
            request = _read_line(reader)
            request_id = request.get("id")
            try:
                result = self._dispatch_client(request.get("method"), request.get("params"))
                response = {"id": request_id, "result": result}
            except ProtocolError as exc:
                response = {"id": request_id, "error": {"code": exc.code, "message": exc.message,
                            "data": exc.data}}
            conn.sendall(_encode_line(response))

    def _dispatch_client(self, method: Any, params: Any) -> Any:
        # 中文注释：直接共享 RPC（含官方适配器）也计入活动；清理查询和生命周期信号不延长任务寿命。
        if (isinstance(method, str) and method.startswith('shared.') and isinstance(params, dict)
                and method not in {'shared.activity', 'shared.session_end', 'shared.cleanup_status', 'shared.cleanup_retry', 'shared.sweep_ungroup', 'shared.sweep_close'}):
            owner = self._required_string(params, 'owner')
            if 'taskId' in params:
                self._owned_task(params)
            if self._session_activity(owner, params.get('taskId')):
                self._flush_tasks()
        result = self._dispatch_client_impl(method, params)
        # 中文注释：创建、撤销与清理回执必须在返回前持久化；动作路径仍合并快照。
        if method in {'shared.create', 'shared.cancel', 'shared.close', 'shared.handoff', 'shared.resume', 'shared.cleanup_retry', 'shared.session_end', 'shared.sweep_ungroup', 'shared.sweep_close'}:
            self._flush_tasks()
        return result

    def _dispatch_client_impl(self, method: Any, params: Any) -> Any:
        if not isinstance(params, dict):
            raise ProtocolError("invalid_params", "params must be an object")
        if method == 'shared.activity':
            if (set(params) - {'owner', 'taskId'} or 'owner' not in params
                    or 'taskId' in params and (not isinstance(params['taskId'], str) or not params['taskId'].strip())):
                raise ProtocolError('invalid_params', 'invalid activity')
            if self._session_activity(self._required_string(params, 'owner'), params.get('taskId')):
                # 中文注释：仅取消持久宽限时立即落盘；普通活动沿用合并快照，避免每次点击多一次 fsync。
                self._flush_tasks()
            return {'accepted': True}
        if method == 'shared.session_end':
            return self._session_end(params)
        if method == 'shared.sweep_close':
            # 中文注释：一次性清理必须提交读到的代次与活动时刻；快照之后有新活动或暂停就拒绝关闭。
            if (set(params) != {'owner', 'taskId', 'generation', 'lastActivityAt', 'idleSeconds'}
                    or type(params['generation']) is not int
                    or type(params['lastActivityAt']) not in {float, int}
                    or type(params['idleSeconds']) not in {float, int}
                    or not math.isfinite(params['lastActivityAt']) or not math.isfinite(params['idleSeconds'])
                    or params['idleSeconds'] < 0):
                raise ProtocolError('invalid_params', 'invalid stale sweep')
            return self._release_task(params, 'closed', True, handoff_if_pending=True,
                                      stale_check=(params['generation'], params['lastActivityAt'], params['idleSeconds']))
        if method == 'shared.sweep_ungroup':
            # 中文注释：一次性脚本只能收指定终态任务的组；始终复核扩展私有创建日志，不授予删页权。
            task = self._owned_task(params)
            if set(params) != {'owner', 'taskId', 'generation'} or type(params['generation']) is not int:
                raise ProtocolError('invalid_params', 'invalid ungroup sweep')
            if task['generation'] != params['generation']:
                raise ProtocolError('task_busy', 'stale sweep generation changed')
            if task['state'] not in {'closed', 'cancelled'}:
                raise ProtocolError('invalid_state', 'terminal task required')
            extension = self.extensions.get(task['instanceId'])
            if extension is None:
                raise ProtocolError('instance_unavailable', 'browser instance is not connected')
            self._ungroup_terminal_tasks(task['instanceId'], extension, task['id'], force=True)
            return self._public_task(task)
        if method == "health" and params == {}:
            return {"ok": True, "protocolVersion": 1}
        if method == 'ui.set_primary':
            if set(params) != {'instanceId'} or not isinstance(params['instanceId'], str):
                raise ProtocolError('invalid_params', 'invalid primary browser')
            return self._set_primary_browser(params['instanceId'])
        if method == "browser.list" and params == {}:
            with self.state_lock:
                extensions = list(self.extensions.values())
                primary = self._primary_browser()
            result = []
            for item in extensions:
                status = "unknown"
                supports_status = item.get("consentStatusSupported") is True
                if supports_status:
                    try:
                        response = self._extension_call(item, "extension.consent_status", {}, timeout=5.0)
                        with self.state_lock:
                            current = self.extensions.get(item["instanceId"]) is item
                        if (current and isinstance(response, dict)
                                and response.get("consentStatus") in {"enabled", "disabled"}
                                and set(response) == {"consentStatus"}):
                            status = response["consentStatus"]
                            pending = item.get("accessRequest")
                            if (isinstance(pending, dict)
                                    and pending.get("initialConsentStatus") in {"enabled", "disabled"}
                                    and status != pending.get("initialConsentStatus")):
                                item["accessRequest"] = None
                            item["lastConsentStatus"] = status
                    except Exception:
                        # A missing, stale, malformed or disconnected read is not
                        # evidence that consent is disabled.
                        pass
                result.append({
                    "instanceId": item["instanceId"],
                    "browser": item["browser"],
                    "version": item["version"],
                    "features": item.get("features", []),
                    "connected": True,
                    "primary": primary is not None and item['instanceId'] == primary['instanceId'] and item['browser'] == primary['browser'],
                    "consentStatus": status,
                    "accessRequestSupported": item.get("accessRequestSupported") is True,
                })
            if primary and not any(item['primary'] for item in result):
                result.append({'instanceId': primary['instanceId'], 'browser': primary['browser'],
                               'version': '', 'features': [], 'connected': False, 'consentStatus': 'unknown',
                               'accessRequestSupported': False, 'primary': True})
            return sorted(result, key=lambda item: item["instanceId"])
        if method == "browser.access_request":
            return self._browser_access_request(params)
        if method == "shared.create":
            return self._create_task(params)
        if method == "shared.get":
            task = self._owned_task(params)
            result = self._public_task(task)
            if params.get('includeLog') is True:
                result['recentLog'] = self._read_task_log(task['id'], params.get('logLimit', 20))
            extension = self.extensions.get(task["instanceId"])
            if extension and extension.get("statusProjection") and task["state"] not in {"closed", "cancelled"}:
                try:
                    observed = self._extension_call(extension, "browser.status", {"taskId": task["id"], "generation": task["generation"]}, timeout=2)
                    result["pageStatus"] = observed
                except (ProtocolError, OSError):
                    result["pageStatus"] = {"status": "unknown", "pages": []}
            return result
        if method == "shared.result":
            task = self._owned_task(params)
            with self.state_lock:
                record = self.page_results.get(task["id"])
                if not record or record["generation"] != task["generation"]:
                    return {"available": False}
                return {"available": True, **record}
        if method == "shared.artifacts":
            task = self._owned_task(params)
            try:
                # 中文注释：只返回当前任务与代次的文件元信息，本地路径留在 daemon 内部。
                return ArtifactStore(self.home).list(task=task, owner=task["owner"])
            except ArtifactError as exc:
                raise ProtocolError(str(exc), "task artifacts unavailable") from None
        if method == "shared.operation_status":
            return self._operation_status(params)
        if method in {"shared.downloads", "shared.download_claim", "shared.download_cancel"}:
            return self._downloads(method, params)
        if method == "shared.cdp_gateway":
            return self._open_cdp_gateway(params)
        if method == "shared.cdp_gateway_close":
            task = self._owned_task(params)
            if set(params) != {'owner', 'taskId'}:
                raise ProtocolError('invalid_params', 'invalid gateway close request')
            self.cdp_gateway.revoke(task['id'])
            return {'closed': True}
        if method == "shared.diagnostics":
            return self._shared_diagnostics(params)
        if method == "shared.list":
            owner = self._required_string(params, "owner")
            with self.state_lock:
                return [self._public_task(task) for task in self.tasks.values() if task["owner"] == owner]
        if method == "shared.run":
            return self._run_task(params)
        if method == "shared.cancel":
            return self._release_task(params, "cancelled", True)
        if method == "shared.close":
            return self._release_task(params, "closed", True)
        if method == "shared.handoff":
            return self._release_task(params, "closed", True, handoff_if_pending=True)
        if method == "shared.cleanup_status":
            return self._cleanup_status(params)
        if method == "shared.cleanup_retry":
            return self._cleanup_retry(params)
        if method == "shared.resume":
            return self._resume_task(params)
        raise ProtocolError("unknown_method", "unknown method")

    def _browser_access_request(self, params: Dict[str, Any]) -> Dict[str, str]:
        if set(params) != {"instanceId"}:
            raise ProtocolError("invalid_params", "access request accepts only instanceId")
        instance_id = self._required_string(params, "instanceId")
        with self.state_lock:
            extension = self.extensions.get(instance_id)
            if extension is None:
                raise ProtocolError("instance_unavailable", "browser instance is not connected")
            if extension.get("accessRequestSupported") is not True:
                raise ProtocolError("access_request_unsupported", "browser extension does not support access requests")
            previous = extension.get("accessRequest")
            if isinstance(previous, dict):
                expired = (previous.get("status") in {"confirmation_requested", "unknown"}
                           and isinstance(previous.get("expiresAt"), (int, float))
                           and previous["expiresAt"] <= time.monotonic())
                if not expired:
                    status = "unknown" if previous.get("status") == "unknown" else "already_requested"
                    return {"requestId": previous["requestId"], "status": status}
                # The old prompt's window has ended. This call is a new explicit
                # user request, so it opens a fresh prompt under a new requestId;
                # the expired request itself is never replayed.
                extension["accessRequest"] = None
            request_id = secrets.token_urlsafe(18)
            connection_generation = extension.get("connectionGeneration")
            initial_status = extension.get("lastConsentStatus")
            if initial_status not in {"enabled", "disabled"}:
                initial_status = "unknown"
            extension["accessRequest"] = {
                "requestId": request_id,
                "status": "opening",
                "initialConsentStatus": initial_status,
                "expiresAt": time.monotonic() + 120.0,
            }

        response = None
        try:
            response = self._extension_call(extension, "extension.access_request", {
                "requestId": request_id,
                "instanceId": instance_id,
                "connectionGeneration": connection_generation,
            }, timeout=10.0)
        except Exception:
            # Opening a UI is a side effect; on lost response, never issue it
            # again for this connection. The request outcome stays unknown.
            pass

        opened = (
            isinstance(response, dict)
            and set(response) == {"requestId", "instanceId", "connectionGeneration", "status"}
            and response.get("requestId") == request_id
            and response.get("instanceId") == instance_id
            and response.get("connectionGeneration") == connection_generation
            and response.get("status") == "opened"
        )
        with self.state_lock:
            current = self.extensions.get(instance_id) is extension
            request = extension.get("accessRequest")
            if not current or not isinstance(request, dict) or request.get("requestId") != request_id:
                return {"requestId": request_id, "status": "unknown"}
            request["status"] = "confirmation_requested" if opened else "unknown"
            if opened and request.get("closed") is True:
                # The extension reported its management UI closed before the
                # open acknowledgement was processed; the prompt has ended.
                extension["accessRequest"] = None
            return {"requestId": request_id, "status": request["status"]}

    def _access_request_closed(self, instance_id: str, params: Dict[str, Any]) -> Dict[str, bool]:
        """Retire the current prompt when the extension's own UI reports it closed.

        This carries no consent information; consent is only ever read back via
        browser.list. It lets the user explicitly request a new prompt without
        waiting for the expiry window.
        """
        if set(params) != {"requestId", "connectionGeneration"}:
            raise ProtocolError("invalid_params", "access request close accepts requestId and connectionGeneration")
        request_id = self._required_string(params, "requestId")
        generation = self._required_string(params, "connectionGeneration")
        with self.state_lock:
            extension = self.extensions.get(instance_id)
            if extension is None or extension.get("connectionGeneration") != generation:
                return {"closed": False}
            request = extension.get("accessRequest")
            if not isinstance(request, dict) or request.get("requestId") != request_id:
                return {"closed": False}
            if request.get("status") == "opening":
                request["closed"] = True
            else:
                extension["accessRequest"] = None
            return {"closed": True}

    def _create_task(self, params: Dict[str, Any]) -> Dict[str, Any]:
        owner = self._required_string(params, "owner")
        title = self._required_string(params, "title")
        instance_id = self._required_string(params, "instanceId")
        origins = self._validate_origins(params.get("allowedOrigins"))
        # 中文注释：页面请求只受任务来源与浏览器模式控制，不预登记单独的 URL 清单。
        if 'apiUrls' in params:
            raise ProtocolError('invalid_params', 'separate API URL scope is not supported')
        with self.state_lock:
            extension = self.extensions.get(instance_id)
            if extension is None:
                raise ProtocolError("instance_unavailable", "browser instance is not connected")
            now = time.time()
            task_id = secrets.token_urlsafe(18)
            task = {
                "id": task_id,
                "owner": owner,
                "title": title,
                "instanceId": instance_id,
                "browser": extension["browser"],
                "state": "pending_approval",
                "generation": 1,
                "activeMode": "smart",
                "modeGeneration": 1,
                "approvalScope": secrets.token_urlsafe(24),
                "allowedOrigins": origins,
                "readOrigins": [],
                "tabIds": [],
                "agentTabIds": [],
                "workTabs": [],
                "workspaceState": "ready",
                "requestHistory": [],
                # 中文注释：浏览器把本任务下载写入 hermes-tasks/<downloadKey>/；代次变化时更换。
                "downloadKey": new_download_key(),
                "createdAt": now,
                "updatedAt": now,
                "isolation": "shared-profile",
            }
            self.tasks[task_id] = task
            self.task_locks[task_id] = threading.RLock()
            self.cleanup_locks[task_id] = threading.Lock()
            self.dedupe[task_id] = {}
            self._persist_tasks()
        self._notify_tasks_changed(instance_id)
        return self._public_task(task)

    def _pending_action(self, task, params, request_hash, payload_hash, pending_notifications, read_origin=None):
        key = (task['id'], request_hash)
        pending = self.action_approvals.get(key)
        if pending is not None:
            if pending['digest'] != payload_hash:
                raise ProtocolError('request_id_conflict', 'requestId is already bound to another payload')
            if pending.get('readOrigin') != read_origin:
                raise ProtocolError('approval_revoked', 'the site changed before approval', {'outcomeUnknown': False})
        else:
            if len(self.action_approvals) >= 256:
                raise ProtocolError('approval_capacity', 'too many pending approvals')
            pending = {'nonce': secrets.token_urlsafe(32), 'digest': payload_hash,
                       'params': json.loads(json.dumps(params)), 'expiresAt': time.time() + self.approval_ttl,
                       'generation': task['generation'], 'modeGeneration': task.get('modeGeneration', 1),
                       'status': 'approval_required', **({'readOrigin': read_origin} if read_origin else {})}
            self.action_approvals[key] = pending
            task.setdefault("requestHistory", []).append({"requestIdHash": request_hash, "payloadHash": payload_hash,
                "state": "awaiting_approval", "dispatched": False, "generation": task["generation"],
                "modeGeneration": task.get('modeGeneration', 1)})
            self._persist_tasks()
            # Deliver only after _run_task_impl releases both task and state locks.
            pending_notifications.append(task['instanceId'])
        return self._pending_view(pending, params['requestId'])

    @staticmethod
    def _pending_view(pending, request_id):
        if pending.get('kind') == 'manual_input':
            return {'status': pending['status'], 'requestId': request_id, 'digest': pending['digest'],
                    'expiresAt': pending['expiresAt'], 'fieldKind': pending['fieldKind'],
                    'message': '这是敏感字段，已请用户在浏览器中亲自填写；本工具不会填写或读取其内容。'
                               '用户完成后，用相同请求编号和参数查询结果。'}
        return {'status': pending['status'], 'requestId': request_id, 'digest': pending['digest'],
                'expiresAt': pending['expiresAt'],
                'message': ('请先确认本任务读取该网站；写入和调试命令仍需逐项批准。批准后用相同请求编号和参数查询结果。'
                            if pending.get('readOrigin') else
                            '请在浏览器扩展中确认这一次操作；确认后用相同请求编号和参数查询结果，不会重新执行。')}

    def _manual_input_action(self, task, params, request_hash, payload_hash, pending_notifications, field_kind):
        key = (task['id'], request_hash)
        if key in self.action_approvals:
            return self._pending_action(task, params, request_hash, payload_hash, pending_notifications)
        if len(self.action_approvals) >= 256:
            raise ProtocolError('approval_capacity', 'too many pending approvals')
        pending = {'nonce': secrets.token_urlsafe(32), 'digest': payload_hash,
                   'params': json.loads(json.dumps(params)), 'expiresAt': time.time() + self.manual_input_ttl,
                   'generation': task['generation'], 'modeGeneration': task.get('modeGeneration', 1),
                   'status': 'user_input_required', 'kind': 'manual_input',
                   'fieldKind': field_kind if field_kind in {'password', 'payment', 'otp'} else 'sensitive'}
        self.action_approvals[key] = pending
        task.setdefault("requestHistory", []).append({"requestIdHash": request_hash, "payloadHash": payload_hash,
            "state": "awaiting_human", "dispatched": False, "generation": task["generation"]})
        self._persist_tasks()
        pending_notifications.append(task['instanceId'])
        return self._pending_view(pending, params['requestId'])

    def _run_task(self, params: Dict[str, Any], _approval=None, _gateway=False) -> Any:
        correlation = uuid.uuid4().hex
        started = time.monotonic()
        self._diagnostic("request_state", "running", correlation, action=params.get('action') if params.get('action') in V1_ACTIONS else None)
        pending_notifications = []
        try:
            result = self._run_task_impl(params, _approval, pending_notifications, _gateway)
        except Exception as exc:
            unknown = not isinstance(exc, ProtocolError) or (
                exc.data.get("outcomeUnknown") if "outcomeUnknown" in exc.data else
                exc.code in {"extension_timeout", "extension_disconnected", "request_outcome_unavailable", "needs_sync", "workspace_unknown"})
            code = self._diagnostic_error_code(exc)
            duration_ms = (time.monotonic() - started) * 1000
            self._diagnostic("request_state", "unknown" if unknown else "failed", correlation, duration_ms, code,
                             action=params.get('action') if params.get('action') in V1_ACTIONS else None)
            self._record_task_request_diagnostic(
                params, "unknown" if unknown else "failed", duration_ms,
                self._diagnostic_error_code(exc),
            )
            # 中文注释：重复在途查询不是原动作失败，不能覆盖原动作的运行状态。
            if not (isinstance(exc, ProtocolError) and exc.data.get("inFlight") is True):
                self._finish_ui_operation(params, "unknown" if unknown else "failed", duration_ms, self._diagnostic_error_code(exc))
            raise
        finally:
            for instance_id in pending_notifications:
                self._notify_tasks_changed(instance_id)
        status = "pending" if isinstance(result, dict) and result.get("status") in {"approval_required", "approved", "executing"} else "succeeded"
        duration_ms = (time.monotonic() - started) * 1000
        target_summary = result.pop('_targetSummary', None) if isinstance(result, dict) else None
        self._diagnostic("request_state", status, correlation, duration_ms,
                         action=params.get('action') if params.get('action') in V1_ACTIONS else None)
        self._record_task_request_diagnostic(params, status, duration_ms)
        self._finish_ui_operation(params, status, duration_ms, target_summary=target_summary)
        if params.get("action") == "page.parse" and isinstance(result, dict) and result.get("schemaVersion") == 1:
            with self.state_lock:
                task = self.tasks.get(params.get("taskId"))
                if task and task.get("owner") == params.get("owner") and task.get("state") == "ready":
                    self.page_results[task["id"]] = {"generation": task["generation"], "receivedAt": time.time(), "result": result}
                    self.page_results.move_to_end(task["id"])
                    while len(self.page_results) > 16:
                        self.page_results.popitem(last=False)
        return result

    def _finish_ui_operation(self, params, status, duration, code=None, target_summary=None):
        """中文注释：仅更新已派发且身份一致的操作，重复查询不追加假步骤。"""
        if not isinstance(params, dict) or not isinstance(params.get("requestId"), str):
            return
        instance_id = None
        with self.state_lock:
            task = self.tasks.get(params.get("taskId"))
            if not task or task.get("owner") != params.get("owner"):
                return
            operation = task.get("currentOperation")
            if not operation or operation.get("requestIdHash") != _sha256(params["requestId"]) or operation.get("state") != "running":
                return
            operation.update(state=status, durationMs=round(duration), completedAt=time.time())
            if code:
                operation["errorCode"] = code
            task["operationTimeline"] = (task.get("operationTimeline", []) + [dict(operation)])[-32:]
            try:
                self._append_task_log(task['id'], operation, target_summary)
            except (OSError, ValueError, ProtocolError):
                # 中文注释：日志写入失败不能把已派发动作改报失败或触发重放。
                pass
            task["lastActivityAt"] = time.time()
            self._persist_tasks()
            instance_id = task['instanceId']
        if instance_id:
            self._notify_tasks_changed(instance_id)

    def _run_task_impl(self, params: Dict[str, Any], _approval, pending_notifications, _gateway=False) -> Any:
        task = self._owned_task(params)
        task_id = task["id"]
        control_epoch = task.get('controlEpoch', 0)
        action = self._required_string(params, "action")
        self._validate_run_params(action, params)  # Before cached responses or approval lookup.
        request_id = self._required_string(params, "requestId")
        fingerprint = json.dumps(
            {key: value for key, value in params.items() if key not in {"owner", "requestId"}},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        request_hash = _sha256(request_id)
        payload_hash = _sha256(fingerprint)
        lock = self.task_locks[task_id]
        with lock:
            with self.state_lock:
                self._expire_approvals_locked()
                # 中文注释：撤权后连缓存结果也不再返回，旧任务不会因重新开启访问而复活。
                if task.get('accessRevoked'):
                    raise ProtocolError('browser_access_revoked', '浏览器访问已撤销；重新开启后请创建新任务', {'outcomeUnknown': False})
            inflight = self.inflight_requests.get((task_id, request_hash)) or self.preparing_requests.get((task_id, request_hash))
            if inflight is not None:
                if inflight != payload_hash:
                    raise ProtocolError('request_id_conflict', 'requestId is already bound to another payload')
                raise ProtocolError('request_outcome_unavailable', 'request is in flight; it will not be replayed', {'outcomeUnknown': True, 'inFlight': True})
            if task['state'] in {'closed', 'cancelled'}:
                raise ProtocolError('task_closed', '任务已结束；请重新 browser_shared_open', {'outcomeUnknown': False})
            if task['state'] == 'paused' or task.get('controlEpoch', 0) != control_epoch:
                raise ProtocolError('task_paused', '用户已接管，任务已暂停，请等待用户继续', {'outcomeUnknown': False, 'retryable': False})
            # 中文注释：新任务授权由扩展异步安装；未就绪时明确告知查询状态，不能把它当成已派发动作。
            if task['state'] in {'pending_approval', 'authorizing'}:
                raise ProtocolError('task_preparing', '任务授权尚未就绪；请查询任务状态，ready 后重新调用',
                                    {'outcomeUnknown': False, 'retryable': True})
            cached = self.dedupe[task_id].get(request_hash)
            if cached is not None:
                if cached[0] != payload_hash:
                    raise ProtocolError("request_id_conflict", "requestId is already bound to another payload")
                if task.get('activeMode') == 'smart' and action in SITE_READ_ACTIONS and cached[1] == 'result':
                    prior = next((row for row in task.get('requestHistory', []) if row.get('requestIdHash') == request_hash), None)
                    if prior is None or prior.get('modeGeneration') != task.get('modeGeneration', 1):
                        raise ProtocolError('approval_revoked', 'site read approval changed; use a new requestId',
                                            {'outcomeUnknown': False})
                # 中文注释：私有写入或脚本网关批准已消费后，同一请求不得误报仍可执行。
                if action in {'vault.authorize', 'gateway.authorize'} and task.get('activeMode') == 'smart' and cached[1] == 'result':
                    permit = task.get('vaultPermit' if action == 'vault.authorize' else 'gatewayPermit')
                    if permit is None or permit.get('requestIdHash') != request_hash:
                        raise ProtocolError('approval_consumed', 'approval was already used; use a new requestId',
                                            {'outcomeUnknown': False})
                if cached[1] is None:
                    raise ProtocolError(
                        "request_outcome_unavailable",
                        "request result was evicted or the daemon restarted; this request will not be replayed",
                    )
                if cached[1] == "error":
                    error = cached[2]
                    raise ProtocolError(error["code"], error["message"], error.get("data"))
                return cached[2]
            if len(task.get("requestHistory", [])) >= self.request_history_limit and (task_id, request_hash) not in self.action_approvals:
                raise ProtocolError(
                    "request_history_full",
                    "task requestId history is full; close this task and create a new one",
                )
            self.preparing_requests[(task_id, request_hash)] = payload_hash
            read_origin = None
            try:
                with _outside_task_lock(lock):
                    if action in SITE_READ_ACTIONS and task.get('activeMode') == 'smart':
                        with self.state_lock:
                            extension = self.extensions.get(task['instanceId'])
                            if (task['state'] not in {'ready', 'running'} or extension is None
                                    or self.tab_leases.get((task['instanceId'], params.get('tabId'))) != task_id):
                                raise ProtocolError('foreign_tab', 'read tab is not leased to this task', {'outcomeUnknown': False})
                            scope = {'taskId': task_id, 'generation': task['generation'],
                                     'modeGeneration': task.get('modeGeneration', 1), 'tabId': params['tabId']}
                        # 中文注释：只取浏览器当前顶层来源，审批前不读取标题、DOM 或截图。
                        observed = self._extension_call(extension, 'browser.read_origin', scope)
                        read_origin = observed.get('origin') if isinstance(observed, dict) else None
                        if read_origin not in task['allowedOrigins'] and isinstance(read_origin, str):
                            # 中文注释：已租页的扩展回读可证明延迟提交的 apex/www 跳转。
                            with self.state_lock:
                                if (task['state'] in {'ready', 'running'} and
                                        self.tab_leases.get((task['instanceId'], params['tabId'])) == task_id and
                                        any(self._www_redirect_origin(site+'/', read_origin+'/') == read_origin
                                            for site in task['allowedOrigins'])):
                                    task['allowedOrigins'].append(read_origin)
                                    self._persist_tasks()
                        if read_origin not in task['allowedOrigins'] and read_origin != 'about:blank':
                            raise ProtocolError('tab_out_of_scope', 'read tab origin is not in task scope', {'outcomeUnknown': False, 'currentOrigin': read_origin, 'scopeHint': '同站用 goto_url，新站用 browser_shared_open。'})
                    artifact_payload = None
                    if action == "files.upload":
                        with self.state_lock:
                            # 中文注释：读取本地路径前先核对工作页租约，避免无效标签请求也复制用户文件。
                            if task["state"] not in {"ready", "running"} or self.tab_leases.get((task["instanceId"], params.get("tabId"))) != task_id:
                                raise ProtocolError("foreign_tab", "tab is not leased to this task", {"outcomeUnknown": False})
                        try:
                            store = ArtifactStore(self.home)
                            # 中文注释：对话中给出的本地路径先复制进任务私有区，再与用户登记的文件走同一条选择链路。
                            registered = [store.register_path(task=task, owner=task["owner"], path=item)
                                          for item in params.get("paths", [])]
                            available = {row["id"]: row for row in store.list(task=task, owner=task["owner"])}
                            selected = [available[item] for item in params.get("artifactIds") or [row["id"] for row in registered]]
                            origins = {item["origin"] for item in selected}
                            if len(origins) != 1:
                                raise ArtifactError("ARTIFACT_SCOPE_DENIED")
                            selected_origin = next(iter(origins))
                            paths = [str(store.resolve(task=task, owner=task["owner"], origin=selected_origin,
                                                       artifact_id=item["id"])[1]) for item in selected]
                            # 中文注释：路径来自当前任务私有登记并重验摘要，绝不从模型参数取得。
                            artifact_payload = {"filePaths": paths,
                                                "artifactOrigin": None if selected_origin == LOCAL_PATH_ORIGIN else selected_origin}
                        except (ArtifactError, KeyError) as exc:
                            if isinstance(exc, ArtifactError) and str(exc) in {"PATH_DENIED", "PATH_UNAVAILABLE", "SIZE_LIMIT", "ARTIFACT_LIMIT"}:
                                raise ProtocolError("file_path_unavailable", "local file is missing, not a regular file or too large",
                                                    {"outcomeUnknown": False}) from None
                            raise ProtocolError("artifact_unavailable", "approved task file is unavailable",
                                                {"outcomeUnknown": False}) from None

                    # V1 action and argument validation already ran before cache lookup.
                    # Safe-field assessment is read-only and precedes presenting a
                    # confirmation. Never hold the global state lock over browser I/O.
                    if action in {'fill', 'press', 'ref_fill', 'ref_press'} and _approval is None and (task_id, request_hash) not in self.action_approvals:
                        with self.state_lock:
                            ext = self.extensions.get(task['instanceId'])
                            if task['state'] == 'paused':
                                raise ProtocolError('task_paused', '用户正在接管页面，退出接管后再继续', {'outcomeUnknown': False, 'retryable': False})
                            if task['state'] not in {'ready', 'running'} or ext is None:
                                raise ProtocolError('invalid_state', 'task is not ready')
                            if self.tab_leases.get((task['instanceId'], params.get('tabId'))) != task_id:
                                raise ProtocolError('foreign_tab', 'tab is not leased to this task')
                            assessment_params = {k:v for k,v in params.items() if k != 'owner'}
                            assessment_params.update(generation=task['generation'], allowedOrigins=list(task['allowedOrigins']))
                        assessed = self._extension_call(ext, 'browser.assess', assessment_params)
                        with self.state_lock:
                            if task['state'] not in {'ready', 'running'} or task['generation'] != assessment_params['generation']:
                                raise ProtocolError('invalid_state', 'task changed during assessment', {'outcomeUnknown': False})
                        target = assessed.get('targetAssessment') if isinstance(assessed, dict) else None
                        if target == 'sensitive':
                            # Never type secrets for the agent: ask the person to fill
                            # this field in the page. Nothing is dispatched to the page.
                            with self.state_lock:
                                return self._manual_input_action(task, params, request_hash, payload_hash,
                                                                 pending_notifications, assessed.get('fieldKind'))
                        if target != 'ordinary':
                            raise ProtocolError('execution_denied', 'safe field assessment required')
            finally:
                self.preparing_requests.pop((task_id, request_hash), None)
            with self.state_lock:
                # 中文注释：准备期间任务锁已释放，派发登记前再次检查账本容量。
                if len(task.get('requestHistory', [])) >= self.request_history_limit and (task_id, request_hash) not in self.action_approvals:
                    raise ProtocolError('request_history_full', 'task requestId history is full')
                if task["state"] == "paused" or task.get("controlEpoch", 0) != control_epoch:
                    raise ProtocolError("task_paused", "用户已接管，任务已暂停，请等待用户继续", {"outcomeUnknown": False, "retryable": False})
                if task.get('accessRevoked'):
                    raise ProtocolError('browser_access_revoked', '浏览器访问已撤销；请创建新任务', {'outcomeUnknown': False})
                # 中文注释：动作准备期间授权状态仍可变化；此处再次检查以免返回含糊的状态错误。
                if task['state'] in {'pending_approval', 'authorizing'}:
                    raise ProtocolError('task_preparing', '任务授权尚未就绪；请查询任务状态，ready 后重新调用',
                                        {'outcomeUnknown': False, 'retryable': True})
                if task["state"] not in {"ready", "running"}:
                    raise ProtocolError("task_closed" if task["state"] in {"closed", "cancelled"} else "invalid_state",
                                        "task is not ready", {"outcomeUnknown": False})
                extension = self.extensions.get(task["instanceId"])
                if extension is None:
                    raise ProtocolError("instance_unavailable", "browser instance is not connected")
                tab_id = params.get("tabId")
                if action not in {"tabs", "new_tab", "official.new_tab", "gateway.authorize"}:
                    if not isinstance(tab_id, int) or isinstance(tab_id, bool):
                        raise ProtocolError("tab_required", "this action requires an explicit tabId")
                    if self.tab_leases.get((task["instanceId"], tab_id)) != task_id:
                        raise ProtocolError("foreign_tab", "tab is not leased to this task")
                if action in SCRIPT_ACTIONS:
                    # 中文注释：脚本和调试命令在智能审批模式走本次动作审批；凭据同页互斥仍独立生效。
                    if tab_id in task.get('credentialTabs', []):
                        raise ProtocolError('credential_mode_conflict', 'credential page cannot run scripts', {'outcomeUnknown': False})
                    touched = task.setdefault('scriptedTabs', [])
                    if tab_id not in touched:
                        touched.append(tab_id)
                if action == 'vault.authorize' and tab_id in task.get('scriptedTabs', []):
                    raise ProtocolError('credential_mode_conflict', 'scripted page cannot receive credentials', {'outcomeUnknown': False})
                if action in {"navigate", "new_tab", "official.goto_url", "official.new_tab"}:
                    if action != 'official.new_tab' or params.get('url') != 'about:blank':
                        try:
                            self._validate_action_url(params.get("url"), task["allowedOrigins"])
                        except ProtocolError as exc:
                            # 中文注释：仅拒绝时回读当前来源，成功导航不增加往返；不读取正文或扩大授权。
                            if exc.code == 'origin_denied':
                                exc.data['scopeHint'] = '同站用 goto_url，新站用 browser_shared_open。'
                            if exc.code == 'origin_denied' and type(params.get('tabId')) is int:
                                scope = {'taskId': task_id, 'generation': task['generation'],
                                         'modeGeneration': task.get('modeGeneration', 1), 'tabId': params['tabId']}
                                try:
                                    observed = self._extension_call(self.extensions[task['instanceId']], 'browser.read_origin', scope, timeout=1.0)
                                    current = observed.get('origin') if isinstance(observed, dict) else None
                                except Exception as origin_error:
                                    # 中文注释：诊断回读失败不能替换原来的跨站拒绝。
                                    data = getattr(origin_error, 'data', {})
                                    current = data.get('currentOrigin') if isinstance(data, dict) else None
                                try:
                                    parsed = urlsplit(current) if isinstance(current, str) else None
                                    if parsed:
                                        parsed.port
                                except ValueError:
                                    parsed = None
                                if parsed and parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password:
                                    exc.data['currentOrigin'] = f'{parsed.scheme}://{parsed.netloc}'
                            raise
                if action == 'api_request':
                    if set(params) - {'owner', 'taskId', 'requestId', 'action', 'tabId', 'url', 'httpMethod', 'fields'}:
                        raise ProtocolError('invalid_params', 'unknown API arguments')
                    # 中文注释：页面请求沿用当前任务来源与两档模式，不再要求独立 API 授权。
                    self._validate_action_url(params.get('url'), task['allowedOrigins'])
                    if params.get('httpMethod', 'GET') not in {'GET', 'HEAD'}:
                        raise ProtocolError('invalid_params', 'read methods only')
                site_origin = None if read_origin == 'about:blank' else read_origin
                if task.get('activeMode') == 'smart' and action in SITE_NAV_ACTIONS and params.get('url') != 'about:blank':
                    parsed = urlsplit(params['url'])
                    site_origin = f'{parsed.scheme}://{parsed.netloc}'
                grant_origin = (site_origin if task.get('activeMode') == 'smart' and site_origin
                                and site_origin not in task.setdefault('readOrigins', []) else None)
                pending = self.action_approvals.get((task_id, request_hash))
                if pending is not None and _approval is not pending:
                    return self._pending_action(task, params, request_hash, payload_hash, pending_notifications,
                                                pending.get('readOrigin') if pending.get('readOrigin') == site_origin else grant_origin)
                if _approval is not None:
                    if (pending is None or _approval is not pending or pending['status'] != 'approved'
                            or pending['digest'] != payload_hash or pending['generation'] != task['generation']
                            or pending['modeGeneration'] != task.get('modeGeneration', 1)
                            or pending['expiresAt'] <= time.time()
                            or pending.get('readOrigin') not in {None, site_origin}):
                        raise ProtocolError('approval_revoked', 'approval expired or revoked')
                    pending['status'] = 'executing'
                elif grant_origin and action in SITE_READ_ACTIONS and not _gateway:
                    return self._pending_action(task, params, request_hash, payload_hash, pending_notifications, grant_origin)
                elif (action not in {'tabs', 'snapshot', 'screenshot', 'page.observe', 'page.parse', 'semantic_snapshot', 'frame_catalog', 'interaction.capture', 'interaction.bounds', 'official.ready_state', 'images', 'console'}
                      and not _gateway
                      and task.get('activeMode', 'smart') != 'full'):
                    return self._pending_action(task, params, request_hash, payload_hash, pending_notifications, grant_origin)
                if _approval is not None and pending.get('readOrigin'):
                    approved = task.setdefault('readOrigins', [])
                    if pending['readOrigin'] not in approved:
                        approved.append(pending['readOrigin'])
                task["state"] = "running"
                task["updatedAt"] = time.time()
                # 中文注释：只记录固定动作与时间，不把参数/输入/页面正文混入状态日志。
                task["currentOperation"] = {"action": action, "state": "running", "startedAt": time.time(), "requestIdHash": request_hash, "tabId": tab_id}
                generation = task["generation"]
                mode_generation = task.get("modeGeneration", 1)
                # 中文注释：派发前先持久化最小账本；响应丢失时只能核实，不能重放写动作。
                entry = next((row for row in task.setdefault("requestHistory", [])
                              if row.get("requestIdHash") == request_hash), None)
                if entry is None:
                    entry = {"requestIdHash": request_hash, "payloadHash": payload_hash,
                             "modeGeneration": task.get('modeGeneration', 1)}
                    task["requestHistory"].append(entry)
                entry.update(state="dispatched", dispatched=True, generation=generation, action=action)
                self._persist_tasks()
                self.inflight_requests[(task_id, request_hash)] = payload_hash

            command_params = {
                key: value
                for key, value in params.items()
                if key not in {"owner", "paths"}
            }
            # 中文注释：扩展只接收已核对的任务私有文件路径，不接收对话里的原始本地路径。
            command_params["taskId"] = task_id
            command_params["generation"] = generation
            command_params["modeGeneration"] = mode_generation
            if _approval is not None:
                command_params["approval"] = {"nonce": _approval["nonce"], "digest": _approval["digest"]}
            command_params["allowedOrigins"] = list(task["allowedOrigins"])
            if task.get('activeMode') == 'smart' and action in SITE_READ_ACTIONS and site_origin:
                command_params['approvedReadOrigin'] = site_origin
            if artifact_payload is not None:
                command_params.update(artifact_payload)
            try:
                with _outside_task_lock(lock):
                    self._persist_dispatched(task, entry)
                    if action in {'gateway.authorize', 'vault.authorize'}:
                        # 中文注释：批准 browser_exec 或 Vault 私有写入后只签发一次资格，不派发页面动作。
                        result = {'authorized': True}
                    elif action == 'api_request':
                        result = self._api_request(task, extension, command_params)
                    else:
                        if action.startswith("interaction.") or action in {"js.evaluate", "cdp.send"}:
                            # 中文注释：浏览器端先执行 CDP 截止时间，daemon 再给结果传播留 5 秒；超时仍按未知写入处理。
                            timeout = (params.get("timeoutMs", 30000) / 1000 + 5.0) if action == "cdp.send" else (
                                75.0 if action == "js.evaluate" else 30.0)
                            result = self._extension_call(extension, "browser.execute", command_params,
                                                          timeout=timeout)
                        else:
                            result = self._extension_call(extension, "browser.execute", command_params)
                        if isinstance(result, dict) and "__hermesChunked" in result:
                            # 中文注释：工具通道单行上限 1MB；超限结果已执行但不回传正文，改用网关或更小的请求。
                            size = result["__hermesChunked"].get("size") if isinstance(result["__hermesChunked"], dict) else None
                            result = {"executed": True, "resultTooLarge": True,
                                      "size": size if type(size) is int else None}
            except ProtocolError as exc:
                cleanup = False
                # 中文注释：滚动已派发后的超时仍有副作用不确定性。
                read_only = action in {"tabs", "snapshot", "screenshot", "page.observe", "page.parse", "semantic_snapshot", "frame_catalog", "interaction.capture", "interaction.bounds", "official.ready_state", "cdp.events", "network.inspect", "images", "console"}
                uncertain_official_write = (action in {'official.new_tab','official.goto_url'}
                                            and exc.data.get('outcomeUnknown') is True)
                if read_only and exc.code in {"extension_timeout", "extension_disconnected"}:
                    exc.data = {"outcomeUnknown": False, "retryable": False}
                with self.state_lock:
                    if task["state"] == "running" and task["generation"] == generation:
                        # 中文注释：单次扩展超时不证明任务代次或标签归属变化；只冻结该请求的重放。
                        if exc.code in {"extension_disconnected", "workspace_unknown"} or uncertain_official_write:
                            self._record_request_locked(task, request_hash, payload_hash, None, None)
                            self._revoke_task_locked(task, "needs_sync")
                            cleanup = True
                        else:
                            self._record_request_locked(
                                task,
                                request_hash,
                                payload_hash,
                                {"code": exc.code, "message": exc.message, "data": exc.data},
                                "error",
                            )
                            task["state"] = "running" if any(key[0] == task_id and key[1] != request_hash for key in self.inflight_requests) else "ready"
                            task["updatedAt"] = time.time()
                        self._persist_tasks()
                    elif task["generation"] == generation:
                        self._record_request_locked(task, request_hash, payload_hash, None, None)
                        self._persist_tasks()
                        cleanup = exc.code in {"extension_disconnected", "workspace_unknown"} or uncertain_official_write
                if cleanup:
                    self._best_effort_release(extension, task_id, generation, False)
                # 中文注释：在途动作已撤权时仍保留副作用不确定性，不把扩展的迟到拒绝误报为一般执行失败。
                if task.get('accessRevoked'):
                    raise ProtocolError('browser_access_revoked', '浏览器访问已撤销；动作不会重放',
                                        {'outcomeUnknown': not read_only, 'retryable': False}) from None
                raise
            except Exception:
                # A dispatched full-mode operation is also uncertain on an unexpected
                # adapter failure, not just an approval worker operation.
                with self.state_lock:
                    self._record_request_locked(task, request_hash, payload_hash, None, None)
                    # 中文注释：迟到异常只撤销它所属的运行代次，不能覆盖停止或恢复后的任务状态。
                    if task['generation'] == generation and task['state'] == 'running':
                        self._revoke_task_locked(task, "needs_sync")
                    self._persist_tasks()
                try:
                    self._best_effort_release(extension, task_id, generation, False)
                except Exception:
                    pass
                raise

            race_cleanup = False
            changed_state = None
            post_error = None
            # Only an explicit link-navigation request plus its positive result
            # creates ownership. Ordinary clicks/popups never establish it.
            opened_task_tab = action in {"new_tab", "official.new_tab"} or (
                action in {"click", "ref_click"}
                and params.get("clickMode") == "open_link_in_task_tab"
                and isinstance(result, dict)
                and result.get("openedVia") == "safe_link_navigation"
                and result.get("clicked") is False
                and result.get("unsupported") is not True
            )
            if action == 'official.new_tab' and (not isinstance(result, dict)
                    or not isinstance(result.get('targetId'), str) or not result['targetId']
                    or type(result.get('tabId')) is not int):
                with self.state_lock:
                    self._record_request_locked(task, request_hash, payload_hash, None, None)
                    # 中文注释：无效旧回执仍报告未知，但不能撤销已重新批准的新代次。
                    if task['generation'] == generation and task['state'] == 'running':
                        self._revoke_task_locked(task, 'needs_sync')
                    self._persist_tasks()
                self._best_effort_release(extension, task_id, generation, False)
                raise ProtocolError('invalid_extension_result', 'real targetId readback required',
                                    {'outcomeUnknown': True})
            with self.state_lock:
                # 中文注释：标签集合可以随同任务建页变化，真正的授权边界是代次、模式及控制状态。
                if (task["state"] not in {"ready", "running"} or task["generation"] != generation
                        or task.get("modeGeneration", 1) != mode_generation
                        or task.get("controlEpoch", 0) != control_epoch or task.get("accessRevoked")):
                    changed_state = task["state"]
                    self._record_request_locked(task, request_hash, payload_hash, None, None)
                    if task["generation"] == generation and task["state"] in {"ready", "running"}:
                        task["state"] = "running" if any(key[0] == task_id for key in self.inflight_requests) else "ready"
                    race_cleanup = (
                        opened_task_tab
                        and (task["generation"] != generation or task["state"] in {"cancelled", "closed", "needs_sync"})
                        and isinstance(result, dict)
                        and isinstance(result.get("tabId"), int)
                        and not isinstance(result.get("tabId"), bool)
                    )
                    self._persist_tasks()
                else:
                    if opened_task_tab:
                        if not isinstance(result, dict) or not isinstance(result.get("tabId"), int) or isinstance(result.get("tabId"), bool):
                            self._record_request_locked(task, request_hash, payload_hash, None, None)
                            self._revoke_task_locked(task, "needs_sync")
                            self._persist_tasks()
                            post_error = ProtocolError("invalid_extension_result", "new_tab did not return a tabId")
                        else:
                            new_tab_id = result["tabId"]
                            holder = self.tab_leases.get((task["instanceId"], new_tab_id))
                            if holder is not None and holder != task_id:
                                # 中文注释：并发新建页冲突只拒绝本次回执，其他入口维持原清理契约。
                                if action == "new_tab":
                                    post_error = ProtocolError("task_busy", "new tab collides with another task lease",
                                                               {"outcomeUnknown": True, "retryable": False})
                                    self._record_request_locked(task, request_hash, payload_hash,
                                        {"code": post_error.code, "message": post_error.message, "data": post_error.data}, "error")
                                    task["state"] = "running" if any(key[0] == task_id for key in self.inflight_requests) else "ready"
                                else:
                                    self._record_request_locked(task, request_hash, payload_hash, None, None)
                                    self._revoke_task_locked(task, "needs_sync")
                                    post_error = ProtocolError("lease_conflict", "new tab collides with another task lease")
                                self._persist_tasks()
                            else:
                                # 中文注释：同代次回收墓碑阻止乱序回执重新登记已关闭的标签。
                                retired = task.setdefault("retiredAgentTabs", {}).setdefault(str(generation), [])
                                closed = result.get("closedTabs", [])
                                if isinstance(closed, list):
                                    for old_id in closed:
                                        if type(old_id) is int and old_id != new_tab_id:
                                            if old_id not in retired:
                                                retired.append(old_id)
                                            self._forget_agent_tab_locked(task, old_id)
                                if new_tab_id not in retired:
                                    self.tab_leases[(task["instanceId"], new_tab_id)] = task_id
                                    if new_tab_id not in task["tabIds"]:
                                        task["tabIds"].append(new_tab_id)
                                    if new_tab_id not in task["agentTabIds"]:
                                        task["agentTabIds"].append(new_tab_id)
                                    if action == 'official.new_tab' and params.get('url') == 'about:blank':
                                        task.setdefault("officialBlankTabs", []).append(new_tab_id)
                                    if all(type(result.get(k)) is int and result[k] >= 0 for k in ("groupId", "windowId")):
                                        task.setdefault("workTabs", []).append({k: result[k] for k in ("tabId", "groupId", "windowId")})
                                        task["workspaceState"] = "ready"
                    if post_error is None:
                        if action in {'new_tab', 'navigate'} and isinstance(result, dict) and isinstance(result.get('url'), str):
                            redirected = self._www_redirect_origin(params.get('url', ''), result['url'])
                            if redirected and redirected not in task['allowedOrigins']:
                                # 中文注释：扩展已完成来源核验后，守护进程同步任务范围供后续动作使用。
                                task['allowedOrigins'].append(redirected)
                        if action == 'gateway.authorize' and task['activeMode'] == 'smart':
                            task['gatewayPermit'] = {'requestIdHash': request_hash, 'codeDigest': params['codeDigest'],
                                                     'modeGeneration': task.get('modeGeneration', 1), 'expiresAt': time.time() + 120}
                        if action == 'vault.authorize' and task['activeMode'] == 'smart':
                            task['vaultPermit'] = {'requestIdHash': request_hash, 'handleDigest': params['handleDigest'],
                                                   'vaultAction': params['vaultAction'], 'tabId': params['tabId'],
                                                   'modeGeneration': task.get('modeGeneration', 1), 'expiresAt': time.time() + 120}
                        task["state"] = "running" if any(key[0] == task_id and key[1] != request_hash for key in self.inflight_requests) else "ready"
                        task["updatedAt"] = time.time()
                        self._record_request_locked(task, request_hash, payload_hash, result, "result")
                        self._persist_tasks()
            if post_error is not None:
                if post_error.code != "task_busy":
                    self._best_effort_release(extension, task_id, generation, False)
                raise post_error
            if changed_state is not None:
                if race_cleanup:
                    self._best_effort_release(extension, task_id, generation, False)
                if changed_state in {"cancelled", "closed"}:
                    with self.state_lock:
                        if task["state"] == changed_state and task["generation"] == generation:
                            task.update(cleanupState="unknown", cleanupReason="late_result")
                            for field in ("cleanupRemainingCount", "cleanupPreservedCount", "cleanupUnknownCount", "cleanupError"):
                                task.pop(field, None)
                            self.cleanup_proofs.pop(task_id, None)
                            self._persist_tasks()
                # 中文注释：授权或控制变化只拒绝迟到请求，原有撤权和终态清理仍保留。
                code = ("cancelled" if changed_state in {"cancelled", "closed"} else
                        "needs_sync" if changed_state == "needs_sync" else
                        "task_paused" if changed_state == "paused" else "task_busy")
                if task.get('accessRevoked'):
                    raise ProtocolError('browser_access_revoked', '浏览器访问已撤销；动作不会重放',
                                        {'outcomeUnknown': action not in {"tabs", "snapshot", "screenshot", "page.observe", "page.parse", "semantic_snapshot", "frame_catalog", "interaction.capture", "interaction.bounds", "official.ready_state", "cdp.events", "network.inspect", "images", "console"}})
                raise ProtocolError(code, "task authority changed while action was running",
                                    {"outcomeUnknown": True, "retryable": False})
            return result

    def _forget_agent_tab_locked(self, task, tab_id):
        """中文注释：回收只移除本任务模型页，绝不删除其他任务或用户页的租约。"""
        if tab_id not in task["agentTabIds"] or self.tab_leases.get((task["instanceId"], tab_id)) != task["id"]:
            return
        task["agentTabIds"].remove(tab_id)
        if tab_id in task["tabIds"]:
            task["tabIds"].remove(tab_id)
        task["workTabs"] = [row for row in task.get("workTabs", []) if row.get("tabId") != tab_id]
        self.tab_leases.pop((task["instanceId"], tab_id), None)

    def _record_request_locked(
        self,
        task: Dict[str, Any],
        request_hash: str,
        payload_hash: str,
        result: Any,
        outcome_kind: str | None,
    ) -> None:
        task_id = task["id"]
        self.inflight_requests.pop((task_id, request_hash), None)
        if request_hash in self.dedupe[task_id]:
            return
        if len(self.dedupe[task_id]) >= self.request_history_limit:
            raise ProtocolError("request_history_full", "task requestId history is full")
        self.dedupe[task_id][request_hash] = (payload_hash, outcome_kind, result)
        # 中文注释：仅淘汰结果本体；旧请求指纹保留并返回 unavailable，绝不再次派发。
        size = len(json.dumps(result, ensure_ascii=False).encode("utf-8"))
        self.result_cache[(task_id, request_hash)] = size
        self.result_cache_bytes += size
        while self.result_cache_bytes > 8 * 1024 * 1024 and self.result_cache:
            (old_task, old_request), old_size = self.result_cache.popitem(last=False)
            self.result_cache_bytes -= old_size
            old = self.dedupe.get(old_task, {}).get(old_request)
            if old:
                self.dedupe[old_task][old_request] = (old[0], None, None)
        entry = next((row for row in task.setdefault("requestHistory", [])
                      if row.get("requestIdHash") == request_hash), None)
        if entry is None:
            entry = {"requestIdHash": request_hash, "payloadHash": payload_hash}
            task["requestHistory"].append(entry)
        entry.update(state="confirmed" if outcome_kind == "result" else "rejected" if outcome_kind == "error" else "unknown",
                     dispatched=entry.get("dispatched") is True or outcome_kind in {"result", None},
                     generation=task["generation"])
        self.pending_journal.append(self._ledger_record(task, entry))

    def _operation_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        task = self._owned_task(params)
        request_id = self._required_string(params, "requestId")
        if len(request_id) > 128 or set(params) != {"owner", "taskId", "requestId"}:
            raise ProtocolError("invalid_params", "invalid operation status request")
        request_hash = _sha256(request_id)
        with self.state_lock:
            entry = next((row for row in task.get("requestHistory", [])
                          if row.get("requestIdHash") == request_hash), None)
            if entry is None:
                raise ProtocolError("request_not_found", "operation has no ledger entry", {"outcomeUnknown": False})
            state = entry.get("state")
            if state not in {"awaiting_approval", "awaiting_human", "dispatched", "confirmed", "rejected", "unknown"}:
                state = "unknown"
            generation = entry.get("generation")
            return {"requestIdHash": request_hash, "state": state,
                    "dispatched": entry.get("dispatched") is not False,
                    "generation": generation if type(generation) is int and generation >= 1 else None}

    def _revoke_task_locked(self, task: Dict[str, Any], state: str) -> None:
        self._revoke_api_locked(task)
        task.pop('gatewayPermit', None)
        task.pop('vaultPermit', None)
        task['readOrigins'] = []
        self.cdp_gateway.revoke(task['id'])
        task["activeMode"] = "smart"
        task["modeGeneration"] = task.get("modeGeneration", 1) + 1
        for key in list(self.action_approvals):
            if key[0] == task["id"]:
                self._finish_approval_locked(key, "approval_revoked", "授权已撤销，未继续执行")
        for tab_id in list(task["tabIds"]):
            if self.tab_leases.get((task["instanceId"], tab_id)) == task["id"]:
                del self.tab_leases[(task["instanceId"], tab_id)]
        task["state"] = state
        if state in {'closed', 'cancelled'}:
            # 中文注释：终态撤销未到期的宽限，不向外展示已经失效的关闭截止时间。
            task.pop('idleCloseAt', None)
        task["workspaceState"] = "unknown" if state == "needs_sync" else "cancelled"
        self._diagnostic("task_state", "unknown" if state == "needs_sync" else "cancelled")
        self._record_task_state_diagnostic(task, "unknown" if state == "needs_sync" else "cancelled")
        task["tabIds"] = []
        task["agentTabIds"] = []
        task["updatedAt"] = time.time()

    def _revoke_api_locked(self, task):
        self.api_credentials.pop(task['id'], None)
        conn = self.api_connections.pop(task['id'], None)
        if conn is not None:
            if hasattr(conn, '_api_abort'):
                conn._api_abort()
                return
            try:
                if conn.sock: conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

    def _api_request(self, task, extension, p):
        task_id, generation = task['id'], task['generation']
        def valid():
            with self.state_lock:
                return (task['state'] == 'running' and task['generation'] == generation
                        and self.extensions.get(task['instanceId']) is extension
                        and self.tab_leases.get((task['instanceId'], p['tabId'])) == task_id)
        def track(conn):
            with self.state_lock:
                if not valid():
                    conn.close()
                    raise ApiDenied('API authority revoked')
                self.api_connections[task_id] = conn
        credentials = None
        try:
            credentials = self._extension_call(extension, 'browser.credentials', {
                'taskId': task_id, 'generation': generation, 'tabId': p['tabId'], 'url': p['url']})
            with self.state_lock:
                if not valid(): raise ApiDenied('API authority revoked')
                if not isinstance(credentials, dict) or set(credentials) != {'cookies'}:
                    raise ApiDenied('invalid credentials response')
                self.api_credentials[task_id] = (generation, task['instanceId'], p['tabId'], p['url'], credentials)
            return self.api_client.request(p['url'], p.get('httpMethod', 'GET'), p.get('fields'), credentials['cookies'], valid, track)
        except ApiDenied:
            raise ProtocolError('api_denied', 'local API read denied or failed') from None
        finally:
            with self.state_lock:
                self.api_credentials.pop(task_id, None)
                self.api_connections.pop(task_id, None)
            if isinstance(credentials, dict): credentials.clear()

    def _best_effort_release(
        self,
        extension: Dict[str, Any],
        task_id: str,
        generation: int,
        close_agent_tabs: bool,
    ) -> None:
        try:
            self._extension_call(
                extension,
                "browser.release",
                {
                    "taskId": task_id,
                    "generation": generation,
                    "closeAgentTabs": close_agent_tabs,
                },
                timeout=1.0,
            )
        except (ProtocolError, OSError):
            pass

    def _resume_task(self, params: Dict[str, Any]) -> Dict[str, Any]:
        task = self._owned_task(params)
        lock = self.task_locks[task["id"]]
        with lock:
            with self.state_lock:
                if task.get('accessRevoked'):
                    raise ProtocolError('browser_access_revoked', '浏览器访问已撤销；请创建新任务', {'outcomeUnknown': False})
                if task["state"] not in {"cancelled", "needs_sync", "failed"}:
                    raise ProtocolError("invalid_state", "only a cancelled or unsynchronized task can be resumed")
                if task["instanceId"] not in self.extensions:
                    raise ProtocolError("instance_unavailable", "browser instance is not connected")
                for tab_id in list(task["tabIds"]):
                    if self.tab_leases.get((task["instanceId"], tab_id)) == task["id"]:
                        del self.tab_leases[(task["instanceId"], tab_id)]
                task["generation"] += 1
                task.pop('idleRecoveryState', None)
                task.pop('autoClosePending', None)
                task['readOrigins'] = []
                task["downloadKey"] = new_download_key()
                self.cleanup_proofs.pop(task["id"], None)
                task["state"] = "pending_approval"
                task["tabIds"] = []
                task["agentTabIds"] = []
                task["updatedAt"] = time.time()
                self._persist_tasks()
                result = self._public_task(task)
                # 中文注释：恢复会更换代次并撤销旧授权；明确告知下一步，避免把待批准误认为连接故障。
                result['nextStep'] = '等待扩展自动安装新代次授权；待任务 ready 后读取工作标签。当前模式以扩展显示的模式为准。'
                result['modeStatus'] = 'awaiting_extension_confirmation'
            self._notify_tasks_changed(task["instanceId"])
            return result

    def _release_task(self, params: Dict[str, Any], final_state: str, close_agent_tabs: bool, *, handoff_if_pending: bool = False, idle_check=None, stale_check=None) -> Dict[str, Any]:
        task = self._owned_task(params)
        with self.state_lock:
            if stale_check is not None:
                generation, activity, idle_seconds = stale_check
                eligible = task['state'] == 'ready' or (task['state'] == 'needs_sync' and task.get('idleRecoveryState') == 'ready')
                if (not eligible or self._pending_human(task) or task['generation'] != generation
                        or task.get('lastActivityAt', task.get('updatedAt', task['createdAt'])) != activity
                        or activity + idle_seconds > time.time()):
                    raise ProtocolError('task_busy', 'stale sweep snapshot changed or task not idle')
            if idle_check is not None:
                current = (task['generation'], task.get('idleCloseAt'), task.get('lastActivityAt'))
                if current != idle_check or not self._idle_due(task, time.time()):
                    return self._public_task(task)
            if task["state"] in {"closed", "cancelled"}:
                return self._public_task(task)
            # 中文注释：仅可信会话收尾走移交；待人工处理或暂停时保留工作页，同时撤销全部任务权限。
            pending_human = self._pending_human(task)
            # 中文注释：keepTabs 由模型在需要用户完成验证码等页面操作时显式请求；仍撤销任务全部权限。
            handoff = handoff_if_pending and (pending_human or params.get("keepTabs") is True)
            if handoff:
                close_agent_tabs = False
                task["handoff"] = True
            extension = self.extensions.get(task["instanceId"])
            if extension is None:
                # 中文注释：启动扫描可能早于扩展连接；重连后仅补发这次从未派发的释放。
                task['autoClosePending'] = close_agent_tabs
            generation = task["generation"]
            self._revoke_task_locked(task, final_state)
            self.cleanup_proofs.pop(task["id"], None)
            task.update(cleanupState="pending", cleanupReason="release_in_progress")
            task.pop("cleanupError", None)
            self._persist_tasks()
        with self.cleanup_locks[task["id"]]:
            if extension is None:
                self._record_cleanup(task, generation, extension, None, "browser_offline")
            else:
                try:
                    response = self._extension_call(extension, "browser.release", {
                        "taskId": task["id"], "generation": generation,
                        "closeAgentTabs": close_agent_tabs}, timeout=5.0)
                except (ProtocolError, OSError) as exc:
                    self._record_cleanup(task, generation, extension, None, self._cleanup_error_code(exc))
                else:
                    if not isinstance(response, dict) or response.get("released") is not True:
                        response = None
                    self._record_cleanup(task, generation, extension, response)
                    if handoff and task.get("cleanupState") == "succeeded":
                        with self.state_lock:
                            task["cleanupReason"] = "handed_to_user"
                            self._persist_tasks()
        if extension is not None and task.get("workTabs"):
            # 中文注释：终态收组在后台执行，不能把有界 release 延长为等待在途动作。
            threading.Thread(target=self._ungroup_terminal_tasks, args=(task["instanceId"], extension, task["id"]), daemon=True).start()
        self._notify_tasks_changed(task["instanceId"])
        return self._public_task(task)

    @staticmethod
    def _cleanup_error_code(exc: Exception) -> str:
        if isinstance(exc, OSError):
            return "transport_error"
        code = getattr(exc, "code", "")
        return code if code in {"extension_timeout", "extension_disconnected", "workspace_unknown", "too_many_pending"} else "extension_error"

    @staticmethod
    def _cleanup_response(response: Any) -> tuple[dict, tuple[int, ...]]:
        if not isinstance(response, dict) or not isinstance(response.get("cleanupState"), str) or response["cleanupState"] not in {"succeeded", "pending", "unknown", "failed"}:
            return {"cleanupState": "unknown", "cleanupReason": "invalid_response"}, ()
        state = response["cleanupState"]
        lists = {}
        for field in ("remainingTabIds", "preservedTabIds", "unknownTabIds"):
            value = response.get(field)
            if value is None and state in {"unknown", "failed"}:
                value = []  # Unknown counts are not proof of zero; omit them below.
            elif not isinstance(value, list) or len(value) > 256 or any(type(tab_id) is not int or tab_id < 0 for tab_id in value) or len(value) != len(set(value)):
                return {"cleanupState": "unknown", "cleanupReason": "invalid_response"}, ()
            lists[field] = value
        if state == "succeeded" and (lists["remainingTabIds"] or lists["unknownTabIds"]):
            return {"cleanupState": "unknown", "cleanupReason": "invalid_response"}, ()
        reason = response.get("cleanupReason")
        safe_reasons = {"release_in_progress", "browser_offline", "cleanup_timeout", "workspace_unknown", "ownership_unknown", "remaining_owned_tabs", "preserved_tabs", "cleanup_failed", "verified_complete", "no_journal", "preserved", "cleanup_uncertain", "ungrouped_unverified", "browser_restarted", "handed_to_user"}
        metadata = {"cleanupState": state}
        if isinstance(reason, str) and reason in safe_reasons:
            metadata["cleanupReason"] = reason
        for field, name in (("remainingTabIds", "cleanupRemainingCount"), ("preservedTabIds", "cleanupPreservedCount"), ("unknownTabIds", "cleanupUnknownCount")):
            if field in response:
                metadata[name] = len(lists[field])
        return metadata, tuple(lists["remainingTabIds"]) if state == "pending" and "remainingTabIds" in response else ()

    def _record_cleanup(self, task, generation, extension, response, error_code=None, *, allow_proof=False):
        metadata, owned = self._cleanup_response(response) if error_code is None else ({"cleanupState": "unknown", "cleanupReason": error_code,
                                                                             "cleanupError": {"code": error_code}}, ())
        with self.state_lock:
            if task["generation"] != generation or task["state"] not in {"cancelled", "closed"}:
                raise ProtocolError("stale_generation", "cleanup task generation changed")
            if extension is not None and self.extensions.get(task["instanceId"]) is not extension:
                metadata, owned = {"cleanupState": "unknown", "cleanupReason": "browser_offline"}, ()
            for field in ("cleanupRemainingCount", "cleanupPreservedCount", "cleanupUnknownCount", "cleanupError", "cleanupReason"):
                task.pop(field, None)
            task.update(metadata)
            self.cleanup_proofs.pop(task["id"], None)
            if allow_proof and owned and extension is not None and response is not None:
                self.cleanup_proofs[task["id"]] = (generation, extension, owned)
            task["updatedAt"] = time.time()
            self._persist_tasks()

    def _cleanup_status(self, params):
        task = self._owned_task(params)
        with self.cleanup_locks[task["id"]]:
            with self.state_lock:
                if task["state"] not in {"cancelled", "closed"}:
                    raise ProtocolError("invalid_state", "cleanup status requires a terminal task")
                generation = task["generation"]
                extension = self.extensions.get(task["instanceId"])
                self.cleanup_proofs.pop(task["id"], None)
            if extension is None:
                self._record_cleanup(task, generation, extension, None, "browser_offline")
            else:
                try:
                    result = self._extension_call(extension, "browser.cleanup_status", {
                        "taskId": task["id"], "generation": generation}, timeout=5.0)
                except (ProtocolError, OSError) as exc:
                    self._record_cleanup(task, generation, extension, None, self._cleanup_error_code(exc))
                else:
                    self._record_cleanup(task, generation, extension, result, allow_proof=True)
            return self._public_task(task)

    def _ungroup_terminal_tasks(self, instance_id, extension, task_id=None, *, force=False):
        # 中文注释：后台线程不能占用 Native Messaging 读循环；连接与任务代次变化时立即停止。
        with self.state_lock:
            candidates = sorted((t for t in self.tasks.values()
                                 if t["instanceId"] == instance_id and t["state"] in {"closed", "cancelled"}
                                 and (task_id is None or t["id"] == task_id)
                                 and (force or t.get("cleanupState") == "unknown" or t.get("cleanupReason") in {'preserved', 'handed_to_user'})
                                 # 中文注释：普通重连只尝试一次；显式 sweep 可以重新复核，仍不能扩大创建证明。
                                 and (force or not t.get("ungroupAttempted") or 'autoClosePending' in t)
                                 and (t.get("workTabs") or 'autoClosePending' in t)), key=lambda t: t.get("updatedAt", 0), reverse=True)[:100]
        for task in candidates:
            with self.cleanup_locks[task["id"]]:
                with self.state_lock:
                    if self.extensions.get(instance_id) is not extension:
                        return
                    if task["state"] not in {"closed", "cancelled"}:
                        continue
                    generation = task["generation"]
                    auto_close = task.pop('autoClosePending', None)
                    params = {"taskId": task["id"], "generation": generation, "ungroupOnly": True,
                              "state": task["state"], "title": task["title"],
                              "workTabs": [dict(tab) for tab in task.get("workTabs", [])]}
                try:
                    if auto_close is not None:
                        # 中文注释：补发资格先落盘撤销，崩溃后不能自动重放可能已经派发的释放。
                        self._persist_tasks()
                        self._flush_tasks()
                        response = self._extension_call(extension, 'browser.release', {
                            'taskId': task['id'], 'generation': generation, 'closeAgentTabs': auto_close}, timeout=5.0)
                        self._record_cleanup(task, generation, extension, response)
                    response = self._extension_call(extension, "browser.cleanup_retry", params, timeout=30.0)
                    self._record_cleanup(task, generation, extension, response)
                except (ProtocolError, OSError):
                    continue
                with self.state_lock:
                    if task["generation"] == generation and task["state"] in {"closed", "cancelled"}:
                        task["ungroupAttempted"] = True
                        if task.get('handoff') and task.get('cleanupState') == 'succeeded':
                            # 中文注释：收组回执不能丢失 keep_tabs/人工接管的移交语义。
                            task['cleanupReason'] = 'handed_to_user'
                self._persist_tasks()
        self._notify_tasks_changed(instance_id)

    def _cleanup_retry(self, params):
        task = self._owned_task(params)
        with self.cleanup_locks[task["id"]]:
            with self.state_lock:
                proof = self.cleanup_proofs.pop(task["id"], None)
                extension = self.extensions.get(task["instanceId"])
                if (task["state"] not in {"cancelled", "closed"} or not proof or
                        proof[0] != task["generation"] or proof[1] is not extension or
                        task.get("cleanupState") != "pending"):
                    raise ProtocolError("reconcile_required", "read-only cleanup status with owned live tabs required")
                generation, _, tab_ids = proof
                task.update(cleanupState="pending", cleanupReason="release_in_progress")
                self._persist_tasks()
            try:
                result = self._extension_call(extension, "browser.cleanup_retry", {
                    "taskId": task["id"], "generation": generation, "tabIds": list(tab_ids)}, timeout=5.0)
            except (ProtocolError, OSError) as exc:
                self._record_cleanup(task, generation, extension, None, self._cleanup_error_code(exc))
            else:
                self._record_cleanup(task, generation, extension, result)
            return self._public_task(task)

    @staticmethod
    def _validate_action_url(value: Any, allowed_origins: list[str]) -> None:
        if not isinstance(value, str):
            raise ProtocolError("invalid_url", "url must be a string")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ProtocolError("invalid_url", "url must use http or https")
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in allowed_origins:
            raise ProtocolError("origin_denied", "url origin is not approved")

    @staticmethod
    def _www_redirect_origin(requested: str, final: str) -> str | None:
        # 中文注释：只接受扩展已确认的同协议 apex/www 对换，不接受其他子域或端口变化。
        try:
            before, after = urlsplit(requested), urlsplit(final)
            if (before.scheme not in {'http', 'https'} or before.scheme != after.scheme
                    or before.port != after.port or before.username or before.password
                    or after.username or after.password or not before.hostname or not after.hostname):
                return None
            apex = lambda host: host[4:] if host.startswith('www.') else host
            if (before.hostname != after.hostname and apex(before.hostname) == apex(after.hostname)
                    and apex(before.hostname) in {before.hostname, after.hostname}):
                return f'{after.scheme}://{after.netloc.lower()}'
        except ValueError:
            return None
        return None

    @staticmethod
    def _validate_run_params(action: str, params: Dict[str, Any]) -> None:
        if not isinstance(action, str) or action not in V1_ACTIONS:
            raise ProtocolError("invalid_action", "V1 action is not allowed")
        common = {"owner", "taskId", "requestId", "action"}
        required = {
            "tabs": set(), "new_tab": {"url"}, "navigate": {"tabId", "url"},
            "official.ready_state": {"tabId"}, "official.goto_url": {"tabId", "url"},
            "official.new_tab": {"url"},
            "snapshot": {"tabId"}, "click": {"tabId", "selector"},
            "fill": {"tabId", "selector", "text"}, "press": {"tabId", "selector", "key"},
            "screenshot": {"tabId"}, "api_request": {"tabId", "url", "fields"},
            "page.observe": {"tabId"}, "page.parse": {"tabId"}, "semantic_snapshot": {"tabId"},
            "frame_catalog": {"tabId"},
            "ref_click": {"tabId", "binding", "snapshotId", "ref"},
            "ref_fill": {"tabId", "binding", "snapshotId", "ref", "text"},
            # 中文注释：语义按键与原有 press 使用同一受限按键集合。
            "ref_press": {"tabId", "binding", "snapshotId", "ref", "key"},
            "ref_set_checked": {"tabId", "binding", "snapshotId", "ref", "checked"},
            "ref_select_option": {"tabId", "binding", "snapshotId", "ref", "by", "values"},
            "interaction.capture": {"tabId"},
            "interaction.bounds": {"tabId", "screenshotId", "selector"},
            "interaction.click": {"tabId", "screenshotId", "point", "expectedRef"},
            "interaction.drag_coordinates": {"tabId", "screenshotId", "from", "to"},
            "interaction.drag_elements": {"tabId", "screenshotId", "source", "target"},
            # 中文注释：文件正文和本地路径不属于模型动作参数。
            "files.upload": {"tabId", "selector"},
            "scroll": {"tabId", "direction"}, "back": {"tabId"},
            "js.evaluate": {"tabId", "expression"}, "cdp.send": {"tabId", "method"}, "cdp.events": {"tabId"}, "network.inspect": {"tabId", "options"},
            "gateway.authorize": {"codeDigest"},
            "vault.authorize": {"tabId", "vaultAction", "handleDigest"},
            "images": {"tabId"}, "console": {"tabId"}, "dialog": {"tabId", "accept"},
        }[action]
        optional = {
            "click": {"clickMode"}, "ref_click": {"clickMode"},
            "ref_fill": {"frameToken"}, "ref_press": {"frameToken"}, "ref_set_checked": {"frameToken"},
            "ref_select_option": {"frameToken"},
            "api_request": {"httpMethod"}, "page.observe": {"options"}, "page.parse": {"options"}, "semantic_snapshot": {"options"},
            "interaction.drag_coordinates": {"mode", "steps"},
            "interaction.drag_elements": {"mode", "steps"},
            "js.evaluate": {"world", "awaitPromise", "timeoutMs", "frameToken", "arguments"},
            "cdp.send": {"params", "frameToken", "targetId", "timeoutMs"}, "cdp.events": {"max"},
            "console": {"clear"}, "dialog": {"promptText"},
            # 中文注释：官方视觉工具的编号标注只引用本次语义快照的引用，不接受坐标或脚本。
            "screenshot": {"annotate", "selector", "binding", "snapshotId", "ref", "format"},
            # 中文注释：带语义引用时只滚动该目标所在的容器，用于虚拟列表有上限的逐屏查找。
            "scroll": {"binding", "snapshotId", "ref", "frameToken"},
            "files.upload": {"artifactIds", "paths"},
        }.get(action, set())
        if action == "ref_click":
            optional = optional | {"frameToken"}
        if set(params) - common - required - optional or required - set(params):
            raise ProtocolError("invalid_params", "invalid action arguments")
        if "clickMode" in params:
            modes = {"open_link_in_task_tab"} if action == "click" else {"open_link_in_task_tab", "pointer"} if action == "ref_click" else set()
            if not isinstance(params["clickMode"], str) or params["clickMode"] not in modes:
                raise ProtocolError("invalid_params", "invalid clickMode")

        def text(name: str, limit: int, *, empty: bool = False) -> str:
            value = params.get(name)
            if not isinstance(value, str) or (not empty and not value) or len(value) > limit:
                raise ProtocolError("invalid_params", f"invalid {name}")
            return value

        def number(value: Any) -> bool:
            return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)

        def point(value: Any) -> None:
            if not isinstance(value, dict) or set(value) != {"x", "y"} or not number(value["x"]) or not number(value["y"]):
                raise ProtocolError("invalid_params", "invalid screenshot point")

        def endpoint(value: Any) -> None:
            if not isinstance(value, dict) or set(value) != {"point", "expectedRef"}:
                raise ProtocolError("invalid_params", "invalid drag endpoint")
            point(value["point"])
            if not isinstance(value["expectedRef"], str) or not value["expectedRef"] or len(value["expectedRef"]) > 256:
                raise ProtocolError("invalid_params", "invalid drag endpoint ref")

        def binding(value: Any) -> None:
            if not isinstance(value, dict) or set(value) != {"taskId", "documentId", "leaseId"}:
                raise ProtocolError("invalid_params", "invalid semantic binding")
            if any(not isinstance(value[key], str) or not value[key] or len(value[key]) > 128 for key in value):
                raise ProtocolError("invalid_params", "invalid semantic binding")

        if "selector" in params:
            text("selector", 4096)
        for name, limit in (("snapshotId", 512), ("ref", 256), ("screenshotId", 256),
                            ("expectedRef", 256), ("source", 4096), ("target", 4096)):
            if name in params:
                text(name, limit)
        if "text" in params:
            text("text", 100000, empty=True)
        if action in {"press", "ref_press"} and (not isinstance(params.get("key"), str)
                                                 or params["key"] not in {"Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"}):
            # 中文注释：批准前拒绝未知按键，避免展示与实际派发的操作不一致。
            raise ProtocolError("invalid_params", "invalid key")
        if "binding" in params:
            binding(params["binding"])
        if "frameToken" in params and (not isinstance(params["frameToken"], str) or not 1 <= len(params["frameToken"]) <= 128):
            raise ProtocolError("invalid_params", "invalid frame token")
        if "checked" in params and type(params["checked"]) is not bool:
            raise ProtocolError("invalid_params", "checked must be a boolean")
        if "by" in params and (not isinstance(params["by"], str) or params["by"] not in {"value", "label", "index"}):
            raise ProtocolError("invalid_params", "invalid option selector")
        if "values" in params:
            # 中文注释：原生 select 的 index 为零基整数；value/label 保留 Unicode 字符串。
            values = params["values"]
            if not isinstance(values, list) or len(values) > 100:
                raise ProtocolError("invalid_params", "invalid option values")
            if params.get("by") == "index":
                invalid = any(type(value) is not int or value < 0 or value > 2 ** 53 - 1 for value in values)
            else:
                invalid = any(not isinstance(value, str) or len(value) > 1000 for value in values)
            if invalid or len(set(values)) != len(values):
                raise ProtocolError("invalid_params", "invalid option values")
        if action == "files.upload" and ("artifactIds" in params) == ("paths" in params):
            raise ProtocolError("invalid_params", "give either artifact ids or local paths")
        if action == "files.upload" and "paths" in params:
            paths = params["paths"]
            if (not isinstance(paths, list) or not 1 <= len(paths) <= 10 or len(set(paths)) != len(paths)
                    or any(not isinstance(item, str) or not item.startswith("/") or len(item) > 4096 or "\x00" in item
                           for item in paths)):
                raise ProtocolError("invalid_params", "invalid local file paths")
        if action == "files.upload" and "artifactIds" in params:
            ids = params.get("artifactIds")
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 10
                    or any(not isinstance(item, str) or not re.fullmatch(
                        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", item)
                           for item in ids) or len(set(ids)) != len(ids)):
                raise ProtocolError("invalid_params", "invalid artifact ids")
        if "point" in params:
            point(params["point"])
        if "from" in params:
            endpoint(params["from"])
            endpoint(params["to"])
        if "steps" in params and (type(params["steps"]) is not int or not 2 <= params["steps"] <= 100):
            raise ProtocolError("invalid_params", "invalid drag steps")
        if action == "interaction.drag_coordinates" and params.get("mode", "pointer") != "pointer":
            raise ProtocolError("invalid_params", "coordinate drag requires pointer mode")
        if action == "interaction.drag_elements" and params.get("mode", "pointer") not in {"pointer", "html5-synthetic"}:
            raise ProtocolError("invalid_params", "invalid drag mode")
        if action == "network.inspect":
            options = params.get('options')
            if not isinstance(options, dict) or len(json.dumps(options)) > 4096:
                raise ProtocolError('invalid_params', 'invalid network options')
        if action == 'gateway.authorize' and (not isinstance(params.get('codeDigest'), str)
                                               or not re.fullmatch(r'[0-9a-f]{64}', params['codeDigest'])):
            raise ProtocolError('invalid_params', 'invalid script digest')
        if action == 'vault.authorize' and (params.get('vaultAction') not in {'fill', 'save_login', 'enter_code'}
                                            or not isinstance(params.get('handleDigest'), str)
                                            or not re.fullmatch(r'[0-9a-f]{64}', params['handleDigest'])):
            raise ProtocolError('invalid_params', 'invalid Vault approval scope')
        if action == "js.evaluate":
            text("expression", 100000)
            if params.get("world", "isolated") not in {"isolated", "main"}:
                raise ProtocolError("invalid_params", "invalid JavaScript world")
            if "awaitPromise" in params and type(params["awaitPromise"]) is not bool:
                raise ProtocolError("invalid_params", "invalid awaitPromise")
            if "timeoutMs" in params and (type(params["timeoutMs"]) is not int or not 100 <= params["timeoutMs"] <= 60000):
                raise ProtocolError("invalid_params", "invalid JavaScript timeout")
        if action == "cdp.send":
            if not isinstance(params.get("method"), str) or not re.fullmatch(r"[A-Z][A-Za-z]{1,40}\.[a-zA-Z]{1,80}", params["method"]):
                raise ProtocolError("invalid_params", "invalid CDP method")
            if "params" in params and (not isinstance(params["params"], dict)
                                       or len(json.dumps(params["params"])) > 1000000):
                raise ProtocolError("invalid_params", "invalid CDP params")
            if "targetId" in params and (not isinstance(params["targetId"], str)
                                          or not 1 <= len(params["targetId"]) <= 128
                                          or "frameToken" in params):
                raise ProtocolError("invalid_params", "invalid CDP target")
            if "timeoutMs" in params and (type(params["timeoutMs"]) is not int
                                           or not 100 <= params["timeoutMs"] <= 60000):
                raise ProtocolError("invalid_params", "invalid CDP timeout")
        if action == "console" and "clear" in params and type(params["clear"]) is not bool:
            raise ProtocolError("invalid_params", "invalid clear flag")
        if action == "dialog" and (type(params.get("accept")) is not bool or (
                "promptText" in params and (not isinstance(params["promptText"], str) or len(params["promptText"]) > 10000))):
            raise ProtocolError("invalid_params", "invalid dialog response")
        if action == "cdp.events" and "max" in params and (type(params["max"]) is not int or not 1 <= params["max"] <= 500):
            raise ProtocolError("invalid_params", "invalid event count")
        if action == "scroll" and params.get("direction") not in {"up", "down"}:
            raise ProtocolError("invalid_params", "scroll direction must be up or down")
        if action == "screenshot" and "annotate" in params:
            annotate = params["annotate"]
            labels = annotate.get("labels") if isinstance(annotate, dict) else None
            if (not isinstance(annotate, dict) or set(annotate) != {"binding", "snapshotId", "labels"}
                    or not isinstance(annotate["binding"], dict) or not isinstance(annotate["snapshotId"], str)
                    or len(annotate["snapshotId"]) > 512 or not isinstance(labels, list) or len(labels) > 200
                    or any(not isinstance(row, dict) or set(row) != {"label", "ref"} or type(row["label"]) is not int
                           or not 1 <= row["label"] <= 1000 or not isinstance(row["ref"], str) or not 0 < len(row["ref"]) <= 256
                           for row in labels)):
                raise ProtocolError("invalid_params", "invalid screenshot annotation")
        if action == "screenshot":
            if params.get("format", "png") not in {"png", "jpeg"}:
                raise ProtocolError("invalid_params", "screenshot format must be png or jpeg")
            if "annotate" in params and params.get("format", "png") != "png":
                raise ProtocolError("invalid_params", "annotated screenshots require png")
            if "selector" in params and (not isinstance(params["selector"], str) or not 0 < len(params["selector"]) <= 2000
                                           or {"binding", "snapshotId", "ref"} & set(params)):
                raise ProtocolError("invalid_params", "invalid screenshot selector")
            if {"binding", "snapshotId", "ref"} & set(params) and not {"binding", "snapshotId", "ref"} <= set(params):
                raise ProtocolError("invalid_params", "screenshot target needs binding, snapshotId and ref")
        if action == "scroll" and {"binding", "snapshotId", "ref", "frameToken"} & set(params) and not {"binding", "snapshotId", "ref"} <= set(params):
            raise ProtocolError("invalid_params", "container scroll needs binding, snapshot_id and ref")
        if action == "page.observe":
            # 中文注释：只允许内部等待的固定选择器；不接受源码、跨框架或扩大扫描预算。
            options = params.get("options")
            if (not isinstance(options, dict) or set(options) != {"selector"}
                    or not isinstance(options["selector"], str) or not 1 <= len(options["selector"]) <= 512):
                raise ProtocolError("invalid_params", "invalid page observation options")
        if action == "page.parse":
            options = params.get("options", {})
            if (not isinstance(options, dict) or set(options) - {"root", "sections", "composed", "budget", "cursor", "maxScan", "schema", "frameToken"}
                    or len(json.dumps(options, allow_nan=False)) > 100000):
                raise ProtocolError("invalid_params", "invalid page parse options")
        if action == "js.evaluate" and "arguments" in params:
            if len(json.dumps(params["arguments"], allow_nan=False)) > 100000:
                raise ProtocolError("invalid_params", "JavaScript argument too large")
        if action == "semantic_snapshot" and "options" in params:
            options = params["options"]
            allowed = {"mode", "root", "query", "roles", "viewport", "composed", "budget", "cursor", "baselineId", "frameToken"}
            if not isinstance(options, dict) or set(options) - allowed:
                raise ProtocolError("invalid_params", "invalid semantic options")
            if options.get("mode", "interactive") not in {"interactive", "content", "table"}:
                raise ProtocolError("invalid_params", "invalid semantic mode")
            for name, limit, empty in (("root", 4096, False), ("query", 2000, True),
                                       ("cursor", 512, False), ("baselineId", 512, False)):
                if name in options and (not isinstance(options[name], str) or (not empty and not options[name]) or len(options[name]) > limit):
                    raise ProtocolError("invalid_params", "invalid semantic options")
            if "roles" in options and (not isinstance(options["roles"], list) or len(options["roles"]) > 100
                    or any(not isinstance(role, str) or not role or len(role) > 100 for role in options["roles"])):
                raise ProtocolError("invalid_params", "invalid semantic roles")
            if "viewport" in options and type(options["viewport"]) is not bool:
                raise ProtocolError("invalid_params", "invalid semantic viewport")
            if "composed" in options and type(options["composed"]) is not bool:
                raise ProtocolError("invalid_params", "invalid semantic composed flag")
            if "frameToken" in options and (not isinstance(options["frameToken"], str) or not 1 <= len(options["frameToken"]) <= 128):
                raise ProtocolError("invalid_params", "invalid frame token")
            if "budget" in options and (type(options["budget"]) is not int or options["budget"] < 512):
                raise ProtocolError("invalid_params", "invalid semantic budget")

    def _extension_call(self, extension: Dict[str, Any], method: str, params: Dict[str, Any], timeout: float = 15.0) -> Any:
        request_id = "srv:" + uuid.uuid4().hex
        pending = {"event": threading.Event(), "response": None}
        with extension["pendingLock"]:
            if len(extension["pending"]) >= 128:
                raise ProtocolError("too_many_pending", "too many pending browser operations")
            extension["pending"][request_id] = pending
        try:
            try:
                self._send_extension(extension, {"id": request_id, "method": method, "params": params})
            except OSError as exc:
                raise ProtocolError("extension_disconnected", "browser extension disconnected") from exc
            if not pending["event"].wait(timeout):
                raise ProtocolError("extension_timeout", "browser extension did not respond")
            response = pending["response"]
            if not isinstance(response, dict):
                raise ProtocolError("extension_disconnected", "browser extension disconnected")
            if "error" in response:
                error = response["error"] if isinstance(response["error"], dict) else {}
                raise ProtocolError(str(error.get("code", "extension_error")),
                                    str(error.get("message", "browser extension error")), error.get("data"))
            return response.get("result")
        finally:
            with extension["pendingLock"]:
                extension["pending"].pop(request_id, None)

    def _accept_extension_response(self, extension: Dict[str, Any], message: Dict[str, Any]) -> bool:
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return False
        with extension["pendingLock"]:
            pending = extension["pending"].get(request_id)
            if pending is None:
                return (
                    request_id.startswith("srv:")
                    and "method" not in message
                    and (("result" in message) != ("error" in message))
                )
            pending["response"] = message
            pending["event"].set()
            return True

    def _owned_task(self, params: Dict[str, Any]) -> Dict[str, Any]:
        owner = self._required_string(params, "owner")
        task_id = self._required_string(params, "taskId")
        with self.state_lock:
            task = self.tasks.get(task_id)
            if task is None:
                raise ProtocolError("not_found", "task not found")
            if task["owner"] != owner:
                raise ProtocolError("forbidden", "task belongs to another owner")
            return task

    @staticmethod
    def _required_string(params: Dict[str, Any], name: str) -> str:
        value = params.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ProtocolError("invalid_params", f"{name} must be a non-empty string")
        return value

    @staticmethod
    def _validate_origins(value: Any) -> list[str]:
        if not isinstance(value, list) or not value:
            raise ProtocolError("invalid_params", "allowedOrigins must be a non-empty list")
        origins = []
        for origin in value:
            if not isinstance(origin, str):
                raise ProtocolError("invalid_params", "allowedOrigins entries must be strings")
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                raise ProtocolError("invalid_origin", "allowedOrigins must contain exact http(s) origins")
            normalized = f"{parsed.scheme}://{parsed.netloc}"
            if origin.rstrip("/") != normalized:
                raise ProtocolError("invalid_origin", "allowedOrigins must contain exact http(s) origins")
            if normalized not in origins:
                origins.append(normalized)
        return origins

    def _public_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        # 中文注释：公开状态不包含请求指纹，操作投影使用固定允许字段。
        result = {key: value for key, value in task.items()
                  if key not in {"owner", "agentTabIds", "spawnedTabIds", "requestHistory", "readOrigins", "downloads", "officialBlankTabs", "currentOperation", "operationTimeline", "idleRecoveryState", "autoClosePending"}}
        fields = {"action", "state", "startedAt", "completedAt", "durationMs", "errorCode", "tabId"}
        if isinstance(task.get("currentOperation"), dict):
            result["currentOperation"] = {key: value for key, value in task["currentOperation"].items() if key in fields}
        if isinstance(task.get("operationTimeline"), list):
            result["operationTimeline"] = [{key: value for key, value in row.items() if key in fields} for row in task["operationTimeline"][-32:] if isinstance(row, dict)]
        with self.state_lock:
            pending = [entry for (task_id, _), entry in self.action_approvals.items()
                       if task_id == task["id"] and entry.get("generation") == task.get("generation")
                       and entry.get("status") in {"approval_required", "user_input_required"}
                       and entry.get("expiresAt", 0) > time.time()]
            if pending:
                result["pendingInteraction"] = {"kind": "manual_input" if any(entry.get("status") == "user_input_required" for entry in pending) else "approval", "count": len(pending)}
        return result

    def _notify_tasks_changed(self, instance_id: str) -> None:
        with self.state_lock:
            extension = self.extensions.get(instance_id)
        if extension is None:
            return
        try:
            self._send_extension(extension, {"method": "tasks.changed", "params": {}})
        except OSError:
            pass

    @staticmethod
    def _send_extension(extension: Dict[str, Any], value: Dict[str, Any]) -> None:
        with extension["sendLock"]:
            if value.get("id") and str(value.get("method", "")).startswith("browser."):
                extension["sendSequence"] = extension.get("sendSequence", 0) + 1
                value = {**value, "sequence": extension["sendSequence"]}
            extension["socket"].sendall(_encode_line(value))

    def _expire_approvals_locked(self):
        for key, pending in list(self.action_approvals.items()):
            if pending['status'] in {'approval_required', 'user_input_required'} and pending['expiresAt'] <= time.time():
                self._finish_approval_locked(key, 'approval_expired', '确认已过期，未执行；如仍需要，请明确发起新请求。')

    def _finish_approval_locked(self, key, code, message):
        pending = self.action_approvals.pop(key, None)
        if pending is not None:
            task = self.tasks[key[0]]
            if pending['status'] == 'executing':
                self._record_request_locked(task, key[1], pending['digest'], None, None)
            else:
                self._record_request_locked(task, key[1], pending['digest'], {'code': code, 'message': message}, 'error')
            self._persist_tasks()

    def _approval_worker(self, key, pending):
        try:
            self._run_task(pending['params'], _approval=pending)
        except ProtocolError as exc:
            with self.state_lock:
                self._finish_approval_locked(key, exc.code, exc.message)
        except Exception:
            # A lost worker must never make the same queued action runnable.
            with self.state_lock:
                task = self.tasks[key[0]]
                self._record_request_locked(task, key[1], pending['digest'], None, None)
                self._revoke_task_locked(task, 'needs_sync')
                self._persist_tasks()
                extension = self.extensions.get(task['instanceId'])
            if extension is not None:
                try:
                    self._best_effort_release(extension, task['id'], task['generation'], False)
                except Exception:
                    pass  # Revocation is authoritative even if cleanup fails.
        finally:
            with self.state_lock:
                self.action_approvals.pop(key, None)
            self._notify_tasks_changed(self.tasks[key[0]]['instanceId'])

    def _dispatch_connected_extension(self, extension, method, params):
        instance_id = extension['instanceId']
        # 中文注释：连接核对与状态修改必须原子完成；暂停先取任务锁，保持任务锁→状态锁的既有顺序。
        if method in {'extension.pause', 'extension.unpause'}:
            return self._dispatch_extension(instance_id, method, params, _connection=extension)
        with self.state_lock:
            if self.extensions.get(instance_id) is not extension:
                raise ProtocolError('connection_replaced', 'browser connection was replaced')
            return self._dispatch_extension(instance_id, method, params)

    def _dispatch_extension(self, instance_id: str, method: Any, params: Any, *, _connection=None) -> Any:
        if not isinstance(params, dict):
            raise ProtocolError("invalid_params", "params must be an object")
        if method == 'extension.set_primary' and params == {}:
            with self.state_lock:
                if _connection is not None and self.extensions.get(instance_id) is not _connection:
                    raise ProtocolError('connection_replaced', 'browser connection was replaced')
            return self._set_primary_browser(instance_id)
        if method == 'extension.browser_list' and params == {}:
            # 中文注释：扩展请求不能在同一套接字上同步回问 consent_status，使用最近一次已确认状态。
            with self.state_lock:
                primary = self._primary_browser()
                rows = [{'instanceId': item['instanceId'], 'browser': item['browser'], 'connected': True,
                         'consentStatus': item.get('lastConsentStatus', 'unknown'),
                         'primary': bool(primary and primary['instanceId'] == item['instanceId']
                                         and primary['browser'] == item['browser'])}
                        for item in self.extensions.values()]
                if primary and not any(item['primary'] for item in rows):
                    rows.append({**primary, 'connected': False, 'consentStatus': 'unknown', 'primary': True})
                return rows
        if method == 'extension.task_log':
            if (set(params) != {'taskId', 'generation', 'limit'} or type(params['limit']) is not int
                    or not 1 <= params['limit'] <= 5):
                raise ProtocolError('invalid_params', 'invalid task log request')
            task = self.tasks.get(params['taskId'])
            if not task or task['instanceId'] != instance_id or task['generation'] != params['generation']:
                raise ProtocolError('not_found', 'task log unavailable')
            return self._read_task_log(task['id'], params['limit'])
        if method == 'extension.revoke_access' and params == {}:
            # 中文注释：只撤销发送方浏览器的任务，包含尚未装入扩展的待批准任务；其他实例不受影响。
            with self.state_lock:
                for task in self.tasks.values():
                    if task['instanceId'] != instance_id or task['state'] == 'closed':
                        continue
                    task['accessRevoked'] = True
                    self._revoke_task_locked(task, 'cancelled')
                    task.update(cleanupState='unknown', cleanupReason='access_revoked')
                    self.cleanup_proofs.pop(task['id'], None)
                self._persist_tasks()
            return {'revoked': True}
        if method == "extension.access_request_closed":
            return self._access_request_closed(instance_id, params)
        if method == 'extension.approvals' and params == {}:
            with self.state_lock:
                self._expire_approvals_locked()
                return [dict(taskId=key[0], nonce=p['nonce'], digest=p['digest'], expiresAt=p['expiresAt'],
                             generation=p['generation'], modeGeneration=p['modeGeneration'],
                             kind=p.get('kind', 'action'),
                             **({'readOrigin': p['readOrigin']} if p.get('readOrigin') else {}),
                             **({'fieldKind': p['fieldKind']} if p.get('kind') == 'manual_input' else {}),
                             request={k:v for k,v in p['params'].items()
                                      if k != 'owner' and not (k == 'text' and p.get('kind') == 'manual_input')})
                        for key,p in self.action_approvals.items()
                        if self.tasks[key[0]]['instanceId'] == instance_id
                        and p['status'] in {'approval_required', 'user_input_required'}]
        if method == 'extension.decide':
            with self.state_lock:
                self._expire_approvals_locked()
                found = next(((key,p) for key,p in self.action_approvals.items()
                              if key[0] == params.get('taskId') and p['nonce'] == params.get('nonce')), None)
                if found is None:
                    raise ProtocolError('approval_stale', '确认已使用、撤销或过期')
                key, pending = found
                task = self.tasks[key[0]]
                expected_status = 'user_input_required' if pending.get('kind') == 'manual_input' else 'approval_required'
                if (task['instanceId'] != instance_id or pending['digest'] != params.get('digest')
                        or pending['status'] != expected_status or task['state'] != 'ready'
                        or pending['generation'] != task['generation']
                        or pending['modeGeneration'] != task.get('modeGeneration', 1)):
                    raise ProtocolError('approval_stale', '确认范围已变化')
                if pending.get('kind') == 'manual_input':
                    if params.get('approve') is not True:
                        self._finish_approval_locked(key, 'user_input_declined', '用户未填写该字段，未执行')
                        return {'status': 'denied'}
                    # The person typed it themselves; nothing was dispatched.
                    self.action_approvals.pop(key, None)
                    self._record_request_locked(task, key[1], pending['digest'],
                                                {'status': 'completed_by_user', 'filledBy': 'user',
                                                 'fieldKind': pending['fieldKind']}, 'result')
                    self._persist_tasks()
                    return {'status': 'completed'}
                if params.get('approve') is not True:
                    self._finish_approval_locked(key, 'approval_denied', '用户拒绝，未执行')
                    return {'status': 'denied'}
                pending['status'] = 'approved'
                threading.Thread(target=self._approval_worker, args=(key,pending), daemon=True).start()
                return {'status': 'approved'}
        if method in {'extension.pause', 'extension.unpause'}:
            task_id = self._required_string(params, 'taskId')
            changes = params.get('changes') if method == 'extension.unpause' else None
            if changes is not None and (not isinstance(changes, dict)
                    or set(changes) != {'urlChanged', 'documentReplaced', 'referencesInvalid', 'readPageFirst'}
                    or any(type(value) is not bool for value in changes.values())
                    or changes['referencesInvalid'] is not True or changes['readPageFirst'] is not True):
                raise ProtocolError('invalid_params', 'invalid takeover changes')
            with self.state_lock:
                task = self.tasks.get(task_id)
                if task is None or task['instanceId'] != instance_id:
                    raise ProtocolError('not_found', 'task not found for this browser instance')
                lock = self.task_locks[task_id]
            # 中文注释：先在宿主冻结新派发；扩展等待在途动作收尾后才交出页面，暂停保留租约。
            with lock:
                with self.state_lock:
                    # 中文注释：等待任务锁期间也可能完成重连，旧连接不能暂停或恢复新连接的任务。
                    if _connection is not None and self.extensions.get(instance_id) is not _connection:
                        raise ProtocolError('connection_replaced', 'browser connection was replaced')
                    expected = {'ready', 'running', 'paused'} if method == 'extension.pause' else {'paused', 'ready'}
                    if task['generation'] != params.get('generation') or task['state'] not in expected:
                        raise ProtocolError('invalid_state', 'task state changed before takeover')
                    # 中文注释：接管使此前排队/准备中的请求失效，继续不会复活旧请求。
                    if method == 'extension.pause' and task['state'] != 'paused':
                        task['controlEpoch'] = task.get('controlEpoch', 0) + 1
                    task['state'] = 'paused' if method == 'extension.pause' else 'ready'
                    if method == 'extension.pause':
                        task.pop('resumeSummary', None)
                    else:
                        task['resumeSummary'] = changes or {'urlChanged': True, 'documentReplaced': True,
                                                            'referencesInvalid': True, 'readPageFirst': True}
                    task['updatedAt'] = time.time()
                    self._persist_tasks()
                    result = self._public_task(task)
            self._notify_tasks_changed(instance_id)
            return result
        if method == 'extension.mode':
            with self.state_lock:
                task = self.tasks.get(self._required_string(params, 'taskId'))
                if task is None or task['instanceId'] != instance_id:
                    raise ProtocolError('not_found', 'task not found for this browser instance')
                if (params.get('mode') not in {'smart', 'full'} or task['state'] not in {'ready', 'running', 'authorizing', 'paused'}
                        or params.get('generation') != task['generation']
                        or params.get('modeGeneration') != task.get('modeGeneration', 1)):
                    raise ProtocolError('mode_stale', '模式或任务范围已变化，请刷新')
                if task['state'] in {'running', 'paused'} and params['mode'] == 'full':
                    raise ProtocolError('invalid_state', '请等待当前操作结束后开启完整访问')
                task['activeMode'] = params['mode']
                task['readOrigins'] = []
                # 中文注释：浏览器访问变化时撤销旧网关连接，防止旧连接恢复。
                task.pop('gatewayPermit', None)
                task.pop('vaultPermit', None)
                self.cdp_gateway.revoke(task['id'])
                if task['state'] == 'authorizing':
                    task['state'] = 'ready'
                task['modeGeneration'] = task.get('modeGeneration', 1) + 1
                for key in list(self.action_approvals):
                    if key[0] == task['id']:
                        self._finish_approval_locked(key, 'approval_revoked', '审批方式已改变，原确认已撤销')
                self._persist_tasks()
                return self._public_task(task)
        if method == "extension.tasks" and params == {}:
            with self.state_lock:
                return [
                    self._public_task(task)
                    for task in self.tasks.values()
                    if task["instanceId"] == instance_id and task["state"] not in {"closed"}
                ]
        if method == "extension.approve":
            # 中文注释：API 请求已归入两档模式，旧的单独审批字段不再接受。
            if 'apiBridgeApproved' in params:
                raise ProtocolError('invalid_params', 'separate API approval is not supported')
            task_id = self._required_string(params, "taskId")
            origins = self._validate_origins(params.get("allowedOrigins"))
            tab_ids = params.get("tabIds")
            workspace_only = params.get('workspaceOnly') is True
            if not isinstance(tab_ids, list) or (not tab_ids and not workspace_only) or any(not isinstance(tab_id, int) or isinstance(tab_id, bool) or tab_id < 0 for tab_id in tab_ids):
                raise ProtocolError("invalid_params", "tabIds must be a non-empty list of integers unless workspace-only")
            if workspace_only and tab_ids:
                raise ProtocolError('invalid_params', 'workspace-only grants cannot claim existing tabs')
            tab_ids = list(dict.fromkeys(tab_ids))
            with self.state_lock:
                task = self.tasks.get(task_id)
                if task is None or task["instanceId"] != instance_id:
                    raise ProtocolError("not_found", "task not found for this browser instance")
                if task["state"] != "pending_approval":
                    raise ProtocolError("invalid_state", "task is not pending approval")
                if workspace_only and (type(params.get('generation')) is not int or params['generation'] != task['generation']):
                    raise ProtocolError('approval_stale', 'workspace approval generation changed')
                if origins != task["allowedOrigins"]:
                    raise ProtocolError("origin_mismatch", "approval cannot widen or change requested origins")
                for tab_id in tab_ids:
                    holder = self.tab_leases.get((instance_id, tab_id))
                    if holder is not None and holder != task_id:
                        raise ProtocolError("lease_conflict", "tab is already controlled by another task")
                for tab_id in tab_ids:
                    self.tab_leases[(instance_id, tab_id)] = task_id
                task["tabIds"] = tab_ids
                task["state"] = "authorizing" if workspace_only else "ready"
                task["updatedAt"] = time.time()
                self._persist_tasks()
                result = self._public_task(task)
            return result
        if method in {"extension.reject", "extension.stop"}:
            task_id = self._required_string(params, "taskId")
            with self.state_lock:
                task = self.tasks.get(task_id)
                if task is None or task["instanceId"] != instance_id:
                    raise ProtocolError("not_found", "task not found for this browser instance")
                if 'generation' in params and (type(params['generation']) is not int or params['generation'] != task['generation']):
                    raise ProtocolError('approval_stale', 'task generation changed')
                if method == "extension.reject":
                    if task["state"] != "pending_approval":
                        raise ProtocolError("invalid_state", "only a pending task can be rejected")
                    final_state = "failed"
                else:
                    if task["state"] in {"cancelled", "closed"}:
                        return self._public_task(task)
                    final_state = "cancelled"
                self._revoke_task_locked(task, final_state)
                if final_state == "cancelled":
                    # 中文注释：停止回调与扩展共用读取循环，只采信随请求送来的本地清理回执。
                    cleanup = params.get('cleanup')
                    if isinstance(cleanup, dict) and cleanup.get('released') is True:
                        metadata, _ = self._cleanup_response(cleanup)
                    else:
                        metadata = {'cleanupState': 'unknown', 'cleanupReason': 'extension_unreported'}
                    task.update(metadata)
                    self.cleanup_proofs.pop(task_id, None)
                self._persist_tasks()
                return self._public_task(task)
        if method == "extension.tab_event":
            return self._handle_tab_event(instance_id, params)
        if method == "extension.download_event":
            return self._download_event(instance_id, params)
        if method == "extension.cdp_events":
            return self._cdp_events(instance_id, params)
        raise ProtocolError("unknown_method", "unknown extension method")

    def _download_event(self, instance_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        allowed = {"taskId", "generation", "tabId", "event", "downloadRef", "url", "filename", "mimeType",
                   "totalBytes", "bytesReceived", "fileSize", "path", "danger", "exists", "error"}
        if set(params) - allowed or params.get("event") not in {
                "attributed", "ambiguous", "progress", "complete", "interrupted", "cancelled",
                "rejected_size", "rejected_limit"}:
            raise ProtocolError("invalid_params", "invalid download event")
        task_id = self._required_string(params, "taskId")
        with self.state_lock:
            task = self.tasks.get(task_id)
            if task is None or task["instanceId"] != instance_id:
                raise ProtocolError("not_found", "task not found for this browser instance")
            if type(params.get("generation")) is not int or params["generation"] != task["generation"]:
                raise ProtocolError("approval_stale", "download task generation changed")
            # 中文注释：新下载只归属仍在运行的任务及其租约标签页；已有下载的完成/中断事件在停止后仍可记录。
            if params["event"] in {"attributed", "ambiguous"} and (
                    task["state"] not in {"ready", "running", "paused"}
                    or self.tab_leases.get((instance_id, params.get("tabId"))) != task_id):
                raise ProtocolError("foreign_tab", "download tab is not leased to this task")
            try:
                row = self.download_registry.event(task, params)
            except DownloadError as exc:
                raise ProtocolError(str(exc).lower(), "download event rejected") from None
            task["updatedAt"] = time.time()
            self._persist_tasks()
            return {"accepted": True, **({"downloadId": row["id"], "state": row["state"]} if row else {})}

    def _cdp_events(self, instance_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        events = params.get("events")
        dropped = params.get("dropped", 0)
        if not isinstance(events, list) or len(events) > 500 or type(dropped) is not int or dropped < 0:
            raise ProtocolError("invalid_params", "invalid CDP event batch")
        groups: Dict[tuple, list] = {}
        with self.state_lock:
            for event in events:
                if not isinstance(event, dict):
                    continue
                task = self.tasks.get(event.get("taskId"))
                # 中文注释：只路由本浏览器实例、仍有浏览器访问授权的活动任务事件。
                if (task is None or task["instanceId"] != instance_id or event.get("generation") != task["generation"]
                        or task.get("activeMode") not in {"smart", "full"} or task.get("state") not in {"ready", "running"}
                        or event.get("tabId") in task.get("outOfScopeTabIds", [])
                        or self.tab_leases.get((instance_id, event.get("tabId"))) != task["id"]):
                    continue
                groups.setdefault((task["id"], task["generation"]), []).append(event)
        for (task_id, generation), batch in groups.items():
            self.cdp_gateway.deliver(task_id, generation, batch, dropped)
        return {"accepted": sum(len(batch) for batch in groups.values())}

    def _open_cdp_gateway(self, params: Dict[str, Any]) -> Dict[str, Any]:
        task = self._owned_task(params)
        if set(params) - {"owner", "taskId", "workspace", "requestId", "codeDigest"}:
            raise ProtocolError("invalid_params", "invalid gateway request")
        workspace = params.get("workspace")
        if workspace is not None and (not isinstance(workspace, str) or len(workspace) > 4096):
            raise ProtocolError("invalid_params", "invalid workspace")
        with self.state_lock:
            if task['state'] == 'paused':
                raise ProtocolError('task_paused', 'user has taken over the page', {'outcomeUnknown': False})
            if task['state'] not in {'ready', 'running'}:
                raise ProtocolError('invalid_state', 'task is not ready', {'outcomeUnknown': False})
            smart = task.get('activeMode') == 'smart'
            if smart:
                permit = task.get('gatewayPermit')
                request_id = params.get('requestId')
                if (not isinstance(request_id, str) or not isinstance(params.get('codeDigest'), str)
                        or permit is None or permit.get('requestIdHash') != _sha256(request_id)
                        or permit.get('codeDigest') != params['codeDigest']
                        or permit.get('modeGeneration') != task.get('modeGeneration', 1)
                        or permit.get('expiresAt', 0) <= time.time()):
                    raise ProtocolError('approval_required', 'browser_exec script needs approval', {'outcomeUnknown': False})
                # 中文注释：智能审批资格仅能换取一次网关会话，完成后客户端必须主动关闭。
                task.pop('gatewayPermit', None)
            if task["instanceId"] not in self.extensions:
                raise ProtocolError("instance_unavailable", "browser instance is not connected")
            owner, generation, mode_generation = task["owner"], task["generation"], task.get("modeGeneration", 1)
        try:
            return self.cdp_gateway.open(owner=owner, task_id=task["id"], generation=generation,
                                         mode_generation=mode_generation, workspace=workspace,
                                         smart_authorized=smart)
        except GatewayDenied as exc:
            raise ProtocolError("invalid_params", exc.message, {"outcomeUnknown": False}) from None

    def _gateway_validate(self, grant: Dict[str, Any]) -> Dict[str, Any]:
        with self.state_lock:
            if grant.get('revoked') is True:
                raise GatewayDenied('gateway connection was revoked')
            task = self.tasks.get(grant["taskId"])
            if (task is None or task["owner"] != grant["owner"] or task["generation"] != grant["generation"]
                    or task["state"] not in {"ready", "running", "paused"}):
                raise GatewayDenied("Hermes task is no longer active")
            if task["state"] == "paused":
                raise GatewayDenied("the user has taken over this page; wait until they resume")
            if (task.get('modeGeneration', 1) != grant['modeGeneration']
                    or (task.get('activeMode') == 'smart' and not grant.get('smartAuthorized'))
                    or task.get('activeMode') not in {'smart', 'full'}):
                raise GatewayDenied('browser access was revoked or changed')
            if task["instanceId"] not in self.extensions:
                raise GatewayDenied("browser instance is not connected")
            return task

    def _gateway_call(self, grant: Dict[str, Any], method: str, params: Dict[str, Any]) -> Any:
        # 中文注释：网关与私有凭据填写共用任务锁，避免二者同时越过页面互斥检查。
        with self.state_lock:
            lock = self.task_locks.get(grant["taskId"])
        if lock is None:
            raise GatewayDenied("Hermes task is no longer active")
        with lock:
            return self._gateway_call_locked(grant, method, params)

    def _gateway_call_locked(self, grant: Dict[str, Any], method: str, params: Dict[str, Any]) -> Any:
        task = self._gateway_validate(grant)
        with self.state_lock:
            extension = self.extensions.get(task["instanceId"])
            tab_id = params.get("tabId")
            if type(tab_id) is int and tab_id in task.get("outOfScopeTabIds", []):
                raise GatewayDenied("task page left its authorized origins")
            if method == "browser.cdp" and type(tab_id) is int:
                if tab_id in task.get("credentialTabs", []):
                    raise GatewayDenied("this page received a credential fill and cannot run raw CDP")
                touched = task.setdefault("scriptedTabs", [])
                if tab_id not in touched:
                    touched.append(tab_id)
        if extension is None:
            raise GatewayDenied("browser instance is not connected")
        try:
            result = self._extension_call(extension, method, params, timeout=60.0)
            if isinstance(result, dict) and isinstance(result.get("__hermesChunked"), dict):
                meta = result["__hermesChunked"]
                count = meta.get("count")
                if type(count) is not int or not 1 <= count <= 64:
                    raise GatewayDenied("invalid chunked result")
                parts = []
                for index in range(count):
                    chunk = self._extension_call(extension, "browser.cdp_chunk", {
                        "taskId": grant["taskId"], "generation": grant["generation"], "modeGeneration": grant["modeGeneration"], "id": meta.get("id"), "index": index},
                        timeout=30.0)
                    if not isinstance(chunk, dict) or chunk.get("index") != index or not isinstance(chunk.get("data"), str):
                        raise GatewayDenied("chunked result unavailable")
                    parts.append(chunk["data"])
                result = json.loads("".join(parts))
            return result
        except ProtocolError as exc:
            raise GatewayDenied(exc.message if exc.code in {"cdp_error", "cdp_method_denied", "browser_access_required",
                                                             "frame_not_supported", "credential_mode_conflict",
                                                             "target_not_owned", "permission_denied", "invalid_params"}
                                else f"Hermes gateway: {exc.code}") from None

    def _gateway_create_tab(self, grant: Dict[str, Any], url: str) -> Dict[str, Any]:
        # 中文注释：排队建页和页面调用一样，在取得任务锁后重验连接撤销状态。
        with self.state_lock:
            lock = self.task_locks.get(grant['taskId'])
        if lock is None:
            raise GatewayDenied('Hermes task is no longer active')
        with lock:
            self._gateway_validate(grant)
            action = "official.new_tab" if url == "about:blank" else "new_tab"
            try:
                result = self._run_task({"owner": grant["owner"], "taskId": grant["taskId"],
                                         "requestId": "cdp-gateway-" + uuid.uuid4().hex, "action": action, "url": url},
                                        _gateway=True)
            except ProtocolError as exc:
                raise GatewayDenied(f"Hermes gateway: {exc.code}") from None
            if not isinstance(result, dict) or type(result.get("tabId")) is not int:
                raise GatewayDenied("Hermes gateway: new tab was not confirmed")
            return result

    def _downloads(self, method: str, params: Dict[str, Any]) -> Any:
        task = self._owned_task(params)
        allowed = {"owner", "taskId"} | ({"downloadId"} if method != "shared.downloads" else set())
        if set(params) != allowed:
            raise ProtocolError("invalid_params", "invalid download request")
        if method == "shared.downloads":
            with self.state_lock:
                if self.download_registry.expire(task):
                    self._persist_tasks()
                return {"downloads": [public_download(row) for row in self.download_registry.rows(task)],
                        "unattributed": int(task.get("downloadsUnattributed", 0))}
        download_id = params.get("downloadId")
        if method == "shared.download_claim":
            with self.task_locks[task["id"]]:
                with self.state_lock:
                    try:
                        record, path = self.download_registry.claim(task, download_id)
                    except DownloadError as exc:
                        self._persist_tasks()
                        raise ProtocolError(str(exc).lower(), "download cannot be claimed",
                                            {"outcomeUnknown": False}) from None
                    self._persist_tasks()
            # 中文注释：领取结果把本机路径交给同一可信会话处理该文件；诊断日志不记录路径。
            return {**record, "localPath": path}
        with self.state_lock:
            row = self.download_registry.find(task, download_id=download_id) if isinstance(download_id, str) else None
            if row is None or row.get("generation") != task["generation"]:
                raise ProtocolError("download_not_found", "download not found", {"outcomeUnknown": False})
            if row.get("state") != "in_progress":
                return public_download(row)
            extension = self.extensions.get(task["instanceId"])
            if extension is None:
                raise ProtocolError("instance_unavailable", "browser instance is not connected")
            ref, generation = row["ref"], task["generation"]
        result = self._extension_call(extension, "browser.download_cancel", {
            "taskId": task["id"], "generation": generation, "downloadRef": ref}, timeout=10.0)
        with self.state_lock:
            if isinstance(result, dict) and result.get("cancelled") is True and row.get("state") == "in_progress":
                row.update(state="cancelled", completedAt=time.time())
                self._persist_tasks()
            return public_download(row)

    def _handle_tab_event(self, instance_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        task_id = self._required_string(params, "taskId")
        tab_id = params.get("tabId")
        event = params.get("event")
        document_generation = params.get("documentGeneration")
        if not isinstance(tab_id, int) or isinstance(tab_id, bool) or tab_id < 0:
            raise ProtocolError("invalid_params", "tabId must be a non-negative integer")
        if event not in {"closed", "navigated", "created"}:
            raise ProtocolError("invalid_params", "unknown tab event")
        if event != "created" and (not isinstance(document_generation, int) or isinstance(document_generation, bool) or document_generation < 0):
            raise ProtocolError("invalid_params", "documentGeneration must be a non-negative integer")
        with self.state_lock:
            task = self.tasks.get(task_id)
            if task is None or task["instanceId"] != instance_id:
                raise ProtocolError("not_found", "task not found for this browser instance")
            # 中文注释：关闭和导航通知与新建通知一样绑定代次，旧事件不得撤销恢复后的同一标签。
            if type(params.get('generation')) is not int or params['generation'] != task['generation']:
                raise ProtocolError('approval_stale', 'tab event task generation changed')
            if event == "created":
                opener = params.get("openerTabId")
                if (type(params.get("generation")) is not int or params["generation"] != task["generation"]
                        or task["state"] not in {"ready", "running", "paused"}):
                    raise ProtocolError("approval_stale", "popup task generation changed")
                if (type(opener) is not int
                        or (opener not in task.get("spawnedTabIds", []) and self.tab_leases.get((instance_id, opener)) != task_id)
                        or tab_id in task["agentTabIds"] or (instance_id, tab_id) in self.tab_leases):
                    raise ProtocolError("foreign_tab", "popup opener is not owned by this task")
                task.setdefault("spawnedTabIds", []).append(tab_id)
                task["agentTabIds"].append(tab_id)
                task["spawnedTabCount"] = len(task["spawnedTabIds"])
                task["updatedAt"] = time.time()
                self._persist_tasks()
                return self._public_task(task)
            if self.tab_leases.get((instance_id, tab_id)) != task_id:
                # 中文注释：只接受当前代次在途建页请求的提前关闭通知；其他任务租约不受影响。
                request_id = params.get("creationRequestId")
                request_hash = _sha256(request_id) if isinstance(request_id, str) else None
                pending_open = next((row for row in task.get("requestHistory", [])
                    if row.get("requestIdHash") == request_hash and row.get("generation") == task["generation"]
                    and row.get("state") == "dispatched" and row.get("action") in {"new_tab", "official.new_tab"}), None)
                if (event == "closed" and (instance_id, tab_id) not in self.tab_leases and pending_open
                        and (task_id, request_hash) in self.inflight_requests):
                    retired = task.setdefault("retiredAgentTabs", {}).setdefault(str(task["generation"]), [])
                    if tab_id not in retired:
                        retired.append(tab_id)
                    self._persist_tasks()
                    return self._public_task(task)
                raise ProtocolError("foreign_tab", "tab is not leased to this task")
            self._revoke_api_locked(task)
            if event == "closed":
                # 中文注释：已知模型页的关闭事件也登记墓碑，晚到建页回执不能复活该页。
                if tab_id in task["agentTabIds"]:
                    retired = task.setdefault("retiredAgentTabs", {}).setdefault(str(task["generation"]), [])
                    if tab_id not in retired:
                        retired.append(tab_id)
                del self.tab_leases[(instance_id, tab_id)]
                if tab_id in task.get("outOfScopeTabIds", []):
                    task["outOfScopeTabIds"] = [value for value in task["outOfScopeTabIds"] if value != tab_id]
                task["tabIds"] = [value for value in task["tabIds"] if value != tab_id]
                task["agentTabIds"] = [value for value in task["agentTabIds"] if value != tab_id]
                # 中文注释：建页回执尚未到达时，登记集合为空不代表工作区丢失。
                opening = any(row.get("action") in {"new_tab", "official.new_tab"}
                              and row.get("state") == "dispatched" and row.get("generation") == task["generation"]
                              for row in task.get("requestHistory", []))
                if not task["tabIds"] and not opening and task["state"] in {"ready", "running", "paused"}:
                    task["state"] = "needs_sync"
            elif params.get("outOfScope") is True and "url" not in params:
                # 标签页离开授权网站：只标记该页，任务、租约与标签组保持不变；
                # 扩展侧会拒绝该页上除“导航回授权网站”之外的全部动作。
                # 中文注释：同时废弃旧网关及其缓存 session，返回授权网站后也不能复活旧连接。
                self.cdp_gateway.revoke(task_id)
                off = task.setdefault("outOfScopeTabIds", [])
                if tab_id not in off:
                    off.append(tab_id)
            else:
                url = params.get("url")
                try:
                    if not (url == "about:blank" and tab_id in task.get("officialBlankTabs", [])):
                        if isinstance(url, str):
                            # 中文注释：可信扩展的租约页通知可能早于建页回执，先登记精确 www 跳转。
                            for site in task['allowedOrigins']:
                                redirected = self._www_redirect_origin(site+'/', url)
                                if redirected and redirected not in task['allowedOrigins']:
                                    task['allowedOrigins'].append(redirected)
                                    break
                        self._validate_action_url(url, task["allowedOrigins"])
                        # 中文注释：空白工作页一旦进入真实来源，就不再保留 about:blank 例外。
                        if tab_id in task.get("officialBlankTabs", []):
                            task["officialBlankTabs"].remove(tab_id)
                except ProtocolError:
                    self._revoke_task_locked(task, "needs_sync")
                    self._persist_tasks()
                    raise
                if tab_id in task.get("outOfScopeTabIds", []):
                    task["outOfScopeTabIds"] = [value for value in task["outOfScopeTabIds"] if value != tab_id]
            task["updatedAt"] = time.time()
            self._persist_tasks()
            return self._public_task(task)

    def _serve_extension(self, conn: socket.socket, reader, origin: str) -> None:
        instance_id = None
        try:
            request = _read_line(reader)
            params = request.get("params")
            if request.get("method") != "extension.hello" or not isinstance(params, dict):
                conn.sendall(_encode_line({"id": request.get("id"), "error": {"code": "hello_required", "message": "extension.hello required"}}))
                return
            instance_id = params.get("instanceId")
            browser = params.get("browser")
            version = params.get("version")
            raw_capabilities = params.get("capabilities")
            capabilities = raw_capabilities if isinstance(raw_capabilities, dict) else {}
            consent_status_supported = capabilities.get("consentStatus") is True
            access_request_supported = capabilities.get("accessRequest") is True
            if not isinstance(instance_id, str) or not instance_id or browser not in {"chrome", "edge"} or not isinstance(version, str):
                conn.sendall(_encode_line({"id": request.get("id"), "error": {"code": "invalid_params", "message": "invalid extension metadata"}}))
                return
            connection_generation = uuid.uuid4().hex
            with self.state_lock:
                old = self.extensions.get(instance_id)
                if old is not None:
                    for task in self.tasks.values():
                        if task["instanceId"] != instance_id or task["state"] in {"cancelled", "closed", "failed", "needs_sync"}:
                            continue
                        self._revoke_task_locked(task, "needs_sync")
                    self._persist_tasks()
                    with old["pendingLock"]:
                        for pending in old["pending"].values():
                            pending["response"] = None
                            pending["event"].set()
                    try:
                        old["socket"].shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                extension = {
                    "instanceId": instance_id,
                    "browser": browser,
                    "version": version,
                    "origin": origin,
                    "socket": conn,
                    "sendLock": threading.RLock(),
                    "pendingLock": threading.Lock(),
                    "pending": {},
                    "connectionGeneration": connection_generation,
                    "consentStatusSupported": consent_status_supported,
                    "accessRequestSupported": access_request_supported,
                    "statusProjection": capabilities.get("statusProjection") is True,
                    # 中文注释：只接收当前实现认识的能力标识，缺失时不推断支持。
                    "features": [f for f in ('browser_core_v1', 'page_parse_v1', 'page_function_v1', 'network_evidence_v1')
                                 if isinstance(capabilities.get('features'), list) and f in capabilities['features']],
                    "accessRequest": None,
                }
                # 中文注释：当前读循环只持有自己登记的连接，不能在锁外重新取到并发替换后的 socket。
                self.extensions[instance_id] = extension
            self._diagnostic("connection_state", "connected")
            hello_result = {"connected": True}
            if access_request_supported:
                hello_result.update(instanceId=instance_id, connectionGeneration=connection_generation)
            self._send_extension(extension, {"id": request.get("id"), "result": hello_result})
            # 中文注释：hello 后只对最近终态且清理未确认的任务补收组，needs_sync 保留恢复组。
            threading.Thread(target=self._ungroup_terminal_tasks, args=(instance_id, extension), daemon=True).start()
            while not self.stop_event.is_set():
                request = _read_line(reader)
                if self._accept_extension_response(extension, request):
                    continue
                request_id = request.get("id")
                with extension["sendLock"]:
                    try:
                        result = self._dispatch_connected_extension(extension, request.get("method"), request.get("params"))
                        # 中文注释：扩展入口的停止/撤权与客户端入口一样先落盘，再确认；崩溃不能复活已确认撤销的任务。
                        if request.get('method') in {'extension.stop', 'extension.reject', 'extension.revoke_access'}:
                            self._flush_tasks()
                        response = {"id": request_id, "result": result}
                    except ProtocolError as exc:
                        response = {"id": request_id, "error": {"code": exc.code, "message": exc.message}}
                    extension["socket"].sendall(_encode_line(response))
                method = request.get("method")
                if method == "extension.tab_event" or (
                    method in {"extension.approve", "extension.reject", "extension.stop", "extension.revoke_access"}
                    and "result" in response
                ):
                    self._notify_tasks_changed(instance_id)
                    if method in {"extension.stop", "extension.revoke_access"}:
                        threading.Thread(target=self._ungroup_terminal_tasks, args=(instance_id, extension, request.get("params", {}).get("taskId")), daemon=True).start()
        finally:
            if instance_id is not None:
                with self.state_lock:
                    current = self.extensions.get(instance_id)
                    if current is not None and current.get("socket") is conn:
                        del self.extensions[instance_id]
                        self._diagnostic("connection_state", "disconnected", error_code="DISCONNECTED")
                        for task in self.tasks.values():
                            if task["instanceId"] != instance_id or task["state"] in {"cancelled", "closed", "failed", "needs_sync"}:
                                continue
                            self._revoke_task_locked(task, "needs_sync")
                        self._persist_tasks()
                        with current["pendingLock"]:
                            for pending in current["pending"].values():
                                pending["response"] = None
                                pending["event"].set()


def _open_private_regular(path: Path, flags: int, mode: int) -> int:
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags | no_follow, mode)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise RuntimeError(f"refusing symlink for private file: {path.name}") from exc
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError(f"private file is not a same-owner regular file: {path.name}")
        os.fchmod(fd, mode)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_private_regular(path: Path) -> bytes:
    fd = _open_private_regular(path, os.O_RDONLY, 0o600)
    with os.fdopen(fd, "rb") as handle:
        return handle.read()


def _atomic_write_private(path: Path, data: bytes) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            # Ownership transfers to handle. Never close the numeric FD again:
            # another connection may reuse it as soon as this context exits.
            fd = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _encode_line(value: Dict[str, Any]) -> bytes:
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(data) > _MAX_LINE:
        raise ValueError("payload too large")
    return data + b"\n"


def _read_line(reader) -> Dict[str, Any]:
    line = reader.readline(_MAX_LINE + 1)
    if not line:
        raise EOFError
    if len(line) > _MAX_LINE or not line.endswith(b"\n"):
        raise ValueError("invalid frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("frame must be object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    args = parser.parse_args()
    daemon = BridgeDaemon(Path(args.home))
    signal.signal(signal.SIGTERM, daemon.stop)
    signal.signal(signal.SIGINT, daemon.stop)
    return daemon.run()


if __name__ == "__main__":
    raise SystemExit(main())
