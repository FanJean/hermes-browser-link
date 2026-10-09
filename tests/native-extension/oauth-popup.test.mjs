// OAuth popup boundaries exercised through the real executor, no browser required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';
import {trustedTask,workspaceFixture} from './workspace-fixture.mjs';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';

async function fixture({workspace=false,...options}={}){
 const backing=workspace?workspaceFixture():null;
 const tabs=backing?.tabs||new Map([[1,{id:1,url:'https://example.com/',windowId:7}]]);
 const mutations=[];
 const api=backing?.api||{tabs:{get:async id=>{if(!tabs.has(id))throw Error('closed');return {...tabs.get(id)};},query:async()=>[...tabs.values()],remove:async id=>mutations.push(['remove',id])},windows:{get:async id=>({id,type:id===7?'normal':'popup'})}};
 if(backing){
  api.windows.get=async id=>({id,type:id===7?'normal':'popup'});
  const remove=api.tabs.remove;api.tabs.remove=async id=>{mutations.push(['remove',id]);return remove(id);};
 }
 const executor=new Executor(api,()=>{},options);await executor.approve(trustedTask());
 const debugCalls=[],listeners=new Set();
 api.debugger={onEvent:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)},
  attach:async target=>{debugCalls.push(['attach',target.tabId]);},detach:async target=>{debugCalls.push(['detach',target.tabId]);},
  sendCommand:async(target,method,params={})=>{
   debugCalls.push([method,target.tabId,params]);
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:`frame-${target.tabId}`,loaderId:`doc-${target.tabId}`,url:tabs.get(target.tabId).url}}};
   if(method==='Page.createIsolatedWorld')return {executionContextId:target.tabId};
   if(method==='Runtime.callFunctionOn')return {result:{value:true}};
   if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:`preveil-${target.tabId}`};
   return {};
  }};
 const command=(action,extra={})=>({taskId:'a',generation:1,modeGeneration:1,allowedOrigins:['https://example.com'],requestId:action,action,tabId:1,...extra});
 const create=(id=2,extra={})=>{const tab={id,openerTabId:1,windowId:8,url:'https://accounts.example.test/login?secret=private',...extra};tabs.set(id,tab);return executor.tabCreated(tab);};
 return {executor,tabs,command,create,mutations,debugCalls,listeners};
}

function publicBridge(f,onContentFilter=async()=>true){
 let deliver;
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:message=>deliver(message)},f.executor,()=>{},{onContentFilter});
 const request=params=>({id:params.requestId,sequence:1,method:'browser.execute',params});
 const send=message=>new Promise(resolve=>{deliver=resolve;bridge.receive(message);});
 return {bridge,request,send};
}

test('public popup catalog delivers only identity metadata with content shielding enabled',async()=>{
 const f=await fixture({onContentShield:async()=>({enabled:true,rules:{}})});
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});await f.create();
 const b=publicBridge(f),response=await b.send(b.request(f.command('popup_catalog')));
 assert.equal(response.error,undefined);assert.equal(response.result.candidates.length,1);
 assert.equal(response.result.candidates[0].origin,'https://accounts.example.test');
 assert.ok(!JSON.stringify(response).includes('private'));
 assert.equal(f.executor.leases.has(2),false);
});

for(const action of ['popup_catalog','popup_adopt'])for(const enabled of [false,true])test(`public ${action} refuses a shield toggle before delivery without replaying`,async()=>{
 let settings={enabled,rules:{}};
 const f=await fixture({onContentShield:async()=>settings});
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});await f.create();
 const command=action==='popup_adopt'?await approved(f):f.command(action);
 const b=publicBridge(f,async()=>{settings={...settings,enabled:!enabled};return settings.enabled;});
 let executions=0;const execute=f.executor.execute.bind(f.executor);
 f.executor.execute=async p=>{executions++;return execute(p);};
 const message=b.request(command),first=await b.send(message);
 assert.equal(first.error?.code,'content_shield_stale');
 assert.equal(first.error.data.outcomeUnknown,action==='popup_adopt');assert.equal(first.error.data.retryable,false);
 // Keep the changed setting for replay: only sending is repeated, never adoption.
 b.bridge.onContentFilter=async()=>settings.enabled;
 assert.deepEqual(await b.send(message),first);assert.equal(executions,1);
 assert.equal(f.executor.leases.get(2),action==='popup_adopt'?'a':undefined);
});

