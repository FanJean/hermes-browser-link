"""FastAPI backend for the browser-link dashboard/desktop surface.

Hermes mounts ``router`` below ``/api/plugins/browser-link``. The host owns
authentication; this module never accepts an owner from HTTP clients.
"""
from __future__ import annotations

import hashlib
import importlib.util
import math
import re
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Depends, File, UploadFile
from pydantic import BaseModel, ConfigDict, Field


router = APIRouter()
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
def _native_tools():
    path = _PLUGIN_ROOT / 'native_tools.py'
    name = 'hermes_browser_native_api_tools_' + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    if name not in sys.modules:
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
    return sys.modules[name]


def _native_profile_runtime():
    from hermes_constants import get_hermes_home
    return _native_tools().runtime_module().get_native_profile_runtime(get_hermes_home(), _PLUGIN_ROOT)


def _artifact_store(home):
    # 中文注释：源码与发行包使用同一文件登记模块，宿主只传可信 HOME。
    candidates = (_PLUGIN_ROOT / 'native_bridge' / 'artifacts.py',
                  _PLUGIN_ROOT.parent / 'native-bridge' / 'artifacts.py')
    path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if path is None:
        raise RuntimeError('文件登记模块未安装')
    name = 'hermes_browser_artifacts_' + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError('文件登记模块不可用')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return sys.modules[name].ArtifactStore(home)


def _shared_call(fn):
    try:
        return _native_tools()._public(fn())
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, '共享浏览器桥接服务暂不可用；请安装桥接服务并检查扩展连接。操作结果不确定时请勿自动重试。') from exc


def _browser_rows(value):
    if not isinstance(value, list):
        raise ValueError('invalid browser list')
    rows = []
    for source in value:
        if not isinstance(source, dict):
            continue
        row = dict(source)
        status = row.get('consentStatus')
        row['consentStatus'] = status if isinstance(status, str) and status in {'enabled', 'disabled', 'unknown'} else 'unknown'
        row['accessRequestSupported'] = row.get('accessRequestSupported') is True
        rows.append(row)
    return rows


def _access_request_result(value):
    if (not isinstance(value, dict) or set(value) != {'requestId', 'status'}
            or not isinstance(value.get('requestId'), str) or not value['requestId']
            or len(value['requestId']) > 128
            or value.get('status') not in {'confirmation_requested', 'already_requested', 'expired', 'unknown'}):
        raise ValueError('invalid access request result')
    return value


def _shared_entries(runtime):
    # Never enumerate the daemon globally or derive owners from HTTP inputs.
    for owner in runtime.authority.known_owners():
        for task in runtime.call('shared.list', {'owner': owner}):
            yield owner, task


def _shared_target(runtime, task_id):
    matches = [owner for owner, task in _shared_entries(runtime) if task.get('id') == task_id]
    if len(matches) != 1:
        raise HTTPException(404, '未找到该共享浏览器任务')
    return {'owner': matches[0], 'taskId': task_id}


def _runtime_profile_selector_matches(selector: str) -> bool:
    """Compare a UI profile selector to Hermes' active home; never resolve client paths."""
    try:
        from hermes_constants import get_hermes_home, profile_name_for_home

        active_profile = profile_name_for_home(get_hermes_home())
    except Exception:
        return False
    return active_profile is not None and selector == active_profile


def _validate_shared_profile_selector(selector: str | None, *, detail: str):
    if selector is not None and not _runtime_profile_selector_matches(selector):
        raise HTTPException(422, detail)


async def _diagnostics_query(request: Request):
    """Accept only bounded, opaque diagnostic query parameters."""
    if await request.body():
        raise HTTPException(422, '诊断查询不接受请求正文')
    allowed = {'requestIdHash', 'limit', 'cursor', 'profile'}
    values = {}
    for key, value in request.query_params.multi_items():
        if key not in allowed or key in values:
            raise HTTPException(422, '诊断查询参数无效')
        values[key] = value

    _validate_shared_profile_selector(values.get('profile'), detail='诊断查询参数无效')

    request_hash = values.get('requestIdHash')
    if request_hash is not None and re.fullmatch(r'[a-f0-9]{64}', request_hash) is None:
        raise HTTPException(422, '诊断查询参数无效')

    raw_limit = values.get('limit', '50')
    if len(raw_limit) > 3 or re.fullmatch(r'[0-9]+', raw_limit) is None:
        raise HTTPException(422, '诊断查询参数无效')
    limit = int(raw_limit)
    if not 1 <= limit <= 100:
        raise HTTPException(422, '诊断查询参数无效')

    raw_cursor = values.get('cursor', '0')
    if len(raw_cursor) > 20 or re.fullmatch(r'[0-9]+', raw_cursor) is None:
        raise HTTPException(422, '诊断查询参数无效')
    return {'requestIdHash': request_hash, 'limit': limit, 'cursor': int(raw_cursor)}


