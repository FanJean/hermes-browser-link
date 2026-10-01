// Synthetic Chrome debugger and native-extension dispatcher; no browser starts.
import readline from 'node:readline';
import {Executor} from '../../native-extension/core.mjs';
import {trustedTask} from '../native-extension/workspace-fixture.mjs';
import {withSyntheticOverlay} from '../native-extension/overlay-fixture.mjs';
const png=(w,h)=>{const b=Buffer.alloc(44);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b.toString('base64');};
const realNow=performance.now.bind(performance);let clockAdvance=0;
Object.defineProperty(performance,'now',{value:()=>realNow()+clockAdvance});
const state={token:'document-token',revision:0,url:'https://example.com/page',visibility:'visible',viewport:{width:100,height:80},dpr:1,scroll:{x:0,y:0},visual:{scale:1,x:0,y:0}};
const commands=[];let sensitive=false, blocked=false;
const listeners=new Set();
// 中文注释：合成扩展实现任务标签激活，以覆盖高亮前的真实调用顺序。
const api={tabs:{get:async id=>({id,url:state.url,windowId:7,groupId:-1}),update:async()=>({active:true}),remove:async()=>{}},
 debugger:{onDetach:{addListener:l=>listeners.add(l),removeListener:l=>listeners.delete(l)},attach:async()=>{},detach:async()=>{},
 sendCommand:async(target,method,p={})=>{
  commands.push({tabId:target.tabId,method,params:p});
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'loader',url:state.url}}};
  if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
  if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
  if(method==='Page.createIsolatedWorld')return {executionContextId:11};
  if(method==='Page.captureScreenshot')return {data:png(100,80)};
  if(method==='Runtime.callFunctionOn')return {result:{value:p.objectId?false:p.functionDeclaration?.includes('function inspectPage')?{hasSensitiveValue:sensitive}:{ok:true}}};
  if(method==='Runtime.evaluate'){
   const expr=p.expression||'';
   if(expr.includes(')("state"'))return {result:{value:{...state}}};
   if(expr.includes(')("bounds"'))return {result:{value:{ref:'node-ref',rect:{x:10,y:10,width:20,height:10}}}};
   if(expr.includes(')("check"'))return {result:{value:blocked?{error:'SENSITIVE_TARGET'}:{ok:true}}};
   // 中文注释：公共协议夹具模拟页面目标收到可信 click 和完整拖动端点事件。
   if(expr.includes(')("probe"'))return {result:{value:{global:{pointerdown:1,mousedown:1,click:1,pointerup:1},target:{pointerdown:1,trustedClick:1}}}};
   if(expr.includes(')("arm-probe"')||expr.includes(')("clear-probe"'))return {result:{value:{ok:true}}};
   if(expr.includes(')("html5"'))return {result:{value:{ok:true,kind:'html5-synthetic',trusted:false}}};
  }
  if(method==='DOM.getNodeForLocation')return {backendNodeId:1};
  if(method==='DOM.resolveNode')return {object:{objectId:'obj'}};
  if(method==='Runtime.releaseObject')return {};
  if(method==='Input.dispatchMouseEvent'||method==='Input.cancelDragging')return {};
  throw Error('unexpected synthetic CDP '+method);
 }}};
api.debugger=withSyntheticOverlay(api.debugger);
const executor=new Executor(api);
await executor.approve({...trustedTask('task-v2',[7]),generation:4,instanceId:'instance-v2'});
const rl=readline.createInterface({input:process.stdin});
for await(const line of rl){
 try{
  const msg=JSON.parse(line);
  let result;
  if(msg.method==='control'){
   if(msg.op==='full')executor.setMode({id:'task-v2',generation:4,instanceId:'instance-v2',approvalScope:'fixture-owner-task-v2',modeGeneration:2,activeMode:'full'});
   if(msg.op==='revoke')executor.revokeMode('task-v2');
   if(msg.op==='approve')executor.approveAction(msg.value);
   if(msg.op==='sensitive')sensitive=msg.value;
   if(msg.op==='blocked')blocked=msg.value;
   if(msg.op==='revision')state.revision++;
   if(msg.op==='origin')state.url='https://evil.test/page';
   if(msg.op==='generation')executor.tasks.get('task-v2').generation++;
   if(msg.op==='advance')clockAdvance+=msg.value;
   result={commands:commands.filter(c=>c.method.startsWith('Input.')).length};
  }else if(msg.method==='browser.execute')result=await executor.execute(msg.params);
  else throw Error('unsupported method');
  process.stdout.write(JSON.stringify({id:msg.id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({id:JSON.parse(line).id,error:{code:e.code||e.message,message:'synthetic extension rejected',data:{outcomeUnknown:true}}})+'\n');}
}