for(const action of ['popup_catalog','popup_adopt'])for(const [name,revoke] of [
 ['generation',f=>{f.executor.tasks.get('a').generation++;}],
 ['task replacement',f=>{f.executor.tasks.set('a',{...f.executor.tasks.get('a')});}],
 ['mode generation',f=>{const t=f.executor.tasks.get('a');t.policy={...t.policy,modeGeneration:t.policy.modeGeneration+1};}],
 ['source lease',f=>{f.executor.leases.delete(1);}],
 ['release',f=>{f.executor.tasks.get('a').revoked=true;}],
 ['receipt registration',f=>{f.executor.shieldResults=new WeakMap();}],
])test(`public ${action} refuses ${name} revocation at send and replay with shielding off`,async()=>{
 const f=await fixture({onContentShield:async()=>({enabled:false,rules:{}})});
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});await f.create();
 const command=action==='popup_adopt'?await approved(f):f.command(action),b=publicBridge(f,async()=>{revoke(f);return false;});
 let executions=0;const execute=f.executor.execute.bind(f.executor);
 f.executor.execute=async p=>{executions++;return execute(p);};
 const message=b.request(command),first=await b.send(message);
 assert.equal(first.error?.code,'content_shield_stale');assert.equal(first.error.data.outcomeUnknown,action==='popup_adopt');
 b.bridge.onContentFilter=async()=>false;assert.deepEqual(await b.send(message),first);assert.equal(executions,1);
});

test('public adopted popup receipt is fenced by its target lease',async()=>{
 const f=await fixture({onContentShield:async()=>({enabled:true,rules:{}})});
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});await f.create();
 const b=publicBridge(f,async()=>{f.executor.leases.set(2,'other');return true;});
 const response=await b.send(b.request(await approved(f)));
 assert.equal(response.error?.code,'content_shield_stale');assert.equal(response.error.data.outcomeUnknown,true);
 assert.equal(f.executor.leases.get(2),'other');
});

test('public adoption withholds unavailable filter settings as unknown and never replays',async()=>{
 const f=await fixture({onContentShield:async()=>({enabled:true,rules:{}})});
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});await f.create();
 const b=publicBridge(f,async()=>{throw Error('settings offline');}),message=b.request(await approved(f));
 const first=await b.send(message);
 assert.equal(first.error?.code,'content_filter_unavailable');assert.equal(first.error.data.outcomeUnknown,true);assert.equal(first.error.data.retryable,false);
 assert.equal(f.executor.leases.get(2),'a');assert.deepEqual(await b.send(message),first);
});

test('adoption initializes the existing overlay before publishing the popup lease',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),send=f.executor.api.debugger.sendCommand;
 f.executor.api.debugger.sendCommand=async(target,method,params)=>{
  if(target.tabId===2&&['Runtime.callFunctionOn','Page.getFrameTree','Page.createIsolatedWorld','Runtime.addBinding'].includes(method)){assert.equal(f.executor.leases.has(2),false);assert.equal(t.tabIds.has(2),false);}
  return send(target,method,params);
 };
 const adopted=await f.executor.execute(command);
 assert.equal(adopted.adopted,true);assert.ok(f.executor.attached.has(2));
 const status=await f.executor.status({taskId:'a',generation:1});assert.equal(status.pages.find(page=>page.tabId===2).control,'hermes');
 assert.equal(t.overlays?.get(2)?.documentId,'doc-2');assert.ok(f.listeners.has(t.overlays.get(2).listener));
 assert.ok(f.debugCalls.some(([method,id,p])=>method==='Runtime.callFunctionOn'&&id===2&&p.arguments?.[0]?.value==='update'&&p.arguments[1].value.update.state==='waiting'));
 assert.equal(f.executor.leases.get(2),'a');assert.deepEqual(f.mutations,[]);
});

