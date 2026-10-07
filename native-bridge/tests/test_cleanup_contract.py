"""Cleanup is independent of task execution state and requires positive readback."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon import BridgeDaemon, ProtocolError, _encode_line


class CleanupContractTests(unittest.TestCase):
    def test_partial_delivery_result_is_logged_unknown_with_code(self):
        import hashlib
        row = self.daemon.tasks[self.task['id']]
        row['currentOperation'] = {'action': 'ref_click', 'state': 'running', 'startedAt': 1,
            'requestIdHash': hashlib.sha256(b'partial').hexdigest()}
        self.daemon._run_task_impl = lambda *args: {'clicked': False, 'delivery': 'partial', 'outcomeUnknown': True}
        self.daemon._run_task({**self.params, 'requestId': 'partial', 'action': 'ref_click'})
        record = json.loads(self.daemon._task_log_path(row['id']).read_text())
        self.assertEqual(record['result'], 'unknown'); self.assertEqual(record['errorCode'], 'operation_outcome_unknown')
        request_hash = hashlib.sha256(b'partial-ledger').hexdigest()
        self.daemon._record_request_locked(row, request_hash, 'a' * 64,
            {'outcomeUnknown': True, 'delivery': 'partial'}, 'result')
        self.assertEqual(self.daemon._operation_status({**self.params, 'requestId': 'partial-ledger'})['state'], 'unknown')
        self.assertEqual(self.daemon.dedupe[row['id']][request_hash][1], 'result')
        request_hash = hashlib.sha256(b'unknown-error-ledger').hexdigest()
        self.daemon._record_request_locked(row, request_hash, 'b' * 64,
            {'code': 'extension_timeout', 'data': {'outcomeUnknown': True}}, 'error')
        self.assertEqual(self.daemon._operation_status({**self.params, 'requestId': 'unknown-error-ledger'})['state'], 'unknown')

    def test_explicit_handoff_reason_is_required_and_public(self):
        self.daemon.tasks[self.task['id']]['state'] = 'ready'
        for reason in (None, 'blocked'):
            args = {**self.params, 'keepTabs': True}
            if reason is not None:
                args['handoffReason'] = reason
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._dispatch_client('shared.handoff', args)
            self.assertEqual(caught.exception.code, 'invalid_fields')
            self.assertEqual(self.daemon.tasks[self.task['id']]['state'], 'ready')
        self.daemon._extension_call = lambda *a, **kw: {'released': True, 'cleanupState': 'succeeded', 'remainingTabIds': [], 'preservedTabIds': [], 'unknownTabIds': []}
        result = self.daemon._dispatch_client('shared.handoff', {**self.params, 'keepTabs': True, 'handoffReason': 'captcha'})
        self.assertEqual(result['handoffReason'], 'captcha')
        self.assertEqual(result['cleanupReason'], 'handed_to_user')

    def test_failed_operation_log_never_loses_error_code(self):
        self.daemon._append_task_log(self.task['id'], {'action': 'ref_click', 'state': 'unknown', 'startedAt': 1})
        row = json.loads(self.daemon._task_log_path(self.task['id']).read_text())
        self.assertEqual(row['errorCode'], 'operation_outcome_unknown')
    def setUp(self):
        scratch = Path(tempfile.gettempdir())
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        # 中文注释：先完成异步快照，再清理临时目录，避免计时器写入已删除路径。
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon._notify_tasks_changed = lambda _: None
        self.extension = {'browser': 'chrome'}
        self.daemon.extensions['browser'] = self.extension
        self.task = self.daemon._dispatch_client('shared.create', {
            'owner': 'owner', 'title': 'cleanup', 'instanceId': 'browser',
            'allowedOrigins': ['https://example.test']})
        self.params = {'owner': 'owner', 'taskId': self.task['id']}

    def test_overlay_cleanup_lists_closed_tasks_only_for_the_trusted_instance(self):
        # 中文注释：扩展清理读取本实例终态，默认列表不增加已关闭任务，也不返回别的实例。
        row = self.daemon.tasks[self.task['id']]
        row['state'] = 'closed'
        self.daemon.tasks['foreign'] = {**row, 'id': 'foreign', 'instanceId': 'other'}
        self.assertEqual(self.daemon._dispatch_extension('browser', 'extension.tasks', {}), [])
        listed = self.daemon._dispatch_extension('browser', 'extension.tasks', {'includeClosed': True})
        self.assertEqual([task['id'] for task in listed], [self.task['id']])
        self.assertEqual(listed[0]['state'], 'closed')

    def test_overlay_cleanup_option_rejects_non_boolean_and_extra_fields(self):
        # 中文注释：只有明确的布尔开关合法，不能把任意清理参数带入扩展任务读取。
        for params in ({'includeClosed': 1}, {'includeClosed': False}, {'includeClosed': True, 'instanceId': 'other'}):
            with self.assertRaises(ProtocolError):
                self.daemon._dispatch_extension('browser', 'extension.tasks', params)

    def test_overlay_cleanup_history_fits_transport_without_changing_records(self):
        # 中文注释：历史操作详情会超过单帧上限，清理只需身份、状态、代次与标签证据。
        row = self.daemon.tasks[self.task['id']]
        row['state'] = 'needs_sync'
        row['tabIds'] = [7]
        row['currentOperation'] = {'action': 'snapshot', 'state': 'succeeded', 'startedAt': 1}
        row['operationTimeline'] = [dict(row['currentOperation'], completedAt=2, durationMs=1000)] * 32
        for index in range(500):
            self.daemon.tasks[f'history-{index}'] = {**row, 'id': f'history-{index}', 'state': 'closed'}
        self.daemon.tasks['foreign'] = {**row, 'id': 'foreign', 'instanceId': 'other'}
        baseline = copy.deepcopy(self.daemon.tasks)
        full = [self.daemon._public_task(t) for t in baseline.values() if t['instanceId'] == 'browser']
        self.assertGreater(len(json.dumps({'id': 'history', 'result': full}).encode()), 1024 * 1024)
        with self.assertRaises(ValueError):
            _encode_line({'id': 'history', 'result': full})
        listed = self.daemon._dispatch_extension('browser', 'extension.tasks', {'includeClosed': True})
        self.assertEqual(len(listed), 501)
        self.assertLess(len(_encode_line({'id': 'history', 'result': listed})), 128 * 1024)
        self.assertEqual(listed[0], {key: row[key] for key in ('id', 'instanceId', 'generation', 'state', 'tabIds')})
        self.assertTrue(all(set(t) == {'id', 'instanceId', 'generation', 'state', 'tabIds'} for t in listed))
        self.assertEqual(self.daemon.tasks, baseline)
        active = self.daemon._dispatch_extension('browser', 'extension.tasks', {})
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]['operationTimeline'], row['operationTimeline'])
        self.assertEqual(active[0]['title'], row['title'])

    def test_handoff_preserves_work_page_and_revokes_lease(self):
        # 中文注释：用户接管时自动结束保留页面，但任务权限立即失效。
        self.daemon.tasks[self.task['id']]['state'] = 'paused'
        self.daemon.tasks[self.task['id']]['tabIds'] = [73]
        self.daemon.tab_leases[('browser', 73)] = self.task['id']
        calls = []
        def release(ext, method, params, **kwargs):
            calls.append(params)
            self.assertFalse(params['closeAgentTabs'])
            return {'released': True, 'cleanupState': 'succeeded', 'remainingTabIds': [],
                    'preservedTabIds': [73], 'unknownTabIds': [], 'cleanupReason': 'preserved'}
        self.daemon._extension_call = release
        result = self.daemon._dispatch_client('shared.handoff', self.params)
        self.assertEqual(result['state'], 'closed')
        self.assertEqual(result['cleanupReason'], 'handed_to_user')
        self.assertNotIn(('browser', 73), self.daemon.tab_leases)
        self.assertEqual(len(calls), 1)
        with self.assertRaises(ProtocolError) as denied:
            self.daemon._dispatch_client('shared.run', {**self.params, 'requestId': 'after-handoff',
                                                        'action': 'snapshot', 'tabId': 73})
        self.assertEqual(denied.exception.code, 'task_closed')

    def test_pending_input_handoff_and_ordinary_close(self):
        self.daemon.tasks[self.task['id']]['state'] = 'ready'
        self.daemon.action_approvals[(self.task['id'], 'request')] = {
            'generation': self.task['generation'], 'status': 'user_input_required',
            'expiresAt': __import__('time').time() + 30, 'digest': 'd', 'params': {}}
        calls = []
        self.daemon._extension_call = lambda ext, method, params, **kwargs: (
            calls.append(params) or {'released': True, 'cleanupState': 'succeeded',
            'remainingTabIds': [], 'preservedTabIds': [], 'unknownTabIds': [], 'cleanupReason': 'preserved'})
        self.assertEqual(self.daemon._dispatch_client('shared.handoff', self.params)['state'], 'closed')
        self.assertFalse(calls[0]['closeAgentTabs'])
        ordinary = self.daemon._dispatch_client('shared.create', {
            'owner': 'owner', 'title': 'ordinary', 'instanceId': 'browser',
            'allowedOrigins': ['https://example.test']})
        self.daemon._dispatch_client('shared.handoff', {'owner': 'owner', 'taskId': ordinary['id']})
        self.assertTrue(calls[1]['closeAgentTabs'])

    def test_explicit_keep_tabs_handoff_for_ready_task(self):
        # 中文注释：验证码等页面没有挂起请求，模型显式 keepTabs 时同样保留页面并撤权。
        self.daemon.tasks[self.task['id']]['state'] = 'ready'
        calls = []
        self.daemon._extension_call = lambda ext, method, params, **kwargs: (
            calls.append(params) or {'released': True, 'cleanupState': 'succeeded',
            'remainingTabIds': [], 'preservedTabIds': [], 'unknownTabIds': [], 'cleanupReason': 'preserved'})
        result = self.daemon._dispatch_client('shared.handoff', {**self.params, 'keepTabs': True, 'handoffReason': 'user_requested'})
        self.assertEqual(result['state'], 'closed')
        self.assertEqual(result['cleanupReason'], 'handed_to_user')
        self.assertFalse(calls[0]['closeAgentTabs'])

    def test_timeout_fences_and_persists_unknown_without_replaying_close(self):
        calls = []
        def release(ext, method, params, **kwargs):
            calls.append(method)
            self.assertEqual(self.daemon.tasks[self.task['id']]['state'], 'closed')
            self.assertEqual(self.daemon.tasks[self.task['id']]['cleanupState'], 'pending')
            raise ProtocolError('extension_timeout', 'private page data')
        self.daemon._extension_call = release
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['state'], 'closed')
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupReason'], 'extension_timeout')
        self.assertEqual(result['cleanupError']['code'], 'extension_timeout')
        self.assertNotIn('private page data', str(result))
        self.assertEqual(self.daemon._dispatch_client('shared.close', self.params)['cleanupState'], 'unknown')
        self.assertEqual(calls, ['browser.release'])
        restored = BridgeDaemon(Path(self.temp.name))
        restored._load_tasks()
        self.assertEqual(restored._dispatch_client('shared.get', self.params)['cleanupState'], 'unknown')

    def test_unstructured_release_cannot_claim_success_and_offline_is_unknown(self):
        self.daemon._extension_call = lambda *args, **kwargs: {'released': True}
        result = self.daemon._dispatch_client('shared.cancel', self.params)
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupReason'], 'invalid_response')
        self.assertEqual(self.daemon._dispatch_client('shared.cancel', self.params)['cleanupState'], 'unknown')
        other = self.daemon._dispatch_client('shared.create', {
            'owner': 'owner', 'title': 'offline', 'instanceId': 'browser',
            'allowedOrigins': ['https://example.test']})
        self.daemon.extensions.clear()
        offline = self.daemon._dispatch_client('shared.close', {'owner': 'owner', 'taskId': other['id']})
        self.assertEqual(offline['cleanupState'], 'unknown')
        self.assertEqual(offline['cleanupReason'], 'browser_offline')

    def test_child_safe_no_journal_reason_is_public_but_arbitrary_text_is_not(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': True, 'cleanupState': 'unknown', 'remainingTabIds': [],
            'unknownTabIds': [], 'preservedTabIds': [], 'cleanupReason': 'no_journal'}
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupReason'], 'no_journal')

    def test_claimed_success_without_inventory_is_unverified(self):
        self.daemon._extension_call = lambda *args, **kwargs: {'released': True, 'cleanupState': 'succeeded'}
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupReason'], 'invalid_response')

    def test_release_must_acknowledge_fence_before_claiming_cleanup_success(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': False, 'cleanupState': 'succeeded', 'remainingTabIds': [],
            'preservedTabIds': [], 'unknownTabIds': []}
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupReason'], 'invalid_response')

    def test_extension_stop_without_cleanup_readback_is_unknown(self):
        stopped = self.daemon._dispatch_extension('browser', 'extension.stop', {
            'taskId': self.task['id'], 'generation': 1})
        self.assertEqual(stopped['state'], 'cancelled')
        self.assertEqual(stopped['cleanupState'], 'unknown')
        self.assertEqual(stopped['cleanupReason'], 'extension_unreported')

    def test_extension_stop_records_verified_local_cleanup(self):
        # 中文注释：停止入口随请求传入扩展清理回执，不能因读取循环限制丢掉完成状态。
        stopped = self.daemon._dispatch_extension('browser', 'extension.stop', {
            'taskId': self.task['id'], 'generation': 1,
            'cleanup': {'released': True, 'cleanupState': 'succeeded',
                        'cleanupReason': 'verified_complete', 'remainingTabIds': [],
                        'preservedTabIds': [], 'unknownTabIds': []}})
        self.assertEqual(stopped['state'], 'cancelled')
        self.assertEqual(stopped['cleanupState'], 'succeeded')
        self.assertEqual(stopped['cleanupReason'], 'verified_complete')

    def test_reconcile_must_precede_retry_and_retry_only_verified_owned_live_tabs(self):
        calls = []
        def rpc(ext, method, params, **kwargs):
            calls.append((method, params))
            if method == 'browser.release':
                return {'released': True, 'cleanupState': 'unknown', 'unknownTabIds': [78]}
            if method == 'browser.cleanup_status':
                return {'cleanupState': 'pending', 'remainingTabIds': [73], 'preservedTabIds': [74], 'unknownTabIds': [78]}
            if method == 'browser.cleanup_retry':
                self.assertEqual(params['tabIds'], [73])
                return {'cleanupState': 'succeeded', 'remainingTabIds': [], 'preservedTabIds': [74], 'unknownTabIds': []}
            self.fail(method)
        self.daemon._extension_call = rpc
        self.daemon._dispatch_client('shared.close', self.params)
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client('shared.cleanup_retry', self.params)
        self.assertEqual(caught.exception.code, 'reconcile_required')
        status = self.daemon._dispatch_client('shared.cleanup_status', self.params)
        self.assertEqual(status['cleanupState'], 'pending')
        self.assertEqual(status['cleanupRemainingCount'], 1)
        self.assertEqual(status['cleanupPreservedCount'], 1)
        self.assertEqual(status['cleanupUnknownCount'], 1)
        self.assertEqual(self.daemon._dispatch_client('shared.cleanup_retry', self.params)['cleanupState'], 'succeeded')
        self.assertEqual([method for method, _ in calls], ['browser.release', 'browser.cleanup_status', 'browser.cleanup_retry'])
        self.assertEqual(self.daemon._dispatch_client('shared.close', self.params)['cleanupState'], 'succeeded')

    def test_foreign_owner_cannot_observe_status_or_retry(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': True, 'cleanupState': 'unknown', 'remainingTabIds': [],
            'preservedTabIds': [], 'unknownTabIds': []}
        self.daemon._dispatch_client('shared.close', self.params)
        for method in ('shared.cleanup_status', 'shared.cleanup_retry'):
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._dispatch_client(method, dict(self.params, owner='intruder'))
            self.assertEqual(caught.exception.code, 'forbidden')

    def test_release_pending_response_alone_never_authorizes_retry(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': True, 'cleanupState': 'pending', 'remainingTabIds': [73],
            'preservedTabIds': [], 'unknownTabIds': []}
        self.assertEqual(self.daemon._dispatch_client('shared.close', self.params)['cleanupState'], 'pending')
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client('shared.cleanup_retry', self.params)
        self.assertEqual(caught.exception.code, 'reconcile_required')

    def test_reconcile_does_not_authorize_after_generation_change(self):
        self.daemon._extension_call = lambda *args, **kwargs: {'released': True, 'cleanupState': 'unknown'}
        self.daemon._dispatch_client('shared.cancel', self.params)
        def status(ext, method, params, **kwargs):
            self.daemon._dispatch_client('shared.resume', self.params)
            return {'cleanupState': 'pending', 'remainingTabIds': [73]}
        self.daemon._extension_call = status
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client('shared.cleanup_status', self.params)
        self.assertEqual(caught.exception.code, 'stale_generation')
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('shared.cleanup_retry', self.params)
        self.assertEqual(self.daemon._dispatch_client('shared.get', self.params)['state'], 'pending_approval')

    def test_invalid_tab_ids_never_create_retry_proof(self):
        self.daemon._extension_call = lambda *args, **kwargs: {'released': True, 'cleanupState': 'unknown'}
        self.daemon._dispatch_client('shared.close', self.params)
        self.daemon._extension_call = lambda *args, **kwargs: {'cleanupState': 'pending', 'remainingTabIds': [True]}
        status = self.daemon._dispatch_client('shared.cleanup_status', self.params)
        self.assertEqual(status['cleanupState'], 'unknown')
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('shared.cleanup_retry', self.params)

    def test_malformed_extension_reason_never_crashes_or_leaks(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': True, 'cleanupState': 'succeeded', 'remainingTabIds': [],
            'preservedTabIds': [], 'unknownTabIds': [], 'cleanupReason': {'page': 'secret'}}
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupState'], 'succeeded')
        self.assertNotIn('cleanupReason', result)

    def test_release_failure_keeps_safe_typed_extension_error(self):
        def failure(*args, **kwargs):
            raise ProtocolError('workspace_unknown', 'secret page text', {'outcomeUnknown': True, 'retryable': False})
        self.daemon._extension_call = failure
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupError'], {'code': 'workspace_unknown'})
        self.assertNotIn('secret page text', str(result))

    def test_release_transport_error_is_typed_without_leaking_exception_text(self):
        def failure(*args, **kwargs):
            raise OSError('socket and secret path')
        self.daemon._extension_call = failure
        result = self.daemon._dispatch_client('shared.close', self.params)
        self.assertEqual(result['cleanupState'], 'unknown')
        self.assertEqual(result['cleanupError'], {'code': 'transport_error'})
        self.assertNotIn('secret path', str(result))

    def test_reconcile_cannot_turn_stale_browser_into_retry_proof(self):
        self.daemon._extension_call = lambda *args, **kwargs: {
            'released': True, 'cleanupState': 'unknown', 'unknownTabIds': [5]}
        self.daemon._dispatch_client('shared.close', self.params)
        def status(extension, method, params, **kwargs):
            self.daemon.extensions['browser'] = {'browser': 'chrome'}
            return {'cleanupState': 'pending', 'remainingTabIds': [5], 'preservedTabIds': [], 'unknownTabIds': []}
        self.daemon._extension_call = status
        self.assertEqual(self.daemon._dispatch_client('shared.cleanup_status', self.params)['cleanupState'], 'unknown')
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('shared.cleanup_retry', self.params)

    def test_extension_typed_read_error_preserves_only_safe_metadata(self):
        def rpc(*args, **kwargs):
            raise ProtocolError('page_not_ready', 'sensitive extension text',
                                {'outcomeUnknown': False, 'retryable': True, 'secret': 'do not expose'})
        self.daemon._extension_call = rpc
        self.daemon.tasks[self.task['id']].update(state='ready', tabIds=[1])
        self.daemon.tab_leases[('browser', 1)] = self.task['id']
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client('shared.run', dict(self.params, action='snapshot', tabId=1, requestId='read'))
        self.assertEqual(caught.exception.data, {'outcomeUnknown': False, 'retryable': True})

    def test_read_timeout_is_classified_without_revoking_task_or_replaying_request(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='ready', tabIds=[1])
        # 中文注释：本用例只测已授权读取超时；首次网站批准由独立回归覆盖。
        task['activeMode'] = 'full'
        self.daemon.tab_leases[('browser', 1)] = task['id']
        calls = []
        def timeout(extension, method, params, **kwargs):
            calls.append(method)
            if method == 'browser.execute':
                raise ProtocolError('extension_timeout', 'read timed out')
            return {'released': True}
        self.daemon._extension_call = timeout
        params = dict(self.params, action='snapshot', tabId=1, requestId='read-timeout')
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client('shared.run', params)
        self.assertFalse(caught.exception.data['outcomeUnknown'])
        # 中文注释：现有只读超时保持任务 ready；同请求 ID 仍不能重派发，不能把旧断言误当本次自动收组回归。
        self.assertFalse(caught.exception.data['retryable'], 'same request must not be redispatched')
        self.assertEqual(task['state'], 'ready', 'read timeout preserves task authority')
        with self.assertRaises(ProtocolError) as replay:
            self.daemon._dispatch_client('shared.run', params)
        self.assertEqual(replay.exception.code, 'extension_timeout')
        self.assertEqual(calls, ['browser.execute'],
                         'same request id queries recorded outcome, never redispatches')

    def test_created_popup_from_leased_user_tab_is_cleanup_only_lineage(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='ready', tabIds=[4], agentTabIds=[])
        self.daemon.tab_leases[('browser', 4)] = task['id']
        self.daemon._dispatch_extension('browser', 'extension.tab_event', {
            'taskId': task['id'], 'generation': task['generation'],
            'tabId': 8, 'openerTabId': 4, 'event': 'created'})
        self.assertEqual(task['agentTabIds'], [8])
        self.assertEqual(task['tabIds'], [4])
        self.assertNotIn(('browser', 8), self.daemon.tab_leases)

    def test_leaving_approved_site_keeps_task_lease_and_group(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='ready', tabIds=[4])
        self.daemon.tab_leases[('browser', 4)] = task['id']
        base = {'taskId': task['id'], 'generation': task['generation'], 'tabId': 4, 'event': 'navigated', 'documentGeneration': 3}
        self.daemon._dispatch_extension('browser', 'extension.tab_event', dict(base, outOfScope=True))
        self.assertEqual(task['state'], 'ready', 'switching the work tab to another site must not revoke the task')
        self.assertEqual(task['tabIds'], [4])
        self.assertEqual(self.daemon.tab_leases[('browser', 4)], task['id'])
        self.assertEqual(task['outOfScopeTabIds'], [4])
        self.daemon._dispatch_extension('browser', 'extension.tab_event', dict(base, documentGeneration=4, url='https://example.test/back'))
        self.assertEqual(task['outOfScopeTabIds'], [])
        # An unapproved URL reported directly is still a hard scope violation.
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension('browser', 'extension.tab_event', dict(base, documentGeneration=5, url='https://evil.test/'))
        self.assertEqual(task['state'], 'needs_sync')

    def test_created_popup_tracks_only_matching_generation_and_owned_opener(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='ready', tabIds=[4], agentTabIds=[4])
        self.daemon.tab_leases[('browser', 4)] = self.task['id']
        event = {'taskId': task['id'], 'generation': task['generation'],
                 'tabId': 8, 'openerTabId': 4, 'event': 'created'}
        created = self.daemon._dispatch_extension('browser', 'extension.tab_event', event)
        self.assertIn(8, task['agentTabIds'])
        self.assertNotIn(8, task['tabIds'], 'popup ownership alone must not grant action lease or origin scope')
        self.assertNotIn(8, created['tabIds'])
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension('browser', 'extension.tab_event', dict(event, tabId=9, generation=2))
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension('browser', 'extension.tab_event', dict(event, tabId=10, openerTabId=99))
        self.assertEqual(task['agentTabIds'], [4, 8])

    def test_late_non_new_tab_write_invalidates_successful_cleanup_claim(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='ready', activeMode='full', tabIds=[4])
        self.daemon.tab_leases[('browser', 4)] = task['id']
        def rpc(extension, method, params, **kwargs):
            self.daemon._revoke_task_locked(task, 'closed')
            task.update(cleanupState='succeeded', cleanupRemainingCount=0)
            return {'clicked': True}
        self.daemon._extension_call = rpc
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('shared.run', dict(self.params, action='click', tabId=4,
                selector='#link', requestId='late-click'))
        self.assertEqual(task['cleanupState'], 'unknown')
        self.assertEqual(task['cleanupReason'], 'late_result')


if __name__ == '__main__':
    unittest.main()

# 中文注释：重连补偿仅使用 daemon 的终态记录，不能将收组结果升级成删页证明。
class TerminalUngroupTests(unittest.TestCase):
    setUp = CleanupContractTests.setUp

    def test_reconnect_ungroups_only_terminal_unknown_and_persists_honest_result(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='closed', cleanupState='unknown', cleanupReason='no_journal',
                    workTabs=[{'tabId': 73, 'groupId': 20, 'windowId': 7}])
        calls = []
        def ungroup(extension, method, params, **kwargs):
            calls.append((method, params))
            self.assertIs(extension, self.extension)
            return {'cleanupState': 'unknown', 'cleanupReason': 'ungrouped_unverified',
                    'remainingTabIds': [], 'unknownTabIds': [], 'preservedTabIds': [73]}
        self.daemon._extension_call = ungroup
        self.daemon._ungroup_terminal_tasks('browser', self.extension)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], 'browser.cleanup_retry')
        self.assertTrue(calls[0][1]['ungroupOnly'])
        self.assertEqual(calls[0][1]['workTabs'], task['workTabs'])
        self.assertEqual(task['cleanupState'], 'unknown')
        self.assertEqual(task['cleanupReason'], 'ungrouped_unverified')
        self.assertNotIn(task['id'], self.daemon.cleanup_proofs)
        # 中文注释：同一终态任务只尝试一次收组，之后的重连不再重复调用扩展。
        self.daemon._ungroup_terminal_tasks('browser', self.extension)
        self.assertEqual(len(calls), 1)
        self.assertTrue(task['ungroupAttempted'])
        task['state'] = 'needs_sync'
        task.pop('ungroupAttempted')
        self.daemon._ungroup_terminal_tasks('browser', self.extension)
        self.assertEqual(len(calls), 1)

    def test_stale_connection_or_resumed_generation_cannot_publish_cleanup(self):
        task = self.daemon.tasks[self.task['id']]
        task.update(state='cancelled', cleanupState='unknown',
                    workTabs=[{'tabId': 73, 'groupId': 20, 'windowId': 7}])
        self.daemon._extension_call = lambda *args, **kwargs: self.fail('stale connection dispatched')
        self.daemon._ungroup_terminal_tasks('browser', {})
        def resume(*args, **kwargs):
            task.update(generation=2, state='needs_sync')
            return {'cleanupState': 'unknown', 'cleanupReason': 'ungrouped_unverified'}
        self.daemon._extension_call = resume
        self.daemon._ungroup_terminal_tasks('browser', self.extension)
        self.assertEqual(task['state'], 'needs_sync')
        self.assertNotEqual(task.get('cleanupReason'), 'ungrouped_unverified')
