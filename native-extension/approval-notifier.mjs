// UI coordinator only. The native/extension authority must validate live scope and
// register approval-panel.html as a trusted sender before dispatching any decision.
const PANEL = 'approval-panel.html';
// 中文注释：调试命令可能附带多个子框架来源，审批按钮须保留可见空间。
const WIDTH = 420, HEIGHT = 450;
const NOTIFICATION = 'hermes-browser-approval';

// 中文注释：系统通知只提醒打开扩展面板，不携带网站、任务、浏览器标识或 Cookie 值。
export async function showPanelNotification(chrome,id,message) {
 try { await chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icon-128.png'),title:'Hermes Browser Link 需要你确认',message}); }
 catch { /* 中文注释：系统禁用通知时保留面板和角标，不能把提醒失败解释为批准。 */ }
}
export async function clearPanelNotification(chrome,id) {
 try { await chrome.notifications.clear(id); } catch { /* 中文注释：清理提醒失败不改变审批状态。 */ }
}

export function isApprovalPanelSender(sender, runtimeId, panelWindowId, panelTabId) {
 return !!sender && sender.id === runtimeId && sender.url === `chrome-extension://${runtimeId}/${PANEL}`
  && Number.isInteger(panelWindowId) && sender.tab?.windowId === panelWindowId
  && sender.tab?.id === panelTabId;
}

function valid(r, instanceId) {
 if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 128
  || r.instanceId !== instanceId || typeof r.taskId !== 'string' || !r.taskId
  || !Number.isSafeInteger(r.generation) || r.generation < 1
  || (r.modeGeneration!==undefined && (!Number.isSafeInteger(r.modeGeneration)||r.modeGeneration<1))
  || (r.tabId!==null&&(!Number.isInteger(r.tabId)||r.tabId<0)) || !Number.isInteger(r.windowId)
  || typeof r.action !== 'string' || !r.action || typeof r.digest !== 'string' || !r.digest
  || !['本次操作','此任务','本任务此网站读取'].includes(r.scope) || !Number.isFinite(r.expiresAt)
  || (r.mode!==undefined && r.mode!=='smart')
  || (r.kind!==undefined && !(r.kind==='manual_input' && ['password','payment','otp','sensitive'].includes(r.fieldKind))&&r.kind!=='cookie_mirror')
  || typeof r.taskTitle !== 'string' || !r.taskTitle) return false;
 try { const u = new URL(r.origin); const read=r.readOrigin===undefined?null:new URL(r.readOrigin);return ['http:','https:'].includes(u.protocol) && !u.username&&!u.password&&u.origin===r.origin
  &&(!read||['http:','https:'].includes(read.protocol)&&!read.username&&!read.password&&read.origin===r.readOrigin); }
 catch { return false; }
}
const identity = r => JSON.stringify([r.instanceId,r.taskId,r.generation,r.modeGeneration,r.tabId,r.windowId,r.origin,r.readOrigin,r.action,r.scope,r.expiresAt,r.digest,r.taskTitle,r.kind,r.fieldKind,r.source,r.target,r.sites,r.count,r.options]);

