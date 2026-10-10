"""Entry point of one browser_shared_script run, executed in a fresh interpreter.

The host passes one inherited socket (HERMES_BROWSER_FD) and the script on
stdin. The script sees only the helpers below; each helper is one JSON line to
the trusted host, which applies task, origin and approval checks. Nothing here
holds browser credentials or can pick another task or tab.
"""
import json
import contextvars
import functools
import threading
import itertools
from concurrent.futures import Future, ThreadPoolExecutor
import math
import difflib
import re
import os
import socket
import sys
import time
from pathlib import Path


class BrowserError(RuntimeError):
    """A browser action failed. ``outcome_unknown`` means do not replay it."""

    def __init__(self, message, code=None, outcome_unknown=True, final_origin=None, candidates=None, obstruction=None, current_origin=None, stage=None, reason_code=None, effect=None, suggestion=None):
        super().__init__(message)
        self.code = code
        self.outcome_unknown = outcome_unknown
        self.final_origin = final_origin
        # 中文注释：脚本可按固定字段读取拒绝摘要，不解析异常原文。
        self.candidates = candidates
        self.obstruction = obstruction
        self.current_origin, self.stage, self.reason_code = current_origin, stage, reason_code
        # 中文注释：无效果错误向脚本公开固定字段。
        self.effect, self.suggestion = effect, suggestion

    def __str__(self):
        # 中文注释：异常首行保留可信错误码，便于从脚本回溯区分拒绝与未知结果。
        message = super().__str__()
        if self.code == 'redirected_out_of_scope' and self.final_origin:
            message += f' 请用 {self.final_origin} 新开任务。'
        if self.code in {'origin_denied', 'tab_out_of_scope'}:
            message += f' 当前来源：{self.current_origin or "unavailable"}；同站用 goto_url，新站用 browser_shared_open。'
        return f'BrowserError[{self.code}]: {message}' if self.code else message


class ApprovalRequired(BrowserError):
    """The user must confirm this action in the browser extension first."""


class UserInputRequired(ApprovalRequired):
    """A password, payment or one-time-code field: the user fills it in the page
    (they are prompted in the browser). Call wait_pending() to wait for them."""


_channel = None
_connect_lock = threading.Lock()
_write_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending_calls = {}
_transport_closed = False
_call_ids = itertools.count(1)
_tab_scope = contextvars.ContextVar('browser_tab', default=None)


# 中文注释：显式 tab 参数沿复合 helper 传递，只影响本次调用和当前线程。
def _tab_scoped(fn):
    @functools.wraps(fn)
    def scoped(*args, **kwargs):
        tab = kwargs.get('tab')
        token = _tab_scope.set(tab) if tab is not None else None
        try:
            return fn(*args, **kwargs)
        finally:
            if token is not None:
                _tab_scope.reset(token)
    return scoped


def _read_replies(channel):
    global _transport_closed
    # 中文注释：回执按本地流水号分发；断线使所有在途请求变成未知，绝不重发。
    try:
        while line := channel.readline():
            reply = json.loads(line)
            with _pending_lock:
                future = _pending_calls.pop(reply.get('id'), None)
            if future is None:
                raise BrowserError('unexpected browser reply', code='invalid_receipt')
            future.set_result(reply)
    finally:
        with _pending_lock:
            _transport_closed = True
            pending = list(_pending_calls.values())
            _pending_calls.clear()
        for future in pending:
            future.set_exception(BrowserError('browser connection closed; do not replay uncertain work', code='extension_disconnected'))


def _connect():
    global _channel
    with _connect_lock:
        if _channel is None:
            fd = int(os.environ.pop('HERMES_BROWSER_FD'))
            sock = socket.socket(fileno=fd)
            _channel = sock.makefile('wb')
            reader = sock.makefile('rb')
            threading.Thread(target=_read_replies, args=(reader,), daemon=True).start()
        return _channel


def _call(op, args):
    channel = _connect()
    request_id = next(_call_ids)
    future = Future()
    with _pending_lock:
        if _transport_closed:
            raise BrowserError('browser transport closed; do not replay', code='extension_disconnected')
        _pending_calls[request_id] = future
    try:
        with _write_lock:
            channel.write((json.dumps({'id': request_id, 'op': op, 'args': args,
                **({'tab': _tab_scope.get()} if _tab_scope.get() is not None else {})}) + '\n').encode('utf-8'))
            channel.flush()
        reply = future.result()
    except (OSError, ValueError) as exc:
        with _pending_lock:
            _pending_calls.pop(request_id, None)
        raise BrowserError('browser transport failed; do not replay uncertain work', code='extension_disconnected') from exc
    if reply.get('ok') is True:
        return reply.get('value')
    code = reply.get('code')
    unknown = reply.get('outcomeUnknown', True) is not False
    kind = {'approval_required': ApprovalRequired, 'user_input_required': UserInputRequired}.get(code, BrowserError)
    raise kind(reply.get('error') or 'browser action failed', code=code, outcome_unknown=unknown,
               final_origin=reply.get('finalOrigin') if code == 'redirected_out_of_scope' else None,
               candidates=reply.get('candidates') if code in {'reference_target_missing', 'reference_target_ambiguous', 'element_timeout'} else None,
               obstruction=reply.get('obstruction') if code == 'target_occluded' else None,
               current_origin=reply.get('currentOrigin'), stage=reply.get('stage'), reason_code=reply.get('reasonCode'),
               effect=reply.get('effect'), suggestion=reply.get('suggestion'))


