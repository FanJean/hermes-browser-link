// 中文注释：任务下载归属。只有任务标签页的 CDP 下载事件与浏览器下载项一一对应时才认领；
// 同一网址出现并发下载、任务已撤销或标签页租约变化时一律交还浏览器默认目录，不认领、不取消用户文件。
export const DECISION_DELAY_MS=300;
export const PEER_WINDOW_MS=1500;
export const BEGIN_TTL_MS=10000;
export const MAX_DOWNLOAD_BYTES=100*1024*1024;
export const MAX_ACTIVE_DOWNLOADS=10;
const MAX_TRACKED=512;

// 中文注释：文件名只保留最后一段并去掉控制字符、路径分隔符和前导点，避免借文件名逃出暂存目录。
export function safeDownloadName(value){
 const raw=String(value||'').replace(/\\/g,'/').split('/').pop()||'';
 let name=[...raw].map(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127||'<>:"|?*'.includes(char)?'_':char).join('').replace(/^[.\s]+/,'').trim();
 if(!name)name='download';
 if(name.length>180){const dot=name.lastIndexOf('.');const ext=dot>0&&name.length-dot<=16?name.slice(dot):'';name=name.slice(0,180-ext.length)+ext;}
 return name;
}

export class DownloadTracker{
 constructor(executor,{report=async()=>{},now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms)}={}){
  this.executor=executor;this.report=report;this.now=now;this.setTimer=setTimer;
  this.begins=[];this.items=new Map();this.attributed=new Map();this.pollTimer=null;
 }
 get api(){return this.executor.api.downloads;}
 activeTasks(){return [...this.executor.tasks.values()].filter(t=>!t.revoked&&t.downloadKey);}
 prune(){
  const cutoff=this.now()-BEGIN_TTL_MS;
  this.begins=this.begins.filter(item=>item.at>=cutoff).slice(-MAX_TRACKED);
  for(const [id,item] of this.items)if(item.at<cutoff)this.items.delete(id);
  while(this.items.size>MAX_TRACKED)this.items.delete(this.items.keys().next().value);
  // 中文注释：只回收跟踪状态，不取消或删除用户的下载；已结束条目由 daemon 保存元信息。
  for(const [id,row] of this.attributed){
   const task=this.executor.tasks.get(row.taskId);
   if(!task||task.revoked||task.generation!==row.generation)this.attributed.delete(id);
  }
  for(const [id,row] of this.attributed){
   if(this.attributed.size<=MAX_TRACKED)break;
   if(row.state!=='in_progress')this.attributed.delete(id);
  }
 }
 // 中文注释：只记录当前任务租约内标签页（含其子 frame 会话）发出的下载开始事件。
 observeCdp(source,method,params){
  if(method!=='Page.downloadWillBegin'||typeof params?.url!=='string')return;
  const tabId=source?.tabId,taskId=this.executor.leases.get(tabId),t=this.executor.tasks.get(taskId);
  if(!Number.isInteger(tabId)||!t||t.revoked||!t.downloadKey)return;
  this.prune();
  this.begins.push({taskId:t.id,generation:t.generation,tabId,url:params.url,guid:String(params.guid||''),
   suggested:String(params.suggestedFilename||''),at:this.now(),used:false});
 }
 created(item){
  if(!Number.isInteger(item?.id))return;
  this.prune();
  this.items.set(item.id,{url:item.url||'',finalUrl:item.finalUrl||'',at:this.now()});
 }
 // 中文注释：Chrome 在确定文件名前暂停写盘；没有活动任务时立即交还默认目录，避免拖慢用户下载。
 determine(item,suggest){
  if(!Number.isInteger(item?.id)||!this.activeTasks().length){suggest();return false;}
  if(!this.items.has(item.id))this.created(item);
  this.setTimer(()=>{
   let decision;
   try{decision=this.decide(item);}catch{decision={attribute:false};}
   if(!decision.attribute){
    try{suggest();}catch{}
    for(const begin of decision.ambiguous||[])void this.send(begin,{event:'ambiguous',url:begin.url});
    return;
   }
   const {begin,task}=decision,filename=safeDownloadName(item.filename||begin.suggested);
   const record={taskId:task.id,generation:task.generation,tabId:begin.tabId,url:begin.url,filename,state:'in_progress',reported:0};
   this.attributed.set(item.id,record);
   try{suggest({filename:`hermes-tasks/${task.downloadKey}/${filename}`,conflictAction:'uniquify'});}
   catch{this.attributed.delete(item.id);return;}
   void this.send(record,{event:'attributed',downloadRef:item.id,url:begin.url,filename,
    mimeType:typeof item.mime==='string'?item.mime.slice(0,128):'',totalBytes:Number.isSafeInteger(item.totalBytes)?item.totalBytes:-1});
   const active=[...this.attributed.values()].filter(row=>row.taskId===task.id&&row.state==='in_progress').length;
   if(active>MAX_ACTIVE_DOWNLOADS)void this.cancelRef(item.id,'rejected_limit');
   else if(Number.isSafeInteger(item.totalBytes)&&item.totalBytes>MAX_DOWNLOAD_BYTES)void this.cancelRef(item.id,'rejected_size');
   this.schedulePoll();
  },DECISION_DELAY_MS);
  return true;
 }
 decide(item){
  this.prune();
  const created=this.items.get(item.id)?.at??this.now();
  const urls=new Set([item.url,item.finalUrl].filter(value=>typeof value==='string'&&value));
  const begins=this.begins.filter(begin=>!begin.used&&urls.has(begin.url));
  if(!begins.length)return {attribute:false};
  const peers=[...this.items].filter(([id,value])=>id!==item.id&&!this.attributed.has(id)
   &&(urls.has(value.url)||urls.has(value.finalUrl))&&Math.abs(value.at-created)<=PEER_WINDOW_MS);
  // 中文注释：URL 相同但时间不能对应时仍属歧义，防止旧任务事件认领后来的用户下载。
  if(begins.length!==1||peers.length||Math.abs(begins[0].at-created)>PEER_WINDOW_MS){for(const begin of begins)begin.used=true;return {attribute:false,ambiguous:begins};}
  const begin=begins[0],task=this.executor.tasks.get(begin.taskId);
  begin.used=true;
  if(!task||task.revoked||task.generation!==begin.generation||!task.downloadKey||this.executor.leases.get(begin.tabId)!==task.id)
   return {attribute:false,ambiguous:[begin]};
  return {attribute:true,begin,task};
 }
 async send(record,payload){
  try{await this.report({taskId:record.taskId,generation:record.generation,tabId:record.tabId,...payload});}catch{}
 }
 async changed(delta){
  const record=this.attributed.get(delta?.id);
  if(!record)return;
  const state=delta.state?.current;
  if(state==='complete'||state==='interrupted')await this.finish(delta.id,record);
 }
 async finish(id,record){
  let item;
  try{[item]=await this.api.search({id});}catch{item=null;}
  if(!item)return;
  if(item.state==='complete'&&record.state==='in_progress'){
   record.state='complete';
   await this.send(record,{event:'complete',downloadRef:id,path:String(item.filename||''),
    bytesReceived:item.bytesReceived,totalBytes:item.totalBytes,fileSize:item.fileSize,
    danger:typeof item.danger==='string'?item.danger:'unknown',exists:item.exists!==false});
  }else if(item.state==='interrupted'&&record.state==='in_progress'){
   record.state=record.cancelReason||'interrupted';
   await this.send(record,{event:record.cancelReason||'interrupted',downloadRef:id,
    error:typeof item.error==='string'?item.error.slice(0,64):'unknown'});
  }
 }
 schedulePoll(){
  if(this.pollTimer)return;
  this.pollTimer=this.setTimer(async()=>{
   this.pollTimer=null;this.prune();
   const open=[...this.attributed].filter(([,row])=>row.state==='in_progress');
   if(!open.length)return;
   let items=[];
   try{items=await this.api.search({state:'in_progress'});}catch{}
   for(const item of items){
    const record=this.attributed.get(item.id);if(!record||record.state!=='in_progress')continue;
    // 中文注释：超出单文件上限时只取消本任务已确认归属的下载，不截断、不删除用户文件。
    if(item.bytesReceived>MAX_DOWNLOAD_BYTES||(item.totalBytes>MAX_DOWNLOAD_BYTES))await this.cancelRef(item.id,'rejected_size');
    else if(item.bytesReceived!==record.reported){record.reported=item.bytesReceived;
     await this.send(record,{event:'progress',downloadRef:item.id,bytesReceived:item.bytesReceived,totalBytes:item.totalBytes});}
   }
   for(const [id,record] of open)if(record.state==='in_progress'&&!items.some(item=>item.id===id))await this.finish(id,record);
   if([...this.attributed.values()].some(row=>row.state==='in_progress'))this.schedulePoll();
  },1000);
 }
 async cancelRef(id,reason='cancelled'){
  const record=this.attributed.get(id);
  if(!record||record.state!=='in_progress')return false;
  record.cancelReason=reason;
  try{await this.api.cancel(id);}catch{return false;}
  await this.finish(id,record);
  if(record.state==='in_progress'){record.state=reason;await this.send(record,{event:reason,downloadRef:id});}
  return true;
 }
 // 中文注释：取消只作用于本任务、本代次、已确认归属的下载项。
 async cancel({taskId,generation,downloadRef}){
  const t=this.executor.tasks.get(taskId);this.executor.check(t,{generation});
  const record=this.attributed.get(downloadRef);
  if(!record||record.taskId!==taskId||record.generation!==generation)throw Error('DOWNLOAD_NOT_OWNED');
  if(record.state!=='in_progress')return {cancelled:false,state:record.state};
  return {cancelled:await this.cancelRef(downloadRef,'cancelled'),state:record.state};
 }
}
