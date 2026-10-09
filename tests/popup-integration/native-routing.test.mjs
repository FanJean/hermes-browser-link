import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {validateShieldRules} from '../../native-extension/content-shield.mjs';
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
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
const root=new URL('../../native-extension/',import.meta.url);
const [html,popup,background]=await Promise.all(['popup.html','popup.mjs','background.mjs'].map(f=>readFile(new URL(f,root),'utf8')));
const clone=v=>structuredClone(v);
const seed=()=>({id:'native-task',generation:3,title:'真实路由测试（合成数据）',state:'pending_approval',activeMode:'smart',modeGeneration:1,tabIds:[],allowedOrigins:['https://example.test']});
async function harness(initialStorage={},manifestVersion=packageVersion){
 let task=seed(),queue=[],receive,dispatch,executor,poll;const nativeCalls=[],popupCalls=[];
 const port={onDisconnect:{addListener(){}},onMessage:{addListener:f=>receive=f},postMessage:m=>{
  nativeCalls.push(clone(m));queueMicrotask(()=>{let result;
   switch(m.method){
    case 'extension.hello':result={};break;
    // 中文注释：弹窗状态复用在线实例清单，夹具只返回脱敏元信息。
    case 'extension.browser_list':result=[];break;
    case 'extension.cdp_events':result={};break;
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
  constructor(_api,_event,options={}){this.options=options;executor=this;this.tasks=new Map();this.leases=new Map();this.actionGrants=new Map();this.attached=new Set();this.diagnostics=new DiagnosticEventBuffer();}
  async approve(t){this.tasks.set(t.id,{...t,policy:{activeMode:'smart',modeGeneration:t.modeGeneration}});for(const id of t.tabIds)this.leases.set(id,t.id);}
  revokeMode(id){this.tasks.get(id).policy.activeMode='smart';}
  setMode(t){this.tasks.get(t.id).policy={activeMode:t.activeMode,modeGeneration:t.modeGeneration};}
  approveAction(a){this.actionGrants.set(a.nonce,a);}
  async release({taskId}){const t=this.tasks.get(taskId);if(t){t.revoked=true;t.policy.activeMode='smart';}}
  async disconnect(){}
 }
 class TestWorkspaces{constructor(){this.manager={reconcile:async()=>{}};}async status(){return [];}}
 const event={addListener(){}};const storage=clone(initialStorage);const api={
  runtime:{id:'test',getManifest:()=>({version:manifestVersion}),onMessage:{addListener:f=>dispatch=f},connectNative:()=>port,sendMessage:async()=>({})},
  storage:{session:{get:async()=>({instanceId:'test-instance'}),set:async()=>{}},local:{get:async()=>clone(storage),set:async v=>Object.assign(storage,v)}},
  notifications:{onClicked:event},
  alarms:{create(){},onAlarm:event},tabs:{onCreated:event,onRemoved:event,onUpdated:event,query:async()=>[{id:7,url:'https://example.test/work',title:'工作页'}],get:async()=>({id:7,url:'https://example.test/work'})},debugger:{onDetach:event}
 };
 // Only ES module linking is replaced. The background handler body is unchanged.
 vm.runInNewContext(background.replace(/^import .*;\n/gm,''),{CloudLink,validateShieldRules,CookieMirror,Executor:TestExecutor,NativeWorkspaces:TestWorkspaces,Bridge,BrowserConsent,isUiSender,registerWorkspaceStartup:()=>{},origin:u=>new URL(u).origin,chrome:api,navigator:{userAgent:'Node DOM harness'},crypto:globalThis.crypto,console});
 const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};await flush();
 const sender={id:'test',url:'chrome-extension://test/popup.html'};
 const send=m=>new Promise(resolve=>{popupCalls.push(clone(m));assert.equal(dispatch(m,sender,resolve),true);});
 const dom=new JSDOM(html,{url:sender.url,runScripts:'outside-only',pretendToBeVisual:true});
 dom.window.chrome={tabs:api.tabs,runtime:{getManifest:api.runtime.getManifest,sendMessage:send,onMessage:{addListener(){}}}};dom.window.setInterval=f=>{poll=f;return 1;};dom.window.clearInterval=()=>{};
 dom.window.eval(popup);await flush();
 const d=dom.window.document;
 const click=async selector=>{const b=d.querySelector(selector);assert.ok(b,selector);assert.equal(b.disabled,false,selector);b.click();await flush();};
 return {dom,d,click,send,flush,storage,api,poll:async()=>{await poll();await flush();},nativeCalls,popupCalls,dispatch,executor,queue:(nonce='nonce-real-routing')=>{queue=[{taskId:task.id,nonce,digest:'digest-real-routing',request:{action:'click',tabId:7,selector:'#save'}}];},reset:()=>{task={...seed(),generation:4};executor.tasks.clear();executor.leases.clear();}};
}
test('握手与弹窗状态读取浏览器 manifest，而非源码版本常量',async()=>{
 const parts=packageVersion.split('.').map(BigInt),version=`${parts[0]}.${parts[1]}.${parts[2]+1n}`;
 const h=await harness({},version);
 assert.equal(h.nativeCalls.find(m=>m.method==='extension.hello').params.version,version);
 assert.equal((await h.send({type:'popup_status'})).result.version,version);
 assert.equal(h.d.querySelector('#version-label').textContent,`v${version}`);
 h.dom.window.close();
});

test('browser identity survives sessions and obsolete smart preference cannot require another grant',async()=>{
 const old=await harness({preferredMode:'smart',browserFullConsent:{version:1,enabled:false},browserInstanceId:'durable-instance'});
 assert.equal(old.nativeCalls.find(m=>m.method==='extension.hello').params.instanceId,'durable-instance');
 assert.equal(old.nativeCalls.some(m=>m.method==='extension.approve'),true);
 assert.equal(old.executor.tasks.get('native-task').policy.activeMode,'full');
 const restored=await harness({browserFullConsent:{version:1,enabled:true},browserInstanceId:'durable-instance'});
 assert.equal(restored.executor.tasks.get('native-task').policy.activeMode,'full');
});

test('connected task is full-only without selecting user tabs or a mode confirmation',async()=>{
 const h=await harness();
 assert.equal(h.nativeCalls.some(x=>x.method==='extension.approve'),true);
 const approval=h.nativeCalls.find(x=>x.method==='extension.approve');
 assert.deepEqual(approval.params.tabIds,[]);assert.equal(approval.params.workspaceOnly,true);
 assert.equal(Object.hasOwn(approval.params,'apiBridgeApproved'),false);
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'full');
 const status=await h.send({type:'status'});assert.equal(status.result.browserFullConsent,true);
 assert.equal(h.d.querySelector('#access-toggle,#confirm-enable'),null);
 assert.equal((await h.send({type:'browser_consent',enabled:false})).error,'不支持的操作');
 assert.equal((await h.send({type:'mode',taskId:'native-task',mode:'smart'})).error,'不支持的操作');
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'full');
 assert.equal((await h.send({type:'status'})).result.browserFullConsent,true);
 assert.equal(h.dispatch({type:'browser_consent',enabled:true},{id:'test',url:'https://evil.test'},()=>assert.fail()),false);
});

test('popup exposes connection status without mode switch; foreign senders cannot change authorization',async()=>{
 const h=await harness();
 assert.match(h.d.querySelector('#connection-label').textContent,/已连接/);
 assert.equal(h.d.querySelector('#tasks'),null);
 assert.equal(h.d.querySelector('#diagnostics'),null);
 assert.equal(h.d.querySelector('#access-toggle'),null);
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'test',url:'chrome-extension://test/other.html'},()=>assert.fail('foreign sender accepted')),false);
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'foreign',url:'chrome-extension://test/popup.html'},()=>assert.fail('foreign extension accepted')),false);
});

