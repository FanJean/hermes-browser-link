import {CloudLink} from '../support/cloud-link-stub.mjs';
// Synthetic native port + production background/Bridge/notifier. No browser launch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
import {Bridge,BrowserConsent,isUiSender} from '../../native-extension/bridge.mjs';
import {createApprovalNotifier} from '../../native-extension/approval-notifier.mjs';
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
const background=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
const clone=x=>structuredClone(x);
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function harness({focusFails=false,browserFullConsent=false,decideFails=false,cookieData=[]}={}){
 const now=Date.now(),nativeCalls=[],focusCalls=[],windowCalls=[],badge=[],listeners={};let receiver,disconnect,windowRemoved,task={id:'task-A',instanceId:'instance-A',generation:2,modeGeneration:1,state:'ready',activeMode:'smart',title:'整理资料',tabIds:[7],allowedOrigins:['https://example.test']};
 let approvals=[{taskId:'task-A',nonce:'nonce-1',digest:'digest-1',generation:2,modeGeneration:1,expiresAt:now/1000+60,request:{action:'click',tabId:7,selector:'#save'}}];
 let tab={id:7,windowId:12,url:'https://example.test/work'},panelTab=null,created=0,executor;
 const port={onDisconnect:{addListener:f=>disconnect=f},onMessage:{addListener:f=>receiver=f},postMessage:m=>{nativeCalls.push(clone(m));if(!m.method)return;queueMicrotask(()=>{let result;
  switch(m.method){case 'extension.cookie_mirror.status':result={status:'approval_required'};break;case 'extension.cookie_mirror.decide':result={status:m.params.approve?'executing':'denied'};break;case 'extension.hello':result={};break;case 'extension.tasks':result=[clone(task)];break;case 'extension.approvals':result=clone(approvals);break;
   case 'extension.decide':if(decideFails){receiver({id:m.id,error:{message:'native response unavailable'}});return;}approvals=[];result={status:m.params.approve?'approved':'denied'};break;
   case 'extension.stop':task.state='cancelled';result=clone(task);break;
   default:throw Error('unexpected native '+m.method);
  }receiver({id:m.id,result});});}};
 class ExecutorFake{
  // 中文注释：本夹具不创建页面浮层，握手清理能力由专项 DOM 回归覆盖。
  async cleanupOrphanOverlays(){}
  constructor(){executor=this;this.tasks=new Map([['task-A',{...task,policy:{activeMode:'smart',modeGeneration:1},revoked:false}]]);this.leases=new Map([[7,'task-A']]);this.actionGrants=new Map();this.attached=new Set();this.diagnostics={size:0,recordSafely(){},exportBundle(){return {};}};}
  approveAction(a){this.actionGrants.set(a.nonce,clone(a));} revokeMode(id){this.tasks.get(id).policy.activeMode='smart';} setMode(t){this.tasks.get(t.id).policy.activeMode=t.activeMode;}
  async release(){this.tasks.get('task-A').revoked=true;}async disconnect(){this.tasks.get('task-A').revoked=true;this.actionGrants.clear();}
 }
 class WorkspaceFake{constructor(){this.manager={reconcile:async()=>{}};}async status(){return [];}}
 const local={browserInstanceId:'instance-A',browserFullConsent:{version:1,enabled:browserFullConsent}};
 // 中文注释：通知回调在后台顶层注册，离线模拟点击只允许聚焦。
 const chrome={notifications:{onClicked:{addListener:f=>listeners.notification=f},create:async()=>{},clear:async()=>true},cookies:{getAll:async()=>clone(cookieData)},runtime:{getManifest:()=>({version:packageVersion}),id:'ext-123',getURL:p=>`chrome-extension://ext-123/${p}`,onMessage:{addListener:f=>listeners.message=f},connectNative:()=>port,sendMessage:async()=>{}},
  storage:{local:{get:async()=>clone(local),set:async x=>Object.assign(local,x)},session:{get:async()=>({instanceId:'instance-A'}),set:async()=>{}}},
  alarms:{create(){},onAlarm:{addListener:f=>listeners.alarm=f}},
  tabs:{get:async id=>id===7?clone(tab):id===panelTab?.id?clone(panelTab):null,query:async()=>[clone(tab)],onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
  windows:{getLastFocused:async()=>({id:12}),onRemoved:{addListener:f=>windowRemoved=f},get:async id=>({id,left:100,top:40,width:1000,height:800,type:'normal'}),update:async(id,p)=>{focusCalls.push([id,p]);if(focusFails)throw Error('focus failed');return {id,focused:true};},create:async p=>{windowCalls.push(p);panelTab={id:400+(++created),windowId:90+created,url:p.url};return {id:panelTab.windowId,tabs:[panelTab],focused:true};},remove:async()=>{}},
  action:{setBadgeText:async p=>badge.push(p.text),setTitle:async()=>{}},debugger:{onDetach:{addListener(){}}}};
 vm.runInNewContext(background.replace(/^import .*;\n/gm,''),{CloudLink,validateShieldRules,reloadForInstalledBuild:async()=>false,BUILD_ID:'',registerWorkspaceStartup:()=>{},NativeWorkspaces:WorkspaceFake,Executor:ExecutorFake,CookieMirror,Bridge,BrowserConsent,isUiSender,createApprovalNotifier,origin:u=>new URL(u).origin,chrome,crypto:globalThis.crypto,navigator:{userAgent:'Node'},console,setTimeout,clearTimeout});
 const sender=()=>({id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:panelTab?.id,windowId:panelTab?.windowId}});
 const message=(m,s=sender())=>new Promise(resolve=>{const yes=listeners.message(m,s,resolve);if(!yes)resolve({ignored:true});});
 return {sendNative:m=>receiver(m),tick,message,sender,nativeCalls,focusCalls,windowCalls,badge,notification:id=>listeners.notification(id),disconnect:()=>disconnect?.(),windowRemoved:()=>windowRemoved?.(panelTab?.windowId),setApprovals:x=>approvals=x,setTask:x=>task={...task,...x},setTab:x=>tab={...tab,...x},executor:()=>executor,changed:()=>receiver({method:'tasks.changed'}),chrome};
}