for(const failure of ['attach','unsupported','initialization','update'])test(`adoption ${failure} failure cannot authorize an uncontrolled popup`,async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),send=f.executor.api.debugger.sendCommand;
 if(failure==='attach')f.executor.api.debugger.attach=async()=>{throw Error('busy');};
 if(failure==='unsupported')delete f.executor.api.debugger.onEvent;
 f.executor.api.debugger.sendCommand=async(target,method,p)=>{
  if(method==='Runtime.callFunctionOn'&&failure==='initialization'&&typeof p.arguments?.[0]?.value==='object')return {exceptionDetails:{text:'synthetic init failure'}};
  if(method==='Runtime.callFunctionOn'&&failure==='update'&&p.arguments?.[0]?.value==='update')return {result:{value:false}};
  return send(target,method,p);
 };
 const response=await publicBridge(f,async()=>false).send({id:command.requestId,sequence:1,method:'browser.execute',params:command});
 assert.equal(response.error?.code,'overlay_injection_failed');assert.equal(response.error.data.outcomeUnknown,false);
 assert.equal(f.executor.leases.has(2),false);assert.equal(t.tabIds.has(2),false);assert.equal(t.adoptedPopupTabs?.has(2)||false,false);
 assert.ok(!t.allowedOrigins.includes('https://accounts.example.test'));assert.equal(f.executor.attached.has(2),false);
 assert.equal(t.overlays?.has(2)||false,false);assert.equal(f.listeners.size,0);assert.deepEqual(f.mutations,[]);
 await assert.rejects(f.executor.vault.scope({taskId:'a',generation:1,modeGeneration:1,instanceId:t.instanceId,tabId:2}),/tab lease denied/);
 await assert.rejects(f.executor.execute(command),/approval mismatch|POPUP_STALE/);
});

for(const [name,change] of [
 ['target window',f=>{f.tabs.get(2).windowId=99;}],
 ['target opener',f=>{f.tabs.get(2).openerTabId=9;}],
 ['target origin',f=>{f.tabs.get(2).url='https://changed.test/';}],
 ['target document',f=>{f.executor.docs.set(2,1);} ],
 ['source window',f=>{f.tabs.get(1).windowId=99;}],
 ['source origin',f=>{f.tabs.get(1).url='https://changed.test/';}],
 ['approval expiry',null],
])test(`overlay initialization rechecks ${name} before adoption publishes authority`,async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),send=f.executor.api.debugger.sendCommand;
 const grant=f.executor.actionGrants.get(command.approval.nonce);
 f.executor.api.debugger.sendCommand=async(target,method,p)=>{
  const result=await send(target,method,p);
  if(method==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='update'){
   if(name==='approval expiry')grant.expiresAt=0;else change(f,command);
  }
  return result;
 };
 await assert.rejects(f.executor.execute(command));
 assert.equal(f.executor.leases.has(2),false);assert.equal(t.tabIds.has(2),false);
 assert.ok(!t.allowedOrigins.includes('https://accounts.example.test'));assert.equal(f.executor.attached.has(2),false);
 assert.equal(t.overlays?.has(2)||false,false);assert.deepEqual(f.mutations,[]);
});

for(const enabled of [false,true])test(`public adoption delivers and replays its receipt with shield ${enabled}`,async()=>{
 const f=await fixture({onContentShield:async()=>({enabled,rules:{}})}),t=f.executor.tasks.get('a');
 await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const b=publicBridge(f,async()=>enabled),message=b.request(await approved(f));
 let executions=0;const execute=f.executor.execute.bind(f.executor);
 f.executor.execute=async p=>{executions++;return execute(p);};
 const first=await b.send(message);
 assert.equal(first.error,undefined);assert.equal(first.result.adopted,true);assert.equal(first.result.cleanupOwned,false);
 assert.deepEqual(await b.send(message),first);assert.equal(executions,1);
 // Cached successful receipts must be revalidated after actual lease revocation.
 await f.executor.release({taskId:'a',generation:1,closeAgentTabs:true});
 const stale=await b.send(message);assert.equal(stale.error?.code,'content_shield_stale');assert.equal(stale.error.data.outcomeUnknown,true);
 assert.equal(executions,1);assert.equal(f.executor.leases.has(2),false);assert.deepEqual(f.mutations,[]);
 assert.equal(t.overlays.has(2),false);assert.ok(!t.agentTabs.has(2));assert.equal(f.tabs.get(2).windowId,8);assert.equal(f.tabs.get(2).openerTabId,1);
 await assert.rejects(f.executor.vault.scope({taskId:'a',generation:1,modeGeneration:1,instanceId:t.instanceId,tabId:2}),/stale generation/);
 // A lost/evicted receipt is a tombstone, not permission to execute again.
 b.bridge.ledger.maxEntries=0;b.bridge.ledger.trim();
 const lost=await b.send(message);assert.equal(lost.error?.code,'request_outcome_unavailable');assert.equal(lost.error.data.outcomeUnknown,true);assert.equal(executions,1);
});

