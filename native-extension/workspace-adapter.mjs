import {WorkWindow,INPUT_ACTIONS} from './work-window.mjs';
import {createAuthority,createWorkspaces,groupTitle,registerWorkspaceStartup} from '../browser-workspaces/index.mjs';
// 中文注释：扩展入口统一复用适配器导出，构建只需维护一个 workspace 依赖映射。
export {groupTitle,registerWorkspaceStartup};
// Private to trusted Executor approval installation; never exposed by Bridge RPC.
export class NativeWorkspaces {
 constructor(api,instance,isTabLeased=()=>false){
  this.api=api;this.workWindow=new WorkWindow(api);this.authority=createAuthority(instance);
  const guarded={runtime:api.runtime,storage:api.storage,tabGroups:api.tabGroups,tabs:{query:p=>api.tabs.query(p),get:id=>api.tabs.get(id),remove:id=>api.tabs.remove(id),ungroup:id=>api.tabs.ungroup(id),group:p=>api.tabs.group(p),create:async p=>{
   const tab=await api.tabs.create(p);if(isTabLeased(tab.id))throw Error('new tab lease conflict');return tab;
  }}};
  this.manager=createWorkspaces({chrome:guarded,authority:this.authority});
  this.recovered=new Map();
  this.ready=(async()=>{
   await this.manager.ready;
   const journal=(await api.storage.local.get('hermes.backgroundWorkspaces.v1'))['hermes.backgroundWorkspaces.v1'];
   if(journal?.instance!==instance)return;
   // 中文注释：只从扩展 local 日志恢复清理句柄，读取须等待启动撤权屏障。
   const entries=journal.tasks.map(([key,t])=>({key,t,id:JSON.parse(key)})).sort((a,b)=>a.id[3]-b.id[3]);
   for(const {key,t,id:[storedInstance,owner,task,generation]} of entries){
    if(storedInstance!==instance)throw Error('WORKSPACE_INSTANCE_MISMATCH');
    this.recovered.set(key,this.authority.issue({owner,task,generation,windowId:t.windowId}));
   }
  })();
 }
 async install(task,tabs){
  await this.ready;
  if(task.instanceId!==this.authority.instance)throw Error('WORKSPACE_INSTANCE_MISMATCH');
  // 中文注释：原授权页不移动；新建任务组默认始终进入独立工作窗口。
  const owner=JSON.stringify([task.instanceId,task.approvalScope,task.id,task.generation]);
  const windowId=task.workWindowMode==='current'?(tabs[0]?.windowId??(await this.api.windows.getCurrent()).id):await this.workWindow.ensure(owner);
  this.workWindow.retain(owner,windowId);
  let cap;
  try{cap=this.authority.issue({owner:task.approvalScope,task:task.id,generation:task.generation,windowId});await this.manager.start(cap);}
  catch(error){await this.workWindow.closeIdle(owner,windowId);throw error;}
  return cap;
 }
 // 中文注释：只在本扩展工作窗口内切前台；用户拖走的工作页继续遵循既有所有权规则。
 async withInput(task,p,guard,work){
  if(task.workWindowMode==='current'||(!INPUT_ACTIONS.has(p.action)&&!(p.action==='cdp.send'&&p.method?.startsWith('Input.')))||!task.workspaceCapability)return work();
  const windowId=this.authority.resolve(task.workspaceCapability).windowId;
  if(windowId!==this.workWindow.windowId||!task.agentTabs.has(p.tabId))return work();
  const tab=await this.api.tabs.get(p.tabId);guard();
  if(tab.windowId!==windowId||tab.groupId!==task.agentTabGroups?.get(p.tabId))return work();
  return this.workWindow.input(windowId,p.tabId,guard,work);
 }
 async open(cap,p){
  try{return await this.manager.open(cap,{requestId:p.requestId,url:p.url,title:p.title});}
  catch(error){
   // 中文注释：创建回执撞上已有租约只拒绝该请求，不将整个任务标成工作区未知。
   if(error?.message==='new tab lease conflict')throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:false});
   if(['CANCELLED','RELEASED','STALE','INVALID_URL','INVALID_REQUEST','UNTRUSTED'].includes(error?.message))throw error;
   const unknown=Error('工作页结果不确定，请人工核对；不会自动重试');unknown.code='workspace_unknown';throw unknown;
  }
 }
 spawned(cap,tab){return this.manager.spawned(cap,tab);}
 cleanupStatus(cap){return this.manager.status(cap);}
 // 中文注释：工作页清理成功后才释放窗口占用；失败和未知结果不触发空窗口删除。
 async cleanup(cap,options={}){
  const deadline=Date.now()+Math.max(1,Math.min(options.timeoutMs??2000,2000));
  const result=await this.manager.cleanup(cap,options);
  if(result.cleanupState==='succeeded'){
   const id=this.authority.resolve(cap,{allowStale:true}),owner=JSON.stringify([id.instance,id.owner,id.task,id.generation]);
   await this.workWindow.closeIdle(owner,id.windowId,{...options,timeoutMs:Math.max(0,deadline-Date.now())});
  }
  return result;
 }
 // 中文注释：当前 worker 的能力与重载能力共用同一收组实现。
 ungroup(cap,options){return this.manager.ungroup(cap,options);}
 // 中文注释：终态收组只接受扩展 local 日志恢复的能力，daemon 传来的标题和组号不能生成能力。
 async ungroupTerminal(taskId,generation,options){
  await this.ready;
  const cap=[...this.recovered].find(([key])=>{const id=JSON.parse(key);return id[2]===taskId&&id[3]===generation;})?.[1];
  if(!cap)return {cleanupState:'unknown',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[],cleanupReason:'no_journal'};
  return this.manager.ungroup(cap,options);
 }
 async cleanupRecovered(taskId,generation,options){
  await this.ready;
  for(const [key,cap] of this.recovered){const [, ,task,gen]=JSON.parse(key);if(task===taskId&&gen===generation)await this.cleanup(cap,options);}
 }
 async status(){
  await this.ready;
  await this.manager.reconcile();
  const journal=(await this.api.storage.local.get('hermes.backgroundWorkspaces.v1'))['hermes.backgroundWorkspaces.v1'];
  return (journal?.tasks||[]).map(([key,t])=>{const [, ,taskId,generation]=JSON.parse(key),requests=t.requests.map(([,r])=>r),unknown=requests.filter(r=>r.status==='unknown'||r.status==='pending').length;
   return {taskId,generation,state:unknown?'unknown':journal.preserved?.includes(key)?'preserved':journal.cancelled.includes(key)?'cancelled':'ready',unknown,tabs:requests.filter(r=>Number.isInteger(r.tabId)).map(r=>({tabId:r.tabId,windowId:t.windowId,groupId:r.groupId??null,state:r.status}))};});
 }
}
