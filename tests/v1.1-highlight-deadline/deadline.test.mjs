import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor} from '../../native-extension/core.mjs';

const origin='https://deadline.example.test';
const task={id:'highlight-deadline',generation:5,instanceId:'deadline-instance',approvalScope:'deadline-owner',
 modeGeneration:1,allowedOrigins:[origin],tabIds:[7]};
const request=(action,extra={})=>({taskId:task.id,generation:task.generation,modeGeneration:2,tabId:7,action,allowedOrigins:task.allowedOrigins,...extra});

function fixture({hangOverlayRemove=false,releaseDeadlineMs,beforeLeaseRelease}={}) {
 const dom=new JSDOM('<!doctype html><button id="target">Run</button>',
  {url:`${origin}/`,runScripts:'outside-only',pretendToBeVisual:true});
 const {window}=dom,document=window.document,events=[],calls=[],listeners=new Set();
 Object.defineProperty(window,'innerWidth',{configurable:true,value:100});
 Object.defineProperty(window,'innerHeight',{configurable:true,value:100});
 window.visualViewport=Object.assign(new window.EventTarget(),{scale:1,offsetLeft:0,offsetTop:0});
 let uuid=0,detachCalls=0;
 Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>`deadline-${++uuid}`});
 const target=document.querySelector('#target');
 Object.defineProperty(target,'getBoundingClientRect',{configurable:true,value:()=>({x:10,y:12,left:10,top:12,right:50,bottom:32,width:40,height:20})});
 Object.defineProperty(target,'getClientRects',{configurable:true,value:()=>[{x:10,y:12,left:10,top:12,right:50,bottom:32,width:40,height:20}]});
 document.elementFromPoint=()=>target;
 document.elementsFromPoint=()=>[target];
 target.addEventListener('click',()=>events.push('click'));
 let paintResolve,paintReject,paintStartedResolve,removeResolve,removeStartedResolve;
 const paintStarted=new Promise(resolve=>{paintStartedResolve=resolve;});
 const removeStarted=new Promise(resolve=>{removeStartedResolve=resolve;});
 const api={
  // 中文注释：高亮期限测试需要覆盖派发前激活工作页的调用。
  tabs:{get:async id=>({id,url:`${origin}/`,windowId:5,groupId:2,status:'complete'}),update:async()=>({active:true})},
  debugger:{
   onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
   onDetach:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
   getTargets:async()=>[{type:'page',targetId:'deadline-target',tabId:7,url:`${origin}/`}],
   attach:async()=>{},detach:async()=>{detachCalls++;},
   sendCommand:async(_target,method,params={})=>{
    calls.push({method,params});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:`${origin}/`,loaderId:'deadline-document'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:17};
    if(method==='Runtime.addBinding'){window.hermesOverlayCommand=()=>{};return {};}
    if(method==='Runtime.callFunctionOn'){
     const args=(params.arguments||[]).map(item=>item.value);
     if(hangOverlayRemove&&params.functionDeclaration.startsWith('function(op,scope)')&&args[0]==='remove'){
      removeStartedResolve();
      return new Promise(resolve=>{removeResolve=resolve;});
     }
     if(params.functionDeclaration.startsWith('function interactionHighlightCommand(')&&args[0]==='painted'){
      paintStartedResolve();
      return new Promise((resolve,reject)=>{paintResolve=resolve;paintReject=reject;});
     }
     const fn=window.eval(`(${params.functionDeclaration})`);
     return {result:{value:fn(...args)}};
    }
    if(method==='Input.dispatchMouseEvent'||method==='Input.dispatchKeyEvent')events.push(method);
    return {};
   },
  },
 };
 const executor=new Executor(api,()=>{},{releaseDeadlineMs,beforeLeaseRelease});
 return {dom,document,events,calls,listeners,executor,paintStarted,removeStarted,
  get detachCalls(){return detachCalls;},
  resolvePaint:value=>paintResolve?.({result:{value}}),rejectPaint:error=>paintReject?.(error),
  resolveRemove:value=>removeResolve?.({result:{value}})};
}

async function authorizeFull(executor){
 await executor.approve(task);
 executor.setMode({...task,activeMode:'full',modeGeneration:2});
}

function within(promise,ms){
 let timer;
 return Promise.race([
  promise,
  new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),ms);}),
 ]).finally(()=>clearTimeout(timer));
}

