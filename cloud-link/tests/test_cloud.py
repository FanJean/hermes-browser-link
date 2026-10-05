"""云端身份、范围和去重回归；不访问个人浏览器。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'cloud-link'))
from runtime.capabilities import native_tools, schemas
from runtime.executor import CloudDenied, CloudExecutor
from runtime import client as client_module

class FakeBridge:
    # 中文注释：合成桥保留 owner 校验，检查停止云端时是否触碰本地任务。
    def __init__(self):
        self.tasks = {'local-task': {'id': 'local-task', 'owner': 'local-owner', 'instanceId': 'paired-browser',
                                     'allowedOrigins': ['https://example.com'], 'state': 'ready'}}
        self.calls = []
    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == 'shared.create':
            task = {'id': 'cloud-task', **params, 'state': 'ready', 'generation': 1, 'tabIds': [], 'browser': 'chrome'}
            self.tasks['cloud-task'] = task
            return task
        if method == 'shared.list':
            return [row for row in self.tasks.values() if row['owner'] == params['owner']]
        task = self.tasks[params['taskId']]
        if task['owner'] != params['owner']: raise PermissionError('foreign_owner')
        if method == 'shared.get': return task
        if method == 'shared.run': return {'tabId': 8, 'url': 'https://example.com', 'secretToken': 'must-not-leak'}
        if method == 'shared.handoff': task.update(state='closed',cleanupState='succeeded'); return task
        raise AssertionError(method)
    def close(self): pass

class CloudTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='hbl-cloud-')
        self.addCleanup(self.scratch.cleanup)
        self.path = Path(self.scratch.name)
        self.bridge = FakeBridge()
        self.executor = CloudExecutor(self.path / 'home', self.path / 'cloud', 'device-a', 'paired-browser',
                                      ['https://example.com'], client=self.bridge)
        self.addCleanup(self.executor.close)
    def command(self, tool, args, **extra):
        return {'id': 'command-a', 'device_id': 'device-a', 'session_id': 'cloud-session-a',
                'expires_at': time.time() + 20, 'tool': tool, 'args': args, **extra}
    def create(self):
        return self.executor.execute(self.command('create', {'title': '测试', 'allowed_origins': ['https://example.com']}))
    def test_cloud_owner_and_shutdown_leave_local_task_unchanged(self):
        self.assertEqual(self.create()['id'], 'cloud-task')
        self.assertNotEqual(self.bridge.tasks['cloud-task']['owner'], 'local-owner')
        self.executor.close()
        self.assertEqual(self.bridge.tasks['local-task']['state'], 'ready')
        self.assertEqual(self.bridge.tasks['cloud-task']['state'], 'closed')
        self.assertFalse(any(p.get('owner') == 'local-owner' for _, p in self.bridge.calls))
    def test_idle_close_removes_work_pages_but_disconnect_hands_them_back(self):
        # 中文注释：闲置和正常断线分开验证，所有清理仍仅限本云端 owner。
        self.create()
        self.assertTrue(self.executor.handoff_session('cloud-session-a', keep_tabs=False))
        calls=[params for method,params in self.bridge.calls if method=='shared.handoff']
        self.assertFalse(calls[-1]['keepTabs'])
        self.assertEqual(self.bridge.tasks['local-task']['state'],'ready')
        self.create()
        self.assertTrue(self.executor.handoff_session('cloud-session-a'))
        calls=[params for method,params in self.bridge.calls if method=='shared.handoff']
        self.assertTrue(calls[-1]['keepTabs'])

    def test_shutdown_reclaims_creation_that_finishes_after_first_scan(self):
        # 中文注释：首轮扫描尚无任务时，关闭必须等在途创建结束并再次核实回收。
        entered,release=threading.Event(),threading.Event()
        original=self.bridge.call
        def call(method,params):
            if method=='shared.create':entered.set();release.wait(3)
            return original(method,params)
        self.bridge.call=call
        worker=threading.Thread(target=self.create);worker.start();self.assertTrue(entered.wait(1))
        closed=[]
        closer=threading.Thread(target=lambda:closed.extend(self.executor.close(sessions=['cloud-session-a'])))
        closer.start()
        deadline=time.monotonic()+1
        while not self.executor._closed and time.monotonic()<deadline:time.sleep(.005)
        self.assertTrue(closer.is_alive());release.set();worker.join(2);closer.join(2)
        self.assertFalse(worker.is_alive());self.assertFalse(closer.is_alive())
        self.assertEqual(closed,['cloud-session-a']);self.assertEqual(self.bridge.tasks['cloud-task']['state'],'closed')
        self.assertEqual(self.bridge.tasks['local-task']['state'],'ready')
    def test_cloud_cannot_choose_owner_device_browser_or_unpaired_origin(self):
        for args, extra in [({'owner': 'local-owner'}, {}), ({'instance_id': 'other'}, {}),
                            ({'title': 'x', 'allowed_origins': ['https://other.test']}, {}),
                            ({}, {'device_id': 'device-b'})]:
            with self.subTest(args=args, extra=extra), self.assertRaises(CloudDenied):
                self.executor.execute(self.command('create', args, **extra))
        self.assertEqual(self.bridge.calls, [])
    def test_local_task_and_other_cloud_session_do_not_grant_access(self):
        self.create()
        with self.assertRaises(PermissionError): self.executor.execute(self.command('get', {'task_id': 'local-task'}))
        with self.assertRaises(PermissionError): self.executor.execute(self.command('get', {'task_id': 'cloud-task'}, session_id='other-cloud-session'))
        self.assertEqual(self.bridge.tasks['local-task']['state'], 'ready')
    def test_cloud_result_reuses_existing_privacy_projection(self):
        self.create()
        result = self.executor.execute(self.command('run', {'task_id': 'cloud-task', 'action': 'new_tab', 'url': 'https://example.com'}))
        self.assertEqual(result['tabId'], 8)
        self.assertNotIn('secretToken', json.dumps(result))
        self.assertEqual(self.bridge.calls[-1][1]['requestId'], 'command-a')
    def test_approval_waits_for_confirmed_ledger_before_reading_receipt(self):
        self.create()
        original = self.bridge.call
        states = iter(['awaiting_approval', 'dispatched', 'confirmed'])
        runs = []
        def call(method, params):
            # 中文注释：模拟审批线程仍在派发，提前读回执会失败，且不得重复派发。
            if method == 'shared.operation_status':
                return {'state': next(states)}
            if method == 'shared.run':
                runs.append(params['requestId'])
                if len(runs) == 1:
                    return {'status': 'approval_required', 'approvalId': 'approval-a'}
                return {'tabId': 8, 'url': 'https://example.com'}
            return original(method, params)
        self.bridge.call = call
        with patch('runtime.executor.time.sleep'):
            result = self.executor.execute(self.command('run', {'task_id': 'cloud-task', 'action': 'new_tab', 'url': 'https://example.com'}))
        self.assertEqual(result['tabId'], 8)
        self.assertEqual(runs, ['command-a', 'command-a'])
    def test_schema_export_does_not_mutate_local_schemas(self):
        before = json.dumps(native_tools.TOOL_SCHEMAS, sort_keys=True)
        cloud = schemas()
        self.assertNotIn('instance_id', cloud['create']['properties'])
        self.assertNotIn('files.upload', cloud['run']['properties']['action']['enum'])
        self.assertEqual(before, json.dumps(native_tools.TOOL_SCHEMAS, sort_keys=True))
    def test_journal_does_not_replay_duplicate_crashed_or_changed_command(self):
        class Counter:
            calls = 0
            def execute(self, command): self.calls += 1; return {'ok': True}
        journal = client_module.Journal(self.path / 'requests.sqlite'); self.addCleanup(journal.db.close)
        counter = Counter(); command = self.command('list', {})
        self.assertEqual(journal.execute(command, counter), {'ok': True})
        self.assertEqual(journal.execute(command, counter), {'ok': True})
        self.assertEqual(counter.calls, 1)
        with self.assertRaises(ValueError): journal.execute({**command, 'args': {'task_id': 'modified'}}, counter)
        crashed = {**command, 'id': 'crashed'}
        digest = hashlib.sha256(json.dumps(crashed, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        journal.db.execute('INSERT INTO commands(id,digest) VALUES(?,?)', ('crashed', digest)); journal.db.commit()
        restored = client_module.Journal(self.path / 'requests.sqlite'); self.addCleanup(restored.db.close)
        self.assertTrue(restored.execute(crashed, counter)['outcome_unknown']); self.assertEqual(counter.calls, 1)
    def test_private_config_rejects_symlinks_and_non_https(self):
        target = self.path / 'real.json'; target.write_text('{}'); target.chmod(0o600)
        link = self.path / 'linked.json'; link.symlink_to(target)
        with self.assertRaises(OSError): client_module.load_config(link)
        for site in ('http://relay.test', 'https://user:password@relay.test', 'https://relay.test/path'):
            with self.assertRaises(ValueError): client_module.origin(site)

if __name__ == '__main__': unittest.main()
