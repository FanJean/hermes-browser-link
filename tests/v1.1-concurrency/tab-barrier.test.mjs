// 中文注释：离线证明不同页并行、同页串行以及任务级写屏障的先后关系。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('page actions overlap across tabs and task writer fences later reads',async()=>{
 const executor=new Executor({tabs:{},debugger:{}}),gate=deferred(),events=[];
 const task={id:'t',generation:1,allowedOrigins:['https://test.example'],policy:{modeGeneration:1},overlays:new Map()};
 executor.tasks.set('t',task);executor.leases.set(7,'t');executor.leases.set(8,'t');
 executor.performSettled=async(_t,p)=>{events.push(p.requestId);if(p.requestId==='first')await gate.promise;return p.requestId;};
 executor.perform=async()=>{events.push('writer');return true;};
 const run=(requestId,tabId,action='snapshot')=>executor.executeAction({taskId:'t',generation:1,allowedOrigins:task.allowedOrigins,requestId,tabId,action});
 const first=run('first',7),same=run('same',7),other=run('other',8);
 await tick();assert.deepEqual(events,['first','other']);
 const writer=run('writer',undefined,'tabs'),later=run('later',8);
 await tick();assert.deepEqual(events,['first','other']);
 gate.resolve();await Promise.all([first,same,other,writer,later]);
 assert.deepEqual(events,['first','other','same','writer','later']);
 assert.equal(executor.taskBarriers.size,0);
 await assert.rejects(run('foreign',9),/tab lease denied/);
});

// 中文注释：使用真实执行器队列和页面遮罩，接管必须覆盖整项任务，并拒绝接管前排队但尚未派发的动作。
import {JSDOM} from 'jsdom';
import {createAutomationOverlay} from '../../native-extension/automation-overlay.mjs';
function takeoverFixture(){
 const e=new Executor({tabs:{},debugger:{}}),windows=[],effects=[];
 for(const [id,ids] of [['a',[7,8]],['b',[9]]]){
  const t={id,generation:1,allowedOrigins:['https://example.test'],policy:{modeGeneration:1},tabIds:new Set(ids),semanticBindings:new Map(),frameRefs:new Map(),interactionRefs:new Map(),interactions:new Map(),overlays:new Map()};
  e.tasks.set(id,t);
  for(const tabId of ids){
   const dom=new JSDOM('<button>页面</button>',{url:'https://example.test'});windows.push(dom);
   const overlay=createAutomationOverlay({document:dom.window.document,taskId:id,generation:1,tabId,origin:'https://example.test',onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
   t.overlays.set(tabId,{overlay,nonce:String(tabId)});e.leases.set(tabId,id);
  }
 }
 e.overlayCall=async(_tab,entry,op,extra)=>{if(op==='update')entry.overlay.update(extra.update);else if(op==='reblock')entry.overlay.reblock();return true;};
 e.performSettled=async(_t,p)=>{effects.push(p.requestId);return true;};
 const run=(requestId,tabId=7,taskId='a')=>e.executeAction({taskId,generation:1,tabId,requestId,action:'click',allowedOrigins:['https://example.test']});
 return {e,run,effects,host:tabId=>e.tasks.get(tabId===9?'b':'a').overlays.get(tabId).overlay.host,close(){for(const t of e.tasks.values())for(const entry of t.overlays.values())entry.overlay.remove();for(const d of windows)d.window.close();}};
}
test('接管和继续同步整个任务的遮罩，其他任务不变',async()=>{
 const f=takeoverFixture();try{
  await f.e.pause('a',1);assert.equal(f.host(7).style.pointerEvents,'none');assert.equal(f.host(8).style.pointerEvents,'none');assert.equal(f.host(9).style.pointerEvents,'auto');
  await assert.rejects(f.run('paused'),/task paused/);await f.run('other',9,'b');
  await f.e.resume('a',1);assert.equal(f.host(7).style.pointerEvents,'auto');assert.equal(f.host(8).style.pointerEvents,'auto');await f.run('resumed');
  assert.deepEqual(f.effects,['other','resumed']);
 }finally{f.close();}
});
test('接管前已排队的同页动作不会在当前动作结束后派发',async()=>{
 const f=takeoverFixture(),gate=deferred(),entered=deferred();try{
  f.e.performSettled=async(_t,p)=>{f.effects.push(p.requestId);if(p.requestId==='first'){entered.resolve();await gate.promise;}return true;};
  const first=f.run('first');await entered.promise;
  const queued=f.run('queued').then(()=>({ok:true}),error=>({error}));await tick();
  const pause=f.e.pause('a',1);gate.resolve();await first;await pause;
  assert.match((await queued).error?.message||'',/task paused/);assert.deepEqual(f.effects,['first']);
 }finally{gate.resolve();f.close();}
});