test('host pending action produces one centered trusted panel and dedupes changed snapshots',async()=>{
 const h=harness();await h.tick();assert.equal(h.focusCalls.length,1);assert.equal(h.windowCalls[0].url,'chrome-extension://ext-123/approval-panel.html');
 h.changed();h.changed();await h.tick();assert.equal(h.focusCalls.length,1);
 const view=await h.message({type:'approval_panel_view'});assert.equal(view.result.origin,'https://example.test');assert.equal(view.result.scope,'本次操作');assert.equal(view.result.action,'点击页面 · #save');
 assert.equal((await h.message({type:'approval_panel_view'},{id:'ext-123',url:'chrome-extension://ext-123/popup.html'})).ignored,true);
});
test('forged popup/page/model cannot decide panel; live nonce and mode must remain valid',async()=>{
 const h=harness();await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 assert.equal((await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'},{id:'ext-123',url:'chrome-extension://ext-123/popup.html'})).ignored,true);
 h.setTask({modeGeneration:2});const result=await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'});assert.match(result.error,/失效|stale|scope/);
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,0);assert.equal(h.executor().actionGrants.size,0);
});
test('trusted decision installs one-shot grant and host readback; repeated decision never replays',async()=>{
 const h=harness();await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 const reply=await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'});assert.equal(reply.result.decision,'approve');
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,1);assert.equal(h.executor().actionGrants.size,1);
 const repeat=await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'});assert.ok(repeat.error||repeat.ignored);
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,1);
});
test('reject and later preserve existing semantics, expiry and close do not approve',async()=>{
 const h=harness();await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 assert.equal((await h.message({type:'approval_panel_decision',requestId:id,decision:'later'})).result.decision,'later');
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,0);
 h.setApprovals([]);h.changed();await h.tick();assert.equal(h.badge.at(-1),'');
});
test('focus failure keeps the panel and badge; disconnect clears pending',async()=>{
 const h=harness({focusFails:true});await h.tick();assert.equal(h.windowCalls.length,1);assert.equal(h.badge.at(-1),'1');
 h.disconnect();await h.tick();assert.equal(h.badge.at(-1),'');
});
test('full access and foreign tab cannot spawn an action approval panel',async()=>{
 const full=harness({browserFullConsent:true});full.setTask({activeMode:'full'});await full.tick();assert.equal(full.windowCalls.length,0);
 const foreign=harness();foreign.setTab({url:'https://other.test/'});await foreign.tick();assert.equal(foreign.windowCalls.length,0);
});
test('host denial uses old one-time decision route without creating a grant',async()=>{
 const h=harness();await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 assert.equal((await h.message({type:'approval_panel_decision',requestId:id,decision:'reject'})).result.decision,'reject');
 const decision=h.nativeCalls.find(x=>x.method==='extension.decide');assert.equal(decision.params.approve,false);
 assert.equal(h.executor().actionGrants.size,0);assert.equal(h.badge.at(-1),'');
});
test('lost decision result is unknown and never dispatched a second time',async()=>{
 const h=harness({decideFails:true});await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 assert.match((await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'})).error,/unavailable/);
 assert.equal(h.executor().actionGrants.size,0);h.changed();await h.tick();assert.equal(h.badge.at(-1),'!');
 assert.equal((await h.message({type:'approval_panel_decision',requestId:id,decision:'approve'})).ignored,true);
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,1);
});
test('host revocation removes the panel; a closed panel never auto-refocuses',async()=>{
 const h=harness();await h.tick();h.setApprovals([]);h.changed();await h.tick();
 assert.equal(h.badge.at(-1),'');assert.equal((await h.message({type:'approval_panel_view'})).ignored,true);
 const closed=harness();await closed.tick();closed.windowRemoved();await closed.tick();closed.changed();await closed.tick();
 assert.equal(closed.focusCalls.length,1);
});
test('approval panel cannot take over stop or persistent-mode permissions',async()=>{
 const h=harness();await h.tick();const id=(await h.message({type:'approval_panel_view'})).result.id;
 const malformed=await h.message({type:'approval_panel_decision',requestId:id,decision:'stop'});
 assert.match(malformed.error,/decision/);
 assert.equal((await h.message({type:'stop',taskId:'task-A'})).ignored,true);
 assert.equal((await h.message({type:'mode',taskId:'task-A',mode:'full'})).ignored,true);
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.stop'||x.method==='extension.mode').length,0);
});
test('host task with another browser identity is not presented or approved',async()=>{
 const h=harness();h.setTask({instanceId:'other-browser'});await h.tick();
 assert.equal(h.windowCalls.length,0);
 assert.equal(h.nativeCalls.filter(x=>x.method==='extension.decide').length,0);
});
test('card shows a bounded target but never the content being filled',async()=>{
 const h=harness();h.setApprovals([{taskId:'task-A',nonce:'fill-once',digest:'fill-digest',generation:2,modeGeneration:1,expiresAt:Date.now()/1000+60,request:{action:'fill',tabId:7,selector:'#draft',text:'DO-NOT-SHOW-SECRET'}}]);await h.tick();
 const view=(await h.message({type:'approval_panel_view'})).result;
 assert.match(view.action,/#draft/);assert.doesNotMatch(JSON.stringify(view),/DO-NOT-SHOW-SECRET/);
});

// 中文注释：验证真实后台消息路由，不允许网页或审批面板修改持久化过滤偏好。
test('only trusted popup can persist the independent content filter setting',async()=>{
 const h=harness();await h.tick();
 const popup={id:'ext-123',url:'chrome-extension://ext-123/popup.html'};
 for(const sender of [{id:'ext-123',url:'https://example.test/'},{id:'other',url:popup.url},h.sender()]){
  assert.equal((await h.message({type:'page_content_filter',enabled:true},sender)).ignored,true);
 }
 assert.equal((await h.chrome.storage.local.get()).pageContentFilter,undefined);
 assert.equal((await h.message({type:'page_content_filter',enabled:'true'},popup)).error,'无效的过滤设置');
 assert.equal((await h.message({type:'page_content_filter',enabled:true},popup)).result.enabled,true);
 assert.equal((await h.chrome.storage.local.get()).pageContentFilter,true);
 assert.equal((await h.chrome.storage.local.get()).browserFullConsent.enabled,false);
 assert.equal((await h.message({type:'page_content_filter',enabled:false},popup)).result.enabled,false);
 h.chrome.storage.local.set=async()=>{throw Error('storage failed');};
 assert.equal((await h.message({type:'page_content_filter',enabled:true},popup)).error,'storage failed');
 assert.equal((await h.chrome.storage.local.get()).pageContentFilter,false);
});

// 中文注释：生产后台在全部访问中仍只认源扩展面板，native 取块不能绕过人工批准。
test('Cookie mirror requires trusted source panel even in full access',async()=>{
 const secret=['SECRET','COOKIE','VALUE','xyz'].join('_'),transferId='c'.repeat(32);
 const h=harness({browserFullConsent:true,cookieData:[{name:'login',domain:'example.test',path:'/',httpOnly:true,secure:true,session:true,hostOnly:true,sameSite:'lax',value:secret}]});
 h.setTask({activeMode:'full'});await h.tick();
 h.sendNative({id:'srv:'+'1'.repeat(32),method:'browser.cookie_mirror.prepare',params:{transferId,expiresAt:Date.now()+60000,sites:['example.test'],options:{},source:{browser:'chrome',instanceId:'instance-A'},target:{browser:'edge',instanceId:'instance-B'}}});
 await h.tick();
 const view=(await h.message({type:'approval_panel_view'})).result;
 assert.equal(view.kind,'cookie_mirror');assert.equal(view.count,1);assert.equal(view.source.browser,'chrome');assert.equal(view.target.browser,'edge');assert.ok(!JSON.stringify(view).includes(secret));
 // 中文注释：关闭面板后只能通过可信弹窗打开原请求，不能派发复制或批准。
 const popup={id:'ext-123',url:'chrome-extension://ext-123/popup.html'};
 h.windowRemoved();await h.tick();
 assert.equal((await h.message({type:'cookie_mirror_pending'},{id:'ext-123',url:'https://example.test'})).ignored,true);
 assert.equal((await h.message({type:'cookie_mirror_pending'},popup)).result.opened,true);
 assert.equal((await h.message({type:'approval_panel_view'})).result.id,transferId);
 for(const type of ['cookie_mirror_sites','cookie_mirror_request','cookie_mirror_status'])assert.ok((await h.message({type},popup)).error);
 assert.equal(h.nativeCalls.some(m=>m.method==='extension.cookie_mirror.request'),false);
 assert.equal(h.nativeCalls.some(m=>m.method==='extension.cookie_mirror.decide'),false);
 h.sendNative({id:'srv:'+'2'.repeat(32),method:'browser.cookie_mirror.take',params:{transferId,index:0}});await h.tick();assert.equal(h.nativeCalls.find(m=>m.id==='srv:'+'2'.repeat(32)).error.code,'cookie_mirror_denied');
 assert.equal((await h.message({type:'approval_panel_decision',requestId:transferId,decision:'approve'},{id:'ext-123',url:'https://example.test'})).ignored,true);
 assert.equal((await h.message({type:'approval_panel_decision',requestId:transferId,decision:'approve'})).result.decision,'approve');
 h.sendNative({id:'srv:'+'3'.repeat(32),method:'browser.cookie_mirror.take',params:{transferId,index:0}});await h.tick();assert.equal(h.nativeCalls.find(m=>m.id==='srv:'+'3'.repeat(32)).result.cookies[0].value,secret);
 h.disconnect();await h.tick();
 assert.equal((await h.message({type:'cookie_mirror_pending'},popup)).result.opened,false);
});

// 中文注释：覆盖 service worker 真实注册的通知入口，不通过面板决定消息替代点击。
test('system notification event focuses the pending panel without dispatching approval',async()=>{
 const h=harness({focusFails:true});await h.tick();const before=h.nativeCalls.filter(m=>m.method==='extension.action_decision').length;
 h.chrome.windows.update=async(id)=>{h.focusCalls.push([id,{focused:true}]);return {id,focused:true};};
 h.notification('hermes-browser-approval');await h.tick();
 assert.equal(h.focusCalls.at(-1)[0],h.sender().tab.windowId);
 assert.equal(h.nativeCalls.filter(m=>m.method==='extension.action_decision').length,before);
 assert.ok((await h.message({type:'approval_panel_view'})).result);
});
// 中文注释：VM 只替换模块链接，完整设置校验仍复用生产实现。
import {validateShieldRules} from '../../native-extension/content-shield.mjs';
