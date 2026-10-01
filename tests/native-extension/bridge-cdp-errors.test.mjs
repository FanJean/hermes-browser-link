import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';

async function request(description, semantic = true, action = 'ref_click') {
 const api={debugger:{sendCommand:async()=>({exceptionDetails:{exception:{description}}})}};
 const executor=new Executor(api);
 // 中文注释：本测试只验证动作异常，不把库安装错误混入测试。
 executor.semanticWorlds.add(JSON.stringify([1,undefined,1]));
 executor.execute=()=>semantic
  ? executor.callSemanticWorld({tabId:1},'frame','ref_click',{},()=>{},1)
  : executor.callWorld({tabId:1},'frame',{allowedOrigins:['https://example.test']},'click','#target',null,null,()=>{},1);
 const sent=[];
 const bridge=new Bridge({postMessage:m=>sent.push(m),onMessage:{addListener(){}}},executor);
 bridge.receive({id:'probe',method:'browser.execute',params:{action}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,1);
 return sent[0].error;
}

for(const semantic of [true,false])for(const [reason,code] of [
 ['TARGET_OCCLUDED','target_occluded'],['STALE_REF','stale_reference'],
 ['BINDING_MISMATCH','stale_reference'],['DOM_CHANGED','document_changed'],
 ['origin denied','permission_denied'],
])test(`CDP ${semantic?'semantic':'selector'} error retains ${reason}`,async()=>{
 const error=await request(`Error: ${reason}\n    at privatePage (https://example.test/private?secret=hidden:1:2)`,semantic);
 assert.equal(error.code,code);
 assert.deepEqual(error.data,{outcomeUnknown:!(['TARGET_OCCLUDED'].includes(reason)||semantic&&['STALE_REF','BINDING_MISMATCH'].includes(reason)),retryable:false,...(code==='document_changed'?{stage:'document',reasonCode:'document_changed'}:{})});
 assert.equal(JSON.stringify(error).includes('private'),false);
});
test('wrapped stale read permits refresh, not write replay',async()=>{
 const error=await request('Error: STALE_REF\n    at snapshot (<anonymous>:1:2)',true,'semantic_snapshot');
 assert.equal(error.code,'stale_reference');
 assert.deepEqual(error.data,{outcomeUnknown:false,retryable:true});
});
test('classification must not search arbitrary payloads or stack frames',async()=>{
 for(const text of ['private TARGET_OCCLUDED payload','Error: private\n    at STALE_REF','Error: STALE_REF extra-private-data']) {
  const error=await request(text);
  assert.equal(error.code,'execution_denied');
  assert.equal(JSON.stringify(error).includes('private'),false);
 }
});
test('page-load CDP protocol errors become retryable page_not_ready for reads, never generic denial',async()=>{
 const run=async(action,message)=>{
  const executor=new Executor({debugger:{}});executor.execute=async()=>{throw Error(message);};
  const sent=[];const bridge=new Bridge({postMessage:m=>sent.push(m),onMessage:{addListener(){}}},executor);
  bridge.receive({id:'probe',method:'browser.execute',params:{action}});
  await new Promise(resolve=>setImmediate(resolve));return sent[0].error;
 };
 let error=await run('semantic_snapshot','{"code":-32000,"message":"Cannot find context with specified id"}');
 assert.equal(error.code,'page_not_ready');assert.deepEqual(error.data,{outcomeUnknown:false,retryable:true});
 error=await run('ref_click','{"code":-32000,"message":"Execution context was destroyed."}');
 assert.equal(error.code,'page_not_ready');assert.equal(error.data.retryable,false);assert.equal(error.data.outcomeUnknown,true);
 error=await run('semantic_snapshot','private Cannot find context with specified id');
 assert.equal(error.code,'execution_denied');
});
test('page parser budget failure has a fixed code',async()=>{
 const error=await request('Error: BUDGET_TOO_SMALL',true,'page.parse');
 assert.equal(error.code,'parse_budget_too_small');
 assert.equal(error.data.outcomeUnknown,false);
});

for(const [reason,code] of [
 ['sensitive target blocked','sensitive_target'],
 ['target unavailable','target_unavailable'],
 ['target not found','target_unavailable'],
])test(`具体页面拒绝 ${reason} 有固定码且不泄露页面内容`,async()=>{
 // 中文注释：定位失败发生在派发前，保留固定码且不泄露页面异常文本。
 const error=await request(`Error: ${reason}\n    at privatePage (https://example.test/private?secret=hidden:1:2)`,false,'fill');
 assert.equal(error.code,code);
 assert.equal(error.data.outcomeUnknown,reason==='sensitive target blocked');
 assert.equal(JSON.stringify(error).includes('private'),false);
});
