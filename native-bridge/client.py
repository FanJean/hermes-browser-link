#!/usr/bin/env python3
"""Synchronous client for the profile-scoped native browser bridge."""

from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Dict

_MAX_LINE = 1024 * 1024
_STARTUP_LOCKS_GUARD = threading.Lock()
_STARTUP_LOCKS: dict[Path, threading.Lock] = {}


def _data_dir(home: os.PathLike[str] | str) -> Path:
    return Path(home).expanduser().resolve() / "plugin-data" / "browser-link-native"


def _read_token(home: os.PathLike[str] | str) -> str:
    path = _data_dir(home) / "token"
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, os.O_RDONLY | no_follow)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise BridgeError("insecure_token", "native bridge token must not be a symlink") from exc
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise BridgeError("insecure_token", "native bridge token is not a same-owner regular file")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise BridgeError("insecure_token", "native bridge token permissions must be 0600")
        with os.fdopen(fd, "r", encoding="ascii") as handle:
            fd = -1
            token = handle.read(4097).strip()
        if not token or len(token) > 4096:
            raise BridgeError("insecure_token", "native bridge token is invalid")
        return token
    finally:
        if fd >= 0:
            os.close(fd)


def safe_summary(value):
    # 中文注释：错误通路复用结果的数字、域名和固定类别约束，只接受镜像汇总字段。
    if not isinstance(value, dict):
        return {}
    import re
    result = {}
    for key in ('count', 'success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed'):
        if type(value.get(key)) is int and 0 <= value[key] <= 1000000:
            result[key] = value[key]
    if isinstance(value.get('reason'), str) and value['reason'] in {'transfer_failed', 'expired', 'disconnected'}:
        result['reason'] = value['reason']
    if isinstance(value.get('reasons'), dict):
        result['reasons'] = {key: n for key, n in value['reasons'].items()
                             if key in {'expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'} and type(n) is int and 0 <= n <= 1000000}
    if isinstance(value.get('sites'), list):
        result['sites'] = [{'site': row['site'], **safe_summary({key: item for key, item in row.items() if key != 'sites'})}
                           for row in value['sites'][:4096] if isinstance(row, dict) and isinstance(row.get('site'), str) and re.fullmatch(r'(?:[a-z0-9-]+\.)*[a-z0-9-]+|\[[0-9a-f:]{2,45}\]', row['site']) and len(row['site']) <= 253]
    return result


class BridgeError(RuntimeError):
    def __init__(self, code: str, message: str, data: Any = None):
        # 中文注释：Cookie 异常文本也固定，防止浏览器异常被调用方记录到日志。
        if code == 'cookie_mirror_denied':
            message = 'Cookie 镜像请求不可用，请在扩展中核实。'
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = {key: data[key] for key in ("outcomeUnknown", "retryable")
                     if isinstance(data, dict) and type(data.get(key)) is bool}
        # 中文注释：保护仍拒绝输出，仅转发扩展已确认的点击事实，不接受页面字段或异常原文。
        if (isinstance(data, dict) and data.get('actionConfirmed') is True and code in {
                'content_shield_stale', 'content_shield_changed', 'content_shield_unavailable',
                'content_shield_uninspectable', 'content_shield_unsupported', 'content_shield_invalid_rules',
                'content_shield_unsupported_viewport', 'content_shield_blocker_overlap', 'content_shield_render_unsupported'}):
            self.data['actionConfirmed'] = True
        # 中文注释：点击错误只保留固定效果和提示，脚本与工具共用该边界。
        if isinstance(data, dict) and code == 'click_no_effect':
            self.data['effect'] = 'unobserved'
            if data.get('suggestion') == '输入已派发但未观察到效果；请读取目标页核对，检查按钮状态或改用页面支持的操作，不要反复重试。':
                self.data['suggestion'] = data['suggestion']
        if code == 'cookie_mirror_denied':
            # 中文注释：镜像错误与页面错误分开处理，不放行候选、遮挡或任意诊断文本。
            self.data.update(safe_summary(data))
            return
        # 中文注释：仅转发固定形状的脱敏候选和遮挡摘要；不转发网页异常原文。
        if isinstance(data, dict) and code in {'reference_target_missing', 'reference_target_ambiguous'}:
            rows = data.get('candidates')
            if isinstance(rows, list):
                self.data['candidates'] = [{'role': row['role'][:40], 'name': row['name'][:80]}
                                           for row in rows[:5] if isinstance(row, dict)
                                           and isinstance(row.get('role'), str) and isinstance(row.get('name'), str)]
        if isinstance(data, dict) and code == 'target_occluded':
            obstruction = data.get('obstruction')
            if isinstance(obstruction, dict) and isinstance(obstruction.get('role'), str) and isinstance(obstruction.get('name'), str):
                self.data['obstruction'] = {'role': obstruction['role'][:40], 'name': obstruction['name'][:80]}
                button = obstruction.get('closeButton')
                binding = button.get('binding') if isinstance(button, dict) else None
                if isinstance(binding, dict) and all(isinstance(binding.get(key), str) for key in ('taskId', 'documentId', 'leaseId')) and all(isinstance(button.get(key), str) for key in ('snapshotId', 'ref', 'name')):
                    self.data['obstruction']['closeButton'] = {'binding': {key: binding[key] for key in ('taskId', 'documentId', 'leaseId')}, 'snapshotId': button['snapshotId'], 'ref': button['ref'], 'role': 'button', 'name': button['name'][:80]}
        # 中文注释：只允许固定阶段原因和脱敏当前来源；字段名不会带入网页异常文本。
        if isinstance(data, dict):
            if isinstance(data.get('stage'), str) and isinstance(data.get('reasonCode'), str) and (data.get('stage'), data.get('reasonCode')) in {('overlay', 'initialization_exception'), ('overlay', 'return_type_invalid'), ('document', 'document_changed')}:
                self.data.update(stage=data['stage'], reasonCode=data['reasonCode'])
            if code in {'origin_denied', 'tab_out_of_scope'} and isinstance(data.get('currentOrigin'), str):
                from urllib.parse import urlsplit
                try:
                    parts = urlsplit(data['currentOrigin'])
                    if parts.scheme in {'http', 'https'} and parts.hostname and not parts.username and not parts.password:
                        parts.port
                        self.data['currentOrigin'] = f'{parts.scheme}://{parts.netloc}'
                        self.data['scopeHint'] = '同站用 goto_url，新站用 browser_shared_open。'
                except ValueError:
                    pass
        # 中文注释：跨站跳转仅传已验证的来源，不转发路径或异常原文。
        if code == 'redirected_out_of_scope' and isinstance(data, dict):
            from urllib.parse import urlsplit
            value = data.get('finalOrigin')
            if isinstance(value, str):
                parts = urlsplit(value)
                if parts.scheme in {'http', 'https'} and parts.hostname and not parts.path and not parts.query and not parts.fragment and not parts.username and not parts.password:
                    self.data['finalOrigin'] = value


