import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
const load = () => import(process.env.CORE_UNDER_TEST || '../../native-extension/core.mjs');
import {trustedTask as task, workspaceFixture} from './workspace-fixture.mjs';
const newTabCommand=(taskId='a',requestId='new-work-tab')=>({taskId,generation:1,requestId,action:'new_tab',url:'https://example.com/',allowedOrigins:['https://example.com']});
const safeTree=tabId=>({frameTree:{frame:{id:`main-${tabId}`,loaderId:`document-${tabId}`,url:'https://example.com/'}}});
const fixtureResult=value=>({result:{value}});
function highlightReadyFixture(api,{hideConfirmed=true}={}){
 const listeners=new Set();
 api.debugger.onEvent={addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)};
 const sendCommand=api.debugger.sendCommand.bind(api.debugger);
 api.debugger.sendCommand=async(target,method,params={})=>{
  // The overlay installs this binding before its actions; emulate the API response
  // instead of treating an unmodelled setup command as a deliberately gated call.
  // 中文注释：预遮罩注册不是截图派发，不能进入截图的阻塞桩。
  if(['Runtime.addBinding','Page.enable','Page.removeScriptToEvaluateOnNewDocument'].includes(method))return {};
  if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'fixture-preveil'};
  if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
  if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
  if(method==='Runtime.callFunctionOn'){
   const declaration=params.functionDeclaration||'',op=params.arguments?.[0]?.value;
   if(declaration.includes('const createAutomationOverlay='))return fixtureResult(true);
   if(declaration.startsWith('function(op,scope){const state=')){
    if(op==='hide')return fixtureResult(hideConfirmed);
    if(['restore','remove','scope','scope-running','update','reblock','revoke','reply'].includes(op))return fixtureResult(true);
   }
   if(declaration.startsWith('function interactionHighlightCommand(')){
    if(['prepare-selector','prepare-drag-selectors','verify-selector','verify-drag-selectors','painted','complete','clear'].includes(op))return fixtureResult({ok:true});
   }
  }
  return sendCommand(target,method,params);
 };
 return api;
}

// Test-only trusted extension UI confirmation of this exact request; not task-wide authority.
function executeUserApproved(executor, command) {
 const {generation,modeGeneration=1,allowedOrigins,...request}=command;
 const nonce=randomUUID(),digest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 executor.approveAction({taskId:command.taskId,generation,modeGeneration,request,nonce,digest,expiresAt:Date.now()/1000+120});
 return executor.execute({...command,modeGeneration,approval:{nonce,digest}});
}

test('task approval defaults to smart; supported interaction writes need confirmation and JS/CDP remain denied',async()=>{
 const {Executor}=await load();let effects=0;
 const e=new Executor({tabs:{get:async id=>({id,url:'https://example.com/'}),create:async()=>{effects++;},update:async()=>{effects++;}},debugger:{attach:async()=>{effects++;},sendCommand:async()=>{effects++;}}});
 await e.approve(task());
 for(const action of ['navigate','new_tab','click','fill','press','ref_click','ref_fill']){
  const command={taskId:'a',generation:1,tabId:1,action,url:'https://example.com/',selector:'#x',text:'ordinary',allowedOrigins:task().allowedOrigins};
  await assert.rejects(e.execute(command),/confirmation required/);
  await assert.rejects(e.execute({...command,activeMode:'full',confirmed:true}),/confirmation required/);
 }
 for(const action of ['interaction.click','interaction.drag_coordinates','interaction.drag_elements']){
  const command={taskId:'a',generation:1,tabId:1,action,allowedOrigins:task().allowedOrigins};
  await assert.rejects(e.execute(command),/confirmation required/);
  await assert.rejects(e.execute({...command,activeMode:'full',confirmed:true}),/confirmation required/);
 }
 assert.equal(effects,0);
 for(const action of ['evaluate','cdp','Runtime.evaluate'])await assert.rejects(e.execute({taskId:'a',generation:1,tabId:1,action,allowedOrigins:task().allowedOrigins}),/V1 unsupported action/);
 for(const action of ['interaction.capture','interaction.bounds']){
  await assert.rejects(e.execute({taskId:'a',generation:1,action,allowedOrigins:task().allowedOrigins}),/explicit tabId required/);
  await assert.rejects(e.execute({taskId:'a',generation:1,tabId:1,action,allowedOrigins:['https://evil.test']}),/origin authority mismatch/);
 }
 assert.equal(e.tasks.get('a').policy.activeMode,'smart');
});

