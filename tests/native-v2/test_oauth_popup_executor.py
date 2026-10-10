"""Popup public contract, script selection and private Vault eligibility."""
import importlib.util
import ast
from pathlib import Path
import sys
import types
import threading
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'executor-plugin'))
sys.path.insert(0,str(ROOT/'native-bridge'))
import native_runtime
native_tools=native_runtime.load_module(ROOT/'executor-plugin/native_tools.py','oauth_native_tools_')
action=native_runtime.load_module(ROOT/'executor-plugin/script_lane/action_session.py','oauth_action_session_')
vault=native_runtime.load_module(ROOT/'native-bridge/vault_private.py','oauth_vault_private_')
from vault_adapter.integration import VaultBindingRegistry
from vault_adapter.adapter import VaultAdapter

class ExecutorPopupTests(unittest.TestCase):
    def test_popup_close_restores_current_script_tab_and_reads_new_source_document(self):
        task = {'id': 'task', 'instanceId': 'instance', 'generation': 1, 'state': 'ready',
                'tabIds': [1, 2], 'workTabs': [{'tabId': 1}], 'adoptedPopupTabIds': [2], 'popupSources': {'2': 1}}
        calls = []
        def call(method, params):
            calls.append((method, params))
            if method == 'shared.get': return task
            return {'binding': {'documentId': 'fresh-source'}, 'tabId': params['tabId']}
        session = action.ActionSession(types.SimpleNamespace(call=call), owner='owner', task_id='task')
        session.install_scope('instance', 1)
        session.use_tab(2)
        self.assertIs(session.for_tab(2), session)
        task.update(tabIds=[1], adoptedPopupTabIds=[], popupReturns={'2': 1})
        result = session.run('semantic_snapshot', {})
        self.assertEqual(result['popupClosed'], {'returnedTo': 1})
        self.assertEqual(result['tabId'], 1)
        self.assertEqual(result['binding']['documentId'], 'fresh-source')
        self.assertEqual(session.current_tab(), 1)
        self.assertEqual([p['tabId'] for method, p in calls if method == 'shared.run'], [1])

    def test_popup_return_does_not_cross_generation_or_foreign_source(self):
        task = {'id': 'task', 'instanceId': 'instance', 'generation': 1, 'state': 'ready',
                'tabIds': [1, 2], 'workTabs': [{'tabId': 1}], 'adoptedPopupTabIds': [2], 'popupSources': {'2': 1}}
        session = action.ActionSession(types.SimpleNamespace(call=lambda *args: task), owner='owner', task_id='task')
        session.install_scope('instance', 1);session.use_tab(2)
        task.update(tabIds=[1], popupReturns={'2': 1}, generation=2)
        self.assertEqual(session.current_tab(), 2)
        task.update(generation=1, tabIds=[3], popupReturns={'2': 3})
        self.assertEqual(session.current_tab(), 2)

    def test_explicit_adopted_popup_passes_vault_binding_and_private_scope_not_script_conflict(self):
        task={'id':'task','owner':'owner','instanceId':'instance','generation':1,'state':'ready','modeGeneration':2,'activeMode':'full','allowedOrigins':['https://accounts.example.test'],'tabIds':[1,2,3],'agentTabIds':[1],'workTabs':[{'tabId':1}], 'adoptedPopupTabIds':[2]}
        runtime=types.SimpleNamespace(authority=types.SimpleNamespace(owner_for_session=lambda *args:'owner'),call=lambda method,p:task if method=='shared.get' else [{'instanceId':'instance','connected':True}])
        registry=VaultBindingRegistry(runtime,types.SimpleNamespace(revoke_binding=lambda *args:None))
        registry.bind('session',owner='owner',task_id='task',tab_id=2)
        adapter=VaultAdapter(runtime,registry,None,None)
        self.assertEqual(adapter._scope('session').tab_id,2)
        daemon=types.SimpleNamespace(state_lock=threading.RLock(),tasks={'task':task},tab_leases={('instance',2):'task'},extensions={'instance':{}})
        private=object.__new__(vault.VaultPrivateService);private.daemon=daemon
        scope={'sessionId':'session','owner':'owner','taskId':'task','instanceId':'instance','generation':1,'modeGeneration':2,'tabId':2,'allowedOrigins':task['allowedOrigins']}
        self.assertEqual(private._scope(scope)[0],task)
        task['scriptedTabs']=[2]
        with self.assertRaisesRegex(ValueError,'conflict'):private._scope(scope)
        with self.assertRaises(ValueError):registry.bind('session',owner='owner',task_id='task',tab_id=3)
    def test_child_helpers_forward_source_tab_scoped_candidate_ref(self):
        tree=ast.parse((ROOT/'executor-plugin/script_lane/child.py').read_text())
        functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'popup_catalog','popup_adopt'}]
        self.assertEqual(len(functions),2)
        calls=[];scope={'_tab_scoped':lambda fn:fn,'_call':lambda *args:calls.append(args)}
        exec(compile(ast.Module(body=functions,type_ignores=[]),'child.py','exec'),scope)
        scope['popup_catalog']();scope['popup_adopt']('ref-2')
        self.assertEqual(calls,[('run',['popup_catalog',{}]),('run',['popup_adopt',{'candidateRef':'ref-2'}])])
    def test_public_validator_exposes_candidate_ref_not_approval_authority(self):
        args={'task_id':'task','action':'popup_adopt','tab_id':1,'candidate_ref':'ref-2'}
        native_tools._validate('browser_shared_run',args)
        with self.assertRaises(native_tools.ArgumentFieldsError):
            native_tools._validate('browser_shared_run',{**args,'popupScope':{}})
    def test_public_contract_and_script_selection_allow_only_explicit_adopted_popup(self):
        self.assertIn('popup_catalog',native_tools.PUBLIC_ACTIONS)
        self.assertIn('popup_adopt',native_tools.PUBLIC_ACTIONS)
        schema=native_tools.TOOL_SCHEMAS['browser_shared_run']['parameters']
        self.assertIn('candidate_ref',schema['properties'])
        self.assertEqual(action.ActionSession.SCRIPT_ACTIONS['popup_adopt'],frozenset({'candidateRef'}))
        task={'id':'task','instanceId':'instance','generation':1,'state':'ready','tabIds':[1,2,3],'workTabs':[{'tabId':1}], 'adoptedPopupTabIds':[2]}
        runtime=types.SimpleNamespace(call=lambda *args:task)
        session=action.ActionSession(runtime,owner='owner',task_id='task');session.install_scope('instance',1)
        self.assertEqual(session.use_tab(2),2)
        with self.assertRaises(action.ActionRejected):session.use_tab(3)
        self.assertEqual(task['workTabs'],[{'tabId':1}])