def parallel(fn, tabs):
    """Call fn(tab) concurrently, returning input order; aggregate failures without retries."""
    selected = list(tabs)
    if len(selected) > 32 or any(type(tab) is not int or tab < 0 for tab in selected):
        raise BrowserError('invalid parallel tabs', code='invalid_params', outcome_unknown=False)
    # 中文注释：每个分支固定工作页；异常全部收集后报告，不重试任何动作。
    def run(tab):
        token = _tab_scope.set(tab)
        try:
            return fn(tab)
        finally:
            _tab_scope.reset(token)
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(selected)))) as pool:
        futures = [pool.submit(run, tab) for tab in selected]
        results, errors = [], []
        for index, future in enumerate(futures):
            try:
                results.append(future.result())
            except Exception as exc:
                results.append(None)
                errors.append({'index': index, 'tab_id': selected[index], 'code': getattr(exc, 'code', type(exc).__name__),
                               'outcome_unknown': getattr(exc, 'outcome_unknown', True)})
    if errors:
        error = BrowserError('parallel browser actions failed; inspect errors and do not replay', code='parallel_action_failed', outcome_unknown=any(e['outcome_unknown'] for e in errors))
        error.errors, error.results = errors, results
        raise error
    return results


def new_tab(url):
    """Open a work tab on an approved origin; returns the numeric tab id."""
    return _call('new_tab', [url])


def use_tab(tab_id):
    """Select the current owned work tab; prefer explicit tab= for parallel work."""
    return _call('use_tab', [tab_id])


def current_tab():
    """Return the explicitly selected work-tab id without guessing the active tab."""
    return _call('current_tab', [])


@_tab_scoped
def goto_url(url, *, summary=True, tab=None):
    """Navigate the work tab to an approved origin."""
    return _call('goto_url', [url, summary])


_LOADING_CODES = frozenset({'document_changed', 'page_not_ready', 'stale_frame', 'overlay_frame_changed', 'target_unavailable'})


@_tab_scoped
def wait_for_load(timeout=15.0, *, until='interactive', tab=None):
    """Wait until document.readyState reaches ``until``; returns the final state.

    The default ``'interactive'`` returns once the DOM is parsed and readable;
    pass ``until='complete'`` only when images/ads/analytics must finish too.
    A slow page may replace its document while loading; those transient
    errors are polled through until the deadline instead of failing."""
    if until not in ('interactive', 'complete'):
        raise BrowserError('invalid wait_for_load state', code='invalid_params', outcome_unknown=False)
    accepted = ('interactive', 'complete') if until == 'interactive' else ('complete',)
    deadline = time.monotonic() + timeout
    while True:
        try:
            state = _call('run', ['official.ready_state', {}])
        except BrowserError as exc:
            if exc.code not in _LOADING_CODES or time.monotonic() >= deadline:
                raise
            state = {'readyState': 'loading'}
        else:
            if state.get('readyState') in accepted:
                return state['readyState']
        if time.monotonic() >= deadline:
            return state.get('readyState')
        time.sleep(0.25)


@_tab_scoped
def page_text(*, tab=None):
    """中文注释：返回 dict {url, title, elements, ...}；最小读法 print(page_text()['elements'][:5])，不能切片 dict。"""
    return _call('snapshot', [])


@_tab_scoped
def semantic_snapshot(tab=None, **options):
    """中文注释：返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}；读 result['items']，coverage.complete=false 时按 nextCursor 续读。"""
    return _call('run', ['semantic_snapshot', {'options': options} if options else {}])


@_tab_scoped
def parse_page(tab=None, **options):
    """中文注释：返回 dict {schemaVersion,parseId,binding,regions,blocks,tables,forms,collections,records,coverage,warnings,nextCursor}；只读取指定 sections/root，结果引用仅作为来源证据。"""
    return _call('run', ['page.parse', {'options': options}])


@_tab_scoped
def page_markdown(tab=None, **options):
    """中文注释：Markdown 是当前解析页的派生结果，同时保留分页与覆盖状态。"""
    page = parse_page(sections=['blocks'], **options)
    parts = []
    for block in page.get('blocks', []):
        text = block.get('text', '')
        if block.get('level'):
            text = '#' * block['level'] + ' ' + text
        elif block.get('kind') == 'li':
            text = '- ' + text
        elif block.get('kind') == 'blockquote':
            text = '> ' + text.replace('\n', '\n> ')
        elif block.get('kind') == 'pre':
            fence = '`' * (max([len(part) for part in __import__('re').findall(r'`+', text)] or [2]) + 1)
            text = fence + '\n' + text + '\n' + fence
        parts.append(text)
    return {'markdown': '\n\n'.join(parts), 'coverage': page['coverage'], 'nextCursor': page.get('nextCursor'), 'warnings': page.get('warnings', [])}


@_tab_scoped
def extract(schema, tab=None, **options):
    """中文注释：返回 parse_page 的 dict；读 result['records']，每项含 fields/states/sources/valid；核对 coverage/warnings/nextCursor，不能把 sourceRef 用于写动作。"""
    return parse_page(schema=schema, sections=[], **options)


