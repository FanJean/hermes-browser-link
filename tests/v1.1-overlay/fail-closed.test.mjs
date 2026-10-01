// 中文注释：复现普通动作无限放行、文档替换掉罩和动作锁外恢复的竞态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createAutomationOverlay} from '../../native-extension/automation-overlay.mjs';
import {Executor,preveilSource} from '../../native-extension/core.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const dom=new JSDOM('<!doctype html><input><iframe></iframe>',{url:'https://example.test',runScripts:'outside-only'});
 const overlay=createAutomationOverlay({document:dom.window.document,taskId:'t',generation:1,tabId:7,origin:'https://example.test',onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 return {dom,overlay,close(){overlay.remove();dom.window.close();}};
}
test('普通动作无论是否收到完成回调，放行窗口到期都恢复拦截',async()=>{
 const f=fixture();try{
  for(const step of ['click','fill','press','ref_click','scroll']){
   f.overlay.update({state:'running',step,holdMs:15});assert.equal(f.overlay.host.style.pointerEvents,'none');
   await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.overlay.host.style.pointerEvents,'auto',step);
  }
 }finally{f.close();}
});
test('删除遮罩或替换根节点后自动重建，且关闭在途放行',async()=>{
 const f=fixture();try{
  f.overlay.update({state:'running',step:'click'});f.overlay.host.remove();await tick();
  assert.equal(f.overlay.host.isConnected,true);assert.equal(f.overlay.host.style.pointerEvents,'auto');
  f.dom.window.document.documentElement.replaceWith(f.dom.window.document.createElement('html'));await tick();
  assert.equal(f.overlay.host.isConnected,true);
  f.overlay.update({state:'paused'});f.overlay.host.remove();await tick();
  assert.equal(f.overlay.host.isConnected,true);assert.equal(f.overlay.host.style.pointerEvents,'none');
  f.overlay.remove();await tick();assert.equal(f.overlay.host.isConnected,false);
 }finally{f.close();}
});
test('document.open 和 bfcache 恢复后保留遮罩与拦截',async()=>{
 const f=fixture();try{
  const doc=f.dom.window.document;doc.open();doc.write('<html><body><input></body></html>');doc.close();await tick();
  assert.equal(f.overlay.host.isConnected,true);
  f.overlay.update({state:'running',step:'click'});f.dom.window.dispatchEvent(new f.dom.window.Event('pageshow'));
  assert.equal(f.overlay.host.style.pointerEvents,'auto');
 }finally{f.close();}
});
test('已聚焦的 iframe 在拦截恢复时交还焦点，暂停时保留用户焦点',()=>{
 const f=fixture();try{
  const frame=f.dom.window.document.querySelector('iframe');frame.focus();f.overlay.update({state:'waiting'});
  assert.notEqual(f.dom.window.document.activeElement,frame);
  f.overlay.update({state:'paused'});frame.focus();f.overlay.reblock();assert.equal(f.dom.window.document.activeElement,frame);
 }finally{f.close();}
});
test('新文档预遮罩节点被页面删除后仍会恢复',async()=>{
 const dom=new JSDOM('<!doctype html><button>页面</button>',{url:'https://example.test',runScripts:'outside-only'});
 try{
  dom.window.eval(preveilSource(['https://example.test']));const host=dom.window.document.querySelector('[data-hermes-preveil]');assert.ok(host);
  host.remove();await tick();assert.ok(dom.window.document.querySelector('[data-hermes-preveil]'));
 }finally{const full=dom.window.document.createElement('div');full.setAttribute('data-hermes-automation-overlay','');dom.window.document.documentElement.append(full);await tick();dom.window.close();}
});
for(const failure of [null,'异常','INTERACTION_HIGHLIGHT_FRAME_TIMEOUT','DOCUMENT_CHANGED','授权撤销'])test(`动作${failure||'成功'}在释放同页锁前收回放行`,async()=>{
 const e=new Executor({tabs:{},debugger:{}}),events=[];
 const t={id:'t',generation:1,allowedOrigins:['https://example.test'],policy:{modeGeneration:1},overlays:new Map([[7,{nonce:'n'}]])};
 e.tasks.set(t.id,t);e.leases.set(7,t.id);
 const p={taskId:'t',generation:1,tabId:7,action:'click',allowedOrigins:t.allowedOrigins};
 let end;const pending=new Promise(resolve=>{end=resolve;});
 e.overlayCall=async()=>{events.push('开始恢复');await pending;events.push('完成恢复');return true;};
 e.performSettled=async()=>{events.push('派发');if(failure==='授权撤销')t.revoked=true;if(failure)throw Object.assign(Error(failure),{preDispatch:failure.includes('TIMEOUT')});return true;};
 const first=e.executeAction(p).catch(error=>error.message);await tick();
 const second=e.lock(7,async()=>events.push('下一动作'));await tick();
 assert.equal(events.includes('开始恢复'),true);assert.equal(events.includes('下一动作'),false);
 end();await Promise.all([first,second]);assert.ok(events.indexOf('完成恢复')<events.indexOf('下一动作'));
});
test('两个任务不同页面并行时只恢复各自遮罩',async()=>{
 const e=new Executor({tabs:{},debugger:{}}),calls=[];
 for(const [id,tabId] of [['a',7],['b',8]]){e.tasks.set(id,{id,generation:1,allowedOrigins:[],policy:{modeGeneration:1},overlays:new Map([[tabId,{nonce:id}]])});e.leases.set(tabId,id);}
 e.performSettled=async()=>{await tick();return true;};e.overlayCall=async(tabId,entry)=>{calls.push([tabId,entry.nonce]);return true;};
 await Promise.all([['a',7],['b',8]].map(([taskId,tabId])=>e.executeAction({taskId,tabId,generation:1,action:'click',allowedOrigins:[]})));
 assert.deepEqual(calls.sort(),[[7,'a'],[8,'b']]);
});

test('迟到的动作收尾不能收回下一次放行，撤销后旧授权不能重新放开',async()=>{
 const f=fixture();try{
  const state={nonce:'n',taskId:'t',generation:1,documentId:'d',modeGeneration:1,active:true,overlay:f.overlay};
  f.dom.window.__hermesAutomationOverlay=state;
  const e=new Executor({tabs:{},debugger:{sendCommand:async(_target,_method,p)=>({result:{value:f.dom.window.eval(`(${p.functionDeclaration})`)(...p.arguments.map(arg=>arg.value))}})}});
  const entry={nonce:'n',contextId:1},scope={taskId:'t',generation:1,documentId:'d',modeGeneration:1,update:{state:'running',step:'click'}};
  await e.overlayCall(7,entry,'scope-running',{...scope,actionToken:'a'});
  await e.overlayCall(7,entry,'scope-running',{...scope,actionToken:'b'});
  assert.equal(await e.overlayCall(7,entry,'reblock',{expectedActionToken:'a'}),false);
  assert.equal(f.overlay.host.style.pointerEvents,'none');
  await e.overlayCall(7,entry,'revoke');assert.equal(f.overlay.host.style.pointerEvents,'auto');
  assert.equal(await e.overlayCall(7,entry,'scope-running',{...scope,actionToken:'a'}),false);
  assert.equal(f.overlay.host.style.pointerEvents,'auto');
 }finally{f.close();}
});