_DIAGNOSTIC_FIELDS = frozenset({
    'events', 'execution_state', 'cleanup_state', 'has_more', 'next_cursor',
})
_DIAGNOSTIC_EVENT_FIELDS = frozenset({
    'timestamp', 'component', 'event_type', 'status', 'duration_ms', 'error_code', 'action',
})
_DIAGNOSTIC_COMPONENTS = frozenset({'native_bridge', 'mv3_background', 'mv3_content', 'diagnostics'})
_DIAGNOSTIC_EVENT_TYPES = frozenset({
    'task_state', 'request_state', 'connection_state', 'action_state', 'buffer_state', 'sink_state',
})
_DIAGNOSTIC_STATUSES = frozenset({
    'pending', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'connected',
    'disconnected', 'dropped', 'rotated', 'recovered',
})
_DIAGNOSTIC_ERROR_CODES = frozenset({
    'UNCLASSIFIED_ERROR', 'TIMEOUT', 'CANCELLED', 'DISCONNECTED', 'PROTOCOL_ERROR',
    'VALIDATION_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED',
    'INTERNAL_ERROR', 'TRANSPORT_ERROR',
})
_DIAGNOSTIC_TIMESTAMP = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
# 中文注释：诊断接口保留接管状态，与任务投影一致。
_DIAGNOSTIC_EXECUTION_STATES = frozenset({
    'pending_approval', 'running', 'ready', 'paused', 'cancelled', 'closed', 'failed', 'needs_sync', 'unknown',
})
_DIAGNOSTIC_CLEANUP_STATES = frozenset({'succeeded', 'pending', 'unknown', 'failed'})


def _valid_diagnostics_projection(value, *, limit, cursor):
    """Reject unexpected RPC fields before returning any data to HTTP callers."""
    if not isinstance(value, dict) or set(value) != _DIAGNOSTIC_FIELDS:
        return False
    if value['execution_state'] not in _DIAGNOSTIC_EXECUTION_STATES:
        return False
    if value['cleanup_state'] not in _DIAGNOSTIC_CLEANUP_STATES:
        return False
    events = value['events']
    if not isinstance(events, list) or len(events) > limit:
        return False
    for event in events:
        if not isinstance(event, dict) or set(event) != _DIAGNOSTIC_EVENT_FIELDS:
            return False
        if not isinstance(event['timestamp'], str) or not _DIAGNOSTIC_TIMESTAMP.fullmatch(event['timestamp']):
            return False
        if event['component'] not in _DIAGNOSTIC_COMPONENTS:
            return False
        if event['event_type'] not in _DIAGNOSTIC_EVENT_TYPES:
            return False
        if event['status'] not in _DIAGNOSTIC_STATUSES:
            return False
        duration = event['duration_ms']
        if duration is not None and (
            isinstance(duration, bool) or not isinstance(duration, (int, float))
            or not math.isfinite(duration) or not 0 <= duration <= 86_400_000
        ):
            return False
        if event['error_code'] is not None and event['error_code'] not in _DIAGNOSTIC_ERROR_CODES and not (
                isinstance(event['error_code'], str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', event['error_code'])):
            return False
        if event['action'] is not None and (not isinstance(event['action'], str)
                                            or not re.fullmatch(r'[a-z][a-z0-9_.]{0,40}', event['action'])):
            return False
    if type(value['has_more']) is not bool:
        return False
    next_cursor = value['next_cursor']
    if value['has_more']:
        return type(next_cursor) is int and next_cursor == cursor + len(events)
    return next_cursor is None


def _shared_diagnostics_call(fn, *, limit, cursor):
    try:
        result = fn()
        if not _valid_diagnostics_projection(result, limit=limit, cursor=cursor):
            raise ValueError('invalid diagnostics projection')
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            503,
            '诊断日志暂不可用或未提供；请确认桥接服务已接入诊断查询。',
        ) from exc


async def _shared_http_guard(request: Request):
    values = {}
    for key, value in request.query_params.multi_items():
        if key != 'profile' or key in values:
            raise HTTPException(422, '共享浏览器接口不接受查询身份或会话参数')
        values[key] = value
    _validate_shared_profile_selector(
        values.get('profile'), detail='共享浏览器接口不接受查询身份或会话参数')
    if request.method == 'POST' and request.url.path.endswith(('/cancel', '/resume', '/close', '/access-request', '/primary')):
        raw = await request.body()
        if raw.strip() not in (b'', b'{}'):
            raise HTTPException(422, '任务控制和授权请求不接受身份或授权参数')


async def _artifact_origin_query(request: Request) -> str:
    values = {}
    for key, value in request.query_params.multi_items():
        if key not in {'origin', 'profile'} or key in values:
            raise HTTPException(422, '文件来源参数无效')
        values[key] = value
    _validate_shared_profile_selector(values.get('profile'), detail='文件来源参数无效')
    origin = values.get('origin')
    if not isinstance(origin, str) or not 1 <= len(origin) <= 2048:
        raise HTTPException(422, '必须选择文件允许使用的网站来源')
    return origin


class SharedCreateBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=200)
    instanceId: str = Field(min_length=1, max_length=256)
    allowedOrigins: list[str] = Field(min_length=1, max_length=64)


