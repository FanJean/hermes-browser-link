// 中文注释：任务页控制台与 JS 对话框观察。只记录租约内标签页的事件，缓冲有上限；
// 控制台只从首次读取后开始收集，不回溯此前输出。
const MAX_ENTRIES=200,MAX_TEXT=2000;
const clip=value=>String(value??'').slice(0,MAX_TEXT);

function remoteText(arg){
 if(!arg)return '';
 if(Object.hasOwn(arg,'value'))return typeof arg.value==='string'?arg.value:JSON.stringify(arg.value);
 return arg.unserializableValue||arg.description||arg.type||'';
}

export class PageObservers{
 constructor(executor){this.executor=executor;}
 taskFor(tabId){
  const t=this.executor.tasks.get(this.executor.leases.get(tabId));
  return t&&!t.revoked?t:null;
 }
 observe(source,method,params){
  const tabId=source?.tabId;if(!Number.isInteger(tabId)||source.sessionId)return;
  const t=this.taskFor(tabId);if(!t)return;
  if(method==='Page.javascriptDialogOpening'){
   if(!t.dialogs)t.dialogs=new Map();
   t.dialogs.set(tabId,{type:String(params?.type||'alert'),message:clip(params?.message),
    defaultPrompt:clip(params?.defaultPrompt),hasBrowserHandler:params?.hasBrowserHandler===true});
   return;
  }
  if(method==='Page.javascriptDialogClosed'){t.dialogs?.delete(tabId);return;}
  const buffer=t.consoleBuffers?.get(tabId);if(!buffer)return;
  let entry=null;
  if(method==='Runtime.consoleAPICalled')entry={kind:'message',type:String(params?.type||'log'),text:clip((params?.args||[]).map(remoteText).join(' '))};
  else if(method==='Runtime.exceptionThrown')entry={kind:'error',message:clip(params?.exceptionDetails?.exception?.description||params?.exceptionDetails?.text)};
  else if(method==='Log.entryAdded')entry={kind:'message',type:String(params?.entry?.level||'log'),text:clip(params?.entry?.text)};
  if(!entry)return;
  if(buffer.entries.length>=MAX_ENTRIES){buffer.dropped++;return;}
  buffer.entries.push(entry);
 }
 async console(t,p,target,guard){
  if(!t.consoleBuffers)t.consoleBuffers=new Map();
  let buffer=t.consoleBuffers.get(p.tabId);
  if(!buffer){
   buffer={entries:[],dropped:0};t.consoleBuffers.set(p.tabId,buffer);
   await this.executor.api.debugger.sendCommand(target,'Runtime.enable');guard();
   await this.executor.api.debugger.sendCommand(target,'Log.enable');guard();
  }
  const messages=buffer.entries.filter(entry=>entry.kind==='message').map(({type,text})=>({type,text}));
  const errors=buffer.entries.filter(entry=>entry.kind==='error').map(({message})=>({message}));
  const result={messages,errors,dropped:buffer.dropped,collectingSince:'first_console_read'};
  if(p.clear===true){buffer.entries=[];buffer.dropped=0;}
  return result;
 }
 pending(t,tabId){return t.dialogs?.get(tabId)||null;}
 // 中文注释：只响应当前任务页上已记录的对话框；无对话框时拒绝，不猜测。
 async handle(t,p,target,guard){
  const dialog=this.pending(t,p.tabId);
  if(!dialog)throw Object.assign(Error('NO_DIALOG'),{preDispatch:true});
  if(typeof p.accept!=='boolean'||(p.promptText!==undefined&&(typeof p.promptText!=='string'||p.promptText.length>10000)))
   throw Object.assign(Error('INVALID_DIALOG_ARGS'),{preDispatch:true});
  await this.executor.api.debugger.sendCommand(target,'Page.handleJavaScriptDialog',
   {accept:p.accept,...(p.accept&&p.promptText!==undefined?{promptText:p.promptText}:{})});guard();
  t.dialogs?.delete(p.tabId);
  return {handled:true,action:p.accept?'accept':'dismiss',dialog:{type:dialog.type,message:dialog.message}};
 }
}

// 中文注释：在隔离世界中列出页面图片；排除 data: URI，数量有上限。
export function listImages(){
 const images=[...document.images].filter(image=>image.currentSrc||image.src).filter(image=>!(image.currentSrc||image.src).startsWith('data:'));
 return {images:images.slice(0,300).map(image=>({src:String(image.currentSrc||image.src).slice(0,2048),alt:String(image.alt||'').slice(0,500),
  width:image.naturalWidth,height:image.naturalHeight})),count:images.length};
}
