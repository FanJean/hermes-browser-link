"""browser_shared_open: start browser work in one call.

Picks the connected browser (or the one the model names), reuses the session's
ready task when it already covers the site, otherwise creates a task for that
site, waits briefly for the extension to authorize it, binds the session and
opens a work tab. It adds no authority of its own: every step goes through the
same daemon calls and approval rules as the individual browser_shared_* tools.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

TOOL_NAME = 'browser_shared_open'
READY_WAIT_S = 15.0
POLL_S = 0.5

SCHEMA = {
    'description': (
        '一步开始浏览器工作：按显式 instance_id、主要链接、环境默认值或唯一实例选择浏览器，为该网址的网站建立或复用本会话任务，'
        '等待授权、绑定会话并打开工作标签页。同源默认复用当前工作页；new_task=true 才新建任务。'
        '回执默认含可直接用于 ref 动作的摘要，read_intent=content 读正文，interactive 读控件；loading 时 summary_missing.reason=page_loading，按 read_hint 在原页有界等待后读取。多步页面操作用一次 browser_shared_script，'
        '单步用 browser_shared_run；同一页不要混用 browser_exec。'),
    'parameters': {
        'type': 'object',
        'properties': {
            'url': {'type': 'string', 'minLength': 1, 'maxLength': 4096},
            'title': {'type': 'string', 'minLength': 1, 'maxLength': 256},
            'instance_id': {'type': 'string', 'minLength': 1, 'maxLength': 256},
            'new_task': {'type': 'boolean', 'description': '明确要求为同网站新建任务。'},
            'summary': {'type': 'boolean', 'description': '默认附带精简摘要；已有读取计划时 false 可关闭。'},
            'read_intent': {'type': 'string', 'enum': ['content', 'interactive'], 'description': '正文阅读用 content，操作控件用 interactive（默认）；单次采集，保留 binding/coverage。'},
            'root': {'type': 'string', 'minLength': 1, 'maxLength': 512, 'description': '摘要的目标 CSS 区域。'},
        },
        'required': ['url'],
        'additionalProperties': False,
    },
}


def _json(value):
    return json.dumps(value, ensure_ascii=False)


def _error(message, code, **extra):
    return _json({'error': message, 'code': code, 'retryable': False, 'outcome_unknown': False, **extra})


def _origin(url):
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username or parts.password:
        return None
    return f'{parts.scheme}://{parts.netloc.lower()}'


def _summary(runtime, owner, task_id, tab_id, request_id, url, *, read_intent='interactive', root=None):
    # 中文注释：一次采集目标区域； binding 和 snapshotId 原样保留，正文和控件不重复读取。
    options = {'mode': read_intent, 'budget': 1400}
    if root is not None:
        options['root'] = root
    page = runtime.call('shared.run', {'owner': owner, 'taskId': task_id, 'tabId': tab_id,
                        'requestId': request_id + '-summary', 'action': 'semantic_snapshot', 'options': options})
    if not isinstance(page, dict) or not isinstance(page.get('snapshotId'), str):
        return None
    result = {key: page.get(key) for key in ('binding', 'snapshotId', 'coverage', 'nextCursor')}
    result.update({'url': url[:300], 'title': str(page.get('title', ''))[:160], 'headings': [], 'items': [], 'read_intent': read_intent})
    categories = set()
    for row in page.get('items', []):
        item = {key: row[key] for key in ('ref', 'role', 'name', 'disabled', 'checked', 'cells') if key in row}
        if len(result['items']) >= 20 or len(_json({**result, 'items': [*result['items'], item]})) > 1200:
            categories.add('summary_items')
            break
        result['items'].append(item)
    if page.get('nextCursor') or page.get('coverage', {}).get('complete') is False:
        categories.add('snapshot_coverage')
    if len(url) > 300:
        categories.add('summary_url')
    if categories:
        result.update({'truncated': True, 'truncation': sorted(categories),
                       'read_hint': '用 read_page(query/root/mode) 缩小范围；按 coverage 和 nextCursor 续读，摘要不代表完整正文。'})
    return result


def _default_browser(runtime):
    # 中文注释：非默认 profile 沿用运行时已解析的共享 daemon 根目录；只读取指定键。
    explicit = os.environ.get('HERMES_BROWSER_DEFAULT', '').strip()
    if explicit:
        return explicit
    home = getattr(runtime, 'bridge_home', None)
    if home is None:
        return None
    try:
        for line in (Path(home) / '.env').read_text(encoding='utf-8').splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and key.strip() == 'HERMES_BROWSER_DEFAULT':
                return value.strip().strip('"\'') or None
    except (OSError, UnicodeError):
        return None
    return None


def _pick_browser(rows, instance_id, default_browser=None):
    connected = [row for row in rows if isinstance(row, dict) and row.get('connected') is True]
    if instance_id:
        match = [row for row in connected if row.get('instanceId') == instance_id]
        return (match[0], None) if match else (None, 'instance_unavailable')
    enabled = [row for row in connected if row.get('consentStatus') == 'enabled']
    # 中文注释：兼容旧状态回执，仅优先已连接的主要链接；实际任务权限仍由宿主核实。
    primary = [row for row in connected if row.get('primary') is True
               and row.get('consentStatus') in {'enabled', 'disabled'}]
    if len(primary) == 1:
        return primary[0], None
    if default_browser:
        matches = [row for row in enabled if row.get('instanceId') == default_browser
                   or row.get('browser') == default_browser.lower()]
        if len(matches) == 1:
            return matches[0], None
    if len(enabled) == 1:
        return enabled[0], None
    if not enabled and len(connected) == 1:
        return connected[0], None
    return None, ('no_browser' if not connected else 'browser_choice_required')


def make_handler(runtime, host_bridge, *, lease_error, clock=time.monotonic, sleep=time.sleep):
    def handler(args, *, session_id=None, **_):
        try:
            lease = runtime.authority.consume(TOOL_NAME, args, session_id=session_id)
        except lease_error:
            return _error('缺少可信会话身份，已拒绝。', 'session_identity_required')
        # 中文注释：schema 新字段也在宿主校验，错误仅返回字段名。
        if 'url' not in args:
            return _error('缺少必填字段。', 'missing_fields', fields=['url'])
        invalid = []
        for key, spec in SCHEMA['parameters']['properties'].items():
            if key not in args:
                continue
            value = args[key]
            if spec['type'] == 'boolean':
                valid = type(value) is bool
            else:
                valid = isinstance(value, str) and spec.get('minLength', 0) <= len(value) <= spec.get('maxLength', 4096) and ('enum' not in spec or value in spec['enum'])
            if not valid:
                invalid.append(key)
        if invalid:
            return _error('参数不符合契约。', 'invalid_fields', fields=sorted(invalid))
        url = args.get('url')
        origin = _origin(url) if isinstance(url, str) else None
        if origin is None:
            return _error('仅支持 http/https 网址，且不能包含账号密码。', 'invalid_url')
        owner = lease.owner
        try:
            rows = runtime.call('browser.list', {})
            available_rows = rows if isinstance(rows, list) else []
            browser, problem = _pick_browser(available_rows, args.get('instance_id'),
                                             _default_browser(runtime))
            primary_unavailable = not args.get('instance_id') and any(
                row.get('primary') is True and (row.get('connected') is not True
                                                or row.get('consentStatus') not in {'enabled', 'disabled'})
                for row in available_rows if isinstance(row, dict))
            primary_note = {'primaryUnavailable': True} if primary_unavailable else {}
            if browser is None:
                messages = {
                    'no_browser': '没有已连接的浏览器；请用户在浏览器中启用 Hermes 扩展并连接。',
                    'instance_unavailable': '指定的浏览器未连接。',
                    'browser_choice_required': '有多台浏览器可用；请用 instance_id 指定其中一台。',
                }
                choices = [{'instance_id': row.get('instanceId'), 'browser': row.get('browser'),
                            'consent': row.get('consentStatus')} for row in available_rows if isinstance(row, dict)]
                return _error(messages[problem], problem, browsers=choices, **primary_note)
            instance_id = browser['instanceId']

            # Reuse the session's bound task when it is ready for this site.
            bound = host_bridge._bindings.get(session_id) if session_id else None
            task = None
            created_task = False
            if bound and bound[0] == owner and args.get('new_task') is not True:
                current = runtime.call('shared.get', {'owner': owner, 'taskId': bound[1]})
                if (isinstance(current, dict) and current.get('state') in {'ready', 'paused'}
                        and current.get('instanceId') == instance_id and origin in (current.get('allowedOrigins') or [])):
                    task = current
            if task is None and args.get('new_task') is not True:
                # 等待授权的任务尚未绑定会话；重试时从当前 owner 的任务中复用它。
                existing = runtime.call('shared.list', {'owner': owner})
                matches = [row for row in existing if isinstance(row, dict)
                           and row.get('state') in {'ready', 'paused', 'pending_approval', 'authorizing'}
                           and row.get('instanceId') == instance_id
                           and origin in (row.get('allowedOrigins') or [])]
                if matches:
                    task = max(matches, key=lambda row: (row['state'] == 'ready', row.get('createdAt', 0)))
            if task is None:
                created = runtime.call('shared.create', {
                    'owner': owner, 'title': args.get('title') or f'浏览 {origin}',
                    'instanceId': instance_id, 'allowedOrigins': [origin]})
                task = created
                created_task = True
            deadline = clock() + READY_WAIT_S
            while task.get('state') in {'pending_approval', 'authorizing'} and clock() < deadline:
                sleep(POLL_S)
                task = runtime.call('shared.get', {'owner': owner, 'taskId': task['id']})
            # 中文注释：接管期间保留同一任务，避免为同一网站另建任务或提前打开工作页。
            if task.get('state') == 'paused':
                return _json({'status': 'task_paused', 'task_id': task['id'], 'state': 'paused',
                              'message': '用户正在接管浏览器页面；退出接管后继续同一任务。', **primary_note})
            if task.get('state') in {'pending_approval', 'authorizing'}:
                return _json({'status': 'awaiting_authorization', 'task_id': task['id'], 'state': task.get('state'),
                              'message': '已为该网站建立任务，正在等待用户在浏览器扩展中批准；'
                                         '批准后调用 browser_shared_get 确认就绪，再调用本工具打开页面。', **primary_note})
            # 中文注释：只把仍待批准的任务报告为等待；终态或断线必须让 agent 重新核实。
            if task.get('state') != 'ready':
                return _error('任务已停止、被拒绝或失去连接；请核实浏览器访问状态后创建新任务。',
                              'task_not_ready', task_id=task['id'], state=task.get('state'), **primary_note)
            host_bridge.bind(session_id, owner=owner, task_id=task['id'])

            opened = None
            reused = False
            if not created_task:
                # 中文注释：只选择本任务工作页；当前绑定页优先，旧页仍须经守护进程导航校验。
                owned = {row.get('tabId') for row in task.get('workTabs', []) if isinstance(row, dict)}
                if owned:
                    tabs = runtime.call('shared.run', {'owner': owner, 'taskId': task['id'],
                                                       'requestId': lease.tool_call_id + '-tabs', 'action': 'tabs'})
                    matches = [row for row in tabs if isinstance(row, dict) and row.get('id') in owned
                               and row.get('url') == url and row.get('outOfScope') is not True]
                    if len(matches) > 1:
                        return _error('同一任务有多个同网址工作页；请核对 tab_id 后继续。',
                                      'work_tab_choice_required', task_id=task['id'],
                                      tab_ids=[row['id'] for row in matches])
                    if matches:
                        opened = {'tabId': matches[0]['id'], 'url': url}
                        reused = True
                    else:
                        candidates = [row for row in tabs if isinstance(row, dict) and row.get('id') in owned
                                      and row.get('outOfScope') is not True]
                        preferred = bound[3].tab_id if bound and bound[1] == task['id'] and len(bound) > 3 else None
                        selected = next((row for row in candidates if row['id'] == preferred), None)
                        if selected is None and candidates:
                            selected = candidates[-1]
                        if selected is not None:
                            opened = runtime.call('shared.run', {'owner': owner, 'taskId': task['id'],
                                       'requestId': lease.tool_call_id, 'action': 'navigate',
                                       'tabId': selected['id'], 'url': url})
                            reused = True
            if opened is None:
                params = {'owner': owner, 'taskId': task['id'], 'requestId': lease.tool_call_id,
                          'action': 'new_tab', 'url': url}
                opened = runtime.call('shared.run', params)
        except Exception as exc:
            code = str(getattr(exc, 'code', '') or 'bridge_error')
            data = getattr(exc, 'data', {})
            unknown = data.get('outcomeUnknown') if isinstance(data, dict) else None
            if code == 'redirected_out_of_scope':
                return _error('页面跳转到任务范围外；请用返回的来源新开任务。', code,
                              final_origin=data.get('finalOrigin') if isinstance(data, dict) else None)
            return _error('打开浏览器工作页失败；请用返回的 task_id 检查任务状态。确认未执行后可重试。', code,
                          **({'task_id': task['id']} if isinstance(task, dict) and isinstance(task.get('id'), str) else {}),
                          outcome_unknown=unknown if type(unknown) is bool else code not in {'origin_denied', 'invalid_url', 'forbidden', 'invalid_state', 'task_paused'})
        if isinstance(opened, dict) and opened.get('status') == 'approval_required':
            return _json({'status': 'approval_required', 'task_id': task['id'], 'request_id': lease.tool_call_id,
                          'message': '打开页面需要用户在浏览器中确认。确认后用 browser_shared_run 查询：'
                                     'action=new_tab、相同 url 与 request_id；不会重复打开。'})
        if not isinstance(opened, dict) or type(opened.get('tabId')) is not int:
            return _error('打开结果无法确认；请用 browser_shared_get 检查，不要重复打开。', 'outcome_unknown',
                          outcome_unknown=True)
        try:
            host_bridge.bind(session_id, owner=owner, task_id=task['id'], tab_id=opened['tabId'])
        except Exception:
            return _error('工作页已打开，但当前页绑定失败；请检查任务后显式选页，不要重复打开。', 'binding_unavailable',
                          task_id=task['id'], tab_id=opened['tabId'], opened=True)
        result = {'current_tab': opened['tabId'], 'task_id': task['id'], 'tab_id': opened['tabId'],
                  'url': opened.get('url', url), 'origin': origin, 'reused': reused,
                  'ready': opened.get('ready'), 'browser': browser.get('browser'),
                  'instance_id': instance_id, 'sessionBinding': 'ready'}
        # 中文注释：会话拥有的任务工作页一起计数；复用既有页面不会增加计数。
        result['open_tabs'] = opened.get('open_tabs', task.get('open_tabs', 0))
        if result['open_tabs'] > 6:
            result['tab_hint'] = '不再用的网站先 browser_shared_close'
        result.update(primary_note)
        if args.get('summary') is not False:
            reason = None
            result['summary'] = None
            if result['ready'] == 'loading':
                reason = 'page_loading'
            else:
                try:
                    result['summary'] = _summary(runtime, owner, task['id'], opened['tabId'],
                        lease.tool_call_id, result['url'], read_intent=args.get('read_intent', 'interactive'), root=args.get('root'))
                    if result['summary'] is None:
                        reason = 'summary_return_type'
                except Exception as exc:
                    # 中文注释：只返回已知阶段码，不回传网页异常文本，不改变已确认的开页结果。
                    code = getattr(exc, 'code', None)
                    reason = code if code in {'document_changed', 'page_not_ready', 'overlay_injection_failed', 'overlay_frame_changed', 'permission_denied', 'task_paused', 'approval_required'} else 'summary_read_failed'
            if reason:
                result['summary_missing'] = {'reason': reason}
                result['read_hint'] = '在原 tab 用 wait_for(selector, timeout<=60) 检查 satisfied，或 wait_for_load() 后 read_page(root/query, mode)；正文用 content，控件用 interactive。不要重复 open。'
        return _json(result)
    return handler


def register(ctx, runtime, host_bridge, *, lease_error):
    runtime.authority.lease_tools((TOOL_NAME, 'browser_shared_use_tab'))
    ctx.register_tool(name='browser_shared_use_tab', toolset='browser-link', schema=USE_TAB_SCHEMA,
                      handler=make_use_tab_handler(runtime, host_bridge, lease_error=lease_error),
                      description=USE_TAB_SCHEMA['description'], emoji='🌐')
    ctx.register_tool(name=TOOL_NAME, toolset='browser-link', schema=SCHEMA,
                      handler=make_handler(runtime, host_bridge, lease_error=lease_error),
                      description=SCHEMA['description'], emoji='🌐')


# 中文注释：显式选页只接受已绑定任务的工作页，身份仍由一次性 owner lease 注入。
USE_TAB_SCHEMA = {'description': '将本会话官方 browser_* 工具的当前页切换为已绑定任务的工作页。',
    'parameters': {'type': 'object', 'properties': {'tab_id': {'type': 'integer', 'minimum': 0}},
                   'required': ['tab_id'], 'additionalProperties': False}}


def make_use_tab_handler(runtime, host_bridge, *, lease_error):
    def handler(args, *, session_id=None, **_):
        try:
            lease = runtime.authority.consume('browser_shared_use_tab', args, session_id=session_id)
        except lease_error:
            return _error('缺少可信会话身份。', 'session_identity_required')
        tab_id = args.get('tab_id')
        if type(tab_id) is not int or tab_id < 0:
            return _error('工作页编号无效。', 'invalid_arguments')
        try:
            receipt = host_bridge.use_tab(session_id, owner=lease.owner, tab_id=tab_id)
            return _json({'success': True, 'current_tab': tab_id, 'binding': receipt})
        except Exception:
            return _error('只能选择本会话已绑定任务的工作页。', 'foreign_tab')
    return handler