def _js_error_text(detail):
    """中文注释：异常文本通常已带类型前缀，只在缺少时补上，截断到 200 字符。"""
    kind, text = str(detail.get('type') or 'Error'), str(detail.get('text') or '')
    return (text if text.startswith(kind) else f'{kind}: {text}')[:200]


@_tab_scoped
def evaluate(function, arguments=None, *, world='isolated', timeout_ms=10000, frame_token=None, tab=None):
    """中文注释：返回函数的 JSON 值；evaluate('(selector)=>document.querySelector(selector)?.textContent', '#result') 用 arguments 传数据。isolated 共享 DOM、不共享网站 JS 全局变量；main 仅确需网站变量时显式指定，禁止错误后自动切换。"""
    json.dumps(arguments, allow_nan=False)
    params = {'expression': function, 'arguments': arguments, 'world': world, 'timeoutMs': timeout_ms}
    if frame_token:
        params['frameToken'] = frame_token
    result = _call('run', ['js.evaluate', params])
    if isinstance(result, dict) and result.get('ok') is False:
        detail = result.get('exception') or {}
        raise BrowserError(_js_error_text(detail),
                           code=result.get('code', 'js_exception'), outcome_unknown=result.get('outcomeUnknown') is not False)
    return result.get('value', result) if isinstance(result, dict) else result


@_tab_scoped
def network_start(*, tab=None):
    """中文注释：开始主标签网络观察；返回 captureId，供后续调用防止串用游标。"""
    return _call('run', ['network.inspect', {'options': {'operation': 'start'}}])


@_tab_scoped
def network_list(capture_id, *, after_sequence=0, limit=20, filter='', tab=None):
    """中文注释：只读摘要不返回请求头；cursor 表示更新序号，seq 表示请求标识。"""
    return _call('run', ['network.inspect', {'options': {'operation': 'list', 'captureId': capture_id,
        'afterSequence': after_sequence, 'limit': limit, 'filter': filter}}])


@_tab_scoped
def network_detail(capture_id, seq, *, part='response', start=0, max_chars=8000, tab=None):
    """中文注释：按摘要序号读取脱敏 JSON；分页延续同一缓存正文，不重新发送请求。"""
    return _call('run', ['network.inspect', {'options': {'operation': 'detail', 'captureId': capture_id,
        'seq': seq, 'part': part, 'start': start, 'maxChars': max_chars}}])


@_tab_scoped
def network_stop(*, tab=None):
    """中文注释：清空本任务页捕获缓存，不关闭其他等待器使用的 Network 域。"""
    return _call('run', ['network.inspect', {'options': {'operation': 'stop'}}])


@_tab_scoped
def page_request(url, *, fields, method='GET', max_bytes=65536, timeout_ms=10000, tab=None):
    """中文注释：连接授权后直接执行同源 GET/HEAD 的有界 JSON 字段读取；不推断业务无副作用。"""
    import re
    if (not isinstance(url, str) or not 1 <= len(url) <= 4096 or method not in ('GET', 'HEAD')
            or type(max_bytes) is not int or not 1024 <= max_bytes <= 131072
            or type(timeout_ms) is not int or not 100 <= timeout_ms <= 20000
            or not isinstance(fields, list) or not 1 <= len(fields) <= 16
            or any(not isinstance(f, str) or not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*', f)
                   or len(f) > 128 or re.search('cookie|authorization|password|passwd|secret|token|csrf|session|credential|otp|api.?key', f, re.I) for f in fields)):
        raise BrowserError('invalid page request', code='invalid_params', outcome_unknown=False)
    source = Path(__file__).with_name('page-request.js').read_text()
    return evaluate(source, {'url': url, 'fields': fields, 'method': method, 'max_bytes': max_bytes,
        'timeout_ms': timeout_ms}, timeout_ms=timeout_ms + 1000)