function paintedCalls(f){
 return f.calls.filter(call=>call.method==='Runtime.callFunctionOn'
  &&call.params.functionDeclaration.startsWith('function interactionHighlightCommand(')
  &&call.params.arguments?.[0]?.value==='painted');
}

function overlayOps(f){
 return f.calls.filter(call=>call.method==='Runtime.callFunctionOn'
  &&call.params.functionDeclaration.startsWith('function(op,scope)'))
  .map(call=>call.params.arguments?.[0]?.value);
}

test('release returns while its painted CDP probe remains in flight and ignores late success',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 let releasePromise;
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined,'click must enter its painted probe');
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  const released=await within(releasePromise,250);
  assert.equal(released.timedOut,undefined,'release must be bounded by local probe cancellation, not CDP settlement');
  assert.equal(released.released,true);
  const result=await within(action,250);
  assert.equal(result.timedOut,undefined,'the cancelled action must leave its tab lock');
  assert.match(result.error?.message||'',/stale generation|revoked/i);
  const state=f.executor.tasks.get(task.id);
  assert.equal(state.interactionOperations.size,0,'cancellation removes its local operation and abort listener');
  assert.equal(state.pendingInteractionProbes.size,1,'the unresolved CDP request remains tracked without holding release');
  assert.equal(f.listeners.size,0,'release removes the page overlay listener');
  assert.equal(paintedCalls(f).length,1,'cancellation must not replay the probe');
  assert.deepEqual(f.events,[],'a released operation must not dispatch its click');
  f.resolvePaint({ok:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.events,[],'late success cannot dispatch after release');
  assert.equal(state.pendingInteractionProbes.size,0,'late settlement clears in-flight tracking');
  assert.equal(f.document.querySelector('[data-hermes-interaction-highlight]'),null,'late success cannot restore a removed highlight');
 }finally{
  f.resolvePaint({ok:true});
  if(releasePromise)await within(releasePromise,1500);
  await within(action,1500);
  f.dom.window.close();
 }
});

test('a never-settling visual probe does not block a separately confirmed click',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined,'click must enter its painted probe');
  const updatesBeforeTimeout=overlayOps(f).filter(op=>op==='update').length;
  const taskState=f.executor.tasks.get(task.id);
  const started=Date.now();
  const outcome=await within(action,2800);
  const elapsed=Date.now()-started;
  assert.equal(outcome.timedOut,undefined,'a single CDP probe must be covered by the frame deadline');
  assert.equal(outcome.value?.clicked,true);
  assert.ok(elapsed>=1700&&elapsed<2800,`the actual single-command deadline should be about two seconds (measured ${elapsed}ms)`);
  assert.equal(taskState.pendingInteractionProbes.size,1,'the unresolved CDP command remains explicitly tracked');
  const probe=[...taskState.pendingInteractionProbes][0];
  assert.equal(probe.kind,'painted');assert.equal(probe.abandoned,true);
  assert.equal(taskState.interactionOperations.size,0,'the completed operation must release its local state');
  assert.equal(paintedCalls(f).length,1,'an abandoned probe must not be replayed');
  assert.deepEqual(f.events,['click'],'the independently confirmed target receives one click');
  assert.ok(overlayOps(f).filter(op=>op==='update').length>updatesBeforeTimeout,'the dispatch window is reopened for the confirmed target');
  f.resolvePaint({ok:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.events,['click'],'late paint success cannot trigger another click');
  assert.equal(taskState.pendingInteractionProbes.size,0,'settled late probes are removed from in-flight state');
  assert.equal(probe.state,'settled_late');
 }finally{
  f.resolvePaint({ok:true});
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  f.dom.window.close();
 }
});

test('late painted-probe rejection stays isolated after cancellation',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined,'click must enter its painted probe');
  const state=f.executor.tasks.get(task.id);
  const probe=[...state.pendingInteractionProbes][0];
  const released=await within(f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false}),250);
  assert.equal(released.timedOut,undefined,'release must not await the CDP rejection');
  const result=await within(action,250);
  assert.equal(result.timedOut,undefined);
  assert.match(result.error?.message||'',/stale generation|revoked/i);
  f.rejectPaint(Error('late CDP failure'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.pendingInteractionProbes.size,0,'late rejection removes the abandoned command from in-flight state');
  assert.equal(probe.state,'settled_late');assert.equal(probe.outcome,'rejected');
  assert.equal(paintedCalls(f).length,1,'a rejected in-flight probe is not replayed');
  assert.deepEqual(f.events,[],'late rejection cannot trigger page interaction');
 }finally{
  f.rejectPaint(Error('late CDP failure'));
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false}).catch(()=>{});
  f.dom.window.close();
 }
});

