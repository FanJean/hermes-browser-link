"""Preview Python action adapter for an already-authorized shared browser task.

This is NOT a browser_exec hook or a drop-in Browser Use helper backend. The
trusted Hermes host must construct it with an owner derived from its own
session identity; never accept owner/task binding from model-written Python.
NativeProfileRuntime.call keeps daemon-side ownership and approval checks.
"""
from __future__ import annotations

import math
import os
import importlib.util
import secrets
import threading
import time
from pathlib import Path
from typing import Any


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _valid_page_info(receipt):
    if not isinstance(receipt, dict):
        return False
    if set(receipt) == {'dialog'}:
        dialog = receipt['dialog']
        if not isinstance(dialog, dict) or not {'type', 'message'} <= set(dialog):
            return False
        allowed = {'type', 'message', 'url', 'frameId', 'hasBrowserHandler', 'defaultPrompt'}
        if set(dialog) - allowed:
            return False
        if dialog.get('type') not in {'alert', 'confirm', 'prompt', 'beforeunload'}:
            return False
        if not isinstance(dialog.get('message'), str):
            return False
        for key in ('url', 'frameId', 'defaultPrompt'):
            if key in dialog and not isinstance(dialog[key], str):
                return False
        return 'hasBrowserHandler' not in dialog or type(dialog['hasBrowserHandler']) is bool
    required = {'url', 'title', 'w', 'h', 'sx', 'sy', 'pw', 'ph'}
    return (set(receipt) == required and isinstance(receipt.get('url'), str)
            and isinstance(receipt.get('title'), str)
            and all(_finite_number(receipt.get(key)) for key in ('w', 'h', 'sx', 'sy', 'pw', 'ph')))



def _valid_fill_receipt(receipt):
    if not isinstance(receipt, dict) or type(receipt.get('found')) is not bool:
        return False
    if receipt['found'] is False:
        return set(receipt) == {'found'}
    return (set(receipt) == {'found', 'delivery', 'inputEvent', 'changeEvent'}
            and receipt.get('delivery') == 'cdp-key-events'
            and receipt.get('inputEvent') is True and receipt.get('changeEvent') is True)


class PendingAction(RuntimeError):
    """A bound action still needs the user's decision; do not start another."""


class ApprovalRequired(PendingAction):
    """The action is pending in the existing trusted extension approval UI."""


class UserInputRequired(ApprovalRequired):
    """A sensitive field: the person fills it in the page; nothing is typed by us."""


class OutcomeUnknown(RuntimeError):
    """A dispatched action's result cannot be established; no automatic replay."""
    def __init__(self, message, code=None, data=None):
        super().__init__(message)
        # 中文注释：未知结果仍禁止重放，只保留 client 已过滤的固定效果字段。
        self.data = {key: data[key] for key in ('effect', 'suggestion') if isinstance(data, dict) and key in data}
        self.code = code or 'outcome_unknown'
        self.outcomeUnknown = True


class NoBoundTab(RuntimeError):
    """The task has no verified owned work tab."""

class ActionRejected(RuntimeError):
    """A classified, deterministically rejected action (not an unknown write)."""
    def __init__(self, code, final_origin=None, data=None):
        super().__init__('native action rejected')
        self.code = code
        self.outcomeUnknown = False
        self.finalOrigin = final_origin
        # 中文注释：保留桥接层已裁剪的结构化错误数据，宿主发送前再次筛选。
        self.data = data if isinstance(data, dict) else {}


