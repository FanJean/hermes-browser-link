import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {trustedTask} from '../native-extension/workspace-fixture.mjs';
import {withSyntheticOverlay} from '../native-extension/overlay-fixture.mjs';

const png=()=>{const b=Buffer.alloc(44);b.writeUInt32BE(100,16);b.writeUInt32BE(80,20);return b.toString('base64');};
function fixture(){
 const commands=[];
 let entered,release;
 const moved=new Promise(resolve=>entered=resolve);
 const hold=new Promise(resolve=>release=resolve);
 const state={token:'d',revision:0,url:'https://example.com/page',viewport:{width:100,height:80},dpr:1,scroll:{x:0,y:0},visual:{scale:1,x:0,y:0}};
 const listeners=new Set();
 // 中文注释：合成标签实现活动状态切换，保证在途写入测试覆盖真实前置调用。
 const api={tabs:{query:async()=>[await api.tabs.get(1)],get:async id=>({id,url:state.url,windowId:1,groupId:-1}),update:async()=>({active:true})},debugger:{
  onDetach:{addListener:x=>listeners.add(x),removeListener:x=>listeners.delete(x)},
  onEvent:{addListener:x=>listeners.add(x),removeListener:x=>listeners.delete(x)},
  attach:async()=>{},detach:async()=>{},
  sendCommand:async(_target,method,p={})=>{
   commands.push(method);
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'loader',url:state.url}}};
   if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
   if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
   if(method==='Page.createIsolatedWorld')return {executionContextId:11};
   if(method==='Page.captureScreenshot')return {data:png()};
   if(method==='Runtime.callFunctionOn')return {result:{value:p.objectId?false:{hasSensitiveValue:false}}};
   if(method==='Runtime.evaluate'){
    const e=p.expression||'';
    if(e.includes(')("state"'))return {result:{value:{...state}}};
    if(e.includes(')("bounds"'))return {result:{value:{ref:'ref',rect:{x:10,y:10,width:20,height:10}}}};
    if(e.includes(')("check"'))return {result:{value:{ok:true}}};
   }
   if(method==='DOM.getNodeForLocation')return {backendNodeId:1};
   if(method==='DOM.resolveNode')return {object:{objectId:'object'}};
   if(method==='Input.dispatchMouseEvent'&&p.type==='mouseMoved'){entered();await hold;return {};}
   return {};
  }}};
 api.debugger=withSyntheticOverlay(api.debugger);
 return {api,commands,moved,release:()=>release()};
}

test('revoking mode while hover is pending prevents coordinate click press',async()=>{
 const f=fixture(),executor=new Executor(f.api);
 await executor.approve({...trustedTask('task-v2',[7]),generation:4,instanceId:'instance-v2'});
 executor.setMode({id:'task-v2',generation:4,instanceId:'instance-v2',approvalScope:'fixture-owner-task-v2',modeGeneration:2,activeMode:'full'});
 const common={taskId:'task-v2',generation:4,modeGeneration:2,tabId:7,allowedOrigins:['https://example.com']};
 const shot=await executor.execute({...common,action:'interaction.capture'});
 const bound=await executor.execute({...common,action:'interaction.bounds',screenshotId:shot.id,selector:'#button'});
 const click=executor.execute({...common,action:'interaction.click',screenshotId:shot.id,point:bound.imageCenter,expectedRef:bound.ref});
 await f.moved;
 executor.revokeMode('task-v2');f.release();
 await assert.rejects(click,/mode revoked/);
 assert.equal(f.commands.filter(x=>x==='Input.dispatchMouseEvent').length,1);
});
