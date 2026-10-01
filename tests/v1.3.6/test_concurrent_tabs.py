"""中文注释：真实 daemon + Executor/NativeWorkspaces 管道回归，不绑定 socket 或启动浏览器。"""
import concurrent.futures
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/native-v2'))
from test_daemon_wire import daemon_module


class ConcurrentTabsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='parallel-tabs-')
        self.addCleanup(temp.cleanup)
        self.daemon = daemon_module.BridgeDaemon(Path(temp.name))
        self.daemon._persist_tasks = lambda: None
        self.daemon._notify_tasks_changed = lambda _: None
        self.task = dict(id='parallel', owner='owner', title='parallel', instanceId='fixture-browser-instance',
                         browser='chrome', state='ready', generation=1, modeGeneration=2, activeMode='full',
                         allowedOrigins=['https://example.com'], tabIds=[], agentTabIds=[], requestHistory=[],
                         createdAt=time.time(), updatedAt=time.time(), isolation='shared-profile')
        self.daemon.tasks['parallel'] = self.task
        self.daemon.task_locks['parallel'] = threading.RLock()
        self.daemon.dedupe['parallel'] = {}
        self.daemon.extensions[self.task['instanceId']] = {}
        self.proc = subprocess.Popen(['node', str(Path(__file__).with_name('concurrent-extension.mjs'))],
                                     cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.addCleanup(self.stop)
        self.pending, self.events, self.sequence = {}, [], 0
        self.sent = []
        self.write_lock = threading.Lock()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.daemon._extension_call = lambda _ext, method, params, **_kw: self.rpc(method, params)
        self.daemon._best_effort_release = lambda *_args: None

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)
        self.reader.join(timeout=5)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()

    def read(self):
        # 中文注释：先处理关闭通知，再交付同一管道上的动作回执，复现真实通知抢先到达。
        for line in self.proc.stdout:
            value = json.loads(line)
            if 'event' in value:
                try:
                    self.daemon._handle_tab_event(self.task['instanceId'], value['event'])
                except daemon_module.ProtocolError as error:
                    self.events.append(error.code)
            else:
                self.pending[value['id']].put(value)

    def rpc(self, method, params):
        with self.write_lock:
            self.sequence += 1
            if method == "browser.execute" and params.get("action") == "new_tab":
                self.sent.append(params["url"])
            seq = self.sequence
            response = self.pending[seq] = queue.Queue()
            self.proc.stdin.write(json.dumps(dict(id=seq, method=method, params=params))+'\n')
            self.proc.stdin.flush()
        value = response.get(timeout=15)
        if 'error' in value:
            error = value['error']
            raise daemon_module.ProtocolError(error['code'], error['message'], error.get('data'))
        return value['result']

    def run_action(self, request, action='new_tab', **params):
        return self.daemon._dispatch_client('shared.run', dict(owner='owner', taskId='parallel',
                                            requestId=request, action=action, **params))

    def check_batch(self, count):
        self.run_action('initial', url='https://example.com/initial')
        def run(index):
            try:
                return self.run_action(f'page-{index}', url=f'https://example.com/{index}')
            except daemon_module.ProtocolError as error:
                return {'error': error.code, 'message': error.message}
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            results = list(pool.map(run, range(count)))
        self.assertFalse([r for r in results if 'error' in r], results)
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.events, [])
        inspected = self.rpc('inspect', {})
        self.assertEqual(len(inspected['tabs']), 4)
        self.assertLessEqual(inspected['peak'], 4)
        self.assertEqual([row['url'] for row in inspected['creates']], self.sent)
        self.assertEqual(set(self.task['agentTabIds']), set(inspected['tabs']))
        self.assertEqual(set(self.task['tabIds']), set(inspected['tabs']))
        self.assertEqual({tab for (instance, tab), owner in self.daemon.tab_leases.items() if owner == 'parallel'}, set(inspected['tabs']))
        self.assertEqual(len(self.run_action('after', action='tabs')), 4)
        navigated = self.run_action('navigate-after', action='navigate', tabId=inspected['tabs'][-1], url='https://example.com/after')
        self.assertEqual(navigated['url'], 'https://example.com/after')
        self.assertEqual(self.task['state'], 'ready')

    def test_four_concurrent_new_tabs(self):
        self.check_batch(4)

    def test_eight_concurrent_new_tabs(self):
        self.check_batch(8)

    def test_late_receipt_cannot_restore_recycled_tab(self):
        # 中文注释：刻意延迟前几个回执，后续关闭通知和回收回执先进入 daemon。
        call = self.daemon._extension_call
        def delayed(ext, method, params, **kwargs):
            result = call(ext, method, params, **kwargs)
            if params.get('requestId') in {'page-0', 'page-1'}:
                time.sleep(.4)
            return result
        self.daemon._extension_call = delayed
        self.check_batch(8)

    def test_moved_tab_conflict_only_rejects_new_request(self):
        for index in range(4):
            result = self.run_action(f'initial-{index}', url=f'https://example.com/{index}')
            if index == 0:
                oldest = result['tabId']
        self.rpc('move', {'tabId': oldest})
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.run_action('conflict', url='https://example.com/conflict')
        self.assertEqual(caught.exception.code, 'task_busy')
        self.assertFalse(caught.exception.data['outcomeUnknown'])
        self.assertEqual(self.task['state'], 'ready')
        inspected = self.rpc('inspect', {})
        self.assertNotIn(oldest, inspected['removed'])
        self.assertEqual(len(inspected['creates']), 4)
        self.assertEqual(len(self.run_action('still-ready', action='tabs')), 4)

    def test_mode_change_rejects_late_result_without_task_release(self):
        call = self.daemon._extension_call
        releases = []
        self.daemon._best_effort_release = lambda *args: releases.append(args)
        def changed(ext, method, params, **kwargs):
            result = call(ext, method, params, **kwargs)
            self.task['modeGeneration'] += 1
            return result
        self.daemon._extension_call = changed
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.run_action('changed', url='https://example.com/')
        self.assertEqual(caught.exception.code, 'task_busy')
        self.assertTrue(caught.exception.data['outcomeUnknown'])
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(releases, [])
        self.assertEqual(self.task['tabIds'], [])

    def test_foreign_lease_conflict_keeps_both_tasks_authority(self):
        # 中文注释：冲突回执不能覆盖另一任务租约，也不能撤销本任务已成功的页。
        initial = self.run_action('initial', url='https://example.com/')
        self.daemon.tab_leases[(self.task['instanceId'], 999)] = 'other-task'
        self.daemon._extension_call = lambda *_args, **_kw: {'tabId': 999}
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.run_action('collision', url='https://example.com/')
        self.assertEqual(caught.exception.code, 'task_busy')
        self.assertTrue(caught.exception.data['outcomeUnknown'])
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.task['tabIds'], [initial['tabId']])
        self.assertEqual(self.daemon.tab_leases[(self.task['instanceId'], 999)], 'other-task')

    def test_extension_creation_collision_is_unknown_only_for_this_request(self):
        # 中文注释：真实工作区适配器检测到创建 ID 撞租约时，也不能降级整个任务。
        self.rpc('collision', {})
        with self.assertRaises(daemon_module.ProtocolError) as caught:
            self.run_action('collision', url='https://example.com/')
        self.assertEqual(caught.exception.code, 'task_busy')
        self.assertTrue(caught.exception.data['outcomeUnknown'])
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.task['tabIds'], [])
        opened = self.run_action('after-collision', url='https://example.com/after')
        self.assertIn(opened['tabId'], self.task['tabIds'])

    def test_unregistered_close_requires_matching_inflight_creation(self):
        # 中文注释：不能用任意关闭通知、旧代次或另一任务租约伪造回收证明。
        for generation, request_id in [(1, 'not-dispatched'), (0, 'old')]:
            with self.assertRaises(daemon_module.ProtocolError):
                self.daemon._handle_tab_event(self.task['instanceId'], dict(taskId='parallel',
                    generation=generation, tabId=999, event='closed', documentGeneration=1,
                    creationRequestId=request_id))
        self.assertEqual(self.task.get('retiredAgentTabs', {}), {})
        self.assertEqual(self.task['state'], 'ready')

    def test_generation_change_and_origin_denial_remain_fenced(self):
        with self.assertRaises(daemon_module.ProtocolError):
            self.run_action('foreign', url='https://evil.test/')
        self.assertEqual(len(self.rpc('inspect', {})['creates']), 0)
        call = self.daemon._extension_call
        def changed(ext, method, params, **kwargs):
            result = call(ext, method, params, **kwargs)
            self.task['generation'] += 1
            return result
        self.daemon._extension_call = changed
        with self.assertRaises(daemon_module.ProtocolError):
            self.run_action('old-generation', url='https://example.com/')
        self.assertEqual(self.task['tabIds'], [])


if __name__ == '__main__':
    unittest.main()