class ActionSession:
    """Translate a small Python action slice into the existing shared.run RPC.

    The object is in the trusted host, not agent_helpers.py or the model's
    interpreter. One call can be pending. Ordinary approvals query the same
    payload; popup adoption waits query only its ledger and current scope.
    Any transport/receipt failure freezes the
    session, including read calls, until the host explicitly reconciles it.
    """

    def __init__(self, runtime: Any, *, owner: str, task_id: str) -> None:
        if not isinstance(owner, str) or not owner or not isinstance(task_id, str) or not task_id:
            raise ValueError('trusted owner and task_id are required')
        self._runtime = runtime
        self._owner = owner
        self._task_id = task_id
        self._pending: dict[str, Any] | None = None
        self._pending_kind: str | None = None
        self._unknown = False
        self._generation_reset = False
        self._last_request_id: str | None = None
        self._last_started = 0.0
        self._instance_id: str | None = None
        self._generation: int | None = None
        self.tab_id: int | None = None
        self._tab_sessions = {}
        self._rpc_lock = threading.RLock()
        self._resume_summary = None
        self._popup_candidates = {}
        self._pending_popup_scope = None
        self._popup_waiting = False

    def _wait_for_resume(self):
        # 中文注释：暂停仅轮询同一任务状态，不重放已派发动作；代次或终态变化立即退出。
        timeout = int(os.environ.get('HERMES_BROWSER_PAUSE_TIMEOUT_S', '600'))
        if not 1 <= timeout <= 3600:
            raise ValueError('HERMES_BROWSER_PAUSE_TIMEOUT_S must be 1..3600')
        deadline = time.monotonic() + timeout
        while True:
            task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
            if task.get('generation') != self._generation or task.get('state') in {'closed', 'cancelled', 'needs_sync', 'failed'}:
                raise ActionRejected('invalid_state')
            if task.get('state') in {'ready', 'running'}:
                self._resume_summary = task.get('resumeSummary')
                return
            if task.get('state') != 'paused':
                raise ActionRejected('invalid_state')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ActionRejected('task_paused')
            time.sleep(min(0.25, remaining))

    def use_tab(self, tab_id):
        """中文注释：只接受本任务创建且仍被租用的工作页，不使用浏览器活动页。"""
        if self._unknown or self._pending is not None:
            raise PendingAction('reconcile or resolve pending action before changing tabs')
        task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
        if task.get('state') == 'paused':
            self._wait_for_resume()
            task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
        owned = [row.get('tabId') for row in task.get('workTabs', []) if isinstance(row, dict)]
        owned += task.get('adoptedPopupTabIds', [])
        if (type(tab_id) is not int or tab_id not in owned or tab_id not in task.get('tabIds', [])
                or task.get('state') not in {'ready', 'running'} or task.get('generation') != self._generation):
            raise ActionRejected('foreign_tab')
        self.tab_id = tab_id
        return tab_id

    def current_tab(self):
        return self.tab_id

    def for_tab(self, tab_id):
        # 中文注释：显式页参数不改变当前页，各页单独保存待确认及未知结果围栏。
        if self._unknown:
            raise OutcomeUnknown('task operation outcome unknown')
        if type(tab_id) is not int:
            raise NoBoundTab('explicit work tab required')
        if tab_id not in self._tab_sessions:
            child = ActionSession(self._runtime, owner=self._owner, task_id=self._task_id)
            child.install_scope(self._instance_id, self._generation)
            child.use_tab(tab_id)
            self._tab_sessions[tab_id] = child
        return self._tab_sessions[tab_id]

    def install_scope(self, instance_id: str, generation: int) -> None:
        if (not isinstance(instance_id, str) or not instance_id or type(generation) is not int
                or generation < 1 or self._instance_id not in (None, instance_id)):
            raise ActionRejected('invalid_binding_scope')
        self._instance_id = instance_id
        self._generation = generation

    def reconnect(self) -> dict:
        """Read the bound task after a transport break; never repeat a pending write."""
        if not self._instance_id or self._generation is None:
            raise ActionRejected('binding_scope_missing')
        try:
            task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
            browsers = self._runtime.call('browser.list', {})
        except Exception:
            return {'state': 'disconnected', 'requiresReconciliation': self._unknown}
        if (not isinstance(task, dict) or task.get('id') != self._task_id
                or task.get('instanceId') != self._instance_id
                or type(task.get('generation')) is not int
                or task['generation'] < self._generation):
            raise ActionRejected('binding_scope_changed')
        if not isinstance(browsers, list) or not any(
                isinstance(row, dict) and row.get('instanceId') == self._instance_id
                and row.get('connected') is True for row in browsers):
            return {'state': 'disconnected', 'requiresReconciliation': self._unknown}
        if task.get('state') != 'ready':
            return {'state': str(task.get('state') or 'unknown'),
                    'requiresReconciliation': self._unknown}
        if task['generation'] != self._generation:
            # 中文注释：新代次不能续用旧在途请求或页面引用，先只读核实新的唯一工作页。
            self._tab_sessions.clear()
            self._generation = task['generation']
            self._pending = None
            self._pending_kind = None
            self._unknown = True
            self._generation_reset = True
            self.tab_id = None
        work_tabs = task.get('workTabs')
        allowed_tabs = task.get('tabIds')
        if (isinstance(work_tabs, list) and len(work_tabs) == 1 and isinstance(allowed_tabs, list)
                and isinstance(work_tabs[0], dict)
                and type(work_tabs[0].get('tabId')) is int
                and work_tabs[0]['tabId'] in allowed_tabs):
            self.tab_id = work_tabs[0]['tabId']
        elif self.tab_id not in (allowed_tabs if isinstance(allowed_tabs, list) else []):
            self.tab_id = None
        return {'state': 'ready', 'generation': self._generation, 'tabId': self.tab_id,
                'requiresReconciliation': self._unknown}

    def _request(self, action: str, kind: str, **arguments: Any) -> Any:
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; reconcile before any further action')
        if self._pending is not None:
            raise PendingAction('resolve the existing request before another action')
        self._pending_popup_scope = None
        self._popup_waiting = False
        if action == 'popup_adopt':
            task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
            self._pending_popup_scope = {
                'instanceId': task.get('instanceId'), 'generation': task.get('generation'),
                'modeGeneration': task.get('modeGeneration'),
                'candidate': self._popup_candidates.get((arguments.get('tabId'), arguments.get('candidateRef'))),
            }
        payload = {'owner': self._owner, 'taskId': self._task_id,
                   'requestId': secrets.token_urlsafe(18), 'action': action, **arguments}
        self._last_request_id = payload['requestId']
        self._last_started = time.monotonic()
        self._pending = payload
        self._pending_kind = kind
        return self.resume_pending()

    def operation_status(self, request_id: str | None = None) -> dict:
        """Read only the persisted receipt state of this task's prior request."""
        selected = request_id if request_id is not None else self._last_request_id
        if not isinstance(selected, str) or not 1 <= len(selected) <= 128:
            raise ActionRejected('request_id_required')
        try:
            result = self._runtime.call('shared.operation_status', {
                'owner': self._owner, 'taskId': self._task_id, 'requestId': selected})
        except Exception as exc:
            raise ActionRejected('operation_status_unavailable') from exc
        if (not isinstance(result, dict) or result.get('state') not in
                {'awaiting_approval', 'awaiting_human', 'dispatched', 'confirmed', 'rejected', 'unknown'}
                or type(result.get('dispatched')) is not bool
                or not isinstance(result.get('requestIdHash'), str)):
            raise ActionRejected('invalid_operation_status')
        # 中文注释：请求 ID 只是本任务的只读关联键；查询不解除未知写入的冻结。
        return {'requestId': selected, 'requestIdHash': result['requestIdHash'],
                'state': result['state'], 'dispatched': result['dispatched'],
                'generation': result.get('generation')}

    def _download_call(self, method: str, **extra: Any) -> Any:
        try:
            return self._runtime.call(method, {'owner': self._owner, 'taskId': self._task_id, **extra})
        except Exception as exc:
            code = getattr(exc, 'code', None)
            # 中文注释：下载查询与领取不向页面派发动作；失败时按已知拒绝处理，不冻结脚本。
            if method != 'shared.download_cancel' or code in {'download_not_found', 'download_not_owned'}:
                raise ActionRejected(code if isinstance(code, str) else 'download_unavailable') from exc
            self._unknown = True
            raise OutcomeUnknown('download cancel outcome unknown; list downloads before retrying', code=code) from exc

    def downloads(self) -> dict:
        return self._download_call('shared.downloads')

    def download_claim(self, download_id: str) -> dict:
        if not isinstance(download_id, str) or not 1 <= len(download_id) <= 64:
            raise ActionRejected('invalid_params')
        return self._download_call('shared.download_claim', downloadId=download_id)

    def download_cancel(self, download_id: str) -> dict:
        if not isinstance(download_id, str) or not 1 <= len(download_id) <= 64:
            raise ActionRejected('invalid_params')
        return self._download_call('shared.download_cancel', downloadId=download_id)

    def last_operation(self) -> dict | None:
        if self._last_request_id is None:
            return None
        try:
            return self.operation_status(self._last_request_id)
        except ActionRejected:
            return {'requestId': self._last_request_id, 'state': 'unavailable',
                    'dispatched': None, 'generation': self._generation}

    def completion(self) -> dict:
        """中文注释：结束状态取自可信动作账本，脚本捕获异常不能将未完成操作改为成功。"""
        latest = max([self, *self._tab_sessions.values()], key=lambda item: item._last_started)
        last = latest.last_operation()
        state = last.get('state') if last else None
        unknown = self._unknown or state in {'unknown', 'dispatched', 'unavailable'}
        complete = not unknown and self._pending is None and state in {None, 'confirmed', 'rejected'}
        children = [child.completion() for child in self._tab_sessions.values()]
        return {'last_operation': last, 'execution_complete': complete and all(child['execution_complete'] for child in children),
                'outcome_unknown': unknown or any(child['outcome_unknown'] for child in children),
                'resumeSummary': self._resume_summary or next((child.get('resumeSummary') for child in children if child.get('resumeSummary')), None)}

    def _query_popup_pending(self):
        # 中文注释：账本只证明原动作状态，不重取成功缓存，也不授予或续用旧权限。
        payload, scope = self._pending, self._pending_popup_scope
        assert payload is not None
        try:
            status = self.operation_status(payload['requestId'])
            if status['state'] == 'unknown':
                raise OutcomeUnknown('popup adoption outcome unknown; do not replay')
            task = self._runtime.call('shared.get', {'owner': self._owner, 'taskId': self._task_id})
            if (not scope or task.get('id') != self._task_id
                    or task.get('instanceId') != self._instance_id
                    or scope['instanceId'] != self._instance_id
                    or task.get('generation') != self._generation
                    or scope['generation'] != self._generation
                    or status['generation'] != self._generation
                    or type(scope['modeGeneration']) is not int
                    or task.get('modeGeneration') != scope['modeGeneration']
                    or task.get('state') not in {'ready', 'running', 'paused'}):
                raise ActionRejected('approval_revoked')
            if status['state'] == 'rejected':
                # 中文注释：公开账本不含拒绝原因，不能把它猜成用户拒绝或过期。
                raise ActionRejected('approval_revoked')
            if status['state'] == 'confirmed':
                candidate = scope['candidate']
                if (not status['dispatched'] or not candidate
                        or payload['tabId'] not in task.get('tabIds', [])
                        or candidate['tabId'] not in task.get('tabIds', [])
                        or candidate['tabId'] not in task.get('adoptedPopupTabIds', [])
                        or candidate['origin'] not in task.get('allowedOrigins', [])):
                    raise ActionRejected('approval_revoked')
                if task['state'] == 'paused':
                    self._wait_for_resume()
                    return self._query_popup_pending()
                self._pending = None
                self._pending_kind = None
                self._popup_waiting = False
                return status
        except ActionRejected as exc:
            if exc.code in {'operation_status_unavailable', 'invalid_operation_status'}:
                self._unknown = True
                raise OutcomeUnknown('popup ledger unavailable; do not replay', code=exc.code) from exc
            self._pending = None
            self._pending_kind = None
            self._popup_waiting = False
            raise
        except Exception as exc:
            self._unknown = True
            raise OutcomeUnknown('popup result query failed; do not replay',
                                 code=getattr(exc, 'code', None)) from exc
        raise ApprovalRequired('await existing popup approval; query its ledger only')

    def resume_pending(self) -> Any:
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; do not replay')
        if self._pending is None:
            raise PendingAction('no pending request')
        payload = self._pending
        if self._popup_waiting:
            return self._query_popup_pending()
        try:
            while True:
                try:
                    receipt = self._runtime.call('shared.run', dict(payload))
                    break
                except Exception as exc:
                    if getattr(exc, 'code', None) != 'task_paused':
                        raise
                    self._wait_for_resume()
        except Exception as exc:
            code = getattr(exc, 'code', None)
            data = getattr(exc, 'data', None)
            unknown = (data.get('outcomeUnknown') if isinstance(data, dict) else None)
            rejected_before_dispatch = code in {'invalid_action','invalid_params','foreign_tab',
                'origin_denied','invalid_url','forbidden','tab_required','invalid_state','task_paused','site_changed',
                'request_id_conflict','approval_denied','approval_expired','user_input_declined',
                'browser_access_required','frame_not_supported','credential_mode_conflict','cdp_method_denied','task_closed','instance_unavailable'}
            if code and (unknown is False or (unknown is None and rejected_before_dispatch)):
                # Approval denial, scope rejection, stale reference: no write was
                # dispatched. Retain classification without exposing page data.
                self._pending = None
                self._pending_kind = None
                raise ActionRejected(code, data.get('finalOrigin') if isinstance(data, dict) and code == 'redirected_out_of_scope' else None, data) from exc
            self._unknown = True
            raise OutcomeUnknown('native action outcome unknown; no automatic replay', code=code, data=data) from exc
        if not isinstance(receipt, dict):
            self._unknown = True
            raise OutcomeUnknown('invalid native action receipt')
        if receipt.get('status') in ('approval_required', 'approved', 'executing', 'user_input_required'):
            if receipt.get('requestId') != payload['requestId']:
                self._unknown = True
                raise OutcomeUnknown('pending receipt requestId mismatch')
            if self._pending_kind == 'popup_adopt':
                self._popup_waiting = True
            if receipt['status'] == 'user_input_required':
                raise UserInputRequired('the user must fill this sensitive field in the page')
            raise ApprovalRequired('await existing approval and query this same request')
        # 中文注释：页面脚本抛出的语法/运行时异常是确定的结果，原样交给 js()/evaluate() 分类报错，不冻结会话。
        if (receipt.get('ok') is False and 'error' not in receipt
                and receipt.get('code') in ('js_syntax_error', 'js_exception')
                and self._pending_kind in ('js.evaluate', 'evaluate')):
            self._pending = None
            self._pending_kind = None
            return receipt
        if 'error' in receipt or receipt.get('ok') is False:
            self._unknown = True
            raise OutcomeUnknown('native action rejected or uncertain; inspect the task state')
        kind = self._pending_kind
        if kind == 'popup_catalog':
            self._popup_candidates = {(payload['tabId'], row['candidateRef']):
                                      {'tabId': row['tabId'], 'origin': row['origin']}
                                      for row in receipt.get('candidates', [])
                                      if isinstance(row, dict) and isinstance(row.get('candidateRef'), str)
                                      and type(row.get('tabId')) is int and isinstance(row.get('origin'), str)}
        if kind == 'navigate' and (type(receipt.get('tabId')) is not int or receipt['tabId'] != self.tab_id):
            self._unknown = True
            raise OutcomeUnknown('navigate receipt did not match the bound tab')
        if kind == 'official.new_tab':
            tab_id, target = receipt.get('tabId'), receipt.get('targetId')
            if type(tab_id) is not int or tab_id < 0 or not isinstance(target, str) or not target:
                self._unknown = True
                raise OutcomeUnknown('official new_tab requires verified Chrome target and tab')
            self.tab_id = tab_id
            value = target
        elif kind == 'official.goto_url':
            if (not isinstance(receipt.get('frameId'), str) or not receipt['frameId']
                or set(receipt) - {'frameId','loaderId','errorText','isDownload'}
                or any(k in receipt and not isinstance(receipt[k], str) for k in ('loaderId','errorText'))
                or ('isDownload' in receipt and type(receipt['isDownload']) is not bool)):
                self._unknown = True
                raise OutcomeUnknown('invalid official Page.navigate receipt')
            value = receipt
        elif kind == 'official.ready_state':
            if receipt.get('readyState') not in ('loading','interactive','complete'):
                self._unknown = True
                raise OutcomeUnknown('invalid document.readyState receipt')
            value = receipt
        elif kind == 'official.page_info':
            if not _valid_page_info(receipt):
                self._unknown = True
                raise OutcomeUnknown('invalid official page_info receipt')
            value = receipt
        elif kind == 'official.fill_input':
            if not _valid_fill_receipt(receipt):
                self._unknown = True
                raise OutcomeUnknown('invalid official fill_input receipt')
            value = receipt
        elif kind == 'new_tab':
            tab_id = receipt.get('tabId')
            if type(tab_id) is not int or tab_id < 0:
                self._unknown = True
                raise OutcomeUnknown('new_tab returned no verified tabId')
            self.tab_id = tab_id
            value = tab_id
        elif kind == 'screenshot':
            data = receipt.get('data')
            if not isinstance(data, str) or not data:
                self._unknown = True
                raise OutcomeUnknown('screenshot returned no PNG data')
            value = data
        else:
            value = receipt
        self._pending = None
        self._pending_kind = None
        return value

    def new_tab(self, url: str) -> int:
        """Open only an already-approved origin; native daemon validates URL."""
        return self._request('new_tab', 'new_tab', url=url)

    def goto_url(self, url: str, *, summary: bool = True) -> dict:
        """Navigate only the verified work tab; return native (not CDP) receipt."""
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; reconcile before any further action')
        if self.tab_id is None:
            raise NoBoundTab('use new_tab on an authorized task before navigation')
        receipt = self._request('navigate', 'navigate', tabId=self.tab_id, url=url)
        if summary:
            # 中文注释：摘要读取失败不改写已确认的导航结果；下一步可显式取语义快照。
            try:
                # 中文注释：插件以文件路径加载；脚本通道也按路径读取同一摘要实现。
                path = Path(__file__).resolve().parents[1] / 'open_tool.py'
                spec = importlib.util.spec_from_file_location('hermes_browser_page_summary', path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                receipt['summary'] = module._summary(self._runtime, self._owner, self._task_id,
                                                     self.tab_id, self._last_request_id, receipt.get('url', url))
            except Exception:
                receipt['summary'] = None
        return receipt

    def reconcile(self) -> dict:
        """After an uncertain write, read the page once so the caller can check
        what actually happened, then allow further actions. It never resends the
        uncertain action and never bypasses a pending approval."""
        if self._pending is not None and not self._unknown:
            raise PendingAction('resolve the pending request before reconciling')
        if self.tab_id is None and self._generation_reset:
            # 中文注释：新代次没有旧工作页可读；调用方显式确认后才可建新页，旧的未知写入仍需在业务侧核实。
            self._unknown = False
            self._generation_reset = False
            self._pending = None
            self._pending_kind = None
            return {'reconciled': True, 'tabId': None, 'generation': self._generation,
                    'note': 'new generation has no work tab; verify the old page outcome from business data'}
        if self.tab_id is None:
            raise NoBoundTab('no owned work tab')
        self._unknown = False
        self._pending = None
        self._pending_kind = None
        return self._request('snapshot', 'snapshot', tabId=self.tab_id)

    def snapshot(self) -> dict:
        """Read the owned tab; native snapshot is not Browser Use page_info()."""
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; reconcile before any further action')
        if self.tab_id is None:
            raise NoBoundTab('no owned work tab')
        return self._request('snapshot', 'snapshot', tabId=self.tab_id)

    def screenshot(self) -> str:
        """Return native Page.captureScreenshot base64 data for the bound tab."""
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; reconcile before any further action')
        if self.tab_id is None:
            raise NoBoundTab('no owned work tab')
        return self._request('screenshot', 'screenshot', tabId=self.tab_id)

    # Page actions a script may request on its own work tab, with the argument
    # keys each accepts. The daemon still validates values, origins, approval
    # and sensitive targets; this only narrows the surface.
    SCRIPT_ACTIONS = {
        'popup_catalog': frozenset(),
        'popup_adopt': frozenset({'candidateRef'}),
        # 中文注释：复用原生已开放的滚动动作，不新增脚本任意执行权限。
        'scroll': frozenset({'direction'}),
        'snapshot': frozenset(),
        'screenshot': frozenset({'selector', 'binding', 'snapshotId', 'ref', 'format'}),
        'page.observe': frozenset({'options'}),
        'page.parse': frozenset({'options'}),
        'semantic_snapshot': frozenset({'options'}),
        'frame_catalog': frozenset(),
        'click': frozenset({'selector'}),
        'fill': frozenset({'selector', 'text'}),
        'press': frozenset({'selector', 'key'}),
        'ref_click': frozenset({'binding', 'snapshotId', 'ref', 'clickMode', 'frameToken'}),
        'ref_fill': frozenset({'binding', 'snapshotId', 'ref', 'text', 'frameToken'}),
        # 中文注释：脚本只传最新快照引用及固定按键，任务页仍由宿主绑定。
        'ref_press': frozenset({'binding', 'snapshotId', 'ref', 'key', 'frameToken'}),
        # 中文注释：文件路径只由 daemon 从用户登记 ID 解析，脚本只能提交 ID 和目标选择器。
        'files.upload': frozenset({'selector', 'artifactIds', 'paths'}),
        'ref_set_checked': frozenset({'binding', 'snapshotId', 'ref', 'checked', 'frameToken'}),
        'ref_select_option': frozenset({'binding', 'snapshotId', 'ref', 'by', 'values', 'frameToken'}),
        'official.ready_state': frozenset(),
        # 中文注释：JavaScript/CDP 与网络观察复用现有任务的浏览器访问。
        'js.evaluate': frozenset({'expression', 'world', 'awaitPromise', 'timeoutMs', 'frameToken', 'arguments'}),
        'cdp.send': frozenset({'method', 'params', 'frameToken'}),
        'cdp.events': frozenset({'max'}),
        # 中文注释：网络查询仍经同一任务与浏览器授权链。
        'network.inspect': frozenset({'options'}),
    }

    def run(self, action: str, arguments: dict) -> Any:
        """Run one allowlisted page action on the verified work tab."""
        if self._unknown:
            raise OutcomeUnknown('previous outcome unknown; reconcile before any further action')
        allowed = self.SCRIPT_ACTIONS.get(action) if isinstance(action, str) else None
        if allowed is None or not isinstance(arguments, dict) or set(arguments) - allowed:
            raise ActionRejected('invalid_params')
        if self.tab_id is None:
            raise NoBoundTab('use new_tab before page actions')
        return self._request(action, 'screenshot_receipt' if action == 'screenshot' else action,
                             tabId=self.tab_id, **arguments)

    def official_new_tab(self, url='about:blank') -> str:
        return self._request('official.new_tab','official.new_tab',url=url)

    def official_goto_url(self, url: str) -> dict:
        if self.tab_id is None:
            raise NoBoundTab('use new_tab before navigation')
        return self._request('official.goto_url','official.goto_url',tabId=self.tab_id,url=url)

    def official_ready_state(self) -> dict:
        if self.tab_id is None:
            raise NoBoundTab('use new_tab before reading document.readyState')
        return self._request('official.ready_state','official.ready_state',tabId=self.tab_id)

    def official_page_info(self) -> dict:
        """Return Browser Harness page_info data; semantic snapshots are not equivalent."""
        if self.tab_id is None:
            raise NoBoundTab('use new_tab before reading page_info')
        return self._request('official.page_info','official.page_info',tabId=self.tab_id)

    def official_fill_input(self, selector: str, text: str, clear_first=True, timeout=0.0) -> dict:
        """Request key-event delivery; never translate this to the native DOM-value fill."""
        if self.tab_id is None:
            raise NoBoundTab('use new_tab before fill_input')
        if not isinstance(selector, str) or not isinstance(text, str):
            raise ValueError('fill_input selector and text must be strings')
        if type(clear_first) is not bool or not _finite_number(timeout) or timeout < 0:
            raise ValueError('fill_input clear_first or timeout is invalid')
        return self._request('official.fill_input','official.fill_input',tabId=self.tab_id,
                             selector=selector,text=text,clearFirst=clear_first,timeout=timeout)