test('permission revocation aborts the painted wait and fences late success',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined,'click must enter its painted probe');
  const updatesBeforeRevocation=overlayOps(f).filter(op=>op==='update').length;
  const state=f.executor.tasks.get(task.id);
  const probe=[...state.pendingInteractionProbes][0];
  f.executor.revokeMode(task.id);
  const outcome=await within(action,250);
  assert.equal(outcome.timedOut,undefined,'permission revocation must not wait for CDP settlement');
  assert.match(outcome.error?.message||'',/mode revoked/i);
  assert.equal(state.interactionOperations.size,0,'revocation removes the local operation and its abort listener');
  assert.equal(state.pendingInteractionProbes.size,1,'the unresolved probe remains separately tracked');
  assert.equal(overlayOps(f).filter(op=>op==='update').length,updatesBeforeRevocation,'revocation cannot write an unknown state after losing permission');
  f.resolvePaint({ok:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.events,[],'late success after permission loss cannot dispatch');
  assert.equal(state.pendingInteractionProbes.size,0);
  assert.equal(probe.state,'settled_late');
 }finally{
  f.resolvePaint({ok:true});
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  f.dom.window.close();
 }
});

test('never-settling highlight probes respect a hard per-task capacity without erasing in-flight records',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const state=f.executor.tasks.get(task.id),controller=new AbortController(),resolvers=[];
 const operation={binding:{operationToken:'capacity-probe'},controller,pendingProbes:new Set(),guard(){}};
 const call=()=>new Promise(resolve=>resolvers.push(resolve));
 const probes=Array.from({length:32},()=>f.executor.interactionProbe(state,operation,'painted',Date.now()+60_000,call));
 let overflow;
 try{
  await Promise.resolve();
  assert.equal(state.pendingInteractionProbes.size,32,'all unresolved CDP probes remain accounted');
  const extra=f.executor.interactionProbe(state,operation,'painted',Date.now()+60_000,call);
  overflow=await within(extra.then(value=>({value}),error=>({error})),50);
  assert.equal(overflow.timedOut,undefined,'capacity exhaustion must reject promptly');
  assert.match(overflow.error?.message||'',/INTERACTION_HIGHLIGHT_PROBE_CAPACITY/);
  assert.equal(resolvers.length,32,'capacity rejection must not dispatch another CDP command');
  assert.equal(state.pendingInteractionProbes.size,32,'rejection cannot falsely clear still-running CDP commands');
 }finally{
  controller.abort(Error('test cleanup'));
  await Promise.allSettled(probes);
  await new Promise(resolve=>setImmediate(resolve));
  for(const resolve of resolvers)resolve({ok:true});
  await new Promise(resolve=>setImmediate(resolve));
  f.dom.window.close();
 }
});

test('release bounds a stalled overlay cleanup and retains honest in-flight accounting',async()=>{
 const f=fixture({hangOverlayRemove:true});await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 let releasePromise;
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined,'click must enter its painted probe');
  const state=f.executor.tasks.get(task.id);
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal((await within(f.removeStarted.then(()=>true),1000)).timedOut,undefined,'release must attempt overlay removal');
  const released=await within(releasePromise,800);
  assert.equal(released.timedOut,undefined,'release must bound local cleanup waiting');
  assert.equal(released.cleanupState,'unknown','a cleanup timeout must not be reported as complete');
  const actionResult=await within(action,250);
  assert.equal(actionResult.timedOut,undefined,'release must let the cancelled action leave its tab lock');
  assert.match(actionResult.error?.message||'',/stale generation|revoked/i);
  assert.equal(state.pendingInteractionCleanups.size,1,'the unresolved removal remains tracked after release');
  const cleanup=[...state.pendingInteractionCleanups][0];
  assert.equal(cleanup.kind,'overlay-remove');
  assert.equal(cleanup.abandoned,true,'only the local wait is abandoned');
  assert.equal(cleanup.settled,false,'the CDP request is still in flight');
  assert.deepEqual(f.events,[],'cleanup timeout cannot restore or dispatch the fenced action');
  f.resolveRemove(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.pendingInteractionCleanups.size,0,'late settlement releases its bounded record');
  assert.equal(cleanup.state,'settled_late');
  assert.deepEqual(f.events,[],'late cleanup settlement cannot resume the action');
 }finally{
  f.resolvePaint({ok:true});f.resolveRemove(true);
  if(releasePromise)await within(releasePromise,1500);
  await within(action,1500);
  f.dom.window.close();
 }
});

