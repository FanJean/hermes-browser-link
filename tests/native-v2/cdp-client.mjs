// 中文注释：真实浏览器验收仅使用临时 profile 的 CDP 连接，不依赖已删除的旧产品测试工具。
export async function fetchJson(url){
 const response=await fetch(url);
 if(!response.ok)throw Error(`CDP HTTP ${response.status}`);
 return response.json();
}

export async function activateTestExtensionTab(client,targetId,cdp){
 for(let attempt=0;;attempt++){
  try{await client.evaluate('chrome.tabs.getCurrent().then(tab=>chrome.windows.update(tab.windowId,{focused:true}).then(()=>chrome.tabs.update(tab.id,{active:true}))).then(()=>true)');break;}
  catch(error){
   // 中文注释：仅重试临时 profile 的聚焦/激活；页面输入和审批决定不在重试范围。
   if(attempt===2||!/^(?:Error: )?Tabs cannot be edited right now \(user may be dragging a tab\)\.$/.test(error.message))throw error;
   await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
  }
 }
 await cdp.call('Target.activateTarget',{targetId});
 await client.call('Emulation.setFocusEmulationEnabled',{enabled:true});
}

export async function waitFor(read,timeoutMs=15000,{label='未命名等待点',ready=Boolean}={}){
 const deadline=Date.now()+timeoutMs;
 let lastObserved,lastError;
 while(Date.now()<deadline){
  try{const value=await read();lastObserved=value;lastError=undefined;if(ready(value))return value;}
  catch(error){lastError=error instanceof Error?error.message:String(error);}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 // 中文注释：超时保留等待点、最后一次读数和读取错误，便于区分状态未变化与 CDP 读取失败。
 throw Error(`CDP acceptance wait timed out: ${label}; last=${JSON.stringify(lastObserved)}; error=${JSON.stringify(lastError)}`);
}

// 中文注释：Target 元信息可先于导航完成；只在指定扩展文档及其权限 API 全部就绪后执行夹具。
export async function waitForExtensionPage(client,{extensionId,url,timeoutMs=15000}){
 return waitFor(()=>client.evaluate(`(()=>({url:location.href,readyState:document.readyState,
  runtimeId:globalThis.chrome?.runtime?.id??null,hasRuntime:typeof globalThis.chrome?.runtime?.getURL==='function',
  hasTabs:typeof globalThis.chrome?.tabs?.get==='function',hasDebugger:typeof globalThis.chrome?.debugger?.sendCommand==='function',
  popupMounted:Boolean(document.querySelector('#connection-label'))}))()`),timeoutMs,{
  label:`扩展页面与 API 就绪 (${extensionId})`,
  ready:state=>state?.url===url&&state.readyState==='complete'&&state.runtimeId===extensionId&&
   state.hasRuntime&&state.hasTabs&&state.hasDebugger&&state.popupMounted,
 });
}

export class CdpClient{
 constructor(url){this.url=url;this.socket=null;this.pending=new Map();this.sequence=0;}
 async connect(){
  this.socket=new WebSocket(this.url);
  await new Promise((resolve,reject)=>{
   this.socket.addEventListener('open',resolve,{once:true});
   this.socket.addEventListener('error',reject,{once:true});
  });
  this.socket.addEventListener('message',event=>{
   const message=JSON.parse(event.data),entry=this.pending.get(message.id);
   if(!entry)return;
   this.pending.delete(message.id);clearTimeout(entry.timer);
   message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result);
  });
 }
 // 中文注释：可选扁平 session 用于任务 CDP 网关回归；现有浏览器直连调用不变。
 call(method,params={},sessionId){
  if(this.socket?.readyState!==WebSocket.OPEN)throw Error('CDP socket disconnected');
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP timeout ${method}`));},15000);
   this.pending.set(id,{resolve,reject,timer});
   this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
 }
 async evaluate(expression){
  const result=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'CDP evaluation failed');
  return result.result.value;
 }
 close(){
  this.socket?.close();
  for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('CDP socket closed'));}
  this.pending.clear();
 }
}
