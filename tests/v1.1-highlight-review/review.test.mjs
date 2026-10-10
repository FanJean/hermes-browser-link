import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor} from '../../native-extension/core.mjs';

const origin='https://review.example.test';
const task={id:'highlight-review',generation:4,instanceId:'review-instance',approvalScope:'review-owner',
 modeGeneration:1,allowedOrigins:[origin],tabIds:[7]};
const request=(action,extra={})=>({taskId:task.id,generation:task.generation,modeGeneration:2,tabId:7,action,allowedOrigins:task.allowedOrigins,...extra});

function fixture({debuggerEvents=true,pauseAnimationFrames=false,stallPaintProbe=false,captureFailure=false,restoreFailure=false}={}){
 const dom=new JSDOM('<!doctype html><button id="target">Run</button>',
  {url:`${origin}/`,runScripts:'outside-only',pretendToBeVisual:true});
 const {window}=dom,document=window.document,events=[],calls=[],listeners=new Set();
 const getComputedStyle=window.getComputedStyle.bind(window);
 const target=document.querySelector('#target');
 // 中文注释：测试按钮显示点击状态，为效果观察提供真实 DOM 变化。
 target.onclick=e=>e.currentTarget.setAttribute('aria-pressed',String(Date.now()));
 Object.defineProperty(window,'innerWidth',{configurable:true,value:100});
 Object.defineProperty(window,'innerHeight',{configurable:true,value:100});
 window.visualViewport=Object.assign(new window.EventTarget(),{scale:1,offsetLeft:0,offsetTop:0});
 let uuid=0;
 Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>`review-${++uuid}`});
 if(pauseAnimationFrames){
  Object.defineProperty(window,'requestAnimationFrame',{configurable:true,value:()=>1});
  Object.defineProperty(window,'cancelAnimationFrame',{configurable:true,value:()=>{}});
 }
 Object.defineProperty(target,'getBoundingClientRect',{configurable:true,value:()=>({x:10,y:12,left:10,top:12,right:50,bottom:32,width:40,height:20})});
 Object.defineProperty(target,'getClientRects',{configurable:true,value:()=>[{x:10,y:12,left:10,top:12,right:50,bottom:32,width:40,height:20}]});
 document.elementFromPoint=()=>target;
 document.elementsFromPoint=()=>[target];
 target.addEventListener('click',()=>events.push('click'));
 let preparedResolve;
 const prepared=new Promise(resolve=>{preparedResolve=resolve;});
 let paintProbeResolve,paintProbeStartedResolve;
 const paintProbeStarted=new Promise(resolve=>{paintProbeStartedResolve=resolve;});
 const api={
  // 中文注释：写操作会先激活本任务标签页，合成浏览器也须实现该接口。
  tabs:{query:async()=>[await api.tabs.get(7)],get:async id=>({id,url:`${origin}/`,windowId:5,groupId:2,status:'complete'}),update:async()=>({active:true})},
  debugger:{
   ...(debuggerEvents?{onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}:{}),
   onDetach:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
   getTargets:async()=>[{type:'page',targetId:'review-target',tabId:7,url:`${origin}/`}],
   attach:async()=>{},detach:async()=>{},
   sendCommand:async(_target,method,params={})=>{
    calls.push({method,params});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:`${origin}/`,loaderId:'review-document'}}};
    if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
    if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
    if(method==='Page.createIsolatedWorld')return {executionContextId:17};
    if(method==='Runtime.addBinding'){window.hermesOverlayCommand=()=>{};return {};}
    if(method==='Runtime.callFunctionOn'){
     const args=(params.arguments||[]).map(item=>item.value);
     if(stallPaintProbe&&params.functionDeclaration.startsWith('function interactionHighlightCommand(')&&args[0]==='painted'){
      paintProbeStartedResolve();
      return new Promise(resolve=>{paintProbeResolve=resolve;});
     }
     const fn=window.eval(`(${params.functionDeclaration})`);
     const value=fn(...args);
     if(restoreFailure&&params.functionDeclaration.startsWith('function(op,scope){const state=')&&args[0]==='hide'){
      const host=document.querySelector('[data-hermes-automation-overlay]');
      window.getComputedStyle=element=>element===host?{display:'none'}:getComputedStyle(element);
     }
     if(params.functionDeclaration.startsWith('function interactionHighlightCommand(')&&args[0]==='prepare-selector')preparedResolve();
     return {result:{value}};
    }
    if(method==='Page.captureScreenshot'){
     if(captureFailure)throw Error('review capture failure');
     return {data:'synthetic-png'};
    }
    if(method==='Input.dispatchMouseEvent'||method==='Input.dispatchKeyEvent')events.push(method);
    return {};
   },
  },
 };
 const executor=new Executor(api);
 return {dom,document,events,calls,listeners,executor,prepared,paintProbeStarted,
  resolvePaintProbe:()=>paintProbeResolve?.({result:{value:{ok:false}}})};
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

test('without debugger.onEvent, an ordinary full-mode click is rejected before page effects',async()=>{
 const f=fixture({debuggerEvents:false});await authorizeFull(f.executor);
 try{
  await assert.rejects(f.executor.execute(request('click',{selector:'#target'})),/INTERACTION_HIGHLIGHT_UNAVAILABLE/);
  assert.deepEqual(f.events,[],'no click may dispatch without the required visual interaction surface');
 }finally{f.dom.window.close();}
});

