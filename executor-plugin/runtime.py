"""Trusted identity and result projection for the browser-link plugin.

OwnerAuthority derives an opaque per-profile owner from Hermes' trusted
session identity and issues one-shot leases in the pre_tool_call hook; tool
handlers consume them. _project_tool_result keeps tool results to closed,
credential-free schemas. The native bridge tools (native_runtime.py) build on
both; nothing here starts a browser or engine.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import fcntl as _fcntl
except ImportError:  # Windows keeps the in-process lock and unique temp files.
    _fcntl = None

PLUGIN_ID = "browser-link"
OWNER_LEASE_ARG = "__browser_link_owner_lease"
_LEASE_TTL_SECONDS = 120.0
_MAX_LEASES = 2048
_MAX_KNOWN_OWNERS = 1024
_OWNER_REGISTRY_LOCKS_GUARD = threading.Lock()
_OWNER_REGISTRY_LOCKS: dict[str, threading.RLock] = {}


def _owner_registry_thread_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _OWNER_REGISTRY_LOCKS_GUARD:
        return _OWNER_REGISTRY_LOCKS.setdefault(key, threading.RLock())


class OwnerLeaseError(PermissionError):
    """Trusted runtime ownership could not be established for a tool call."""


@dataclass(frozen=True)
class OwnerLease:
    owner: str
    tool_name: str
    tool_call_id: str
    args_digest: str
    expires_at: float


def _canonical_args_digest(args: dict[str, Any]) -> str:
    public_args = {key: value for key, value in args.items() if key != OWNER_LEASE_ARG}
    encoded = json.dumps(
        public_args,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class OwnerAuthority:
    """Issue one-shot leases from trusted Hermes pre-tool-call identity.

    The model never controls ``owner``. The pre-tool hook receives Hermes'
    trusted session/tool-call IDs, derives an opaque profile-local owner, and
    injects a random one-time lease into the tool arguments. The handler must
    consume that lease while also matching the trusted ``session_id`` kwarg
    passed by the registry. No ContextVar crosses the bounded worker boundary.
    """

    def __init__(self, data_dir: Path, *, clock=time.monotonic) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with contextlib_suppress_oserror():
            os.chmod(self.data_dir, 0o700)
        self._clock = clock
        self._lock = threading.RLock()
        self._leases: dict[str, OwnerLease] = {}
        self._owners_path = self.data_dir / "owners.json"
        self._registry_lock_path = self.data_dir / "owners.lock"
        self._registry_thread_lock = _owner_registry_thread_lock(self._registry_lock_path)
        with self._registry_thread_lock:
            lock_fd = self._acquire_registry_file_lock()
            try:
                self._secret = self._load_or_create_secret()
                self._known_owners = self._load_known_owners()
            finally:
                self._release_registry_file_lock(lock_fd)
        self._remember_owner(self.ui_owner())

    def _acquire_registry_file_lock(self) -> int:
        fd = os.open(self._registry_lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        os.fchmod(fd, 0o600)
        if _fcntl is not None:
            _fcntl.flock(fd, _fcntl.LOCK_EX)
        return fd

    @staticmethod
    def _release_registry_file_lock(fd: int) -> None:
        try:
            if _fcntl is not None:
                _fcntl.flock(fd, _fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def _load_or_create_secret(self) -> bytes:
        path = self.data_dir / "owner-secret"
        try:
            secret = path.read_bytes()
        except FileNotFoundError:
            secret = secrets.token_bytes(32)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(secret)
                handle.flush()
                os.fsync(handle.fileno())
        if len(secret) < 32:
            raise OwnerLeaseError("browser executor owner secret is invalid")
        with contextlib_suppress_oserror():
            os.chmod(path, 0o600)
        return secret

    def _load_known_owners(self) -> set[str]:
        try:
            raw = json.loads(self._owners_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError, TypeError):
            return set()
        owners = raw.get("owners") if isinstance(raw, dict) else None
        if not isinstance(owners, list):
            return set()
        return {
            value for value in owners
            if isinstance(value, str) and (value.startswith("tool:") or value.startswith("ui:"))
        }

    def _save_known_owners_locked(self) -> None:
        payload = json.dumps({"owners": sorted(self._known_owners)}, separators=(",", ":"))
        fd, tmp_name = tempfile.mkstemp(prefix=".owners.", suffix=".tmp", dir=self.data_dir)
        tmp = Path(tmp_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self._owners_path)
            with contextlib_suppress_oserror():
                os.chmod(self._owners_path, 0o600)
        finally:
            if fd >= 0:
                os.close(fd)
            with contextlib_suppress_oserror():
                tmp.unlink()

    def _remember_owner(self, owner: str) -> None:
        with self._lock, self._registry_thread_lock:
            lock_fd = self._acquire_registry_file_lock()
            try:
                self._known_owners.update(self._load_known_owners())
                if owner in self._known_owners:
                    return
                if len(self._known_owners) >= _MAX_KNOWN_OWNERS:
                    raise OwnerLeaseError("浏览器任务会话数量已达安全上限")
                self._known_owners.add(owner)
                self._save_known_owners_locked()
            finally:
                self._release_registry_file_lock(lock_fd)

    def known_owners(self) -> tuple[str, ...]:
        with self._lock, self._registry_thread_lock:
            lock_fd = self._acquire_registry_file_lock()
            try:
                self._known_owners.update(self._load_known_owners())
                return tuple(sorted(self._known_owners))
            finally:
                self._release_registry_file_lock(lock_fd)

    def ui_owner(self) -> str:
        digest = hmac.new(self._secret, b"ui:profile", hashlib.sha256).hexdigest()
        return f"ui:{digest}"

    def owner_for_session(self, session_id: str) -> str:
        clean = str(session_id or "").strip()
        if not clean:
            raise OwnerLeaseError("缺少可信会话身份，已拒绝浏览器操作")
        digest = hmac.new(self._secret, f"tool:{clean}".encode(), hashlib.sha256).hexdigest()
        return f"tool:{digest}"

    def consume(
        self,
        tool_name: str,
        args: dict[str, Any] | None,
        *,
        session_id: str | None,
    ) -> OwnerLease:
        current_args = args if isinstance(args, dict) else {}
        token = current_args.get(OWNER_LEASE_ARG)
        if not isinstance(token, str) or not token:
            raise OwnerLeaseError("缺少可信浏览器任务身份，已拒绝操作")
        with self._lock:
            lease = self._leases.pop(token, None)
        if lease is None:
            raise OwnerLeaseError("浏览器任务身份无效或已使用")
        now = self._clock()
        if lease.expires_at < now:
            raise OwnerLeaseError("浏览器任务身份已过期")
        expected_owner = self.owner_for_session(str(session_id or ""))
        if not hmac.compare_digest(lease.owner, expected_owner):
            raise OwnerLeaseError("浏览器任务身份与当前会话不匹配")
        if lease.tool_name != tool_name:
            raise OwnerLeaseError("浏览器任务身份与工具不匹配")
        if not hmac.compare_digest(lease.args_digest, _canonical_args_digest(current_args)):
            raise OwnerLeaseError("浏览器任务参数在授权后发生变化")
        return lease

    def _prune_locked(self, now: float) -> None:
        expired = [token for token, lease in self._leases.items() if lease.expires_at < now]
        for token in expired:
            self._leases.pop(token, None)


class contextlib_suppress_oserror:
    """Tiny local suppressor to keep this runtime stdlib-only."""

    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc, traceback):
        return bool(exc_type and issubclass(exc_type, OSError))


log = logging.getLogger("browser-link")


def _private_result_key(key: str) -> bool:
    # Normalize spelling, not substrings: tokenCount/key/leaseId are business or
    # public action-binding fields, not authentication credentials.
    normalized = ''.join(c for c in key.casefold() if c.isalnum())
    return normalized in {
        'owner', 'approvalscope', 'cookie', 'cookies', 'setcookie', 'authorization',
        'proxyauthorization', 'password', 'passwd', 'secret', 'clientsecret',
        'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken',
        'apikey', 'xapikey', 'privatekey', 'secretkey', 'signingkey', 'credentials',
        'credential', 'storagestate', 'localstorage', 'sessionstorage',
        'headers', 'requestheaders', 'responseheaders', 'body', 'rawbody',
        'requestbody', 'responsebody', 'sessiontoken', 'csrftoken', 'xsrftoken',
        'xauthtoken', 'accesskey', 'accesskeyid', 'secretaccesskey', 'awssecretaccesskey',
    }


def _strip_owner(value: Any) -> Any:
    """Recursive credential-key filtering (legacy name retained for callers).

    Not complete DLP: unlabelled secrets in prose, URLs or image pixels cannot
    be recognized reliably here. Producers must enforce page/capture privacy;
    tool handlers additionally project their explicit result envelopes below.
    Never mutate backend state or deduplication-cache objects.
    """
    if isinstance(value, dict):
        return {key: _strip_owner(item) for key, item in value.items()
                if isinstance(key, str) and not _private_result_key(key)}
    if isinstance(value, (list, tuple)):
        return [_strip_owner(item) for item in value]
    return value


# Closed result schemas: dict = named fields, [schema] = list, None = scalar.
# Only requested API business fields use recursive open JSON; all browser
# protocol envelopes and nested semantic/visual metadata are closed.
def _scalar_fields(names):
    return dict.fromkeys(names.split())


_RESULT_POINT = _scalar_fields('x y')
# 中文注释：保留过滤标记，让 agent 能区分原始内容与经过规则过滤的文本。
_RESULT_CONTENT_FILTER = _scalar_fields('enabled removedSegments siteAutomationRestricted unreadFrames')
# 中文注释：导航就绪与离开任务来源是执行器的明确状态，公共工具不能在投影时丢弃。
_RESULT_TAB = _scalar_fields('id tabId url title active selected index windowId groupId status pinned ready outOfScope')
_RESULT_ARTIFACT = _scalar_fields('id taskId sha256 mimeType size')
_RESULT_TASK = {
    **_scalar_fields('id title browser instanceId state generation activeMode modeGeneration nextStep modeStatus '
                     'createdAt updatedAt isolation lastError workspaceState cleanupState open_tabs'),
    'allowedOrigins': [None], 'tabIds': [None], 'adoptedPopupTabIds': [None],
    'workTabs': [_scalar_fields('tabId windowId groupId state')],
    'pendingInteraction': _scalar_fields('kind count'),
    'resumeSummary': _scalar_fields('urlChanged documentReplaced referencesInvalid readPageFirst'),
    # 中文注释：日志状态和固定错误码一起交付，云端读取不能把未知结果的原因再次裁掉。
    'recentLog': [_scalar_fields('time action target durationMs result errorCode')],
}
_RESULT_SEMANTIC = {
    'contentFilter': _RESULT_CONTENT_FILTER,
    **_scalar_fields('version title snapshotId kind mode nextCursor baselineId frameToken'),
    'binding': _scalar_fields('taskId documentId leaseId'),
    # 中文注释：语义上下文和状态必须穿过公共工具投影，容器引用仍不是动作别名；不放行 value 或原始属性。
    'items': [{**_scalar_fields('ref role name nameSource parentRef inputType fieldKind inputRequired disabled readonly busy checked expanded selected required omittedCells truncated inferred'),
               'actions': frozenset({'click', 'press', 'fill', 'set_checked', 'select_option'}),
               'context': [_scalar_fields('ref role name index surfaceKind')],
               'targetPath': [_scalar_fields('kind mode frameRef hostRef frameToken documentId')], 'cells': [None]}],
    'removed': [None], 'order': [None], 'resync': _scalar_fields('reason'),
    'coverage': _scalar_fields('scanned matched returned omitted filtered truncated offset complete traversalComplete scope skippedFrames unsupportedCanvas contentShieldSkippedFrames axDiscoveryComplete axEnriched axOmitted'),
    'budget': _scalar_fields('kind method limit'),
}
_RESULT_CAPTURE = {
    **_scalar_fields('id taskId generation documentId revision url dpr createdAt expiresInMs'),
    'viewport': _scalar_fields('width height'), 'scroll': _RESULT_POINT,
    'visual': _scalar_fields('x y scale'),
    'image': _scalar_fields('width height data mimeType'), 'artifact': _RESULT_ARTIFACT,
    'masked': [_scalar_fields('kind role name')],
}
# 中文注释：解析结果使用封闭来源结构，业务字段按本次 schema 单独投影。
_RESULT_SOURCE = {**_scalar_fields('sourceRef documentId parseId'), 'targetPath': [_scalar_fields('kind mode frameRef hostRef frameToken documentId')]}
_RESULT_PARSE = {
    'contentFilter': _RESULT_CONTENT_FILTER,
    **_scalar_fields('schemaVersion parseId status nextCursor frameToken'),
    'binding': _scalar_fields('taskId documentId leaseId'),
    'coverage': _scalar_fields('scanned skippedFrames traversalComplete scope complete totalRecords observedRecords returned matched offset contentShieldSkippedFrames'),
    'warnings': [None],
    'regions': [{**_RESULT_SOURCE, **_scalar_fields('kind name parentRef surfaceKind method excludedFromContent')}],
    'blocks': [{**_RESULT_SOURCE, **_scalar_fields('kind text regionRef level href truncated')}],
    'tables': [{**_RESULT_SOURCE, **_scalar_fields('tableRef row domRow observedRows declaredRows declaredColumns'), 'cells': [{**_RESULT_SOURCE, **_scalar_fields('text row column rowSpan colSpan header headerRole'), 'headerRefs': [None]}]}],
    'forms': [{**_RESULT_SOURCE, **_scalar_fields('formRef surfaceRef groupRef groupLabel label role inputType fieldKind inputRequired description validationMessage'),
               'actions': frozenset({'click', 'press', 'fill', 'set_checked', 'select_option'}),
               'state': _scalar_fields('disabled required readonly checked selected expanded busy invalid'), 'options': [_scalar_fields('text selected')]}],
    'collections': [{**_RESULT_SOURCE, **_scalar_fields('containerRef text classification method')}],
}
_RESULT_POPUP = _scalar_fields('candidateRef tabId windowId openerTabId origin windowType')
_RESULT_ACTIONS = {
    'popup_catalog': {**_scalar_fields('sourceTabId observationMs'), 'candidates': [_RESULT_POPUP]},
    'popup_adopt': {**_RESULT_POPUP, **_scalar_fields('adopted sourceTabId cleanupOwned')},
    'page.parse': _RESULT_PARSE,
    'navigate': _RESULT_TAB, 'new_tab': {**_RESULT_TAB, **_scalar_fields('open_tabs tab_hint')}, 'select_tab': _RESULT_TAB,
    'close_tab': _scalar_fields('closed tabId'), 'tabs': {'tabs': [_RESULT_TAB]},
    'snapshot': {**_RESULT_TAB, **_scalar_fields('text truncated'),
                 'contentFilter': _RESULT_CONTENT_FILTER,
                 'elements': [_scalar_fields('tag text sensitive')]},
    'screenshot': {**_scalar_fields('data path tabId omittedMoving omittedMasked'), 'artifact': _RESULT_ARTIFACT,
                   'annotations': [_scalar_fields('label x y width height')],
                   'masked': [_scalar_fields('kind role name')]},
    # 中文注释：已完成点击可引发跨来源导航，保留结果状态但不扩大网页字段白名单。
    # 中文注释：可信输入的派发后状态随公共结果透出，调用方据此决定只读核实且不得自动重试。
    'click': _scalar_fields('kind delivery effect ok clicked tabId url ready groupId windowId openedVia unsupported code popupOwnership documentChanged outOfScope outcomeUnknown'), 'fill': _scalar_fields('ok filled tabId'),
    'press': _scalar_fields('ok pressed tabId delivery effect'), 'semantic_snapshot': _RESULT_SEMANTIC,
    'frame_catalog': {'frames': [_scalar_fields('index origin access kind frameToken parentFrameToken documentId')],
                      'coverage': _scalar_fields('found ready complete depthLimited scope')},
    'scroll': _scalar_fields('tabId scrolled direction'), 'back': _scalar_fields('tabId url ready'),
    'ref_click': {**_scalar_fields('clicked kind delivery fallbackReason effect tabId url ready groupId windowId openedVia unsupported code popupOwnership documentChanged outOfScope outcomeUnknown relocated'),
                  'navigation': _scalar_fields('kind origin'), 'postCheck': _scalar_fields('status code nextStep'),
                  'dialogOpened': _scalar_fields('type message')}, 'ref_fill': _scalar_fields('filled kind relocated'),
    # 中文注释：只公开按键交付状态；网页效果仍由下一次页面读取核实。
    'ref_press': {**_scalar_fields('pressed key delivery effect dispatched documentChanged outOfScope outcomeUnknown relocated'),
                  'dialogOpened': _scalar_fields('type message')},
    'ref_set_checked': {**_scalar_fields('checked changed verified kind delivery fallbackReason dispatched effect documentChanged outOfScope outcomeUnknown relocated'),
                        'dialogOpened': _scalar_fields('type message')},
    'ref_select_option': {**_scalar_fields('changed verified selectedCount kind delivery fallbackReason dispatched effect documentChanged outOfScope outcomeUnknown relocated'),
                          # 中文注释：只返回实际选中的选项值、Unicode 标签与零基索引，不返回整个下拉列表。
                          'selectedOptions': [_scalar_fields('value label index')],
                          'dialogOpened': _scalar_fields('type message')},
    'files.upload': {**_scalar_fields('selectedCount selectionState websiteState'), 'selectedFiles': [None]},
    'images': {'images': [_scalar_fields('src alt width height')], 'count': None},
    'console': {'messages': [_scalar_fields('type text')], 'errors': [_scalar_fields('message')],
                'dropped': None, 'collectingSince': None},
    'dialog': {**_scalar_fields('handled action'), 'dialog': _scalar_fields('type message')},
    'interaction.capture': _RESULT_CAPTURE,
    'interaction.bounds': {'ref': None, 'rect': _scalar_fields('x y width height'), 'imageCenter': _RESULT_POINT},
    'interaction.click': _scalar_fields('ok kind delivery fallbackReason effect outcomeUnknown'),
    'interaction.drag_coordinates': {**_scalar_fields('ok kind delivery outcomeUnknown steps'), 'from': _RESULT_POINT, 'to': _RESULT_POINT},
    'interaction.drag_elements': {**_scalar_fields('ok kind delivery outcomeUnknown trusted steps'), 'from': _RESULT_POINT, 'to': _RESULT_POINT},
}


# 中文注释：每个公开页面动作保留固定内容保护状态，不开放规则或任意 metadata。
for _result_schema in _RESULT_ACTIONS.values():
    _result_schema['contentFilter'] = _RESULT_CONTENT_FILTER


def _project_schema(value, schema):
    if value is None:
        return None
    # 中文注释：固定动作词表只接受已知字符串，不让页面值或伪造对象进入协议动作清单。
    if isinstance(schema, frozenset):
        return list(dict.fromkeys(item for item in value if isinstance(item, str) and item in schema)) if isinstance(value, list) else []
    if isinstance(schema, dict):
        if not isinstance(value, dict):
            return {}
        result = {key: ('浏览器操作失败；请检查实际状态，不要自动重试' if key in {'error', 'lastError'} and value[key]
                       else _project_schema(value[key], subschema)) for key, subschema in schema.items()
                  if key in value and not _private_result_key(key)}
        if result.get('state') in ('unknown', 'needs_sync'):
            result.update(retryable=False, outcome_unknown=True)
        return result
    if isinstance(schema, list):
        return [_project_schema(item, schema[0]) for item in value] if isinstance(value, list) else []
    # Never let an object smuggled into a scalar field bypass its schema.
    return value if type(value) in (str, int, float, bool) else None


_UNKNOWN_ERROR_CODES = frozenset({
    'TRANSFER_OUTCOME_UNKNOWN', 'REQUEST_AMBIGUOUS', 'REQUEST_RESULT_UNAVAILABLE',
    'WAIT_TIMEOUT', 'OUTCOME_UNKNOWN', 'UNKNOWN_REQUIRES_RECONCILIATION',
})
_PUBLIC_ERROR_CODES = _UNKNOWN_ERROR_CODES | frozenset('''
    INVALID_PARAMS INVALID_URL SCHEME_BLOCKED ORIGIN_BLOCKED ACTION_NOT_ALLOWED
    TAB_NOT_FOUND FIELD_UNAVAILABLE SENSITIVE_FIELD DOM_CHANGED BINDING_MISMATCH
    STALE_SNAPSHOT STALE_REF NODE_CHANGED INVALID_OPTIONS INVALID_ROOT BUDGET_TOO_SMALL
    DOCUMENT_REPLACED OWNER_DENIED OWNER_MISMATCH DOWNLOAD_BUSY NOT_COMPLETED INVALID_TIMEOUT INVALID_ID
    UNKNOWN_SCREENSHOT SCREENSHOT_EXPIRED STALE_SCREENSHOT CAPTURE_CHANGED INVALID_COORDINATES
    INVALID_NODE_REF TARGET_OCCLUDED SENSITIVE_TARGET NODE_MOVED TARGET_NOT_ACTIONABLE
    UNSUPPORTED_SHADOW_DOM SELECTOR_NOT_UNIQUE UNSUPPORTED_DRAG_MODE INVALID_STEPS
    SCOPE_MISMATCH TYPE_DENIED INVALID_DIGEST IDEMPOTENCY_CONFLICT ACTION_FAILED
    TASK_NOT_FOUND INVALID_STATE GENERATION_MISMATCH REQUEST_ID_CONFLICT
'''.split())


def _fixed_result_error():
    return {'error': '浏览器操作结果无法确认；请检查实际状态，不要自动重试',
            'code': 'OUTCOME_UNKNOWN', 'retryable': False, 'outcome_unknown': True}


def _project_tool_result(tool_name, args, value):
    if isinstance(value, dict) and (value.get('error') or value.get('outcome_unknown') is True
                                   or value.get('status') in ('unknown', 'outcome_unknown', 'needs_sync')):
        return _fixed_result_error()
    if tool_name == 'browser_shared_cookie_mirror':
        # 中文注释：采用闭合类型白名单；不允许不明字符串塞入计数或原因字段泄露值。
        import re
        if not isinstance(value, dict):
            return {}
        result = {}
        for key in ('transferId', 'source', 'target'):
            if isinstance(value.get(key), str) and re.fullmatch(r'[a-f0-9-]{32,36}', value[key]):
                result[key] = value[key]
        if isinstance(value.get('status'), str) and value['status'] in {'preparing', 'approval_required', 'executing', 'completed', 'denied', 'failed'}:
            result['status'] = value['status']
        if isinstance(value.get('reason'), str) and value['reason'] in {'transfer_failed', 'expired', 'disconnected'}:
            result['reason'] = value['reason']
        for key in ('count', 'success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed'):
            if type(value.get(key)) is int and 0 <= value[key] <= 1000000:
                result[key] = value[key]
        # 中文注释：错误汇总也只保留固定类别及有界计数。
        if isinstance(value.get('reasons'), dict):
            result['reasons'] = {key: n for key, n in value['reasons'].items()
                if key in {'expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'} and type(n) is int and 0 <= n <= 1000000}
        rows = []
        for row in value.get('sites', []) if isinstance(value.get('sites'), list) else []:
            if not isinstance(row, dict) or not isinstance(row.get('site'), str) or not re.fullmatch(r'(?:[a-z0-9.-]{1,253}|\[[0-9a-f:]{2,45}\])', row['site']):
                continue
            projected = {'site': row['site']}
            for key in ('count', 'success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed'):
                if type(row.get(key)) is int and 0 <= row[key] <= 1000000:
                    projected[key] = row[key]
            if isinstance(row.get('reasons'), dict):
                projected['reasons'] = {key: n for key, n in row['reasons'].items()
                    if key in {'expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'} and type(n) is int and 0 <= n <= 1000000}
            rows.append(projected)
        result['sites'] = rows
        return _strip_owner(result)
    suffix = tool_name.rsplit('_', 1)[-1]
    shared = tool_name.startswith('browser_shared_')
    if suffix == 'health':
        schema = _scalar_fields('ok protocolVersion')
    elif suffix == 'browsers':
        schema = [_scalar_fields('instanceId browser connected connectedAt lastSeen profileName version consentStatus primary')]
    elif suffix == 'list':
        schema = [_RESULT_TASK]
    elif suffix == 'downloads':
        # 中文注释：下载只公开元信息；本机路径仅在显式领取后交给同一会话。
        row = _scalar_fields('id filename state mimeType bytesReceived totalBytes origin startedAt completedAt '
                             'claimedAt sha256 size reason localPath')
        schema = {'downloads': [row], 'unattributed': None} if args.get('action', 'list') == 'list' else row
    elif suffix == 'artifacts':
        # 中文注释：公开文件列表只允许已选文件的标识、来源和摘要，不透出本地路径。
        schema = [_scalar_fields('id filename mimeType size sha256 origin')]
    elif suffix != 'run':
        schema = _RESULT_TASK
    elif isinstance(value, dict) and value.get('status') == 'user_input_required':
        # A sensitive field (password, payment, one-time code): the person fills
        # it in the page. The agent never supplies or sees its value.
        result = _project_schema(value, _scalar_fields('status requestId digest expiresAt fieldKind'))
        result['message'] = ('这是敏感字段，已在浏览器中提醒用户亲自填写；不要自己填写或索要其内容。'
                             '用户完成后，用相同请求编号和参数查询结果。')
        return result
    elif isinstance(value, dict) and value.get('status') == 'completed_by_user':
        result = _project_schema(value, _scalar_fields('status filledBy fieldKind'))
        result['message'] = '用户已在页面中亲自填写该字段；内容未经过 Hermes。'
        return result
    elif isinstance(value, dict) and value.get('status') in ('approval_required', 'approved', 'executing'):
        result = _project_schema(value, _scalar_fields('status requestId digest expiresAt'))
        result['message'] = '请在浏览器扩展中确认这一次操作；确认后用相同请求编号和参数查询结果，不会重新执行。'
        return result
    elif args.get('action') in ('js.evaluate', 'cdp.send', 'cdp.events'):
        # 中文注释：页面执行按任务授权返回原始页面/协议结果，不做字段级脱敏；只限制外层体积。
        text = json.dumps(value, ensure_ascii=False, default=str)
        if len(text) > 900_000:
            return {'executed': True, 'resultTooLarge': True, 'size': len(text)}
        return value
    elif args.get('action') == 'api_request':
        # fields are top-level JSON selectors, not an allowlist applied to every
        # nested business row. Preserve row names/value/key while removing secrets.
        result = _project_schema(value, {'status': None})
        data = value.get('data') if isinstance(value, dict) else None
        result['data'] = _strip_owner({key: data[key] for key in args.get('fields', []) if key in data}) if isinstance(data, dict) else {}
        return result
    elif args.get('action') == 'page.parse':
        keys = args.get('options', {}).get('schema', {}).get('fields', {})
        schema = {**_RESULT_PARSE, 'records': [{**_RESULT_SOURCE, 'valid': None,
            'fields': {key: None for key in keys}, 'sources': {key: _RESULT_SOURCE for key in keys},
            'states': {key: _scalar_fields('status required raw') for key in keys}}]}
    else:
        schema = [_RESULT_TAB] if shared and args.get('action') == 'tabs' else _RESULT_ACTIONS.get(args.get('action'), {})
    return _strip_owner(_project_schema(value, schema))
