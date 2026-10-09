"""Approval execution integration; real daemon, isolated persistence."""
import sys, tempfile, unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native-bridge'))
from daemon import BridgeDaemon, ProtocolError

class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.d = BridgeDaemon(Path(self.temp.name))
        self.d._prepare_data_dir()
        self.d.extensions['browser'] = {'browser':'chrome'}
        self.d._notify_tasks_changed = lambda _: None
        self.executed = []
        self.d._extension_call = lambda ext, method, p, **kw: self.executed.append(p) or {'ok': True}
        self.t = self.task('alice', 1)
    def tearDown(self): self.temp.cleanup()
    def task(self, owner, tab):
        t=self.d._dispatch_client('shared.create', dict(owner=owner,title=owner,instanceId='browser',allowedOrigins=['https://example.com']))
        return self.d._dispatch_extension('browser','extension.approve',dict(taskId=t['id'],tabIds=[tab],allowedOrigins=t['allowedOrigins']))
    def params(self, **extra):
        return dict(owner='alice',taskId=self.t['id'],requestId='r1',action='click',tabId=1,selector='#send',**extra)
    def test_smart_action_is_pending_without_execution_or_lock(self):
        result=self.d._dispatch_client('shared.run',self.params())
        self.assertEqual(result.get('status'), 'approval_required')
        self.assertEqual(self.executed, [])
        self.assertTrue(self.d.task_locks[self.t['id']].acquire(blocking=False))
        self.d.task_locks[self.t['id']].release()
        self.assertEqual(self.d._dispatch_client('shared.run',self.params()), result)
        self.assertNotIn('nonce', str(result))

    def test_nonce_decision_runs_once_and_rejects_digest_swap(self):
        self.d._dispatch_client('shared.run', self.params())
        pending=self.d._dispatch_extension('browser','extension.approvals',{})[0]
        decision=dict(taskId=self.t['id'],nonce=pending['nonce'],digest='wrong',approve=True)
        with self.assertRaises(ProtocolError): self.d._dispatch_extension('browser','extension.decide',decision)
        decision['digest']=pending['digest']
        self.d._dispatch_extension('browser','extension.decide',decision)
        with self.assertRaises(ProtocolError): self.d._dispatch_extension('browser','extension.decide',decision)
        for _ in range(100):
            if self.executed: break
            time.sleep(.01)
        self.assertEqual(len(self.executed),1)
        self.assertEqual(self.d._dispatch_client('shared.run',self.params()),{'ok':True})
        self.assertEqual(len(self.executed),1)

    def test_smart_js_approval_roundtrip_and_rejection(self):
        # 中文注释：脚本请求沿用 daemon 审批往返；拒绝不派发，批准只派发一次。
        command = dict(owner='alice', taskId=self.t['id'], requestId='smart-js-1',
                       action='js.evaluate', tabId=1, expression='1 + 1')
        self.assertEqual(self.d._dispatch_client('shared.run', command)['status'], 'approval_required')
        pending = self.d._dispatch_extension('browser', 'extension.approvals', {})[0]
        self.assertEqual(pending['request']['action'], 'js.evaluate')
        self.d._dispatch_extension('browser', 'extension.decide', dict(taskId=self.t['id'], nonce=pending['nonce'],
            digest=pending['digest'], approve=False))
        with self.assertRaises(ProtocolError) as denied:
            self.d._dispatch_client('shared.run', command)
        self.assertEqual(denied.exception.code, 'approval_denied')
        self.assertEqual(self.executed, [])
        command['requestId'] = 'smart-js-2'
        self.assertEqual(self.d._dispatch_client('shared.run', command)['status'], 'approval_required')
        pending = self.d._dispatch_extension('browser', 'extension.approvals', {})[0]
        self.d._dispatch_extension('browser', 'extension.decide', dict(taskId=self.t['id'], nonce=pending['nonce'],
            digest=pending['digest'], approve=True))
        for _ in range(100):
            if self.executed: break
            time.sleep(.01)
        self.assertEqual(len(self.executed), 1)
        self.assertEqual(self.d._dispatch_client('shared.run', command), {'ok': True})
        self.assertEqual(len(self.executed), 1)

    def mode(self, mode):
        task=self.d.tasks[self.t['id']]
        return self.d._dispatch_extension('browser','extension.mode',dict(taskId=task['id'],mode=mode,generation=task['generation'],modeGeneration=task.get('modeGeneration',1)))
    def test_full_mode_is_ui_only_revoke_clears_pending_and_restart_smart(self):
        with self.assertRaises(ProtocolError): self.d._dispatch_client('extension.mode',dict(taskId=self.t['id'],mode='full'))
        self.assertEqual(self.mode('full')['activeMode'],'full')
        self.assertEqual(self.d._dispatch_client('shared.run', self.params()), {'ok':True})
        self.assertEqual(self.mode('smart')['activeMode'],'smart')
        p=self.params();p['requestId']='r2'
        self.assertEqual(self.d._dispatch_client('shared.run',p)['status'],'approval_required')
        self.mode('full')
        with self.assertRaises(ProtocolError) as e: self.d._dispatch_client('shared.run',p)
        self.assertEqual(e.exception.code,'approval_revoked')
        restarted=BridgeDaemon(Path(self.temp.name));restarted._load_tasks()
        self.assertEqual(restarted.tasks[self.t['id']]['activeMode'],'smart')
    def test_pending_does_not_block_other_owner_and_boundaries_stay_on(self):
        self.d._dispatch_client('shared.run', self.params())
        other=self.task('bob',2)
        # 中文注释：另一任务已完成连接授权；Alice 的兼容审批不得阻塞 Bob 的普通读取。
        self.d._dispatch_extension('browser','extension.mode',dict(taskId=other['id'],mode='full',
            generation=other['generation'],modeGeneration=other.get('modeGeneration',1)))
        self.assertEqual(self.d._dispatch_client('shared.run',dict(owner='bob',taskId=other['id'],requestId='read',action='snapshot',tabId=2)),{'ok':True})
        self.mode('full')
        p=self.params();p['owner']='bob'
        with self.assertRaises(ProtocolError) as e: self.d._dispatch_client('shared.run',p)
        self.assertEqual(e.exception.code,'forbidden')
        p=self.params();p['tabId']=2;p['requestId']='foreign'
        with self.assertRaises(ProtocolError) as e: self.d._dispatch_client('shared.run',p)
        self.assertEqual(e.exception.code,'foreign_tab')
    def test_expiry_is_terminal_and_page_request_uses_smart_approval(self):
        self.d.approval_ttl=-1
        self.d._dispatch_client('shared.run',self.params())
        self.assertEqual(self.d._dispatch_extension('browser','extension.approvals',{}),[])
        with self.assertRaises(ProtocolError) as e: self.d._dispatch_client('shared.run',self.params())
        self.assertEqual(e.exception.code,'approval_expired')
        self.d.approval_ttl=120
        # 中文注释：同源页面请求不再要求独立 API 授权，但智能审批仍需单次确认。
        request=dict(owner='alice',taskId=self.t['id'],requestId='api',action='api_request',tabId=1,url='https://example.com/api',fields=['ok'])
        self.assertEqual(self.d._dispatch_client('shared.run',request)['status'],'approval_required')

    def test_unexpected_worker_failure_is_unknown_not_replayable(self):
        self.d._dispatch_client('shared.run',self.params())
        pending=self.d._dispatch_extension('browser','extension.approvals',{})[0]
        def broken(*args,**kw): raise RuntimeError('transport exploded after send')
        self.d._extension_call=broken
        self.d._dispatch_extension('browser','extension.decide',dict(taskId=self.t['id'],nonce=pending['nonce'],digest=pending['digest'],approve=True))
        for _ in range(100):
            if not self.d.action_approvals: break
            time.sleep(.01)
        with self.assertRaises(ProtocolError) as e: self.d._dispatch_client('shared.run',self.params())
        self.assertEqual(e.exception.code,'request_outcome_unavailable')
        self.assertEqual(self.d.tasks[self.t['id']]['state'],'needs_sync')

if __name__=='__main__': unittest.main()