class DaemonPopupPeerTests(unittest.TestCase):
    """Review probes promoted to daemon -> real Bridge/Executor regressions."""
    def setUp(self):
        import json
        import os
        import subprocess
        import tempfile
        import time
        self.json=json
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.peer=subprocess.Popen(['node',str(ROOT/'tests/v1.1-concurrency/bridge_executor_peer.mjs'),'--oauth-fixture'],
                                   stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        self.addCleanup(self.close_peer)
        self.module=native_runtime.load_module(ROOT/'native-bridge/daemon.py','oauth_peer_daemon_')
        d=self.daemon=self.module.BridgeDaemon(Path(self.temp.name))
        self.addCleanup(d._flush_tasks)
        self.task={'id':'task','owner':'owner','instanceId':'instance','state':'ready','generation':1,
                   'activeMode':'full','modeGeneration':2,'allowedOrigins':['https://example.com'],
                   'tabIds':[1],'agentTabIds':[],'workTabs':[],'requestHistory':[],
                   'createdAt':time.time(),'updatedAt':time.time()}
        d.tasks['task']=self.task;d.task_locks['task']=threading.RLock();d.dedupe['task']={}
        d.tab_leases[('instance',1)]='task'
        d.extensions['instance']={'instanceId':'instance','pendingLock':threading.Lock(),'pending':{}}
        d._notify_tasks_changed=lambda *args:None
        self.calls=[]
        def send(extension,message):
            self.calls.append(message)
            response=self.rpc(op='rpc',message=message)
            self.assertTrue(d._accept_extension_response(extension,response))
        d._send_extension=send

    def close_peer(self):
        self.peer.stdin.close()
        try:self.peer.wait(timeout=10)
        finally:
            if self.peer.poll() is None:self.peer.kill();self.peer.wait()
            self.peer.stdout.close()

    def rpc(self,**params):
        self.peer.stdin.write(self.json.dumps(params)+'\n');self.peer.stdin.flush()
        line=self.peer.stdout.readline()
        self.assertTrue(line,'synthetic peer unexpectedly closed')
        reply=self.json.loads(line)
        self.assertTrue(reply['ok'],reply.get('error'))
        return reply['result']

    def catalog(self,request_id='catalog'):
        params={'owner':'owner','taskId':'task','requestId':request_id,'action':'popup_catalog','tabId':1}
        return params,self.daemon._run_task(params)

    def prepare_adoption(self):
        _,catalog=self.catalog('prepare-catalog')
        params={'owner':'owner','taskId':'task','requestId':'adopt','action':'popup_adopt','tabId':1,
                'candidateRef':catalog['candidates'][0]['candidateRef']}
        self.assertEqual(self.daemon._run_task(params)['status'],'approval_required')
        pending=next(row for row in self.daemon.action_approvals.values() if row['params']['requestId']=='adopt')
        pending['status']='approved'
        grant={key:pending[key] for key in ('nonce','digest','expiresAt','generation','modeGeneration','popupScope')}
        grant.update(taskId='task',request={key:value for key,value in params.items() if key!='owner'})
        self.rpc(op='grant',approval=grant)
        return params,pending

    def approve_and_wait(self,pending):
        # 中文注释：走用户实际批准入口，不能只验证绕过 worker 的内部执行器。
        pending['status']='approval_required'
        done=threading.Event()
        worker=self.daemon._approval_worker
        def traced_worker(*args):
            try:worker(*args)
            finally:done.set()
        self.daemon._approval_worker=traced_worker
        decision=self.daemon._dispatch_extension('instance','extension.decide',{
            'taskId':'task','nonce':pending['nonce'],'digest':pending['digest'],'approve':True})
        self.assertEqual(decision,{'status':'approved'})
        self.assertTrue(done.wait(5),'approval worker did not finish')

    def assert_no_popup_success_replay(self,params):
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError) as error:self.daemon._run_task(params)
        self.assertEqual(error.exception.code,'request_outcome_unavailable')
        self.assertFalse(error.exception.data['retryable'])
        self.assertEqual(len(self.calls),before,'never resend adoption to revalidate')

    def assert_unknown_adoption_released(self,enabled):
        self.rpc(op='settings',enabled=enabled)
        params,pending=self.prepare_adoption()
        self.rpc(op='settings',enabled=enabled,toggleAtSend=True)
        with self.assertRaises(self.module.ProtocolError) as error:
            self.daemon._run_task(params,_approval=pending)
        self.assertEqual(error.exception.code,'content_shield_stale')
        self.assertTrue(error.exception.data['outcomeUnknown'])
        state=self.rpc(op='state')
        self.assertEqual(state['leases'],[],state)
        self.assertTrue(state['revoked'])
        self.assertEqual(state['overlays'],[])
        self.assertIn(2,state['overlayUninstalls'])
        self.assertIn(2,state['detached'])
        self.assertEqual(state['removed'],[])
        self.assertEqual([(tab['id'],tab['windowId']) for tab in state['present']],[(1,7),(2,8)])
        self.assertEqual(self.task['state'],'needs_sync')
        self.assertEqual(self.daemon.tab_leases,{})
        self.assertEqual(self.task['adoptedPopupTabIds'],[])
        self.assertNotIn(2,self.task['agentTabIds'])
        self.assertFalse(self.rpc(op='vault')['allowed'])
        private=object.__new__(vault.VaultPrivateService);private.daemon=self.daemon
        with self.assertRaises(ValueError):
            private._scope({'sessionId':'session','owner':'owner','taskId':'task','instanceId':'instance',
                            'generation':1,'modeGeneration':2,'tabId':2,'allowedOrigins':['https://accounts.example.test']})
        for kind in ('takeover','stop'):
            control=self.rpc(op='control',kind=kind,host=self.daemon._public_task(self.task))
            self.assertEqual(control,{'reply':{'state':'unknown'},'calls':[]})
        releases=[message['params'] for message in self.calls if message['method']=='browser.release']
        self.assertEqual(releases,[{'taskId':'task','generation':1,'closeAgentTabs':False}])
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError):self.daemon._run_task(params)
        self.assertEqual(len(self.calls),before)
        self.daemon._flush_tasks()
        saved=self.json.loads(self.daemon.tasks_path.read_text())['tasks'][0]
        row=next(row for row in saved['requestHistory'] if row.get('action')=='popup_adopt')
        self.assertEqual(row['state'],'unknown')
        restarted=self.module.BridgeDaemon(Path(self.temp.name))
        self.addCleanup(restarted._flush_tasks)
        restarted._load_tasks()
        self.assertIn('task',restarted.tasks)
        with self.assertRaises(self.module.ProtocolError) as replay:restarted._run_task(params)
        self.assertEqual(replay.exception.code,'request_outcome_unavailable')
        self.assertEqual(len(self.calls),before)

    def test_withheld_adoption_shield_enabling_releases_without_deletion(self):
        self.assert_unknown_adoption_released(False)

    def test_withheld_adoption_shield_disabling_releases_without_deletion(self):
        self.assert_unknown_adoption_released(True)

    def test_successful_popup_actual_background_takeover_and_stop_controls(self):
        params,pending=self.prepare_adoption()
        self.assertTrue(self.daemon._run_task(params,_approval=pending)['adopted'])
        host=self.daemon._public_task(self.task)
        takeover=self.rpc(op='control',kind='takeover',host=host)
        self.assertEqual(takeover['reply']['state'],'paused')
        self.assertIn('extension.pause',[row['method'] for row in takeover['calls']])
        host['state']='paused'
        stop=self.rpc(op='control',kind='stop',host=host)
        self.assertEqual(stop['reply']['state'],'stopped')
        self.assertIn('extension.stop',[row['method'] for row in stop['calls']])
        self.assertEqual(self.rpc(op='state')['removed'],[])

    def intercept_adoption_receipt(self,after):
        d=self.daemon
        def send(extension,message):
            self.calls.append(message)
            response=self.rpc(op='rpc',message=message)
            if message['method']=='browser.execute' and message['params']['action']=='popup_adopt':
                after(response)
            self.assertTrue(d._accept_extension_response(extension,response))
        d._send_extension=send

    def assert_released_state(self):
        state=self.rpc(op='state')
        self.assertTrue(state['revoked'])
        self.assertEqual(state['leases'],[])
        self.assertEqual(state['overlays'],[])
        self.assertEqual(state['removed'],[])
        self.assertEqual([tab['id'] for tab in state['present']],[1,2])
        self.assertFalse(self.rpc(op='vault')['allowed'])
        return state

    def test_mode_changed_after_successful_adoption_releases_old_qualification(self):
        params,pending=self.prepare_adoption()
        self.intercept_adoption_receipt(lambda response:self.task.update(modeGeneration=3))
        with self.assertRaises(self.module.ProtocolError) as error:
            self.daemon._run_task(params,_approval=pending)
        self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assert_released_state()
        self.assertEqual(self.task['state'],'needs_sync')
        self.assertEqual(self.daemon.tab_leases,{})

    def test_generation_changed_after_success_releases_only_old_extension_generation(self):
        params,pending=self.prepare_adoption()
        self.intercept_adoption_receipt(lambda response:self.task.update(generation=2,state='ready'))
        with self.assertRaises(self.module.ProtocolError):self.daemon._run_task(params,_approval=pending)
        self.assert_released_state()
        self.assertEqual((self.task['generation'],self.task['state']),(2,'ready'))
        self.assertEqual(self.daemon.tab_leases,{('instance',1):'task'})

    def test_late_success_does_not_revoke_concurrently_renewed_extension_generation(self):
        params,pending=self.prepare_adoption()
        def renew(response):
            self.rpc(op='renew',generation=2)
            self.task.update(generation=2,state='ready')
        self.intercept_adoption_receipt(renew)
        with self.assertRaises(self.module.ProtocolError):self.daemon._run_task(params,_approval=pending)
        state=self.rpc(op='state')
        self.assertFalse(state['revoked'])
        self.assertEqual(state['generation'],2)
        self.assertEqual(state['leases'],[[1,'task']])
        self.assertEqual(state['removed'],[])
        self.assertEqual((self.task['generation'],self.task['state']),(2,'ready'))
        releases=[row['params'] for row in self.calls if row['method']=='browser.release']
        self.assertEqual(releases,[{'taskId':'task','generation':1,'closeAgentTabs':False}])

    def test_source_lease_revoked_before_success_receipt_cannot_publish_popup(self):
        params,pending=self.prepare_adoption()
        self.intercept_adoption_receipt(lambda response:self.daemon.tab_leases.pop(('instance',1)))
        with self.assertRaises(self.module.ProtocolError) as error:self.daemon._run_task(params,_approval=pending)
        self.assertEqual(error.exception.code,'invalid_extension_result')
        self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assert_released_state()
        self.assertEqual(self.daemon.tab_leases,{})
        self.assertNotIn(2,self.task['tabIds'])

    def test_adoption_timeout_revokes_and_late_receipt_cannot_revive(self):
        params,pending=self.prepare_adoption()
        d=self.daemon;extension=d.extensions['instance'];late=[]
        def send(ext,message):
            self.calls.append(message)
            response=self.rpc(op='rpc',message=message)
            if message['method']=='browser.execute' and message['params']['action']=='popup_adopt':
                late.append(response)
            else:self.assertTrue(d._accept_extension_response(ext,response))
        d._send_extension=send
        original=d._extension_call
        d._extension_call=lambda ext,method,p,timeout=15:original(ext,method,p,timeout=0.01 if method=='browser.execute' else timeout)
        with self.assertRaises(self.module.ProtocolError) as error:d._run_task(params,_approval=pending)
        self.assertEqual(error.exception.code,'extension_timeout')
        self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assert_released_state()
        self.assertEqual(self.task['state'],'needs_sync')
        before=len(self.calls)
        self.assertTrue(d._accept_extension_response(extension,late[0]))
        self.assert_released_state()
        with self.assertRaises(self.module.ProtocolError):d._run_task(params)
        self.assertEqual(len(self.calls),before)

    def test_invalid_adoption_receipt_releases_real_extension_lease(self):
        params,pending=self.prepare_adoption()
        self.intercept_adoption_receipt(lambda response:response['result'].update(cleanupOwned=True))
        with self.assertRaises(self.module.ProtocolError) as error:self.daemon._run_task(params,_approval=pending)
        self.assertEqual(error.exception.code,'invalid_extension_result')
        self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assert_released_state()
        self.assertEqual(self.task['state'],'needs_sync')

    def test_unknown_old_receipt_does_not_revoke_renewed_generation(self):
        params,pending=self.prepare_adoption()
        self.rpc(op='settings',enabled=False,toggleAtSend=True)
        def renew(response):
            self.assertEqual(response['error']['code'],'content_shield_stale')
            self.rpc(op='renew',generation=2)
            self.task.update(generation=2,state='ready')
        self.intercept_adoption_receipt(renew)
        with self.assertRaises(self.module.ProtocolError):self.daemon._run_task(params,_approval=pending)
        state=self.rpc(op='state')
        self.assertEqual((state['generation'],state['revoked']),(2,False))
        self.assertEqual(state['leases'],[[1,'task']])
        self.assertEqual((self.task['generation'],self.task['state']),(2,'ready'))
        self.assertEqual(self.daemon.tab_leases,{('instance',1):'task'})
        self.assertEqual(state['removed'],[])

    def assert_unknown_adoption_not_replayed(self,params):
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError) as error:self.daemon._run_task(params)
        self.assertEqual(error.exception.code,'request_outcome_unavailable')
        self.assertEqual(error.exception.data,{})
        self.assertEqual(len(self.calls),before)

    def change_takeover_state(self,unpause=False):
        self.daemon._dispatch_extension('instance','extension.pause',{'taskId':'task','generation':1})
        self.assertEqual(self.task['state'],'paused')
        if unpause:
            self.daemon._dispatch_extension('instance','extension.unpause',{'taskId':'task','generation':1})
            self.assertEqual(self.task['state'],'ready')

    def assert_unknown_takeover_adoption(self,params):
        state=self.assert_released_state()
        self.assertEqual([(tab['id'],tab['windowId']) for tab in state['present']],[(1,7),(2,8)])
        self.assertEqual(state['present'][1]['openerTabId'],1)
        for tab_id in (1,2):
            self.assertIn(tab_id,state['overlayUninstalls'])
            self.assertIn(tab_id,state['detached'])
        host=self.daemon._dispatch_client('shared.get',{'owner':'owner','taskId':'task'})
        self.assertEqual((host['generation'],host['state']),(1,'needs_sync'))
        self.assertEqual(self.daemon.tab_leases,{})
        for key in ('tabIds','agentTabIds','adoptedPopupTabIds'):
            self.assertEqual(self.task[key],[])
        private=object.__new__(vault.VaultPrivateService);private.daemon=self.daemon
        for tab_id in (1,2):
            with self.assertRaises(ValueError):
                private._scope({'sessionId':'session','owner':'owner','taskId':'task','instanceId':'instance',
                                'generation':1,'modeGeneration':2,'tabId':tab_id,
                                'allowedOrigins':['https://accounts.example.test']})
        for kind in ('takeover','resume','stop'):
            self.assertEqual(self.rpc(op='control',kind=kind,host=host),{'reply':{'state':'unknown'},'calls':[]})
        releases=[row['params'] for row in self.calls if row['method']=='browser.release']
        self.assertEqual(releases,[{'taskId':'task','generation':1,'closeAgentTabs':False}])
        self.assertEqual(self.daemon._operation_status({'owner':'owner','taskId':'task','requestId':'adopt'})['state'],'unknown')
        self.assert_unknown_adoption_not_replayed(params)
        self.daemon._flush_tasks()
        saved=self.json.loads(self.daemon.tasks_path.read_text())['tasks'][0]
        row=next(row for row in saved['requestHistory'] if row.get('action')=='popup_adopt')
        self.assertEqual((row['state'],row['dispatched']),('unknown',True))
        restarted=self.module.BridgeDaemon(Path(self.temp.name))
        self.addCleanup(restarted._flush_tasks)
        restarted._load_tasks()
        with self.assertRaises(self.module.ProtocolError) as replay:restarted._run_task(params)
        self.assertEqual(replay.exception.code,'request_outcome_unavailable')
        before=len(self.calls)
        resumed=self.daemon._dispatch_client('shared.resume',{'owner':'owner','taskId':'task'})
        self.assertEqual((resumed['generation'],resumed['state']),(2,'pending_approval'))
        with self.assertRaises(self.module.ProtocolError) as preparing:self.daemon._run_task(params)
        self.assertEqual(preparing.exception.code,'task_preparing')
        self.assertEqual(self.daemon._operation_status({'owner':'owner','taskId':'task','requestId':'adopt'})['state'],'unknown')
        self.assertEqual(len(self.calls),before)
        self.assert_released_state()

    def assert_takeover_receipt_failure(self,unpause,error_kind):
        params,pending=self.prepare_adoption()
        def change(response):
            self.change_takeover_state(unpause)
            if error_kind=='exception':raise RuntimeError('adapter failed after adoption and takeover')
            if error_kind=='protocol':
                raise self.module.ProtocolError('extension_disconnected','receipt unavailable',{'outcomeUnknown':True})
        self.intercept_adoption_receipt(change)
        if error_kind=='exception':
            with self.assertRaisesRegex(RuntimeError,'adapter failed after adoption and takeover'):
                self.daemon._run_task(params,_approval=pending)
        else:
            with self.assertRaises(self.module.ProtocolError) as error:self.daemon._run_task(params,_approval=pending)
            self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assert_unknown_takeover_adoption(params)

    def test_pause_then_unexpected_adoption_exception_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(False,'exception')

    def test_pause_unpause_then_unexpected_adoption_exception_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(True,'exception')

    def test_pause_then_late_adoption_success_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(False,'success')

    def test_pause_unpause_then_late_adoption_success_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(True,'success')

    def test_pause_then_adoption_protocol_error_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(False,'protocol')

    def test_pause_unpause_then_adoption_protocol_error_revokes_same_generation(self):
        self.assert_takeover_receipt_failure(True,'protocol')

    def test_unexpected_adoption_exception_does_not_revoke_renewed_generation(self):
        params,pending=self.prepare_adoption()
        def renew(response):
            self.rpc(op='renew',generation=2)
            self.task.update(generation=2,state='ready')
            raise RuntimeError('adapter failed after generation renewal')
        self.intercept_adoption_receipt(renew)
        self.approve_and_wait(pending)
        state=self.rpc(op='state')
        self.assertEqual((state['generation'],state['revoked']),(2,False))
        self.assertEqual(state['leases'],[[1,'task']])
        self.assertEqual((self.task['generation'],self.task['state'],self.task['modeGeneration']),(2,'ready',2))
        self.assertEqual(self.daemon.tab_leases,{('instance',1):'task'})
        self.assertEqual(state['removed'],[])
        releases=[row['params'] for row in self.calls if row['method']=='browser.release']
        self.assertEqual(releases,[{'taskId':'task','generation':1,'closeAgentTabs':False}])
        self.assert_unknown_adoption_not_replayed(params)

    def assert_terminal_adoption_exception(self,final_state):
        params,pending=self.prepare_adoption()
        self.daemon.cleanup_locks['task']=threading.RLock()
        def finish(response):
            self.daemon._release_task({'owner':'owner','taskId':'task'},final_state,False)
            raise RuntimeError('adapter failed after task termination')
        self.intercept_adoption_receipt(finish)
        self.approve_and_wait(pending)
        self.assertEqual((self.task['generation'],self.task['state'],self.task['modeGeneration']),(1,final_state,3))
        self.assertEqual(self.daemon.tab_leases,{})
        self.assert_released_state()
        releases=[row['params'] for row in self.calls if row['method']=='browser.release']
        self.assertEqual(releases,[{'taskId':'task','generation':1,'closeAgentTabs':False}]*2)
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError) as closed:self.daemon._run_task(params)
        self.assertEqual(closed.exception.code,'task_closed')
        self.assertEqual(len(self.calls),before)
        self.assertEqual(self.daemon._operation_status({'owner':'owner','taskId':'task','requestId':'adopt'})['state'],'unknown')

    def test_unexpected_adoption_exception_preserves_cancelled_state(self):
        self.assert_terminal_adoption_exception('cancelled')

    def test_unexpected_adoption_exception_preserves_closed_state(self):
        self.assert_terminal_adoption_exception('closed')

    def test_approval_worker_exception_revokes_same_generation_without_duplicate_release(self):
        params,pending=self.prepare_adoption()
        def broken(response):raise RuntimeError('adapter failed after approved adoption')
        self.intercept_adoption_receipt(broken)
        self.approve_and_wait(pending)
        self.assert_unknown_takeover_adoption(params)

    def test_unexpected_transport_failure_after_adoption_releases_without_replay(self):
        params,pending=self.prepare_adoption()
        def broken(response):raise RuntimeError('synthetic adapter failed after adoption')
        self.intercept_adoption_receipt(broken)
        with self.assertRaisesRegex(RuntimeError,'synthetic adapter failed'):
            self.daemon._run_task(params,_approval=pending)
        self.assert_released_state()
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError):self.daemon._run_task(params)
        self.assertEqual(len(self.calls),before)
        self.assert_unknown_takeover_adoption(params)

    def test_catalog_cached_success_rejected_after_both_shield_toggle_directions(self):
        for enabled in (False,True):
            with self.subTest(enabled=enabled):
                self.rpc(op='settings',enabled=enabled)
                params,result=self.catalog('catalog-'+str(enabled))
                self.assertEqual(len(result['candidates']),1)
                self.rpc(op='settings',enabled=not enabled)
                self.assert_no_popup_success_replay(params)

    def test_adopted_receipt_shield_changes_and_restart_never_replay_success(self):
        params,pending=self.prepare_adoption()
        self.assertTrue(self.daemon._run_task(params,_approval=pending)['adopted'])
        for enabled in (True,False):
            self.rpc(op='settings',enabled=enabled)
            self.assert_no_popup_success_replay(params)
        self.daemon._flush_tasks()
        restarted=self.module.BridgeDaemon(Path(self.temp.name))
        self.addCleanup(restarted._flush_tasks)
        restarted._load_tasks()
        self.assertIn('task',restarted.tasks)
        before=len(self.calls)
        with self.assertRaises(self.module.ProtocolError) as error:restarted._run_task(params)
        self.assertEqual(error.exception.code,'request_outcome_unavailable')
        self.assertEqual(len(self.calls),before)

    def test_unchanged_success_is_one_shot_but_fresh_catalog_is_legal(self):
        params,_=self.catalog()
        self.assert_no_popup_success_replay(params)
        self.assertEqual(len(self.catalog('fresh-catalog')[1]['candidates']),1)
        params,pending=self.prepare_adoption()
        self.assertTrue(self.daemon._run_task(params,_approval=pending)['adopted'])
        self.assert_no_popup_success_replay(params)
        self.assertEqual(self.daemon._operation_status({'owner':'owner','taskId':'task','requestId':'adopt'})['state'],'confirmed')

if __name__=='__main__':unittest.main()