test('接管等待当前动作结束并使旧页面引用失效',async()=>{
 const {Executor}=await load();const {api}=workspaceFixture();const e=new Executor(api);await e.approve(task());
 const current=e.tasks.get('a');current.semanticBindings.set(1,{leaseId:'old'});current.frameRefs.set(1,new Map());
 let finish;const running=new Promise(resolve=>{finish=resolve});// 中文注释：并行执行器使用任务屏障和同页锁。
 const inflight=e.taskBarrier('a',false,()=>e.lock(1,()=>running));await new Promise(resolve=>setImmediate(resolve));
 let settled=false;const pause=e.pause('a',1).then(()=>{settled=true});
 await Promise.resolve();assert.equal(settled,false);assert.equal(current.pauseRequested,true);
 finish();await pause;await inflight;
 assert.equal(current.paused,true);assert.equal(current.semanticBindings.size,0);assert.equal(current.frameRefs.size,0);
 assert.equal(e.leases.get(1),'a');
 await e.resume('a',1);assert.equal(current.paused,false);assert.equal(current.pauseRequested,false);
 assert.equal(e.leases.get(1),'a');
});

test('trusted per-action fixture leaves smart mode and does not authorize the next request',async()=>{
 const {Executor}=await load();let updates=0;
 const e=new Executor({tabs:{get:async id=>({id,url:'https://example.com/'}),update:async()=>{updates++;return {url:'https://example.com/next'};}}});
 await e.approve(task());
 const command={taskId:'a',generation:1,tabId:1,action:'navigate',url:'https://example.com/next',allowedOrigins:task().allowedOrigins};
 await executeUserApproved(e,command);
 assert.equal(updates,1);assert.equal(e.actionGrants.size,0);
 assert.equal(e.tasks.get('a').policy.activeMode,'smart');
 await assert.rejects(e.execute(command),/confirmation required/);
 assert.equal(updates,1);
});

test('fixed CDP actions enforce origins, cancel races and preserve user tabs',async()=>{
 const {Executor}=await load();const {api,tabs,removed}=workspaceFixture(),commands=[];
 let resolveCreate,created;
 const createGate=new Promise(r=>resolveCreate=r),createStarted=new Promise(r=>created=r);
 const create=api.tabs.create;
 api.tabs.create=async p=>{const tab=await create(p);created();await createGate;return tab;};
 api.debugger={attach:async()=>{},detach:async()=>{},sendCommand:async(_,m,p)=>{commands.push([m,p]);if(m==='Page.getFrameTree')return safeTree(1);if(m==='Page.createIsolatedWorld')return {executionContextId:1};return {result:{value:{ok:true,targetAssessment:'ordinary'}}};}};
 const e=new Executor(highlightReadyFixture(api));await e.approve(task());
 await assert.rejects(executeUserApproved(e,{taskId:'a',generation:1,tabId:1,action:'navigate',url:'https://evil.test/',allowedOrigins:['https://example.com']}),/origin/);
 await assert.rejects(e.execute({taskId:'a',generation:1,tabId:1,action:'evaluate',allowedOrigins:['https://example.com']}),/unsupported/);
 await executeUserApproved(e,{taskId:'a',generation:1,tabId:1,action:'fill',selector:'#x',text:'hello',allowedOrigins:['https://example.com']});assert.equal(commands.findLast(([m])=>m==='Runtime.callFunctionOn')[0],'Runtime.callFunctionOn');
 const pending=executeUserApproved(e,newTabCommand());
 // Either fence may win: the executor's generation check or the workspace's
 // cancellation. Both are non-read failures reported as outcome-unknown.
 const rejected=assert.rejects(pending,/CANCELLED|stale generation/);
 await createStarted;
 const stopping=e.release({taskId:'a',generation:1,closeAgentTabs:true});
 // Cleanup is queued behind the in-flight create; let its response arrive after fencing.
 await Promise.resolve();resolveCreate();await rejected;await stopping;
 assert.deepEqual(removed,[3]);assert.ok(tabs.has(1));assert.equal(tabs.get(1).groupId,-1);
 assert.equal(e.leases.has(1),false);assert.equal(e.actionGrants.size,0);
 await assert.rejects(e.approve(task('b',[9])),/origin/);
});

