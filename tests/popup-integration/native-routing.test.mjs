// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
// Real popup -> real background dispatcher -> real Bridge request envelope.
// Browser/Executor and daemon replies are in-memory doubles; NO browser or host starts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {Bridge,isUiSender,BrowserConsent} from '../../native-extension/bridge.mjs';
import {DiagnosticEventBuffer} from '../../browser-diagnostics/js/diagnostics.mjs';
const root=new URL('../../native-extension/',import.meta.url);
const [html,popup,background]=await Promise.all(['popup.html','popup.mjs','background.mjs'].map(f=>readFile(new URL(f,root),'utf8')));
const clone=v=>structuredClone(v);
const seed=()=>({id:'native-task',generation:3,title:'真实路由测试（合成数据）',state:'pending_approval',activeMode:'smart',modeGeneration:1,tabIds:[],allowedOrigins:['https://example.test']});
async function harness(initialStorage={}){
 let task=seed(),queue=[],receive,dispatch,executor,poll;const nativeCalls=[],popupCalls=[];
 const port={onDisconnect:{addListener(){}},onMessage:{addListener:f=>receive=f},postMessage:m=>{
  nativeCalls.push(clone(m));queueMicrotask(()=>{let result;
   switch(m.method){
    case 'extension.hello':result={};break;
    // 中文注释：弹窗状态复用在线实例清单，夹具只返回脱敏元信息。
    case 'extension.browser_list':result=[];break;
    case 'extension.tasks':result=[clone(task)];break;
    case 'extension.approvals':result=clone(queue);break;
    case 'extension.approve':task={...task,...m.params,state:m.params.workspaceOnly?'authorizing':'ready',id:task.id};result=clone(task);break;
    case 'extension.mode':task={...task,state:'ready',activeMode:m.params.mode,modeGeneration:task.modeGeneration+1};result=clone(task);break;
    case 'extension.decide':queue=[];result={status:'accepted'};break;
    case 'extension.stop':task={...task,state:'cancelled'};result=clone(task);break;
    case 'extension.reject':task={...task,state:'failed'};result=clone(task);break;
    default:throw Error(`unexpected native method ${m.method}`);
   }
   receive({id:m.id,result});
  });
 }};
 class TestExecutor{
  // 中文注释：本夹具不创建页面浮层，握手清理能力由专项 DOM 回归覆盖。
  async cleanupOrphanOverlays(){}
  constructor(){executor=this;this.tasks=new Map();this.leases=new Map();this.actionGrants=new Map();this.attached=new Set();this.diagnostics=new DiagnosticEventBuffer();}
  async approve(t){this.tasks.set(t.id,{...t,policy:{activeMode:'smart',modeGeneration:t.modeGeneration}});for(const id of t.tabIds)this.leases.set(id,t.id);}
  revokeMode(id){this.tasks.get(id).policy.activeMode='smart';}
  setMode(t){this.tasks.get(t.id).policy={activeMode:t.activeMode,modeGeneration:t.modeGeneration};}
  approveAction(a){this.actionGrants.set(a.nonce,a);}
  async release({taskId}){const t=this.tasks.get(taskId);if(t){t.revoked=true;t.policy.activeMode='smart';}}
  async disconnect(){}
 }
 class TestWorkspaces{constructor(){this.manager={reconcile:async()=>{}};}async status(){return [];}}
 const event={addListener(){}};const storage=clone(initialStorage);const api={
  runtime:{id:'test',onMessage:{addListener:f=>dispatch=f},connectNative:()=>port,sendMessage:async()=>({})},
  storage:{session:{get:async()=>({instanceId:'test-instance'}),set:async()=>{}},local:{get:async()=>clone(storage),set:async v=>Object.assign(storage,v)}},
  alarms:{create(){},onAlarm:event},tabs:{onCreated:event,onRemoved:event,onUpdated:event,query:async()=>[{id:7,url:'https://example.test/work',title:'工作页'}],get:async()=>({id:7,url:'https://example.test/work'})},debugger:{onDetach:event}
 };
 // Only ES module linking is replaced. The background handler body is unchanged.
 vm.runInNewContext(background.replace(/^import .*;\n/gm,''),{CookieMirror,Executor:TestExecutor,NativeWorkspaces:TestWorkspaces,Bridge,BrowserConsent,isUiSender,registerWorkspaceStartup:()=>{},origin:u=>new URL(u).origin,chrome:api,navigator:{userAgent:'Node DOM harness'},crypto:globalThis.crypto,console});
 const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};await flush();
 const sender={id:'test',url:'chrome-extension://test/popup.html'};
 const send=m=>new Promise(resolve=>{popupCalls.push(clone(m));assert.equal(dispatch(m,sender,resolve),true);});
 const dom=new JSDOM(html,{url:sender.url,runScripts:'outside-only',pretendToBeVisual:true});
 dom.window.chrome={runtime:{sendMessage:send,onMessage:{addListener(){}}}};dom.window.setInterval=f=>{poll=f;return 1;};dom.window.clearInterval=()=>{};
 dom.window.eval(popup);await flush();
 const d=dom.window.document;
 const click=async selector=>{const b=d.querySelector(selector);assert.ok(b,selector);assert.equal(b.disabled,false,selector);b.click();await flush();};
 return {dom,d,click,send,flush,poll:async()=>{await poll();await flush();},nativeCalls,popupCalls,dispatch,executor,queue:(nonce='nonce-real-routing')=>{queue=[{taskId:task.id,nonce,digest:'digest-real-routing',request:{action:'click',tabId:7,selector:'#save'}}];},reset:()=>{task={...seed(),generation:4};executor.tasks.clear();executor.leases.clear();}};
}
test('browser identity survives sessions while old preference leaves smart as default',async()=>{
 const old=await harness({preferredMode:'full',browserInstanceId:'durable-instance'});
 assert.equal(old.nativeCalls.find(m=>m.method==='extension.hello').params.instanceId,'durable-instance');
 assert.equal(old.nativeCalls.some(m=>m.method==='extension.approve'),true);
 assert.equal(old.executor.tasks.get('native-task').policy.activeMode,'smart');
 const restored=await harness({browserFullConsent:{version:1,enabled:true},browserInstanceId:'durable-instance'});
 assert.equal(restored.executor.tasks.get('native-task').policy.activeMode,'full');
});