test('highlight probe capacity is shared across task generations and task IDs',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const oldState=f.executor.tasks.get(task.id),resolverBatches=[];
 const makeBatch=(state,token,count)=>{
  const controller=new AbortController(),resolvers=[];
  const operation={binding:{operationToken:token},tabId:7,controller,pendingProbes:new Set(),guard(){}};
  const promises=Array.from({length:count},()=>f.executor.interactionProbe(state,operation,'painted',Date.now()+60_000,()=>new Promise(resolve=>resolvers.push(resolve))));
  resolverBatches.push(resolvers);return {controller,promises};
 };
 let batch1,batch2,batch3,extraPromise;
 try{
  batch1=makeBatch(oldState,'generation-5',16);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oldState.pendingInteractionProbes.size,16);
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  const nextTask={...task,generation:task.generation+1};
  await f.executor.approve(nextTask);
  const nextState=f.executor.tasks.get(task.id);
  batch2=makeBatch(nextState,'generation-6',16);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.executor.pendingInteractionProbes.size,32,'global accounting survives task release and generation replacement');
  await f.executor.release({taskId:task.id,generation:nextTask.generation,closeAgentTabs:false});
  const newTask={...task,id:'new-task',generation:1,approvalScope:'new-task-owner'};
  await f.executor.approve(newTask);
  const newState=f.executor.tasks.get(newTask.id);
  batch3=makeBatch(newState,'new-task-probe',0);
  extraPromise=f.executor.interactionProbe(newState,{binding:{operationToken:'new-task-probe'},tabId:7,controller:batch3.controller,pendingProbes:new Set(),guard(){}},'painted',Date.now()+60_000,()=>new Promise(resolve=>resolverBatches[2].push(resolve)))
   .then(value=>({value}),error=>({error}));
  const overflow=await within(extraPromise,80);
  assert.equal(overflow.timedOut,undefined,'a new task ID cannot reset transport-wide probe usage');
  assert.match(overflow.error?.message||'',/INTERACTION_HIGHLIGHT_PROBE_CAPACITY/);
  assert.equal(resolverBatches.flat().length,32,'global overflow must not dispatch another CDP request');
  assert.equal(newState.pendingInteractionProbes.size,0,'rejected work is not retained as in flight');
 }finally{
  for(const batch of [batch1,batch2,batch3])batch?.controller.abort(Error('test cleanup'));
  await Promise.allSettled([...(batch1?.promises||[]),...(batch2?.promises||[]),...(batch3?.promises||[]),...(extraPromise?[extraPromise]:[])]);
  for(const resolvers of resolverBatches)for(const resolve of resolvers)resolve({ok:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.executor.pendingInteractionProbes.size,0,'only underlying settlement releases global capacity');
  f.dom.window.close();
 }
});

test('highlight cleanup capacity is shared across task generations and task IDs',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 const oldState=f.executor.tasks.get(task.id),resolverBatches=[];
 const makeBatch=(state,count)=>{
  const resolvers=[];
  const promises=Array.from({length:count},()=>f.executor.trackInteractionCleanup(state,'highlight-clear',()=>new Promise(resolve=>resolvers.push(resolve)),60_000));
  resolverBatches.push(resolvers);return promises;
 };
 let batch1,batch2,extraCleanup;
 try{
  batch1=makeBatch(oldState,16);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oldState.pendingInteractionCleanups.size,16);
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  const nextTask={...task,generation:task.generation+1};
  await f.executor.approve(nextTask);
  const nextState=f.executor.tasks.get(task.id);
  batch2=makeBatch(nextState,16);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.executor.pendingInteractionCleanups.size,32,'global accounting survives task release and generation replacement');
  await f.executor.release({taskId:task.id,generation:nextTask.generation,closeAgentTabs:false});
  const newTask={...task,id:'new-task',generation:1,approvalScope:'new-task-owner'};
  await f.executor.approve(newTask);
  const newState=f.executor.tasks.get(newTask.id);
  extraCleanup=f.executor.trackInteractionCleanup(newState,'highlight-clear',()=>new Promise(resolve=>resolverBatches[2].push(resolve)),60_000)
   .then(value=>({value}),error=>({error}));
  const overflow=await within(extraCleanup,80);
  assert.equal(overflow.timedOut,undefined,'a new task ID cannot reset transport-wide cleanup usage');
  assert.equal(overflow.value?.capacityExceeded,true);
  assert.equal(resolverBatches.flat().length,32,'global overflow must not dispatch another cleanup command');
  assert.equal(newState.pendingInteractionCleanups.size,0,'rejected cleanup is not retained as in flight');
 }finally{
  for(const resolvers of resolverBatches)for(const resolve of resolvers)resolve({ok:true});
  await Promise.allSettled([...(batch1||[]),...(batch2||[]),...(extraCleanup?[extraCleanup]:[])]);
  assert.equal(f.executor.pendingInteractionCleanups.size,0,'only underlying settlement releases global capacity');
  f.dom.window.close();
 }
});

