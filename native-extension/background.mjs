import {validateShieldRules} from './content-shield.mjs';
import {NativeWorkspaces,registerWorkspaceStartup} from './workspace-adapter.mjs';
// 中文注释：顶层同步注册浏览器启动撤权，不能等 connect 或 ready 完成后注册。
registerWorkspaceStartup(chrome);
import {Executor,origin} from './core.mjs';
import {Bridge,isUiSender,BrowserConsent} from './bridge.mjs';
import {CookieMirror} from './cookie-mirror.mjs';
import {createApprovalNotifier,showPanelNotification,clearPanelNotification} from './approval-notifier.mjs';
let bridge=null,connected=false,connecting=false,lastError='尚未连接本地桥';
let notifier=null,approvalInstance=null,approvalRefresh=Promise.resolve();
let connectedInstanceId=null,connectedGeneration=null;
// 中文注释：发送边界也校验完整设置，不能把损坏的开关或规则当成过滤关闭。
async function readContentFilter(){return (await readContentShield()).enabled;}
// 中文注释：一次读取开关和规则，校验失败不按关闭处理。
async function readContentShield(){
 const value=await chrome.storage.local.get(['pageContentFilter','pageContentShieldRules']);
 if(value.pageContentFilter!==undefined&&typeof value.pageContentFilter!=='boolean')throw Error('CONTENT_SHIELD_UNAVAILABLE');
 return {enabled:value.pageContentFilter===true,rules:validateShieldRules(value.pageContentShieldRules===undefined?{}:value.pageContentShieldRules)};
}
// Hermes asks us to show the authorization management UI. A toolbar popup
// cannot be opened reliably from a background request, so open the same page
// as a centered, focused extension window instead.
const ACCESS_WIDTH=460,ACCESS_HEIGHT=640;
const ACCESS_NOTIFICATION='hermes-browser-access';
let accessWindow=null;
// 中文注释：监听在 service worker 顶层注册；系统通知点击只打开确认 UI，不能授权。
chrome.notifications.onClicked.addListener(id=>{
 if(id===ACCESS_NOTIFICATION){
  const active=accessWindow;if(!active||!connected||bridge!==active.bridge||connectedGeneration!==active.connectionGeneration)return;
  chrome.windows.update(active.windowId,{focused:true}).then(focused=>{
   if(accessWindow!==active)return;active.focusConfirmed=focused?.id===active.windowId&&focused.focused===true;
   if(active.focusConfirmed)void clearPanelNotification(chrome,ACCESS_NOTIFICATION);
  }).catch(()=>{});
 }else void notifier?.notificationClicked(id).catch(()=>{});
});
async function openAccessManagementRequest(request){
 const p=request||{};
 if(!connected||!bridge||p.instanceId!==connectedInstanceId||p.connectionGeneration!==connectedGeneration
  ||typeof p.requestId!=='string'||!p.requestId||typeof chrome.windows?.create!=='function')throw Error('stale or unsupported access request');
 // 中文注释：复用权限窗口；后台聚焦失败不能丢弃已有窗口。
 if(accessWindow){try{const focused=await chrome.windows.update(accessWindow.windowId,{focused:true});accessWindow.focusConfirmed=focused?.id===accessWindow.windowId&&focused.focused===true;}catch{accessWindow.focusConfirmed=false;}}
 if(!accessWindow){
  let target=null;try{target=await chrome.windows.getLastFocused({windowTypes:['normal']});}catch{}
  const options={url:chrome.runtime.getURL('popup.html'),type:'popup',focused:true,width:ACCESS_WIDTH,height:ACCESS_HEIGHT};
  if([target?.left,target?.top,target?.width,target?.height].every(Number.isFinite)){
   options.left=Math.round(target.left+(target.width-ACCESS_WIDTH)/2);
   options.top=Math.round(target.top+Math.max(0,(target.height-ACCESS_HEIGHT)/2));
  }
  const created=await chrome.windows.create(options);
  if(!Number.isInteger(created?.id))throw Error('authorization window not opened');
  accessWindow={windowId:created.id,focusConfirmed:created.focused===true};
 }
 if(!connected||p.instanceId!==connectedInstanceId||p.connectionGeneration!==connectedGeneration)throw Error('connection changed');
 Object.assign(accessWindow,{requestId:p.requestId,connectionGeneration:p.connectionGeneration,bridge});
 // 中文注释：权限窗口与操作审批面板分开，但后台未聚焦时使用同一提醒通路。
 if(!accessWindow.focusConfirmed)await showPanelNotification(chrome,ACCESS_NOTIFICATION,'请打开扩展面板确认网站访问模式。');
 else await clearPanelNotification(chrome,ACCESS_NOTIFICATION);
 return {requestId:p.requestId,instanceId:p.instanceId,connectionGeneration:p.connectionGeneration,status:'opened'};
}
// Tells the daemon only that our own management window closed, so the user
// can explicitly ask again. It carries no consent; Hermes reads consent back.
function accessWindowClosed(windowId){
 const active=accessWindow;
 if(!active||active.windowId!==windowId)return;
 accessWindow=null;void clearPanelNotification(chrome,ACCESS_NOTIFICATION);
 if(!active.requestId||!connected||bridge!==active.bridge||connectedGeneration!==active.connectionGeneration)return;
 active.bridge.request('extension.access_request_closed',{requestId:active.requestId,connectionGeneration:active.connectionGeneration}).catch(()=>{});
}
// 中文注释：不同页面入口不能交错暂停/继续；停止可以越过控制等待，立即撤权。
const taskControls=new Set();
const takeoverBaselines=new Map();
async function takeoverStructure(task){
 // 中文注释：本地仅比较 URL 与文档代数；摘要不包含地址、正文或用户输入。
 const pages=await Promise.all([...task.tabIds].map(async currentTabId=>{
  try { return {tabId:currentTabId,url:(await chrome.tabs.get(currentTabId)).url,documentGeneration:executor.docs.get(currentTabId)||0}; }
  catch { return {tabId:currentTabId,url:null,documentGeneration:null}; }
 }));
 return pages;
}
async function overlayCommand(scope){
 if(scope.kind==='stop')return performOverlayCommand(scope);
 const key=JSON.stringify([scope.taskId,scope.generation]);
 if(taskControls.has(key))return {state:'unknown'};
 taskControls.add(key);
 try{return await performOverlayCommand(scope);}finally{taskControls.delete(key);}
}
async function performOverlayCommand({taskId,generation,tabId,origin:site,kind}){
 const unknown={state:'unknown'};
 const current=bridge,instanceId=connectedInstanceId,local=executor.tasks.get(taskId);
 if(!connected||!current||!instanceId||!['stop','takeover','resume'].includes(kind)
  ||!Number.isInteger(tabId)||!local||local.revoked||local.releasing
  ||local.id!==taskId||local.generation!==generation||local.instanceId!==instanceId
  ||executor.leases.get(tabId)!==taskId||!local.allowedOrigins?.includes(site))return unknown;
 try{
  const tasks=await current.request('extension.tasks');
  const host=tasks.find(t=>t.id===taskId);
  if(!host||host.instanceId!==instanceId||host.generation!==generation
   ||(kind==='resume'?!['paused','ready','running'].includes(host.state):kind==='stop'?!['ready','running','paused'].includes(host.state):!['ready','running'].includes(host.state))
   ||!host.tabIds?.includes(tabId)||!host.allowedOrigins?.includes(site)
   ||bridge!==current||!connected||connectedInstanceId!==instanceId
   ||executor.tasks.get(taskId)!==local||local.revoked||local.releasing
   ||executor.leases.get(tabId)!==taskId)return unknown;
  const tab=await chrome.tabs.get(tabId);
  if(origin(tab.url)!==site||bridge!==current||!connected||connectedInstanceId!==instanceId
   ||executor.tasks.get(taskId)!==local||local.revoked||local.releasing
   ||executor.leases.get(tabId)!==taskId)return unknown;
  if(kind==='takeover'){
   // 中文注释：先冻结扩展后续动作并等待当前动作结束，再确认桥接任务进入暂停态。
   await Promise.all([executor.pause(taskId,generation),current.request('extension.pause',{taskId,generation})]);
   takeoverBaselines.set(taskId,await takeoverStructure(local));
   const after=await current.request('extension.tasks');
   return after.some(t=>t.id===taskId&&t.instanceId===instanceId&&t.generation===generation&&t.state==='paused')
    ?{state:'paused',verified:true,taskId,generation}:unknown;
  }
  if(kind==='resume'){
   // 中文注释：恢复同一代任务，不创建新任务或重放已完成的浏览器动作。
   const before=takeoverBaselines.get(taskId)||[];
   const afterPages=await takeoverStructure(local);
   const changed={urlChanged:afterPages.some(row=>before.find(old=>old.tabId===row.tabId)?.url!==row.url),
    documentReplaced:afterPages.some(row=>before.find(old=>old.tabId===row.tabId)?.documentGeneration!==row.documentGeneration),
    referencesInvalid:true,readPageFirst:true};
   await executor.resume(taskId,generation);
   try{
    // 中文注释：上次恢复回执可能丢失；宿主已恢复时只修复本地状态，不重发控制请求。
    if(host.state==='paused')await current.request('extension.unpause',{taskId,generation,changes:changed});
    const after=await current.request('extension.tasks');
    if(after.some(t=>t.id===taskId&&t.instanceId===instanceId&&t.generation===generation&&['ready','running'].includes(t.state))){takeoverBaselines.delete(taskId);return {state:'running',verified:true,taskId,generation};}
    await executor.pause(taskId,generation);return unknown;
   }catch{await executor.pause(taskId,generation);return unknown;}
  }
  // Release while the daemon lease still exists. extension.stop cannot invoke
  // browser.release on this response reader without deadlocking it.
  const released=await executor.release({taskId,generation,closeAgentTabs:kind==='stop'});
  takeoverBaselines.delete(taskId);
  if(released?.released!==true||!local.revoked||bridge!==current||!connected)return unknown;
  await current.request('extension.stop',{taskId,generation,cleanup:released});
  const after=await current.request('extension.tasks');
  if(bridge!==current||!connected||connectedInstanceId!==instanceId
   ||!after.some(t=>t.id===taskId&&t.instanceId===instanceId&&t.generation===generation&&t.state==='cancelled'))return unknown;
  return {state:'stopped',verified:true,taskId,generation};
 }catch{return unknown;}
}
// 中文注释：下载事件只报告已归属任务的元信息；未连接本地桥时不认领，文件留在默认暂存位置。
const reportDownload=p=>{const current=bridge;if(!current||!connected)return Promise.resolve();return current.request('extension.download_event',p).catch(()=>{});};
// 中文注释：已存在的订阅也必须遵循当前开关；设置读失败时不推送原始事件。
const pushCdpEvents=async p=>{try{if((await readContentShield()).enabled)return;}catch{return;}const current=bridge;if(!current||!connected)return;return current.request('extension.cdp_events',p).catch(()=>{});};
const executor=new Executor(chrome,p=>bridge?.request('extension.tab_event',p).catch(()=>{}),{onOverlayCommand:overlayCommand,onDownloadEvent:reportDownload,onCdpEvents:pushCdpEvents,onContentShield:readContentShield});
// 中文注释：镜像状态变化只刷新源扩展确认面板，弹窗不保留复制结果。
const cookieMirror=new CookieMirror(chrome,{onChanged:()=>{void refreshApprovals();}});
const consent=new BrowserConsent(chrome.storage.local,executor);
const consentLoaded=consent.load();
let disconnectBarrier=Promise.resolve();
// The host list is authoritative. Never accept a request supplied by the page,
// model, or panel as approval scope; the panel receives only display fields.
const approvalActions={click:'点击页面',fill:'填写内容',press:'按键',ref_click:'点击页面元素',ref_fill:'填写页面元素',ref_press:'按页面元素键位',ref_set_checked:'设置复选状态',ref_select_option:'选择下拉选项',
 snapshot:'读取页面快照',screenshot:'截取页面', 'page.parse':'解析页面','semantic_snapshot':'读取语义快照',frame_catalog:'读取子框架目录','interaction.capture':'截取交互画面','interaction.bounds':'读取元素位置','official.ready_state':'读取页面状态',images:'读取页面图片',console:'读取控制台',
 dialog:'处理页面对话框','js.evaluate':'执行页面 JavaScript','cdp.send':'执行原始 CDP','cdp.events':'读取 CDP 事件','network.inspect':'查看网络记录',
 api_request:'发送页面请求','files.upload':'上传文件','gateway.authorize':'运行 browser_exec 调试脚本','vault.authorize':'使用保险库填写',new_tab:'新建工作页','official.new_tab':'新建工作页',select_tab:'切换标签页',close_tab:'关闭标签页',scroll:'滚动页面',
 'official.goto_url':'打开网址',
 'interaction.click':'按截图点击','interaction.drag_coordinates':'按截图拖动','interaction.drag_elements':'拖动元素',navigate:'打开网址',back:'返回上一页'};
