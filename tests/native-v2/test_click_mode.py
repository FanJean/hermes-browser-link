"""Public click-mode route; synthetic extension only, no browser/install."""
import json
import unittest
import test_daemon_wire as daemon_tests
import test_wire_contract as wire_tests


class ClickModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        wire_tests.NativeV2WireTests.setUpClass.__func__(cls)

    invoke = wire_tests.NativeV2WireTests.invoke
    run_action = daemon_tests.NativeV2DaemonTests.run_action

    def setUp(self):
        wire_tests.NativeV2WireTests.setUp(self)
        daemon_tests.NativeV2DaemonTests.setUp(self)
        self.task['activeMode'] = 'full'

        self.response = {'tabId': 8, 'url': 'https://example.com/link', 'ready': True,
                         'windowId': 2, 'groupId': 3, 'clicked': False,
                         'openedVia': 'safe_link_navigation'}

        def extension_call(extension, method, params, timeout=15):
            self.calls.append((extension, method, params, timeout))
            return dict(self.response)
        self.daemon._extension_call = extension_call

        def call(method, params):
            # Owner comes from the real trusted pre-tool hook, not model args.
            self.task['owner'] = params['owner']
            return self.daemon._dispatch_client(method, params)
        self.client.call = call

    def args(self, action='click', **extra):
        fields = {'selector': '#link'} if action == 'click' else {
            'binding': {'taskId': 'task-v2', 'documentId': 'doc', 'leaseId': 'lease'},
            'snapshot_id': 'snap', 'ref': 'link'}
        return dict(task_id='task-v2', tab_id=7, request_id=action,
                    action=action, **fields, **extra)

    def test_public_explicit_link_mode_reaches_dispatcher_and_returns_truthful_result(self):
        for action in ('click', 'ref_click'):
            with self.subTest(action=action):
                result = self.invoke(self.args(action, clickMode='open_link_in_task_tab'))
                self.assertEqual(result, self.response)
                self.assertEqual(self.calls[-1][1], 'browser.execute')
                self.assertEqual(self.calls[-1][2]['clickMode'], 'open_link_in_task_tab')
                self.assertEqual(self.calls[-1][2]['generation'], 4)

    def test_safe_link_tab_is_registered_for_followup_actions(self):
        self.invoke(self.args(clickMode='open_link_in_task_tab'))
        self.assertIn(8, self.task['tabIds'])
        self.assertIn(8, self.task['agentTabIds'])
        self.assertEqual(self.daemon.tab_leases[('instance-v2', 8)], 'task-v2')
        self.response = {'text': 'opened link'}
        self.assertEqual(self.invoke(dict(task_id='task-v2', tab_id=8,
            action='snapshot', request_id='followup')), self.response)

    def test_real_bridge_client_jsonl_roundtrip_preserves_explicit_mode(self):
        import socket
        import threading
        client_module = wire_tests.load(daemon_tests.BRIDGE / 'client.py', 'click_mode_client')
        client = client_module.BridgeClient(self.tmp.name)
        local, remote = socket.socketpair()
        local.settimeout(2)
        remote.settimeout(2)
        client._socket = local
        client._reader = local.makefile('rb')
        self.addCleanup(client.close)
        self.addCleanup(remote.close)
        dispatch = self.client.call
        def serve():
            with remote.makefile('rb') as reader:
                message = json.loads(reader.readline())
                result = dispatch(message['method'], message['params'])
                remote.sendall((json.dumps({'id': message['id'], 'result': result}) + '\n').encode())
        worker = threading.Thread(target=serve)
        worker.start()
        self.client.call = client.call
        self.assertEqual(self.invoke(self.args(clickMode='open_link_in_task_tab')), self.response)
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.calls[-1][2]['clickMode'], 'open_link_in_task_tab')

    def test_mode_is_bound_to_approval_and_request_id_without_replay(self):
        self.task['activeMode'] = 'smart'
        args = self.args(clickMode='open_link_in_task_tab')
        pending = self.invoke(args)
        self.assertEqual(pending['status'], 'approval_required')
        approval = self.daemon._dispatch_extension('instance-v2', 'extension.approvals', {})[0]
        self.assertEqual(approval['request']['clickMode'], 'open_link_in_task_tab')
        self.assertEqual(self.invoke(args)['digest'], pending['digest'])
        changed = dict(args)
        del changed['clickMode']
        self.assertEqual(self.invoke(changed)['bridgeCode'], 'request_id_conflict')
        self.assertEqual(self.calls, [])

    def test_success_is_cached_and_popup_metadata_alone_does_not_grant_ownership(self):
        args = self.args(clickMode='open_link_in_task_tab')
        self.assertEqual(self.invoke(args), self.response)
        self.assertEqual(self.invoke(args), self.response)
        self.assertEqual(len(self.calls), 1)
        self.response['tabId'] = 9
        args = self.args('ref_click')
        self.assertEqual(self.invoke(args), self.response)
        self.assertNotIn(9, self.task['tabIds'])

    def test_invalid_modes_rejected_at_public_and_daemon_boundaries(self):
        from test_daemon_wire import daemon_module
        for action in ('click', 'ref_click'):
            for value in ('normal', '', 'arbitrary', None, False, 1, [], {}):
                with self.subTest(action=action, value=value):
                    args = self.args(action, clickMode=value)
                    self.assertEqual(self.invoke(args)['code'], 'invalid_fields')
                    fields = {'selector': '#link'} if action == 'click' else {
                        'binding': args['binding'], 'snapshotId': 'snap', 'ref': 'link'}
                    self.task['owner'] = 'owner-v2'
                    with self.assertRaises(daemon_module.ProtocolError) as caught:
                        self.run_action('invalid', action, clickMode=value, **fields)
                    self.assertEqual(caught.exception.code, 'invalid_params')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.invoke(dict(task_id='task-v2', tab_id=7,
            action='snapshot', clickMode='open_link_in_task_tab'))['code'], 'invalid_fields')
        with self.assertRaises(daemon_module.ProtocolError):
            self.run_action('wrong-action', 'snapshot', clickMode='open_link_in_task_tab')
        # 中文注释：指针模式只适用于带语义引用的点击，选择器点击不能扩大权限。
        self.assertEqual(self.invoke(self.args('click', clickMode='pointer'))['code'], 'invalid_fields')
        with self.assertRaises(daemon_module.ProtocolError):
            self.run_action('wrong-pointer-action', 'click', selector='#link', clickMode='pointer')

    def test_schema_exposes_two_explicit_modes_and_omission_is_default(self):
        schema = self.tools.TOOL_SCHEMAS['browser_shared_run']['parameters']
        self.assertEqual(schema['properties']['clickMode']['type'], 'string')
        self.assertEqual(schema['properties']['clickMode']['enum'], ['open_link_in_task_tab', 'pointer'])
        self.assertNotIn('clickMode', schema['required'])
        self.assertNotIn('default', schema['properties']['clickMode'])

    def test_pointer_mode_uses_same_owner_and_request_binding(self):
        self.response = {'clicked': True, 'kind': 'trusted-input', 'delivery': 'confirmed',
                         'effect': 'unverified', 'popupOwnership': 'uncertain'}
        args = self.args('ref_click', clickMode='pointer')
        self.assertEqual(self.invoke(args), self.response)
        self.assertEqual(self.calls[-1][2]['clickMode'], 'pointer')
        self.assertEqual(self.invoke(args), self.response)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.task['agentTabIds'], [])

    def test_child_frame_write_waits_for_smart_approval_and_runs_in_full(self):
        args = self.args('ref_click', frame_token='opaque-frame')
        self.task['activeMode'] = 'smart'
        pending = self.invoke(args)
        self.assertEqual(pending.get('status'), 'approval_required')
        self.assertEqual(self.calls, [])
        self.task['activeMode'] = 'full'
        args['request_id'] = 'full-frame'
        self.response = {'clicked': True, 'kind': 'trusted-input'}
        allowed = self.invoke(args)
        self.assertEqual(allowed, self.response)
        self.assertEqual(self.calls[-1][2]['frameToken'], 'opaque-frame')

    def test_safe_link_lease_conflict_fails_closed(self):
        self.daemon.tab_leases[('instance-v2', 8)] = 'other-task'
        result = self.invoke(self.args(clickMode='open_link_in_task_tab'))
        self.assertIn('error', result)
        self.assertEqual(self.task['state'], 'needs_sync')
        self.assertNotIn(8, self.task['tabIds'])
        self.assertEqual(self.daemon.tab_leases[('instance-v2', 8)], 'other-task')

    def test_ordinary_clicks_and_unsupported_results_are_not_substituted(self):
        for action in ('click', 'ref_click'):
            self.response = {'clicked': True, 'popupOwnership': 'uncertain'}
            self.assertEqual(self.invoke(self.args(action)), self.response)
            self.assertNotIn('clickMode', self.calls[-1][2])
            self.response = {'clicked': False, 'unsupported': True, 'code': 'CHILD_CREATION_UNSUPPORTED'}
            args = self.args(action, clickMode='open_link_in_task_tab')
            args['request_id'] += '-unsupported'
            self.assertEqual(self.invoke(args), self.response)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.task['agentTabIds'], [])


if __name__ == '__main__':
    unittest.main()