// 中文注释：使用真实后台消息处理器验证受信配置、持久化读回及恶意发起者拒绝。
test('指定屏蔽区域只接受受信 popup，校验 origin 与选择器并读回',async()=>{
 const h=await harness();
 const rules={'https://example.test':['#notice','main > .private']};
 assert.deepEqual((await h.send({type:'page_content_shield_save',rules})).result.rules,rules);
 assert.deepEqual((await h.send({type:'page_content_shield_read'})).result.rules,rules);
 for(const bad of [{'https://example.test/path':['#notice']},{'https://example.test':['[']}])assert.ok((await h.send({type:'page_content_shield_save',rules:bad})).error);
 for(const sender of [{id:'test',url:'https://example.test/'},{id:'other',url:'chrome-extension://test/popup.html'},{id:'test',url:'chrome-extension://test/approval-panel.html'}])assert.equal(h.dispatch({type:'page_content_shield_save',rules},sender,()=>assert.fail('非法 sender')),false);
 h.dom.window.close();
});
// 中文注释：真实后台路由对应的弹窗不再展示额外区域、鼠标开关或 Cookie 镜像。
test('生产弹窗仅提供自动屏蔽，右上角展示本扩展版本',async()=>{
 const h=await harness();
 assert.equal(h.d.querySelector('#shield-settings,#cursor-toggle,#cookie-mirror'),null);
 assert.equal(h.d.querySelector('#version-label').textContent,`v${packageVersion}`);
 await h.click('#filter-toggle');assert.equal(h.storage.pageContentFilter,true);
 assert.equal(h.popupCalls.some(row=>row.type==='visual_cursor'||row.type==='cookie_mirror_pending'||row.type.startsWith('page_content_shield')),false);h.dom.window.close();
});