# 中文注释：镜像路由采用闭合字段和类型白名单，异常响应也不回显请求体或扩展文本。
_COOKIE_COUNTS = ('count', 'success', 'failed', 'matched', 'missing', 'cleared', 'clearFailed')
_COOKIE_REASONS = {'expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'}
_COOKIE_STATES = {'preparing', 'approval_required', 'executing', 'completed', 'denied', 'failed'}


def _cookie_sites_view(value):
    if not isinstance(value, list) or len(value) > 4096:
        raise ValueError('invalid cookie sites')
    rows = []
    for item in value:
        if (not isinstance(item, dict) or not isinstance(item.get('site'), str)
                or len(item['site']) > 253
                or not re.fullmatch(r'(?:[a-z0-9-]+\.)*[a-z0-9-]+|\[[0-9a-f:]{2,45}\]', item['site'])):
            raise ValueError('invalid cookie site')
        row = {'site': item['site']}
        for key in _COOKIE_COUNTS:
            if key in item:
                if type(item[key]) is not int or not 0 <= item[key] <= 1000000:
                    raise ValueError('invalid cookie count')
                row[key] = item[key]
        for key in ('httpOnly', 'session'):
            if key in item:
                if type(item[key]) is not bool:
                    raise ValueError('invalid cookie flag')
                row[key] = item[key]
        if isinstance(item.get('reasons'), dict):
            row['reasons'] = {key: n for key, n in item['reasons'].items()
                              if key in _COOKIE_REASONS and type(n) is int and 0 <= n <= 1000000}
        rows.append(row)
    return rows


def _cookie_mirror_view(value):
    if not isinstance(value, dict) or value.get('status') not in _COOKIE_STATES:
        raise ValueError('invalid cookie state')
    result = {'status': value['status'], 'sites': _cookie_sites_view(value.get('sites'))}
    for key in ('transferId', 'source', 'target'):
        if not isinstance(value.get(key), str) or not re.fullmatch(r'[a-f0-9-]{32,36}', value[key]):
            raise ValueError('invalid cookie identity')
        result[key] = value[key]
    expires = value.get('expiresAt')
    if type(expires) not in (int, float) or not math.isfinite(expires) or not 0 < expires < 1e12:
        raise ValueError('invalid cookie deadline')
    result['expiresAt'] = expires
    if value['status'] == 'completed' and any(key not in value for key in ('success', 'failed', 'matched', 'missing')):
        raise ValueError('invalid cookie result')
    for key in _COOKIE_COUNTS:
        if key in value:
            if type(value[key]) is not int or not 0 <= value[key] <= 1000000:
                raise ValueError('invalid cookie count')
            result[key] = value[key]
    if value.get('reason') in {'transfer_failed', 'expired', 'disconnected'}:
        result['reason'] = value['reason']
    return result