test('release waits for in-flight CDP before another task can claim tab',async()=>{
 const {Executor}=await load();let finish,started;const shooting=new Promise(resolve=>{started=resolve;});let detach=0;const api=highlightReadyFixture({tabs:{get:async()=>({url:'https://example.com/'})},debugger:{attach:async()=>{},detach:async()=>{detach++;},sendCommand:async(_,method)=>{if(method==='Page.getFrameTree')return safeTree(1);if(method==='Page.createIsolatedWorld')return {executionContextId:1};if(method==='Runtime.callFunctionOn')return {result:{value:{hasSensitiveValue:false}}};return new Promise(r=>{finish=r;started();});}}});const e=new Executor(api);await e.approve(task());
 const running=e.execute({taskId:'a',generation:1,tabId:1,action:'screenshot',allowedOrigins:['https://example.com']});await shooting;const stop=e.release({taskId:'a',generation:1,closeAgentTabs:false});await assert.rejects(e.approve(task('b')),/claimed/);finish({data:'png'});await assert.rejects(running,/stale/);await stop;await e.approve(task('b'));assert.equal(detach,1);
});

test('closing cancelled task cannot close agent tab adopted by another task',async()=>{
 const {Executor}=await load();const {api,tabs,removed}=workspaceFixture();const e=new Executor(api);
 await e.approve(task());const work=await executeUserApproved(e,newTabCommand());
 // User moved this work page out of the owned group before cancellation.
 tabs.get(work.tabId).groupId=-1;
 await e.release({taskId:'a',generation:1,closeAgentTabs:false});
 assert.ok(tabs.has(work.tabId));assert.equal(e.leases.has(work.tabId),false);
 await e.approve(task('b',[work.tabId]));
 await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.deepEqual(removed,[]);assert.equal(e.leases.get(work.tabId),'b');assert.ok(tabs.has(1));
});

test('resume is denied until old-generation detach completes',async()=>{
 const {Executor}=await load();let finish;const e=new Executor({tabs:{get:async()=>({url:'https://example.com/'})},debugger:{detach:()=>new Promise(r=>finish=r)}});await e.approve(task());e.attached.add(1);const stop=e.release({taskId:'a',generation:1,closeAgentTabs:false});await new Promise(r=>setTimeout(r,0));await assert.rejects(e.approve({...task(),generation:2}),/active|releasing/);finish();await stop;await e.approve({...task(),generation:2});assert.equal(e.leases.get(1),'a');
});

test('different task/tab queues progress independently',async()=>{
 const {Executor}=await load();let finish;const api=highlightReadyFixture({tabs:{get:async()=>({url:'https://example.com/'})},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async({tabId},method)=>{if(method==='Page.getFrameTree')return safeTree(tabId);if(method==='Page.createIsolatedWorld')return {executionContextId:tabId};if(method==='Runtime.callFunctionOn')return {result:{value:{hasSensitiveValue:false}}};return tabId===1?new Promise(r=>finish=r):{data:'peer'};}}});const e=new Executor(api);await e.approve(task());await e.approve(task('b',[2]));const p=e.execute({taskId:'a',generation:1,tabId:1,action:'screenshot',allowedOrigins:['https://example.com']});await new Promise(r=>setTimeout(r,0));assert.equal((await e.execute({taskId:'b',generation:1,tabId:2,action:'screenshot',allowedOrigins:['https://example.com']})).data,'peer');finish({data:'a'});await p;
});

test('approval creates exclusive task/tab leases and explicit tab required',async()=>{
 const {Executor}=await load();const e=new Executor({tabs:{get:async id=>({id,url:'https://example.com/'})}});
 await e.approve(task()); await assert.rejects(e.approve(task('b')),/claimed/);
 await assert.rejects(e.execute({taskId:'a',generation:1,action:'snapshot',allowedOrigins:['https://example.com']}),/explicit/);
 await assert.rejects(e.execute({taskId:'a',generation:1,tabId:2,action:'snapshot',allowedOrigins:['https://example.com']}),/lease/);
 assert.deepEqual(await e.execute({taskId:'a',generation:1,action:'tabs',allowedOrigins:['https://example.com']}),[{id:1,url:'https://example.com/'}]);
});