class BridgeClient:
    """Thread-safe synchronous JSONL client."""

    def __init__(self, home: os.PathLike[str] | str, timeout: float = 15.0, *, autostart: bool = True):
        self.home = Path(home).expanduser().resolve()
        self.timeout = timeout
        # 中文注释：一次性清理必须使用已经运行的服务，不能因连接失败自动启动并触发空闲扫描。
        self.autostart = autostart
        self._socket: socket.socket | None = None
        self._reader = None
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self._disconnect()

    def _disconnect(self) -> None:
        reader, sock = self._reader, self._socket
        self._reader = None
        self._socket = None
        if reader is not None:
            try:
                reader.close()
            except OSError:
                pass
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _connect(self) -> None:
        # 中文注释：先直连现有服务，只有连接前失败才启动/探活；数据目录归属检查不能因快路径省略。
        def connect():
            data_dir = _checked_data_dir(self.home)
            token = _read_token(self.home)
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.settimeout(self.timeout)
                sock.connect(str(data_dir / "bridge.sock"))
                sock.sendall(_encode_line({"role": "client", "token": token}))
                self._socket = sock
                self._reader = sock.makefile("rb")
            except Exception:
                sock.close()
                raise
        try:
            connect()
        except (FileNotFoundError, ConnectionRefusedError):
            if not self.autostart:
                raise BridgeError('service_unavailable', 'native bridge is not running') from None
            ensure_service(self.home)
            connect()

    def _reusable(self) -> bool:
        # 中文注释：复用前确认 daemon 未关闭连接；请求尚未发出，此时重连不会重放任何动作。
        sock = self._socket
        if sock is None:
            return False
        try:
            readable, _, _ = select.select([sock], [], [], 0)
        except (OSError, ValueError):
            return False
        # 空闲连接可读意味着 EOF 或未请求的数据，二者都不可复用。
        return not readable

    def call(self, method: str, params: Dict[str, Any] | None = None) -> Any:
        request = {"id": uuid.uuid4().hex, "method": method, "params": params or {}}
        with self._lock:
            if self._socket is not None and not self._reusable():
                self._disconnect()
            for attempt in range(2):
                if self._socket is None:
                    try:
                        self._connect()
                    except (OSError, EOFError, ValueError, json.JSONDecodeError, BridgeError):
                        self._disconnect()
                        if attempt == 0:
                            continue
                        raise BridgeError("connection_failed", "native bridge connection failed")
                assert self._socket is not None and self._reader is not None
                # 中文注释：长连接每次调用使用本动作的期限。
                self._socket.settimeout(self.timeout)
                try:
                    self._socket.sendall(_encode_line(request))
                except OSError as exc:
                    self._disconnect()
                    raise BridgeError("outcome_unknown", "request may have been accepted before the connection failed") from exc
                try:
                    response = _read_line(self._reader)
                except (OSError, EOFError, ValueError, json.JSONDecodeError) as exc:
                    self._disconnect()
                    raise BridgeError("outcome_unknown", "request outcome is unknown because the response was lost") from exc
                if response.get("id") != request["id"]:
                    self._disconnect()
                    raise BridgeError("protocol_error", "response id mismatch")
                if "error" in response:
                    error = response["error"]
                    raise BridgeError(str(error.get("code", "error")), str(error.get("message", "bridge error")), error.get("data"))
                return response.get("result")
            raise BridgeError("connection_failed", "native bridge connection failed")


