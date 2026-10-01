"""browser_shared_open: one-call start, with a synthetic daemon; no browser."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN))
import native_runtime  # noqa: E402

open_tool = native_runtime.load_module(PLUGIN / 'open_tool.py', 'open_tool_under_test_')
integration = native_runtime.load_module(PLUGIN / 'single_tool_adapter' / 'integration.py', 'open_integration_under_test_')


class FakeBridge:
    def __init__(self):
        self.calls = []

    def bind(self, session_id, *, owner, task_id, tab_id=None):
        self.calls.append(('bind', session_id, task_id))

    def unbind(self, session_id, *, task_id=None):
        self.calls.append(('unbind', session_id))


class FakeRuntime:
    def __init__(self, directory, browsers, *, ready_after=0, tasks=None, run_status=None):
        self.authority = native_runtime.NativeOwnerAuthority(directory)
        self.authority.lease_tools((open_tool.TOOL_NAME,))
        self.browsers = browsers
        self.ready_after = ready_after
        self.tasks = dict(tasks or {})
        self.tabs = {}
        self.run_status = run_status
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == 'browser.list':
            return self.browsers
        if method == 'shared.list':
            return [dict(task) for task in self.tasks.values()
                    if task.get('owner', params['owner']) == params['owner']]
        if method == 'shared.create':
            task = {'id': f'task-{len(self.tasks) + 1}', 'state': 'pending_approval', 'instanceId': params['instanceId'],
                    'allowedOrigins': params['allowedOrigins'], 'owner': params['owner'], 'polls': 0}
            self.tasks[task['id']] = task
            return dict(task)
        if method == 'shared.get':
            task = self.tasks[params['taskId']]
            task['polls'] += 1
            if task['state'] == 'pending_approval' and task['polls'] > self.ready_after:
                task['state'] = 'ready'
            return dict(task)
        if method == 'shared.run':
            if params['action'] == 'tabs':
                return list(self.tabs.get(params['taskId'], []))
            if self.run_status:
                return {'status': self.run_status, 'requestId': params['requestId']}
            if params['action'] == 'semantic_snapshot':
                mode = params['options']['mode']
                return {'snapshotId': 'snap-1', 'binding': {'taskId': params['taskId'], 'documentId': 'doc-1', 'leaseId': 'lease-1'},
                        'items': [{'role': 'heading', 'name': '目录'}] if mode == 'content' else
                        [{'ref': f'r{index}', 'role': 'button', 'name': '操作' * 100} for index in range(30)]}
            if params['action'] == 'navigate':
                tab = next(row for row in self.tabs[params['taskId']] if row['id'] == params['tabId'])
                tab['url'] = params['url']
                return {'tabId': tab['id'], 'url': tab['url'], 'ready': 'interactive'}
            if params['action'] == 'ref_click':
                # 中文注释：模拟守护进程按摘要原始快照绑定接受后续引用动作。
                assert params['snapshotId'] == 'snap-1'
                assert params['binding']['taskId'] == params['taskId']
                return {'clicked': True, 'ref': params['ref']}
            opened = {'tabId': 41 + len(self.tabs.get(params['taskId'], [])), 'url': params['url']}
            self.tabs.setdefault(params['taskId'], []).append({'id': opened['tabId'], 'url': params['url']})
            self.tasks[params['taskId']].setdefault('workTabs', []).append({'tabId': opened['tabId']})
            return opened
        raise AssertionError(method)


EDGE = {'instanceId': 'edge-1', 'browser': 'edge', 'connected': True, 'consentStatus': 'enabled'}
CHROME = {'instanceId': 'chrome-1', 'browser': 'chrome', 'connected': True, 'consentStatus': 'enabled'}


class OpenToolTests(unittest.TestCase):
    def test_primary_browser_precedes_environment_default(self):
        self.make([{**EDGE, 'primary': True}, CHROME])
        with patch.dict(os.environ, {'HERMES_BROWSER_DEFAULT': 'chrome'}):
            selected = self.open({'url': 'https://shop.example/list'})
        self.assertEqual(selected['instance_id'], 'edge-1')
        self.make([{**EDGE, 'primary': True, 'consentStatus': 'disabled'}, CHROME])
        with patch.dict(os.environ, {'HERMES_BROWSER_DEFAULT': 'chrome'}):
            smart = self.open({'url': 'https://shop.example/list'})
        self.assertEqual(smart['instance_id'], 'edge-1')
        self.assertNotIn('primaryUnavailable', smart)

    def test_explicit_instance_overrides_primary_and_offline_primary_falls_back(self):
        self.make([{**EDGE, 'primary': True}, CHROME])
        selected = self.open({'url': 'https://shop.example/list', 'instance_id': 'chrome-1'})
        self.assertEqual(selected['instance_id'], 'chrome-1')
        self.make([{**EDGE, 'connected': False, 'primary': True}, CHROME])
        fallback = self.open({'url': 'https://shop.example/list'})
        self.assertEqual(fallback['instance_id'], 'chrome-1')
        self.assertTrue(fallback['primaryUnavailable'])
        self.make([{**EDGE, 'connected': False, 'primary': True}, CHROME,
                   {'instanceId': 'chrome-2', 'browser': 'chrome', 'connected': True, 'consentStatus': 'enabled'}])
        with patch.dict(os.environ, {'HERMES_BROWSER_DEFAULT': 'chrome-2'}):
            selected = self.open({'url': 'https://shop.example/list'})
        self.assertEqual(selected['instance_id'], 'chrome-2')
        self.assertTrue(selected['primaryUnavailable'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def make(self, browsers, **options):
        self.runtime = FakeRuntime(Path(self.temp.name) / 'auth', browsers, **options)
        self.bridge = integration.HostBindingCoordinator(FakeBridge())
        self.clock = [0.0]
        self.handler = open_tool.make_handler(
            self.runtime, self.bridge, lease_error=native_runtime.OwnerLeaseError,
            clock=lambda: self.clock[0], sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s))

    def open(self, args, call='call-1'):
        hook = self.runtime.authority.pre_tool_call(open_tool.TOOL_NAME, args, session_id='session-a', tool_call_id=call)
        self.assertEqual(hook['action'], 'modify')
        return json.loads(self.handler({**args, **hook['args']}, session_id='session-a'))

    def methods(self):
        return [method for method, _ in self.runtime.calls]

    def test_single_authorized_browser_creates_binds_and_opens(self):
        self.make([EDGE], ready_after=1)
        result = self.open({'url': 'https://shop.example/list?page=1'})
        self.assertEqual(result['tab_id'], 41)
        self.assertEqual(result['origin'], 'https://shop.example')
        self.assertEqual(result['instance_id'], 'edge-1')
        created = next(p for m, p in self.runtime.calls if m == 'shared.create')
        self.assertEqual(created['allowedOrigins'], ['https://shop.example'])
        run = next(p for m, p in self.runtime.calls if m == 'shared.run')
        self.assertEqual((run['action'], run['requestId']), ('new_tab', 'call-1'))
        self.assertEqual(self.bridge._bindings['session-a'][1], result['task_id'])

    def test_bound_ready_task_for_the_same_site_is_reused(self):
        self.make([EDGE])
        first = self.open({'url': 'https://shop.example/a'})
        second = self.open({'url': 'https://shop.example/b'}, call='call-2')
        self.assertEqual(first['task_id'], second['task_id'])
        self.assertEqual(self.methods().count('shared.create'), 1)
        self.assertEqual(first['tab_id'], second['tab_id'])
        self.assertTrue(second['reused'])
        self.assertEqual(self.runtime.calls[-2][1]['action'], 'navigate')

    def test_new_task_forces_separate_workspace(self):
        self.make([EDGE])
        first = self.open({'url': 'https://shop.example/a', 'summary': False})
        second = self.open({'url': 'https://shop.example/b', 'new_task': True, 'summary': False}, call='call-2')
        self.assertNotEqual(first['task_id'], second['task_id'])
        self.assertEqual(self.methods().count('shared.create'), 2)

    def test_other_session_does_not_reuse_same_site_task(self):
        self.make([EDGE])
        first = self.open({'url': 'https://shop.example/a', 'summary': False})
        args = {'url': 'https://shop.example/b', 'summary': False}
        hook = self.runtime.authority.pre_tool_call(open_tool.TOOL_NAME, args,
                                                     session_id='session-b', tool_call_id='call-b')
        second = json.loads(self.handler({**args, **hook['args']}, session_id='session-b'))
        # 中文注释：owner 由可信会话身份生成；同源任务也不能跨会话借用。
        self.assertNotEqual(first['task_id'], second['task_id'])
        self.assertEqual(self.methods().count('shared.create'), 2)

    def test_summary_is_bounded_and_can_be_disabled(self):
        self.make([EDGE])
        result = self.open({'url': 'https://shop.example/a'})
        self.assertEqual(result['summary']['snapshotId'], 'snap-1')
        self.assertLessEqual(len(json.dumps(result['summary'], ensure_ascii=False)), 1500)
        self.assertLessEqual(len(result['summary']['items']), 20)
        self.assertTrue(result['summary']['truncated'])
        without = self.open({'url': 'https://shop.example/b', 'summary': False}, call='call-2')
        self.assertNotIn('summary', without)

    def test_open_summary_ref_is_usable_without_another_snapshot(self):
        self.make([EDGE])
        opened = self.open({'url': 'https://shop.example/a'})
        summary = opened['summary']
        selected = self.runtime.call('shared.run', {'owner': 'owner', 'taskId': opened['task_id'],
            'tabId': opened['tab_id'], 'requestId': 'click-1', 'action': 'ref_click',
            'binding': summary['binding'], 'snapshotId': summary['snapshotId'],
            'ref': summary['items'][0]['ref']})
        self.assertTrue(selected['clicked'])
        self.assertEqual(self.methods().count('shared.run'), 3)

    def test_open_failure_exposes_existing_task_id(self):
        self.make([EDGE])
        original = self.runtime.call
        def fail(method, params):
            if method == 'shared.run' and params.get('action') == 'new_tab':
                error = RuntimeError('page failed')
                error.code = 'page_not_ready'
                error.data = {'outcomeUnknown': False}
                raise error
            return original(method, params)
        self.runtime.call = fail
        failed = self.open({'url': 'https://shop.example/a', 'summary': False})
        self.assertEqual(failed['task_id'], 'task-1')
        self.runtime.call = original
        retried = self.open({'url': 'https://shop.example/a', 'summary': False}, call='call-2')
        self.assertEqual(retried['task_id'], 'task-1')
        self.assertEqual(self.methods().count('shared.create'), 1)

    def test_resume_reuses_the_exact_owned_work_tab(self):
        self.make([EDGE], tasks={'held': {'id': 'held', 'state': 'ready', 'instanceId': 'edge-1',
                                         'allowedOrigins': ['https://shop.example'], 'polls': 0,
                                         'workTabs': [{'tabId': 77}], 'tabIds': [77]}})
        self.runtime.tabs['held'] = [{'id': 77, 'url': 'https://shop.example/resume'}]
        result = self.open({'url': 'https://shop.example/resume'})
        self.assertEqual(result['tab_id'], 77)
        self.assertFalse(any(params.get('action') == 'new_tab' for method, params in self.runtime.calls
                             if method == 'shared.run'))

    def test_same_url_on_multiple_owned_tabs_requires_selection(self):
        self.make([EDGE], tasks={'held': {'id': 'held', 'state': 'ready', 'instanceId': 'edge-1',
                                         'allowedOrigins': ['https://shop.example'], 'polls': 0,
                                         'workTabs': [{'tabId': 77}, {'tabId': 78}], 'tabIds': [77, 78]}})
        self.runtime.tabs['held'] = [{'id': 77, 'url': 'https://shop.example/resume'},
                                     {'id': 78, 'url': 'https://shop.example/resume'}]
        result = self.open({'url': 'https://shop.example/resume'})
        self.assertEqual(result['code'], 'work_tab_choice_required')
        self.assertEqual(result['tab_ids'], [77, 78])
        self.assertFalse(any(params.get('action') == 'new_tab' for method, params in self.runtime.calls
                             if method == 'shared.run'))

    def test_paused_task_is_reused_without_opening_another_page(self):
        self.make([EDGE], tasks={'held': {'id': 'held', 'state': 'paused', 'instanceId': 'edge-1',
                                         'allowedOrigins': ['https://shop.example'], 'polls': 0}})
        # 中文注释：用户接管时不创建重复任务，也不在人工操作的页面上打开新页。
        result = self.open({'url': 'https://shop.example/a'})
        self.assertEqual(result['status'], 'task_paused')
        self.assertEqual(result['task_id'], 'held')
        self.assertNotIn('shared.create', self.methods())
        self.assertNotIn('shared.run', self.methods())

    def test_a_new_site_gets_its_own_task_and_the_session_moves_to_it(self):
        self.make([EDGE])
        first = self.open({'url': 'https://shop.example/a'})
        second = self.open({'url': 'https://pay.example/'}, call='call-2')
        self.assertNotEqual(first['task_id'], second['task_id'])
        self.assertEqual(self.bridge._bindings['session-a'][1], second['task_id'])

    def test_several_authorized_browsers_require_a_choice(self):
        self.make([EDGE, CHROME])
        result = self.open({'url': 'https://shop.example/'})
        self.assertEqual(result['code'], 'browser_choice_required')
        self.assertEqual({row['instance_id'] for row in result['browsers']}, {'edge-1', 'chrome-1'})
        self.assertNotIn('shared.create', self.methods())
        chosen = self.open({'url': 'https://shop.example/', 'instance_id': 'chrome-1'}, call='call-2')
        self.assertEqual(chosen['instance_id'], 'chrome-1')

    def test_default_browser_selects_only_unique_enabled_match(self):
        # 中文注释：显式实例优先；未配置或默认值匹配多台时仍要求选择。
        self.make([EDGE, CHROME])
        with patch.dict(os.environ, {'HERMES_BROWSER_DEFAULT': 'edge'}):
            self.assertEqual(self.open({'url': 'https://shop.example/'})['instance_id'], 'edge-1')
            self.assertEqual(self.open({'url': 'https://shop.example/', 'instance_id': 'chrome-1'},
                                       call='call-2')['instance_id'], 'chrome-1')
        self.assertEqual(open_tool._pick_browser([EDGE, {**EDGE, 'instanceId': 'edge-2'}], None, 'edge')[1],
                         'browser_choice_required')

    def test_nondefault_profile_reads_shared_browser_default(self):
        # 中文注释：模拟 sample-profile 配置目录，进程变量仍高于共享 .env。
        root = Path(self.temp.name) / 'hermes'
        (root / 'profiles' / 'sample-profile').mkdir(parents=True)
        (root / '.env').write_text('HERMES_BROWSER_DEFAULT=edge\n')
        self.make([EDGE, CHROME])
        self.runtime.bridge_home = root
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.open({'url': 'https://shop.example/'})['instance_id'], 'edge-1')
        with patch.dict(os.environ, {'HERMES_BROWSER_DEFAULT': 'chrome'}):
            self.assertEqual(self.open({'url': 'https://shop.example/', 'instance_id': 'edge-1'},
                                       call='call-2')['instance_id'], 'edge-1')

    def test_redirected_open_returns_final_origin_without_unknown_outcome(self):
        # 中文注释：跨站跳转已确定拒绝，工具只返回来源供新任务使用。
        self.make([EDGE])
        original = self.runtime.call

        class Redirected(Exception):
            code = 'redirected_out_of_scope'
            data = {'outcomeUnknown': False, 'finalOrigin': 'https://other.test'}

        def redirected(method, params):
            if method == 'shared.run' and params.get('action') == 'new_tab':
                raise Redirected('private path /token')
            return original(method, params)

        self.runtime.call = redirected
        result = self.open({'url': 'https://shop.example/'})
        self.assertEqual(result['code'], 'redirected_out_of_scope')
        self.assertEqual(result['final_origin'], 'https://other.test')
        self.assertFalse(result['outcome_unknown'])
        self.assertNotIn('private path', json.dumps(result))

    def test_unauthorized_task_reports_waiting_instead_of_opening(self):
        self.make([{**EDGE, 'consentStatus': 'disabled'}], ready_after=10_000)
        result = self.open({'url': 'https://shop.example/'})
        self.assertEqual(result['status'], 'awaiting_authorization')
        self.assertNotIn('shared.run', self.methods())

    def test_task_stopped_while_waiting_is_not_reported_as_awaiting_authorization(self):
        # 中文注释：批准等待中发生停止、断线或拒绝时，工具不能再让 agent 等待一个已失效的任务。
        for state in ('cancelled', 'closed', 'failed', 'needs_sync'):
            with self.subTest(state=state):
                self.make([EDGE], ready_after=999)
                original = self.runtime.call
                def call(method, params):
                    result = original(method, params)
                    if method == 'shared.get':
                        result['state'] = state
                    return result
                self.runtime.call = call
                result = self.open({'url': 'https://shop.example/'})
                self.assertEqual(result.get('code'), 'task_not_ready')
                self.assertEqual(result['state'], state)
                self.assertNotIn('shared.run', self.methods())
        self.assertNotIn('session-a', self.bridge._bindings)

    def test_waiting_task_is_reused_after_authorization(self):
        # 授权等待和后续重试必须指向同一任务，避免重复创建与重复授权。
        self.make([{**EDGE, 'consentStatus': 'disabled'}], ready_after=10_000)
        first = self.open({'url': 'https://shop.example/'})
        waiting = self.open({'url': 'https://shop.example/'}, call='call-2')
        self.assertEqual(first['task_id'], waiting['task_id'])
        self.assertEqual(self.methods().count('shared.create'), 1)
        self.runtime.tasks[first['task_id']]['state'] = 'ready'
        opened = self.open({'url': 'https://shop.example/'}, call='call-3')
        self.assertEqual(opened['task_id'], first['task_id'])
        self.assertEqual(self.methods().count('shared.create'), 1)

    def test_invalid_urls_are_refused_before_any_call(self):
        self.make([EDGE])
        for url in ('file:///etc/passwd', 'https://user:pw@shop.example/', 'not a url'):
            with self.subTest(url=url):
                self.assertEqual(self.open({'url': url}, call=url)['code'], 'invalid_url')
        self.assertEqual(self.runtime.calls, [])

    def test_confirmation_needed_returns_the_request_to_query(self):
        self.make([EDGE], run_status='approval_required')
        result = self.open({'url': 'https://shop.example/'}, call='call-7')
        self.assertEqual(result['status'], 'approval_required')
        self.assertEqual(result['request_id'], 'call-7')


if __name__ == '__main__':
    unittest.main()
