"""Trusted host side of the plugin's Python script lane (browser_shared_script).

The plugin host binds a ready native task to a trusted Hermes session, then
hands each script run one socket endpoint. The script can only ask for the
allowlisted helper operations below; every page action still goes through the
daemon's task, origin and approval checks. bind() is not a public tool.
"""
from __future__ import annotations
import importlib.util
import json
import math
from pathlib import Path
import select
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor


class BridgeDenied(RuntimeError):
    pass


# 中文注释：暂停使用固定原因，脚本入口不得误导用户新建任务或自动重试。
class TaskPaused(BridgeDenied):
    code = 'task_paused'


class _Launch:
    def __init__(self, channel, server, thread, lock, closed, revoked, actions):
        self._channel = channel
        self._server = server
        self._thread = thread
        self._lock = lock
        self._closed = closed
        self._revoked = revoked
        self._actions = actions
        self.fd = channel.fileno()
        self.receipt = None

    def close(self):
        if self.receipt is not None:
            return
        self._closed.set()
        try:
            self._server.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._channel.close()
        self._thread.join(timeout=3)
        if self._thread.is_alive():
            # An in-flight native RPC could still commit after CLI timeout.
            # Keep this session fenced until explicit host unbind/reconciliation.
            self._revoked.set()
            self.receipt = {'last_operation': None, 'execution_complete': False, 'outcome_unknown': True}
            # 中文注释：保留会话锁直到实际在途处理退出，退出后释放，避免永久锁死会话。
            def release_after_drain():
                self._thread.join()
                self._lock.release()
            threading.Thread(target=release_after_drain, daemon=True).start()
        else:
            try:
                # 中文注释：先冻结本次结果再释放会话锁，避免下一脚本覆盖最后操作的账本引用。
                self.receipt = self._actions.completion()
                if self._revoked.is_set():
                    self.receipt['execution_complete'] = False
            finally:
                self._lock.release()


class _BatchReceipt:
    """中文注释：只汇总本脚本实际使用的任务，不把其他任务的旧错误归给本次执行。"""
    def __init__(self, state):
        self.state = state

    def completion(self):
        roots = list(self.state['roots'].values())
        receipts = [root.completion() for root in roots]
        latest = max(roots, key=lambda root: max(item._last_started for item in [root, *root._tab_sessions.values()]))
        return {'last_operation': latest.completion()['last_operation'],
                'execution_complete': all(row['execution_complete'] for row in receipts),
                'outcome_unknown': any(row['outcome_unknown'] for row in receipts),
                'resumeSummary': next((row.get('resumeSummary') for row in receipts if row.get('resumeSummary')), None)}


