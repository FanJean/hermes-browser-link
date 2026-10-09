"""通信线程必须在任务等待期间保持在线，关闭后释放自己的线程与锁。"""
from pathlib import Path
from urllib.error import HTTPError, URLError
import sys
import json
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from runtime.client import load_config,private_directory,save_config
from runtime.service import CloudService
from runtime.executor import CloudExecutor
from runtime.scheduler import Scheduler
from test_cloud import FakeBridge


# 中文注释：实际部署的 Store + 内存 SQLite 经 JSON 管道连接 Native，禁止用人工 active mock 代替协议。
STORE_SCRIPT = r"""
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Store, Denied } from './cloud-link/site/worker/store.js';
class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync('cloud-link/site/drizzle').filter(name => name.endsWith('.sql')).sort())
      this.db.exec(readFileSync('cloud-link/site/drizzle/' + file, 'utf8'));
  }
  prepare(sql) {
    const db=this.db; let args=[];
    const statement={bind(...values){args=values;return statement;},
      async first(){return db.prepare(sql).get(...args)||null;},
      async all(){return {results:db.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};
    return statement;
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {const results=[];for(const statement of statements)results.push(await statement.run());
      this.db.exec('COMMIT');return results;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
const db=new LocalD1(),store=new Store(db);
for await (const line of createInterface({input:process.stdin})) {
  const {path,body,secret}=JSON.parse(line);
  const request=new Request('https://relay.test'+path,{method:'POST',headers:{Authorization:'Bearer '+secret}});
  try {
    let result;
    if(path==='/device/pair')result=await store.pair(request,body);
    else if(path==='/approve')result=await store.pairing('owner',body.code,true);
    else if(path==='/enqueue')result=await store.enqueue('owner','create',body);
    else {
      const device=await store.device(request,true);
      if(path==='/device/exchange')result=await store.exchange(device,body);
      else if(path==='/device/revoke')result=await store.revoke(device.id,device.owner_id);
      else throw new Error('unexpected_test_path');
    }
    console.log(JSON.stringify({result}));
  } catch(error) {
    if(!(error instanceof Denied))throw error;
    console.log(JSON.stringify({error:error.message,status:error.status}));
  }
}
db.db.close();
"""


class StoreFixture:
    def __init__(self):
        self.guard=threading.Lock()
        self.process=subprocess.Popen(['node','--no-warnings','--input-type=module','-e',STORE_SCRIPT],
            cwd=Path(__file__).resolve().parents[2],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,text=True)
        self.responses=[]

    def call(self,config,path,body):
        with self.guard:
            self.process.stdin.write(json.dumps({'path':path,'body':body,'secret':config['device_secret']})+'\n')
            self.process.stdin.flush()
            line=self.process.stdout.readline()
            if not line:raise AssertionError(self.process.stderr.read())
            response=json.loads(line)
            if 'error' in response:
                raise HTTPError('https://relay.test'+path,response['status'],response['error'],{},None)
            self.responses.append((path,response['result']))
            return response['result']

    def close(self):
        self.process.stdin.close()
        try:self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill();self.process.wait()
        errors=self.process.stderr.read()
        self.process.stdout.close();self.process.stderr.close()
        if self.process.returncode:raise AssertionError(errors)