@_tab_scoped
def wait_for(selector, *, state='present', text=None, count=None, timeout=10, interval=0.25, tab=None):
    """中文注释：声明式只读等待，不重试点击、填写或提交；返回 dict {satisfied, timed_out, last_observation, coverage, reason}；timeout 为 (0,60] 秒，state=present/absent/text/count/stable。satisfied=false 后改定位或停止，不重复等同一条件。"""
    invalid = []
    if not isinstance(state, str) or state not in {'present', 'absent', 'text', 'count', 'stable'}:
        invalid.append('state')
    if not isinstance(selector, str) or not 1 <= len(selector) <= 512:
        invalid.append('selector')
    if type(timeout) not in (int, float) or not 0 < timeout <= 60 or not math.isfinite(timeout):
        invalid.append('timeout')
    if type(interval) not in (int, float) or not 0.05 <= interval <= 2 or not math.isfinite(interval):
        invalid.append('interval')
    if state == 'text' and not isinstance(text, str):
        invalid.append('text')
    if state == 'count' and (type(count) is not int or count < 0):
        invalid.append('count')
    if invalid:
        # 中文注释：不回显值；超限明确报告原因和固定上限。
        reason = 'timeout_must_be_in_0_60_seconds' if 'timeout' in invalid else 'invalid_wait_condition'
        raise BrowserError(f"invalid_fields: {','.join(invalid)}; {reason}", code='invalid_fields', outcome_unknown=False)
    deadline = time.monotonic() + timeout
    last = None
    stable = 0
    def matches(observed, stable_count):
        return observed['complete'] and (state == 'present' and observed['count'] > 0
            or state == 'absent' and observed['count'] == 0
            or state == 'count' and observed['count'] == count
            or state == 'text' and any(text in (value or '') for value in observed['text'])
            or state == 'stable' and observed['count'] > 0 and stable_count >= 2)
    while True:
        try:
            observed = _call('run', ['page.observe', {'options': {'selector': selector}}])
        except BrowserError as exc:
            if exc.code != 'invalid_params':
                raise
            raise BrowserError('invalid_fields: selector; invalid_selector', code='invalid_fields', outcome_unknown=False) from None
        stable = stable + 1 if observed == last else 0
        satisfied = matches(observed, stable)
        if satisfied or time.monotonic() >= deadline:
            # 中文注释：命中或截止后仅做一次完整解析；页面变化或不完整时不报告满足，不继续重复等待。
            page = extract({'record': selector, 'fields': {'text': {'selector': ':scope', 'type': 'text'}}}, budget=12000)
            rows = page.get('records', [])
            final = {'count': len(rows), 'text': [row['fields'].get('text') for row in rows],
                     'complete': page.get('coverage', {}).get('complete') is True}
            same_document = page.get('binding') == observed.get('binding')
            stable_count = stable if final == {key: observed[key] for key in final} else 0
            satisfied = bool(same_document and matches(final, stable_count))
            return {'satisfied': satisfied, 'timed_out': not satisfied and time.monotonic() >= deadline,
                    'last_observation': final, 'coverage': page.get('coverage'),
                    'reason': None if satisfied else 'deadline_reached' if time.monotonic() >= deadline else 'condition_changed'}
        last = observed
        time.sleep(min(interval, max(0, deadline - time.monotonic())))



class _ExpectedEvent:
    """中文注释：监听先于单次动作建立，匹配失败不重放动作。"""
    def __init__(self, kind, url=None, timeout=15):
        if type(timeout) not in (int, float) or not 0 < timeout <= 60 or not math.isfinite(timeout):
            raise BrowserError('invalid event timeout', code='invalid_params', outcome_unknown=False)
        self.kind, self.url, self.timeout, self.result = kind, url, timeout, None
        self.tab = _tab_scope.get()

    def __enter__(self):
        cdp('Network.enable' if self.kind == 'response' else 'Page.enable', tab=self.tab)
        self.frame_id = cdp('Page.getFrameTree', tab=self.tab).get('frameTree', {}).get('frame', {}).get('id') if self.kind == 'navigation' else None
        old = cdp_events(max=500, tab=self.tab)
        if old.get('remaining'):
            raise BrowserError('event backlog; read events first', code='event_backlog', outcome_unknown=False)
        return self

    def __exit__(self, kind, value, traceback):
        if kind is not None:
            return False
        deadline = time.monotonic() + self.timeout
        while True:
            batch = cdp_events(max=500, tab=self.tab)
            if batch.get('dropped'):
                raise BrowserError('event buffer overflow; inspect outcome', code='event_overflow')
            matches = []
            for event in batch.get('events', []):
                params = event.get('params', {})
                if self.kind == 'response' and event.get('method') == 'Network.responseReceived':
                    response = params.get('response', {})
                    if self.url is None or response.get('url') == self.url:
                        matches.append({'request_id': params.get('requestId'), 'status': response.get('status'), 'correlation': 'filter_only'})
                if self.kind == 'navigation' and event.get('method') == 'Page.navigatedWithinDocument':
                    if params.get('frameId') == self.frame_id and (self.url is None or params.get('url') == self.url):
                        matches.append({'frame_id': self.frame_id, 'same_document': True, 'correlation': 'filter_only'})
                if self.kind == 'navigation' and event.get('method') == 'Page.frameNavigated':
                    frame = params.get('frame', {})
                    if not frame.get('parentId') and (self.url is None or frame.get('url') == self.url):
                        matches.append({'frame_id': frame.get('id'), 'loader_id': frame.get('loaderId'), 'correlation': 'filter_only'})
            if len(matches) > 1:
                raise BrowserError('multiple matching events; inspect outcome', code='ambiguous_event')
            if matches:
                self.result = matches[0]
                return False
            if time.monotonic() >= deadline:
                raise BrowserError('expected event not observed; do not repeat action', code='event_timeout')
            time.sleep(0.1)


@_tab_scoped
def expect_response(url=None, *, timeout=15, tab=None):
    return _ExpectedEvent('response', url, timeout)


@_tab_scoped
def expect_navigation(url=None, *, timeout=15, tab=None):
    return _ExpectedEvent('navigation', url, timeout)


@_tab_scoped
def frame_catalog(*, tab=None):
    """列出当前任务页的 frame 及可用的不透明引用。"""
    return _call('run', ['frame_catalog', {}])


@_tab_scoped
def popup_catalog(*, tab=None):
    """仅列出授权源页新建的独立登录弹窗元数据，不读取内容或接管。"""
    return _call('run', ['popup_catalog', {}])