test('approval rechecks selected tab origins and serializes competing leases',async()=>{
 const {Executor}=await load();let first=true;let unblock;const e=new Executor({tabs:{get:async()=>{if(first){first=false;await new Promise(r=>unblock=r);}return {id:1,url:'https://example.com/'};}}});
 const a=e.approve(task());const b=e.approve(task('b'));await new Promise(r=>setTimeout(r,0));unblock();await a;await assert.rejects(b,/claimed/);
 const changed=new Executor({tabs:{get:async()=>({id:1,url:'https://evil.test/'})}});await assert.rejects(changed.approve(task()),/origin/);assert.equal(changed.leases.size,0);
});

test('uninspectable frame and sensitive screenshot checks fail closed with genuine privacy reasons',async()=>{
 const {Executor}=await load();const commands=[],inspected=[];let childUrl='https://evil.test/',sensitiveFrame=null,restoreConfirmed=true;
 const api={tabs:{get:async()=>({id:1,url:'https://example.com/',status:'complete'})},debugger:{onEvent:{addListener(){},removeListener(){}},attach:async()=>{},detach:async()=>{},sendCommand:async(_,method,params={})=>{
  commands.push(method);
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'main-document',url:'https://example.com/'},childFrames:[{frame:{id:'child',loaderId:'child-document',url:childUrl}}]}};
  // 中文注释：DOM 与 frame tree 必须一致；无可信几何的跨源 iframe 不能被截图掩码证明安全。
  if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[{nodeName:'IFRAME',frameId:'child',contentDocument:{nodeName:'HTML',children:[]}}]}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:params.frameId};
  if(method==='Runtime.callFunctionOn'){
   const declaration=params.functionDeclaration||'',op=params.arguments?.[0]?.value;
   if(declaration.includes('const createAutomationOverlay='))return fixtureResult(true);
   if(declaration.startsWith('function(op,scope){const state='))return fixtureResult(op==='restore'?restoreConfirmed:true);
   if(declaration.includes('function inspectPage(')){inspected.push(params.executionContextId);return fixtureResult({hasSensitiveValue:params.executionContextId===sensitiveFrame});}
   throw Error('unexpected capture fixture function');
  }
  if(method==='Page.captureScreenshot')return {data:'png'};
  return {};
 }}};
 const e=new Executor(api);await e.approve(task());
 const request={taskId:'a',generation:1,tabId:1,action:'screenshot',allowedOrigins:['https://example.com']};
 const catalog=await e.execute({...request,action:'frame_catalog'});
 assert.equal(catalog.frames[0].access,'origin_denied');assert.equal(catalog.frames[0].frameToken,undefined);assert.equal(catalog.coverage.complete,false);
 commands.length=0;
 await assert.rejects(e.execute(request),{message:'CAPTURE_FRAME_UNINSPECTABLE'});
 assert.ok(!commands.includes('Page.captureScreenshot'));assert.ok(!inspected.includes('child'),'denied child must never be inspected');
 childUrl='https://example.com/frame';sensitiveFrame='child';commands.length=0;inspected.length=0;
 await assert.rejects(e.execute(request),{message:'CAPTURE_SENSITIVE_BLOCKED'});
 assert.ok(inspected.includes('child'),'sensitive child refusal must follow actual inspection');assert.ok(!commands.includes('Page.captureScreenshot'));
 // 中文注释：双失败不得吞掉真正隐私拒绝；精确核对 AggregateError 的两个底层错误，而不是接受任意异常。
 const current=e.tasks.get('a'),entry=current.overlays.get(1);assert.ok(entry);
 restoreConfirmed=false;commands.length=0;
 await assert.rejects(e.captureWithoutDecorations(current,1,entry,()=>{},async()=>{
  await e.assertSafeCapture({tabId:1},current,()=>{});
  return api.debugger.sendCommand({tabId:1},'Page.captureScreenshot');
 }),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.message,'capture and overlay restoration failed');
  assert.deepEqual(error.errors.map(item=>item.message),['CAPTURE_SENSITIVE_BLOCKED','overlay restore failed']);
  assert.equal(error.errors[1].cause.message,'overlay restore failed');return true;
 });
 assert.ok(!commands.includes('Page.captureScreenshot'));
});

test('redirected main frame is rejected after a fixed page action',async()=>{
 const {Executor}=await load();let frameReads=0;const e=new Executor({tabs:{get:async()=>({id:1,url:'https://example.com/'})},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(_,method)=>{if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:++frameReads===1?'https://example.com/':'https://evil.test/'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:1};if(method==='Runtime.callFunctionOn')return {result:{value:{ok:true}}};}}});await e.approve(task());
 await assert.rejects(e.execute({taskId:'a',generation:1,tabId:1,action:'snapshot',allowedOrigins:['https://example.com']}),/origin/);
});