test('expired tab-lock release never dispatches delayed cleanup or detach',async()=>{
 const f=fixture({releaseDeadlineMs:80});await authorizeFull(f.executor);
 const state=f.executor.tasks.get(task.id);let resumeLock;
 const heldLock=new Promise(resolve=>{resumeLock=resolve;});
 let cleanupCalls=0;
 f.executor.closeTabResources=async()=>{cleanupCalls++;return {cleanupState:'succeeded'};};
 f.executor.attached.add(7);f.executor.tabQueues.set(7,heldLock);
 let releasePromise,queuedRelease;
 try{
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  await new Promise(resolve=>setImmediate(resolve));queuedRelease=f.executor.tabQueues.get(7);
  const released=await within(releasePromise,500);
  assert.equal(released.timedOut,undefined,'the absolute release deadline covers waiting for the tab lock');
  assert.equal(released.cleanupState,'unknown');
  resumeLock();await queuedRelease.catch(()=>{});
  assert.equal(cleanupCalls,0,'an expired queued release cannot send delayed cleanup');
  assert.equal(f.detachCalls,0,'an expired queued release cannot detach a new generation');
  assert.equal(f.executor.tasks.get(task.id),state);
  assert.equal(f.executor.leases.get(7),task.id,'an expired queued callback cannot silently release its uncertain tab lease');
  await assert.rejects(f.executor.approve({...task,id:'different-owner',generation:1}),/tab claimed/,
   'another task cannot claim the tab after the old queued release expired');
  assert.equal(f.executor.leases.get(7),task.id);
 }finally{
  resumeLock();
  if(releasePromise)await within(releasePromise,500);
  f.executor.attached.delete(7);f.dom.window.close();
 }
});

test('remaining release budget bounds a hanging resource cleanup before detach',async()=>{
 const f=fixture({hangOverlayRemove:true,releaseDeadlineMs:120,beforeLeaseRelease:()=>new Promise(resolve=>setTimeout(resolve,70))});
 await authorizeFull(f.executor);f.executor.attached.add(7);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 let releasePromise;
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined);
  const started=Date.now();
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal((await within(f.removeStarted.then(()=>true),300)).timedOut,undefined,'resource cleanup must start within the release budget');
  const result=await within(releasePromise,250);
  assert.equal(result.timedOut,undefined,'resource cleanup is included in the same absolute deadline');
  assert.equal(result.cleanupState,'unknown');
  assert.ok(Date.now()-started<220,'release cannot add the full resource timeout after waiting on its hook');
  assert.equal(f.detachCalls,0,'expired resource cleanup cannot be followed by debugger.detach');
 }finally{
  f.resolvePaint({ok:true});f.resolveRemove(true);
  if(releasePromise)await within(releasePromise,300);
  await within(action,300);f.dom.window.close();
 }
});

