// 中文注释：慢页面加载：只读动作先等加载完成，加载途中的瞬时失败自动重做一次；写入类动作不重做。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor,PAGE_SETTLE_MS,isTransientLoadError} from '../../native-extension/core.mjs';

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
