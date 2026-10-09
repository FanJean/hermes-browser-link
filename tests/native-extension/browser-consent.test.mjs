import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../../native-extension/bridge.mjs';

test('connection consent ignores obsolete smart preferences without a second grant',async()=>{
 for(const data of [{},{preferredMode:'smart',browserFullConsent:{version:1,enabled:false}}]){
  const storage={get:async()=>({...data}),set:async()=>assert.fail('no separate permission preference')};
  const consent=new module.BrowserConsent(storage,{tasks:new Map()});
  assert.equal(await consent.load(),'enabled');
  assert.equal(await consent.readStatus(),'enabled');
  assert.equal(consent.enabled,true);
 }
});

test('connection consent no longer exposes a smart-mode switch',()=>{
 const consent=new module.BrowserConsent({}, {tasks:new Map()});
 assert.equal(consent.setEnabled,undefined);
});

test('full mode installs a new task with empty owned scope',async()=>{
 const {Executor}=await import('../../native-extension/core.mjs');
 const executor=new Executor({tabs:{get:async()=>assert.fail('must not claim existing tabs')}});
 const consent=new module.BrowserConsent({get:async()=>({}),set:async()=>{}},executor);
 const task={id:'new',instanceId:'browser',approvalScope:'scope',generation:1,modeGeneration:1,state:'pending_approval',tabIds:[],allowedOrigins:['https://example.test']};
 let bridge;const sent=[];
 const port={onMessage:{addListener(){}},postMessage:m=>{sent.push(m);queueMicrotask(()=>{
  let result;
  if(m.method==='extension.tasks')result=[task];
  else if(m.method==='extension.approve')result={...task,state:'ready'};
  else if(m.method==='extension.mode')result={...task,state:'ready',activeMode:m.params.mode,modeGeneration:2};
  else assert.fail(m.method);
  bridge.receive({id:m.id,result});
 });}};
 bridge=new module.Bridge(port,executor);
 await consent.synchronize(bridge);
 assert.equal(executor.tasks.get('new').policy.activeMode,'full');
 assert.deepEqual(sent.find(m=>m.method==='extension.approve').params.tabIds,[]);
 assert.equal(Object.hasOwn(sent.find(m=>m.method==='extension.approve').params,'apiBridgeApproved'),false);
 assert.equal(executor.leases.size,0);
});

test('auto-authorized empty scope creates grouped background tabs without claiming user tabs',async()=>{
 const {Executor}=await import('../../native-extension/core.mjs');
 const tabs=new Map([[1,{id:1,url:'https://example.test/',windowId:7,groupId:-1,active:true}]]),data={},created=[];
 let next=10;
 const api={runtime:{getURL:p=>'chrome-extension://test/'+p},storage:{local:{get:async k=>({[k]:data[k]}),set:async v=>Object.assign(data,v)}},windows:{getCurrent:async()=>({id:7}),get:async()=>({id:7}),create:async()=>({id:7,tabs:[{id:9}]})},
  tabs:{query:async()=>[],get:async id=>({...tabs.get(id)}),create:async p=>{const t={...p,id:next++,groupId:-1};created.push(t);tabs.set(t.id,t);return {...t};},group:async p=>{for(const id of p.tabIds)tabs.get(id).groupId=p.groupId??20;return p.groupId??20;},remove:async id=>tabs.delete(id)},tabGroups:{update:async()=>{},get:async id=>({id,windowId:7,title:'AI 工作'})},debugger:{detach:async()=>{}}};
 const executor=new Executor(api),consent=new module.BrowserConsent({set:async()=>{}},executor);
 const task={id:'grouped',instanceId:'browser',approvalScope:'scope',generation:1,modeGeneration:1,state:'pending_approval',tabIds:[],allowedOrigins:['https://example.test']};
 let bridge;
 bridge=new module.Bridge({onMessage:{addListener(){}},postMessage:m=>queueMicrotask(()=>bridge.receive({id:m.id,result:m.method==='extension.tasks'?[task]:m.method==='extension.approve'?{...task,state:'ready'}:{...task,state:'ready',activeMode:'full',modeGeneration:2}}))},executor);
 await consent.load();await consent.synchronize(bridge);
 const p={taskId:task.id,generation:1,modeGeneration:2,allowedOrigins:task.allowedOrigins,action:'new_tab',url:'https://example.test/',requestId:'one'};
 const a=await executor.execute(p),b=await executor.execute({...p,requestId:'two'});
 assert.equal(a.groupId,b.groupId);assert.ok(Number.isInteger(a.groupId));
 assert.equal(created.length,2);assert.ok(created.every(t=>t.active===false));
 assert.equal(tabs.get(1).groupId,-1);assert.equal(executor.leases.has(1),false);
 await executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
 await assert.rejects(executor.execute({...p,requestId:'revoked'}));
 assert.equal(created.length,2);
});

test('mode response cannot switch a different task or a different requested mode',async()=>{
 for(const change of [{id:'other'},{activeMode:'smart'},{generation:4},{modeGeneration:99}]){
  const sent=[];const b=new module.Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},{});
  const p=b.request('extension.mode',{taskId:'task',generation:3,modeGeneration:2,mode:'full'});
  b.receive({id:sent[0].id,result:{id:'task',generation:3,modeGeneration:3,activeMode:'full',...change}});
  await assert.rejects(p,/mode response mismatch/);
 }
});