test('adopted popup mounts a persistent cursor, veil and takeover/stop controls in its isolated world',async()=>{
 const f=await fixture({onContentShield:async()=>({enabled:true,rules:{}})}),t=f.executor.tasks.get('a');
 await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const dom=new JSDOM('<!doctype html><button>synthetic login</button>',{url:f.tabs.get(2).url,runScripts:'outside-only',pretendToBeVisual:true});
 let shadow;const attachShadow=dom.window.Element.prototype.attachShadow;
 dom.window.Element.prototype.attachShadow=function(options){const root=attachShadow.call(this,options);if(this.hasAttribute('data-hermes-automation-overlay'))shadow=root;return root;};
 const send=f.executor.api.debugger.sendCommand;
 f.executor.api.debugger.sendCommand=async(target,method,p)=>{
  if(target.tabId===2&&method==='Runtime.callFunctionOn'){
   const fn=dom.window.eval(`(${p.functionDeclaration})`);
   return {result:{value:await fn(...(p.arguments||[]).map(arg=>arg.value))}};
  }
  return send(target,method,p);
 };
 try{
  const b=publicBridge(f),response=await b.send(b.request(await approved(f)));
  assert.equal(response.error,undefined);assert.equal(response.result.adopted,true);
  const host=dom.window.document.querySelector('[data-hermes-automation-overlay]');assert.ok(host);
  assert.equal(host.style.pointerEvents,'auto');assert.ok(shadow.querySelector('[data-role="veil"]'));
  assert.equal(shadow.querySelector('[data-role="virtual-cursor"]').style.display,'block');
  assert.equal(shadow.querySelector('[data-action="takeover"]').textContent,'接管页面');assert.equal(shadow.querySelector('[data-action="stop"]').textContent,'停止任务');
  await f.executor.overlayCall(2,t.overlays.get(2),'update',{update:{state:'waiting'}});
  assert.equal(shadow.querySelector('[data-role="virtual-cursor"]').style.display,'block');
  await f.executor.release({taskId:'a',generation:1,closeAgentTabs:true});
  assert.equal(dom.window.document.querySelector('[data-hermes-automation-overlay]'),null);assert.deepEqual(f.mutations,[]);
 }finally{dom.window.close();}
});

test('popup document replacement without a leased-tab event cannot publish an old overlay',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),send=f.executor.api.debugger.sendCommand;let replaced=false;
 f.executor.api.debugger.sendCommand=async(target,method,p)=>{
  const result=await send(target,method,p);
  if(method==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='update')replaced=true;
  if(target.tabId===2&&method==='Page.getFrameTree'&&replaced)result.frameTree.frame.loaderId='replacement-doc';
  return result;
 };
 await assert.rejects(f.executor.execute(command),/POPUP_STALE/);
 assert.equal(f.executor.leases.has(2),false);assert.equal(t.overlays?.has(2)||false,false);assert.equal(f.executor.attached.has(2),false);
});

