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


if __name__ == '__main__':
    unittest.main()