@_tab_scoped
def popup_adopt(candidate_ref, *, tab=None):
    """请求精确接管需要人工确认的登录窗口。白名单自动接管时直接 use_tab(popupOpened["tabId"]) 并重读；其他窗口先在同一脚本调用 popup_catalog 保留 candidate；
    ApprovalRequired 后用 wait_pending(tab=source) 只读查询账本，不重发接管。
    等待返回 state=confirmed，不是 adopted 回执；显式 use_tab(candidate['tabId'])
    后重新 read_page 核实原窗口当前权限与内容，不另开登录网址。"""
    return _call('run', ['popup_adopt', {'candidateRef': candidate_ref}])


@_tab_scoped
def read_page(*, query='', root=None, mode='content', budget=3000, cursor=None, tab=None):
    """中文注释：返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}，与 semantic_snapshot 相同；print(read_page(root='#results')['items'][:5])。"""
    if mode not in ('content', 'table', 'interactive'):
        raise BrowserError('invalid page mode', code='invalid_params', outcome_unknown=False)
    options = {'mode': mode, 'query': query, 'budget': budget}
    if root is not None:
        options['root'] = root
    if cursor is not None:
        options['cursor'] = cursor
    return semantic_snapshot(**options)


@_tab_scoped
def _normalized_accessible_name(value):
    # 中文注释：只剥离首尾的状态标记，保留名称中间和词首的普通文字。
    value = re.sub(r'^\*\s*', '', ' '.join(value.split())).strip()
    while True:
        trimmed = re.sub(r'(?:\s*\*|\s*[（(]\s*(?:必填|required|optional|可选|选填)\s*[）)]|\s+(?:optional|required)|[:：])\s*$', '', value, flags=re.I).strip()
        if trimmed == value:
            return value.casefold()
        value = trimmed


def wait_for_element(name, *, role=None, root=None, exact=True, timeout=10.0, tab=None, action=None):
    """等待唯一且未禁用的元素，返回本次快照和引用；不自动点击。"""
    if (not isinstance(name, str) or not name.strip() or len(name) > 2000
            or type(exact) is not bool or (role is not None and
                (not isinstance(role, str) or not role or len(role) > 100))
            or (root is not None and (not isinstance(root, str) or not root))
            or isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 <= timeout <= 60):
        raise BrowserError('invalid element query', code='invalid_params', outcome_unknown=False)
    options = {'mode': 'interactive', 'query': name, 'budget': 3000}
    if role is not None:
        options['roles'] = [role]
    if root is not None:
        options['root'] = root
    deadline = time.monotonic() + timeout
    while True:
        # 中文注释：每次只轮询读取；审批、断线、失效引用均不在此处重试。
        page = semantic_snapshot(**options)
        if (not isinstance(page, dict) or page.get('kind') != 'full'
                or not isinstance(page.get('items'), list)
                or not isinstance(page.get('binding'), dict) or not page.get('snapshotId')):
            raise BrowserError('invalid semantic snapshot', code='invalid_receipt', outcome_unknown=False)
        # 中文注释：预算截断或未遍历完整时不能推断唯一目标，要求缩小区域。
        if page.get('coverage', {}).get('complete') is not True:
            raise BrowserError('narrow the root or query before selecting a target',
                               code='incomplete_target_scope', outcome_unknown=False)
        normalized = _normalized_accessible_name(name)
        candidates = [item for item in page['items'] if isinstance(item, dict)
                      and isinstance(item.get('name'), str) and (role is None or item.get('role') == role)]
        matches = [item for item in candidates if
                   isinstance(item, dict) and isinstance(item.get('name'), str)
                   and (_normalized_accessible_name(item['name']) == normalized if exact
                        else name.casefold() in item['name'].casefold())]
        # 中文注释：填写优先可编辑目标；点击忽略禁用目标，同名候选仍如实报告。
        rejected = matches
        if action == 'fill':
            matches = [item for item in matches if item.get('role') in {'textbox', 'searchbox', 'spinbutton', 'combobox'}
                       and not (item.get('disabled') or item.get('readonly') or item.get('busy'))
                       and ('actions' not in item or isinstance(item['actions'], list) and 'fill' in item['actions'])]
        elif action == 'click':
            matches = [item for item in matches if not (item.get('disabled') or item.get('busy'))
                       and ('actions' not in item or isinstance(item['actions'], list) and 'click' in item['actions'])]
        nearest = difflib.get_close_matches(normalized, [_normalized_accessible_name(item['name'])
                                                            for item in candidates], n=3, cutoff=0)
        suggestions = [{'role': item.get('role', ''), 'name': item['name'][:80]}
                       for candidate in nearest for item in candidates
                       if _normalized_accessible_name(item['name']) == candidate][:3]
        if len(matches) > 1:
            raise BrowserError('multiple matching elements; specify a narrower root; candidates: ' +
                               ', '.join(row['name'] for row in suggestions),
                               code='ambiguous_target', outcome_unknown=False, candidates=suggestions)
        if action == 'fill' and rejected and not matches:
            reason = ('target_disabled' if all(item.get('disabled') or item.get('busy') for item in rejected)
                      else 'target_readonly' if all(item.get('readonly') for item in rejected) else 'target_not_actionable')
            raise BrowserError('matching fields are not editable; candidates: ' + ', '.join(item['name'][:80] for item in rejected[:3]),
                               code=reason, outcome_unknown=False, candidates=suggestions)
        if matches and not matches[0].get('disabled') and not matches[0].get('busy'):
            if not isinstance(matches[0].get('ref'), str) or not matches[0]['ref']:
                raise BrowserError('missing element reference', code='invalid_receipt', outcome_unknown=False)
            return {'snapshot': page, 'ref': matches[0]['ref']}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if len(suggestions) < 3:
                # 中文注释：精确查询失败时才扩大只读范围，给出真正相近的控件名称。
                broader = semantic_snapshot(**{key: value for key, value in options.items() if key != 'query'})
                if isinstance(broader, dict) and isinstance(broader.get('items'), list):
                    candidates = [item for item in broader['items'] if isinstance(item, dict)
                                  and isinstance(item.get('name'), str) and (role is None or item.get('role') == role)]
                    nearest = difflib.get_close_matches(normalized, [_normalized_accessible_name(item['name'])
                                                                        for item in candidates], n=3, cutoff=0)
                    suggestions = [{'role': item.get('role', ''), 'name': item['name'][:80]}
                                   for candidate in nearest for item in candidates
                                   if _normalized_accessible_name(item['name']) == candidate][:3]
            raise BrowserError('element not ready before deadline; candidates: ' +
                               ', '.join(row['name'] for row in suggestions),
                               code='element_timeout', outcome_unknown=False, candidates=suggestions)
        time.sleep(min(0.25, remaining))