test('closing an agent tab retains its lease until removal completes',async()=>{
 const {Executor}=await load();const {api,removed}=workspaceFixture();let finishRemove,removing;
 // 中文注释：本用例只检查关闭期间的租约，合成新页直接报告加载完成。
 const get=api.tabs.get;api.tabs.get=async id=>({...await get(id),status:'complete'});
 const removeStarted=new Promise(r=>removing=r),removeGate=new Promise(r=>finishRemove=r),remove=api.tabs.remove;
 api.tabs.remove=async id=>{removing();await removeGate;await remove(id);};
 const e=new Executor(api);await e.approve(task('a',[]));const work=await executeUserApproved(e,newTabCommand());
 const closing=e.release({taskId:'a',generation:1,closeAgentTabs:true});await removeStarted;
 await assert.rejects(e.approve(task('b',[work.tabId])),/claimed/);
 assert.equal(e.leases.get(work.tabId),'a');finishRemove();await closing;
 assert.deepEqual(removed,[work.tabId]);assert.equal(e.leases.has(work.tabId),false);
});

test('label and descriptive metadata cannot disguise sensitive fill or press targets',async()=>{
 const {pageAction,inspectPage}=await load();class Input{set value(v){this._value=v;}get value(){return this._value||'';}}const field=new Input();Object.assign(field,{tagName:'INPUT',type:'text',name:'',id:'x',autocomplete:'',placeholder:'',className:'field',attributes:[],labels:[{textContent:'Account password'}],disabled:false,getAttribute:()=>'',closest:()=>null,focus(){globalThis.document.activeElement=this;}});
 const saved={location:globalThis.location,document:globalThis.document,HTMLInputElement:globalThis.HTMLInputElement,HTMLTextAreaElement:globalThis.HTMLTextAreaElement,Event:globalThis.Event,getComputedStyle:globalThis.getComputedStyle,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
 try{globalThis.location={origin:'https://example.com',href:'https://example.com/'};globalThis.document={activeElement:null,title:'',querySelector:()=>field,querySelectorAll:()=>[field],getElementById:()=>null};globalThis.HTMLInputElement=Input;globalThis.HTMLTextAreaElement=class{};globalThis.Event=class{};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});globalThis.innerWidth=800;globalThis.innerHeight=600;field.parentElement=null;field.getBoundingClientRect=()=>({left:0,top:0,right:100,bottom:20,width:100,height:20});
  assert.throws(()=>pageAction('fill','#x','secret',null,['https://example.com']),/sensitive/);assert.throws(()=>pageAction('press','#x',null,'Enter',['https://example.com']),/sensitive/);field._value='already-present';assert.equal(inspectPage(['https://example.com']).hasSensitiveValue,true);
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('old child lineage cannot claim a grandchild during a later ambiguous scope',async()=>{
 const {Executor}=await load(),f=workspaceFixture(),e=new Executor(f.api);
 await e.approve(task());e.setMode({...task(),modeGeneration:2,activeMode:'full'});
 let resume,entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 f.api.debugger={attach:async()=>{},detach:async()=>{},sendCommand:async(_,method)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Runtime.callFunctionOn'){entered();await gate;return {result:{value:{ok:true}}};}
 }};
 const first=e.withSpawnScope(e.tasks.get('a'),1,async()=>{entered();await gate;});await start;
 f.tabs.set(11,{id:11,url:'https://example.com/child',openerTabId:1,windowId:7,groupId:-1});await e.tabCreated({...f.tabs.get(11)});
 resume();await first;
 let resumeSecond,enteredSecond;const secondStart=new Promise(r=>enteredSecond=r),secondGate=new Promise(r=>resumeSecond=r);
 f.api.debugger.sendCommand=async(_,method)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Runtime.callFunctionOn'){enteredSecond();await secondGate;return {result:{value:{ok:true}}};}
 };
 const second=e.withSpawnScope(e.tasks.get('a'),1,async()=>{enteredSecond();await secondGate;});await secondStart;
 f.tabs.set(12,{id:12,url:'https://example.com/personal',openerTabId:11,windowId:7,groupId:-1});
 assert.equal(await e.tabCreated({...f.tabs.get(12)}),null);
 resumeSecond();await second;await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.ok(f.tabs.has(12));
});

