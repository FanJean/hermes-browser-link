// 中文注释：凭据库填写的扩展端。只在任务完整访问、来源精确匹配且页面未执行任意脚本时工作；
// 秘密只在本次调用的参数中出现，不写入缓存、诊断或返回值。填写后该页面标记为凭据页面，不再接受任意 JS/CDP。

// 中文注释：与 Hermes 登录字段检查同一口径列出可见输入控件；元素引用只留在隔离世界内存，不在 DOM 上留标记。
export function inspectControls(nonce){
 const elements=[...document.querySelectorAll('input, select')];
 const forms=[...document.forms];
 globalThis.__hermesVaultSlots={nonce,elements:elements.map(element=>new WeakRef(element)),origin:location.origin};
 return {origin:location.origin,controls:elements.flatMap((element,index)=>{
  if(element.disabled||element.readOnly)return [];
  if(['hidden','submit','button','reset','file','image','checkbox','radio'].includes(element.type))return [];
  const style=globalThis.getComputedStyle(element);
  if(style.display==='none'||style.visibility==='hidden'||element.getClientRects().length===0)return [];
  const labels=element.labels?[...element.labels].map(label=>label.textContent||''):[];
  const aria=(element.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ');
  const formIndex=element.form?forms.indexOf(element.form):-1;
  return [{autocomplete:element.autocomplete||'',formIndex:formIndex>=0?formIndex:null,index,
   maxLength:element.maxLength>0?element.maxLength:null,
   label:[...labels,element.getAttribute('aria-label')||'',aria,element.getAttribute('placeholder')||'',element.getAttribute('title')||''].join(' ').slice(0,500),
   name:[element.name,element.id].join(' ').slice(0,300),type:element.tagName==='SELECT'?'select':(element.type||'')}];
 })};
}

// 中文注释：写入前同步核对来源与本次检查的 nonce；只报告填写数量，不回显任何值。
export function fillControls(nonce,expectedOrigin,fills){
 if(location.origin!==expectedOrigin)return {refused:'origin_changed'};
 const slots=globalThis.__hermesVaultSlots;
 if(!slots||slots.nonce!==nonce||slots.origin!==expectedOrigin)return {refused:'inspection_stale'};
 // 中文注释：先核对整批目标，避免某个字段已变化时只填入前半批秘密。
 const targets=fills.map(fill=>slots.elements[fill.index]?.deref());
 // 中文注释：检查后字段仍可能被页面禁用、隐藏或改作新密码；写入前重新核对整批字段。
 if(targets.some((element,index)=>{
  if(!element?.isConnected||!(element instanceof globalThis.HTMLInputElement)||element.disabled||element.readOnly)return true;
  const style=globalThis.getComputedStyle(element),tokens=element.autocomplete.toLowerCase().split(/\s+/);
  return style.display==='none'||style.visibility==='hidden'||element.getClientRects().length===0
   ||(fills[index].token==='current-password'&&(element.type!=='password'||tokens.includes('new-password')||tokens.includes('one-time-code')))
   ||(fills[index].token==='one-time-code'&&!tokens.includes('one-time-code'));
 }))return {refused:'inspection_stale'};
 let filled=0;
 for(const [index,fill] of fills.entries()){
  const element=targets[index];
  element.focus();
  const setter=Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype,'value')?.set;
  if(!setter)throw Error('input setter unavailable');
  setter.call(element,fill.value);
  element.dispatchEvent(new globalThis.InputEvent('input',{bubbles:true,inputType:'insertText'}));
  element.dispatchEvent(new Event('change',{bubbles:true}));
  if(element.value.length>0)filled++;
 }
 delete globalThis.__hermesVaultSlots;
 return {filled};
}

const denied=code=>Object.assign(Error(code),{preDispatch:true});

