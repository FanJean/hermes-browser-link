// 中文注释：独立云端 Native 端口；本地连接和全局浏览器权限不由此模块改写。
export class CloudLink {
 constructor(chrome,{localBridge,executor,consent,changed}){
  this.chrome=chrome;this.localBridge=localBridge;this.executor=executor;this.consent=consent;this.changed=changed;
  this.port=null;this.pending=new Map();this.tasks=new Map();this.instanceId=null;this.connecting=null;
  this.reconnectTimer=null;this.reconnectDelay=1500;
  this.state={state:'unavailable',online:false,paired:false,fullAccess:false,error:null};
 }
 view(){return {...this.state};}
 modeForTask(task){const row=this.tasks.get(task.id);return row&&row.generation===task.generation?row.mode:null;}
 scheduleReconnect(){
  // 中文注释：云端端口独立快速恢复；连续握手失败退避至 30 秒，避免缺少 host 时反复启动进程。
  if(this.reconnectTimer!==null||!this.instanceId)return;
  this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;void this.connect(this.instanceId,this.browser);},this.reconnectDelay);
  this.reconnectDelay=Math.min(30000,this.reconnectDelay*2);
 }
 async connect(instanceId,browser){
  if(this.port||this.connecting)return this.connecting;
  if(this.reconnectTimer!==null){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
  this.instanceId=instanceId;this.browser=browser;
  this.connecting=(async()=>{
   const port=this.chrome.runtime.connectNative('com.hermes.browser_link.cloud');this.port=port;
   port.onMessage.addListener(message=>void this.receive(message));
   port.onDisconnect.addListener(()=>{
    // 中文注释：读取浏览器断开原因，避免把正常 Native 退出留成未处理扩展错误。
    const disconnectReason=this.chrome.runtime.lastError?.message;
    if(this.port!==port)return;this.port=null;this.connecting=null;
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('云端连接已断开'));}this.pending.clear();
    this.state={...this.state,state:'unavailable',online:false,error:disconnectReason?'云端连接已断开，正在重新连接。':'云端服务未连接，请检查安装。'};this.changed();this.scheduleReconnect();
   });
   this.state=await this.request('hello',{instance_id:instanceId,browser});this.reconnectDelay=1500;this.changed();return this.view();
  })().catch(()=>{
   // 中文注释：握手失败的端口不能继续复用；扩展重载时旧实例锁释放后可由下一次刷新恢复。
   const failed=this.port;this.port=null;failed?.disconnect();
   this.state={state:'unavailable',online:false,paired:false,fullAccess:false,error:'云端服务未连接，正在重新连接。'};this.changed();this.scheduleReconnect();
  }).finally(()=>{this.connecting=null;});
  return this.connecting;
 }
 request(method,params={}){
  if(!this.port)return Promise.reject(Error('云端服务未连接'));
  const id=crypto.randomUUID();return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('云端操作结果未确认'));},20000);
   this.pending.set(id,{resolve,reject,timer});
   try{this.port.postMessage({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });
 }
 async receive(message){
  if(message?.method==='cloud.status_changed'){
   if(message.params?.instanceId!==this.instanceId)return;
   this.state=message.params;this.changed();return;
  }
  if(!message?.method){const entry=this.pending.get(message?.id);if(!entry)return;clearTimeout(entry.timer);this.pending.delete(message.id);message.error?entry.reject(Error('云端操作未确认')):entry.resolve(message.result);return;}
  const port=this.port;if(!port)return;
  try{
   let result;
   if(message.method==='cloud.browser_status')result={connected:!!this.localBridge(),instanceId:this.instanceId};
   else if(message.method==='cloud.bind_task')result=await this.bind(message.params);
   else throw Error('不支持的云端请求');
   if(this.port===port)port.postMessage({id:message.id,result});
  }catch{if(this.port===port)port.postMessage({id:message.id,error:'cloud_policy_denied'});}
 }
 async bind(params){
  // 中文注释：绑定只接受本机 Native 服务给出的本实例任务；网页和远程工具不能设置授权模式。
  if(params?.instanceId!==this.instanceId||!['smart','full'].includes(params.mode)||typeof params.taskId!=='string'||!Number.isInteger(params.generation))throw Error('云端任务身份不匹配');
  const bridge=this.localBridge();if(!bridge)throw Error('本地桥未连接');
  const currentTasks=await bridge.request('extension.tasks');
  // 中文注释：复用已有任务列表回收已结束或旧代次的云端模式记录，不增加额外状态请求。
  for(const [id,row] of this.tasks)if(!currentTasks.some(task=>task.id===id&&task.generation===row.generation))this.tasks.delete(id);
  let task=currentTasks.find(row=>row.id===params.taskId&&row.generation===params.generation);
  if(!task||['closed','cancelled','paused'].includes(task.state))throw Error('云端任务已失效');
  this.tasks.set(task.id,{generation:task.generation,mode:params.mode});
  await this.consent.synchronize(bridge);
  task=(await bridge.request('extension.tasks')).find(row=>row.id===params.taskId&&row.generation===params.generation);
  // 中文注释：同任务其他页面正在执行时仍可绑定当前页面，模式和实例校验保持不变。
  if(!task||!['ready','running'].includes(task.state))throw Error('云端任务尚未就绪');
  if(task.activeMode!==params.mode){
   if(params.mode==='smart')this.executor.revokeMode(task.id);
   const updated=await bridge.request('extension.mode',{taskId:task.id,generation:task.generation,modeGeneration:task.modeGeneration,mode:params.mode});
   if(params.mode==='full')this.executor.setMode(updated);task=updated;
  }
  return {verified:task.activeMode===params.mode,taskId:task.id};
 }
 async act(method,params={}){this.state=await this.request(method,params);this.changed();return this.view();}
 async refresh(){
  // 中文注释：云端端口独立断开时自行重连，不依赖本地端口断开或重启原 daemon。
  if(!this.port){if(this.instanceId)await this.connect(this.instanceId,this.browser);return;}
  if(this.connecting)return;try{this.state=await this.request('status');this.changed();}catch{this.state={...this.state,online:false,error:'云端状态暂时无法确认。'};}
 }
}