test('a suspended background requestAnimationFrame reaches the finite highlight deadline, then clicks only after hit confirmation',async()=>{
 const f=fixture({pauseAnimationFrames:true});await authorizeFull(f.executor);
 const start=Date.now();
 try{
  const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
  const outcome=await within(action,3500);
  assert.equal(outcome.timedOut,undefined,'background paint wait must have a bounded deadline');
  // 中文注释：1.3.3 起高亮只作显示；后台工作页不重绘时，命中确认通过后仍点击一次。
  assert.equal(outcome.error,undefined,outcome.error?.message);
  assert.equal(outcome.value?.clicked,true);
  assert.ok(Date.now()-start<3500,'paint deadline must not exceed its bounded allowance');
  assert.deepEqual(f.events,['click'],'the confirmed target receives exactly one click');
  assert.ok(f.calls.some(call=>call.method==='Runtime.callFunctionOn'&&call.params.functionDeclaration.startsWith('function interactionHighlightCommand(')&&['clear','complete'].includes(call.params.arguments?.[0]?.value)),
   'the highlight operation must be completed or cleared after the click');
 }finally{f.dom.window.close();}
});

test('task release during a pending paint wait cancels and clears before any click',async()=>{
 const f=fixture({pauseAnimationFrames:true});await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 try{
  assert.equal((await within(f.prepared.then(()=>true),1000)).timedOut,undefined,'the production click path must reach highlight preparation');
  const started=Date.now();
  const released=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  const outcome=await within(action,1000);
  assert.equal(outcome.timedOut,undefined,'release must fence the paint wait without waiting for background rAF');
  assert.ok(outcome.error,'the click must reject after task release');
  assert.match(outcome.error.message,/stale generation|revoked/i);
  const releaseResult=await within(released,1500);
  assert.equal(releaseResult.timedOut,undefined,'release should finish after the in-flight action clears');
  assert.equal(releaseResult.released,true);
  assert.ok(Date.now()-started<1500,'cancellation should not wait for the paint deadline');
  assert.deepEqual(f.events,[],'cancelled work must not dispatch a click');
  assert.ok(f.calls.some(call=>call.method==='Runtime.callFunctionOn'&&call.params.functionDeclaration.startsWith('function interactionHighlightCommand(')&&call.params.arguments?.[0]?.value==='clear'),
   'cancellation must clear the scoped pending highlight');
 }finally{
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false}).catch(()=>{});
  f.dom.window.close();
 }
});

test('截图恢复失败保留拦截，显式停止后才清理遮罩',async()=>{
 const f=fixture({restoreFailure:true});await f.executor.approve(task);
 let error;
 try{await f.executor.execute(request('screenshot',{modeGeneration:1}));}catch(cause){error=cause;}
 try{
  assert.match(error?.message||'',/overlay restore failed/);
  assert.ok(f.calls.some(call=>call.method==='Page.captureScreenshot'),'capture succeeds before restoration is rejected');
  // 中文注释：失败关闭要求保留输入拦截；资源由明确停止统一释放。
  assert.equal(f.document.querySelector('[data-hermes-automation-overlay]')?.style.pointerEvents,'auto');
  assert.equal(f.executor.tasks.get(task.id).overlays?.has(7),true);
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal(f.document.querySelector('[data-hermes-automation-overlay]'),null);assert.equal(f.listeners.size,0);
 }finally{f.dom.window.close();}
});

test('截图与恢复同时失败保留两个原因并保持拦截至停止',async()=>{
 const f=fixture({captureFailure:true,restoreFailure:true});await f.executor.approve(task);
 try{
  await assert.rejects(f.executor.execute(request('screenshot',{modeGeneration:1})),error=>{
   assert.ok(error instanceof AggregateError);
   assert.equal(error.message,'capture and overlay restoration failed');
   assert.deepEqual(error.errors.map(cause=>cause.message),['review capture failure','overlay restore failed']);
   return true;
  });
  assert.equal(f.document.querySelector('[data-hermes-automation-overlay]')?.style.pointerEvents,'auto');
  assert.equal(f.executor.tasks.get(task.id).overlays?.has(7),true);
  await f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal(f.document.querySelector('[data-hermes-automation-overlay]'),null);assert.equal(f.listeners.size,0);
 }finally{f.dom.window.close();}
});

test('minimal repro: a non-settling CDP paint probe prevents task release from completing',async()=>{
 const f=fixture({stallPaintProbe:true});await authorizeFull(f.executor);
 const action=f.executor.execute(request('click',{selector:'#target'})).then(value=>({value}),error=>({error}));
 let releasePromise;
 try{
  assert.equal((await within(f.paintProbeStarted.then(()=>true),1000)).timedOut,undefined,
   'the action must enter its production painted-token CDP probe');
  releasePromise=f.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
  const releaseWhileProbePending=await within(releasePromise,200);
  // Deliberately assert the desired bounded-cancellation contract. Current
  // production remains blocked on the in-flight debugger promise, so this is
  // the retained minimal regression reproduction, not a fixture failure.
  assert.equal(releaseWhileProbePending.timedOut,undefined,
   'release must not wait indefinitely for an unresponsive CDP paint probe');
 }finally{
  f.resolvePaintProbe();
  await within(action,1000);
  if(releasePromise)await within(releasePromise,1500);
  f.dom.window.close();
 }
});
