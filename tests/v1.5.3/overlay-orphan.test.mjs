// 中文注释：离线使用真实 DOM 和执行器；可信事件由测试夹具调用监听器，网页脚本事件仍走实际 DOM 派发。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createAutomationOverlay} from '../../native-extension/automation-overlay.mjs';
import {Executor,preveilSource} from '../../native-extension/core.mjs';
const scope={taskId:'task',generation:2,tabId:7,origin:'https://example.test'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(callback=()=>new Promise(()=>{}),timeout=15){
 const dom=new JSDOM('<input id="draft"><button id="page">页面</button>',{url:scope.origin}),doc=dom.window.document,handlers=new Map(),windowHandlers=new Map();let shadow;
 const attach=dom.window.Element.prototype.attachShadow,add=dom.window.Element.prototype.addEventListener;
 dom.window.Element.prototype.attachShadow=function(options){shadow=attach.call(this,options);return shadow;};
 dom.window.Element.prototype.addEventListener=function(type,fn,...rest){if(type==='click'&&this.tagName==='BUTTON')handlers.set(this,fn);return add.call(this,type,fn,...rest);};
 const winAdd=dom.window.addEventListener.bind(dom.window),winRemove=dom.window.removeEventListener.bind(dom.window);
 dom.window.addEventListener=(type,fn,...rest)=>{if(['blockKeys','recover','checkFrameFocus'].includes(fn.name))windowHandlers.set(type,fn);winAdd(type,fn,...rest);};
 dom.window.removeEventListener=(type,fn,...rest)=>{if(windowHandlers.get(type)===fn)windowHandlers.delete(type);winRemove(type,fn,...rest);};
 const overlay=createAutomationOverlay({document:doc,...scope,commandTimeoutMs:timeout,onStop:callback,onTakeover:callback,onResume:callback});
 const button=action=>shadow.querySelector(`[data-action="${action}"]`);
 const click=(action,trusted=true)=>handlers.get(button(action))({isTrusted:trusted});
 const key=()=>{let blocked=false;windowHandlers.get('keydown')?.({type:'keydown',isTrusted:true,composedPath:()=>[],preventDefault(){blocked=true;},stopImmediatePropagation(){}});return blocked;};
 return {dom,doc,shadow,overlay,button,click,key,windowHandlers,close(){overlay.remove();dom.window.close();}};
}

test('无回执在期限后显示断开和恢复按钮，保留任务未确认提示',async()=>{
 const f=fixture();try{
  const pending=f.click('takeover');assert.match(f.shadow.textContent,/等待当前步骤结束/);await pending;
  assert.match(f.shadow.textContent,/与扩展的连接已断开/);assert.match(f.shadow.textContent,/不代表任务已暂停/);
  for(const action of ['release','retry'])assert.equal(f.button(action).style.display,'inline-block');
  assert.equal(f.button('retry').disabled,false);assert.equal(f.key(),true);
 }finally{f.close();}
});
test('放开只移除本地浮层和捕获监听器，不再调用任务控制，迟到回执不能复活',async()=>{
 let calls=0,reply;const f=fixture(()=>{calls++;return new Promise(resolve=>{reply=resolve;});});try{
  await f.click('takeover');assert.equal(f.key(),true);f.click('release');await tick();
  assert.equal(f.overlay.host.isConnected,false);assert.equal(f.windowHandlers.size,0);assert.equal(f.key(),false);assert.equal(calls,1);
  reply({state:'paused'});await tick();assert.equal(f.doc.querySelector('[data-hermes-automation-overlay]'),null);assert.equal(calls,1);
 }finally{f.close();}
});
test('重试允许恢复连接，旧请求迟到不能覆盖新回执，超时清理信号已取消',async()=>{
 let calls=0,late,firstSignal;const f=fixture((_scope,{signal})=>{calls++;if(calls===1){firstSignal=signal;return new Promise(resolve=>{late=resolve;});}return Promise.resolve({state:'paused'});});try{
  await f.click('takeover');assert.equal(firstSignal.aborted,true);await f.click('retry');
  assert.equal(calls,2);assert.equal(f.overlay.host.style.pointerEvents,'none');assert.match(f.shadow.textContent,/已暂停/);
  late({state:'running'});await tick();assert.equal(f.overlay.host.style.pointerEvents,'none');
 }finally{f.close();}
});
test('扩展进度回执续期，长步骤期间不误报断开；进度停止后仍会超时',async()=>{
 let finish,timer;const f=fixture((_scope,{onProgress})=>{timer=setInterval(onProgress,5);return new Promise(resolve=>{finish=resolve;});});try{
  const pending=f.click('takeover');await new Promise(resolve=>setTimeout(resolve,45));assert.match(f.shadow.textContent,/等待当前步骤结束/);assert.doesNotMatch(f.shadow.textContent,/与扩展的连接已断开/);
  clearInterval(timer);await pending;assert.match(f.shadow.textContent,/与扩展的连接已断开/);finish({state:'paused'});await tick();assert.equal(f.overlay.host.style.pointerEvents,'auto');
 }finally{clearInterval(timer);f.close();}
});
test('快捷键走同一期限和恢复流程；脚本点击不能重试或放开',async()=>{
 let calls=0;const f=fixture(()=>{calls++;return new Promise(()=>{});});try{
  f.windowHandlers.get('keydown')({type:'keydown',key:'F12',ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,isTrusted:true,preventDefault(){},stopImmediatePropagation(){}});
  await new Promise(resolve=>setTimeout(resolve,30));assert.match(f.shadow.textContent,/与扩展的连接已断开/);assert.equal(calls,1);
  f.button('retry').click();f.button('release').click();await tick();assert.equal(calls,1);assert.equal(f.overlay.host.isConnected,true);
  f.click('release');assert.equal(f.windowHandlers.size,0);
 }finally{f.close();}
});
test('明确断开和异常均可恢复；未知结果不伪造暂停或停止',async()=>{
 for(const callback of [async()=>({state:'disconnected'}),async()=>{throw Error('transport');},async()=>({state:'unknown'})]){
  const f=fixture(callback);try{await f.click('stop');assert.equal(f.overlay.host.isConnected,true);assert.equal(f.overlay.host.style.pointerEvents,'auto');assert.equal(f.button('release').style.display,'inline-block');assert.notEqual(f.button('retry').style.display,'none');}finally{f.close();}
 }
});
test('本地清理事件只能卸载输入，不会调用暂停、停止或继续回调',()=>{
 let calls=0;const f=fixture(()=>{calls++;return {state:'paused'};});try{
  f.overlay.host.dispatchEvent(new f.dom.window.Event('hermes-overlay-release'));assert.equal(f.windowHandlers.size,0);assert.equal(calls,0);assert.equal(f.overlay.host.isConnected,false);
 }finally{f.close();}
});

// 中文注释：任务屏障尚未完成时显示进度并保留拦截，收尾后才确认 paused。
test('长动作暂停等待显示进度，屏障收尾前不伪造已暂停',async()=>{
 const f=fixture();let finish;const gate=new Promise(resolve=>{finish=resolve;});
 const executor=new Executor({tabs:{},debugger:{}}),task={id:'task',generation:2,tabIds:new Set(),overlays:new Map(),semanticBindings:new Map(),frameRefs:new Map(),interactionRefs:new Map(),interactions:new Map()};
 executor.tasks.set('task',task);executor.syncTaskOverlays=async(_task,state)=>f.overlay.update({state});executor.taskBarrier=()=>gate;
 try{
  const pending=executor.pause('task',2);await tick();assert.equal(task.pauseRequested,true);assert.notEqual(task.paused,true);
  assert.match(f.shadow.textContent,/等待当前步骤结束/);assert.equal(f.key(),true);
  finish();await pending;assert.equal(task.paused,true);assert.equal(f.key(),false);assert.match(f.shadow.textContent,/已暂停/);
 }finally{finish();f.close();}
});

function cleanupFixture({legacy=false,occupied=false}={}){
 const f=fixture();if(legacy){f.overlay.host.removeAttribute('data-hermes-overlay-task');f.overlay.host.removeAttribute('data-hermes-overlay-generation');}
 const calls=[],context={__hermesAutomationOverlay:{overlay:f.overlay,taskId:'task',generation:2,pending:new Map(),active:true}},executor=new Executor({
  tabs:{get:async()=>({url:scope.origin})},
  scripting:{executeScript:async p=>{calls.push('scripting');vm.runInNewContext(`(${p.func.toString()})(scope)`,{document:f.doc,Event:f.dom.window.Event,scope:p.args[0]});}},
  debugger:{getTargets:async()=>occupied?[{tabId:7,attached:true}]:[],attach:async()=>{calls.push('attach');},detach:async()=>{calls.push('detach');},sendCommand:async(_target,method,p)=>{
   calls.push(method);if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:p.worldName==='hermes-automation-overlay'?1:2};
   if(method==='Runtime.callFunctionOn'){const value=vm.runInNewContext(`(${p.functionDeclaration})(scope)`,{...context,scope:p.arguments?.[0]?.value});return {result:{value}};}return {};
  }},
 });
 executor.workspaces={status:async()=>[{taskId:'task',generation:2,tabs:[{tabId:7}]}]};
 return {...f,executor,calls};
}
const stale={id:'task',instanceId:'instance',generation:2,state:'needs_sync',tabIds:[]};
test('重连清理从工作区补回已清空的 tabIds，仅处理本实例 needs_sync 和终态',async()=>{
 const f=cleanupFixture({legacy:true});try{
  await f.executor.cleanupOrphanOverlays([{...stale,instanceId:'foreign'},{...stale,state:'ready'}],'instance');assert.deepEqual(f.calls,[]);
  await f.executor.cleanupOrphanOverlays([stale],'instance');assert.equal(f.overlay.host.isConnected,false);assert.equal(f.windowHandlers.size,0);assert.equal(f.calls.at(-1),'detach');assert.equal(f.executor.overlayCleanupTabs.size,0);
 }finally{f.close();}
});
test('DevTools 占用时只用 scripting 卸载当前浮层，不抢调试器或改任务状态',async()=>{
 const f=cleanupFixture({occupied:true});try{await f.executor.cleanupDetachedOverlay(stale,7);assert.equal(f.overlay.host.isConnected,false);assert.deepEqual(f.calls,['scripting']);assert.equal(f.executor.tasks.size,0);}finally{f.close();}
});
test('新的任务租约或较新浮层代次不能被旧清理请求移除',async()=>{
 const f=cleanupFixture({legacy:true});try{
  f.executor.leases.set(7,'new-task');await f.executor.cleanupDetachedOverlay(stale,7);assert.deepEqual(f.calls,[]);
  f.executor.leases.clear();await f.executor.cleanupDetachedOverlay({...stale,generation:1},7);assert.equal(f.overlay.host.isConnected,true);
 }finally{f.close();}
});
test('预遮罩也响应本地卸载事件，DOM 变化后不重挂或继续拦截',async()=>{
 const dom=new JSDOM('<button>页面</button>',{url:scope.origin,runScripts:'outside-only'});try{
  vm.runInContext(preveilSource([scope.origin],scope),dom.getInternalVMContext());const host=dom.window.document.querySelector('[data-hermes-preveil]');assert.equal(host.dataset.hermesOverlayTask,'task');
  host.dispatchEvent(new dom.window.Event('hermes-overlay-release'));dom.window.document.body.append(dom.window.document.createElement('div'));await tick();
  assert.equal(dom.window.document.querySelector('[data-hermes-preveil]'),null);
 }finally{dom.window.close();}
});
