"""中文注释：用临时账本和浏览器回执验证真实插件钩子到 daemon 的生命周期，不连接个人浏览器。"""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from daemon import BridgeDaemon, ProtocolError
from client import BridgeClient, BridgeError


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TOOLS = load('autoclose_tools', ROOT / 'executor-plugin/native_tools.py')
SWEEP = load('autoclose_sweep', ROOT / 'scripts/sweep-stale-tasks.py')


class Context:
    # 中文注释：保留注册的真实回调，测试不能绕开 session_key 映射和租约检查。
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_tool(self, **_):
        pass

    def on_unload(self, callback):
        self.unload = callback


class AutocloseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp', prefix='ac-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.now = 1_700_000_000.0
        self.clock = patch('time.time', lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.daemon = BridgeDaemon(self.home)
        self.daemon._prepare_data_dir()
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon._notify_tasks_changed = lambda _: None
        self.ext = {'instanceId': 'fixture', 'browser': 'chrome', 'version': '1.4.3'}
        self.daemon.extensions['fixture'] = self.ext
        self.releases = []
        def browser(extension, method, params, **_):
            if method == 'browser.release':
                self.releases.append(dict(params))
            return {'released': True, 'cleanupState': 'succeeded', 'cleanupReason': 'verified_complete',
                    'remainingTabIds': [], 'unknownTabIds': [],
                    'preservedTabIds': [7] if params.get('closeAgentTabs') is False else []}
        self.daemon._extension_call = browser
        class Client:
            # 中文注释：进程间 RPC 在测试中直连真实 dispatcher；浏览器清理只替换外部回执。
            call = lambda _, method, params: self.daemon._dispatch_client(method, params)
        self.runtime = TOOLS.runtime_module().NativeProfileRuntime(self.home, ROOT / 'executor-plugin', bridge_client=Client())
        self.ctx = Context()
        TOOLS.register_native_context(self.ctx, self.runtime)
        self.owner = self.runtime.authority.owner_for_session('session-a')
        self.runtime.authority._remember_owner(self.owner)
        self.task = self.new_task(self.owner)
        self.params = {'owner': self.owner, 'taskId': self.task['id']}

    def new_task(self, owner):
        result = self.daemon._dispatch_client('shared.create', {'owner': owner, 'title': '临时任务',
            'instanceId': 'fixture', 'allowedOrigins': ['https://fixture.test']})
        task = self.daemon.tasks[result['id']]
        tab_id = len(self.daemon.tasks) + 6
        task.update(state='ready', tabIds=[tab_id], agentTabIds=[tab_id])
        self.daemon.tab_leases[('fixture', tab_id)] = task['id']
        return task

    def completed(self):
        self.ctx.hooks['on_session_end'](session_id='session-a', completed=True)

    def test_missing_lifecycle_hooks_keep_tools_and_idle_cleanup(self):
        # 中文注释：宿主只接受预调用钩子；真实租约和 get 工具照常工作，收组由 daemon 空闲扫描完成。
        host = types.ModuleType('hermes_cli.plugins')
        host.VALID_HOOKS = {'pre_tool_call'}
        ctx = Context()
        with patch.dict(sys.modules, {'hermes_cli.plugins': host}):
            TOOLS.register_native_context(ctx, self.runtime)
        self.assertEqual(set(ctx.hooks), {'pre_tool_call'})
        self.now += 3000
        args = {'task_id': self.task['id']}
        decision = ctx.hooks['pre_tool_call']('browser_shared_get', args,
                                             session_id='session-a', tool_call_id='read')
        self.assertEqual(decision['action'], 'modify')
        value = json.loads(TOOLS.make_tool_handler('browser_shared_get', self.runtime)(
            {**args, **decision['args']}, session_id='session-a'))
        self.assertEqual(value['id'], self.task['id'])
        self.assertEqual(value['state'], 'ready')
        self.assertNotIn('idleCloseAt', self.task)
        self.now += self.daemon.task_idle_timeout_seconds - 1
        self.daemon._sweep_idle_tasks()
        self.assertEqual(self.task['state'], 'ready')
        self.now += 2
        self.daemon._sweep_idle_tasks()
        self.assertEqual(self.task['state'], 'closed')
        self.assertEqual(self.task['cleanupState'], 'succeeded')
        self.assertTrue(self.releases[-1]['closeAgentTabs'])

    def test_completed_closes_after_grace_and_only_this_owner(self):
        other = self.new_task('other-owner')
        self.completed()
        self.assertEqual(self.releases, [])
        self.now += 599
        self.daemon._sweep_idle_tasks()
        self.assertEqual(self.task['state'], 'ready')
        self.now += 2
        self.daemon._sweep_idle_tasks()
        self.assertEqual(self.task['state'], 'closed')
        self.assertEqual(other['state'], 'ready')
        self.assertTrue(self.releases[0]['closeAgentTabs'])
        self.assertNotIn(('fixture', 7), self.daemon.tab_leases)

    def test_grace_activity_cancels_deadline_and_survives_reload(self):
        self.completed()
        self.now += 590
        self.daemon._dispatch_client('shared.get', self.params)
        self.daemon._flush_tasks()
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.addCleanup(restored._flush_tasks)
        self.now += 30
        restored._sweep_idle_tasks()
        self.assertEqual(restored.tasks[self.task['id']]['state'], 'needs_sync')
        self.assertNotIn('idleCloseAt', restored.tasks[self.task['id']])

    def test_all_shared_calls_signal_activity_even_without_page_rpc(self):
        self.runtime.authority.lease_tools(['browser_shared_reference', 'browser_shared_doctor', 'browser_shared_script'])
        for name in ['browser_shared_health', 'browser_shared_browsers', 'browser_shared_reference',
                     'browser_shared_doctor', 'browser_shared_script', 'browser_shared_run']:
            self.completed()
            self.ctx.hooks['pre_tool_call'](name, {}, session_id='session-a', tool_call_id=name)
            self.assertNotIn('idleCloseAt', self.task, name)

    def test_foreign_or_forged_activity_cannot_cancel_grace(self):
        self.completed()
        self.ctx.hooks['pre_tool_call']('browser_shared_get', {'owner': self.owner}, session_id='forged', tool_call_id='x')
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('shared.get', {'owner': 'other', 'taskId': self.task['id']})
        self.assertIn('idleCloseAt', self.task)

    def test_completed_zero_and_incomplete_turn(self):
        self.ctx.hooks['on_session_end'](session_id='session-a', completed=False)
        self.assertNotIn('idleCloseAt', self.task)
        self.daemon.idle_close_seconds = 0
        self.completed()
        self.assertEqual(self.task['state'], 'closed')

    def test_cli_finalize_keeps_completed_grace_but_stop_overrides_it(self):
        self.completed()
        self.ctx.hooks['on_session_finalize'](session_id='session-a')
        self.assertEqual(self.task['state'], 'ready')
        self.ctx.hooks['on_session_end'](session_id='session-a', interrupted=True)
        self.assertEqual(self.task['state'], 'closed')

    def test_failed_and_interrupted_close_immediately(self):
        for flag in ['failed', 'interrupted']:
            self.task = self.new_task(self.owner)
            self.ctx.hooks['on_session_end'](session_id='session-a', completed=True, **{flag: True})
            self.assertEqual(self.task['state'], 'closed')
            self.assertNotIn('idleCloseAt', self.task)

    def test_stop_key_maps_from_exact_authoritative_route(self):
        key = 'agent:sample-profile:test-route'
        with sqlite3.connect(self.home / 'state.db') as db:
            db.execute('CREATE TABLE gateway_routing (scope TEXT, session_key TEXT, entry_json TEXT)')
            db.execute('INSERT INTO gateway_routing VALUES (?, ?, ?)', (str(self.home / 'sessions'), key,
                       json.dumps({'session_key': key, 'session_id': 'session-a'})))
        self.ctx.hooks['agent_loop_stopped'](session_key=key)
        self.assertEqual(self.task['state'], 'closed')
        self.assertNotEqual(self.owner, self.runtime.authority.owner_for_session(key))

    def test_unknown_key_never_treated_as_session_id(self):
        with self.assertLogs('browser-link', 'WARNING'):
            self.ctx.hooks['agent_loop_stopped'](session_key='session-a')
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.releases, [])

    def test_wrong_scope_foreign_owner_or_corrupt_route_closes_nothing(self):
        with sqlite3.connect(self.home / 'state.db') as db:
            db.execute('CREATE TABLE gateway_routing (scope TEXT, session_key TEXT, entry_json TEXT)')
        for scope, entry in [(str(self.home / 'other-sessions'), {'session_key': 'route', 'session_id': 'session-a'}),
                             (str(self.home / 'sessions'), {'session_key': 'route', 'session_id': 'other-session'}),
                             (str(self.home / 'sessions'), {'session_key': 'wrong', 'session_id': 'session-a'}),
                             (str(self.home / 'sessions'), [])]:
            # 中文注释：即便有相似路由或损坏数据，也不能按当前会话之外的身份进行清理。
            with sqlite3.connect(self.home / 'state.db') as db:
                db.execute('DELETE FROM gateway_routing')
                db.execute('INSERT INTO gateway_routing VALUES (?, ?, ?)', (scope, 'route', json.dumps(entry)))
            with self.assertLogs('browser-link', 'WARNING'):
                self.ctx.hooks['agent_loop_stopped'](session_key='route')
            self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.releases, [])

    def test_keep_tabs_and_stopped_pause_use_handoff(self):
        self.daemon._dispatch_client('shared.handoff', {**self.params, 'keepTabs': True})
        self.assertFalse(self.releases[-1]['closeAgentTabs'])
        self.assertTrue(self.task['handoff'])
        self.task = self.new_task(self.owner)
        self.task['state'] = 'paused'
        self.ctx.hooks['on_session_end'](session_id='session-a', interrupted=True)
        self.assertFalse(self.releases[-1]['closeAgentTabs'])
        self.assertEqual(self.task['cleanupPreservedCount'], 1)

    def test_paused_and_pending_captcha_are_exempt_from_both_timers(self):
        for status in ['paused', 'approval_required', 'user_input_required']:
            self.task = self.new_task(self.owner)
            if status == 'paused':
                self.task['state'] = 'paused'
            else:
                self.daemon.action_approvals[(self.task['id'], 'manual')] = {
                    'generation': 1, 'status': status, 'expiresAt': self.now + 10000}
            self.completed()
            self.now += 4000
            self.daemon._sweep_idle_tasks()
            self.assertNotEqual(self.task['state'], 'closed')

    def test_restart_startup_scan_closes_stale_ready_and_defers_offline_release(self):
        self.task['lastActivityAt'] = self.now - 4000
        self.daemon._persist_tasks()
        self.daemon._flush_tasks()
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        restored._notify_tasks_changed = lambda _: None
        self.addCleanup(restored._flush_tasks)
        # 中文注释：启动 watcher 的首轮必须扫描，无需新工具调用或手动调用 sweep。
        wait = restored.stop_event.wait
        restored.stop_event.wait = lambda seconds: restored.stop_event.set()
        restored._idle_watch()
        task = restored.tasks[self.task['id']]
        self.assertEqual(task['state'], 'closed')
        self.assertTrue(task['autoClosePending'])
        restored.extensions['fixture'] = self.ext
        calls = []
        def rpc(extension, method, params, **_):
            calls.append(method)
            return {'released': True, 'cleanupState': 'succeeded', 'remainingTabIds': [],
                    'preservedTabIds': [], 'unknownTabIds': []}
        restored._extension_call = rpc
        restored._ungroup_terminal_tasks('fixture', self.ext)
        self.assertIn('browser.release', calls)
        self.assertNotIn('autoClosePending', task)
        restored.stop_event.wait = wait

    def test_restart_retains_grace_and_pause_exemption(self):
        paused = self.new_task(self.owner)
        paused['state'] = 'paused'
        self.completed()
        self.daemon._persist_tasks()
        self.daemon._flush_tasks()
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.addCleanup(restored._flush_tasks)
        self.now += 601
        restored._sweep_idle_tasks()
        self.assertEqual(restored.tasks[self.task['id']]['state'], 'closed')
        self.assertEqual(restored.tasks[paused['id']]['state'], 'needs_sync')

    def test_restart_retains_pending_human_exemption_without_persisting_request(self):
        self.daemon.action_approvals[(self.task['id'], 'manual')] = {
            'generation': 1, 'status': 'user_input_required', 'expiresAt': self.now + 10000}
        self.completed()
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.addCleanup(restored._flush_tasks)
        self.now += 20000
        restored._sweep_idle_tasks()
        self.assertEqual(restored.tasks[self.task['id']]['state'], 'needs_sync')
        self.assertEqual(restored.tasks[self.task['id']]['idleRecoveryState'], 'paused')

    def test_activity_racing_scan_rechecks_before_release(self):
        self.completed()
        self.now += 601
        release = self.daemon._release_task
        def race(*args, **kwargs):
            self.daemon._session_activity(self.owner)
            return release(*args, **kwargs)
        self.daemon._release_task = race
        self.daemon._sweep_idle_tasks()
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.releases, [])

    def test_sweep_filters_and_snapshot_rejects_new_activity(self):
        self.task['lastActivityAt'] = self.now - 700
        snapshot = json.loads(json.dumps(self.task))
        paused = {**snapshot, 'id': 'paused', 'state': 'paused'}
        unknown = {**snapshot, 'id': 'unknown', 'state': 'closed', 'cleanupState': 'unknown',
                   'workTabs': [{'tabId': 8, 'groupId': 9, 'windowId': 1}]}
        self.assertEqual([t['id'] for t in SWEEP.candidates([snapshot, paused, unknown], self.now, 600)], [snapshot['id'], 'unknown'])
        self.daemon._dispatch_client('shared.get', self.params)
        with self.assertRaises(ProtocolError) as error:
            SWEEP.apply_task(type('Client', (), {'call': lambda _, m, p: self.daemon._dispatch_client(m, p)})(), snapshot, 600)
        self.assertEqual(error.exception.code, 'task_busy')
        self.assertEqual(self.task['state'], 'ready')
        self.task['lastActivityAt'] = snapshot['lastActivityAt']
        self.assertEqual(SWEEP.apply_task(type('Client', (), {'call': lambda _, m, p: self.daemon._dispatch_client(m, p)})(), snapshot, 600)['state'], 'closed')

    def test_sweep_dry_run_never_creates_client_or_changes_ledger(self):
        self.daemon._persist_tasks()
        self.daemon._flush_tasks()
        before = self.daemon.tasks_path.read_bytes()
        with patch.object(SWEEP.importlib.util, 'spec_from_file_location', side_effect=AssertionError('dry-run opened client')):
            self.assertEqual(SWEEP.main(['--dry-run', '--home', str(self.home), '--idle-seconds', '0']), 0)
        self.assertEqual(before, self.daemon.tasks_path.read_bytes())

    def test_apply_unknown_receipt_is_nonzero_and_never_retried(self):
        self.task.update(state='closed', cleanupState='unknown', generation=1,
                         workTabs=[{'tabId': 7, 'groupId': 9, 'windowId': 1}])
        self.daemon._persist_tasks()
        self.daemon._flush_tasks()
        calls = []
        class Client:
            # 中文注释：模拟缺创建证明的回执，脚本必须报告未确认，并且只请求一次非破坏收组。
            def call(self, method, params):
                calls.append((method, params))
                return {'state': 'closed', 'cleanupState': 'unknown', 'cleanupReason': 'no_journal'}
            def close(self):
                pass
        module = types.SimpleNamespace(BridgeClient=lambda *args, **kwargs: Client())
        spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        with patch.object(SWEEP.importlib.util, 'spec_from_file_location', return_value=spec), \
             patch.object(SWEEP.importlib.util, 'module_from_spec', return_value=module):
            self.assertEqual(SWEEP.main(['--apply', '--home', str(self.home)]), 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], 'shared.sweep_ungroup')
        self.assertEqual(calls[0][1]['generation'], 1)

    def test_no_autostart_client_never_launches_daemon(self):
        with patch('client.ensure_service', side_effect=AssertionError('started daemon')):
            client = BridgeClient(self.home / 'missing', autostart=False)
            try:
                with self.assertRaises(BridgeError) as error:
                    client.call('health', {})
                self.assertEqual(error.exception.code, 'connection_failed')
            finally:
                client.close()

    def test_environment_values(self):
        with patch.dict('os.environ', {'HERMES_BROWSER_IDLE_CLOSE_SECONDS': '2.5', 'HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS': '99'}):
            daemon = BridgeDaemon(self.home)
        self.assertEqual(daemon.idle_close_seconds, 2.5)
        self.assertEqual(daemon.task_idle_timeout_seconds, 99)
        with patch.dict('os.environ', {'HERMES_BROWSER_IDLE_CLOSE_SECONDS': '-1'}):
            with self.assertRaises(ValueError):
                BridgeDaemon(self.home)


if __name__ == '__main__':
    unittest.main()