async def _cookie_mirror_body(request: Request):
    try:
        raw = await request.body()
        if len(raw) > 128 * 1024:
            raise ValueError('invalid cookie selection')
        body = await request.json()
        if not isinstance(body, dict) or set(body) - {'source', 'target', 'sites', 'options'}:
            raise ValueError('invalid cookie selection')
        _native_tools()._validate('browser_shared_cookie_mirror', {'action': 'request_mirror', **body})
        if body['source'] == body['target']:
            raise ValueError('invalid cookie target')
        # 中文注释：沿用站点白名单，重复站点在进入守护进程前拒绝。
        _cookie_sites_view([{'site': site} for site in body['sites']])
        if len(set(body['sites'])) != len(body['sites']):
            raise ValueError('invalid cookie selection')
        return body
    except Exception:
        raise HTTPException(422, 'Cookie 镜像参数无效；请选择不同的已连接浏览器和有效站点。') from None


@router.get('/shared/browsers/{instance_id}/cookie-sites', dependencies=[Depends(_shared_http_guard)])
def shared_cookie_sites(instance_id: str):
    if not instance_id or len(instance_id) > 256:
        raise HTTPException(422, '浏览器实例无效')
    def run():
        runtime = _native_profile_runtime()
        value = runtime.call('browser.cookie_mirror', {
            'action': 'list_sites', 'source': instance_id, 'owner': runtime.authority.ui_owner()})
        rows = _cookie_sites_view(value.get('sites') if isinstance(value, dict) else None)
        if any('count' not in row for row in rows):
            raise ValueError('invalid cookie inventory')
        # 中文注释：列表端点只返回站点、数量及两项标记，不透传状态或扩展对象。
        return {'sites': [{key: row[key] for key in ('site', 'count', 'httpOnly', 'session') if key in row} for row in rows]}
    return _shared_call(run)


@router.post('/shared/cookie-mirror', dependencies=[Depends(_shared_http_guard)])
def shared_cookie_mirror(body: dict = Depends(_cookie_mirror_body)):
    def run():
        runtime = _native_profile_runtime()
        return _cookie_mirror_view(runtime.call('browser.cookie_mirror', {
            'action': 'request_mirror', **body, 'owner': runtime.authority.ui_owner()}))
    return _shared_call(run)


@router.get('/shared/cookie-mirror/{transfer_id}', dependencies=[Depends(_shared_http_guard)])
def shared_cookie_mirror_status(transfer_id: str):
    if not re.fullmatch(r'[a-f0-9]{32}', transfer_id):
        raise HTTPException(422, 'Cookie 镜像编号无效')
    def run():
        runtime = _native_profile_runtime()
        # 中文注释：桌面身份只读取自身请求；不枚举模型 owner，也不保留到期状态或 Cookie。
        return _cookie_mirror_view(runtime.call('browser.cookie_mirror', {
            'action': 'status', 'transferId': transfer_id, 'owner': runtime.authority.ui_owner()}))
    return _shared_call(run)


@router.get('/shared/browsers', dependencies=[Depends(_shared_http_guard)])
def shared_browsers():
    return _shared_call(lambda: _browser_rows(_native_profile_runtime().call('browser.list', {})))


@router.post('/shared/browsers/{instance_id}/primary', dependencies=[Depends(_shared_http_guard)])
def shared_browser_primary(instance_id: str):
    # 中文注释：仅桌面插件的受保护 HTTP 路由能写入主要链接；模型工具不注册此操作。
    if not instance_id or len(instance_id) > 256:
        raise HTTPException(422, '浏览器实例无效')
    return _shared_call(lambda: _native_profile_runtime().call('ui.set_primary', {'instanceId': instance_id}))


@router.post('/shared/browsers/{instance_id}/access-request', dependencies=[Depends(_shared_http_guard)])
def shared_browser_access_request(instance_id: str):
    if not instance_id or len(instance_id) > 256:
        raise HTTPException(422, '浏览器实例无效')

    def request_access():
        runtime = _native_profile_runtime()
        result = runtime.call('browser.access_request', {'instanceId': instance_id})
        return _access_request_result(result)

    return _shared_call(request_access)


