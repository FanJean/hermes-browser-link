// 中文注释：工作窗口仅由本扩展创建，以固定的扩展首页验证身份，避免重启后复用用户窗口编号。
export const INPUT_ACTIONS=new Set(['click','fill','press','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','interaction.click','interaction.drag_coordinates','interaction.drag_elements','scroll']);
const KEY='hermes.workWindow.v1';
export class WorkWindow {
 constructor(api){this.api=api;this.pending=null;this.windowId=null;this.tails=new Map();}
 async ensure(){
  if(this.pending)return this.pending;
  this.pending=this.resolve();
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
  const win=await this.api.windows.create({url:marker,type:'normal',focused:false,state:'normal'});
  const tab=win.tabs?.[0];
  if(!Number.isInteger(win.id)||!Number.isInteger(tab?.id))throw Error('WORK_WINDOW_UNAVAILABLE');
  this.windowId=win.id;
  await this.api.storage.local.set({[KEY]:{windowId:win.id,tabId:tab.id}});
  return win.id;
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