def _encode_line(value: Dict[str, Any]) -> bytes:
    data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(data) > _MAX_LINE:
        raise BridgeError("payload_too_large", "bridge payload exceeds limit")
    return data + b"\n"


def _read_line(reader) -> Dict[str, Any]:
    line = reader.readline(_MAX_LINE + 1)
    if not line:
        raise EOFError("bridge closed")
    if len(line) > _MAX_LINE or not line.endswith(b"\n"):
        raise ValueError("invalid bridge frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("bridge frame must be an object")
    return value


def _spawn_detached(argv: list[str]) -> None:
    """Launch safely from multi-threaded hosts and reap on eventual exit."""
    process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    threading.Thread(target=process.wait, name="browser-bridge-reaper", daemon=True).start()


def _startup_thread_lock(home: Path) -> threading.Lock:
    with _STARTUP_LOCKS_GUARD:
        lock = _STARTUP_LOCKS.get(home)
        if lock is None:
            lock = threading.Lock()
            _STARTUP_LOCKS[home] = lock
        return lock


def _open_startup_lock(path: Path) -> int:
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | no_follow, 0o600)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise BridgeError("insecure_startup_lock", "native bridge startup lock must not be a symlink") from exc
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise BridgeError(
                "insecure_startup_lock",
                "native bridge startup lock is not a same-owner regular file",
            )
        os.fchmod(fd, 0o600)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _checked_data_dir(home: os.PathLike[str] | str) -> Path:
    data_dir = _data_dir(Path(home).expanduser().resolve())
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = os.lstat(data_dir)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BridgeError("insecure_data_dir", "native bridge data path must be a same-owner real directory")
    os.chmod(data_dir, 0o700)
    return data_dir


MAINTENANCE_MARKER = "maintenance.json"


def maintenance_active(home: os.PathLike[str] | str) -> bool:
    """开发同步维护期间存在标记；任何形式的同名节点都按维护处理，不跟随也不读取。"""
    return os.path.lexists(_data_dir(home) / MAINTENANCE_MARKER)


def ensure_service(home: os.PathLike[str] | str, timeout: float = 5.0) -> None:
    """Start the per-profile daemon if needed and wait for authenticated health."""
    home_path = Path(home).expanduser().resolve()
    # 中文注释：维护期间不连接正在退出的旧 daemon，也不拉起新 daemon；调用方稍后重试。
    if maintenance_active(home_path):
        raise BridgeError("maintenance", "native bridge is under maintenance; retry later")
    data_dir = _checked_data_dir(home_path)

    if _probe(home_path):
        return

    with _startup_thread_lock(home_path):
        if _probe(home_path):
            return
        lock_fd = _open_startup_lock(data_dir / "client-startup.lock")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            if _probe(home_path):
                return
            daemon_path = Path(__file__).with_name("daemon.py")
            _spawn_detached([sys.executable, str(daemon_path), "--home", str(home_path)])
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if _probe(home_path):
                    return
                time.sleep(0.025)
            raise BridgeError("startup_timeout", "native bridge did not become ready")
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)


def _probe(home: Path) -> bool:
    data_dir = _data_dir(home)
    if not (data_dir / "bridge.sock").exists() or not (data_dir / "token").exists():
        return False
    try:
        token = _read_token(home)
    except (OSError, BridgeError):
        return False
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.25)
    reader = None
    try:
        sock.connect(str(data_dir / "bridge.sock"))
        reader = sock.makefile("rb")
        sock.sendall(_encode_line({"role": "client", "token": token}))
        request_id = uuid.uuid4().hex
        sock.sendall(_encode_line({"id": request_id, "method": "health", "params": {}}))
        response = _read_line(reader)
        return response == {"id": request_id, "result": {"ok": True, "protocolVersion": 1}}
    except (OSError, EOFError, ValueError, json.JSONDecodeError, BridgeError):
        return False
    finally:
        if reader is not None:
            reader.close()
        sock.close()