test('配置读取失败和保存读回不一致不能显示成功',async()=>{
 const h=await harness();h.api.storage.local.get=async()=>{throw Error('合成读失败');};
 assert.ok((await h.send({type:'page_content_shield_read'})).error);
 assert.ok((await h.send({type:'page_content_shield_save',rules:{'https://example.test':['#notice']}})).error);
 h.api.storage.local.get=async()=>({pageContentShieldRules:{}});
 assert.ok((await h.send({type:'page_content_shield_save',rules:{'https://example.test':['#notice']}})).error);h.dom.window.close();
});
test('已建立的原始 CDP 订阅遵循当前过滤开关，读取失败不推送',async()=>{
 const h=await harness();let count=h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length;
 h.storage.pageContentFilter=true;await h.executor.options.onCdpEvents({events:[{text:'原始事件正文'}]});
 assert.equal(h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length,count);
 h.storage.pageContentFilter=false;await h.executor.options.onCdpEvents({events:[]});count++;
 assert.equal(h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length,count);
 h.api.storage.local.get=async()=>{throw Error('读失败');};await h.executor.options.onCdpEvents({events:[{text:'原始事件正文'}]});
 assert.equal(h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length,count);h.dom.window.close();
});

// 中文注释：损坏设置不能让发送边界把过滤当作关闭，也不能推送原始订阅事件。
for(const storage of [{pageContentFilter:'true'},{pageContentFilter:false,pageContentShieldRules:{'https://example.test':['[']}}])test('损坏设置禁止公开过滤状态和原始事件',async()=>{
 const h=await harness(storage);
 assert.ok((await h.send({type:'popup_status'})).error);
 let pushed=h.nativeCalls.filter(row=>row.method==='extension.cdp_events').length;
 await h.executor.options.onCdpEvents({events:[{text:'RAW_CORRUPT_SETTINGS_CANARY'}]});
 assert.equal(h.nativeCalls.filter(row=>row.method==='extension.cdp_events').length,pushed);
 h.dom.window.close();
});