@_tab_scoped
def click_element(name, *, mode='pointer', tab=None, **options):
    """按名称/角色点击一次；effect=observed 表示观察到效果，无效果抛 click_no_effect。"""
    target = wait_for_element(name, action='click', **options)
    return ref_click(target['snapshot'], target['ref'], mode=mode)


@_tab_scoped
def fill_element(name, text, tab=None, **options):
    """按名称/角色定位后填写一次；敏感字段仍转人工处理。"""
    if not isinstance(text, str):
        raise BrowserError('text must be a string', code='invalid_params', outcome_unknown=False)
    target = wait_for_element(name, action='fill', **options)
    return ref_fill(target['snapshot'], target['ref'], text)


@_tab_scoped
def scroll(direction='down', *, tab=None):
    """复用受控页面滚动；滚动后重新定位，不沿用旧元素引用。"""
    if direction not in ('up', 'down'):
        raise BrowserError('invalid scroll direction', code='invalid_params', outcome_unknown=False)
    return _call('run', ['scroll', {'direction': direction}])


@_tab_scoped
def click(selector, *, tab=None):
    return _call('run', ['click', {'selector': selector}])


@_tab_scoped
def fill(selector, text, *, tab=None):
    return _call('run', ['fill', {'selector': selector, 'text': text}])


@_tab_scoped
def press(selector, key, *, tab=None):
    return _call('run', ['press', {'selector': selector, 'key': key}])


@_tab_scoped
def ref_click(snapshot, ref, *, mode='pointer', tab=None):
    """按语义引用点击一次；依据实际送达回执区分交付方式。"""
    if mode != 'pointer':
        raise BrowserError('invalid click mode', code='invalid_params', outcome_unknown=False)
    params = {'binding': snapshot['binding'], 'snapshotId': snapshot['snapshotId'], 'ref': ref}
    if snapshot.get('frameToken'):
        params['frameToken'] = snapshot['frameToken']
    # 中文注释：可见页确认可信点击，后台页保持可写并报告合成点击；调用方无需额外模式参数。
    return _call('run', ['ref_click', params])


@_tab_scoped
def ref_fill(snapshot, ref, text, *, tab=None):
    params = {'binding': snapshot['binding'], 'snapshotId': snapshot['snapshotId'], 'ref': ref, 'text': text}
    if snapshot.get('frameToken'):
        params['frameToken'] = snapshot['frameToken']
    return _call('run', ['ref_fill', params])


@_tab_scoped
def ref_press(snapshot, ref, key, *, tab=None):
    """在当前语义目标上派发受限按键，输入前仍须通过敏感字段预审。"""
    if key not in ('Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'):
        raise BrowserError('invalid key', code='invalid_params', outcome_unknown=False)
    params = {'binding': snapshot['binding'], 'snapshotId': snapshot['snapshotId'], 'ref': ref, 'key': key}
    if snapshot.get('frameToken'):
        params['frameToken'] = snapshot['frameToken']
    return _call('run', ['ref_press', params])


@_tab_scoped
def ref_set_checked(snapshot, ref, checked, *, tab=None):
    """设置当前语义引用的复选状态；结果由页面状态回读确认。"""
    if type(checked) is not bool:
        raise BrowserError('checked must be a boolean', code='invalid_params', outcome_unknown=False)
    params = {'binding': snapshot['binding'], 'snapshotId': snapshot['snapshotId'], 'ref': ref, 'checked': checked}
    if snapshot.get('frameToken'):
        params['frameToken'] = snapshot['frameToken']
    return _call('run', ['ref_set_checked', params])


@_tab_scoped
def ref_select_option(snapshot, ref, values, *, by='value', tab=None):
    """按 value、Unicode 标签或零基 index 选择原生选项，并由页面状态回读确认。"""
    # 中文注释：index 与文本选择器使用不同类型，避免布尔值或混合列表流入原生控件。
    invalid = by not in ('value', 'label', 'index') or not isinstance(values, list) or len(values) > 100
    if not invalid:
        invalid = (any(type(value) is not int or value < 0 or value > 2 ** 53 - 1 for value in values)
                   if by == 'index' else any(not isinstance(value, str) or len(value) > 1000 for value in values))
    if invalid or len(set(values)) != len(values):
        raise BrowserError('invalid option values', code='invalid_params', outcome_unknown=False)
    params = {'binding': snapshot['binding'], 'snapshotId': snapshot['snapshotId'], 'ref': ref, 'by': by, 'values': values}
    if snapshot.get('frameToken'):
        params['frameToken'] = snapshot['frameToken']
    return _call('run', ['ref_select_option', params])


