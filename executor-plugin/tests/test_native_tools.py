"""Native tool boundary tests; fixtures never use the active Hermes profile."""
import importlib.util
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    key = 'test_native_' + name
    if key in sys.modules:
        return sys.modules[key]
    spec = importlib.util.spec_from_file_location(key, ROOT / (name + '.py'))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


class RecordingClient:
    def __init__(self):
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        if method == 'browser.list':
            return [{'instanceId': 'explicit-instance', 'connected': True}]
        return {'id': 'task-1', 'state': 'pending_approval', 'owner': params.get('owner')}


class NativeTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(tempfile.gettempdir())
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.tools = load('native_tools')
        self.runtime = self.tools.runtime_module()
        self.client = RecordingClient()
        self.profile = self.runtime.NativeProfileRuntime(Path(self.tmp.name), ROOT, bridge_client=self.client)

    def invoke(self, name, args, session='session-a'):
        with ThreadPoolExecutor(max_workers=1) as worker:
            decision = worker.submit(self.profile.authority.pre_tool_call, name, args,
                                     session_id=session, tool_call_id='trusted-call-1').result()
        self.assertEqual(decision['action'], 'modify')
        patched = {**args, **decision['args']}
        result = self.tools.make_tool_handler(name, self.profile)(patched, session_id=session)
        return json.loads(result), patched

    def test_pending_guidance_distinguishes_browser_consent_from_manual_approval(self):
        result, _ = self.invoke('browser_shared_create', {'title': 'fixture', 'instance_id': 'explicit-instance', 'allowed_origins': ['https://example.com']})
        self.assertIn('自动', result['message'])
        self.assertIn('new_tab', self.tools.TOOL_SCHEMAS['browser_shared_create']['description'])
        self.assertNotIn('用户必须', self.tools.TOOL_SCHEMAS['browser_shared_create']['description'])
        self.assertIn('全部访问', self.tools.TOOL_SCHEMAS['browser_shared_resume']['description'])
        self.assertIn('授权', self.tools._public({'state': 'authorizing'})['message'])

    # 中文注释：桥接丢失滚动回执时不能被工具层的只读分类覆盖。
    def test_browser_access_revocation_is_explicit_and_keeps_write_uncertainty(self):
        for dispatched in (False, True):
            # 中文注释：同一撤权错误在派发前明确未执行，派发后不能自动重试写入。
            class Failure(Exception):
                code = 'browser_access_revoked'
                data = {'outcomeUnknown': dispatched, 'retryable': False}
            def fail_call(method, params):
                raise Failure('revoked')
            self.client.call = fail_call
            result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'request_id': 'write',
                'action': 'navigate', 'tab_id': 7, 'url': 'https://example.test/'})
            self.assertEqual(result['bridgeCode'], 'browser_access_revoked')
            self.assertEqual(result['outcome_unknown'], dispatched)
            self.assertFalse(result['retryable'])

    def test_concurrency_codes_have_specific_guidance_and_truthful_outcome(self):
        # 中文注释：冲突派发前后都保留明确提示，已派发的新标签不能被标为确定未执行。
        for code, unknown in [('needs_sync', True), ('task_busy', False), ('task_busy', True)]:
            class Failure(Exception):
                pass
            error = Failure('concurrency')
            error.code, error.data = code, {'outcomeUnknown': unknown}
            def fail_call(_method, _params):
                raise error
            self.client.call = fail_call
            result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'request_id': 'parallel',
                'action': 'new_tab', 'url': 'https://example.test/'})
            self.assertEqual(result['bridgeCode'], code)
            self.assertEqual(result['outcome_unknown'], unknown)
            self.assertNotIn('共享浏览器操作失败', result['error'])

    def test_scroll_failure_keeps_unknown_outcome(self):
        class Failure(Exception):
            code = "document_changed"
            data = {"outcomeUnknown": True, "retryable": False}
        def fail_call(method, params):
            raise Failure("页面已变化")
        self.client.call = fail_call
        result, _ = self.invoke("browser_shared_run", {"task_id": "task-1", "request_id": "scroll-1",
                                                      "action": "scroll", "tab_id": 7, "direction": "down"})
        self.assertTrue(result["outcome_unknown"])
        self.assertFalse(result["retryable"])

    def test_explicit_cleanup_status_then_retry_routes_under_same_owner(self):
        for action, method in [('status', 'shared.cleanup_status'), ('retry', 'shared.cleanup_retry')]:
            result, _ = self.invoke('browser_shared_close', {'task_id': 'task-1', 'cleanup_action': action})
            self.assertNotIn('error', result)
            self.assertEqual(self.client.calls[-1][0], method)
            self.assertEqual(self.client.calls[-1][1], {
                'owner': self.profile.authority.owner_for_session('session-a'), 'taskId': 'task-1'})
        self.assertIn('cleanupState', self.tools.TOOL_SCHEMAS['browser_shared_close']['description'])

    def test_task_projection_preserves_bounded_cleanup_counts_and_error(self):
        def result(method, params):
            return {'id': 'task-1', 'state': 'closed', 'owner': params['owner'],
                    'cleanupState': 'unknown', 'cleanupReason': 'extension_timeout',
                    'cleanupRemainingCount': 2, 'cleanupPreservedCount': 1,
                    'cleanupUnknownCount': 3, 'cleanupError': {'code': 'extension_timeout', 'secret': 'hide'},
                    'spawnedTabCount': 1, 'untrusted': 'hide'}
        self.client.call = result
        value, _ = self.invoke('browser_shared_get', {'task_id': 'task-1'})
        self.assertEqual(value['cleanupState'], 'unknown')
        self.assertEqual(value['cleanupReason'], 'extension_timeout')
        self.assertEqual(value['cleanupRemainingCount'], 2)
        self.assertEqual(value['cleanupPreservedCount'], 1)
        self.assertEqual(value['cleanupUnknownCount'], 3)
        self.assertEqual(value['cleanupError'], {'code': 'extension_timeout'})
        self.assertEqual(value['spawnedTabCount'], 1)
        self.assertNotIn('untrusted', value)

    def test_pending_create_does_not_unconditionally_request_approval(self):
        self.assertNotIn('否则请在扩展批准任务及标签页',
                         self.tools._public({'state': 'pending_approval'})['message'])

    def test_typed_read_error_not_misclassified_as_unknown_write(self):
        class TypedFailure(Exception):
            code = 'page_not_ready'
            data = {'outcomeUnknown': False, 'retryable': True}
        def fail(*_):
            raise TypedFailure()
        self.client.call = fail
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'snapshot', 'tab_id': 1})
        self.assertEqual(result['bridgeCode'], 'page_not_ready')
        self.assertFalse(result['outcome_unknown'])
        self.assertTrue(result['retryable'])

    def test_write_error_code_alone_cannot_prove_not_dispatched(self):
        class AmbiguousFailure(Exception):
            code = 'invalid_state'
            data = {}
        self.client.call = lambda method, params: (_ for _ in ()).throw(AmbiguousFailure())
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'click', 'tab_id': 1, 'selector': '#save'})
        self.assertTrue(result['outcome_unknown'])
        self.assertFalse(result['retryable'])

    def test_stale_parse_cursor_keeps_typed_error_without_page_data(self):
        # 中文注释：公共工具必须保留分页失效类型，不能把页面异常正文或游标内容带回调用者。
        class StaleCursor(Exception):
            code = 'parse_cursor_stale'
            data = {'outcomeUnknown': False, 'retryable': False}
        def fail(*_):
            raise StaleCursor('private page content and cursor')
        self.client.call = fail
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'page.parse',
            'tab_id': 1, 'options': {'cursor': 'old-cursor'}})
        self.assertEqual(result.get('bridgeCode'), 'parse_cursor_stale')
        self.assertFalse(result['outcome_unknown'])
        self.assertFalse(result['retryable'])
        self.assertNotIn('private page content', json.dumps(result))
        self.assertNotIn('old-cursor', json.dumps(result))

    def test_takeover_error_is_known_before_dispatch_and_can_continue_after_resume(self):
        class Paused(Exception):
            code = 'task_paused'
            data = {'outcomeUnknown': False, 'retryable': True}
        # 中文注释：接管阻断发生在浏览器动作派发前，不应被标为结果不确定。
        self.client.call = lambda method, params: (_ for _ in ()).throw(Paused())
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'click', 'tab_id': 1, 'selector': '#save'})
        self.assertEqual(result['bridgeCode'], 'task_paused')
        self.assertFalse(result['outcome_unknown'])
        self.assertFalse(result['retryable'])

    def test_foreign_cdp_target_is_a_known_pre_dispatch_refusal(self):
        class ForeignTarget(Exception):
            code = 'target_not_owned'
            data = {'outcomeUnknown': False}
        captured = []
        def refuse(method, params):
            captured.append((method, params))
            raise ForeignTarget()
        self.client.call = refuse
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'cdp.send',
            'tab_id': 1, 'method': 'DOM.getDocument', 'target_id': 'foreign-target'})
        self.assertEqual(captured[0][1]['targetId'], 'foreign-target')
        self.assertEqual(result['bridgeCode'], 'target_not_owned')
        self.assertFalse(result['outcome_unknown'])

    def test_page_request_maps_without_separate_api_consent_or_credentials(self):
        # 中文注释：任务来源即页面请求范围，协议不再接受独立 API URL 清单。
        result, _ = self.invoke('browser_shared_create', {'title': 'API fixture', 'instance_id': 'explicit-instance', 'allowed_origins': ['https://example.com']})
        self.assertNotIn('error', result)
        self.assertNotIn('apiUrls', self.client.calls[-1][1])
        result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'api_request', 'tab_id': 1, 'url': 'https://example.com/api', 'fields': ['count'], 'http_method': 'GET'})
        self.assertNotIn('error', result)
        self.assertEqual(self.client.calls[-1][1]['fields'], ['count'])
        self.assertEqual(self.client.calls[-1][1]['httpMethod'], 'GET')
        for extra in ({'cookies': 'no'}, {'headers': {}}, {'http_method': 'POST'}, {'fields': []}):
            result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': 'api_request', 'tab_id': 1, 'url': 'https://example.com/api', 'fields': ['count'], **extra})
            self.assertEqual(result['code'], 'invalid_fields')

    def test_cross_thread_hook_retains_identity_and_pending_guidance(self):
        result, patched = self.invoke('browser_shared_create', {
            'title': 'fixture', 'instance_id': 'explicit-instance',
            'allowed_origins': ['https://example.com']})
        method, params = self.client.calls[-1]
        self.assertEqual(method, 'shared.create')
        self.assertEqual(params['owner'], self.profile.authority.owner_for_session('session-a'))
        self.assertEqual(params['instanceId'], 'explicit-instance')
        self.assertNotIn('owner', result)
        self.assertIn('浏览器', result['message'])
        self.assertIn('批准', result['message'])
        replay = json.loads(self.tools.make_tool_handler('browser_shared_create', self.profile)(patched, session_id='session-a'))
        self.assertIn('error', replay)
        self.assertEqual(len(self.client.calls), 1)

    def test_invalid_public_arguments_fail_before_rpc(self):
        cases = [
            ('create', {'title': 'x', 'allowed_origins': ['https://example.com']}),
            ('create', {'title': 'x', 'instance_id': 'x', 'allowed_origins': ['file:///tmp']}),
            ('create', {'title': 'x', 'instance_id': 'x', 'allowed_origins': ['https://example.com'], 'api_urls': ['https://example.com/api']}),
            ('run', {'task_id': 'x', 'action': 'click', 'selector': '#x'}),
            ('run', {'task_id': 'x', 'action': 'evaluate', 'tab_id': 1}),
            ('run', {'task_id': 'x', 'action': 'fill', 'tab_id': True, 'selector': '#x', 'text': 'fixture'}),
            ('list', {'extra': 'unexpected'}),
        ]
        for suffix, args in cases:
            with self.subTest(suffix=suffix, args=args):
                result, _ = self.invoke('browser_shared_' + suffix, args)
                # 中文注释：缺必填参数与参数类型/字段错误分别返回固定分类。
                expected = 'missing_fields' if suffix == 'create' and 'instance_id' not in args or suffix == 'run' and args.get('action') == 'click' and 'tab_id' not in args else 'invalid_fields'
                self.assertEqual(result.get('code'), expected)
        self.assertEqual(self.client.calls, [])

    def test_wrong_session_tampering_and_missing_hook_fail_closed(self):
        name = 'browser_shared_get'
        handler = self.tools.make_tool_handler(name, self.profile)
        for session, mutation in [('session-b', {}), ('', {}), ('session-a', {'task_id': 'other'})]:
            args = {'task_id': 'task-1'}
            decision = self.profile.authority.pre_tool_call(name, args, session_id='session-a', tool_call_id='c')
            patched = {**args, **decision['args'], **mutation}
            self.assertEqual(json.loads(handler(patched, session_id=session))['code'], 'owner_denied')
        self.assertEqual(json.loads(handler({'task_id': 'task-1'}, session_id='session-a'))['code'], 'owner_denied')
        self.assertEqual(self.client.calls, [])

    def test_forged_owner_and_lease_blocked_in_hook(self):
        for key in ('owner', 'session_id', self.runtime.OWNER_LEASE_ARG):
            decision = self.profile.authority.pre_tool_call('browser_shared_list', {key: 'forged'}, session_id='a', tool_call_id='c')
            self.assertEqual(decision['action'], 'block')

    def test_exact_registration_and_no_authority_in_schema(self):
        class Context:
            def __init__(self):
                self.tools, self.hooks, self.unload = {}, [], []
            def register_tool(self, **kw):
                self.tools[kw['name']] = kw
            def register_hook(self, *args):
                self.hooks.append(args)
            def on_unload(self, callback):
                self.unload.append(callback)
        ctx = Context()
        self.tools.register_native_context(ctx, self.profile)
        # 中文注释：文件清单只读工具随可信任务身份注册，不授予本地路径读取。
        self.assertEqual(set(ctx.tools), {'browser_shared_' + s for s in ('health', 'browsers', 'create', 'list', 'get', 'artifacts', 'run', 'cancel', 'resume', 'close', 'downloads')})
        self.assertEqual({name for name, _ in ctx.hooks}, {'pre_tool_call', 'on_session_finalize', 'subagent_stop', 'on_session_end', 'agent_loop_stopped'})
        for entry in ctx.tools.values():
            schema = entry['schema']['parameters']
            self.assertFalse(schema['additionalProperties'])
            self.assertNotIn('owner', schema['properties'])
            self.assertNotIn(self.runtime.OWNER_LEASE_ARG, schema['properties'])
        ctx.unload[0]()
        result, _ = self.invoke('browser_shared_list', {})
        self.assertIn('error', result)
        self.assertEqual(self.client.calls, [])

    def test_expired_foreign_tool_and_profile_leases_are_rejected(self):
        authority = self.profile.authority
        authority._clock = lambda: 1.0
        issued = authority.pre_tool_call('browser_shared_list', {}, session_id='a', tool_call_id='c')
        authority._clock = lambda: 1000.0
        self.assertRaises(self.runtime.OwnerLeaseError, authority.consume, 'browser_shared_list', issued['args'], session_id='a')
        authority._clock = lambda: 1.0
        issued = authority.pre_tool_call('browser_shared_list', {}, session_id='a', tool_call_id='c')
        self.assertRaises(self.runtime.OwnerLeaseError, authority.consume, 'browser_shared_health', issued['args'], session_id='a')
        other = self.runtime.NativeProfileRuntime(Path(self.tmp.name) / 'other', ROOT, bridge_client=self.client)
        issued = authority.pre_tool_call('browser_shared_list', {}, session_id='a', tool_call_id='c')
        self.assertRaises(self.runtime.OwnerLeaseError, other.authority.consume, 'browser_shared_list', issued['args'], session_id='a')
        self.assertNotEqual(authority.owner_for_session('a'), other.authority.owner_for_session('a'))
        reloaded = self.runtime.NativeProfileRuntime(Path(self.tmp.name), ROOT, bridge_client=self.client)
        self.assertEqual(authority.owner_for_session('a'), reloaded.authority.owner_for_session('a'))
        self.assertRaises(self.runtime.OwnerLeaseError, reloaded.authority.consume, 'browser_shared_list', issued['args'], session_id='a')

    def test_close_keep_tabs_maps_to_handoff(self):
        result, _ = self.invoke('browser_shared_close', {'task_id': 'task-1', 'keep_tabs': True})
        self.assertNotIn('error', result)
        method, params = self.client.calls[-1]
        self.assertEqual(method, 'shared.handoff')
        self.assertIs(params['keepTabs'], True)

    def test_metadata_and_control_rpc_mappings(self):
        for suffix, expected in [('health', 'health'), ('browsers', 'browser.list'), ('list', 'shared.list'),
                                 ('get', 'shared.get'), ('cancel', 'shared.cancel'),
                                 ('resume', 'shared.resume'), ('close', 'shared.close')]:
            args = {} if suffix in ('health', 'browsers', 'list') else {'task_id': 'task-1'}
            result, _ = self.invoke('browser_shared_' + suffix, args)
            self.assertNotIn('error', result)
            method, params = self.client.calls[-1]
            self.assertEqual(method, expected)
            if suffix in ('health', 'browsers'):
                self.assertEqual(params, {})
            else:
                self.assertEqual(params['owner'], self.profile.authority.owner_for_session('session-a'))

    def test_get_waits_for_resume_and_reads_bounded_log(self):
        # 中文注释：模型只能读取同一可信 owner 的任务状态与脱敏步骤，不能设置主要链接。
        states = iter(['paused', 'ready', 'ready'])
        def call(method, params):
            self.client.calls.append((method, dict(params)))
            return {'id': 'task-1', 'state': next(states), 'generation': 2,
                    'resumeSummary': {'urlChanged': True, 'documentReplaced': False,
                                      'referencesInvalid': True, 'readPageFirst': True},
                    'recentLog': [{'time': '2026-09-30T00:00:00Z', 'action': 'click',
                                   'target': 'button · 提交', 'durationMs': 12, 'result': 'succeeded'}]}
        self.client.call = call
        result, _ = self.invoke('browser_shared_get', {'task_id': 'task-1', 'until': 'resumed',
                                                       'timeout_s': 1, 'include_log': True, 'log_limit': 5})
        self.assertTrue(result['resumeSummary']['readPageFirst'])
        self.assertEqual(result['recentLog'][0]['target'], 'button · 提交')
        self.assertEqual(self.client.calls[-1][1]['logLimit'], 5)
        self.assertNotIn('browser_shared_set_primary', self.tools.TOOL_SCHEMAS)

    def test_clients_are_per_thread_and_closed_on_unload_without_daemon_shutdown(self):
        import types
        from concurrent.futures import ThreadPoolExecutor
        import threading
        barrier = threading.Barrier(2)
        clients, started, timeouts = [], [], []
        class Client:
            def __init__(self, home, timeout=15.0):
                self.closed = False
                clients.append(self)
                timeouts.append(timeout)
            def call(self, method, params):
                barrier.wait(timeout=2)
                return {'ok': True}
            def close(self):
                self.closed = True
        self.profile._client = None
        self.profile._client_module = types.SimpleNamespace(BridgeClient=Client, ensure_service=lambda home: started.append(home))
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.profile.call, 'health', {}) for _ in range(2)]
            self.assertEqual([future.result() for future in futures], [{'ok': True}, {'ok': True}])
        self.assertEqual(len(clients), 2)
        self.assertTrue(all(not client.closed for client in clients))
        self.profile.close()
        self.assertTrue(all(client.closed for client in clients))
        self.assertEqual(timeouts, [35.0, 35.0])
        real_client_module = self.runtime.load_module(
            ROOT.parent / 'native-bridge' / 'client.py', 'test_native_real_bridge_client_')
        real_client = real_client_module.BridgeClient(Path(self.tmp.name), timeout=35.0)
        self.assertEqual(real_client.timeout, 35.0)
        real_client.close()

    def test_all_actions_map_explicit_parameters(self):
        for action, extra in [('tabs', {}), ('new_tab', {'url': 'https://example.com'}),
                              ('snapshot', {'tab_id': 42}), ('navigate', {'tab_id': 42, 'url': 'https://example.com'}),
                              ('click', {'tab_id': 42, 'selector': '#fixture'}),
                              ('fill', {'tab_id': 42, 'selector': '#fixture', 'text': ''}),
                              ('press', {'tab_id': 42, 'selector': '#fixture', 'key': 'Enter'}),
                              ('screenshot', {'tab_id': 42})]:
            result, _ = self.invoke('browser_shared_run', {'task_id': 'task-1', 'action': action, **extra})
            self.assertNotIn('error', result)
            method, params = self.client.calls[-1]
            self.assertEqual(method, 'shared.run')
            self.assertEqual(params['requestId'], 'trusted-call-1')
            if 'tab_id' in extra:
                self.assertEqual(params['tabId'], 42)


if __name__ == '__main__':
    unittest.main()