function actionSummary(p,extraOrigins=[]){
 const label=p.action==='ref_click'&&p.clickMode==='pointer'?'按指针点击页面元素':approvalActions[p.action],short=value=>typeof value==='string'?value.slice(0,120):'';
 let target='';
 if(['click','fill','press'].includes(p.action))target=short(p.selector);
 else if(['ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option'].includes(p.action))target=short(p.ref);
 else if(p.action==='interaction.drag_elements')target=`${short(p.source)} → ${short(p.target)}`;
 else if(['navigate','new_tab','official.new_tab','official.goto_url'].includes(p.action))try{const u=new URL(p.url);target=`${u.origin}${u.pathname}`.slice(0,120);}catch{}
 else if(p.action==='interaction.click'&&Number.isFinite(p.point?.x)&&Number.isFinite(p.point?.y))target=`(${p.point.x}, ${p.point.y})`;
 else if(p.action==='cdp.send')target=short(p.method);
 else if(p.action==='api_request')target=short(p.url);
 else if(p.action==='gateway.authorize')target=short(p.codeDigest?.slice(0,12));
 else if(p.action==='vault.authorize')target=({fill:'密码',save_login:'保存登录信息',enter_code:'验证码'})[p.vaultAction]||'';
 const details=[target?`${label} · ${target}`:label];
 if(p.action==='cdp.send'&&p.method==='Page.addScriptToEvaluateOnNewDocument')details.push('该脚本会在之后打开的页面上持续执行，包括其他网站');
 if(extraOrigins.length)details.push(`额外子框架来源：${extraOrigins.join('、')}`);
 return details.join('；').slice(0,512);
}
async function frameOrigins(tabId,allowedOrigins){
 // 中文注释：审批面板仅展示来源，不读取子框架页面内容。
 const tree=await chrome.debugger.sendCommand({tabId},'Page.getFrameTree',{});
 const seen=new Set(),visit=node=>{try{const site=new URL(node?.frame?.url).origin;if(site!=='null'&&!allowedOrigins.includes(site))seen.add(site);}catch{}for(const child of node?.childFrames||[])visit(child);};
 visit(tree?.frameTree);
 return [...seen].sort();
}
const fieldLabels={password:'密码',payment:'支付信息',otp:'验证码',sensitive:'敏感信息'};
async function pendingAction(a,t,instanceId){
 const local=executor.tasks.get(t?.id),p=a?.request,manual=a?.kind==='manual_input';
 // A manual-input request is never executed by us, so it is shown in full mode too.
 if(!local||local.revoked||t.instanceId!==instanceId||local.instanceId!==instanceId
  ||local.generation!==t.generation||(!manual&&(local.policy.activeMode!=='smart'||t.activeMode!=='smart'))
  ||(manual&&!Object.hasOwn(fieldLabels,a.fieldKind))
  ||t.state!=='ready'||a.generation!==t.generation
  ||a.modeGeneration!==t.modeGeneration||local.policy.modeGeneration!==t.modeGeneration
  ||!Object.hasOwn(approvalActions,p?.action)
  ||(a.readOrigin!==undefined&&!t.allowedOrigins.includes(a.readOrigin))
  ||!t.allowedOrigins?.length||(Number.isInteger(p.tabId)&&executor.leases.get(p.tabId)!==t.id)
  ||(!Number.isInteger(p.tabId)&&!['new_tab','official.new_tab','gateway.authorize'].includes(p.action))
  ||typeof a.nonce!=='string'||!a.nonce||typeof a.digest!=='string'||!a.digest
  ||!Number.isFinite(a.expiresAt)||a.expiresAt*1000<=Date.now())return null;
 try{
  const tab=Number.isInteger(p.tabId)?await chrome.tabs.get(p.tabId):null;
  const site=tab?origin(tab.url):t.allowedOrigins[0];
  const windowId=tab?.windowId??(await chrome.windows.getLastFocused({windowTypes:['normal']})).id;
  if(!Number.isInteger(windowId)||!t.allowedOrigins.includes(site))return null;
  // 中文注释：页面读取审批绑定发起时的顶层来源；换站后旧弹窗不可继续批准。
  if(a.readOrigin&&['snapshot','screenshot','page.parse','semantic_snapshot','frame_catalog','interaction.capture','interaction.bounds','official.ready_state','images','console'].includes(p.action)&&site!==a.readOrigin)return null;
  const extraOrigins=p.action==='cdp.send'?await frameOrigins(p.tabId,t.allowedOrigins).catch(()=>['来源暂不可读取']):[];
  return {id:JSON.stringify([t.id,a.nonce]),instanceId,taskId:t.id,generation:t.generation,
   modeGeneration:t.modeGeneration,nonce:a.nonce,tabId:p.tabId??null,windowId,origin:site,
   action:manual?`请亲自填写${fieldLabels[a.fieldKind]}`:actionSummary(p,extraOrigins),scope:a.readOrigin?'本任务此网站读取':'本次操作',readOrigin:a.readOrigin,expiresAt:a.expiresAt*1000,digest:a.digest,
   taskTitle:(t.title||'浏览器任务').slice(0,256),...(manual?{kind:'manual_input',fieldKind:a.fieldKind}:
    {mode:'smart'})};
 }catch{return null;}
}
async function collectApprovals(current,instanceId){
 const tasks=await current.request('extension.tasks');
 const approvals=await current.request('extension.approvals');
 const requests=await Promise.all(approvals.map(a=>pendingAction(a,tasks.find(t=>t.id===a?.taskId),instanceId)));
 // 中文注释：Cookie 确认独立于任务和全部访问模式，只有源扩展界面能批准。
 if(!cookieMirror.transfers.size)return requests.filter(Boolean);
 const window=await chrome.windows.getLastFocused({windowTypes:['normal']});
 return [...requests.filter(Boolean),...cookieMirror.approvals(instanceId,window.id)];
}
function refreshApprovals(current=bridge){
 const run=async()=>{
  if(!current||current!==bridge||!connected||!notifier)return;
  try{const list=await collectApprovals(current,approvalInstance);
   if(current===bridge&&connected&&notifier)await notifier.sync(list);
  }catch(e){lastError=e.message;/* Keep pending badge on a failed read; never infer revocation. */}
 };
 const next=approvalRefresh.catch(()=>{}).then(run);approvalRefresh=next;return next;
}
async function verifyAction(r,current=bridge){
 if(!connected||!current||current!==bridge||!notifier||r.instanceId!==approvalInstance||r.expiresAt<=Date.now())return false;
 const list=await collectApprovals(current,approvalInstance);
 if(r.kind==='cookie_mirror'){
  const state=await current.request('extension.cookie_mirror.status',{transferId:r.id});
  return state.status==='approval_required'&&list.some(l=>l.id===r.id&&l.kind==='cookie_mirror');
 }
 return list.some(l=>l.id===r.id&&l.taskId===r.taskId&&l.generation===r.generation
  &&l.modeGeneration===r.modeGeneration&&l.nonce===r.nonce&&l.tabId===r.tabId
  &&l.windowId===r.windowId&&l.origin===r.origin&&l.action===r.action
  &&l.scope===r.scope&&l.readOrigin===r.readOrigin&&l.digest===r.digest&&l.expiresAt===r.expiresAt);
}
async function dispatchAction(r,decision){
 const current=bridge;
 if(!await verifyAction(r,current))throw Error('确认已失效，请刷新');
 if(r.kind==='cookie_mirror'){
  if(decision==='approve')cookieMirror.approve(r.id);else cookieMirror.destroy(r.id);
  try{const result=await current.request('extension.cookie_mirror.decide',{transferId:r.id,approve:decision==='approve'});if(!(decision==='approve'?['executing','completed'].includes(result.status):result.status==='denied'))throw Error('COOKIE_DECISION_UNKNOWN');return result;}
  catch{cookieMirror.destroy(r.id);throw Error('Cookie 镜像决定未确认');}
 }
 const approvals=await current.request('extension.approvals');
 const a=approvals.find(x=>x.taskId===r.taskId&&x.nonce===r.nonce&&x.digest===r.digest
  &&x.generation===r.generation&&x.modeGeneration===r.modeGeneration&&x.expiresAt*1000===r.expiresAt);
 if(!a||!await verifyAction(r,current))throw Error('确认已失效，请刷新');
 const manual=r.kind==='manual_input';
 // "I filled it" dispatches nothing, so it grants the executor nothing.
 if(decision==='approve'&&!manual&&!['gateway.authorize','vault.authorize'].includes(a.request?.action))executor.approveAction(a);
 try{
  const result=await current.request('extension.decide',{taskId:r.taskId,nonce:r.nonce,digest:r.digest,approve:decision==='approve'});
  if(result?.status!==(decision==='approve'?(manual?'completed':'approved'):'denied'))throw Error('确认结果待核查');
  const after=await current.request('extension.approvals');
  if(after.some(x=>x.taskId===r.taskId&&x.nonce===r.nonce))throw Error('确认结果待核查');
 }catch(e){executor.actionGrants.delete(r.nonce);throw e;}
}
async function refreshOverlaySteps(current){
 // 中文注释：仅把守护进程脱敏后的最近五步送进任务遮罩，不读取网页或输入内容。
 for(const task of executor.tasks.values()){
  if(task.revoked||!task.overlays?.size)continue;
  try{
   const steps=await current.request('extension.task_log',{taskId:task.id,generation:task.generation,limit:5});
   if(current!==bridge||task.revoked)continue;
   for(const [tabId,entry] of task.overlays)void executor.overlayCall(tabId,entry,'log',{steps}).catch(()=>{});
  }catch{}
 }
}
const changed=()=>{chrome.runtime.sendMessage({type:'changed'}).catch(()=>{});if(connected&&bridge){const current=bridge;void refreshOverlaySteps(current);consent.synchronize(current).catch(e=>{lastError=e.message;}).then(()=>refreshApprovals(current));}};
async function connect(){if(bridge||connecting)return;connecting=true;try{
 await consentLoaded;await disconnectBarrier;
 const stored=await chrome.storage.local.get('browserInstanceId');const session=await chrome.storage.session.get('instanceId');const instanceId=stored.browserInstanceId||session.instanceId||crypto.randomUUID();await chrome.storage.local.set({browserInstanceId:instanceId});await chrome.storage.session.set({instanceId});
 if(!executor.workspaces)executor.workspaces=new NativeWorkspaces(chrome,instanceId,id=>executor.leases.has(id));
 await executor.workspaces.manager.reconcile();
 const port=chrome.runtime.connectNative('com.hermes.browser_link');const current=new Bridge(port,executor,changed,{onConsentStatus:()=>consent.readStatus(),onAccessRequest:openAccessManagementRequest,onContentFilter:readContentFilter,onCookieMirror:(method,p)=>cookieMirror.handle(method,p),onCookieDisconnect:()=>{cookieMirror.disconnect();}});bridge=current;
 port.onDisconnect.addListener(()=>{if(bridge!==current)return;lastError=chrome.runtime.lastError?.message||'本地桥已断开；操作不会自动重放';connected=false;connectedInstanceId=null;connectedGeneration=null;if(accessWindow)accessWindow.requestId=null;bridge=null;current.close();const old=notifier;notifier=null;approvalInstance=null;old?.dispose().catch(()=>{});disconnectBarrier=executor.disconnect().catch(()=>{});
  // 中文注释：本地桥意外断开（如 daemon 重启）后很快重连一次；在途动作不重放，其余仍靠 30 秒定时重连兜底。
  setTimeout(()=>{connect();},1500);});
 // 中文注释：握手版本与扩展清单保持一致，避免安装后仍报告旧版本。
 // 中文注释：握手版本与 1.7.1 发布清单一致。
 const hello=await current.request('extension.hello',{instanceId,browser:/Edg/.test(navigator.userAgent)?'edge':'chrome',version:'1.7.1',capabilities:{features:['browser_core_v1','page_parse_v1','page_function_v1','network_evidence_v1','cookie_mirror_v1'],statusProjection:true,consentStatus:true,accessRequest:typeof chrome.windows?.create==='function'}});if(bridge===current){connected=true;connectedInstanceId=instanceId;connectedGeneration=typeof hello?.connectionGeneration==='string'?hello.connectionGeneration:null;lastError='';if(chrome.windows?.create&&chrome.windows?.update&&chrome.runtime.getURL){notifier=createApprovalNotifier({chrome,instanceId});approvalInstance=instanceId;}try{executor.diagnostics.recordSafely({component:'mv3_background',event_type:'connection_state',connection_id:executor.diagnosticConnection,status:'connected'});}catch{}// 中文注释：握手后按 daemon 本实例终态与本地工作区日志清理重载遗留浮层，先于恢复授权派发。
 await executor.cleanupOrphanOverlays(await current.request('extension.tasks',{includeClosed:true}),instanceId);await consent.synchronize(current);await refreshApprovals(current);}
 }catch(e){
  lastError=e.message;
  if(bridge&&!connected){
   // 中文注释：握手失败也要释放旧端口，否则“连接”按钮会一直被残留 bridge 拦住。
   const failed=bridge;bridge=null;failed.close();try{failed.port.disconnect();}catch{}
   disconnectBarrier=executor.disconnect().catch(()=>{});
  }
 }finally{connecting=false;}}