@_tab_scoped
def upload_files(selector, artifact_ids=None, *, paths=None, tab=None):
    """把文件选择进当前任务页：用户在对话中给出的本地路径（paths），或已登记的文件 ID；网站接收结果须另行读取。"""
    import os
    import re
    if not isinstance(selector, str) or not selector or len(selector) > 4096 or (artifact_ids is None) == (paths is None):
        raise BrowserError('give a selector and either artifact_ids or paths', code='invalid_params', outcome_unknown=False)
    if paths is not None:
        if (not isinstance(paths, list) or not 1 <= len(paths) <= 10
                or any(not isinstance(value, str) or not value for value in paths)):
            raise BrowserError('invalid local file paths', code='invalid_params', outcome_unknown=False)
        # 中文注释：脚本工作目录中的相对路径按工作目录解析；由宿主复制进任务私有区后再选择。
        resolved = [os.path.abspath(os.path.expanduser(value)) for value in paths]
        if len(set(resolved)) != len(resolved) or any(len(value) > 4096 or '\x00' in value for value in resolved):
            raise BrowserError('invalid local file paths', code='invalid_params', outcome_unknown=False)
        return _call('run', ['files.upload', {'selector': selector, 'paths': resolved}])
    if (not isinstance(artifact_ids, list) or not 1 <= len(artifact_ids) <= 10
            or any(not isinstance(value, str) or not re.fullmatch(
                r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value)
                   for value in artifact_ids) or len(set(artifact_ids)) != len(artifact_ids)):
        raise BrowserError('invalid selected files', code='invalid_params', outcome_unknown=False)
    return _call('run', ['files.upload', {'selector': selector, 'artifactIds': artifact_ids}])


def downloads():
    """列出本任务已归属的下载（不含本机路径）与归属未知的计数。"""
    return _call('downloads', [])


def wait_for_download(timeout=30.0, *, ignore=()):
    """等待一项本任务新完成的下载；ignore 为调用前已见过的下载编号。只读轮询，不触发下载。"""
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 <= timeout <= 300):
        raise BrowserError('invalid download wait timeout', code='invalid_params', outcome_unknown=False)
    seen = set(ignore)
    deadline = time.monotonic() + timeout
    while True:
        rows = downloads().get('downloads', [])
        for row in rows:
            if row.get('id') not in seen and row.get('state') not in ('in_progress',):
                return row
        if time.monotonic() >= deadline:
            raise BrowserError('no new download finished before deadline', code='download_timeout', outcome_unknown=False)
        time.sleep(0.25)