test('timed-out popup initialization is fenced even if the isolated-world receipt arrives late',{timeout:10000},async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),send=f.executor.api.debugger.sendCommand;
 let entered,complete;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>complete=resolve);
 f.executor.api.debugger.sendCommand=async(target,method,p)=>{
  if(target.tabId===2&&method==='Runtime.callFunctionOn'&&typeof p.arguments?.[0]?.value==='object'){entered();await gate;}
  return send(target,method,p);
 };
 const operation=f.executor.execute(command);await started;
 assert.equal(f.executor.leases.has(2),false);
 try{
  await assert.rejects(operation,/overlay injection failed/);
  assert.equal(f.executor.leases.has(2),false);assert.ok(!t.allowedOrigins.includes('https://accounts.example.test'));
 }finally{complete();}
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(t.overlays?.has(2)||false,false);assert.equal(f.listeners.size,0);assert.equal(f.executor.attached.has(2),false);
 assert.equal(f.executor.leases.has(2),false);assert.deepEqual(f.mutations,[]);
});

test('real workspace cleanup deletes owned work tabs but never an adopted original popup',async()=>{
 const f=await fixture({workspace:true}),t=f.executor.tasks.get('a');assert.ok(t.workspaceCapability);
 f.executor.setMode({...trustedTask(),modeGeneration:2,activeMode:'full'});
 const create=f.executor.api.tabs.create;
 f.executor.api.tabs.create=async params=>{const tab=await create(params);f.tabs.get(tab.id).status='complete';return {...tab,status:'complete'};};
 const open=f.command('new_tab',{modeGeneration:2,url:'https://example.com/'});delete open.tabId;
 const owned=await f.executor.execute(open);assert.ok(t.agentTabs.has(owned.tabId));
 await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const result=await f.executor.execute(await approved(f));assert.equal(result.cleanupOwned,false);assert.ok(!t.agentTabs.has(2));
 f.executor.api.debugger.getTargets=async()=>[{id:'original-popup-target',tabId:2,type:'page',url:f.tabs.get(2).url}];
 const bridge=publicBridge(f,async()=>false);
 const close=await bridge.send({id:'close-original-popup',method:'browser.cdp_close',params:{taskId:'a',generation:1,modeGeneration:2,targetId:'original-popup-target'}});
 assert.equal(close.error?.code,'target_not_owned');assert.deepEqual(f.mutations,[]);assert.equal(f.executor.leases.get(2),'a');
 const release=await f.executor.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.equal(release.cleanupState,'succeeded');assert.deepEqual(f.mutations,[['remove',owned.tabId]]);
 assert.ok(f.tabs.has(2));assert.equal(f.tabs.get(2).windowId,8);assert.equal(f.tabs.get(2).openerTabId,1);assert.equal(f.executor.leases.has(2),false);
 await assert.rejects(f.executor.vault.scope({taskId:'a',generation:1,modeGeneration:2,instanceId:t.instanceId,tabId:2}),/stale generation/);
});

async function approved(f){
 const currentModeGeneration=f.executor.tasks.get('a').policy.modeGeneration;
 const [candidate]=(await f.executor.execute(f.command('popup_catalog',{modeGeneration:currentModeGeneration}))).candidates;
 const command=f.command('popup_adopt',{modeGeneration:currentModeGeneration,candidateRef:candidate.candidateRef});
 const popupScope=await f.executor.preparePopup(command),nonce=randomUUID(),digest='test';
 const {generation,modeGeneration,allowedOrigins,...request}=command;
 f.executor.approveAction({taskId:'a',generation,modeGeneration,request,nonce,digest,popupScope,expiresAt:Date.now()/1000+120});
 return {...command,popupScope,approval:{nonce,digest}};
}

test('adopted popup retains Vault eligibility and script conflict without acquiring cleanup authority',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 await f.executor.execute(await approved(f));
 f.executor.api.debugger={attach:async()=>{},detach:async()=>{}};
 f.executor.ensureOverlay=async()=>({contextId:1});
 const p={taskId:'a',generation:1,modeGeneration:1,instanceId:t.instanceId,tabId:2};
 assert.equal((await f.executor.vault.scope(p)).t,t);
 t.scriptedTabs=new Set([2]);await assert.rejects(f.executor.vault.scope(p),/CREDENTIAL_MODE_CONFLICT/);
 assert.ok(!t.agentTabs.has(2));
});