test('navigate waits for completed redirect event and reports final URL/readiness without replay',async()=>{
 const {Executor}=await load();const f=workspaceFixture(),listeners=new Set();
 f.api.tabs.onUpdated={addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)};
 f.api.tabs.update=async(id,{url})=>{f.tabs.get(id).url=url;f.tabs.get(id).status='loading';return {...f.tabs.get(id)};};
 const e=new Executor(f.api);await e.approve(task());e.setMode({...task(),modeGeneration:2,activeMode:'full'});
 const result=e.execute({taskId:'a',generation:1,tabId:1,action:'navigate',url:'https://example.com/start',allowedOrigins:['https://example.com'],modeGeneration:2});
 await new Promise(r=>setImmediate(r));f.tabs.get(1).url='https://example.com/final';f.tabs.get(1).status='complete';
 for(const listener of listeners)listener(1,{status:'complete'}, {...f.tabs.get(1)});
 assert.deepEqual(await result,{tabId:1,url:'https://example.com/final',ready:'complete'});
 assert.equal(listeners.size,0);
});

test('new_tab returns a leased not-ready tab when only its pending URL is visible after grouping',async()=>{
 const {Executor}=await load();const f=workspaceFixture();let reads=0;
 const get=f.api.tabs.get;
 f.api.tabs.get=async id=>{
  const tab=await get(id);
  if(id!==1&&id!==9&&++reads>=4){
   tab.url='';
   tab.pendingUrl='https://example.com/';tab.status='loading';
  } else if(id!==1&&id!==9)tab.status='loading';
  return tab;
 };
 // The completion event may race a tabs.get that still shows pendingUrl only.
 f.api.tabs.onUpdated={addListener:fn=>queueMicrotask(()=>fn(3,{status:'complete'})),removeListener:()=>{}};
 const e=new Executor(f.api);await e.approve(task('a',[]));
 e.setMode({...task('a',[]),modeGeneration:2,activeMode:'full'});
 const result=await e.execute({...newTabCommand(),modeGeneration:2});
 assert.deepEqual(result,{tabId:3,url:'https://example.com/',ready:'loading',groupId:20,windowId:7,closedTabs:[]});
 assert.equal(f.creates.length,1);assert.equal(e.leases.get(3),'a');
});

test('pending URL does not authorize a read while the current URL is unavailable',async()=>{
 const {Executor}=await load();const f=workspaceFixture();let debuggerCalls=0;
 const get=f.api.tabs.get;
 f.api.tabs.get=async id=>id===1?get(id):{...await get(id),url:'',pendingUrl:'https://example.com/',status:'loading'};
 f.api.debugger={attach:async()=>{debuggerCalls++;},sendCommand:async()=>{debuggerCalls++;}};
 const e=new Executor(f.api);await e.approve(task('a',[]));e.setMode({...task('a',[]),modeGeneration:2,activeMode:'full'});
 const result=await e.execute({...newTabCommand(),modeGeneration:2});
 assert.equal(result.ready,'loading');assert.equal(e.leases.get(result.tabId),'a');
 await assert.rejects(e.execute({taskId:'a',generation:1,tabId:result.tabId,action:'snapshot',allowedOrigins:['https://example.com'],modeGeneration:2}),error=>{
  assert.equal(error.message,'TAB_OUT_OF_SCOPE');assert.equal(error.preDispatch,true);
  assert.equal(error instanceof TypeError,false);assert.equal(error.currentOrigin,undefined);return true;
 });
 assert.equal(debuggerCalls,0);
});