chrome.alarms.create('reconnect',{periodInMinutes:0.5});chrome.alarms.onAlarm.addListener(()=>{connect();refreshApprovals();});
chrome.windows?.onRemoved?.addListener(windowId=>{accessWindowClosed(windowId);notifier?.panelClosed(windowId).catch(()=>{});});
chrome.tabs.onCreated.addListener(tab=>executor.tabCreated(tab).catch(()=>{}));
chrome.tabs.onRemoved.addListener(id=>executor.tabEvent(id,'closed').catch(()=>{}));
// 中文注释：完整事件信息用于区分同文档 URL 改写、加载和真正换页；下载与高级事件监听继续共存。
chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(change.url||change.status==='loading'||change.status==='complete')executor.tabEvent(id,'navigated',change.url||tab.url,{status:change.status||null,urlChanged:!!change.url}).catch(()=>{});});
if(chrome.downloads&&executor.downloads){
 chrome.downloads.onCreated.addListener(item=>executor.downloads.created(item));
 chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>executor.downloads.determine(item,suggest));
 chrome.downloads.onChanged.addListener(delta=>{void executor.downloads.changed(delta);});
 chrome.debugger.onEvent.addListener((source,method,params)=>executor.downloads.observeCdp(source,method,params));
}
chrome.debugger.onEvent?.addListener?.((source,method,params)=>{executor.pageRuntime.observe(source,method,params);executor.observers.observe(source,method,params);});
// 中文注释：主框架 DOM 就绪时立刻补完整遮罩；Page 域由预遮罩同步时开启。
chrome.debugger.onEvent?.addListener((source,method)=>{if(method!=='Page.domContentEventFired'||source?.sessionId||!Number.isInteger(source?.tabId)||!executor.leases.has(source.tabId))return;chrome.tabs.get(source.tabId).then(tab=>executor.tabEvent(source.tabId,'navigated',tab.url,{status:'dom_ready',urlChanged:false})).catch(()=>{});});
// 中文注释：分离后原 CDP 通道已失效；先撤销任务，再短暂附加移除残留浮层，清理自己的分离事件不能再停任务。
chrome.debugger.onDetach.addListener(({tabId})=>{
 const expectedClose=executor.closingTabs.has(tabId);executor.attached.delete(tabId);
 if(expectedClose||executor.overlayCleanupTabs.has(tabId))return;
 const t=executor.tasks.get(executor.leases.get(tabId));if(!t||t.revoked)return;
 const current=bridge;
 // 中文注释：立即卸载本地输入拦截，不等待任务资源清理或 daemon 回执。
 void executor.removeLocalOverlayInput(t,tabId).catch(()=>{});
 void executor.release({taskId:t.id,generation:t.generation,closeAgentTabs:false})
  .then(async()=>{await executor.cleanupDetachedOverlay(t,tabId);await current?.request('extension.stop',{taskId:t.id,generation:t.generation});}).catch(()=>{});
});
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
 if(m?.type==='approval_panel_view'||m?.type==='approval_panel_decision'){
  if(!notifier?.isSender(sender))return false;
  (async()=>{
   // Verify the sender still inhabits the actual extension panel tab, not a
   // reused tab ID or a model-controlled HTTP(S) page.
   const panel=notifier.panel(),tab=await chrome.tabs.get(panel.tabId);
   if(tab?.windowId!==panel.windowId||tab.url!==chrome.runtime.getURL('approval-panel.html')
    ||executor.leases.has(tab.id))throw Error('untrusted panel sender');
   if(m.type==='approval_panel_view')return notifier.viewFor(sender);
   if(!connected||!bridge)throw Error('本地桥未连接');
   return notifier.decide({sender,requestId:m.requestId,decision:m.decision,verify:verifyAction,dispatch:dispatchAction});
  })().then(result=>respond({result}),e=>respond({error:e.message}));return true;
 }
 if(!isUiSender(sender,chrome.runtime.id))return false;
 (async()=>{
 await consentLoaded;
 // 中文注释：此分支位于 isUiSender 校验之后，网页和 native 请求不能切换过滤设置。
 if(m.type==='page_content_filter'){
  if(typeof m.enabled!=='boolean')throw Error('无效的过滤设置');
  await chrome.storage.local.set({pageContentFilter:m.enabled});
  const enabled=await readContentFilter();
  chrome.runtime.sendMessage({type:'changed'}).catch(()=>{});
  return {enabled};
 }
 // 中文注释：屏蔽规则入口位于受信 sender 校验之后，保存后逐项读回核实。
 if(m.type==='page_content_shield_read')return {rules:(await readContentShield()).rules};
 if(m.type==='page_content_shield_save'){
  const rules=validateShieldRules(m.rules);
  await chrome.storage.local.set({pageContentShieldRules:rules});
  const saved=(await readContentShield()).rules;
  if(JSON.stringify(saved)!==JSON.stringify(rules))throw Error('屏蔽区域保存未确认');
  chrome.runtime.sendMessage({type:'changed'}).catch(()=>{});
  return {rules:saved};
 }
 // 中文注释：弹窗仅能打开已有镜像确认请求，不能列站点、发起或轮询复制。
 if(m.type==='cookie_mirror_pending'){await refreshApprovals();const pending=notifier?.pending().find(r=>r.kind==='cookie_mirror');if(pending)await notifier.openPending(pending.id);return {opened:!!pending};}
 // 中文注释：主要链接仅由桌面受保护路由设置，弹窗不再提供写入入口。
 if(m.type==='browser_consent'){
  // 中文注释：开关在智能审批与全部访问之间切换，并同步当前任务。
  await consent.setEnabled(m.enabled,connected?bridge:null);
  if(connected&&bridge)await consent.synchronize(bridge);
  return {enabled:consent.enabled,consentStatus:await consent.readStatus()};
 }
 if(m.type==='diagnostics_export')return executor.diagnostics.exportBundle();
 // 中文注释：弹窗只读取当前浏览器的任务摘要和实际归属页，不返回输入或日志正文。
 if(m.type==='popup_status'){
  // 中文注释：弹窗状态报告与 Native 握手相同的 1.7.1 版本。
  const base={connected,browserFullConsentStatus:await consent.readStatus(),pageContentFilter:await readContentFilter(),browser:/Edg/.test(navigator.userAgent)?'Edge':'Chrome',instanceId:connectedInstanceId,observedAt:Date.now(),version:'1.7.1'};
  if(!connected||!bridge)return {...base,tasks:[],page:null};
  const tasks=await bridge.request('extension.tasks');
  const active=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
  const owner=active?executor.leases.get(active.id):null;
  const task=tasks.find(t=>t.id===owner);
  let page=null;
  if(task){const view=await executor.status({taskId:task.id,generation:task.generation});page=view.pages.find(p=>p.tabId===active.id)||null;}
  const local=task&&executor.tasks.get(task.id);
  const state=local?.pauseRequested&&!local.paused?'pausing':local?.paused?'paused':task?.state;
  return {...base,tasks:page&&!['closed','cancelled'].includes(task.state)?[{id:task.id,state,generation:task.generation,activeMode:local?.policy.activeMode||'smart',pendingInteraction:task.pendingInteraction?{kind:task.pendingInteraction.kind}:null}]:[],page:page?{...page,taskId:task.id}:null};
 }
 if(m.type==='popup_action'){
  const t=executor.tasks.get(m.taskId);
  if(!t||t.revoked||t.generation!==m.generation||executor.leases.get(m.tabId)!==t.id)throw Error('页面归属已变化，请刷新');
  const tab=await chrome.tabs.get(m.tabId);const site=origin(tab.url);executor.allowed(t,tab.url);
  if(m.kind==='focus'){await chrome.tabs.update(m.tabId,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return {verified:true};}
  return overlayCommand({taskId:t.id,generation:t.generation,tabId:m.tabId,origin:site,kind:m.kind});
 }
 if(m.type==='status'){const workspaces=await executor.workspaces?.status()||[],diagnostics={available:true,eventCount:executor.diagnostics.size},browserFullConsentStatus=await consent.readStatus(),browserFullConsent=browserFullConsentStatus==='enabled'?true:browserFullConsentStatus==='disabled'?false:null;if(!connected)return {connected,lastError,browserFullConsent,browserFullConsentStatus,tasks:[],tabs:[],workspaces,diagnostics};const tasks=await bridge.request('extension.tasks'),approvals=await bridge.request('extension.approvals');void refreshApprovals();return {connected,lastError,browserFullConsent,browserFullConsentStatus,workspaces,diagnostics,tasks:tasks.map(t=>({...t,activeMode:executor.tasks.get(t.id)?.policy.activeMode||'smart'})),approvals,preferredMode:(await chrome.storage.local.get('preferredMode')).preferredMode||'smart',tabs:(await chrome.tabs.query({})).filter(t=>/^https?:/.test(t.url||''))};}
 if(m.type==='connect'){await connect();return {connected,lastError};}
 if(!connected||!bridge)throw Error('本地桥未连接');
 if(m.type==='approve'){
 const tasks=await bridge.request('extension.tasks');const task=tasks.find(t=>t.id===m.taskId&&t.state==='pending_approval');if(!task)throw Error('任务不再等待批准');
 const ids=[...new Set(m.tabIds)];for(const id of ids){const tab=await chrome.tabs.get(id);if(!task.allowedOrigins.includes(origin(tab.url)))throw Error('标签页来源不在申请范围');if(executor.leases.has(id))throw Error('标签页已被其他任务占用');}
 return bridge.request('extension.approve',{taskId:task.id,tabIds:ids,allowedOrigins:task.allowedOrigins,generation:task.generation});}
 if(m.type==='mode'){
 const t=executor.tasks.get(m.taskId);if(!t||t.revoked)throw Error('任务已失效，请重新批准');
 const generation=t.generation,modeGeneration=t.policy.modeGeneration;
 if(m.mode==='smart')executor.revokeMode(t.id);
 const updated=await bridge.request('extension.mode',{taskId:t.id,mode:m.mode,generation,modeGeneration});
 if(m.mode==='full')executor.setMode(updated);
 await chrome.storage.local.set({preferredMode:m.mode});return updated;
 }
 if(m.type==='decide'){
 const approvals=await bridge.request('extension.approvals');const a=approvals.find(a=>a.taskId===m.taskId&&a.nonce===m.nonce&&a.digest===m.digest);if(!a)throw Error('确认已失效，请刷新');
 if(m.approve===true&&a.kind!=='manual_input')executor.approveAction(a);
 try{return await bridge.request('extension.decide',{taskId:a.taskId,nonce:a.nonce,digest:a.digest,approve:m.approve===true});}catch(e){executor.actionGrants.delete(a.nonce);throw e;}
 }
 if(m.type==='reject')return bridge.request('extension.reject',{taskId:m.taskId});
 if(m.type==='stop'){
  const t=executor.tasks.get(m.taskId);
  // 中文注释：扩展先完成本地释放，再把清理回执随停止请求交给 daemon 记录。
  const cleanup=t?await executor.release({taskId:t.id,generation:t.generation,closeAgentTabs:true}):null;
  return bridge.request('extension.stop',{taskId:m.taskId,...(t?{generation:t.generation,cleanup}:{})});
 }
 throw Error('不支持的操作');
 })().then(result=>respond({result}),e=>respond({error:typeof m.type==='string'&&m.type.startsWith('cookie_mirror_')?'Cookie 镜像请求不可用，请核实扩展权限和连接。':e.message}));return true;
});
connect();
