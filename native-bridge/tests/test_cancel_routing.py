"""Exercise public cancellation routing, not the release helper alone."""
import tempfile
import unittest
from pathlib import Path
from daemon import BridgeDaemon, ProtocolError


class CancelRoutingTests(unittest.TestCase):
    def test_takeover_pauses_same_generation_without_releasing_tabs(self):
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._prepare_data_dir()
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': '接管测试', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
            internal = daemon.tasks[task['id']]
            internal.update(state='ready', tabIds=[7], activeMode='full')
            daemon.tab_leases[('browser', 7)] = task['id']
            # 中文注释：暂停期间同一页租约保留，动作被拒绝且请求 ID 不被占用。
            paused = daemon._dispatch_extension('browser', 'extension.pause', {'taskId': task['id'], 'generation': task['generation']})
            self.assertEqual(paused['state'], 'paused')
            self.assertEqual(daemon.tab_leases[('browser', 7)], task['id'])
            with self.assertRaises(ProtocolError) as caught:
                daemon._dispatch_client('shared.run', {'owner': 'owner', 'taskId': task['id'], 'requestId': 'after-pause', 'action': 'tabs'})
            self.assertEqual(caught.exception.code, 'task_paused')
            self.assertEqual(daemon.dedupe[task['id']], {})
            resumed = daemon._dispatch_extension('browser', 'extension.unpause', {'taskId': task['id'], 'generation': task['generation']})
            self.assertEqual(resumed['state'], 'ready')
            self.assertEqual(resumed['generation'], task['generation'])
            self.assertEqual(daemon.tab_leases[('browser', 7)], task['id'])

    def test_failed_run_and_late_disconnected_result_preserve_tabs(self):
        for outcome in ('extension_timeout', 'extension_disconnected', 'workspace_unknown', 'unexpected', 'invalid_result', 'late_disconnect'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as directory:
                daemon = BridgeDaemon(Path(directory))
                daemon._prepare_data_dir()
                daemon._persist_tasks = lambda: None
                daemon._notify_tasks_changed = lambda instance_id: None
                daemon.extensions['browser'] = {'browser': 'chrome'}
                task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': 'failure', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
                internal = daemon.tasks[task['id']]
                internal.update(state='ready', activeMode='full')
                releases = []
                def extension_call(extension, method, params, timeout=15):
                    if method == 'browser.release':
                        releases.append(params)
                        return {'released': True}
                    if outcome == 'unexpected':
                        raise RuntimeError('adapter failed')
                    if outcome == 'invalid_result':
                        return {}
                    if outcome == 'late_disconnect':
                        daemon._revoke_task_locked(internal, 'needs_sync')
                        return {'tabId': 99}
                    raise ProtocolError(outcome, 'uncertain execution')
                daemon._extension_call = extension_call
                with self.assertRaises((ProtocolError, RuntimeError)):
                    daemon._dispatch_client('shared.run', {'owner': 'owner', 'taskId': task['id'], 'requestId': 'run', 'action': 'new_tab', 'url': 'https://example.test'})
                self.assertTrue(releases)
                self.assertTrue(all(p['closeAgentTabs'] is False for p in releases))

    def test_approval_worker_failure_preserves_tabs(self):
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._prepare_data_dir()
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda instance_id: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': 'worker', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
            def fail(*args, **kwargs):
                raise RuntimeError('worker failed')
            daemon._run_task = fail
            releases = []
            daemon._extension_call = lambda extension, method, params, timeout=15.0: releases.append(params)
            daemon._approval_worker((task['id'], 'request'), {'params': {}, 'digest': 'digest'})
            self.assertIs(releases[0]['closeAgentTabs'], False)

    def test_extension_stop_only_revokes_daemon_state_without_nested_rpc(self):
        # The extension already completed its local release. A synchronous
        # callback here deadlocks the same connection's response reader.
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._prepare_data_dir()
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda instance_id: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': 'stop', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
            daemon._extension_call = lambda *args, **kwargs: self.fail('nested RPC on extension reader')
            result = daemon._dispatch_extension('browser', 'extension.stop', {'taskId': task['id']})
            self.assertEqual(result['state'], 'cancelled')
            self.assertEqual(daemon.tab_leases, {})

    def test_cancel_fences_task_and_requests_bounded_owned_tab_cleanup(self):
        with tempfile.TemporaryDirectory(dir=Path.home() / '.hermes/cache/scratch') as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._prepare_data_dir()
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            task = daemon._dispatch_client('shared.create', {'owner': 'owner', 'title': 'cancel', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
            calls = []
            def extension_call(extension, method, params, **kwargs):
                self.assertEqual(daemon.tasks[task['id']]['state'], 'cancelled')
                calls.append((method, params, kwargs))
                self.assertIs(params['closeAgentTabs'], True)
                raise OSError('disconnected during cleanup')
            daemon._extension_call = extension_call
            result = daemon._dispatch_client('shared.cancel', {'owner': 'owner', 'taskId': task['id']})
            self.assertEqual(result['state'], 'cancelled')
            self.assertEqual(calls[0][0], 'browser.release')
            self.assertIs(calls[0][1]['closeAgentTabs'], True)
            self.assertGreater(calls[0][2]['timeout'], 0)
            self.assertLessEqual(calls[0][2]['timeout'], 5)