for(const [name,change] of [
 ['source origin',f=>{f.tabs.get(1).url='https://changed.test/';}],
 ['source window',f=>{f.tabs.get(1).windowId=99;}],
 ['source document',f=>{f.executor.docs.set(1,1);} ],
 ['target origin',f=>{f.tabs.get(2).url='https://changed.test/';}],
 ['target window',f=>{f.tabs.get(2).windowId=99;}],
 ['target opener',f=>{f.tabs.get(2).openerTabId=9;}],
 ['target closed',f=>{f.tabs.delete(2);} ],
 ['target leased',f=>{f.executor.leases.set(2,'other');}],
 ['candidate expired',f=>{for(const row of f.executor.popups.candidates.values())row.expiresAt=0;}],
 ['task paused',f=>{f.executor.tasks.get('a').paused=true;}],
])test(`confirmation fails closed when ${name} changes`,async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f);change(f);
 await assert.rejects(f.executor.execute(command));
 assert.ok(!t.tabIds.has(2));assert.ok(!t.allowedOrigins.includes('https://accounts.example.test'));assert.deepEqual(f.mutations,[]);
});

test('catalog cannot claim old personal pages, no-opener pages or normal-window children',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');
 await f.create(4); // Created before the observation window, even with an opener.
 await f.executor.execute(f.command('popup_catalog'));
 await f.create(5,{openerTabId:undefined});
 // No live spawn scope: ordinary tab is not an independent popup candidate.
 await f.create(6,{windowId:7});
 await f.create(7,{openerTabId:9});
 const catalog=await f.executor.execute(f.command('popup_catalog'));
 assert.equal(catalog.candidates.length,0);assert.equal(t.tabIds.size,1);
});

test('source changing during popup window inspection cannot cross the adoption fence',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),getWindow=f.executor.api.windows.get;
 f.executor.api.windows.get=async id=>{const result=await getWindow(id);f.tabs.get(1).url='https://changed.test/';return result;};
 await assert.rejects(f.executor.execute(command));assert.ok(!t.tabIds.has(2));
});

test('confirmation expiring while waiting for the source lock is not adopted',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),grant=f.executor.actionGrants.get(command.approval.nonce);
 let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const blocker=f.executor.lock(1,async()=>{entered();await gate;});await started;
 const operation=f.executor.execute(command);await Promise.resolve();await Promise.resolve();
 grant.expiresAt=0;release();await blocker;
 await assert.rejects(operation);assert.ok(!t.tabIds.has(2));
});

test('source document changing during the final target readback cannot acquire a lease',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f),get=f.executor.api.tabs.get;let targetReads=0;
 f.executor.api.tabs.get=async id=>{
  const tab=await get(id);
  if(id===2&&++targetReads===2){f.tabs.get(1).url='https://changed.test/';f.executor.docs.set(1,1);}
  return tab;
 };
 await assert.rejects(f.executor.execute(command),/POPUP_STALE/);
 assert.ok(!t.tabIds.has(2));assert.equal(f.executor.leases.has(2),false);
});

test('source navigation invalidates popup approval before asynchronous page cleanup',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const command=await approved(f);let release;
 const gate=new Promise(resolve=>release=resolve);f.executor.closeTabResources=async()=>gate;
 const navigation=f.executor.tabEvent(1,'navigated','https://changed.test/');
 try{await assert.rejects(f.executor.execute(command),/POPUP_STALE/);assert.equal(f.executor.leases.has(2),false);}
 finally{release();await navigation;}
});

test('catalog discovers only newly observed independent popup metadata after action settles',async()=>{
 const f=await fixture();
 await f.executor.withSpawnScope(f.executor.tasks.get('a'),1,async()=>{});
 await f.create();
 const catalog=await f.executor.execute(f.command('popup_catalog'));
 assert.equal(catalog.candidates.length,1);
 assert.deepEqual(Object.keys(catalog.candidates[0]).sort(),['candidateRef','openerTabId','origin','tabId','windowId','windowType'].sort());
 assert.equal(catalog.candidates[0].origin,'https://accounts.example.test');
 assert.ok(!JSON.stringify(catalog).includes('private'));
 assert.equal(f.executor.leases.has(2),false);
 assert.deepEqual(f.mutations,[]);
});

