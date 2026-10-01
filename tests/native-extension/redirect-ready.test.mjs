// 中文注释：合成标签页与 CDP 回执验证跳转来源、DOM 就绪和普通工作页状态检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {readyState as officialReadyState} from '../../native-extension/official-actions.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

function navigation(start,finish,state='complete'){
 let url=start,reads=0;
 const api={tabs:{get:async id=>({id,url,status:reads++>0?state:'loading',windowId:1,groupId:2})},
  debugger:{attach:async()=>{},getTargets:async()=>[{id:'target-7',tabId:7,type:'page'},{id:'target-9',tabId:9,type:'page'}],
   sendCommand:async(_target,method,params)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',loaderId:'doc',url}}}:
    method==='Page.createIsolatedWorld'?{executionContextId:1}:{result:{value:params.functionDeclaration.includes('const body=')?
     {ready:state==='complete'?'complete':'interactive',title:'',heading:false,textLength:0,elementCount:0}:
     state==='complete'?'complete':'interactive'}}}};
 const executor=new Executor(api),task={id:'task',allowedOrigins:[new URL(start).origin]};
 queueMicrotask(()=>{url=finish;});
 return {executor,task};
}

for(const [start,finish,allowed] of [
 ['https://example.com/','https://www.example.com/path',true],
 ['https://www.example.com/','https://example.com/path',true],
 ['https://example.com/','https://shop.example.com/path',false],
 ['https://example.com/','https://other.test/secret',false],
])test(`committed redirect ${start} to ${new URL(finish).origin}`,async()=>{
 const {executor,task}=navigation(start,finish);
 const began=Date.now();
 if(allowed){
  const result=await executor.settledTab(7,()=>{},null,8000,task,start);
  assert.equal(result.ready,'complete');
  assert.ok(task.allowedOrigins.includes(new URL(finish).origin));
 }else{
  await assert.rejects(executor.settledTab(7,()=>{},null,8000,task,start),error=>
   error.code==='REDIRECTED_OUT_OF_SCOPE'&&error.finalOrigin===new URL(finish).origin&&error.preDispatch===true);
  assert.deepEqual(task.allowedOrigins,[new URL(start).origin]);
  assert.ok(Date.now()-began<500,'跨站提交应立即返回');
 }
});

test('loading tab returns at interactive and normal new tab can read readyState; foreign tab cannot',async()=>{
 let url='https://example.com/';
 const api={tabs:{get:async id=>({id,url,status:'loading',windowId:1,groupId:2})},
  debugger:{attach:async()=>{},getTargets:async()=>[{id:'target-7',tabId:7,type:'page'},{id:'target-9',tabId:9,type:'page'}],
   sendCommand:async(_target,method,params)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',loaderId:'doc',url}}}:
    method==='Page.createIsolatedWorld'?{executionContextId:1}:{result:{value:params.functionDeclaration.includes('const body=')?
     {ready:'interactive',title:'',heading:false,textLength:0,elementCount:0}:'interactive'}}}};
 const executor=new Executor(api),task={id:'task',title:'task',allowedOrigins:['https://example.com'],tabIds:new Set(),agentTabs:new Set()};
 executor.workspaces={authority:{resolve:()=>({windowId:1})},open:async()=>({tabId:7,groupId:2})};task.workspaceCapability='cap';
 const began=Date.now();
 const opened=await executor.openOwnedTab(task,{action:'new_tab',requestId:'r'},()=>{},url);
 assert.equal(opened.ready,'interactive');assert.ok(Date.now()-began<500);
 assert.deepEqual(await officialReadyState(executor,task,{tabId:7},()=>{}),{readyState:'interactive'});
 await assert.rejects(officialReadyState(executor,task,{tabId:9},()=>{}),/TARGET_UNAVAILABLE/);
});

test('navigation settle returns interactive before tab complete',async()=>{
 const start='https://example.com/start';
 const {executor,task}=navigation(start,'https://example.com/next','loading');
 const began=Date.now();
 const result=await executor.settledTab(7,()=>{},null,8000,task,start);
 assert.equal(result.ready,'interactive');
 assert.equal(result.tab.url,'https://example.com/next');
 assert.ok(Date.now()-began<500);
});

test('readyState probe failure falls back to tab status instead of failing the open',async()=>{
 let reads=0,probes=0;
 const api={tabs:{get:async id=>({id,url:'https://example.com/',status:reads++>3?'complete':'loading',windowId:1,groupId:2})},
  debugger:{attach:async()=>{},sendCommand:async()=>{probes++;throw Error('Another debugger is already attached');}}};
 const executor=new Executor(api),task={id:'task',allowedOrigins:['https://example.com']};
 const result=await executor.settledTab(7,()=>{},null,8000,task,'https://example.com/');
 assert.equal(result.ready,'complete');
 assert.equal(probes,1,'探测失败后本页不再重复探测');
});

test('bridge reports only final origin and definite redirected rejection',async()=>{
 let resolve;
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:value=>resolve(value)},
  {execute:async()=>{throw Object.assign(Error('secret/path?token=x'),{code:'REDIRECTED_OUT_OF_SCOPE',
   finalOrigin:'https://other.test',preDispatch:true});}});
 const reply=new Promise(done=>{resolve=done;});
 bridge.receive({id:'r',method:'browser.execute',params:{action:'new_tab'}});
 const result=await reply;
 assert.equal(result.error.code,'redirected_out_of_scope');
 assert.deepEqual(result.error.data,{outcomeUnknown:false,retryable:false,finalOrigin:'https://other.test'});
 assert.ok(!JSON.stringify(result).includes('secret/path'));
});