def claim_download(download_id, dest=None):
    """领取已完成的下载并复制到工作目录；返回相对路径与摘要。中断或变化的文件不能领取。"""
    import shutil
    info = _call('download_claim', [download_id])
    name = Path(str(info.get('filename') or 'download')).name or 'download'
    target = (Path.cwd() / (dest or Path('downloads') / name)).resolve()
    if Path.cwd().resolve() not in target.parents:
        raise BrowserError('download destination must stay inside the workspace', code='invalid_params',
                           outcome_unknown=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(info.pop('localPath'), target)
    info['path'] = str(target.relative_to(Path.cwd().resolve()))
    return info


def cancel_download(download_id):
    """取消本任务仍在进行的一项下载；不影响用户自己的下载。"""
    return _call('download_cancel', [download_id])


@_tab_scoped
def js(expression, *, world='isolated', await_promise=True, timeout_ms=10000, frame_token=None, tab=None):
    """在任务页运行 JavaScript；连接授权后直接执行，凭据与内容保护仍生效。"""
    if not isinstance(expression, str) or not expression or world not in ('isolated', 'main'):
        raise BrowserError('invalid JavaScript request', code='invalid_params', outcome_unknown=False)
    params = {'expression': expression, 'world': world, 'awaitPromise': bool(await_promise), 'timeoutMs': int(timeout_ms)}
    if frame_token:
        params['frameToken'] = frame_token
    result = _call('run', ['js.evaluate', params])
    if isinstance(result, dict) and result.get('ok') is False:
        detail = result.get('exception') or {}
        raise BrowserError(_js_error_text(detail),
                           code=result.get('code', 'js_exception'), outcome_unknown=result.get('outcomeUnknown') is not False)
    return result.get('value', result) if isinstance(result, dict) else result


@_tab_scoped
def cdp(method, frame_token=None, tab=None, **params):
    """原始 CDP 方法；连接授权后直接执行，任务租约、来源和凭据保护仍生效。"""
    if not isinstance(method, str) or not method:
        raise BrowserError('invalid CDP method', code='invalid_params', outcome_unknown=False)
    payload = {'method': method, 'params': params}
    if frame_token:
        payload['frameToken'] = frame_token
    return _call('run', ['cdp.send', payload])


@_tab_scoped
def cdp_events(max=200, *, tab=None):
    """取出本任务页已订阅的 CDP 事件（有上限，dropped 表示溢出丢弃数）。"""
    return _call('run', ['cdp.events', {'max': int(max)}])


@_tab_scoped
def screenshot(path='shot.png', *, tab=None, name=None, selector=None):
    """保存视口截图到工作区或配置的导出根，返回绝对路径。"""
    import base64
    if name is not None and selector is not None:
        raise BrowserError('choose name or selector', code='invalid_params', outcome_unknown=False)
    target = (Path.cwd() / path).resolve()
    workspace = Path.cwd().resolve()
    roots = [Path(value).expanduser().resolve() for value in os.environ.get('HERMES_BROWSER_EXPORT_ROOTS', '').split(':')
             if value and Path(value).expanduser().is_absolute()]
    if target.suffix.lower() not in {'.png', '.jpg', '.jpeg'} or not any(
            target != root and root in target.parents for root in [workspace, *roots]):
        raise BrowserError(f'screenshot path denied; allowed roots: {workspace}, ' + ', '.join(map(str, roots)), code='invalid_params',
                           outcome_unknown=False)
    if target.exists():
        raise BrowserError('screenshot destination already exists', code='invalid_params', outcome_unknown=False)
    params = {'format': 'jpeg' if target.suffix.lower() in {'.jpg', '.jpeg'} else 'png'}
    if name is not None:
        found = wait_for_element(name)
        params.update({'binding': found['snapshot']['binding'], 'snapshotId': found['snapshot']['snapshotId'], 'ref': found['ref']})
    if selector is not None:
        if not isinstance(selector, str) or not selector or len(selector) > 2000:
            raise BrowserError('invalid screenshot selector', code='invalid_params', outcome_unknown=False)
        params['selector'] = selector
    receipt = _call('run', ['screenshot', params])
    target.parent.mkdir(parents=True, exist_ok=True)
    # 中文注释：独占创建防止并发覆盖；截图字节只在通过宿主遮罩后写盘。
    with target.open('xb') as output:
        output.write(base64.b64decode(receipt['data']))
    return str(target)


@_tab_scoped
def reconcile(*, tab=None):
    """After BrowserError.outcome_unknown: read the page to check what happened,
    then continue. The uncertain action itself is never resent."""
    return _call('reconcile', [])


def operation_status(request_id=None):
    """只读查询最近一次或指定请求的持久账本；不重发动作。"""
    if request_id is not None and (not isinstance(request_id, str) or not 1 <= len(request_id) <= 128):
        raise BrowserError('invalid request id', code='invalid_params', outcome_unknown=False)
    return _call('operation_status', [request_id])


def reconnect(timeout_s=30.0):
    """在当前 Python 栈内等待同一任务恢复；返回后仍需核实未知写入。"""
    if (isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float))
            or not math.isfinite(timeout_s) or not 0 <= timeout_s <= 300):
        raise BrowserError('invalid reconnect timeout', code='invalid_params', outcome_unknown=False)
    deadline = time.monotonic() + timeout_s
    while True:
        state = _call('reconnect', [])
        if state.get('state') != 'disconnected' or time.monotonic() >= deadline:
            return state
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))


def load_checkpoint():
    """读取 Hermes 为本次协作式续跑显式提供的业务检查点。"""
    return _call('checkpoint', [])


@_tab_scoped
def wait_pending(timeout_s=20.0, *, tab=None):
    """Wait for the same approval/manual-input request (max 300 s).
    Ordinary requests return their original receipt. Popup adoption queries only
    the ledger and current scope, returning operation_status fields (state=confirmed),
    never an adopted/tabId receipt. Select the catalog candidate with use_tab
    and read_page next; confirmation is not current page-access proof. Unknown
    outcomes, rejected approvals or changed scope never replay the adoption."""
    if (isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float))
            or not math.isfinite(timeout_s) or not 0 <= timeout_s <= 300):
        raise BrowserError('invalid approval wait timeout', code='invalid_params', outcome_unknown=False)
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            return _call('resume_pending', [])
        except ApprovalRequired:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1.0)


HELPERS = {name: globals()[name] for name in (
    'BrowserError', 'ApprovalRequired', 'UserInputRequired', 'new_tab', 'use_tab', 'current_tab', 'parallel', 'goto_url', 'wait_for_load', 'page_text',
    'semantic_snapshot', 'frame_catalog', 'popup_catalog', 'popup_adopt', 'read_page', 'wait_for_element', 'click_element', 'fill_element', 'scroll',
    'click', 'fill', 'press', 'ref_click', 'ref_fill', 'ref_press', 'ref_set_checked', 'ref_select_option', 'upload_files',
    'screenshot', 'reconcile', 'operation_status', 'reconnect', 'load_checkpoint', 'wait_pending',
    'downloads', 'wait_for_download', 'claim_download', 'cancel_download',
    'js', 'cdp', 'cdp_events',
    'network_start', 'network_list', 'network_detail', 'network_stop', 'page_request',
    'parse_page', 'page_markdown', 'extract', 'evaluate', 'wait_for', 'expect_response', 'expect_navigation')}


def main():
    code = sys.stdin.read()
    namespace = {'__name__': '__main__', **HELPERS}
    exec(compile(code, '<browser_script>', 'exec'), namespace)


if __name__ == '__main__':
    main()
