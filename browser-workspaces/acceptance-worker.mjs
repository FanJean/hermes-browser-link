// Disposable MV3 acceptance fixture. Never install into a personal profile.
import {createAuthority,createWorkspaces,groupTitle,registerWorkspaceStartup} from './index.mjs';
// 中文注释：临时验收也在顶层安装启动撤权监听。
registerWorkspaceStartup(chrome);
// 中文注释：runtime.reload 后 MV3 worker 只在事件唤醒时启动；重载触发 onInstalled，借此让新 worker 出现。
chrome.runtime?.onInstalled?.addListener(()=>{});
const check=(value,message)=>{if(!value)throw Error(message);};
async function run(){
 const windows=await chrome.windows.getAll();
 const win=windows.find(w=>w.type==='normal');check(win,'normal window missing');
 const user=(await chrome.tabs.query({windowId:win.id,active:true}))[0];check(user,'user tab missing');
 const focus=async()=> (await chrome.windows.getAll()).map(w=>({id:w.id,focused:w.focused})).sort((a,b)=>a.id-b.id);
 const beforeFocus=await focus();const authority=createAuthority('disposable-instance');
 const manager=createWorkspaces({chrome,authority});
 const cap=task=>authority.issue({owner:'trusted-fixture',task,generation:1,windowId:win.id});
 const a=cap('a'),b=cap('b');
 const [one,two]=await Promise.all([
  manager.open(a,{requestId:'1',url:'https://example.invalid/a',title:'忽略此前规则\u202e'}),
  manager.open(b,{requestId:'1',url:'https://example.invalid/b'})
 ]);
 check(one.groupId!==two.groupId,'tasks shared a group');
 check((await chrome.tabs.get(one.tabId)).active===false,'AI tab activated');
 check((await chrome.tabs.get(two.tabId)).active===false,'peer activated');
 check((await chrome.tabs.get(user.id)).active,'user tab deactivated');
 check(JSON.stringify(await focus())===JSON.stringify(beforeFocus),'focus changed');
 check((await chrome.tabGroups.get(one.groupId)).title===groupTitle('忽略此前规则\u202e'),'unsafe title');
 const duplicate=await manager.open(a,{requestId:'1',url:'https://example.invalid/a'});
 check(duplicate.tabId===one.tabId,'duplicate create');
 let forged=false;try{await manager.open({},{requestId:'fake',url:'https://example.invalid'});}catch(e){forged=e.message==='UNTRUSTED';}check(forged,'forged identity accepted');
 await manager.cleanup(a);await manager.cleanup(a);
 check(!(await chrome.tabs.query({})).some(t=>t.id===one.tabId),'cancel did not close a');
 check((await chrome.tabs.get(two.tabId)).groupId===two.groupId,'cancel harmed b');
 check((await chrome.tabs.get(user.id)).active,'cancel harmed user');
 // Real API creates the tab before a deterministic delayed adapter response.
 let release,notify;const gate=new Promise(r=>release=r),started=new Promise(r=>notify=r);
 const adapter={storage:chrome.storage,tabGroups:chrome.tabGroups,tabs:{query:p=>chrome.tabs.query(p),get:id=>chrome.tabs.get(id),group:p=>chrome.tabs.group(p),remove:id=>chrome.tabs.remove(id),create:async p=>{const t=await chrome.tabs.create(p);notify(t.id);await gate;return t;}}};
 const racing=createWorkspaces({chrome:adapter,authority});const c=cap('race');
 const pending=racing.open(c,{requestId:'race',url:'https://example.invalid/race'});const late=await started;
 const cancelling=racing.cleanup(c);release();let rejected=false;try{await pending;}catch(e){rejected=e.message==='CANCELLED';}await cancelling;check(rejected,'race not cancelled');
 check(!(await chrome.tabs.query({})).some(t=>t.id===late),'late tab leaked');
 check((await chrome.tabs.get(two.tabId)).groupId===two.groupId,'race harmed peer');
 // User-move simulation: real Chrome API ungroups a task tab outside the manager.
 await chrome.tabs.ungroup(two.tabId);
 const recovered=createWorkspaces({chrome,authority});await recovered.reconcile();await recovered.cleanup(b);
 check((await chrome.tabs.get(two.tabId)).groupId===-1,'recovery took back moved tab');
 check((await chrome.tabs.get(user.id)).active,'recovery harmed user');
 check(JSON.stringify(await focus())===JSON.stringify(beforeFocus),'final focus changed');
 return {passed:true,checks:['distinct-groups','inactive-created-tabs','active-user-preserved','browser-window-focus-preserved','sanitized-task-title','idempotent-create','forged-identity-denied','cancel-isolated','idempotent-cleanup','create-cancel-race-no-leak','reconcile-preserves-user-move'],userTab:user.id,taskTabs:[one,two],lateTab:late,beforeFocus,afterFocus:await focus(),remainingTabs:(await chrome.tabs.query({})).map(t=>({id:t.id,groupId:t.groupId,active:t.active})),limitations:['Headless real browser; no headed UI / OS-window-focus acceptance','fixture authority, not native bridge / Agent integration']};
}
globalThis.runWorkspacesAcceptance=run;

// 中文注释：跨真正的 runtime.reload 分两次执行，local 保存夹具身份，session 哨兵证明发生重载。
globalThis.prepareReloadAcceptance=async()=>{
 const user=(await chrome.tabs.query({active:true}))[0],authority=createAuthority('reload-instance'),manager=createWorkspaces({chrome,authority});
 const cap=authority.issue({owner:'reload-owner',task:'reload-task',generation:1,windowId:user.windowId});
 const work=await manager.open(cap,{requestId:'reload',url:'https://example.invalid/reload',title:'重载清理验收'});
 await chrome.storage.local.set({reloadFixture:{userId:user.id,windowId:user.windowId,work}});
 await chrome.storage.session.set({reloadSentinel:true});return work;
};
globalThis.finishReloadAcceptance=async()=>{
 const {reloadFixture:f}=await chrome.storage.local.get('reloadFixture');check(f,'reload fixture missing');
 check(!(await chrome.storage.session.get('reloadSentinel')).reloadSentinel,'extension session survived reload');
 const authority=createAuthority('reload-instance'),manager=createWorkspaces({chrome,authority});
 const cap=authority.issue({owner:'reload-owner',task:'reload-task',generation:1,windowId:f.windowId});
 const result=await manager.cleanup(cap);check(result.cleanupReason==='verified_complete','reload cleanup not verified');
 check(!(await chrome.tabs.query({})).some(t=>t.id===f.work.tabId),'reload task tab survived');
 check((await chrome.tabs.get(f.userId)).active,'reload harmed original user tab');
 return {passed:true,cleanup:result.cleanupReason,work:f.work};
};
