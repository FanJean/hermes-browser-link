// 中文注释：慢页面加载：只读动作先等加载完成，加载途中的瞬时失败自动重做一次；写入类动作不重做。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor,PAGE_SETTLE_MS,isTransientLoadError} from '../../native-extension/core.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

function fixture(statuses){
 const listeners=new Set();let status=statuses.shift();
 const api={debugger:{attach:async()=>{},sendCommand:async(_target,method)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:'https://site.test/',loaderId:'doc'}}}:method==='Page.createIsolatedWorld'?{executionContextId:1}:{result:{value:status==='complete'?'complete':'loading'}}},tabs:{get:async id=>({id,url:'https://site.test/',status}),onUpdated:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}};
 const executor=new Executor(api);
 const task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test']};executor.tasks.set('t',task);executor.leases.set(7,'t');
 const finishLoad=()=>{status='complete';for(const fn of listeners)fn(7,{status:'complete'});};
 return {executor,task,finishLoad,listeners};
}

test('read actions wait for a loading page before running',async()=>{
 const f=fixture(['loading']);const order=[];
 f.executor.perform=async()=>{order.push('perform');return {ok:true};};
 const pending=f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'semantic_snapshot'});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(order,[]);
 f.finishLoad();order.push('loaded');
 assert.deepEqual(await pending,{ok:true});
 assert.deepEqual(order,['loaded','perform']);
 assert.equal(PAGE_SETTLE_MS>=5000,true);
});

test('transient load failure on a read is retried once after the page settles',async()=>{
 const f=fixture(['complete']);let calls=0;
 f.executor.perform=async()=>{calls++;if(calls===1)throw Error('{"code":-32000,"message":"Cannot find context with specified id"}');return 'fresh';};
 assert.equal(await f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'snapshot'}),'fresh');
 assert.equal(calls,2);
});

test('writes and non-transient failures are never replayed',async()=>{
 const f=fixture(['complete']);let calls=0;
 f.executor.perform=async()=>{calls++;throw Error('{"code":-32000,"message":"Execution context was destroyed."}');};
 await assert.rejects(f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'ref_click'}),/destroyed/);
 assert.equal(calls,1);
 calls=0;f.executor.perform=async()=>{calls++;throw Error('origin denied');};
 await assert.rejects(f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'snapshot'}),/origin denied/);
 assert.equal(calls,1);
 assert.equal(isTransientLoadError(Error('page said Cannot find context with specified id')),false);
 assert.equal(isTransientLoadError(Error('DOCUMENT_CHANGED')),true);
});

test('interactive DOM is readable even when tab remains loading',async()=>{
 const f=fixture(['loading']);let reads=0;
 f.executor.api.debugger.sendCommand=async(_target,method)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:'https://site.test/',loaderId:'doc'}}}:method==='Page.createIsolatedWorld'?{executionContextId:1}:{result:{value:'interactive'}};
 f.executor.perform=async()=>{reads++;return 'dom-ready';};
 assert.equal(await f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'snapshot'}),'dom-ready');
 assert.equal(reads,1);assert.equal((await f.executor.api.tabs.get(7)).status,'loading');
});

// 中文注释：复用真实已授权读取与末尾文档检查，只替换浏览器边界；导航事件可在语义回执后推进文档代次。
function documentRaceFixture(changes){
 const f=fixture(['complete']),e=f.executor;let reads=0;
 f.task.policy={modeGeneration:1};f.task.semanticBindings=new Map();
 e.attached.add(7);e.ensurePageEvents=async()=>{};e.ensureOverlay=async()=>null;
 e.callSemanticWorld=async()=>{
  reads++;
  if(reads<=changes)e.docs.set(7,(e.docs.get(7)||0)+1);
  return {items:[],read:reads};
 };
 const guard=()=>{e.check(f.task,{generation:1});if(e.leases.get(7)!==f.task.id)throw Error('tab lease denied');};
 const get=async id=>{const tab=await e.api.tabs.get(id);guard();e.allowed(f.task,tab.url);return tab;};
 e.perform=(t,p)=>e.performAuthorized(t,p,guard,get,1);
 return {...f,reads:()=>reads};
}

test('导航事件在语义回执后推进文档代次时丢弃旧读结果并有界恢复',async()=>{
 const f=documentRaceFixture(1);
 const result=await f.executor.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'semantic_snapshot'});
 assert.deepEqual(result,{items:[],read:2});assert.equal(f.reads(),2);
});

test('持续换文档最多重读一次，桥接保留固定文档错误且不交付旧正文',async()=>{
 const f=documentRaceFixture(Infinity),sent=[];
 f.executor.execute=p=>f.executor.performSettled(f.task,p);
 const bridge=new Bridge({postMessage:m=>sent.push(m),onMessage:{addListener(){}}},f.executor);
 bridge.receive({id:'read-race',method:'browser.execute',params:{taskId:'t',generation:1,tabId:7,action:'semantic_snapshot'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.reads(),2);assert.equal(sent.length,1);
 assert.equal(sent[0].result,undefined);assert.equal(sent[0].error.code,'document_changed');
 assert.deepEqual(sent[0].error.data,{outcomeUnknown:false,retryable:true,stage:'document',reasonCode:'document_changed'});
});

test('有界恢复仍检查租约，不能把权限拒绝当成导航竞态继续读取',async()=>{
 const f=documentRaceFixture(1),e=f.executor;
 const perform=e.perform;let attempts=0;
 e.perform=async(t,p)=>{attempts++;try{return await perform(t,p);}finally{e.leases.delete(7);}};
 await assert.rejects(e.performSettled(f.task,{taskId:'t',generation:1,tabId:7,action:'semantic_snapshot'}),/tab lease denied/);
 assert.equal(attempts,1);assert.equal(f.reads(),1);
});