test('browser mode UI upgrades tasks without selecting user tabs and returns to smart',async()=>{
 const h=await harness();
 await h.click('#access-toggle');
 assert.equal(h.nativeCalls.some(x=>x.method==='extension.approve'),true);
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'smart');
 await h.click('#confirm-enable');
 const approval=h.nativeCalls.find(x=>x.method==='extension.approve');
 assert.deepEqual(approval.params.tabIds,[]);assert.equal(approval.params.workspaceOnly,true);
 assert.equal(Object.hasOwn(approval.params,'apiBridgeApproved'),false);
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'full');
 const status=await h.send({type:'status'});assert.equal(status.result.browserFullConsent,true);
 await h.click('#access-toggle');
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'smart');
 assert.equal((await h.send({type:'status'})).result.browserFullConsent,false);
 assert.equal(h.dispatch({type:'browser_consent',enabled:true},{id:'test',url:'https://evil.test'},()=>assert.fail()),false);
});

test('popup exposes only status and consent; foreign senders cannot change authorization',async()=>{
 const h=await harness();
 assert.match(h.d.querySelector('#connection-label').textContent,/已连接/);
 assert.equal(h.d.querySelector('#tasks'),null);
 assert.equal(h.d.querySelector('#diagnostics'),null);
 assert.equal(h.d.querySelector('#access-toggle').getAttribute('role'),'switch');
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'test',url:'chrome-extension://test/other.html'},()=>assert.fail('foreign sender accepted')),false);
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'foreign',url:'chrome-extension://test/popup.html'},()=>assert.fail('foreign extension accepted')),false);
});