test('initial popup navigation before metadata inspection remains discoverable',async()=>{
 const f=await fixture();await f.executor.execute(f.command('popup_catalog'));await f.create();
 await f.executor.tabEvent(2,'navigated','https://accounts.example.test/login');
 assert.equal((await f.executor.execute(f.command('popup_catalog'))).candidates.length,1);
});

test('Edge creation without opener metadata reads back only the newly created tab',async()=>{
 const f=await fixture();await f.executor.execute(f.command('popup_catalog'));
 f.tabs.set(2,{id:2,openerTabId:1,windowId:8,url:'https://accounts.example.test/login'});
 await f.executor.tabCreated({id:2,windowId:8});
 const catalog=await f.executor.execute(f.command('popup_catalog'));
 assert.equal(catalog.candidates.length,1);assert.equal(catalog.candidates[0].openerTabId,1);
 assert.equal(f.executor.leases.has(2),false);assert.deepEqual(f.mutations,[]);
});

test('late opener readback cannot use an observation started after tab creation',async()=>{
 const f=await fixture();
 f.tabs.set(2,{id:2,openerTabId:1,windowId:8,url:'https://accounts.example.test/login'});
 const created=f.executor.tabCreated({id:2,windowId:8});
 await f.executor.execute(f.command('popup_catalog'));await created;
 assert.deepEqual((await f.executor.execute(f.command('popup_catalog'))).candidates,[]);
});

for(const change of ['expired','window','revoked','source navigation'])test(`late opener readback rejects ${change} creation identity`,async()=>{
 const f=await fixture();await f.executor.execute(f.command('popup_catalog'));
 f.tabs.set(2,{id:2,openerTabId:1,windowId:8,url:'https://accounts.example.test/login'});
 const get=f.executor.api.tabs.get;let started,release;
 const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 f.executor.api.tabs.get=async id=>{if(id===2){started();await gate;}return get(id);};
 const created=f.executor.tabCreated({id:2,windowId:8});await entered;
 if(change==='expired')for(const row of f.executor.popups.observations.values())row.expiresAt=0;
 if(change==='window')f.tabs.get(2).windowId=9;
 if(change==='revoked')f.executor.tasks.get('a').revoked=true;
 if(change==='source navigation')await f.executor.tabEvent(1,'navigated','https://changed.test/');
 release();await created;assert.equal(f.executor.popups.candidates.size,0);
});

test('full mode still requires exact confirmation; adoption preserves existing opener without cleanup ownership',async()=>{
 const f=await fixture(),t=f.executor.tasks.get('a');
 f.executor.setMode({...trustedTask(),modeGeneration:2,activeMode:'full'});
 await f.executor.withSpawnScope(t,1,async()=>{});await f.create();
 const catalog=await f.executor.execute(f.command('popup_catalog',{modeGeneration:2}));
 const command=f.command('popup_adopt',{modeGeneration:2,candidateRef:catalog.candidates[0].candidateRef});
 await assert.rejects(f.executor.execute(command),/confirmation required/);
 const scope=await f.executor.preparePopup(command),nonce=randomUUID(),digest='test-digest';
 const {generation,modeGeneration,allowedOrigins,...request}=command;
 f.executor.approveAction({taskId:'a',generation,modeGeneration,request,nonce,digest,popupScope:scope,expiresAt:Date.now()/1000+120});
 const adopted=await f.executor.execute({...command,popupScope:scope,approval:{nonce,digest}});
 assert.equal(adopted.tabId,2);assert.equal(adopted.adopted,true);
 assert.equal(f.executor.leases.get(2),'a');assert.ok(t.tabIds.has(2));
 assert.ok(t.adoptedPopupTabs.has(2));assert.ok(!t.agentTabs.has(2));
 assert.ok(t.allowedOrigins.includes('https://accounts.example.test'));
 assert.equal(f.tabs.get(2).openerTabId,1);assert.deepEqual(f.mutations,[]);
 await assert.rejects(f.executor.execute({...command,popupScope:scope,approval:{nonce,digest}}),/approval mismatch|POPUP_STALE/);
});
