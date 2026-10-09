"""First Python→existing shared-task action tracer; no real browser is started."""
import importlib.util
import pathlib
import tempfile
import unittest
import os
import threading
import time
from unittest.mock import patch

MODULE = pathlib.Path(__file__).resolve().parents[2] / 'executor-plugin' / 'script_lane' / 'action_session.py'
spec = importlib.util.spec_from_file_location('v11_action_session', MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class RecordingRuntime:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, dict) and response.get('status') == 'approval_required' and 'requestId' not in response:
            return {**response, 'requestId': params['requestId']}
        return response


class ActionSessionTest(unittest.TestCase):
    def test_paused_action_waits_for_same_task_then_continues(self):
        # 中文注释：暂停期间不派发第二动作；恢复后原请求编号只重查未派发步骤。
        resumed = threading.Event()
        class PausedRuntime:
            def __init__(self): self.actions = []; self.reads = 0
            def call(self, method, params):
                if method == 'shared.get':
                    self.reads += 1
                    return {'state': 'ready' if resumed.is_set() else 'paused', 'generation': 2,
                            'resumeSummary': {'urlChanged': True, 'documentReplaced': False,
                                              'referencesInvalid': True, 'readPageFirst': True}}
                self.actions.append(dict(params))
                if not resumed.is_set():
                    raise type('Paused', (Exception,), {'code': 'task_paused', 'data': {'outcomeUnknown': False}})()
                return {'tabId': 9}
        runtime = PausedRuntime()
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.install_scope('instance-1', 2)
        result = []
        worker = threading.Thread(target=lambda: result.append(session.new_tab('https://example.test/')))
        worker.start()
        time.sleep(0.08)
        self.assertEqual(len(runtime.actions), 1)
        resumed.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [9])
        self.assertEqual(runtime.actions[0]['requestId'], runtime.actions[1]['requestId'])
        self.assertTrue(session.completion()['resumeSummary']['urlChanged'])

    def test_pause_timeout_is_classified_without_dispatch(self):
        class PausedRuntime:
            def call(self, method, _params):
                if method == 'shared.get': return {'state': 'paused', 'generation': 2}
                raise type('Paused', (Exception,), {'code': 'task_paused', 'data': {'outcomeUnknown': False}})()
        session = adapter.ActionSession(PausedRuntime(), owner='trusted-owner', task_id='task-1')
        session.install_scope('instance-1', 2)
        with patch.dict(os.environ, {'HERMES_BROWSER_PAUSE_TIMEOUT_S': '1'}):
            with self.assertRaises(adapter.ActionRejected) as caught:
                session.new_tab('https://example.test/')
        self.assertEqual(caught.exception.code, 'task_paused')

    def test_existing_tab_helper_waits_before_selecting_paused_page(self):
        resumed = threading.Event()
        class Runtime:
            def call(self, method, _params):
                self_method = method
                assert self_method == 'shared.get'
                return {'state': 'ready' if resumed.is_set() else 'paused', 'generation': 2,
                        'tabIds': [7], 'workTabs': [{'tabId': 7}]}
        session = adapter.ActionSession(Runtime(), owner='trusted-owner', task_id='task-1')
        session.install_scope('instance-1', 2)
        values = []
        worker = threading.Thread(target=lambda: values.append(session.use_tab(7)))
        worker.start();time.sleep(0.08)
        self.assertEqual(values, [])
        resumed.set();worker.join(2)
        self.assertEqual(values, [7])

    def test_operation_status_is_read_only_even_after_an_unknown_write(self):
        runtime = RecordingRuntime([
            TimeoutError('response lost'),
            {'requestIdHash': 'a' * 64, 'state': 'unknown', 'dispatched': True, 'generation': 4},
        ])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.new_tab('https://example.test/')
        status = session.operation_status()
        # 中文注释：同一请求只查询账本，未知写入仍冻结，不产生第二次 shared.run。
        self.assertEqual(status['state'], 'unknown')
        self.assertEqual(status['requestId'], runtime.calls[0][1]['requestId'])
        self.assertEqual([method for method, _ in runtime.calls], ['shared.run', 'shared.operation_status'])
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()

    def test_js_error_receipt_keeps_code_and_does_not_freeze_session(self):
        # 中文注释：真实浏览器回归：js.evaluate 的语法/运行时异常回执曾被当成结果不确定并冻结会话。
        runtime = RecordingRuntime([
            {'tabId': 7},
            {'ok': False, 'code': 'js_syntax_error', 'outcomeUnknown': False,
             'exception': {'type': 'SyntaxError', 'text': "SyntaxError: Unexpected token '*'"}},
            {'ok': False, 'code': 'js_exception', 'outcomeUnknown': True,
             'exception': {'type': 'TypeError', 'text': 'TypeError: x is null'}},
            {'ok': True, 'value': 'title'},
        ])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/')
        first = session.run('js.evaluate', {'expression': 'document.title +* 1'})
        self.assertEqual((first['ok'], first['code']), (False, 'js_syntax_error'))
        second = session.run('js.evaluate', {'expression': 'x.y'})
        self.assertEqual(second['code'], 'js_exception')
        self.assertEqual(session.run('js.evaluate', {'expression': 'document.title'})['value'], 'title')

    def test_other_ok_false_receipts_still_freeze_session(self):
        runtime = RecordingRuntime([{'tabId': 7}, {'ok': False, 'code': 'something_else'}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.run('js.evaluate', {'expression': 'document.title'})
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()

    def test_last_operation_can_be_returned_after_child_exit(self):
        runtime = RecordingRuntime([
            {'tabId': 7},
            {'requestIdHash': 'b' * 64, 'state': 'confirmed', 'dispatched': True, 'generation': 4},
        ])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/')
        last = session.last_operation()
        self.assertEqual(last['requestId'], runtime.calls[0][1]['requestId'])
        self.assertEqual((last['state'], last['dispatched']), ('confirmed', True))

    def test_reconnect_rebinds_only_the_same_task_and_keeps_unknown_write_fenced(self):
        task = {'id': 'task-1', 'instanceId': 'instance-1', 'state': 'ready', 'generation': 2,
                'tabIds': [8], 'workTabs': [{'tabId': 8}]}
        runtime = RecordingRuntime([ConnectionError('offline'), task,
                                    [{'instanceId': 'instance-1', 'connected': True}],
                                    {'text': 'new page'}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.install_scope('instance-1', 1)
        session.tab_id = 7
        self.assertEqual(session.reconnect()['state'], 'disconnected')
        ready = session.reconnect()
        self.assertEqual((ready['generation'], ready['tabId'], ready['requiresReconciliation']), (2, 8, True))
        # 中文注释：新代次只恢复通道和唯一工作页，不重放旧请求；必须先读取页面。
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()
        self.assertEqual(session.reconcile()['text'], 'new page')
        self.assertEqual([method for method, _ in runtime.calls],
                         ['shared.get', 'shared.get', 'browser.list', 'shared.run'])

    def test_python_batch_uses_bound_task_tab_and_writes_checkpoint(self):
        runtime = RecordingRuntime([
            {'tabId': 71, 'url': 'https://example.test/start'},
            {'tabId': 71, 'url': 'https://example.test/page/2'},
            {'snapshotId': 'snap-2', 'binding': {'taskId': 'task-1', 'documentId': 'doc-2', 'leaseId': 'lease-2'},
             'items': [{'ref': 'r1', 'role': 'button', 'name': '下一页'}]},
            {'text': 'first\nsecond\nfirst'},
        ])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with tempfile.TemporaryDirectory() as folder:
            session.new_tab('https://example.test/start')
            receipt = session.goto_url('https://example.test/page/2')
            # 中文注释：导航摘要保留快照绑定和 ref，可直接组成后续引用动作参数。
            self.assertEqual(receipt['summary']['items'][0]['ref'], 'r1')
            self.assertEqual(receipt['summary']['binding']['documentId'], 'doc-2')
            rows = sorted(set(session.snapshot()['text'].splitlines()))
            path = pathlib.Path(folder) / 'checkpoint.txt'
            path.write_text('\n'.join(rows), encoding='utf-8')
            self.assertEqual(path.read_text(encoding='utf-8'), 'first\nsecond')
        self.assertEqual([call[1]['action'] for call in runtime.calls],
                         ['new_tab', 'navigate', 'semantic_snapshot', 'snapshot'])
        self.assertEqual([call[1].get('tabId') for call in runtime.calls], [None, 71, 71, 71])
        self.assertEqual(len({call[1]['requestId'] for call in runtime.calls}), 4)
        self.assertTrue(all(method == 'shared.run' and payload['owner'] == 'trusted-owner' and payload['taskId'] == 'task-1' for method, payload in runtime.calls))

    def test_approval_pauses_and_queries_same_request_before_next_action(self):
        runtime = RecordingRuntime([{'status': 'approval_required'}, {'tabId': 5}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.ApprovalRequired):
            session.new_tab('https://example.test/')
        with self.assertRaises(adapter.PendingAction):
            session.new_tab('https://example.test/other')
        self.assertEqual(session.resume_pending(), 5)
        self.assertEqual(runtime.calls[0], runtime.calls[1])
        self.assertEqual(session.tab_id, 5)

    def test_pending_receipt_with_foreign_id_freezes_without_retry(self):
        runtime = RecordingRuntime([{'status': 'approval_required', 'requestId': 'foreign'}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.new_tab('https://example.test/')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.resume_pending()
        self.assertEqual(len(runtime.calls), 1)

    def test_unknown_outcome_freezes_actions_without_replay(self):
        runtime = RecordingRuntime([TimeoutError('transport lost')])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.new_tab('https://example.test/')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.resume_pending()
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()
        self.assertEqual(len(runtime.calls), 1)

    def test_navigate_receipt_for_foreign_tab_freezes_session(self):
        runtime = RecordingRuntime([{'tabId': 71}, {'tabId': 99, 'url': 'https://example.test/elsewhere'}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/start')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.goto_url('https://example.test/elsewhere')
        self.assertEqual(session.tab_id, 71)
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()

    def test_official_page_info_preserves_real_helper_shape(self):
        expected = {'url': 'https://example.test/page', 'title': 'Synthetic',
                    'w': 1280, 'h': 720, 'sx': 0, 'sy': 12.5,
                    'pw': 1600, 'ph': 2400}
        runtime = RecordingRuntime([{'tabId': 71}, expected])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/page')
        self.assertEqual(session.official_page_info(), expected)
        call = runtime.calls[-1][1]
        self.assertEqual((call['action'], call['tabId']), ('official.page_info', 71))

    def test_official_fill_input_requires_real_key_events_and_preserves_arguments(self):
        receipt = {'found': True, 'delivery': 'cdp-key-events',
                   'inputEvent': True, 'changeEvent': True}
        runtime = RecordingRuntime([{'tabId': 71}, receipt])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/page')
        self.assertEqual(session.official_fill_input('#q', 'hello', clear_first=False, timeout=2.5), receipt)
        call = runtime.calls[-1][1]
        self.assertEqual({key: call[key] for key in ('action', 'tabId', 'selector', 'text', 'clearFirst', 'timeout')},
                         {'action': 'official.fill_input', 'tabId': 71, 'selector': '#q',
                          'text': 'hello', 'clearFirst': False, 'timeout': 2.5})

    def test_official_fill_input_does_not_accept_dom_setter_receipt(self):
        runtime = RecordingRuntime([{'tabId': 71}, {'found': True, 'delivery': 'dom-synthetic',
                                                     'inputEvent': True, 'changeEvent': True}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/page')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.official_fill_input('#q', 'hello')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.snapshot()
        self.assertEqual(len(runtime.calls), 2)

    def test_no_bound_tab_rejects_navigation_before_backend(self):
        runtime = RecordingRuntime([])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.NoBoundTab):
            session.goto_url('https://example.test/')
        self.assertEqual(runtime.calls, [])

    def test_bad_new_tab_receipt_never_binds_tab(self):
        runtime = RecordingRuntime([{'tabId': True}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.new_tab('https://example.test/')
        self.assertIsNone(session.tab_id)

    def test_screenshot_returns_real_png_data_without_cdp_translation(self):
        runtime = RecordingRuntime([{'tabId': 71}, {'data': 'iVBORw0KGgo='}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/')
        self.assertEqual(session.screenshot(), 'iVBORw0KGgo=')
        self.assertEqual(runtime.calls[-1][1]['action'], 'screenshot')
        self.assertEqual(runtime.calls[-1][1]['tabId'], 71)

    def test_invalid_screenshot_receipt_freezes_instead_of_writing_file(self):
        runtime = RecordingRuntime([{'tabId': 71}, {'path': '/tmp/decoy.png'}])
        session = adapter.ActionSession(runtime, owner='trusted-owner', task_id='task-1')
        session.new_tab('https://example.test/')
        with self.assertRaises(adapter.OutcomeUnknown):
            session.screenshot()
        self.assertEqual(len(runtime.calls), 2)

    def test_identity_and_target_are_mandatory(self):
        for kwargs in ({'owner': '', 'task_id': 'task'}, {'owner': 'owner', 'task_id': ''}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                adapter.ActionSession(RecordingRuntime([]), **kwargs)


class PopupPendingIntegrationTest(unittest.TestCase):
    """ActionSession -> daemon -> production Bridge/Executor; Chrome boundary synthetic."""

    def setUp(self):
        root = MODULE.parents[2]
        peer_spec = importlib.util.spec_from_file_location(
            'script_popup_peer_fixture', root / 'tests/native-v2/test_oauth_popup_executor.py')
        assert peer_spec is not None and peer_spec.loader is not None
        peer_module = importlib.util.module_from_spec(peer_spec)
        peer_spec.loader.exec_module(peer_module)
        self.fixture = peer_module.DaemonPopupPeerTests(methodName='runTest')
        # 中文注释：原 fixture 只模拟授权；补充 Chrome/CDP 的只读页面响应，不改生产逻辑。
        import subprocess
        peer_path = root / 'tests/v1.1-concurrency/bridge_executor_peer.mjs'
        source = peer_path.read_text()
        source = source.replace("if(method==='Runtime.callFunctionOn')return {result:{value:true}};", """
        if(method==='Runtime.evaluate')return {result:{value:'complete'}};
        if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='semantic_snapshot')
          return {result:{value:{version:1,binding:params.arguments[1].value.binding,
            snapshotId:'popup-doc-2',kind:'full',items:[{ref:'r1',role:'heading',name:'Original popup'}],
            coverage:{complete:true}}}};
        if(method==='Runtime.callFunctionOn')return {result:{value:true}};
        """)
        source = source.replace("if (process.argv[2] === '--oauth-fixture')", 'if (true)')
        popen = subprocess.Popen
        with patch.object(subprocess, 'Popen', side_effect=lambda _args, **kwargs:
                          popen(['node', '--input-type=module', '-e', source],
                                cwd=peer_path.parent, **kwargs)):
            self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.runtime_calls = []
        # 中文注释：仅连接传输边界；所有决策、批准、账本与页面租约均走生产实现。
        def call(method, params):
            self.runtime_calls.append((method, dict(params)))
            return self.fixture.daemon._dispatch_client(method, params)
        self.session = adapter.ActionSession(type('Runtime', (), {'call': staticmethod(call)})(),
                                             owner='owner', task_id='task')
        self.session.install_scope('instance', 1)
        self.session.tab_id = 1

    def pending_adoption(self):
        candidate = self.session.run('popup_catalog', {})['candidates'][0]
        with self.assertRaises(adapter.ApprovalRequired):
            self.session.run('popup_adopt', {'candidateRef': candidate['candidateRef']})
        pending = next(iter(self.fixture.daemon.action_approvals.values()))
        return candidate, pending

    def approve(self, pending):
        pending['status'] = 'approved'
        grant = {key: pending[key] for key in
                 ('nonce', 'digest', 'expiresAt', 'generation', 'modeGeneration', 'popupScope')}
        grant.update(taskId='task', request={key: value for key, value in pending['params'].items()
                                           if key != 'owner'})
        self.fixture.rpc(op='grant', approval=grant)
        self.fixture.daemon._approval_worker(('task', self.fixture.module._sha256(
            pending['params']['requestId'])), pending)

    def test_popup_wait_queries_only_while_approval_is_pending(self):
        self.pending_adoption()
        before = len(self.fixture.calls)
        for _ in range(2):
            with self.assertRaises(adapter.ApprovalRequired):
                self.session.resume_pending()
        self.assertEqual(len(self.fixture.calls), before)
        self.assertEqual([method for method, _ in self.runtime_calls[-4:]],
                         ['shared.operation_status', 'shared.get'] * 2)

    def test_denial_and_expiry_return_no_success_without_replaying(self):
        for decision in ('denied', 'expired'):
            with self.subTest(decision=decision):
                _, pending = self.pending_adoption()
                if decision == 'denied':
                    self.fixture.daemon._dispatch_extension('instance', 'extension.decide', {
                        'taskId': 'task', 'nonce': pending['nonce'], 'digest': pending['digest'], 'approve': False})
                else:
                    pending['expiresAt'] = 0
                    self.fixture.daemon._expire_approvals_locked()
                before = len(self.fixture.calls)
                with self.assertRaises(adapter.ActionRejected):
                    self.session.resume_pending()
                self.assertEqual(len(self.fixture.calls), before)
                self.assertIsNone(self.session._pending)
                self.assertNotIn(2, self.fixture.task['tabIds'])

    def test_unknown_adoption_stays_fenced_without_replay(self):
        _, pending = self.pending_adoption()
        self.fixture.rpc(op='settings', enabled=False, toggleAtSend=True)
        self.approve(pending)
        before = len(self.fixture.calls)
        with self.assertRaises(adapter.OutcomeUnknown):
            self.session.resume_pending()
        with self.assertRaises(adapter.OutcomeUnknown):
            self.session.resume_pending()
        with self.assertRaises(adapter.OutcomeUnknown):
            self.session.run('semantic_snapshot', {})
        self.assertEqual(len(self.fixture.calls), before)
        self.assertFalse(self.session.completion()['execution_complete'])
        self.assertEqual(self.fixture.rpc(op='state')['removed'], [])

    def test_confirmed_old_adoption_cannot_survive_scope_changes(self):
        changes = ('generation', 'modeGeneration', 'cancelled', 'target_closed', 'origin_revoked')
        for change in changes:
            with self.subTest(change=change):
                case = PopupPendingIntegrationTest(methodName='runTest')
                case.setUp()
                try:
                    _, pending = case.pending_adoption()
                    case.approve(pending)
                    if change in ('generation', 'modeGeneration'):
                        case.fixture.task[change] += 1
                    elif change == 'cancelled':
                        case.fixture.daemon._revoke_task_locked(case.fixture.task, 'cancelled')
                    elif change == 'target_closed':
                        case.fixture.daemon._handle_tab_event('instance', {
                            'taskId': 'task', 'generation': 1, 'tabId': 2,
                            'event': 'closed', 'documentGeneration': 0})
                    else:
                        case.fixture.task['allowedOrigins'] = ['https://example.com']
                    before = len(case.fixture.calls)
                    with self.assertRaises(adapter.ActionRejected):
                        case.session.resume_pending()
                    self.assertEqual(len(case.fixture.calls), before)
                finally:
                    case.doCleanups()

    def test_real_script_wait_pending_reads_original_popup_through_public_projection(self):
        import json
        root = MODULE.parents[2]
        native_runtime = self.fixture.module.native_runtime if hasattr(self.fixture.module, 'native_runtime') else __import__('native_runtime')
        host = native_runtime.load_module(root / 'executor-plugin/script_lane/host_bridge.py', 'popup_script_host_')
        tool = native_runtime.load_module(root / 'executor-plugin/script_lane/tool.py', 'popup_script_tool_')
        projection = native_runtime.load_module(root / 'executor-plugin/runtime.py', 'popup_script_projection_')
        authority = native_runtime.NativeOwnerAuthority(pathlib.Path(self.fixture.temp.name) / 'authority')
        authority.lease_tools((tool.TOOL_NAME,))
        owner = authority.owner_for_session('popup-script')
        self.fixture.task['owner'] = owner
        self.fixture.task['workTabs'] = [{'tabId': 1}]
        original = self.session._runtime.call
        def call(method, params):
            if method == 'browser.list':
                return [{'instanceId': 'instance', 'connected': True}]
            result = original(method, params)
            if method == 'shared.run' and params['action'] == 'popup_adopt':
                pending = next(iter(self.fixture.daemon.action_approvals.values()))
                self.approve(pending)
            if method in ('shared.get', 'shared.run'):
                result = projection._project_tool_result('browser_shared_get' if method == 'shared.get'
                    else 'browser_shared_run', params, result)
            return result
        runtime = type('Runtime', (), {'call': staticmethod(call), 'authority': authority})()
        bridge = host.HostBridge(runtime, root / 'executor-plugin')
        self.addCleanup(bridge.close)
        bridge.bind('popup-script', owner=owner, task_id='task', tab_id=1)
        handler = tool.make_handler(bridge, authority, pathlib.Path(self.fixture.temp.name),
                                   lease_error=native_runtime.OwnerLeaseError, bridge_denied=host.BridgeDenied)
        code = ("candidate=popup_catalog(tab=1)['candidates'][0]\n"
                "try:\n popup_adopt(candidate['candidateRef'], tab=1)\n"
                "except ApprovalRequired:\n result=wait_pending(timeout_s=2, tab=1)\n"
                "print(result['state'], 'adopted' in result, current_tab())\n"
                "use_tab(candidate['tabId'])\n"
                "page=read_page(mode='interactive')\n"
                "print(current_tab(), len(page['items']), page['items'][0]['name'])\n")
        args = {'code': code, 'timeout_s': 10}
        hook = authority.pre_tool_call(tool.TOOL_NAME, args, session_id='popup-script', tool_call_id='popup-call')
        self.assertEqual(hook['action'], 'modify')
        result = json.loads(handler({**args, **hook['args']}, session_id='popup-script'))
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stdout'].strip().splitlines(), ['confirmed False 1', '2 1 Original popup'])
        self.assertTrue(result['execution_complete'], result)
        self.assertFalse(result['outcome_unknown'], result)
        self.assertEqual(len([p for method, p in self.runtime_calls
                              if method == 'shared.run' and p['action'] == 'popup_adopt']), 1)

    def test_popup_wait_queries_ledger_not_one_shot_adoption_then_reads_original_window(self):
        candidate, pending = self.pending_adoption()
        self.approve(pending)
        before = len(self.fixture.calls)
        result = self.session.resume_pending()
        self.assertEqual(result['state'], 'confirmed')
        self.assertNotIn('adopted', result, 'ledger confirmation is not a new adoption receipt')
        self.assertNotIn('tabId', result)
        self.assertEqual(len(self.fixture.calls), before, 'waiting must not execute or prepare adoption')
        self.assertEqual(self.session.current_tab(), 1)
        self.assertEqual(self.session.use_tab(candidate['tabId']), 2)
        page = self.session.run('semantic_snapshot', {})
        self.assertEqual(len(page['items']), 1)
        self.assertEqual(page['items'][0]['name'], 'Original popup')
        self.assertEqual(page['binding']['taskId'], 'task')
        self.assertEqual(self.fixture.calls[-1]['params']['tabId'], candidate['tabId'])
        self.assertEqual(self.fixture.rpc(op='state')['removed'], [])
        adoption_runs = [p for method, p in self.runtime_calls
                         if method == 'shared.run' and p['action'] == 'popup_adopt']
        self.assertEqual(len(adoption_runs), 1)


if __name__ == '__main__':
    unittest.main()