export function createApprovalNotifier({chrome,instanceId,now=()=>Date.now(),panelPath=PANEL}={}) {
 if (!chrome?.runtime?.id || panelPath !== PANEL || !instanceId) throw Error('invalid notifier setup');
 const requests = new Map(), attempted = new Map(), settled = new Map(); let active=null, panel=null, serial=Promise.resolve(), disposed=false;
 const badge = async () => { const count=requests.size,unknown=[...requests.values()].some(r=>r.unknown);await chrome.action?.setBadgeText?.({text:unknown?'!':count?String(count):''}); await chrome.action?.setTitle?.({title:unknown?'浏览器批准结果待核查':count?'有待处理的浏览器批准':'Hermes 浏览器'}); };
 const close = async () => { const old=panel;panel=null;if(old){await clearPanelNotification(chrome,NOTIFICATION);try{await chrome.windows.remove(old.windowId);}catch{}} };
 async function display() {
  if(disposed || active || panel)return;
  const r=[...requests.values()].find(x=>!x.later&&!attempted.has(x.id));
  if(!r)return;
  active=r.id;attempted.set(r.id,identity(r));
  try {
   // 中文注释：新建工作页尚无租约标签，审批仅绑定当前浏览器窗口与任务。
   if(r.tabId!==null){const tab=await chrome.tabs.get(r.tabId);if(tab?.windowId!==r.windowId||new URL(tab.url).origin!==r.origin)throw Error('tab scope changed');}
   const target=await chrome.windows.get(r.windowId);
   if(target.id!==r.windowId||target.type!=='normal')throw Error('wrong target window');
   // 中文注释：后台应用可能无法抢前台；聚焦失败仍建面板，只记录未确认状态。
   let targetFocused=false;
   try { const focused=await chrome.windows.update(r.windowId,{focused:true});targetFocused=focused?.id===r.windowId&&focused.focused===true; } catch {}
   const manual=r.kind==='manual_input';
   // The person must type into the page: show that tab and keep the field visible.
   if(manual&&r.tabId!==null)await chrome.tabs.update(r.tabId,{active:true});
   const created=await chrome.windows.create({url:chrome.runtime.getURL(PANEL),type:'popup',focused:true,width:WIDTH,height:HEIGHT,
    left:Math.round(manual?target.left+target.width-WIDTH-24:target.left+(target.width-WIDTH)/2),
    top:Math.round(manual?target.top+80:target.top+(target.height-HEIGHT)/2)});
   if(!Number.isInteger(created?.id)||!Number.isInteger(created.tabs?.[0]?.id)){
    if(Number.isInteger(created?.id))try{await chrome.windows.remove(created.id);}catch{}
    throw Error('panel not verifiable');
   }
   panel={windowId:created.id,tabId:created.tabs[0].id,focusConfirmed:targetFocused&&created.focused===true};
   if(!targetFocused||!panel.focusConfirmed)await showPanelNotification(chrome,NOTIFICATION,
    r.kind==='cookie_mirror'?'请打开扩展面板确认 Cookie 镜像。':manual?'请打开扩展面板处理人工输入。':'请打开扩展面板确认网站访问或本次操作。');
  }catch { active=null; /* 中文注释：范围或建窗失败时仅保留角标，不声称面板已打开。 */ }
 }
 const run=fn=>{const result=serial.catch(()=>{}).then(fn);serial=result.catch(()=>{});return result;};
 return {
  sync(incoming) {return run(async()=>{
   if(disposed)throw Error('notifier disposed');
   if(!Array.isArray(incoming))throw Error('invalid request list');
   const next=new Map();for(const r of incoming){if(!valid(r,instanceId))throw Error('invalid approval scope');if(r.expiresAt<=now())continue;if(next.has(r.id)&&identity(next.get(r.id))!==identity(r))throw Error('conflicting approval id');next.set(r.id,{...r});}
   for(const [id,old] of requests){const fresh=next.get(id);if(fresh&&identity(fresh)===identity(old))fresh.later=old.later;else if(active===id){await close();active=null;}}
   for(const [id,stamp] of attempted)if(!next.has(id)||identity(next.get(id))!==stamp)attempted.delete(id);
   for(const [id,entry] of settled)if(!next.has(id)||identity(next.get(id))!==entry.stamp)settled.delete(id);
   requests.clear();for(const [id,r] of next){
    if(settled.get(id)?.state==='done')continue;
    if(settled.get(id)?.state==='unknown'){r.unknown=true;r.later=true;}
    requests.set(id,r);
   }
   await badge();await display();
  });},
  view(){const r=requests.get(active);return r?{...r}:null;},
  viewFor(sender){
   if(!panel||!isApprovalPanelSender(sender,chrome.runtime.id,panel.windowId,panel.tabId))return null;
   const r=requests.get(active);if(!r||r.expiresAt<=now())return null;
   const {id,taskTitle,origin,readOrigin,action,scope,expiresAt,kind,fieldKind}=r;
   return {id,taskTitle,origin,action,scope,expiresAt,...(readOrigin?{readOrigin}:{}),...(kind?{kind,fieldKind}:{}),...(kind==='cookie_mirror'?{source:r.source,target:r.target,sites:r.sites,count:r.count,options:r.options}:{})};
  },
  panel(){return panel&&{...panel};},
  pending(){return [...requests.values()].map(r=>({...r}));},
  status(){return {kind:[...requests.values()].some(r=>r.unknown)?'unknown':requests.size?'waiting':'idle',pendingCount:requests.size,panelOpen:!!panel};},
  isSender(sender){return !!panel && isApprovalPanelSender(sender,chrome.runtime.id,panel.windowId,panel.tabId);},
  decide({sender,requestId,decision,verify,dispatch}={}) {return run(async()=>{
   if(!panel||!isApprovalPanelSender(sender,chrome.runtime.id,panel.windowId,panel.tabId))throw Error('untrusted panel sender');
   const r=requests.get(requestId);if(!r||active!==requestId||r.expiresAt<=now())throw Error('stale approval');
   if(!['approve','reject','later'].includes(decision))throw Error('invalid decision');
   if(decision!=='later'){
    if(typeof verify!=='function'||typeof dispatch!=='function'||await verify({...r})!==true)throw Error('stale approval scope');
    // No replay on missing response: a dispatched decision may have taken effect.
    settled.set(r.id,{stamp:identity(r),state:'unknown'});
    try{await dispatch({...r},decision);settled.set(r.id,{stamp:identity(r),state:'done'});}catch(e){r.later=true;r.unknown=true;await close();active=null;await badge();await display();throw e;}
    requests.delete(r.id);
   }else r.later=true;
   await close();active=null;await badge();await display();
   return {decision,requestId};
  });},
  // 中文注释：通知点击只聚焦仍有效的绑定面板，不派发任何审批决定。
  notificationClicked(id){return run(async()=>{
   const r=requests.get(active);if(id!==NOTIFICATION||!panel||!r||r.expiresAt<=now()||r.unknown)return;
   const focused=await chrome.windows.update(panel.windowId,{focused:true});
   panel.focusConfirmed=focused?.id===panel.windowId&&focused.focused===true;
   if(panel.focusConfirmed)await clearPanelNotification(chrome,NOTIFICATION);
  });},
  panelClosed(windowId){return run(async()=>{if(panel?.windowId!==windowId)return;panel=null;active=null;await clearPanelNotification(chrome,NOTIFICATION);await display();});},
  openPending(id){return run(async()=>{const r=requests.get(id);if(!r||r.expiresAt<=now())throw Error('stale approval');if(r.unknown)throw Error('unknown outcome; reconcile first');r.later=false;attempted.delete(id);if(active){await close();active=null;}await display();});},
  dispose(){return run(async()=>{disposed=true;requests.clear();attempted.clear();settled.clear();active=null;await close();await badge();});}
 };
}