test('read readiness refuses missing, malformed and redirected committed URLs before reads, including polling',async()=>{
 const {Executor}=await load();
 const invalidUrls=[undefined,'','not-a-url','https://evil.test/private?secret=fixture'];
 for(const status of ['loading','complete'])for(const url of invalidUrls){
  let calls=0;const e=new Executor({tabs:{get:async()=>({url,status,pendingUrl:'https://example.com/'})},debugger:{attach:async()=>{calls++;},sendCommand:async()=>{calls++;}}});
  await assert.rejects(e.domReadyTab(task(),{tabId:1},()=>{}),error=>{
   assert.equal(error.message,'TAB_OUT_OF_SCOPE');assert.equal(error.preDispatch,true);
   assert.equal(error.currentOrigin,url?.startsWith('https:')?'https://evil.test':undefined);return true;
  });
  assert.equal(calls,0,'invalid committed URL cannot attach or read through pendingUrl');
 }
 for(const url of invalidUrls){
  let gets=0,commands=0;const e=new Executor({tabs:{get:async()=>({url:++gets===1?'https://example.com/':url,status:'loading',pendingUrl:'https://example.com/'})},debugger:{attach:async()=>{},sendCommand:async(_,method)=>{
   commands++;
   if(method==='Page.getFrameTree')return safeTree(1);
   if(method==='Page.createIsolatedWorld')return {executionContextId:1};
   assert.equal(method,'Runtime.callFunctionOn');return fixtureResult('loading');
  }}});
  await assert.rejects(e.domReadyTab(task(),{tabId:1},()=>{}),error=>{
   assert.equal(error.message,'TAB_OUT_OF_SCOPE');assert.equal(error.preDispatch,true);
   assert.equal(error.currentOrigin,url?.startsWith('https:')?'https://evil.test':undefined);return true;
  });
  assert.equal(gets,2);assert.equal(commands,3,'scope loss must stop before another readyState probe');
 }
});

test('pending allowed URL cannot override a wrong current origin or claim its lease',async()=>{
 const {Executor}=await load();const f=workspaceFixture(),get=f.api.tabs.get;
 f.api.tabs.get=async id=>id===1?get(id):{...await get(id),url:'https://evil.test/',pendingUrl:'https://example.com/',status:'loading'};
 const e=new Executor(f.api);await e.approve(task('a',[]));e.setMode({...task('a',[]),modeGeneration:2,activeMode:'full'});
 await assert.rejects(e.execute({...newTabCommand(),modeGeneration:2}),{message:'REDIRECTED_OUT_OF_SCOPE',code:'REDIRECTED_OUT_OF_SCOPE',preDispatch:true,finalOrigin:'https://evil.test'});
 assert.equal(f.creates.length,1);assert.equal(e.leases.has(3),false);
 assert.deepEqual(e.tasks.get('a').allowedOrigins,['https://example.com']);
});

test('a complete tab with no committed URL cannot claim readiness from pendingUrl',async()=>{
 const {Executor}=await load();const f=workspaceFixture(),get=f.api.tabs.get;
 f.api.tabs.get=async id=>id===1?get(id):{...await get(id),url:'',pendingUrl:'https://example.com/',status:'complete'};
 const e=new Executor(f.api);await e.approve(task('a',[]));e.setMode({...task('a',[]),modeGeneration:2,activeMode:'full'});
 await assert.rejects(e.execute({...newTabCommand(),modeGeneration:2}),error=>{
  assert.equal(error.message,'PAGE_NOT_READY');assert.equal(error.preDispatch,false);
  assert.equal(error instanceof TypeError,false);return true;
 });
 assert.equal(f.creates.length,1);
 assert.deepEqual(e.tasks.get('a').allowedOrigins,['https://example.com']);
 // 中文注释：建页日志已完成但就绪未知；重复请求命中原页租约，不能再创建一次。
 await assert.rejects(e.execute({...newTabCommand(),modeGeneration:2}),{message:'TASK_BUSY',code:'TASK_BUSY',preDispatch:false});
 assert.equal(f.creates.length,1);
 assert.equal(e.leases.get(3),'a');
 await assert.rejects(e.execute({taskId:'a',generation:1,tabId:3,action:'snapshot',allowedOrigins:['https://example.com'],modeGeneration:2}),{message:'TAB_OUT_OF_SCOPE',preDispatch:true});
});

test('structured release reports preserved, moved, and uncertain children without leasing denied origins',async()=>{
 const {Executor}=await load(),f=workspaceFixture(),e=new Executor(f.api);
 await e.approve(task());e.setMode({...task(),modeGeneration:2,activeMode:'full'});
 const command=newTabCommand();
 const owned=await e.execute({...command,modeGeneration:2});
 f.tabs.set(14,{id:14,url:'https://evil.test/',openerTabId:1,windowId:7,groupId:-1});
 let resume,entered;const gate=new Promise(r=>resume=r),start=new Promise(r=>entered=r);
 const world=f.api.debugger;
 f.api.debugger={...world,attach:async()=>{},sendCommand:async(_,method)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Runtime.callFunctionOn'){entered();await gate;return {result:{value:{ok:true}}};}
 }};
 const click=e.withSpawnScope(e.tasks.get('a'),1,async()=>{entered();await gate;});
 await start;await e.tabCreated({...f.tabs.get(14)});resume();await click;
 assert.equal(e.leases.has(14),false);assert.equal(e.tasks.get('a').allowedOrigins.includes('https://evil.test'),false);
 f.tabs.get(owned.tabId).groupId=-1;
 const result=await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.deepEqual(result.remainingTabIds,[]);assert.ok(result.preservedTabIds.includes(owned.tabId));assert.ok(!f.removed.includes(14));
 assert.ok(f.tabs.has(14),'concurrent personal child must survive');assert.equal(f.tabs.get(14).groupId,-1);
 assert.equal(result.cleanupState,'unknown');assert.ok(result.unknownTabIds.includes(14));
 assert.ok(f.tabs.has(owned.tabId));
});

