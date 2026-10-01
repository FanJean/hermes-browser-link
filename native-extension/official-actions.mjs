// Bounded official-helper CDP operations; only Executor supplies trusted scope.
import {origin} from './core.mjs';

// 中文注释：chrome.debugger.getTargets 的目标编号字段是 id（旧测试替身用 targetId），两者都接受。
export const debuggerTargetId=item=>typeof item?.id==='string'&&item.id?item.id:typeof item?.targetId==='string'&&item.targetId?item.targetId:null;

export async function targetFor(executor,task,tabId,guard) {
 const tabs=await executor.api.debugger.getTargets();guard();
 const matches=tabs.filter(item=>item?.tabId===tabId&&item.type==='page'&&debuggerTargetId(item));
 if(matches.length!==1||executor.leases.get(tabId)!==task.id)throw Error('TARGET_UNAVAILABLE');
 return debuggerTargetId(matches[0]);
}

export async function readyState(executor,task,p,guard) {
 const tab=await executor.api.tabs.get(p.tabId);guard();executor.allowed(task,tab.url);
 const id=await targetFor(executor,task,p.tabId,guard);
 // 中文注释：普通工作页由租约限定；官方建页仍核对其登记的目标身份。
 if(task.officialTargets?.has(p.tabId)&&task.officialTargets.get(p.tabId)!==id)throw Error('TARGET_UNAVAILABLE');
 const target={tabId:p.tabId};
 if(!executor.attached.has(p.tabId)){
  await executor.api.debugger.attach(target,'1.3');guard();executor.attached.add(p.tabId);
 }
 const doc=executor.docs.get(p.tabId)||0;
 const tree=await executor.checkedFrameTree(target,task,guard,false);
 if(origin(tree.frame.url)!==origin(tab.url))throw Error('DOCUMENT_CHANGED');
 const world=await executor.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{
  frameId:tree.frame.id,worldName:'hermes-official-ready-state',grantUniveralAccess:false});guard();
 const receipt=await executor.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{
  executionContextId:world.executionContextId,
  functionDeclaration:'function(){return document.readyState}',arguments:[],returnByValue:true});guard();
 if(receipt.exceptionDetails||!['loading','interactive','complete'].includes(receipt.result?.value))throw Error('DOCUMENT_CHANGED');
 if(doc!==(executor.docs.get(p.tabId)||0))throw Error('DOCUMENT_CHANGED');
 const after=await executor.api.tabs.get(p.tabId);guard();executor.allowed(task,after.url);
 const afterTree=await executor.checkedFrameTree(target,task,guard,false);
 if(afterTree.frame.id!==tree.frame.id||afterTree.frame.loaderId!==tree.frame.loaderId||origin(after.url)!==origin(tab.url))throw Error('DOCUMENT_CHANGED');
 return {readyState:receipt.result.value};
}

export async function navigate(executor,task,p,guard) {
 executor.allowed(task,p.url);
 const target={tabId:p.tabId};
 const current=await executor.api.tabs.get(p.tabId);guard();
 const blank=task.officialBlank?.has(p.tabId)&&current.url==='about:blank';
 if(!blank)executor.allowed(task,current.url);
 const id=await targetFor(executor,task,p.tabId,guard);
 if(task.officialTargets?.get(p.tabId)!==id)throw Error('TARGET_UNAVAILABLE');
 if(!executor.attached.has(p.tabId)){
  await executor.api.debugger.attach(target,'1.3');guard();executor.attached.add(p.tabId);
 }
 const before=await executor.api.debugger.sendCommand(target,'Page.getFrameTree',{});guard();
 const frame=before.frameTree?.frame;
 if(!frame?.id||(!blank&&origin(frame.url)!==origin(current.url)))throw Error('DOCUMENT_CHANGED');
 if(blank&&frame.url!=='about:blank')throw Error('DOCUMENT_CHANGED');
 if(!blank)executor.allowed(task,frame.url);
 await executor.closeTabResources(task,p.tabId,null,{keepOverlay:true});guard();
 const receipt=await executor.api.debugger.sendCommand(target,'Page.navigate',{url:p.url,frameId:frame.id});guard();
 if(!receipt||receipt.frameId!==frame.id||typeof receipt.frameId!=='string')throw Error('DOCUMENT_CHANGED');
 for(const key of Object.keys(receipt))if(!['frameId','loaderId','errorText','isDownload'].includes(key))throw Error('DOCUMENT_CHANGED');
 const after=await executor.api.tabs.get(p.tabId);guard();
 // A loading tab can still expose its previous committed URL, never use it as permission.
 if(after.url&&after.url!=='about:blank')executor.allowed(task,after.url);
 if(await targetFor(executor,task,p.tabId,guard)!==id)throw Error('TARGET_UNAVAILABLE');
 return receipt;
}

export async function openTab(executor,task,p,guard) {
 // Workspace creates only allowed http(s) tabs; a blank destination is subsequently
 // changed by Page.navigate, never inserted into allowedOrigins or read as web content.
 const blank=p.url==='about:blank';
 const seed=blank?task.allowedOrigins[0]+'/':p.url;
 executor.allowed(task,seed);
 const opened=await executor.openOwnedTab(task,{...p,action:'new_tab'},guard,seed);
 const tabId=opened.tabId,target={tabId};
 // 中文注释：后台补遮罩也会附加 debugger；官方建页必须与它共用标签页锁，避免重复 attach。
 return executor.lock(tabId,async()=>{
  const targetId=await targetFor(executor,task,tabId,guard);
  if(!executor.attached.has(tabId)){
   await executor.api.debugger.attach(target,'1.3');guard();executor.attached.add(tabId);
  }
  if(blank){
   const tree=await executor.checkedFrameTree(target,task,guard,false);
   if(!task.officialBlank)task.officialBlank=new Set();task.officialBlank.add(tabId);
   // 中文注释：种子页的 onUpdated 事件可能晚于空白页事件到达，记录其确切 URL 以拒绝过期通知。
   if(!task.officialBlankSeeds)task.officialBlankSeeds=new Map();task.officialBlankSeeds.set(tabId,seed);
   if(!task.officialBlankSeen)task.officialBlankSeen=new Set();
   const receipt=await executor.api.debugger.sendCommand(target,'Page.navigate',{url:'about:blank',frameId:tree.frame.id});guard();
   if(receipt?.frameId!==tree.frame.id)throw Error('DOCUMENT_CHANGED');
   const after=await executor.api.tabs.get(tabId);guard();
   if(after.url!=='about:blank'&&after.pendingUrl!=='about:blank')throw Error('DOCUMENT_CHANGED');
   if(after.url==='about:blank')task.officialBlankSeen.add(tabId);
  }
  if(!task.officialTargets)task.officialTargets=new Map();task.officialTargets.set(tabId,targetId);
  return {targetId,tabId,groupId:opened.groupId,windowId:opened.windowId};
 });
}
