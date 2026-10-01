// 中文注释：固定八次语义调用的离线传输预算；不伪造真实浏览器延迟。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Executor} from '../../native-extension/core.mjs';

test('semantic CDP command and byte budget',async t=>{
 const context=vm.createContext({});let calls=0,bytes=0;
 const executor=new Executor({tabs:{},debugger:{sendCommand:async(_target,method,params)=>{
  calls++;bytes+=Buffer.byteLength(JSON.stringify({method,params}));
  if(method==='Runtime.callFunctionOn'){
   // 中文注释：替换页面实现只为计数安装与调用协议，页面动作由语义测试覆盖。
   const declaration=params.functionDeclaration.includes('const createPageSemantics=')?'function(){globalThis.__hermesSemanticLibrary={version:1,call:()=>true};return true;}':params.functionDeclaration;
   return {result:{value:await vm.runInContext(`(${declaration})`,context)(...(params.arguments||[]).map(a=>a.value))}};
  }
  throw Error(method);
 }}});
 for(let i=0;i<8;i++)await executor.callSemanticWorld({tabId:7},'main','rect_ref',{},()=>{},17);
 t.diagnostic(JSON.stringify({calls,bytes}));
 assert.equal(calls,9);assert.ok(bytes<65000);
 const cold={calls,bytes};
 for(let i=0;i<8;i++)await executor.callSemanticWorld({tabId:7},'main','rect_ref',{},()=>{},17);
 t.diagnostic(JSON.stringify({warmCalls:calls-cold.calls,warmBytes:bytes-cold.bytes}));
 assert.equal(calls-cold.calls,8);assert.ok(bytes-cold.bytes<6000);
});

test('phase diagnostics reject page content and retain numeric durations',async()=>{
 const executor=new Executor({tabs:{},debugger:{}});
 for(const stage of ['queue_wait','settle_wait','overlay','target_settle','highlight','dispatch','post_check'])await executor.timed({action:'ref_click'},stage,async()=>true);
 const events=executor.diagnostics.snapshot();assert.equal(events.length,7);
 assert.ok(events.every(e=>e.action==='ref_click'&&typeof e.duration_ms==='number'));
 assert.equal(executor.diagnostics.recordSafely({component:'mv3_background',event_type:'action_state',status:'succeeded',stage:'https://private.test',action:'ref_click'}),false);
});

test('missing library reinstalls once, absent context recovers, unknown dispatch never retries',async()=>{
 const context=vm.createContext({});let installs=0,invokes=0,missingContext=false,unknown=false;
 const executor=new Executor({tabs:{},debugger:{sendCommand:async(_target,method,params)=>{
  if(method==='Page.createIsolatedWorld')return {executionContextId:18};
  if(missingContext){missingContext=false;throw Error('{"code":-32000,"message":"Cannot find context with specified id"}');}
  const installing=params.functionDeclaration.includes('const createPageSemantics=');
  if(installing)installs++;else{invokes++;if(unknown)throw Error('Execution context was destroyed.');}
  const declaration=installing?'function(){globalThis.__hermesSemanticLibrary={version:1,call:()=>true};return true;}':params.functionDeclaration;
  return {result:{value:await vm.runInContext(`(${declaration})`,context)(...(params.arguments||[]).map(a=>a.value))}};
 }}});
 const call=()=>executor.callSemanticWorld({tabId:7},'main','rect_ref',{},()=>{},17);
 await call();vm.runInContext('delete globalThis.__hermesSemanticLibrary',context);await call();
 assert.equal(installs,2);assert.equal(invokes,3);
 missingContext=true;await call();assert.equal(installs,3);
 unknown=true;const before=invokes;await assert.rejects(call(),/destroyed/);assert.equal(invokes,before+1);
});
// 中文注释：诊断写入失败不能覆盖页面动作的成功值或原始异常。
test('阶段诊断异常不影响动作结果',async()=>{
 const e=new Executor({tabs:{},debugger:{}});e.diagnostics.recordSafely=()=>{throw Error('诊断不可用');};
 assert.equal(await e.timed({action:'click'},'dispatch',async()=>42),42);
 const original=Error('原始页面错误');await assert.rejects(e.timed({action:'click'},'dispatch',async()=>{throw original;}),error=>error===original);
});
