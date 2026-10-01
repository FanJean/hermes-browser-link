"""中文注释：只用临时目录验证派发账本恢复与状态锁外持久化。"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
import daemon


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bridge = daemon.BridgeDaemon(Path(self.tmp.name))
        self.bridge._prepare_data_dir()
        self.task = {'id': 'task', 'owner': 'owner', 'generation': 1, 'state': 'running',
                     'instanceId': 'instance', 'tabIds': [7], 'agentTabIds': [7], 'requestHistory': []}
        self.entry = {'requestIdHash': hashlib.sha256(b'request').hexdigest(),
                      'payloadHash': hashlib.sha256(b'payload').hexdigest(),
                      'state': 'dispatched', 'dispatched': True, 'generation': 1}
        self.task['requestHistory'].append(self.entry)
        self.bridge.tasks['task'] = self.task
        self.addCleanup(self.bridge._flush_tasks)

    def restore(self):
        restored = daemon.BridgeDaemon(Path(self.tmp.name))
        restored._load_tasks()
        self.addCleanup(restored._flush_tasks)
        return restored

    def test_dispatch_survives_without_snapshot_and_never_restores_authority(self):
        self.bridge._persist_dispatched(self.task, self.entry)
        self.assertFalse(self.bridge.tasks_path.exists())
        restored = self.restore()
        self.assertEqual(restored.tasks['task']['state'], 'needs_sync')
        self.assertEqual(restored.tasks['task']['tabIds'], [])
        self.assertEqual(restored.dedupe['task'][self.entry['requestIdHash']], (self.entry['payloadHash'], None, None))
        self.assertNotIn(b'payload"', self.bridge.journal_path.read_bytes())

    def test_snapshot_and_newer_journal_merge_and_reject_hash_conflict(self):
        self.bridge._flush_tasks()
        second = {**self.entry, 'requestIdHash': hashlib.sha256(b'next').hexdigest()}
        self.bridge._persist_dispatched(self.task, second)
        self.assertEqual(len(self.restore().tasks['task']['requestHistory']), 2)
        wrong = {**second, 'payloadHash': 'f' * 64}
        self.bridge._persist_dispatched(self.task, wrong)
        with self.assertRaisesRegex(RuntimeError, 'fingerprint conflict'):
            self.restore()

    def test_snapshot_io_does_not_hold_state_lock_and_updates_coalesce(self):
        original = daemon._atomic_write_private
        calls = []
        def write(path, encoded):
            acquired = []
            def probe():
                with self.bridge.state_lock:
                    acquired.append(True)
            thread = threading.Thread(target=probe)
            thread.start(); thread.join(timeout=1)
            self.assertEqual(acquired, [True])
            calls.append(json.loads(encoded))
            original(path, encoded)
        with patch.object(daemon, '_atomic_write_private', write):
            for _ in range(10):
                self.bridge._persist_tasks()
            self.bridge._flush_tasks()
        self.assertEqual(len(calls), 1)

    def test_snapshot_compacts_journal_without_losing_dispatch_fingerprints(self):
        self.bridge._persist_dispatched(self.task, self.entry)
        self.assertTrue(self.bridge.journal_path.read_bytes())
        self.bridge._flush_tasks()
        self.assertEqual(self.bridge.journal_path.read_bytes(), b'')
        second = {**self.entry, 'requestIdHash': hashlib.sha256(b'after-compaction').hexdigest()}
        self.task['requestHistory'].append(second)
        self.bridge._persist_dispatched(self.task, second)
        restored = self.restore()
        self.assertEqual({row['requestIdHash'] for row in restored.tasks['task']['requestHistory']},
                         {self.entry['requestIdHash'], second['requestIdHash']})

    def test_partial_tail_is_removed_before_future_appends(self):
        self.bridge._persist_dispatched(self.task, self.entry)
        with self.bridge.journal_path.open('ab') as handle:
            handle.write(b'{"task":')
        restored = self.restore()
        self.assertTrue(restored.journal_path.read_bytes().endswith(b'\n'))
        second = {**self.entry, 'requestIdHash': hashlib.sha256(b'after-crash').hexdigest()}
        restored._persist_dispatched(restored.tasks['task'], second)
        self.assertEqual(len(self.restore().dedupe['task']), 2)

    # 中文注释：daemon 的超时分支也不得把滚动改写为只读失败。
    def test_scroll_timeout_preserves_unknown_outcome(self):
        self.task.update(state='ready', allowedOrigins=['https://example.test'], activeMode='full')
        self.task['requestHistory'] = []
        self.bridge.task_locks['task'] = threading.RLock()
        self.bridge.dedupe['task'] = {}
        self.bridge.extensions['instance'] = object()
        self.bridge.tab_leases[('instance', 7)] = 'task'
        self.bridge._best_effort_release = lambda *_: None
        def timeout(*_args, **_kwargs):
            raise daemon.ProtocolError('extension_timeout', '回执丢失', {'outcomeUnknown': True, 'retryable': False})
        self.bridge._extension_call = timeout
        with self.assertRaises(daemon.ProtocolError) as caught:
            self.bridge._run_task_impl({'owner': 'owner', 'taskId': 'task', 'requestId': 'scroll',
                                        'action': 'scroll', 'tabId': 7, 'direction': 'down'}, None, [])
        self.assertTrue(caught.exception.data['outcomeUnknown'])
        self.assertFalse(caught.exception.data['retryable'])
        # 中文注释：单个动作超时不改变代次、租约和标签归属；相同请求仍不得重放。
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.task['generation'], 1)
        self.assertEqual(self.bridge.tab_leases[('instance', 7)], 'task')
        self.assertEqual(self.task['tabIds'], [7])

    # 中文注释：宿主锁前的旧请求，即使用户很快继续也不得再派发。
    def test_takeover_epoch_rejects_queued_request_after_resume(self):
        from concurrent.futures import ThreadPoolExecutor
        self.task.update(state='ready', allowedOrigins=['https://example.test'], activeMode='full', title='任务', browser='chrome')
        self.task['requestHistory'] = []
        self.bridge.dedupe['task'] = {}
        self.bridge.extensions['instance'] = object()
        self.bridge.tab_leases[('instance', 7)] = 'task'
        self.bridge._notify_tasks_changed = lambda *_: None
        lock, waiting, main = threading.RLock(), threading.Event(), threading.current_thread()
        class Gate:
            def __enter__(self):
                if threading.current_thread() is not main:
                    waiting.set()
                lock.acquire()
            def __exit__(self, *_):
                lock.release()
        self.bridge.task_locks['task'] = Gate()
        sent = []
        self.bridge._extension_call = lambda *args, **kwargs: sent.append(args) or {'ok': True}
        lock.acquire()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.bridge._run_task_impl, {'owner':'owner','taskId':'task','requestId':'queued',
                                                             'action':'snapshot','tabId':7}, None, [])
            try:
                self.assertTrue(waiting.wait(1))
                paused = self.bridge._dispatch_extension('instance','extension.pause',{'taskId':'task','generation':1})
                self.assertEqual(paused['state'], 'paused')
                self.bridge._dispatch_extension('instance','extension.unpause',{'taskId':'task','generation':1})
            finally:
                lock.release()
            with self.assertRaises(daemon.ProtocolError) as caught:
                future.result(timeout=2)
            self.assertEqual(caught.exception.code, 'task_paused')
            self.assertFalse(caught.exception.data['retryable'])
        self.assertEqual(sent, [])

    def test_same_task_dispatches_two_tabs_and_rejects_inflight_replay(self):
        from concurrent.futures import ThreadPoolExecutor
        self.task.update(state='ready', allowedOrigins=['https://example.test'], activeMode='full')
        self.task['requestHistory'] = []
        self.bridge.task_locks['task'] = threading.RLock()
        self.bridge.dedupe['task'] = {}
        self.bridge.extensions['instance'] = object()
        self.bridge.tab_leases[('instance', 7)] = 'task'
        self.bridge.tab_leases[('instance', 8)] = 'task'
        started, finish = threading.Barrier(3), threading.Event()
        calls = []
        def extension(_extension, method, params):
            self.assertEqual(method, 'browser.execute')
            # 中文注释：进入扩展前，该请求必须已在 fsync 日志里。
            rows = [json.loads(line) for line in self.bridge.journal_path.read_bytes().splitlines()]
            hashed = hashlib.sha256(params['requestId'].encode()).hexdigest()
            self.assertTrue(any(row['entry']['requestIdHash'] == hashed for row in rows))
            calls.append(params['tabId'])
            started.wait(timeout=3)
            finish.wait(timeout=3)
            return {'text': 'bounded fixture'}
        self.bridge._extension_call = extension
        def params(tab):
            return {'owner': 'owner', 'taskId': 'task', 'requestId': str(tab), 'action': 'snapshot', 'tabId': tab}
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.bridge._run_task_impl, params(tab), None, []) for tab in (7, 8)]
            try:
                started.wait(timeout=3)
                with self.assertRaises(daemon.ProtocolError) as duplicate:
                    self.bridge._run_task_impl(params(7), None, [])
                self.assertEqual(duplicate.exception.code, 'request_outcome_unavailable')
                with self.assertRaises(daemon.ProtocolError) as conflict:
                    self.bridge._run_task_impl({**params(7), 'tabId': 8}, None, [])
                self.assertEqual(conflict.exception.code, 'request_id_conflict')
            finally:
                finish.set()
            for future in futures:
                self.assertEqual(future.result()['text'], 'bounded fixture')
        self.assertEqual(sorted(calls), [7, 8])
        self.assertEqual(self.task['state'], 'ready')