// 中文注释：旧界面消息也不能恢复智能审批；模式不再是用户可变偏好。
test('trusted popup rejects removed mode controls without changing tasks',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const {Executor}=await import('../../native-extension/core.mjs');
 for(const storageFails of [false,true]){
  let listener;const calls=[];
  // 中文注释：合成后台提供通知事件 API，不访问系统通知中心。
 const chrome={notifications:{onClicked:{addListener(){}},clear:async()=>true},runtime:{id:'extension',onMessage:{addListener:fn=>{listener=fn;}}},
   storage:{local:{get:async()=>({browserFullConsent:{version:1,enabled:true}}),set:async()=>{if(storageFails)throw Error('storage failed');}},session:{}},
   tabs:{onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
   alarms:{create(){},onAlarm:{addListener(){}}},debugger:{onDetach:{addListener(){}}}};
  let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
  source=source.replace(/^import .*;\n/gm,'').replace(/connect\(\);\s*$/,'bridge=injectedBridge;connected=true;');
  vm.runInNewContext(source,{CloudLink,CookieMirror,chrome,Executor,BrowserConsent:module.BrowserConsent,isUiSender:module.isUiSender,
   reloadForInstalledBuild:async()=>false,BUILD_ID:'',registerWorkspaceStartup:()=>{},injectedBridge:{closed:false,request:async method=>{calls.push(method);return method==='extension.tasks'?[]:{revoked:true};}}});
  for(const message of [{type:'browser_consent',enabled:false},{type:'mode',taskId:'task',mode:'smart'}]){
   const result=await new Promise(resolve=>listener(message,{id:'extension',url:'chrome-extension://extension/popup.html'},resolve));
   assert.equal(result.error,'不支持的操作');
  }
  assert.deepEqual(calls,[]);
 }
});

test('native unsolicited messages cannot enable full access or install authority',async()=>{
 const sent=[];const executor={approve:()=>assert.fail('unsolicited grant'),setMode:()=>assert.fail('unsolicited mode')};
 const b=new module.Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},executor);
 b.receive({id:'forged',method:'browser.consent',params:{enabled:true}});
 b.receive({id:'not-pending',result:{activeMode:'full'}});
 await new Promise(r=>setImmediate(r));assert.equal(sent[0].error.code,'execution_denied');
});

test('local approval guard fences consent revoked while daemon reply is in flight',async()=>{
 let enabled=true,installed=false;
 const sent=[];const b=new module.Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},{approve:async()=>{installed=true;}});
 const p=b.request('extension.approve',{taskId:'task',generation:3,tabIds:[],allowedOrigins:['https://example.test']},()=>enabled);
 enabled=false;
 b.receive({id:sent[0].id,result:{id:'task',generation:3,tabIds:[],allowedOrigins:['https://example.test']}});
 await assert.rejects(p,/revoked/);assert.equal(installed,false);
});

test('native consent status command performs fresh reads and never defaults unknown to disabled',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');const sent=[];let reads=0;
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},{},()=>{}, {
  onConsentStatus:async()=>++reads===1?'enabled':'unknown'
 });
 bridge.receive({id:'read-1',method:'extension.consent_status',params:{}});
 bridge.receive({id:'read-2',method:'extension.consent_status',params:{}});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(sent.map(m=>m.result?.consentStatus),['enabled','unknown']);
 assert.equal(reads,2);
});

test('native access request opens management once per request id and never changes consent',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');const sent=[];let opens=0,grants=0;
 const params={requestId:'req-1',instanceId:'browser-a',connectionGeneration:'generation-a'};
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},{approve:()=>grants++},()=>{}, {
  onAccessRequest:async value=>{opens++;return {requestId:value.requestId,instanceId:value.instanceId,connectionGeneration:value.connectionGeneration,status:'opened'};}
 });
 bridge.receive({id:'host-1',method:'extension.access_request',params});
 bridge.receive({id:'host-2',method:'extension.access_request',params});
 await new Promise(r=>setImmediate(r));
 assert.equal(opens,1);assert.equal(grants,0);
 assert.deepEqual(sent.map(m=>m.result?.status),['opened','opened']);
 assert.deepEqual(sent.map(m=>m.id),['host-1','host-2']);
});

test('native access request id cannot be reused with another connection scope',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');const sent=[];let opens=0;
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:m=>sent.push(m)},{},()=>{}, {
  onAccessRequest:async value=>{opens++;return {requestId:value.requestId,instanceId:value.instanceId,connectionGeneration:value.connectionGeneration,status:'opened'};}
 });
 bridge.receive({id:'host-1',method:'extension.access_request',params:{requestId:'req',instanceId:'a',connectionGeneration:'g1'}});
 bridge.receive({id:'host-2',method:'extension.access_request',params:{requestId:'req',instanceId:'a',connectionGeneration:'g2'}});
 await new Promise(r=>setImmediate(r));
 assert.equal(opens,1);assert.ok(sent.some(m=>m.id==='host-2'&&m.error?.code==='request_conflict'));
});
