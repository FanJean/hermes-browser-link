// 中文注释：工作窗口仅由本扩展创建，以固定的扩展首页验证身份，避免重启后复用用户窗口编号。
export const INPUT_ACTIONS=new Set(['click','fill','press','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','interaction.click','interaction.drag_coordinates','interaction.drag_elements','scroll']);
const KEY='hermes.workWindow.v1';
export class WorkWindow {
 constructor(api){this.api=api;this.pending=null;this.windowId=null;this.tails=new Map();this.owners=new Map();this.lifecycle=Promise.resolve();}
 // 中文注释：窗口创建与空窗口回收共用队列，避免关闭检查和新任务创建交错。
 enqueue(work){const next=this.lifecycle.catch(()=>{}).then(work);this.lifecycle=next.catch(()=>{});return next;}
 retain(owner,windowId){this.owners.set(owner,windowId);}
 async ensure(owner){
  if(owner!==undefined)this.retain(owner,null);
  try{const windowId=await this.ensureWindow();if(owner!==undefined)this.retain(owner,windowId);return windowId;}
  catch(error){if(owner!==undefined)this.owners.delete(owner);throw error;}
 }
 async ensureWindow(){
  if(this.pending)return this.pending;
  this.pending=this.enqueue(()=>this.resolve());
  try{return await this.pending;}finally{this.pending=null;}
 }
 async resolve(){
  const marker=this.api.runtime.getURL('work-window.html');
  const stored=(await this.api.storage.local.get(KEY))[KEY];
  if(Number.isInteger(stored?.windowId)&&Number.isInteger(stored?.tabId)){
   try{
    const tab=await this.api.tabs.get(stored.tabId);
    const win=await this.api.windows.get(stored.windowId);
    if(tab.windowId===win.id&&tab.url===marker){this.windowId=win.id;return win.id;}
   }catch{/* 中文注释：已关闭的工作窗口下次建页时重建，不恢复用户拖走的标签。 */}
  }
  // 中文注释：浏览器恢复会改变窗口和标签编号；用完整扩展首页地址查找已有窗口，再更新编号。
  const markers=await this.api.tabs.query({url:marker});
  for(const tab of markers){
   if(tab.url!==marker||!Number.isInteger(tab.id)||!Number.isInteger(tab.windowId))continue;
   const win=await this.api.windows.get(tab.windowId);
   if(win.type!=='normal')continue;
   this.windowId=win.id;
   await this.api.storage.local.set({[KEY]:{windowId:win.id,tabId:tab.id}});
   return win.id;
  }
  const win=await this.api.windows.create({url:marker,type:'normal',focused:false,state:'normal'});
  const tab=win.tabs?.[0];
  if(!Number.isInteger(win.id)||!Number.isInteger(tab?.id))throw Error('WORK_WINDOW_UNAVAILABLE');
  this.windowId=win.id;
  await this.api.storage.local.set({[KEY]:{windowId:win.id,tabId:tab.id}});
  return win.id;
 }
 // 中文注释：只删除已记录的扩展首页；有其他任务、结果页或用户页时保留窗口，绝不整窗删除。
 closeIdle(owner,windowId,{timeoutMs=2000,canDelete,keepTabIds=[]}={}){
  this.owners.delete(owner);
  const deadline=Date.now()+Math.max(0,Math.min(timeoutMs,2000));
  const idle=()=>Date.now()<deadline&&!this.tails.has(windowId)&&![...this.owners.values()].some(id=>id===null||id===windowId);
  return this.enqueue(async()=>{
   if(!idle())return;
   const stored=(await this.api.storage.local.get(KEY))[KEY];
   if(!idle()||stored?.windowId!==windowId||!Number.isInteger(stored.tabId)||keepTabIds.includes(stored.tabId))return;
   const tabs=await this.api.tabs.query({windowId});
   if(tabs.length!==1||tabs[0].id!==stored.tabId||tabs[0].url!==this.api.runtime.getURL('work-window.html'))return;
   const tab=await this.api.tabs.get(stored.tabId);
   if(!idle()||tab.windowId!==windowId||tab.url!==tabs[0].url||(canDelete&&canDelete(tab.id)!==true))return;
   await this.api.tabs.remove(tab.id);
   if(this.windowId===windowId)this.windowId=null;
   await this.api.storage.local.set({[KEY]:null});
  });
 }
 // 中文注释：窗口内切标签与输入一起排队；只读动作从不进入该队列，也不改变活动标签。
 async input(windowId,tabId,guard,work){
  const previous=this.tails.get(windowId)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
   guard();const tab=await this.api.tabs.get(tabId);guard();
   if(tab.windowId===windowId&&!tab.active)await this.api.tabs.update(tabId,{active:true});
   guard();return work();
  });
  const settled=next.catch(()=>{});this.tails.set(windowId,settled);
  try{return await next;}finally{if(this.tails.get(windowId)===settled)this.tails.delete(windowId);}
 }
}