@router.post('/shared/tasks', status_code=201, dependencies=[Depends(_shared_http_guard)])
def shared_create(body: SharedCreateBody):
    try:
        _native_tools()._validate('browser_shared_create', {
            'title': body.title, 'instance_id': body.instanceId, 'allowed_origins': body.allowedOrigins})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    def run():
        runtime = _native_profile_runtime()
        browsers = runtime.call('browser.list', {})
        if not any(b.get('instanceId') == body.instanceId and b.get('connected') is True for b in browsers):
            raise HTTPException(422, '请选择已连接的浏览器实例；不会自动切换浏览器')
        return runtime.call('shared.create', dict(body.model_dump(), owner=runtime.authority.ui_owner()))
    return _shared_call(run)


@router.get('/shared/tasks', dependencies=[Depends(_shared_http_guard)])
def shared_list():
    return _shared_call(lambda: [task for _, task in _shared_entries(_native_profile_runtime())])


@router.get('/shared/tasks/{task_id}', dependencies=[Depends(_shared_http_guard)])
def shared_get(task_id: str):
    def run():
        runtime = _native_profile_runtime()
        return runtime.call('shared.get', _shared_target(runtime, task_id))
    return _shared_call(run)


@router.post('/shared/tasks/{task_id}/artifacts')
async def shared_artifact_register(task_id: str, file: UploadFile = File(...),
                                   origin: str = Depends(_artifact_origin_query)):
    # 中文注释：浏览器原生文件选择由 Desktop 发起，HTTP 不接受模型指定的本地路径。
    try:
        runtime = _native_profile_runtime()
        target = _shared_target(runtime, task_id)
        task = runtime.call('shared.get', target)
        # 中文注释：登记文件不是页面派发；实际选择文件由任务模式决定是否逐项审批。
        return await _artifact_store(runtime.hermes_home).register(
            task=task, owner=target['owner'], origin=origin, file=file)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, '文件无法用于当前任务或来源') from exc
    except Exception as exc:
        raise HTTPException(503, '文件登记暂不可用') from exc
    finally:
        await file.close()


@router.get('/shared/tasks/{task_id}/artifacts', dependencies=[Depends(_shared_http_guard)])
def shared_artifacts(task_id: str):
    def run():
        runtime = _native_profile_runtime()
        target = _shared_target(runtime, task_id)
        task = runtime.call('shared.get', target)
        return _artifact_store(runtime.hermes_home).list(task=task, owner=target['owner'])
    return _shared_call(run)


def _shared_control(task_id, action):
    def run():
        runtime = _native_profile_runtime()
        return runtime.call('shared.' + action, _shared_target(runtime, task_id))
    return _shared_call(run)


@router.get('/shared/tasks/{task_id}/cleanup-status', dependencies=[Depends(_shared_http_guard)])
def shared_cleanup_status(task_id: str):
    # Reconcile browser ownership read-only; never retry deletion on a GET.
    return _shared_control(task_id, 'cleanup_status')


@router.get('/shared/tasks/{task_id}/diagnostics')
def shared_task_diagnostics(task_id: str, query: dict = Depends(_diagnostics_query)):
    """Read one task's redacted diagnostic projection without mutating state."""
    def run():
        runtime = _native_profile_runtime()
        target = _shared_target(runtime, task_id)
        params = {
            **target,
            'limit': query['limit'],
            'cursor': query['cursor'],
        }
        if query['requestIdHash'] is not None:
            params['requestIdHash'] = query['requestIdHash']
        return runtime.call('shared.diagnostics', params)

    return _shared_diagnostics_call(run, limit=query['limit'], cursor=query['cursor'])


@router.post('/shared/tasks/{task_id}/cancel', dependencies=[Depends(_shared_http_guard)])
def shared_cancel(task_id: str):
    return _shared_control(task_id, 'cancel')


@router.post('/shared/tasks/{task_id}/resume', dependencies=[Depends(_shared_http_guard)])
def shared_resume(task_id: str):
    return _shared_control(task_id, 'resume')


@router.post('/shared/tasks/{task_id}/close', dependencies=[Depends(_shared_http_guard)])
def shared_close(task_id: str):
    return _shared_control(task_id, 'close')
