import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';

function fixture(allowChild=true,{nested=false}={}){
 const main='https://main.test',child='https://child.test',deep='https://deep.test';
 const listeners=new Set(),scrolls=[];let childLoader='child-document-1',deepLoader='deep-document-1';
 const api={tabs:{get:async id=>({id,url:main+'/page',status:'complete'})},debugger:{
  onEvent:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)},
  attach:async()=>{},detach:async()=>{},
  sendCommand:async(target,method,params={})=>{
   if(method==='Page.getFrameTree')return target.sessionId==='deep-session'?
    {frameTree:{frame:{id:'deep-frame',loaderId:deepLoader,url:deep+'/page'}}}:target.sessionId?
    {frameTree:{frame:{id:'child-frame',loaderId:childLoader,url:child+'/page'}}}:
    {frameTree:{frame:{id:'main-frame',loaderId:'main-document',url:main+'/page'}}};
   if(method==='Target.setAutoAttach'){
    if(target.sessionId!=='deep-session')for(const listener of listeners)listener({tabId:7},'Target.attachedToTarget',
     target.sessionId==='child-session'?{sessionId:'deep-session',targetInfo:{type:'iframe',targetId:'deep-frame',url:deep+'/page'}}:
      {sessionId:'child-session',targetInfo:{type:'iframe',targetId:'child-frame',url:child+'/page'}});
    return {};
   }
   if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:target.sessionId==='deep-session'?[]:
    target.sessionId==='child-session'&&nested?[{nodeName:'IFRAME',frameId:'deep-frame',backendNodeId:10}]:
     target.sessionId?[]:[{nodeName:'IFRAME',frameId:'child-frame',backendNodeId:9}]}};
   if(method==='DOM.enable')return {};
   if(method==='DOM.scrollIntoViewIfNeeded'){scrolls.push([target.sessionId||null,params.backendNodeId]);return {};}
   throw Error(`unexpected ${method}`);
  },
 }};
 const task={id:'task',generation:1,instanceId:'browser',approvalScope:'owner',
  allowedOrigins:allowChild?[main,child,...(nested?[deep]:[])]:[main],tabIds:[7]};
 return {api,task,scrolls,setChildLoader:value=>{childLoader=value;},setDeepLoader:value=>{deepLoader=value;}};
}

test('frame token is reused only while child document identity remains current',async()=>{
 const {api,task,setChildLoader}=fixture(),executor=new Executor(api);
 await executor.approve(task);
 const request={taskId:task.id,generation:1,tabId:7,action:'frame_catalog',allowedOrigins:task.allowedOrigins};
 const first=await executor.execute(request);
 assert.equal(first.frames[0].access,'ready');assert.equal(first.frames[0].kind,'out_of_process');
 const token=first.frames[0].frameToken;assert.ok(token);
 assert.equal((await executor.execute(request)).frames[0].frameToken,token);
 setChildLoader('child-document-2');
 const next=await executor.execute(request);
 assert.notEqual(next.frames[0].frameToken,token);
 assert.equal(executor.tasks.get('task').frameRefs.get(7).has(token),false);
});

test('unapproved child origin is visible as a gap without an executable token',async()=>{
 const {api,task}=fixture(false),executor=new Executor(api);
 await executor.approve(task);
 // 中文注释：发现来源不等于授予读取权限，未批准 frame 只公开来源和拒绝状态。
 const result=await executor.execute({taskId:task.id,generation:1,tabId:7,action:'frame_catalog',allowedOrigins:task.allowedOrigins});
 assert.equal(result.frames[0].origin,'https://child.test');
 assert.equal(result.frames[0].access,'origin_denied');
 assert.equal(result.frames[0].frameToken,undefined);
 assert.equal(result.coverage.complete,false);
});

test('nested frame token validates every ancestor before use',async()=>{
 const {api,task,scrolls,setChildLoader}=fixture(true,{nested:true}),executor=new Executor(api);
 await executor.approve(task);
 const request={taskId:task.id,generation:1,tabId:7,action:'frame_catalog',allowedOrigins:task.allowedOrigins};
 const catalog=await executor.execute(request);
 const child=catalog.frames.find(row=>row.origin==='https://child.test');
 const deep=catalog.frames.find(row=>row.origin==='https://deep.test');
 assert.equal(child?.access,'ready');assert.equal(deep?.access,'ready');
 assert.equal(deep.parentFrameToken,child.frameToken);
 const local=executor.tasks.get(task.id),tree=(await api.debugger.sendCommand({tabId:7},'Page.getFrameTree')).frameTree;
 const resolved=await executor.resolveFrame(local,{tabId:7,frameToken:deep.frameToken},tree,()=>{});
 assert.equal(resolved.target.sessionId,'deep-session');
 await executor.scrollFrameChain(local,{tabId:7,frameToken:deep.frameToken},resolved,tree,()=>{});
 assert.deepEqual(scrolls,[[null,9],['child-session',10]]);
 // 中文注释：父文档改代后，子文档即使尚未变化也不得复用旧引用。
 setChildLoader('child-document-2');
 await assert.rejects(executor.resolveFrame(local,{tabId:7,frameToken:deep.frameToken},tree,()=>{}),/FRAME_TOKEN_STALE/);
 const next=await executor.execute(request);
 assert.notEqual(next.frames.find(row=>row.origin==='https://deep.test').frameToken,deep.frameToken);
});

// 中文注释：首次发现 OOPIF 后缓存包含子 loader；导航必须重新做完整 DOM 发现。
test('capture cache detects child document changes and still inspects sensitive data',async()=>{
 const f=fixture(),executor=new Executor(f.api);await executor.approve(f.task);
 const task=executor.tasks.get(f.task.id),send=f.api.debugger.sendCommand;let documents=0,inspections=0,sensitive=false;
 f.api.debugger.sendCommand=async(target,method,params={})=>{
  if(method==='DOM.getDocument')documents++;
  if(method==='Page.createIsolatedWorld')return {executionContextId:17};
  if(method==='Runtime.callFunctionOn'){inspections++;return {result:{value:{hasSensitiveValue:sensitive}}};}
  return send(target,method,params);
 };
 const cache={};await executor.assertSafeCapture({tabId:7},task,()=>{},cache);const first=documents;
 await executor.assertSafeCapture({tabId:7},task,()=>{},cache);assert.equal(documents,first);assert.ok(inspections>=4);
 f.setChildLoader('new-document');await executor.assertSafeCapture({tabId:7},task,()=>{},cache);assert.ok(documents>first);
 sensitive=true;await assert.rejects(executor.assertSafeCapture({tabId:7},task,()=>{},cache),/CAPTURE_SENSITIVE_BLOCKED/);
});
