"""中文注释：1c 的守护进程配置、步骤日志与恢复摘要离线测试。"""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
sys.path.insert(0, str(ROOT / 'browser-diagnostics/python'))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
from browser_diagnostics.schema import make_event  # noqa: E402


class FeaturesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.daemon = BridgeDaemon(self.home)
        self.daemon.extensions = {
            'chrome-1': {'instanceId': 'chrome-1', 'browser': 'chrome', 'version': '1.4.1', 'consentStatusSupported': True},
            'edge-1': {'instanceId': 'edge-1', 'browser': 'edge', 'version': '1.4.1', 'consentStatusSupported': True},
        }

    def test_primary_persists_across_profiles_and_marks_offline_instance(self):
        with patch.object(self.daemon, '_notify_tasks_changed'), patch.object(
                self.daemon, '_extension_call', return_value={'consentStatus': 'enabled'}):
            self.assertEqual(self.daemon._dispatch_client('ui.set_primary', {'instanceId': 'edge-1'}),
                             {'instanceId': 'edge-1', 'browser': 'edge'})
            rows = self.daemon._dispatch_client('browser.list', {})
        self.assertTrue(next(row for row in rows if row['instanceId'] == 'edge-1')['primary'])
        self.assertFalse(next(row for row in rows if row['instanceId'] == 'chrome-1')['primary'])
        another_profile = BridgeDaemon(self.home)
        self.assertEqual(another_profile._primary_browser(), {'instanceId': 'edge-1', 'browser': 'edge'})
        self.daemon.extensions.pop('edge-1')
        with patch.object(self.daemon, '_extension_call', return_value={'consentStatus': 'enabled'}):
            offline = self.daemon._dispatch_client('browser.list', {})
        self.assertFalse(next(row for row in offline if row['primary'])['connected'])
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client('ui.set_primary', {'instanceId': 'missing'})

    def test_log_excludes_input_values_and_prunes_old_files(self):
        operation = {'action': 'ref_fill', 'state': 'failed', 'startedAt': 1780000000,
                     'durationMs': 12, 'errorCode': 'element_timeout', 'text': 'secret-value',
                     'pageBody': 'private-page-body'}
        self.daemon._append_task_log('task-1', operation)
        rows = self.daemon._read_task_log('task-1', 5)
        self.assertEqual(rows[0]['result'], 'element_timeout')
        self.assertEqual(rows[0]['target'], 'textbox · 名称未提供')
        self.daemon._append_task_log('task-1', operation, {'role': 'textbox', 'name': '产品名称'})
        self.assertEqual(self.daemon._read_task_log('task-1', 1)[0]['target'], 'textbox · 产品名称')
        self.daemon._append_task_log('task-1', operation, {'role': 'textbox', 'name': '敏感字段'})
        self.assertEqual(self.daemon._read_task_log('task-1', 1)[0]['target'], '敏感字段')
        self.assertNotIn('secret-value', json.dumps(rows))
        self.assertNotIn('private-page-body', json.dumps(rows))
        old = self.daemon.task_log_dir / ('a' * 64 + '.jsonl')
        old.write_text('{}\n')
        import os
        os.utime(old, (1, 1))
        self.daemon._prune_task_logs()
        self.assertFalse(old.exists())
        oversized = self.daemon.task_log_dir / ('b' * 64 + '.jsonl')
        oversized.write_bytes(b' ' * (10 * 1024 * 1024 + 1))
        self.daemon._prune_task_logs()
        self.assertLessEqual(sum(path.stat().st_size for path in self.daemon.task_log_dir.glob('*.jsonl')),
                             10 * 1024 * 1024)
        self.assertEqual(make_event(component='native_bridge', event_type='request_state',
                                    status='failed', action='ref_fill', error_code='element_timeout')['error_code'],
                         'element_timeout')

    def test_resume_summary_accepts_only_structural_flags(self):
        task = {'id': 'task-1', 'owner': 'owner-1', 'instanceId': 'chrome-1', 'generation': 2,
                'state': 'paused', 'updatedAt': 0}
        self.daemon.tasks[task['id']] = task
        self.daemon.task_locks[task['id']] = threading.RLock()
        changes = {'urlChanged': True, 'documentReplaced': False,
                   'referencesInvalid': True, 'readPageFirst': True}
        with patch.object(self.daemon, '_notify_tasks_changed'):
            result = self.daemon._dispatch_extension('chrome-1', 'extension.unpause',
                                                     {'taskId': 'task-1', 'generation': 2, 'changes': changes})
        self.assertEqual(result['resumeSummary'], changes)
        self.assertEqual(task['state'], 'ready')
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension('chrome-1', 'extension.unpause',
                                            {'taskId': 'task-1', 'generation': 2,
                                             'changes': {**changes, 'pageText': 'secret'}})


if __name__ == '__main__':
    unittest.main()
