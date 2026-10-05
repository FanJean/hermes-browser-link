"""中文注释：只使用临时 daemon 目录与合成任务，覆盖回收配置和跨层效果字段。"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from daemon import BridgeDaemon, ProtocolError, _safe_error_data
from client import BridgeError

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
RUNTIME = load('window160_runtime', 'executor-plugin/runtime.py')
ACTION = load('window160_action', 'executor-plugin/script_lane/action_session.py')
CHILD = load('window160_child', 'executor-plugin/script_lane/child.py')
HINT = '输入已派发但未观察到效果；请读取目标页核对，检查按钮状态或改用页面支持的操作，不要反复重试。'

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp' if os.path.isdir('/private/tmp') else None, prefix='bl160-')
        self.addCleanup(self.temp.cleanup)
        with patch.dict(os.environ, {'HERMES_BROWSER_WORK_WINDOW': 'separate', 'HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS': '1200'}):
            self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        self.daemon._notify_tasks_changed = lambda _: None
        self.addCleanup(self.daemon._flush_tasks)
        # 中文注释：不连接真实浏览器，旧页面记录默认没有确认不存在的证据。
        self.daemon._extension_call = lambda *_a, **_k: {'cleanupState': 'unknown'}
        self.daemon.extensions['fixture'] = {'instanceId': 'fixture', 'browser': 'chrome'}

    def task(self):
        result = self.daemon._dispatch_client('shared.create', {'owner': 'fixture-owner', 'title': 'Task',
            'instanceId': 'fixture', 'allowedOrigins': ['http://fixture.localhost']})
        task = self.daemon.tasks[result['id']]
        task.update(state='needs_sync', lastActivityAt=1, createdAt=1, workTabs=[])
        return task

    def test_default_timeout_and_work_window_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            daemon = BridgeDaemon(Path(self.temp.name))
        self.assertEqual(daemon.task_idle_timeout_seconds, 1200)
        self.assertEqual(daemon.idle_close_seconds, 0)
        self.assertEqual(daemon.work_window_mode, 'separate')
        with patch.dict(os.environ, {'HERMES_BROWSER_WORK_WINDOW': 'current'}):
            self.assertEqual(BridgeDaemon(Path(self.temp.name)).work_window_mode, 'current')
        with patch.dict(os.environ, {'HERMES_BROWSER_WORK_WINDOW': 'invalid'}):
            with self.assertRaises(ValueError):
                BridgeDaemon(Path(self.temp.name))

    def test_hourly_cleanup_revokes_empty_old_needs_sync_only(self):
        old = self.task()
        fresh = self.task(); fresh['lastActivityAt'] = 100000
        paused = self.task(); paused['idleRecoveryState'] = 'paused'
        awaiting = self.task(); awaiting['idleRecoveryState'] = 'pending_approval'
        occupied = self.task(); occupied['workTabs'] = [{'tabId': 7, 'windowId': 1, 'groupId': 3}]
        unknown = self.task(); unknown['requestHistory'] = [{'action': 'new_tab', 'state': 'unknown'}]
        for task in (old, paused, awaiting, occupied, unknown):
            task['lastActivityAt'] = 1
        with patch('time.time', return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(old['state'], 'closed')
        self.assertEqual([fresh['state'], paused['state'], awaiting['state'], occupied['state'], unknown['state']], ['needs_sync'] * 5)
        fresh['lastActivityAt'] = 1
        with patch('time.time', return_value=100100):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(fresh['state'], 'needs_sync')
        with patch('time.time', return_value=103600):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(fresh['state'], 'closed')

    def test_stale_work_records_require_live_browser_proof(self):
        task = self.task(); task['workTabs'] = [{'tabId': 7, 'windowId': 1, 'groupId': 3}]
        calls = []
        def browser(_extension, method, params, **_):
            calls.append(method)
            return {'cleanupState': 'succeeded', 'remainingTabIds': [], 'preservedTabIds': [], 'unknownTabIds': []}
        self.daemon._extension_call = browser
        with patch('time.time', return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(task['state'], 'closed')
        self.assertEqual(calls, ['browser.cleanup_status'])

    def test_pending_human_task_is_not_cleaned(self):
        task = self.task()
        self.daemon.action_approvals[(task['id'], 'pending')] = {'taskId': task['id'], 'generation': task['generation'],
            'status': 'user_input_required', 'expiresAt': 100001}
        with patch('time.time', return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(task['state'], 'needs_sync')

    def test_session_count_includes_only_held_work_pages(self):
        a = self.task(); b = self.task()
        a.update(state='ready', tabIds=[7], agentTabIds=[7])
        b.update(state='ready', tabIds=[8, 9], agentTabIds=[8, 9])
        for tab, task in [(7, a), (8, b)]:
            self.daemon.tab_leases[('fixture', tab)] = task['id']
        self.assertEqual(self.daemon._public_task(a)['open_tabs'], 2)
        self.assertEqual(self.daemon._public_task(a)['workWindowMode'], 'separate')
        b['owner'] = 'other-session'
        self.assertEqual(self.daemon._public_task(a)['open_tabs'], 1)
        b['owner'] = a['owner']
        self.daemon.tab_leases.pop(('fixture', 8))
        self.assertEqual(self.daemon._public_task(a)['open_tabs'], 1)

    def test_no_effect_fields_survive_daemon_client_and_script_exception(self):
        data = {'effect': 'unobserved', 'suggestion': HINT, 'outcomeUnknown': True, 'retryable': False, 'secret': 'discard'}
        error = ProtocolError('click_no_effect', 'fixed', data)
        client = BridgeError(error.code, error.message, error.data)
        self.assertEqual(client.data, {k: v for k, v in data.items() if k != 'secret'})
        uncertain = ACTION.OutcomeUnknown('fixed', code=client.code, data=client.data)
        child = CHILD.BrowserError('fixed', code=uncertain.code, effect=uncertain.data['effect'], suggestion=uncertain.data['suggestion'])
        self.assertEqual((child.code, child.effect, child.suggestion), ('click_no_effect', 'unobserved', HINT))
        self.assertNotIn('suggestion', _safe_error_data({'suggestion': 'arbitrary page data'}))

    def test_observed_and_count_fields_survive_result_projection(self):
        for action in ('click', 'ref_click', 'ref_press', 'press', 'interaction.click'):
            result = RUNTIME._project_schema({'effect': 'observed', 'secret': 'discard'}, RUNTIME._RESULT_ACTIONS[action])
            self.assertEqual(result, {'effect': 'observed'})
        self.assertEqual(RUNTIME._project_schema({'tabId': 7, 'open_tabs': 8, 'tab_hint': '不再用的网站先 browser_shared_close'},
            RUNTIME._RESULT_ACTIONS['new_tab'])['open_tabs'], 8)

if __name__ == '__main__':
    unittest.main()