test('cleanup inspection is read-only, scoped, and never upgrades unknown ownership',async()=>{
 const {Executor}=await load(),f=workspaceFixture(),e=new Executor(f.api);
 await e.approve(task());
 const empty=await e.cleanupStatus({taskId:'a',generation:1});
 assert.equal(empty.cleanupState,'succeeded');assert.equal(empty.cleanupReason,'verified_complete');
 assert.deepEqual(empty.remainingTabIds,[]);assert.deepEqual(empty.preservedTabIds,[]);assert.deepEqual(empty.unknownTabIds,[]);
 for(const request of [{taskId:'absent',generation:1},{taskId:'a',generation:2}]){
  const unknown=await e.cleanupStatus(request);assert.equal(unknown.cleanupState,'unknown');assert.equal(unknown.cleanupReason,'no_journal');
 }
 // 中文注释：成功仅来自可信空日志；歧义创建仍须未知，检查不能授予删除权或改写日志。
 const work=await executeUserApproved(e,newTabCommand());
 await e.workspaces.spawned(e.tasks.get('a').workspaceCapability,{id:14,openerTabId:1,windowId:7});
 const before=structuredClone(f.data),groups=structuredClone(f.groups);
 const unknown=await e.cleanupStatus({taskId:'a',generation:1});
 assert.equal(unknown.cleanupState,'unknown');assert.equal(unknown.cleanupReason,'ownership_unknown');
 assert.deepEqual(unknown.unknownTabIds,[14]);assert.deepEqual(unknown.remainingTabIds,[work.tabId]);
 assert.deepEqual(f.data,before);assert.deepEqual(f.groups,groups);assert.deepEqual(f.removed,[]);assert.equal(e.leases.has(14),false);
});

test('cleanup retry rejects changed inventory instead of ignoring daemon proof tabIds',async()=>{
 const {Executor}=await load(),e=new Executor({});let removals=0;
 e.tasks.set('a',{id:'a',generation:1,revoked:true,workspaceCapability:{}});
 e.workspaces={ready:Promise.resolve(),cleanupStatus:async()=>({cleanupState:'pending',remainingTabIds:[7,8],preservedTabIds:[],unknownTabIds:[]}),cleanup:async()=>{removals++;return {};}};
 await assert.rejects(e.cleanupRetry({taskId:'a',generation:1,tabIds:[7]}),/inventory changed/);
 assert.equal(removals,0);
 await e.cleanupRetry({taskId:'a',generation:1,tabIds:[7,8]});
 assert.equal(removals,1);
});

test('new-tab lease conflict never closes a tab already owned by another task',async()=>{
 const {Executor}=await load();const {api,tabs,removed,groups}=workspaceFixture();const e=new Executor(api);
 await e.approve(task('a',[]));await e.approve(task('b',[1]));
 let creates=0;api.tabs.create=async()=>{creates++;return {...tabs.get(1)};};
 // 中文注释：明确租约冲突为 TASK_BUSY；重放同一未知创建请求仍被日志阻止，不能再建或误删别人的页。
 await assert.rejects(executeUserApproved(e,newTabCommand()),{message:'TASK_BUSY',code:'TASK_BUSY',preDispatch:false});
 await assert.rejects(executeUserApproved(e,newTabCommand()),{code:'workspace_unknown'});
 assert.equal(creates,1);assert.equal(groups.length,0);assert.deepEqual(removed,[]);
 assert.equal(tabs.get(1).groupId,-1);assert.equal(e.leases.get(1),'b');
 await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.deepEqual(removed,[]);assert.equal(e.leases.get(1),'b');
});
