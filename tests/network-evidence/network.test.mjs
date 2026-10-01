// 中文注释：捕获隔离、游标、正文分页、敏感字段过滤与缓存上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import {NetworkEvidence} from '../../native-extension/network-evidence.mjs';
function fixture(){
 const t={execution:{},allowedOrigins:['https://example.test']};
 const calls=[];
 const executor={pageRuntime:{assert:()=>{if(!t.execution)throw Error('revoked');return t.execution;}},allowed:(_,url)=>{if(new URL(url).origin!=='https://example.test')throw Error('denied');},api:{debugger:{sendCommand:async(target,method)=>{calls.push(method);return {body:JSON.stringify({rows:['x'.repeat(500)],token:'PRIVATE',nested:{password:'PRIVATE'}})};}}}};
 const network=new NetworkEvidence(executor), source={tabId:7};
 const inspect=options=>network.inspect(t,{tabId:7,options},()=>{if(!t.execution)throw Error('revoked');});
 const observe=(method,params)=>network.observe(t,source,method,params);
 const request=id=>observe('Network.requestWillBeSent',{requestId:id,request:{url:'https://example.test/api?token=PRIVATE',method:'GET'}});
 const finish=id=>{observe('Network.responseReceived',{requestId:id,response:{url:'https://example.test/api',status:200,mimeType:'application/json'}});observe('Network.loadingFinished',{requestId:id});};
 return {t,network,inspect,observe,request,finish,calls};
}
test('summary then detail pages one cached JSON without credentials',async()=>{
 const f=fixture(),{captureId}=await f.inspect({operation:'start'});f.request('one');f.finish('one');
 const list=await f.inspect({operation:'list',captureId});assert.equal(list.entries.length,1);assert.equal(list.entries[0].url,'https://example.test/api');
 assert.equal(f.calls.includes('Network.getResponseBody'),false);
 const first=await f.inspect({operation:'detail',captureId,seq:1,maxChars:200});assert.equal(first.body.nextStart,200);
 const rest=await f.inspect({operation:'detail',captureId,seq:1,start:200,maxChars:20000});
 assert.ok(!(first.body.text+rest.body.text).includes('PRIVATE'));assert.equal(f.calls.filter(x=>x==='Network.getResponseBody').length,1);
 assert.equal((await f.inspect({operation:'list',captureId,afterSequence:list.cursor})).entries.length,0);
});
test('updates are visible after list cursor and page limits advance',async()=>{
 const f=fixture(),{captureId}=await f.inspect({operation:'start'});f.request('one');
 const first=await f.inspect({operation:'list',captureId});f.finish('one');f.request('two');
 const next=await f.inspect({operation:'list',captureId,afterSequence:first.cursor,limit:1});assert.equal(next.hasMore,true);assert.equal(next.entries[0].seq,1);assert.equal(next.entries[0].completed,true);
 const last=await f.inspect({operation:'list',captureId,afterSequence:next.cursor});assert.equal(last.entries[0].seq,2);
});
test('foreign origins, child sessions, stale capture and revoked grant',async()=>{
 const f=fixture(),{captureId}=await f.inspect({operation:'start'});
 f.observe('Network.requestWillBeSent',{requestId:'x',request:{url:'https://outside.test/private',method:'GET'}});
 f.network.observe(f.t,{tabId:7,sessionId:'child'},'Network.requestWillBeSent',{requestId:'y',request:{url:'https://example.test/a',method:'GET'}});
 assert.equal((await f.inspect({operation:'list',captureId})).entries.length,0);
 await f.inspect({operation:'start'});await assert.rejects(f.inspect({operation:'list',captureId}),/NETWORK_CAPTURE_STALE/);
 f.t.execution=null;await assert.rejects(f.inspect({operation:'start'}),/revoked/);
});
test('eviction and stop are explicit, invalid options rejected',async()=>{
 const f=fixture(),{captureId}=await f.inspect({operation:'start'});
 for(let i=0;i<130;i++)f.request(String(i));
 const list=await f.inspect({operation:'list',captureId});assert.equal(list.dropped,2);
 await assert.rejects(f.inspect({operation:'detail',captureId,seq:1}),/NETWORK_ENTRY_UNAVAILABLE/);
 await assert.rejects(f.inspect({operation:'list',captureId,limit:0}),/INVALID_NETWORK_OPTIONS/);
 await f.inspect({operation:'stop'});await assert.rejects(f.inspect({operation:'list',captureId}),/NETWORK_CAPTURE_STALE/);
});

test('document replacement preserves captures; leaving scope or closing clears them',async()=>{
 const {Executor}=await import('../../native-extension/core.mjs');
 const executor=new Executor({});
 const task={id:'t',tabIds:new Set([7]),agentTabs:new Set([7]),allowedOrigins:['https://example.test'],execution:{network:new Map([[7,{captureId:'capture',entries:new Map()}]])}};
 executor.tasks.set('t',task);executor.leases.set(7,'t');executor.documentChanged=async()=>true;
 const capture=task.execution.network.get(7);
 await executor.tabEvent(7,'navigated','https://example.test/next');
 assert.equal(task.execution.network.get(7),capture);
 await executor.tabEvent(7,'navigated','https://outside.test/');
 assert.equal(task.execution.network.has(7),false);
 task.execution.network.set(7,capture);
 await executor.tabEvent(7,'closed');
 assert.equal(task.execution.network.has(7),false);
});

// 中文注释：从执行器动作入口穿过页面运行时与网络缓存，覆盖正文读取期间撤权和离站。
for(const change of ['revoke','navigate'])test(`network detail rejects ${change} during body retrieval`,async()=>{
 const {Executor}=await import('../../native-extension/core.mjs');
 let onBody=()=>{};
 const api={tabs:{get:async()=>({id:7,url:'https://example.test/',status:'complete'})},debugger:{
  sendCommand:async(_target,method)=>{
   if(method==='Network.getResponseBody'){await onBody();return {body:'{"rows":[1]}'};}
   return {};
  },attach:async()=>{},detach:async()=>{}}};
 const executor=new Executor(api);
 const task={id:'t',generation:1,revoked:false,tabIds:new Set([7]),agentTabs:new Set([7]),allowedOrigins:['https://example.test'],policy:{activeMode:'full',modeGeneration:1}};
 executor.tasks.set('t',task);executor.leases.set(7,'t');
 executor.documentChanged=async()=>true;
 const execute=options=>executor.execute({taskId:'t',generation:1,allowedOrigins:task.allowedOrigins,tabId:7,action:'network.inspect',options});
 const {captureId}=await execute({operation:'start'});
 executor.pageRuntime.observe({tabId:7},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://example.test/api',method:'GET'}});
 executor.pageRuntime.observe({tabId:7},'Network.loadingFinished',{requestId:'one'});
 onBody=async()=>{
  if(change==='revoke'){task.revoked=true;executor.pageRuntime.clear(task);}
  else await executor.tabEvent(7,'navigated','https://outside.test/');
 };
 await assert.rejects(execute({operation:'detail',captureId,seq:1}),change==='revoke'?/stale generation/:/NETWORK_CAPTURE_STALE/);
});