def malformed_commands():
    # 中文注释：R4 只覆盖真实 Store 命令信封；工具参数权限仍由执行器验证。
    valid={'id':'bad','device_id':'device','session_id':'session','tool':'run',
           'args':{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'},
           'expires_at':time.time()+30}
    variants: list[tuple[str,dict]]=[('id_only',{'id':'bad'})]
    for field in ('id','device_id','session_id','tool','args','expires_at'):
        variants.append(('missing_'+field,{key:value for key,value in valid.items() if key!=field}))
    for field in ('id','session_id','tool'):
        for value in ('',None,False,7,[],{}):
            variants.append((field+'_'+repr(value),{**valid,field:value}))
    variants.append(('wrong_device',{**valid,'device_id':'other'}))
    variants.append(('unknown_tool',{**valid,'tool':'unknown'}))
    for value in (None,False,7,'args',[]):
        variants.append(('args_'+repr(value),{**valid,'args':value}))
    for value in (None,True,False,'expiry',[],{},float('nan'),float('inf'),float('-inf')):
        variants.append(('expiry_'+repr(value),{**valid,'expires_at':value}))
    return variants


class ServiceTests(unittest.TestCase):
    def test_exchange_rejects_whole_malformed_command_batch_before_journal_consumption(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None), \
                patch('runtime.service.Relay') as relay:
            service=CloudService(Path(tmp),'browser','Chrome',lambda *args:None)
            self.addCleanup(service.close)
            config={'device_id':'device','paired':True}
            valid={'id':'first','device_id':'device','session_id':'session','tool':'run',
                   'args':{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'},
                   'expires_at':time.time()+30}
            for index,(label,malformed) in enumerate(malformed_commands()):
                for order,commands in enumerate(([malformed],[valid,malformed],[malformed,valid])):
                    with self.subTest(label=label,ids=[row['id'] for row in commands if 'id' in row]):
                        receipt_id=f'receipt-{index}-{order}';session=f'closed-{index}-{order}'
                        service.journal.reserve({'id':receipt_id,'session_id':session,'tool':'list','args':{}})
                        service.journal.abandon(receipt_id);service.journal.mark_closed(session)
                        pending=service.journal.pending();closed=service.journal.closed_sessions()
                        relay.return_value.call.return_value={'device_id':'device','commands':commands,
                            'receipts':[{'command_id':receipt_id,'received':True}],'closed_sessions':closed}
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_unconfirmed'):
                            service._exchange(relay.return_value,config,True,8)
                        self.assertEqual(service.journal.pending(),pending)
                        self.assertEqual(service.journal.closed_sessions(),closed)
                        self.assertEqual(service.journal.active_sessions(),[])

    def test_legacy_disconnect_cannot_resurrect_pairing_after_offline_restart(self):
        for failure in (URLError('offline'), HTTPError('https://relay.test',503,'offline',{},None), None):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as tmp, \
                    patch.object(CloudService,'_loop',lambda self:None), patch('runtime.service.Relay') as relay:
                home=Path(tmp);base=home/'plugin-data/browser-link-cloud';private_directory(base)
                config={'instance_id':'browser','device_id':'old-device','paired':True,'device_secret':'fixture-only'}
                save_config(base/'pairing.json',config)
                private_directory(base/'profile');(base/'profile/identity').write_bytes(b'original-owner')
                from runtime.client import Journal
                old_journal=Journal(base/'requests.sqlite')
                command={'id':'already-reserved','session_id':'old-session','tool':'list','args':{}}
                old_journal.reserve(command);old_journal.abandon(command['id']);old_journal.close()
                other=base/'instances/other';private_directory(other)
                save_config(other/'pairing.json',{'device_id':'other-device','paired':True})
                relay.return_value.call.side_effect=failure
                relay.return_value.call.return_value={'revoked':True}
                service=CloudService(home,'browser','Chrome',lambda *args:None)
                self.assertEqual(service.config['device_id'],'old-device')
                self.assertFalse(service.journal.reserve(command))
                service.disconnect();service.close()
                for _ in range(2):
                    restarted=CloudService(home,'browser','Chrome',lambda *args:None)
                    try:
                        self.assertIsNone(restarted.config)
                        self.assertFalse(restarted.view()['paired']);self.assertFalse(restarted.view()['fullAccess'])
                        self.assertFalse(restarted.journal.reserve(command))
                        self.assertEqual((restarted.directory/'profile/identity').read_bytes(),b'original-owner')
                    finally:restarted.close()
                self.assertEqual(load_config(base/'pairing.json'),config)
                self.assertEqual(load_config(other/'pairing.json')['device_id'],'other-device')

    def test_disconnect_tombstone_survives_interrupted_pairing_deletion(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None):
            home=Path(tmp);directory=home/'plugin-data/browser-link-cloud/instances/browser'
            private_directory(directory);save_config(directory/'pairing.json',{'paired':True,'device_id':'old-device'})
            service=CloudService(home,'browser','Chrome',lambda *args:None)
            with patch.object(Path,'unlink',side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):service.disconnect()
            service.close()
            restarted=CloudService(home,'browser','Chrome',lambda *args:None)
            try:self.assertIsNone(restarted.config)
            finally:restarted.close()

    def test_disconnect_revokes_locally_before_remote_failure_or_block(self):
        failures=(URLError('offline'), TimeoutError('timeout'),
                  *(HTTPError('https://relay.test',code,'unavailable',{},None) for code in (401,410,503)),
                  'unconfirmed_receipt', None)
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as tmp, \
                    patch.object(CloudService,'_loop',lambda self:None), patch('runtime.service.Relay') as relay:
                service=CloudService(Path(tmp),'browser','Chrome',lambda *args:{'verified':True})
                service.config={'device_id':'device','paired':True};service.status='active'
                save_config(service.path,service.config)
                stopped=threading.Event();entered=threading.Event();release=threading.Event()
                class Scheduler:
                    def stop(self):stopped.set()
                service.scheduler=Scheduler();service.executor=object()
                revision=service.generation;result=[];errors=[]
                def remote(path,body):
                    entered.set();release.wait(2)
                    if isinstance(failure,BaseException):raise failure
                    return {'revoked':failure is None}
                relay.return_value.call.side_effect=remote
                def disconnect():
                    try:result.append(service.disconnect())
                    except Exception as error:errors.append(error)
                worker=threading.Thread(target=disconnect);worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertIsNone(service.config);self.assertFalse(service.path.exists())
                    self.assertGreater(service.generation,revision)
                    self.assertIsNone(service.executor);self.assertIsNone(service.scheduler)
                    self.assertTrue(stopped.is_set());self.assertFalse(service.view()['paired'])
                    with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                        service._bind({'id':'old-task','generation':1})
                    self.assertIn('未确认',service.view()['error'])
                finally:
                    release.set();worker.join(2)
                    service.close()
                self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
                self.assertEqual(result[0]['state'],'unpaired')
                self.assertFalse(result[0]['online']);self.assertFalse(result[0]['fullAccess'])
                if failure:self.assertIn('未确认',result[0]['error'])
                else:self.assertIsNone(result[0]['error'])

    def test_inflight_binding_cannot_dispatch_after_disconnect_or_repair(self):
        for repair in (False,True,'remote_revoked'):
            with self.subTest(repair=repair), tempfile.TemporaryDirectory() as tmp, \
                    patch.object(CloudService,'_loop',lambda self:None), patch('runtime.service.Relay') as relay:
                entered=threading.Event();release=threading.Event();dispatched=[];errors=[]
                def browser(method,params):
                    entered.set();release.wait(2);return {'verified':True}
                service=CloudService(Path(tmp),'browser','Chrome',browser)
                service.config={'paired':True,'device_id':'device'};service.status='active'
                relay.return_value.call.return_value={'revoked':True}
                def dispatch():
                    try:
                        service._bind({'id':'task','generation':1});dispatched.append('old-action')
                    except ValueError as error:errors.append(str(error))
                worker=threading.Thread(target=dispatch);worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    if repair=='remote_revoked':service.status='revoked'
                    else:service.disconnect()
                    if repair is True:
                        service.config={'paired':True,'device_id':'new-device'};service.status='active'
                        service.generation+=1
                    release.set();worker.join(2)
                    self.assertFalse(worker.is_alive());self.assertEqual(dispatched,[])
                    self.assertEqual(errors,['cloud_pairing_required'])
                finally:
                    release.set();worker.join(2);service.close()

    def test_disconnect_cannot_race_a_captured_scheduler_dispatch(self):
        entered=threading.Event();revoking=threading.Event();submitted=threading.Event();dispatches=[]
        class Executor:
            def execute(self,command):return {'ok':True}
            def close(self,*,sessions=()):return list(sessions)
        class GatedScheduler(Scheduler):
            def pump(self):
                entered.set();revoking.wait(.2);super().pump()
        with tempfile.TemporaryDirectory() as tmp,patch('runtime.service.Relay') as relay:
            with patch.object(CloudService,'_loop',lambda self:None):
                service=CloudService(Path(tmp),'browser','Chrome',
                    lambda *args:{'connected':True,'instanceId':'browser'})
            path=service.path
            class GatedPath:
                def unlink(self,**kwargs):
                    revoking.set();submitted.wait(1);path.unlink(**kwargs)
            service.path=GatedPath()
            service.config={'paired':True,'device_id':'device'};service.status='active'
            scheduler=GatedScheduler(service.journal,Executor());service.scheduler=scheduler
            command={'id':'queued','session_id':'session','tool':'list','args':{}}
            service.journal.reserve(command);scheduler.pending.append(command)
            submit=scheduler.pool.submit
            def record_dispatch(*args,**kwargs):
                dispatches.append(service.config is not None);submitted.set()
                return submit(*args,**kwargs)
            scheduler.pool.submit=record_dispatch
            relay.return_value.call.side_effect=lambda route,body:({'revoked':True} if route=='/device/revoke'
                else {'device_id':'device','commands':[],'receipts':[],'closed_sessions':[]})
            service.worker=threading.Thread(target=service._loop);service.worker.start()
            closer=threading.Thread(target=service.disconnect)
            try:
                self.assertTrue(entered.wait(2));closer.start();closer.join(3)
                self.assertFalse(closer.is_alive());self.assertEqual(dispatches,[True])
                scheduler.pump();self.assertEqual(dispatches,[True])
                self.assertTrue(scheduler.stopping);self.assertIsNone(service.scheduler)
            finally:
                submitted.set();closer.join(3);service.close()

    def test_old_executor_binding_cannot_use_a_new_pairing_generation(self):
        created=threading.Event();bindings=[];browser_calls=[]
        class Executor:
            def __init__(self,*args,bind_task,authorize=None):bindings.append(bind_task);created.set()
            def close(self,*,sessions=()):return list(sessions)
        class Relay:
            def __init__(self,config):self.config=config
            def call(self,path,body):
                if path=='/device/revoke':return {'revoked':True}
                return {'device_id':self.config['device_id'],'commands':[],'receipts':[],'closed_sessions':[]}
        instance='browser'
        def browser(method,params):
            if method=='cloud.browser_status':return {'connected':True,'instanceId':instance}
            browser_calls.append((method,params));return {'verified':True}
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);directory=home/'plugin-data/browser-link-cloud/instances'/instance
            private_directory(directory)
            save_config(directory/'pairing.json',{'device_id':'old-device','paired':True,'full_access':True})
            with patch('runtime.service.Relay',Relay),patch('runtime.service.CloudExecutor',Executor):
                service=CloudService(home,instance,'Chrome',browser)
                try:
                    self.assertTrue(created.wait(2));old_binding=bindings[0]
                    service.disconnect()
                    with service.guard:
                        service.config={'device_id':'new-device','paired':True};service.status='active'
                        service.generation+=1
                    with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                        old_binding({'id':'old-task','generation':1})
                    self.assertEqual(browser_calls,[])
                finally:service.close()

    def test_real_store_sqlite_pairing_exchange_and_native_execution_contract(self):
        fixture=StoreFixture();self.addCleanup(fixture.close)
        class Relay:
            def __init__(self,config):self.config=config
            def call(self,path,body):return fixture.call(self.config,path,body)
        bridge=FakeBridge();bound=threading.Event();active=threading.Event()
        instance='paired-browser'
        def browser(method,params):
            if method=='cloud.browser_status':return {'connected':True,'instanceId':instance}
            self.assertEqual(method,'cloud.bind_task')
            self.assertEqual(params['instanceId'],instance);self.assertEqual(params['mode'],'full')
            bridge.tasks[params['taskId']]['activeMode']='full';bound.set()
            return {'verified':True}
        def executor(*args,**kwargs):return CloudExecutor(*args,**kwargs,client=bridge)
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);base=home/'plugin-data/browser-link-cloud';private_directory(base)
            save_config(base/'service.json',{'site':'https://relay.test','sites_access_token':'fixture-only'})
            with patch('runtime.service.Relay',Relay),patch('runtime.service.CloudExecutor',executor):
                with patch.object(CloudService,'_loop',lambda self:None):
                    service=CloudService(home,instance,'Chrome',browser,
                        notify=lambda view:active.set() if view['paired'] else None)
                try:
                    service.start_pairing();config=dict(service.config);relay=Relay(config)
                    pending=service._exchange(relay,config,True,0)
                    self.assertEqual(pending['status'],'pending_pairing')
                    self.assertFalse(service.view()['paired']);self.assertIsNone(service.scheduler)
                    with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                        service._bind({'id':'task','generation':1})
                    with self.assertRaises(HTTPError) as denied:
                        fixture.call({**config,'device_secret':'b'*43},'/device/exchange',
                            {'limit':0,'results':[],'closed_sessions':[],'browser_connected':True,'full_access':True})
                    self.assertEqual(denied.exception.code,401)
                    fixture.call(config,'/approve',{'code':config['connection_code']})
                    response=service._exchange(relay,config,True,0)
                    self.assertNotIn('status',fixture.responses[-1][1])
                    self.assertEqual(response['status'],'active')
                    service.worker=threading.Thread(target=service._loop);service.worker.start()
                    self.assertTrue(active.wait(3))
                    queued=fixture.call(config,'/enqueue',{'device_id':config['device_id'],
                        'request_id':'11111111-1111-4111-8111-111111111111','title':'contract',
                        'allowed_origins':['https://example.com']})
                    self.assertTrue(bound.wait(4))
                    deadline=time.monotonic()+3
                    while not any(receipt.get('received') for path,value in fixture.responses
                            if path=='/device/exchange' for receipt in value.get('receipts',[])) and time.monotonic()<deadline:
                        time.sleep(.01)
                    receipts=[receipt for path,value in fixture.responses if path=='/device/exchange'
                              for receipt in value.get('receipts',[])]
                    self.assertIn({'command_id':queued['command_id'],'received':True},receipts)
                    self.assertTrue(load_config(service.path)['paired'])
                    self.assertEqual(bridge.tasks['cloud-task']['state'],'ready')
                    self.assertEqual(bridge.tasks['local-task']['state'],'ready')
                    service.disconnect()
                    self.assertFalse(service.view()['paired']);self.assertIsNone(service.view()['error'])
                    with self.assertRaises(HTTPError) as revoked:
                        fixture.call(config,'/device/exchange',{'limit':0,'results':[],'closed_sessions':[]})
                    self.assertEqual(revoked.exception.code,401)
                finally:service.close()

    def test_new_pairing_defaults_full_but_pending_connection_is_not_authorized(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);instance='11111111-1111-4111-8111-111111111111'
            base=home/'plugin-data/browser-link-cloud';private_directory(base)
            save_config(base/'service.json',{'site':'https://relay.test','sites_access_token':'private'})
            with patch.object(CloudService,'_loop',lambda self:None),patch('runtime.service.Relay') as relay:
                relay.return_value.call.return_value={'device_id':'device','status':'pending_pairing'}
                service=CloudService(home,instance,'Chrome',lambda *args:None)
                try:
                    view=service.start_pairing()
                    config=load_config(service.path)
                    self.assertIs(config['full_access'],True)
                    self.assertFalse(view['paired']);self.assertFalse(view['fullAccess'])
                    self.assertIsNone(service.scheduler);self.assertIsNone(service.executor)
                    service._exchange(relay.return_value,config,True,0)
                    body=relay.return_value.call.call_args.args[1]
                    self.assertFalse(body['full_access']);self.assertEqual(body['limit'],0)
                finally:service.close()

    def test_exchange_rejects_explicit_errors_and_mixed_success_before_receipts(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None), \
                patch('runtime.service.Relay') as relay:
            service=CloudService(Path(tmp),'browser','Chrome',lambda *args:None)
            self.addCleanup(service.close)
            config={'device_id':'device','paired':True}
            service.journal.reserve({'id':'receipt','session_id':'session','tool':'list','args':{}})
            service.journal.abandon('receipt')
            valid={'device_id':'device','commands':[],
                   'receipts':[{'command_id':'receipt','received':True}],'closed_sessions':[]}
            responses=[{**valid,'error':error} for error in ('device_revoked',None,False,{},[])]
            responses += [{**valid,'status':'active','error':'device_revoked'},
                          {**valid,'status':'active','code':'device_revoked'},
                          {**valid,'status':'pending_pairing'},
                          {**valid,'status':'active','commands':None},
                          {**valid,'status':'active','receipts':[None]},
                          {**valid,'status':'active','closed_sessions':[{}]},None,[]]
            for response in responses:
                with self.subTest(response=response):
                    relay.return_value.call.return_value=response
                    with self.assertRaisesRegex(ValueError,'cloud_pairing_unconfirmed'):
                        service._exchange(relay.return_value,config,True,0)
                    self.assertIn('receipt',dict(service.journal.pending()))
            relay.return_value.call.return_value=valid
            self.assertEqual(service._exchange(relay.return_value,config,True,0)['status'],'active')
            self.assertEqual(service.journal.pending(),[])

    def test_exchange_cannot_infer_pairing_from_remote_permission_fields(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None):
            service=CloudService(Path(tmp),'11111111-1111-4111-8111-111111111111','Chrome',lambda *args:None)
            try:
                service.config={'device_id':'device','full_access':True}
                for status in (None,'full','unpaired','revoked','expired','error',False,{},[]):
                    with self.subTest(status=status),patch('runtime.service.Relay') as relay:
                        relay.return_value.call.return_value={'device_id':'device','status':status,'paired':True,'fullAccess':True,
                            'commands':[],'receipts':[],'closed_sessions':[]}
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_unconfirmed'):
                            service._exchange(relay.return_value,service.config,True,0)
                        self.assertFalse(service.view()['paired']);self.assertFalse(service.view()['fullAccess'])
                for response in ({'device_id':'device','paired':True,'fullAccess':True},
                                 {'device_id':'device','commands':None,'receipts':[],'closed_sessions':[]}):
                    with self.subTest(response=response),patch('runtime.service.Relay') as relay:
                        relay.return_value.call.return_value=response
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_unconfirmed'):
                            service._exchange(relay.return_value,service.config,True,0)
                with patch('runtime.service.Relay') as relay:
                    relay.return_value.call.return_value={'device_id':'other','commands':[],'receipts':[],'closed_sessions':[]}
                    with self.assertRaisesRegex(ValueError,'cloud_device_mismatch'):
                        service._exchange(relay.return_value,service.config,True,0)
            finally:service.close()

    def test_real_scheduler_executor_fences_queue_and_inflight_binding_until_authenticated_recovery(self):
        failures=({'status':'unknown'},{'error':'device_revoked'},{'device_id':'other'},
                  {'status':'pending_pairing'},URLError('offline'),TimeoutError('timeout'),
                  HTTPError('https://relay.test',503,'unavailable',{},None),
                  HTTPError('https://relay.test',401,'revoked',{},None))
        malformed=dict(malformed_commands())
        failures+=tuple({'commands':[malformed[label]]} for label in
            ('id_only','missing_session_id','missing_tool','missing_args','missing_expires_at',
             'args_None','args_[]','expiry_True','expiry_nan','expiry_inf'))
        first={'id':'first','device_id':'device','session_id':'session','tool':'run',
               'args':{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'},
               'expires_at':time.time()+30}
        # 中文注释：纳入原 review 混合探针，合法 first 与 args=null 不能部分登记或派发。
        failures+=({'commands':[first,malformed['args_None']]},
                   {'commands':[malformed['args_None'],first]})
        for failure in failures:
            with self.subTest(failure=repr(failure)),tempfile.TemporaryDirectory() as tmp:
                from queue import Queue
                responses=Queue();exchange_entered=threading.Event();published=threading.Event()
                bind_entered=threading.Event();release_bind=threading.Event();gate_binding=threading.Event()
                ticks=threading.Semaphore(0);settled=threading.Event()
                class Clock:
                    stopped=False
                    def wait(self,delay):settled.set();ticks.acquire();return self.stopped
                    def is_set(self):return self.stopped
                    def set(self):self.stopped=True;ticks.release()
                class Relay:
                    def __init__(self,config):pass
                    def call(self,path,body):
                        exchange_entered.set();value=responses.get(timeout=3)
                        if isinstance(value,Exception):raise value
                        return value
                bridge=FakeBridge();instance='paired-browser'
                def browser(method,params):
                    if method=='cloud.browser_status':return {'connected':True,'instanceId':instance}
                    if gate_binding.is_set():bind_entered.set();release_bind.wait(3)
                    bridge.tasks[params['taskId']]['activeMode']='full';return {'verified':True}
                def executor(*args,**kwargs):return CloudExecutor(*args,**kwargs,client=bridge)
                valid={'device_id':'device','commands':[],'receipts':[],'closed_sessions':[]}
                home=Path(tmp);directory=home/'plugin-data/browser-link-cloud/instances'/instance
                private_directory(directory);save_config(directory/'pairing.json',{'paired':True,'device_id':'device'})
                with patch.object(CloudService,'_loop',lambda self:None):
                    service=CloudService(home,instance,'Chrome',browser,notify=lambda view:published.set())
                service.closed=Clock()
                def tick(response):
                    self.assertTrue(settled.wait(2));settled.clear()
                    exchange_entered.clear();published.clear();responses.put(response);ticks.release()
                    self.assertTrue(exchange_entered.wait(2))
                def command(identifier,tool,args):
                    return {'id':identifier,'device_id':'device','session_id':'session','tool':tool,
                            'args':args,'expires_at':time.time()+30}
                loop_errors=[]
                def run_loop():
                    try:service._loop()
                    except Exception as error:loop_errors.append(type(error).__name__+':'+str(error))
                with patch('runtime.service.Relay',Relay),patch('runtime.service.CloudExecutor',executor):
                    service.worker=threading.Thread(target=run_loop);service.worker.start()
                    try:
                        tick(valid);self.assertTrue(published.wait(2));self.assertEqual(service.status,'active')
                        with service.guard:
                            scheduler=service.scheduler;old_binding=service.executor.bind_task
                        create=command('create','create',{'title':'fixture','allowed_origins':['https://example.com']})
                        scheduler.add([create])
                        deadline=time.monotonic()+2
                        while scheduler.running and time.monotonic()<deadline:time.sleep(.005)
                        self.assertFalse(scheduler.running);self.assertEqual(bridge.tasks['cloud-task']['activeMode'],'full')
                        gate_binding.set()
                        inflight=command('inflight','run',{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'})
                        queued=command('queued','run',dict(inflight['args']))
                        scheduler.add([inflight,queued]);self.assertTrue(bind_entered.wait(2))
                        self.assertEqual([row['id'] for row in scheduler.pending],['queued'])
                        revision=service.generation
                        receipt={'id':'receipt','session_id':'closed-session','tool':'list','args':{}}
                        service.journal.reserve(receipt);service.journal.abandon('receipt')
                        service.journal.mark_closed('closed-session')
                        before_ids={row[0] for row in service.journal.db.execute('SELECT id FROM commands')}
                        envelope={**valid,'receipts':[{'command_id':'receipt','received':True}],
                                  'closed_sessions':['closed-session']}
                        bad={**envelope,**failure} if isinstance(failure,dict) else failure
                        tick(bad)
                        deadline=time.monotonic()+1
                        while service.generation==revision and time.monotonic()<deadline:time.sleep(.005)
                        self.assertGreater(service.generation,revision,msg=repr(loop_errors))
                        self.assertEqual(loop_errors,[]);self.assertTrue(service.worker.is_alive())
                        self.assertFalse(service.view()['fullAccess']);self.assertFalse(service.view()['online'])
                        self.assertIn('receipt',dict(service.journal.pending()))
                        self.assertIn('closed-session',service.journal.closed_sessions())
                        self.assertEqual({row[0] for row in service.journal.db.execute('SELECT id FROM commands')},before_ids)
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                            old_binding({'id':'cloud-task','generation':1})
                        release_bind.set();self.assertTrue(published.wait(2))
                        deadline=time.monotonic()+2
                        while service.transitioning and time.monotonic()<deadline:time.sleep(.005)
                        self.assertFalse(service.transitioning)
                        self.assertTrue(scheduler.stopping);self.assertEqual(scheduler.pending,[])
                        self.assertIsNone(service.scheduler)
                        self.assertFalse(any(method=='shared.run' for method,params in bridge.calls))
                        outcomes={key:json.loads(value) for key,value in service.journal.pending()}
                        self.assertEqual(outcomes['queued']['code'],'cloud_disabled')
                        self.assertTrue(outcomes['inflight']['outcome_unknown'])
                        gate_binding.clear()
                        # 中文注释：即使再次连接浏览器，错误交换不能新建执行器或恢复绑定。
                        tick({**valid,'status':'unknown'});self.assertTrue(settled.wait(2))
                        self.assertIsNone(service.scheduler)
                        # 中文注释：只有完整认证成功响应恢复新代次；重复领取旧命令由真实账本拒绝。
                        tick({**valid,'commands':[inflight,queued]});self.assertTrue(published.wait(2))
                        with service.guard:
                            self.assertEqual(service.status,'active');self.assertIsNotNone(service.scheduler)
                            self.assertFalse(service.scheduler.pending);self.assertFalse(service.scheduler.running)
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                            old_binding({'id':'cloud-task','generation':1})
                        self.assertFalse(any(method=='shared.run' for method,params in bridge.calls))
                        self.assertGreater(service.generation,revision)
                        new_create={**command('new-create','create',create['args']),'session_id':'new-session'}
                        tick({**valid,'commands':[new_create]});self.assertTrue(settled.wait(2))
                        recovered=service.scheduler
                        assert recovered is not None
                        deadline=time.monotonic()+2
                        while recovered.running and time.monotonic()<deadline:time.sleep(.005)
                        self.assertFalse(recovered.running)
                        new_run={**command('new-run','run',inflight['args']),'session_id':'new-session'}
                        tick({**valid,'commands':[inflight,queued,new_run]});self.assertTrue(settled.wait(2))
                        deadline=time.monotonic()+2
                        while recovered.running and time.monotonic()<deadline:time.sleep(.005)
                        self.assertFalse(recovered.running)
                        self.assertEqual([params['requestId'] for method,params in bridge.calls if method=='shared.run'],['new-run'])
                        self.assertEqual(loop_errors,[]);self.assertTrue(service.worker.is_alive())
                        self.assertTrue(service.view()['fullAccess'])
                        self.assertEqual(bridge.tasks['local-task']['state'],'ready')
                    finally:release_bind.set();service.close()

    def test_real_executor_cannot_dispatch_after_post_binding_read_is_fenced(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None):
            home=Path(tmp);bridge=FakeBridge();entered=threading.Event();release=threading.Event()
            service=CloudService(home,'paired-browser','Chrome',lambda method,params:
                bridge.tasks[params['taskId']].update(activeMode='full') or {'verified':True})
            service.config={'device_id':'device','paired':True};service.status='active'
            executor=CloudExecutor(home,service.directory,'device','paired-browser',client=bridge,
                                   bind_task=lambda task:service._bind(task,revision=0))
            service.executor=executor;service.scheduler=Scheduler(service.journal,executor)
            def command(identifier,tool,args):
                return {'id':identifier,'device_id':'device','session_id':'session','tool':tool,
                        'args':args,'expires_at':time.time()+30}
            executor.execute(command('create','create',{'title':'fixture','allowed_origins':['https://example.com']}))
            original=bridge.call;reads=0
            def call(method,params):
                nonlocal reads
                if method=='shared.get':
                    reads+=1
                    if reads==2:entered.set();release.wait(3)
                return original(method,params)
            bridge.call=call
            scheduler=service.scheduler
            scheduler.add([command('run','run',{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'})])
            self.assertTrue(entered.wait(2))
            closer=threading.Thread(target=lambda:service._fence(0,'offline','offline'));closer.start()
            try:
                deadline=time.monotonic()+2
                while not executor._closed and time.monotonic()<deadline:time.sleep(.005)
                self.assertTrue(executor._closed);release.set();closer.join(2)
                self.assertFalse(closer.is_alive())
                self.assertFalse(any(method=='shared.run' for method,params in bridge.calls))
            finally:release.set();closer.join(3);service.close()

    def test_dispatched_unknown_action_and_queued_command_are_never_replayed_after_fence(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None):
            home=Path(tmp);bridge=FakeBridge();entered=threading.Event();release=threading.Event();run_ids=[]
            service=CloudService(home,'paired-browser','Chrome',lambda method,params:
                bridge.tasks[params['taskId']].update(activeMode='full') or {'verified':True})
            service.config={'device_id':'device','paired':True};service.status='active'
            executor=CloudExecutor(home,service.directory,'device','paired-browser',client=bridge,
                bind_task=lambda task:service._bind(task,revision=0),authorize=lambda:service._authorize(0))
            service.executor=executor;service.scheduler=Scheduler(service.journal,executor)
            def command(identifier,tool,args):
                return {'id':identifier,'device_id':'device','session_id':'session','tool':tool,
                        'args':args,'expires_at':time.time()+30}
            executor.execute(command('create','create',{'title':'fixture','allowed_origins':['https://example.com']}))
            original=bridge.call
            def call(method,params):
                if method=='shared.run':
                    run_ids.append(params['requestId']);entered.set();release.wait(3)
                    raise RuntimeError('fixture_action_outcome_unknown')
                return original(method,params)
            bridge.call=call
            inflight=command('inflight','run',{'task_id':'cloud-task','action':'new_tab','url':'https://example.com'})
            queued=command('queued','run',dict(inflight['args']))
            scheduler=service.scheduler;scheduler.add([inflight,queued]);self.assertTrue(entered.wait(2))
            closer=threading.Thread(target=lambda:service._fence(0,'offline','offline'));closer.start()
            try:
                deadline=time.monotonic()+2
                while not executor._closed and time.monotonic()<deadline:time.sleep(.005)
                self.assertTrue(executor._closed);release.set();closer.join(2);self.assertFalse(closer.is_alive())
                outcomes={key:json.loads(value) for key,value in service.journal.pending()}
                self.assertTrue(outcomes['inflight']['outcome_unknown'])
                self.assertEqual(outcomes['queued']['code'],'cloud_disabled')
                self.assertFalse(service.journal.reserve(inflight));self.assertFalse(service.journal.reserve(queued))
                scheduler.pump();self.assertEqual(run_ids,['inflight'])
                self.assertEqual(bridge.tasks['local-task']['state'],'ready')
            finally:release.set();closer.join(3);service.close()

    def test_exchange_heartbeat_cannot_advertise_full_before_authenticated_active(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None),patch('runtime.service.Relay') as relay:
            service=CloudService(Path(tmp),'browser','Chrome',lambda *args:None)
            self.addCleanup(service.close)
            config={'device_id':'device','paired':True}
            relay.return_value.call.return_value={'device_id':'device','commands':[],'receipts':[],'closed_sessions':[]}
            for status in ('connecting','offline','unknown','pending_pairing','active'):
                with self.subTest(status=status):
                    service.status=status;service._exchange(relay.return_value,config,True,0)
                    self.assertEqual(relay.return_value.call.call_args.args[1]['full_access'],status=='active')

    def test_native_binding_requires_active_before_and_after_browser_reply(self):
        for status in ('connecting','offline','unknown','error','pending_pairing','revoked','expired','unpaired'):
            for during_reply in (False,True):
                with self.subTest(status=status,during_reply=during_reply), tempfile.TemporaryDirectory() as tmp, \
                        patch.object(CloudService,'_loop',lambda self:None):
                    calls=[]
                    def browser(method,params):
                        calls.append(method);service.status=status;return {'verified':True}
                    service=CloudService(Path(tmp),'browser','Chrome',browser)
                    try:
                        service.config={'device_id':'device','paired':True}
                        service.status='active' if during_reply else status
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                            service._bind({'id':'task','generation':1})
                        self.assertEqual(calls,['cloud.bind_task'] if during_reply else [])
                    finally:service.close()

    def test_native_binding_cannot_authorize_unpaired_or_revoked_connection(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(CloudService,'_loop',lambda self:None):
            calls=[]
            service=CloudService(Path(tmp),'11111111-1111-4111-8111-111111111111','Chrome',
                                 lambda method,params:calls.append((method,params)) or {'verified':True})
            try:
                for config,status in ((None,'unpaired'),({'full_access':True},'pending_pairing'),
                                      ({'paired':True,'full_access':True},'revoked')):
                    with self.subTest(status=status):
                        service.config=config;service.status=status
                        with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                            service._bind({'id':'task','generation':1})
                self.assertEqual(calls,[])
            finally:service.close()

    def test_paired_connections_migrate_to_full_without_changing_identity_or_origins(self):
        for legacy in (False, True):
            for full_access in (False, None):
                with self.subTest(legacy=legacy, full_access=full_access), tempfile.TemporaryDirectory() as tmp:
                    home=Path(tmp);instance='11111111-1111-4111-8111-111111111111'
                    base=home/'plugin-data/browser-link-cloud'
                    directory=base/'instances'/instance
                    source=base if legacy else directory;private_directory(source)
                    config={'paired':True,'instance_id':instance,'device_id':'device','device_secret':'private',
                            'site':'https://relay.test','sites_access_token':'private','allowed_origins':['https://old.test']}
                    if full_access is not None:config['full_access']=full_access
                    save_config(source/'pairing.json',config)
                    with patch.object(CloudService,'_loop',lambda self:None):
                        service=CloudService(home,instance,'Chrome',lambda *args:None)
                        try:
                            self.assertTrue(service.view()['paired'])
                            self.assertFalse(service.view()['fullAccess'])
                            self.assertEqual(service.view()['state'],'connecting')
                            with self.assertRaisesRegex(ValueError,'cloud_pairing_required'):
                                service._bind({'id':'task','generation':1})
                            self.assertEqual(load_config(directory/'pairing.json'),{**config,'full_access':True})
                        finally:service.close()

    def test_pending_legacy_pairing_only_activates_full_after_confirmed_pairing(self):
        exchanges=[];bound=threading.Event();binds=[]
        class Relay:
            def __init__(self,config):pass
            def call(self,path,body):
                exchanges.append(body)
                response={'device_id':'device','commands':[],'receipts':[],'closed_sessions':[]}
                if len(exchanges)==1:response['status']='pending_pairing'
                return response
        class Executor:
            def __init__(self,*args,bind_task,authorize=None):
                bind_task({'id':'task','generation':3});bound.set()
            def close(self, *, sessions=()):return list(sessions)
            def handoff_session(self,session):return True
        instance='11111111-1111-4111-8111-111111111111'
        def browser(method,params):
            if method=='cloud.browser_status':return {'connected':True,'instanceId':instance}
            binds.append((method,params));return {'verified':True}
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);directory=home/'plugin-data/browser-link-cloud/instances'/instance;private_directory(directory)
            save_config(directory/'pairing.json',{'device_id':'device','site':'https://relay.test',
                        'device_secret':'private','sites_access_token':'private','full_access':False,'allowed_origins':[],
                        'connection_code':'234567-ABCDEFG','code_expires_at':time.time()+300})
            with patch('runtime.service.Relay',Relay),patch('runtime.service.CloudExecutor',Executor):
                service=CloudService(home,instance,'Chrome',browser)
                try:
                    self.assertTrue(bound.wait(3))
                    self.assertTrue(service.view()['paired']);self.assertTrue(service.view()['fullAccess'])
                    config=load_config(service.path)
                    self.assertIs(config['full_access'],True)
                    self.assertNotIn('connection_code',config)
                    self.assertEqual(binds,[('cloud.bind_task',{'taskId':'task','generation':3,'instanceId':instance,'mode':'full'})])
                    self.assertEqual([body['full_access'] for body in exchanges[:2]],[False,False])
                    self.assertEqual([body['limit'] for body in exchanges[:2]],[0,0])
                finally:service.close()

    def test_waiting_task_does_not_block_exchange_or_native_shutdown(self):
        started=threading.Event(); release=threading.Event(); exchanges=[]
        class Executor:
            def __init__(self,*args,**kwargs):pass
            def execute(self,cmd):
                started.set();release.wait(5);return {'id':'task','state':'ready'}
            def close(self, *, sessions=()):release.set();return list(sessions)
            def handoff_session(self,session):raise AssertionError('活动任务不能被回收')
        class Relay:
            def __init__(self,config):pass
            def call(self,path,body):
                self_outer.assertEqual(path,'/device/exchange');exchanges.append(body)
                commands=[]
                if len(exchanges)==1:
                    commands=[{'id':'cmd','session_id':'session','device_id':'device','tool':'create',
                               'args':{'title':'test','allowed_origins':['https://example.com']},'expires_at':time.time()+30}]
                return {'device_id':'device','commands':commands,'receipts':[], 'closed_sessions':[]}
        self_outer=self
        with tempfile.TemporaryDirectory() as tmp:
            instance='11111111-1111-4111-8111-111111111111';home=Path(tmp)
            folder=home/'plugin-data/browser-link-cloud/instances'/instance;private_directory(folder)
            save_config(folder/'pairing.json',{'paired':True,'device_id':'device','site':'https://relay.test',
                        'device_secret':'private','sites_access_token':'private','allowed_origins':[],'full_access':False})
            with patch('runtime.service.CloudExecutor',Executor),patch('runtime.service.Relay',Relay):
                service=CloudService(home,instance,'Chrome',lambda *a:{'connected':True,'instanceId':instance})
                try:
                    self.assertTrue(started.wait(2))
                    deadline=time.monotonic()+3
                    while len(exchanges)<3 and time.monotonic()<deadline:time.sleep(.01)
                    self.assertGreaterEqual(len(exchanges),3)
                    self.assertTrue(service.view()['online']);self.assertFalse(release.is_set())
                finally:service.close()
                self.assertFalse(service.worker.is_alive());self.assertFalse(service.scheduler)
                self.assertTrue(release.is_set())

if __name__=='__main__':unittest.main()