class HostBridge:
    """A host-owned session binding; no model args, env or workspace identity."""
    OPTIONAL_OFFICIAL_HELPERS = frozenset({'page_info', 'fill_input'})

    def __init__(self, runtime, plugin_root, *, official_helper_capabilities=()):
        if isinstance(official_helper_capabilities, str):
            raise ValueError('official helper capabilities must be a collection')
        capabilities = frozenset(official_helper_capabilities)
        if capabilities - self.OPTIONAL_OFFICIAL_HELPERS:
            raise ValueError('unsupported official helper capability')
        self.official_helper_capabilities = capabilities
        self.runtime = runtime
        self.plugin_root = Path(plugin_root)
        spec = importlib.util.spec_from_file_location('native_action_session', self.plugin_root / 'script_lane' / 'action_session.py')
        if spec is None or spec.loader is None:
            raise BridgeDenied('native action adapter unavailable')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self._ActionSession = module.ActionSession
        self._bindings = {}
        self._task_bindings = {}
        self._session_locks = {}
        self._guard = threading.RLock()
        self._used_calls = set()
        self._closed = False
        # 中文注释：插件卸载独立于单任务撤销；允许其他绑定任务继续使用同一脚本。
        self._shutdown = threading.Event()

    def _verified_task(self, owner, task_id, instance_id=None):
        try:
            task = self.runtime.call('shared.get', {'owner': owner, 'taskId': task_id})
        except Exception as exc:
            raise BridgeDenied('native task ownership/readiness unavailable') from exc
        if isinstance(task, dict) and task.get('id') == task_id and task.get('state') == 'paused':
            raise TaskPaused('用户已接管，任务已暂停')
        if (not isinstance(task, dict) or task.get('id') != task_id or
                task.get('state') not in {'ready', 'running'} or not task.get('instanceId') or
                type(task.get('generation')) is not int or task['generation'] < 1 or
                (instance_id is not None and task.get('instanceId') != instance_id)):
            raise BridgeDenied('native task not ready on bound browser instance')
        instance = task['instanceId']
        try:
            connected = self.runtime.call('browser.list', {})
        except Exception as exc:
            raise BridgeDenied('connected browser readback unavailable') from exc
        if (not isinstance(connected, list) or not any(
                isinstance(row, dict) and row.get('instanceId') == instance and
                row.get('connected') is True for row in connected)):
            raise BridgeDenied('native task browser instance is disconnected')
        return task

    def bind(self, session_id: str, *, owner: str, task_id: str, tab_id=None):
        if (not session_id or not owner or not task_id or
                self.runtime.authority.owner_for_session(session_id) != owner):
            raise BridgeDenied('trusted owner/session binding required')
        task = self._verified_task(owner, task_id)
        instance_id = task['instanceId']
        with self._guard:
            if self._closed:
                raise BridgeDenied('native host bridge is closed')
            existing = self._task_bindings.get(session_id, {}).get(task_id)
            if not existing:
                revoked = threading.Event()
                actions = self._ActionSession(self.runtime, owner=owner, task_id=task_id)
                actions.install_scope(instance_id, task['generation'])
                # 中文注释：一会话仍只允许一个脚本进程，不同任务共用该进程锁。
                lock = self._session_locks.setdefault(session_id, threading.Lock())
                existing = (owner, task_id, instance_id, actions, lock, revoked)
                self._task_bindings.setdefault(session_id, {})[task_id] = existing
            else:
                existing[3].reconnect()
            if tab_id is not None:
                existing[3].use_tab(tab_id)
            if tab_id is not None or session_id not in self._bindings:
                self._bindings[session_id] = existing

    def unbind(self, session_id: str, *, task_id=None):
        # 中文注释：按任务撤销，其他任务的当前页与在途脚本保持原状态。
        with self._guard:
            tasks = self._task_bindings.get(session_id, {})
            selected = [task_id] if task_id else list(tasks)
            for key in selected:
                existing = tasks.pop(key, None)
                if existing:
                    existing[5].set()
            current = self._bindings.get(session_id)
            if current and current[1] in selected:
                self._bindings.pop(session_id, None)
                if tasks:
                    self._bindings[session_id] = next(reversed(tasks.values()))

    def close(self):
        """Revoke all batches and stop accepting future work on plugin unload.

        The transport gives an inherited client a short drain window to receive
        one explicit revocation error, then closes both socket endpoints even
        when the client is idle.
        """
        with self._guard:
            if self._closed:
                return
            self._closed = True
            self._shutdown.set()
            for tasks in self._task_bindings.values():
                for binding in tasks.values():
                    binding[5].set()
            self._bindings.clear()
            self._task_bindings.clear()

    def validate_origins(self, session_id, origins):
        """中文注释：网站定义只声明所需来源，不新增或扩大任务授权。"""
        with self._guard:
            binding = self._bindings.get(session_id)
            if self._closed or binding is None:
                raise BridgeDenied('no bound task')
            owner, task_id, instance_id, _, _, revoked = binding
            if revoked.is_set() or self.runtime.authority.owner_for_session(session_id) != owner:
                raise BridgeDenied('binding revoked')
            task = self._verified_task(owner, task_id, instance_id)
            if not set(origins).issubset(set(task.get('allowedOrigins', []))):
                raise BridgeDenied('site origins not approved')

    def _resolve_bound_tab(self, session_id, tab_id):
        # 中文注释：页编号只在当前可信会话已绑定的任务中查找，绝不扫描其他 owner。
        if type(tab_id) is not int:
            raise BridgeDenied('invalid work tab')
        with self._guard:
            bindings = list(self._task_bindings.get(session_id, {}).values())
        matches = []
        for owner, task_id, instance, actions, _, revoked in bindings:
            if revoked.is_set() or self.runtime.authority.owner_for_session(session_id) != owner:
                continue
            task = self.runtime.call('shared.get', {'owner': owner, 'taskId': task_id})
            if (task.get('state') in {'ready', 'running', 'paused'} and task.get('generation') == actions._generation
                    and tab_id in task.get('tabIds', [])
                    and tab_id in [row.get('tabId') for row in task.get('workTabs', []) if isinstance(row, dict)]):
                matches.append((actions, revoked))
        if len(matches) != 1:
            # 中文注释：不同浏览器可能有相同 tabId；此时必须拒绝，不猜所属任务。
            raise BridgeDenied('work tab missing or ambiguous across bound tasks')
        return matches[0]

    def prepare(self, *, session_id=None, tool_call_id=None, task_id=None,
                workspace=None, code=None, session='', local=False,resume_checkpoint=None):
        if not session_id or not tool_call_id or not workspace or not isinstance(code, str):
            raise BridgeDenied('missing trusted Hermes call identity/workspace')
        if resume_checkpoint is not None:
            try:
                valid = isinstance(resume_checkpoint, dict) and len(json.dumps(
                    resume_checkpoint, ensure_ascii=False, allow_nan=False).encode('utf-8')) <= 65536
            except (TypeError, ValueError):
                valid = False
            if not valid:
                raise BridgeDenied('invalid business checkpoint')
        if session or local:
            raise BridgeDenied('named sessions/local CDP mode are not supported by the script lane')
        with self._guard:
            if self._closed:
                raise BridgeDenied('native host bridge is closed')
            binding = self._bindings.get(session_id)
            if binding is None or (session_id, tool_call_id) in self._used_calls:
                raise BridgeDenied('no bound native task or duplicate Hermes call')
            owner, native_task, instance_id, actions, lock, revoked = binding
            if self.runtime.authority.owner_for_session(session_id) != owner:
                raise BridgeDenied('trusted session owner changed')
            task = self._verified_task(owner, native_task, instance_id)
            if not lock.acquire(blocking=False):
                raise BridgeDenied('another Python batch owns this session')
            # 中文注释：只复用可信任务返回的唯一工作页；不猜活动页，不覆盖已有脚本目标。
            tabs = task.get('tabIds')
            if (actions.tab_id is None and isinstance(tabs, list) and len(tabs) == 1
                    and type(tabs[0]) is int and tabs[0] >= 0):
                actions.tab_id = tabs[0]
            self._used_calls.add((session_id, tool_call_id))
        try:
            host, child = socket.socketpair()
            closed = threading.Event()
            state = {'current': actions, 'roots': {native_task: actions}, 'guard': threading.RLock(),
                     'revocations': {native_task: revoked}}
            resolver = lambda tab_id: self._resolve_bound_tab(session_id, tab_id)
            thread = threading.Thread(target=self._serve,
                args=(host, child, actions, revoked, closed, self.official_helper_capabilities, resume_checkpoint, state, resolver, self._shutdown), daemon=True)
            thread.start()
            return _Launch(child, host, thread, lock, closed, revoked, _BatchReceipt(state))
        except Exception:
            lock.release()
            raise

    @staticmethod
    def _helper_reply(request, actions, revoked, closed, helper_capabilities, resume_checkpoint, state, resolver):
        try:
            if closed.is_set():
                raise BridgeDenied('native script closed')
            if not isinstance(request, dict) or not {'op', 'args'} <= set(request) or set(request) - {'id', 'op', 'args', 'tab'}:
                raise BridgeDenied('invalid native helper request')
            op, args = request['op'], request['args']
            with state['guard']:
                actions = state['current']
                selected_tab = request.get('tab')
                if op == 'use_tab' and isinstance(args, list) and len(args) == 1:
                    selected_tab = args[0]
                if selected_tab is not None:
                    actions, revoked = resolver(selected_tab)
                    state['roots'][actions._task_id] = actions
                    state['revocations'][actions._task_id] = revoked
                    if op == 'use_tab':
                        actions.use_tab(selected_tab)
                        state['current'] = actions
                else:
                    revoked = state['revocations'][actions._task_id]
            if revoked.is_set():
                raise BridgeDenied('native task binding revoked')
            with actions._rpc_lock:
                selected = actions if op in {'use_tab', 'current_tab', 'capabilities', 'checkpoint'} else actions.for_tab(request['tab']) if 'tab' in request else (
                    actions.for_tab(actions.tab_id) if actions.tab_id is not None and op not in
                    {'new_tab', 'official.new_tab', 'use_tab', 'current_tab', 'reconnect', 'capabilities', 'checkpoint'} and actions._pending is None else actions)
            selected._rpc_lock.acquire()
            try:
                if op == 'capabilities' and args == []:
                    value = sorted(helper_capabilities)
                elif op == 'checkpoint' and args == []:
                    # 中文注释：业务检查点由本次 Hermes 工具调用显式传入，只读返回给同一 Python 子进程。
                    value = resume_checkpoint
                elif op == 'use_tab' and isinstance(args, list) and len(args) == 1:
                    value = actions.use_tab(args[0])
                elif op == 'current_tab' and args == []:
                    value = actions.current_tab()
                elif op == 'new_tab' and isinstance(args, list) and len(args) == 1 and isinstance(args[0], str):
                    value = selected.new_tab(args[0])
                elif op == 'goto_url' and isinstance(args, list) and len(args) == 2 and isinstance(args[0], str) and type(args[1]) is bool:
                    value = selected.goto_url(args[0], summary=args[1])
                elif op == 'reconcile' and args == []:
                    value = selected.reconcile()
                elif op == 'operation_status' and isinstance(args, list) and len(args) == 1:
                    value = selected.operation_status(args[0])
                elif op == 'reconnect' and args == []:
                    value = selected.reconnect()
                elif op == 'resume_pending' and args == []:
                    value = selected.resume_pending()
                elif op == 'run' and isinstance(args, list) and len(args) == 2 and isinstance(args[0], str) and isinstance(args[1], dict):
                    value = selected.run(args[0], args[1])
                elif op == 'downloads' and args == []:
                    value = selected.downloads()
                elif op in ('download_claim', 'download_cancel') and isinstance(args, list) and len(args) == 1 and isinstance(args[0], str):
                    value = (selected.download_claim if op == 'download_claim' else selected.download_cancel)(args[0])
                elif op == 'snapshot' and args == []:
                    value = selected.snapshot()
                elif op == 'screenshot' and args == []:
                    value = selected.screenshot()
                elif op == 'official.new_tab' and isinstance(args, list) and len(args) == 1 and isinstance(args[0], str):
                    value = selected.official_new_tab(args[0])
                elif op == 'official.goto_url' and isinstance(args, list) and len(args) == 1 and isinstance(args[0], str):
                    value = selected.official_goto_url(args[0])
                elif op == 'official.ready_state' and args == []:
                    value = selected.official_ready_state()
                elif op == 'official.page_info' and args == []:
                    if 'page_info' not in helper_capabilities:
                        raise BridgeDenied('official page_info unavailable')
                    value = selected.official_page_info()
                elif op == 'official.fill_input' and isinstance(args, list) and len(args) == 4:
                    selector, text, clear_first, timeout = args
                    if 'fill_input' not in helper_capabilities:
                        raise BridgeDenied('official fill_input unavailable')
                    if (not isinstance(selector, str) or not selector or len(selector) > 4096
                            or not isinstance(text, str) or len(text) > 65536
                            or type(clear_first) is not bool
                            or isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                            or not math.isfinite(timeout) or timeout < 0 or timeout > 30):
                        raise BridgeDenied('invalid official fill_input arguments')
                    value = selected.official_fill_input(selector, text, clear_first, timeout)
                else:
                    raise BridgeDenied('unsupported native helper or arguments')
                reply = {'ok': True, 'value': value}
            finally:
                selected._rpc_lock.release()
        except Exception as exc:
            # Never return browser credentials or internal exception text.
            # 中文注释：只按可信结果标志选择固定文案，不回传异常原文或页面数据。
            unknown = (getattr(exc, 'outcomeUnknown', True) is not False and
                       not isinstance(exc, BridgeDenied) and type(exc).__name__ not in
                       {'NoBoundTab', 'ApprovalRequired', 'UserInputRequired'})
            reply = {'ok': False, 'error': ('浏览器操作结果不确定；不要自动重放。' if unknown
                                           else '浏览器操作未执行，可重新读取页面后重试。')}
            if isinstance(exc, BridgeDenied):
                reply['code'] = 'unsupported_helper'
                reply['outcomeUnknown'] = False
            elif type(exc).__name__ == 'NoBoundTab':
                reply['code'] = 'tab_required'
                reply['outcomeUnknown'] = False
            code = getattr(exc, 'code', None)
            if isinstance(code, str) and (code in {'invalid_action','invalid_params','foreign_tab',
                    'origin_denied','invalid_url','forbidden','tab_required','invalid_state','task_closed','instance_unavailable','task_paused',
                    'request_id_conflict','request_outcome_unavailable',
                    'approval_denied','approval_expired','approval_revoked','user_input_declined',
                    'extension_timeout','extension_disconnected','workspace_unknown',
                    'cancelled','needs_sync','document_changed','site_changed','page_not_ready',
                    'stale_reference','target_unavailable','target_occluded','target_unstable',
                    'target_disabled','target_hidden','target_zero_size','target_out_of_viewport',
                    'reference_target_missing','reference_target_ambiguous',
                    'closed_shadow_unavailable','cross_origin_frame_unavailable',
                    'tab_out_of_scope','execution_denied','redirected_out_of_scope','permission_denied',
                    'stale_frame','overlay_frame_changed','overlay_injection_failed',
                    'screenshot_timeout','screenshot_expired','stale_screenshot','sensitive_target',
                    'capture_sensitive_blocked','capture_frame_uninspectable','target_readonly','element_timeout',
                    'unsupported_frame_transform','background_pointer_unavailable',
                    'radio_cannot_uncheck','invalid_target_state','select_option_missing',
                    'select_option_ambiguous','select_option_disabled','invalid_select_option',
                    'result_too_large','target_not_owned','no_dialog','dialog_open',
                    'parse_cursor_stale','invalid_parse_options',
                    'request_id_required','operation_status_unavailable','invalid_operation_status',
                    'binding_scope_missing','binding_scope_changed','invalid_binding_scope',
                    'download_not_found','download_not_complete','download_changed','download_missing',
                    'download_path_denied','download_invalid','download_not_owned','download_unavailable',
                    'browser_access_required','frame_not_supported','credential_mode_conflict',
                    'cdp_method_denied','js_timeout','js_syntax_error','js_exception','scroll_timeout','parse_budget_too_small','cdp_error','network_capture_stale','network_entry_unavailable',
                    'artifact_origin_denied','artifact_path_denied','file_input_not_unique',
                    'not_file_input','overlay_scope_stale'} or
                    (code.startswith('interaction_highlight_') and len(code) <= 62 and
                     all(char in 'abcdefghijklmnopqrstuvwxyz_' for char in code))):
                reply['code'] = code
                if code == 'task_paused':
                    reply['error'] = '用户已接管，任务已暂停；请等待用户继续，不会自动重试。'
                if code == 'redirected_out_of_scope' and isinstance(getattr(exc, 'finalOrigin', None), str):
                    reply['finalOrigin'] = exc.finalOrigin
                # 中文注释：脚本回执只保留脱敏候选和可再次定位的关闭按钮引用。
                data = getattr(exc, 'data', None)
                # 中文注释：上游 client 已过滤这些固定诊断字段，不回显页面内容。
                if isinstance(data, dict):
                    reply.update({key: data[key] for key in ('currentOrigin', 'scopeHint', 'stage', 'reasonCode') if key in data})
                if isinstance(data, dict) and code in {'reference_target_missing', 'reference_target_ambiguous', 'element_timeout'} and isinstance(data.get('candidates'), list):
                    reply['candidates'] = [{'role': row['role'][:40], 'name': row['name'][:80]}
                                           for row in data['candidates'][:5] if isinstance(row, dict)
                                           and isinstance(row.get('role'), str) and isinstance(row.get('name'), str)]
                if isinstance(data, dict) and code == 'target_occluded':
                    obstruction = data.get('obstruction')
                    if isinstance(obstruction, dict) and isinstance(obstruction.get('role'), str) and isinstance(obstruction.get('name'), str):
                        reply['obstruction'] = {'role': obstruction['role'][:40], 'name': obstruction['name'][:80]}
                        button = obstruction.get('closeButton')
                        binding = button.get('binding') if isinstance(button, dict) else None
                        if isinstance(binding, dict) and all(isinstance(binding.get(key), str) for key in ('taskId', 'documentId', 'leaseId')) and all(isinstance(button.get(key), str) for key in ('snapshotId', 'ref', 'name')):
                            reply['obstruction']['closeButton'] = {'binding': {key: binding[key] for key in ('taskId', 'documentId', 'leaseId')}, 'snapshotId': button['snapshotId'], 'ref': button['ref'], 'role': 'button', 'name': button['name'][:80]}
            if not isinstance(exc, BridgeDenied) and type(exc).__name__ != 'NoBoundTab':
                reply['outcomeUnknown'] = unknown
            if type(exc).__name__ in ('ApprovalRequired', 'UserInputRequired'):
                reply['code'] = ('user_input_required' if type(exc).__name__ == 'UserInputRequired'
                                 else 'approval_required')
                reply['outcomeUnknown'] = False
                reply['error'] = '等待浏览器确认；请查询同一请求，不要另起操作。'
        return reply

    @staticmethod
    def _serve(channel, child, actions, revoked, closed, helper_capabilities, resume_checkpoint, state, resolver, shutdown):
        # 中文注释：一个脚本进程内最多八路 helper，回执带流水号；结束时等待全部在途动作。
        pending = bytearray()
        send_lock = threading.Lock()
        pool = ThreadPoolExecutor(max_workers=8)
        shutdown_deadline = None
        def respond(request):
            reply = HostBridge._helper_reply(request, actions, revoked, closed, helper_capabilities, resume_checkpoint, state, resolver)
            if 'id' in request:
                reply['id'] = request['id']
            with send_lock:
                channel.sendall((json.dumps(reply, ensure_ascii=False) + '\n').encode('utf-8'))
        try:
            while not closed.is_set():
                # 中文注释：卸载后只留短时间返回拒绝回执；空闲客户端也会关闭，不能一直等下一次请求。
                if shutdown.is_set():
                    if shutdown_deadline is None:
                        shutdown_deadline = time.monotonic() + 0.2
                    if time.monotonic() >= shutdown_deadline:
                        break
                readable, _, _ = select.select([channel], [], [], 0.1)
                if not readable:
                    continue
                chunk = channel.recv(65536)
                if not chunk:
                    break
                pending.extend(chunk)
                if len(pending) > 1024 * 1024:
                    raise BridgeDenied('helper request too large')
                while b'\n' in pending:
                    line, _, rest = pending.partition(b'\n')
                    pending = bytearray(rest)
                    request = json.loads(line)
                    pool.submit(respond, request)
                if shutdown.is_set():
                    break
        except (OSError, ValueError, BridgeDenied):
            pass
        finally:
            pool.shutdown(wait=True)
            channel.close()
            child.close()
