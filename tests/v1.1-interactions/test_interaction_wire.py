"""C09 public-to-extension synthetic wire; no browser, installation, or existing tests changed."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/native-v2'))
from test_wire_contract import load
from test_daemon_wire import daemon_module


class InteractionWireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = load(ROOT / 'executor-plugin/native_tools.py', 'interaction_tools')
        cls.runtime_module = cls.tools.runtime_module()

    def setUp(self):
        scratch = Path.home() / '.hermes/cache/scratch'
        scratch.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(temp.cleanup)
        self.proc = subprocess.Popen(['node', str(Path(__file__).with_name('extension-fixture.mjs'))],
                                     cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.addCleanup(self.stop_child)
        self.daemon = daemon_module.BridgeDaemon(Path(temp.name))
        self.daemon._persist_tasks = lambda: None
        self.daemon._notify_tasks_changed = lambda _: None
        self.task = {'id':'task-v2','owner':'owner-v2','title':'synthetic','instanceId':'instance-v2',
                     'browser':'chrome','state':'ready','generation':4,'modeGeneration':1,
                     'allowedOrigins':['https://example.com'],
                     'tabIds':[7],'agentTabIds':[],'requestHistory':[],
                     'createdAt':time.time(),'updatedAt':time.time(),'isolation':'shared-profile'}
        self.daemon.tasks['task-v2'] = self.task
        self.daemon.task_locks['task-v2'] = daemon_module.threading.RLock()
        self.daemon.dedupe['task-v2'] = {}
        self.daemon.tab_leases[('instance-v2',7)] = 'task-v2'
        self.extension = {'instanceId':'instance-v2'}
        self.daemon.extensions['instance-v2'] = self.extension
        self.sent=[]
        def call(ext, method, params, timeout=15):
            self.assertIs(ext,self.extension)
            self.sent.append((method,params,timeout))
            value=self.rpc(method,params)
            if 'error' in value:
                err=value['error']
                self.last_extension_error=err
                raise daemon_module.ProtocolError(err['code'],err['message'],err.get('data'))
            return value['result']
        self.daemon._extension_call = call
        self.runtime = self.runtime_module.NativeProfileRuntime(
            Path(temp.name), ROOT / 'executor-plugin', bridge_client=type('Client',(),{
                'call':lambda _,method,params:self.daemon._dispatch_client(method,params)})())
        # Only this test's real trusted hook may issue owner leases.
        self.task['owner'] = self.runtime.authority.owner_for_session('native-v2-session')
        self.seq=0

    def stop_child(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        self.proc.stdin.close();self.proc.stdout.close();self.proc.stderr.close()

    def rpc(self, method, params=None, **extra):
        self.seq+=1
        self.proc.stdin.write(json.dumps({'id':self.seq,'method':method,'params':params or {},**extra})+'\n')
        self.proc.stdin.flush()
        line=self.proc.stdout.readline()
        if not line:
            self.fail('extension fixture exited: '+self.proc.stderr.read())
        response=json.loads(line)
        self.assertEqual(response['id'],self.seq)
        return response

    def control(self, op, value=None):
        return self.rpc('control',op=op,value=value)['result']

    def run_action(self, action, request_id, **extra):
        args={'task_id':'task-v2','tab_id':7,'action':action,'request_id':request_id,**extra}
        decision=self.runtime.authority.pre_tool_call('browser_shared_run',args,
                           session_id='native-v2-session',tool_call_id='lease-'+str(self.seq))
        self.assertEqual(decision['action'],'modify')
        args.update(decision['args'])
        return json.loads(self.tools.make_tool_handler('browser_shared_run',self.runtime)(args,session_id='native-v2-session'))

    def test_capture_bounds_click_traverse_public_hook_daemon_and_real_executor(self):
        actions=set(self.tools.TOOL_SCHEMAS['browser_shared_run']['parameters']['properties']['action']['enum'])
        self.assertTrue({'interaction.capture','interaction.bounds','interaction.click'} <= actions)
        shot=self.run_action('interaction.capture','capture')
        self.assertEqual(shot['image']['mimeType'],'image/png')
        bound=self.run_action('interaction.bounds','bounds',screenshot_id=shot['id'],selector='#button')
        self.assertEqual(bound['imageCenter'],{'x':20,'y':15})
        payload={'screenshot_id':shot['id'],'point':bound['imageCenter'],'expected_ref':bound['ref']}
        pending=self.run_action('interaction.click','click',**payload)
        self.assertEqual(pending['status'],'approval_required')
        self.assertEqual(self.control('noop')['commands'],0)
        request=self.daemon._dispatch_extension('instance-v2','extension.approvals',{})[0]
        self.assertEqual(request['request']['expectedRef'],bound['ref'])
        self.assertEqual(self.run_action('interaction.click','click',**payload),pending)
        self.assertEqual(self.control('noop')['commands'],0)
        # Decision is extension-owned. Its signed grant is installed by the extension channel.
        decision={'taskId':'task-v2','nonce':request['nonce'],'digest':request['digest'],'approve':True}
        self.control('approve',{'taskId':'task-v2','generation':4,'modeGeneration':1,
             'request':request['request'],'nonce':request['nonce'],'digest':request['digest'],
             'expiresAt':request['expiresAt']})
        self.daemon._dispatch_extension('instance-v2','extension.decide',decision)
        deadline=time.monotonic()+3
        while self.daemon.action_approvals and time.monotonic()<deadline:time.sleep(.01)
        self.assertFalse(self.daemon.action_approvals)
        self.assertEqual(self.run_action('interaction.click','click',**payload),{'ok':True,'kind':'coordinate-click','delivery':'confirmed','effect':'observed'},getattr(self,'last_extension_error',None))
        self.assertEqual(self.control('noop')['commands'],3)
        self.assertEqual(self.run_action('interaction.click','click',**payload),{'ok':True,'kind':'coordinate-click','delivery':'confirmed','effect':'observed'})
        self.assertEqual(self.control('noop')['commands'],3)

    def test_drag_modes_reach_real_executor_and_project_truthful_result(self):
        self.task.update(activeMode='full', modeGeneration=2)
        self.control('full')
        shot=self.run_action('interaction.capture','shot-drag')
        source=self.run_action('interaction.bounds','source',screenshot_id=shot['id'],selector='#source')
        target=self.run_action('interaction.bounds','target',screenshot_id=shot['id'],selector='#target')
        drag=self.run_action('interaction.drag_coordinates','drag',screenshot_id=shot['id'],
                 **{'from':{'point':source['imageCenter'],'expectedRef':source['ref']},
                    'to':{'point':target['imageCenter'],'expectedRef':target['ref']}},steps=4)
        self.assertEqual(drag['kind'],'pointer-drag')
        self.assertEqual(drag['delivery'],'confirmed')
        self.assertEqual(drag['steps'],4)
        self.assertEqual(drag['from'],{'x':20,'y':15})
        self.assertEqual(self.sent[-1][1]['from']['expectedRef'],source['ref'])
        self.assertEqual(self.control('noop')['commands'],7)
        second=self.run_action('interaction.capture','shot-html5')
        synthetic=self.run_action('interaction.drag_elements','html5',screenshot_id=second['id'],
                                  source='#source',target='#target',mode='html5-synthetic')
        self.assertEqual(synthetic,{'ok':True,'kind':'html5-synthetic','trusted':False})
        self.assertEqual(self.control('noop')['commands'],7)

    def test_smart_drag_requires_trusted_approval_before_input(self):
        shot=self.run_action('interaction.capture','smart-drag-shot')
        args=dict(screenshot_id=shot['id'],source='#source',target='#target',mode='html5-synthetic')
        pending=self.run_action('interaction.drag_elements','smart-drag',**args)
        self.assertEqual(pending['status'],'approval_required')
        self.assertEqual(self.run_action('interaction.drag_elements','smart-drag',**args),pending)
        self.assertEqual(self.control('noop')['commands'],0)
        approval=self.daemon._dispatch_extension('instance-v2','extension.approvals',{})[0]
        self.assertEqual(approval['request']['mode'],'html5-synthetic')

    def test_sensitive_capture_and_target_never_dispatch_input(self):
        self.control('sensitive',True)
        blocked=self.run_action('interaction.capture','sensitive-shot')
        self.assertNotIn('image',blocked)
        self.assertEqual(self.control('noop')['commands'],0)
        self.control('sensitive',False)
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','safe-shot')
        bound=self.run_action('interaction.bounds','safe-ref',screenshot_id=shot['id'],selector='#button')
        self.control('blocked',True)
        result=self.run_action('interaction.click','sensitive-click',screenshot_id=shot['id'],
                               point=bound['imageCenter'],expected_ref=bound['ref'])
        self.assertNotEqual(result.get('ok'),True)
        self.assertEqual(self.control('noop')['commands'],0)

    def test_stale_screenshot_and_unbound_target_fail_without_input(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','stale-shot')
        bound=self.run_action('interaction.bounds','stale-ref',screenshot_id=shot['id'],selector='#button')
        self.control('revision')
        self.assertNotEqual(self.run_action('interaction.click','changed',screenshot_id=shot['id'],
            point=bound['imageCenter'],expected_ref=bound['ref']).get('ok'),True)
        self.assertEqual(self.control('noop')['commands'],0)
        new=self.run_action('interaction.capture','fresh-shot')
        self.assertNotEqual(self.run_action('interaction.click','wrong-ref',screenshot_id=new['id'],
            point={'x':20,'y':15},expected_ref=bound['ref']).get('ok'),True)
        self.assertEqual(self.control('noop')['commands'],0)

    def test_read_only_bounds_error_is_not_an_unknown_write(self):
        self.run_action('interaction.capture','read-shot')
        result=self.run_action('interaction.bounds','missing-shot',screenshot_id='missing',selector='#button')
        self.assertFalse(result['outcome_unknown'])
        self.assertEqual(self.control('noop')['commands'],0)

    def test_expired_screenshot_is_rejected_before_drag_dispatch(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','ttl-shot')
        self.run_action('interaction.bounds','ttl-ref',screenshot_id=shot['id'],selector='#source')
        self.control('advance',31000)
        expired=self.run_action('interaction.drag_elements','ttl-drag',screenshot_id=shot['id'],
                                source='#source',target='#target')
        self.assertNotEqual(expired.get('ok'),True)
        self.assertEqual(self.control('noop')['commands'],0)

    def test_public_and_daemon_validation_reject_unknown_fields_and_malformed_coordinates(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        cases=[('interaction.click',{'screenshot_id':'s','point':{'x':True,'y':0},'expected_ref':'r'}),
               ('interaction.drag_coordinates',{'screenshot_id':'s','from':{'point':{'x':0,'y':1},'expectedRef':'r'},
                  'to':{'point':{'x':1,'y':2},'expectedRef':'r'},'mode':'html5-synthetic'}),
               ('interaction.drag_elements',{'screenshot_id':'s','source':'#a','target':'#b','mode':'javascript'}),
               ('interaction.capture',{'password':'secret'}),('raw_cdp',{}),('evaluate',{})]
        for index,(action,extra) in enumerate(cases):
            with self.subTest(action=action,index=index):
                self.assertEqual(self.run_action(action,'bad-'+str(index),**extra).get('code'),'invalid_fields')
        self.assertEqual(self.sent,[])
        with self.assertRaises(daemon_module.ProtocolError) as denied:
            self.daemon._dispatch_client('shared.run',dict(owner=self.task['owner'],taskId='task-v2',
                  requestId='direct',action='interaction.click',tabId=7,screenshotId='shot',
                  point={'x':float('nan'),'y':0},expectedRef='ref'))
        self.assertEqual(denied.exception.code,'invalid_params')

    def test_wrong_owner_tab_and_origin_do_not_dispatch(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','owner-shot')
        before=len(self.sent)
        with self.assertRaises(daemon_module.ProtocolError) as denied:
            self.daemon._dispatch_client('shared.run',dict(owner='attacker',taskId='task-v2',requestId='other',
                                               action='interaction.bounds',tabId=7,screenshotId=shot['id'],selector='#a'))
        self.assertEqual(denied.exception.code,'forbidden')
        self.assertEqual(self.run_action('interaction.bounds','foreign',tab_id=8,
                         screenshot_id=shot['id'],selector='#a').get('bridgeCode'),'foreign_tab')
        self.assertEqual(len(self.sent),before)
        self.control('origin')
        self.assertNotIn('image',self.run_action('interaction.capture','wrong-origin'))
        self.assertEqual(self.control('noop')['commands'],0)

    def test_mode_revocation_and_generation_change_fence_click_without_replay(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','rev-shot')
        bound=self.run_action('interaction.bounds','rev-bound',screenshot_id=shot['id'],selector='#button')
        self.task.update(activeMode='smart',modeGeneration=3);self.control('revoke')
        args=dict(screenshot_id=shot['id'],point=bound['imageCenter'],expected_ref=bound['ref'])
        pending=self.run_action('interaction.click','rev-click',**args)
        self.assertEqual(pending['status'],'approval_required')
        self.assertEqual(self.control('noop')['commands'],0)
        self.task.update(activeMode='full',modeGeneration=4)
        # The extension still has no full grant for the new mode generation.
        self.assertEqual(self.run_action('interaction.click','rev-click',**args),pending)
        self.control('generation')
        self.assertNotIn('image',self.run_action('interaction.capture','stale-gen'))
        self.assertEqual(self.control('noop')['commands'],0)

    def test_unknown_write_is_fenced_and_same_request_id_does_not_replay(self):
        self.task.update(activeMode='full',modeGeneration=2);self.control('full')
        shot=self.run_action('interaction.capture','unknown-shot')
        bound=self.run_action('interaction.bounds','unknown-bound',screenshot_id=shot['id'],selector='#button')
        args=dict(screenshot_id=shot['id'],point=bound['imageCenter'],expected_ref=bound['ref'])
        # 中文注释：单次超时只冻结请求；保留原传输以验证新请求仍可读取同一租约页。
        transport = self.daemon._extension_call
        sent=[]
        def dropped_response(extension,method,params,timeout=15):
            sent.append((method,params))
            raise daemon_module.ProtocolError('extension_timeout','synthetic response lost')
        self.daemon._extension_call=dropped_response
        self.daemon._best_effort_release=lambda *args: None
        first=self.run_action('interaction.click','unknown-click',**args)
        self.assertEqual(first.get('bridgeCode'),'extension_timeout')
        self.assertTrue(first['outcome_unknown'])
        second=self.run_action('interaction.click','unknown-click',**args)
        self.assertEqual(second.get('bridgeCode'),'extension_timeout')
        self.assertTrue(second['outcome_unknown'])
        self.assertEqual(len(sent),1)
        self.assertEqual(self.task['state'],'ready')
        self.assertEqual(self.task['generation'],4)
        self.assertEqual(self.daemon.tab_leases[('instance-v2',7)],'task-v2')
        self.daemon._extension_call = transport
        self.assertIn('image',self.run_action('interaction.capture','after-timeout'))
        self.assertEqual(self.control('noop')['commands'],0)
