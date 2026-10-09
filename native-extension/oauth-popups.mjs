// 中文注释：仅跟踪授权操作之后新建的独立 popup；发现不授予页面或清理权限。
// core 提供任务/租约校验，审批前和确认后使用同一份脱敏身份快照。
const OBSERVATION_MS=30000,CANDIDATE_MS=120000,MAX_CANDIDATES=32;
const denied=()=>Object.assign(Error('POPUP_STALE'),{preDispatch:true});
const site=url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw denied();return u.origin;};
const identity=tab=>({tabId:tab.id,windowId:tab.windowId,origin:site(tab.url)});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class OAuthPopups{
 constructor(executor){this.executor=executor;this.observations=new Map();this.candidates=new Map();}
 invalidate(tabId,event){
  this.observations.delete(tabId);
  for(const [ref,row] of this.candidates)if(row.source.tabId===tabId||event==='closed'&&row.tabId===tabId)this.candidates.delete(ref);
 }
 current(source,candidateRef){
  const row=this.candidates.get(candidateRef);
  if(!row||row.expiresAt<=Date.now()||!same(row.source,source)||(this.executor.docs.get(source.tabId)||0)!==source.documentGeneration)throw denied();
 }
 prune(){const now=Date.now();for(const [id,row] of this.observations)if(row.expiresAt<=now||row.task.revoked)this.observations.delete(id);for(const [ref,row] of this.candidates)if(row.expiresAt<=now||row.task.revoked)this.candidates.delete(ref);}
 async source(task,tabId,guard){const tab=await this.executor.api.tabs.get(tabId).catch(()=>{throw denied();});guard();if(!task.allowedOrigins.includes(site(tab.url))||tab.pendingUrl&&site(tab.pendingUrl)!==site(tab.url))throw denied();return {...identity(tab),documentGeneration:this.executor.docs.get(tabId)||0};}
 async arm(task,tabId,guard){this.prune();const source=await this.source(task,tabId,guard);this.observations.set(tabId,{task,generation:task.generation,source,expiresAt:Date.now()+OBSERVATION_MS});return source;}
 async recoverCreated(tab){
  this.prune();
  if(!Number.isInteger(tab?.id)||!Number.isInteger(tab.windowId)||!this.observations.size||!this.executor.api.tabs?.get)return false;
  // 中文注释：Edge 的 onCreated 可缺 opener；只补读本次新建页，不能借后来的观察认领旧页。
  const observations=new Map(this.observations);
  const fresh=await this.executor.api.tabs.get(tab.id).catch(()=>null);
  if(!fresh||fresh.id!==tab.id||fresh.windowId!==tab.windowId)return false;
  return this.created(fresh,observations);
 }
 created(tab,observations=this.observations){
  this.prune();const observation=observations.get(tab?.openerTabId);
  if(!observation||this.observations.get(tab.openerTabId)!==observation||observation.expiresAt<=Date.now()||observation.task.revoked||observation.task.generation!==observation.generation||this.executor.leases.get(tab.openerTabId)!==observation.task.id||!Number.isInteger(tab.id)||tab.windowId===observation.source.windowId||this.executor.leases.has(tab.id))return false;
  if(this.candidates.size>=MAX_CANDIDATES)return true;
  const candidateRef=crypto.randomUUID();this.candidates.set(candidateRef,{...observation,candidateRef,tabId:tab.id,windowId:tab.windowId,expiresAt:Date.now()+CANDIDATE_MS});return true;
 }
 async inspect(task,tabId,candidateRef,guard){
  this.prune();const row=this.candidates.get(candidateRef);
  if(!row||row.task!==task||row.generation!==task.generation||row.source.tabId!==tabId||this.executor.leases.has(row.tabId))throw denied();
  const source=await this.source(task,tabId,guard);if(!same(source,row.source))throw denied();
  const tab=await this.executor.api.tabs.get(row.tabId).catch(()=>{throw denied();});guard();
  const window=await this.executor.api.windows.get(tab.windowId).catch(()=>{throw denied();});guard();
  if(window.type!=='popup'||tab.windowId!==row.windowId||tab.openerTabId!==tabId||tab.windowId===source.windowId||this.executor.leases.has(tab.id)||tab.pendingUrl&&site(tab.pendingUrl)!==site(tab.url))throw denied();
  const candidate={candidateRef,tabId:tab.id,windowId:tab.windowId,openerTabId:tab.openerTabId,origin:site(tab.url),windowType:'popup'};
  // 中文注释：查询窗口期间源页或 popup 可能已导航/移动；发布身份前再读回两端。
  const latestSource=await this.source(task,tabId,guard);
  const latestTarget=await this.executor.api.tabs.get(row.tabId).catch(()=>{throw denied();});guard();
  if(!same(latestSource,source)||!same(identity(latestTarget),identity(tab))||latestTarget.openerTabId!==tabId||this.executor.leases.has(row.tabId)||latestTarget.pendingUrl&&site(latestTarget.pendingUrl)!==candidate.origin)throw denied();
  this.current(source,candidateRef);
  if(row.candidate&&!same(candidate,row.candidate))throw denied();row.candidate=candidate;
  return {source,candidate};
 }
 async catalog(task,p,guard){
  await this.arm(task,p.tabId,guard);const candidates=[];
  for(const row of this.candidates.values())if(row.task===task&&row.source.tabId===p.tabId){try{candidates.push((await this.inspect(task,p.tabId,row.candidateRef,guard)).candidate);}catch(error){guard();if(error?.message!=='POPUP_STALE')throw error;}}
  guard();return {sourceTabId:p.tabId,observationMs:OBSERVATION_MS,candidates};
 }
}