// 中文注释：凭据检查与填写都在任务浮层的持久隔离世界中执行，确保两步命中同一文档与同一组元素。
export class VaultController{
 constructor(executor){this.executor=executor;}
 async scope(p){
  const executor=this.executor,t=executor.tasks.get(p.taskId);executor.check(t,p);
  if(p.instanceId!==t.instanceId||p.modeGeneration!==t.policy.modeGeneration)throw denied('VAULT_SCOPE_CHANGED');
  if(executor.leases.get(p.tabId)!==t.id)throw denied('tab lease denied');
  if(!t.agentTabs.has(p.tabId))throw denied('tab lease denied');
  // 中文注释：私有宿主通道已经核实本次智能审批或全部访问；扩展继续校验任务代次与同页互斥。
  // 中文注释：页面执行过任意 JS/CDP 时禁止凭据填写，互斥由扩展与宿主双侧校验。
  if(t.scriptedTabs?.has(p.tabId))throw denied('CREDENTIAL_MODE_CONFLICT');
  const guard=()=>{executor.check(t,p);if(executor.leases.get(p.tabId)!==t.id||t.policy.modeGeneration!==p.modeGeneration||t.scriptedTabs?.has(p.tabId))throw Error('VAULT_SCOPE_CHANGED');};
  const target={tabId:p.tabId};
  if(!executor.attached.has(p.tabId)){await executor.api.debugger.attach(target,'1.3');guard();executor.attached.add(p.tabId);}
  const tab=await executor.api.tabs.get(p.tabId);guard();executor.allowed(t,tab.url);
  const overlay=await executor.ensureOverlay(t,p.tabId,target,guard,false);
  if(!overlay)throw denied('INTERACTION_HIGHLIGHT_UNAVAILABLE');
  return {t,guard,target,overlay};
 }
 async call(target,overlay,fn,args,guard){
  const result=await this.executor.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:overlay.contextId,
   functionDeclaration:fn.toString(),arguments:args.map(value=>({value})),returnByValue:true});guard();
  if(result.exceptionDetails)throw Error('page action failed');
  return result.result?.value;
 }
 async inspect(p){
  if(typeof p.nonce!=='string'||!/^[0-9a-f]{16,64}$/.test(p.nonce))throw denied('INVALID_VAULT_ARGS');
  return this.executor.lock(p.tabId,async()=>{
   const {t,guard,target,overlay}=await this.scope(p);
   const found=await this.call(target,overlay,inspectControls,[p.nonce],guard);
   if(!t.allowedOrigins.includes(found?.origin))throw denied('origin denied');
   return {origin:found.origin,controls:(found.controls||[]).slice(0,200),documentGeneration:this.executor.docs.get(p.tabId)||0};
  });
 }
 async fill(p){
  if(typeof p.nonce!=='string'||!/^[0-9a-f]{16,64}$/.test(p.nonce)||!['login','otp'].includes(p.kind)
   ||!Number.isInteger(p.documentGeneration)||p.documentGeneration<0
   ||!Array.isArray(p.fills)||!p.fills.length||p.fills.length>8||p.fills.some(fill=>!Number.isInteger(fill?.index)||fill.index<0
    ||!['current-password','one-time-code'].includes(fill.token)||typeof fill.value!=='string'||!fill.value||fill.value.length>4096))
   throw denied('INVALID_VAULT_ARGS');
  return this.executor.lock(p.tabId,async()=>{
   const {t,guard,target,overlay}=await this.scope(p);
   if(!t.allowedOrigins.includes(p.expectedOrigin))throw denied('origin denied');
   if((this.executor.docs.get(p.tabId)||0)!==p.documentGeneration)return {filled:0,refused:'inspection_stale'};
   // 中文注释：派发前先标记为凭据页面；即使结果未知，该页面此后也不再接受高级 JS/CDP。
   if(!t.credentialTabs)t.credentialTabs=new Set();t.credentialTabs.add(p.tabId);
   const result=await this.call(target,overlay,fillControls,[p.nonce,p.expectedOrigin,p.fills],guard);
   if(result?.refused)return {filled:0,refused:String(result.refused)};
   return {filled:Number.isInteger(result?.filled)?result.filled:0};
  });
 }
}