test('release deadline fences workspace removal that resumes after expiry',async()=>{
 const f=fixture({releaseDeadlineMs:80});await authorizeFull(f.executor);
 const state=f.executor.tasks.get(task.id);state.workspaceCapability={};
 let resumeCleanup,startedCleanup,finishCleanup;const cleanupGate=new Promise(resolve=>{resumeCleanup=resolve;});
 const cleanupStarted=new Promise(resolve=>{startedCleanup=resolve;});
 const cleanupFinished=new Promise(resolve=>{finishCleanup=resolve;});
 let canDelete,removalCalls=0;
 f.executor.workspaces={ready:Promise.resolve(),cleanup:async(_cap,options)=>{
  canDelete=options.canDelete;startedCleanup(true);
  // 中文注释：生产清理器只接受严格 true；defer 是保留后续清理机会的拒绝结果。
  try{await cleanupGate;if(canDelete(99)===true)removalCalls++;return {cleanupState:'succeeded'};}
  finally{finishCleanup();}
 },cleanupStatus:async()=>({cleanupState:'succeeded',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[],cleanupReason:'verified_complete'})};
 let releasePromise;
 try{
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:true});
  assert.equal((await within(cleanupStarted,100)).timedOut,undefined);
  const result=await within(releasePromise,250);
  assert.equal(result.timedOut,undefined,'release has one deadline across workspace cleanup');
  assert.equal(result.cleanupState,'unknown');
  assert.equal(typeof canDelete,'function','workspace deletion receives a deadline/scope guard');
  assert.equal(canDelete(99),'defer','过期后必须拒绝本次删除，不能把延期标记当作 true');
  resumeCleanup();await cleanupFinished;
  assert.equal(removalCalls,0,'a queued workspace removal cannot dispatch after release expiry');
  const status=await f.executor.cleanupStatus({taskId:task.id,generation:task.generation});
  assert.equal(status.cleanupState,'unknown','late workspace readback cannot erase the release uncertainty');
 }finally{
  resumeCleanup();if(releasePromise)await within(releasePromise,300);
  await cleanupFinished;f.dom.window.close();
 }
});

test('release deadline includes a never-settling debugger detach and holds the tab lease until settlement',async()=>{
 const f=fixture({releaseDeadlineMs:80});await authorizeFull(f.executor);
 f.executor.attached.add(7);
 let detachCalls=0,detachResolve,detachStartedResolve;const detachStarted=new Promise(resolve=>{detachStartedResolve=resolve;});
 f.executor.api.debugger.detach=()=>{detachCalls++;detachStartedResolve(true);return new Promise(resolve=>{detachResolve=resolve;});};
 let releasePromise,tabLock;
 try{
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal((await within(detachStarted,150)).timedOut,undefined,'release must reach debugger.detach');
  tabLock=f.executor.tabQueues.get(7);
  const released=await within(releasePromise,400);
  assert.equal(released.timedOut,undefined,'a never-settling detach cannot exceed the total release deadline');
  assert.equal(released.cleanupState,'unknown');
  assert.equal(f.executor.leases.get(7),task.id,'the leased tab remains quarantined while detach is unresolved');
  const otherTask={...task,id:'next-owner',generation:1};
  await assert.rejects(f.executor.approve(otherTask),/tab claimed/);
  detachResolve();await tabLock;
  assert.equal(f.executor.leases.has(7),false,'lease is released only after the dispatched detach settles');
  assert.equal(detachCalls,1,'the dispatched detach is not replayed');
  await f.executor.approve(otherTask);
 }finally{
  detachResolve?.();if(tabLock)await tabLock.catch(()=>{});
  if(releasePromise)await within(releasePromise,500);
  f.dom.window.close();
 }
});

test('unknown release cleanup remains unknown after later workspace readback says succeeded',async()=>{
 const f=fixture({hangOverlayRemove:true});await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 const state=f.executor.tasks.get(task.id);state.workspaceCapability={};
 f.executor.workspaces={ready:Promise.resolve(),cleanup:async()=>({cleanupState:'succeeded'}),cleanupStatus:async()=>({
  cleanupState:'succeeded',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[],remainingCount:0,preservedCount:0,unknownCount:0,cleanupReason:'verified_complete',
 })};
 let releasePromise;
 try{
  assert.equal((await within(f.paintStarted.then(()=>true),1000)).timedOut,undefined);
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal((await within(f.removeStarted.then(()=>true),1000)).timedOut,undefined);
  const released=await within(releasePromise,800);
  assert.equal(released.timedOut,undefined);
  assert.equal(released.cleanupState,'unknown');
  const readback=await f.executor.cleanupStatus({taskId:task.id,generation:task.generation});
  assert.equal(readback.cleanupState,'unknown','page absence alone cannot erase an earlier uncertain cleanup result');
  assert.match(readback.cleanupReason||'',/uncertain|unknown|deadline/i);
  assert.ok(readback.unknownTabIds.includes(7),'uncertainty remains scoped to the affected tab');
 }finally{
  f.resolvePaint({ok:true});f.resolveRemove(true);
  await within(action,500);if(releasePromise)await within(releasePromise,500);
  f.dom.window.close();
 }
});
