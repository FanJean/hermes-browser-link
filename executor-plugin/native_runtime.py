"""Independent native bridge runtime; never starts an isolated browser.

Integration API: get_native_profile_runtime(home, plugin_root) returns the
profile singleton. Register via native_tools.register_native_context(ctx, runtime).
release_native_profile_runtime(home, expected) revokes local leases, but NEVER
kills the shared daemon or closes browser tabs. Source client lives in
../native-bridge/client.py; packaged client in ./native_bridge/client.py.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import secrets
import json
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

_LOAD_LOCK = threading.RLock()


def load_module(path: Path, prefix: str):
    path = path.resolve()
    name = prefix + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    with _LOAD_LOCK:
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError('无法加载共享浏览器组件')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
        return module


_base = load_module(Path(__file__).with_name('runtime.py'), 'hermes_browser_link_runtime_')
OWNER_LEASE_ARG = _base.OWNER_LEASE_ARG
OwnerLeaseError = _base.OwnerLeaseError
TOOL_NAMES = tuple('browser_shared_' + suffix for suffix in (
    # 中文注释：文件清单只提供当前可信会话的任务级元信息。
    'health', 'browsers', 'create', 'list', 'get', 'artifacts', 'run', 'cancel', 'resume', 'close', 'downloads', 'cookie_mirror'))


class NativeOwnerAuthority(_base.OwnerAuthority):
    """Reuse stable profile HMAC identity and one-shot consumer, not core state."""

    def lease_tools(self, names, *, passthrough=False):
        """Also lease the plugin's script tool and any official tools it overrides.

        Only the host registers names here, never model input. ``passthrough``
        names are official tools: a call without trusted identity gets no lease
        and is left to Hermes' original handler instead of being blocked.
        """
        extra = getattr(self, '_extra_tool_names', frozenset())
        self._extra_tool_names = extra | frozenset(names)
        if passthrough:
            self._passthrough_tool_names = getattr(self, '_passthrough_tool_names', frozenset()) | frozenset(names)

    def pre_tool_call(self, tool_name, args, *, session_id='', tool_call_id='', **_):
        if tool_name not in TOOL_NAMES and tool_name not in getattr(self, '_extra_tool_names', ()):
            return None
        if tool_name in getattr(self, '_passthrough_tool_names', ()) and (
                not isinstance(args, dict) or OWNER_LEASE_ARG in args
                or not isinstance(session_id, str) or not session_id.strip()
                or not isinstance(tool_call_id, str) or not tool_call_id.strip()):
            # A forged lease key is stripped and rejected by the override handler.
            return None
        if not isinstance(args, dict):
            return {'action': 'block', 'message': '浏览器参数必须是对象'}
        if OWNER_LEASE_ARG in args or 'owner' in args or 'session_id' in args:
            return {'action': 'block', 'message': '拒绝模型指定浏览器身份'}
        if not isinstance(session_id, str) or not session_id.strip() or not isinstance(tool_call_id, str) or not tool_call_id.strip():
            return {'action': 'block', 'message': '缺少可信工具调用身份'}
        try:
            owner = self.owner_for_session(session_id)
            self._remember_owner(owner)
            digest = _base._canonical_args_digest(args)
        except (OSError, ValueError, TypeError, OwnerLeaseError):
            return {'action': 'block', 'message': '无法建立可信浏览器身份'}
        now = self._clock()
        token = secrets.token_urlsafe(32)
        lease = _base.OwnerLease(owner, tool_name, tool_call_id, digest, now + _base._LEASE_TTL_SECONDS)
        with self._lock:
            self._prune_locked(now)
            if len(self._leases) >= _base._MAX_LEASES:
                return {'action': 'block', 'message': '浏览器身份队列已满'}
            self._leases[token] = lease
        return {'action': 'modify', 'args': {OWNER_LEASE_ARG: token}}


class NativeProfileRuntime:
    def __init__(self, hermes_home: Path, plugin_root: Path, *, bridge_client=None):
        self.hermes_home = Path(hermes_home).expanduser().resolve()
        self.plugin_root = Path(plugin_root).expanduser().resolve()
        self.authority = NativeOwnerAuthority(self.hermes_home / 'plugin-data' / 'browser-link-native' / 'authority')
        # 中文注释：扩展只连默认 HERMES_HOME 的守护进程；其他 profile 设 HERMES_BROWSER_BRIDGE_HOME 共用它。
        # 任务仍按本 profile 的 owner 身份隔离，凭据库（vault）不共用。
        bridge_home = os.environ.get('HERMES_BROWSER_BRIDGE_HOME', '').strip()
        if bridge_home:
            self.bridge_home = Path(bridge_home).expanduser().resolve()
        elif self.hermes_home.parent.name == 'profiles':
            # 中文注释：网关多 profile 模式下 .env 不进 os.environ，按目录结构回退到 ~/.hermes。
            self.bridge_home = self.hermes_home.parent.parent
        else:
            self.bridge_home = self.hermes_home
        self._client = bridge_client
        self._client_module = None
        self._lock = threading.RLock()
        self._closed = False
        self._thread_clients = {}

    def session_for_key(self, session_key):
        # 中文注释：只读宿主当前路由表，精确匹配 scope/key；不把路由 key 当作会话 ID，也不猜旧 JSON 镜像。
        if not isinstance(session_key, str) or not session_key.strip():
            return None
        path = self.bridge_home / 'state.db'
        scope = str((self.bridge_home / 'sessions').resolve())
        try:
            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
                rows = db.execute('SELECT entry_json FROM gateway_routing WHERE scope = ? AND session_key = ?',
                                  (scope, session_key)).fetchall()
            if len(rows) != 1:
                return None
            entry = json.loads(rows[0][0])
            if not isinstance(entry, dict):
                return None
            session_id = entry.get('session_id')
            if entry.get('session_key') != session_key or not isinstance(session_id, str) or not session_id.strip():
                return None
            if self.authority.owner_for_session(session_id) not in self.authority.known_owners():
                return None
            return session_id
        except (sqlite3.Error, OSError, ValueError, TypeError):
            return None

    def call(self, method: str, params: dict[str, Any]):
        with self._lock:
            if self._closed:
                raise RuntimeError('共享浏览器工具已卸载')
            if self._client is None and self._client_module is None:
                candidates = (self.plugin_root / 'native_bridge' / 'client.py',
                              self.plugin_root.parent / 'native-bridge' / 'client.py')
                entry = next((path for path in candidates if path.is_file()), None)
                if entry is None:
                    raise RuntimeError('尚未安装共享浏览器桥接服务')
                self._client_module = load_module(entry, 'hermes_browser_native_client_')
            if self._client is not None:
                client = self._client
            else:
                assert self._client_module is not None
                # Keep the client deadline longer than the daemon's 30-second
                # browser deadline so timeout errors remain classified.
                # 中文注释：CDP 自定义期限还需留给 daemon 清理与回执，客户端不能先在固定 35 秒断线。
                timeout = 35.0
                # 中文注释：JS 的 daemon 期限为 75 秒，客户端再留 5 秒回执时间，避免长脚本被提前报未知。
                if method == 'shared.run' and params.get('action') == 'js.evaluate':
                    timeout = 80.0
                if (method == "shared.run" and params.get("action") == "cdp.send"
                        and type(params.get("timeoutMs")) is int and 100 <= params["timeoutMs"] <= 60000):
                    timeout = max(timeout, params["timeoutMs"] / 1000 + 10.0)
                # 中文注释：每个调用线程复用连接；不同线程可同时取消或执行，写入未知时不重试。
                thread = threading.current_thread()
                client = self._thread_clients.get(thread)
                if client is None:
                    client = self._client_module.BridgeClient(self.bridge_home, timeout=timeout)
                    self._thread_clients[thread] = client
                client.timeout = timeout
                # 中文注释：活动通知只连接已有 daemon，避免 doctor/reference 只读调用启动后台服务。
                client.autostart = method != 'shared.activity'
                for previous in list(self._thread_clients):
                    if previous is not thread and not previous.is_alive():
                        self._thread_clients.pop(previous).close()
        # 中文注释：线程各自持有连接，取消请求不会排在另一个线程的动作后面。
        # The plugin never retries an RPC with an uncertain outcome.
        # 中文注释：复用连接由 close 或线程回收统一关闭，不保留不可达的单次关闭分支。
        return client.call(method, params)

    def vault_private_call(self, operation: str, params: dict[str, Any]):
        # 中文注释：凭据值只进入独立客户端，不经过通用 BridgeClient.call 或脚本工具。
        with self._lock:
            if self._closed:
                raise RuntimeError('Vault private channel unavailable')
            candidates = (self.plugin_root / 'native_bridge' / 'vault_client.py',
                          self.plugin_root.parent / 'native-bridge' / 'vault_client.py')
            entry = next((path for path in candidates if path.is_file()), None)
            if entry is None:
                raise RuntimeError('Vault private channel unavailable')
        private = load_module(entry, 'hermes_browser_vault_client_')
        return private.call(self.hermes_home, operation, params)

    def close(self):
        with self._lock:
            self._closed = True
            clients = list(self._thread_clients.values())
            self._thread_clients.clear()
        for client in clients:
            client.close()
        with self.authority._lock:
            self.authority._leases.clear()


_RUNTIMES = {}
_RUNTIME_LOCK = threading.RLock()


def get_native_profile_runtime(hermes_home: Path, plugin_root: Path):
    key = str(Path(hermes_home).expanduser().resolve())
    with _RUNTIME_LOCK:
        if key not in _RUNTIMES:
            _RUNTIMES[key] = NativeProfileRuntime(Path(key), plugin_root)
        return _RUNTIMES[key]


def release_native_profile_runtime(hermes_home: Path, expected=None):
    key = str(Path(hermes_home).expanduser().resolve())
    with _RUNTIME_LOCK:
        runtime = _RUNTIMES.get(key)
        if runtime is None or (expected is not None and runtime is not expected):
            return
        del _RUNTIMES[key]
    runtime.close()
