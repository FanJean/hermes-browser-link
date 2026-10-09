// 中文注释：独立云端 Native 端口；本地连接和全局浏览器权限不由此模块改写。
export class CloudLink {
 constructor(chrome,{localBridge,executor,consent,changed}){
  this.chrome=chrome;this.localBridge=localBridge;this.executor=executor;this.consent=consent;this.changed=changed;
  this.port=null;this.pending=new Map();this.tasks=new Map();this.instanceId=null;this.connecting=null;
  this.reconnectTimer=null;this.reconnectDelay=1500;this.authorizationGeneration=0;
  this.state={state:'unavailable',online:false,paired:false,fullAccess:false,error:null};
 }
 view(){return {...this.state};}
 authorized(state=this.state){return state?.state==='active'&&state.paired===true&&state.fullAccess===true&&state.online===true&&!state.error;}
 setState(state){
  if(Number.isInteger(this.state.authorizationGeneration)&&Number.isInteger(state?.authorizationGeneration)&&state.authorizationGeneration<this.state.authorizationGeneration)return;
  if(!this.authorized(state)||state.authorizationGeneration!==this.state.authorizationGeneration){
   this.authorizationGeneration++;
   for(const id of this.tasks.keys())this.executor.revokeMode(id);
   this.tasks.clear();
  }
  this.state=state;this.changed();
 }
 modeForTask(task){const row=this.tasks.get(task.id);return this.authorized()&&row&&row.revision===this.authorizationGeneration&&row.generation===task.generation?row.mode:null;}
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
  this.setState({state:'connecting',online:false,paired:false,fullAccess:false,error:null});
  this.connecting=(async()=>{
   const port=this.chrome.runtime.connectNative('com.hermes.browser_link.cloud');this.port=port;
   port.onMessage.addListener(message=>void this.receive(message,port));
   port.onDisconnect.addListener(()=>{
    // 中文注释：读取浏览器断开原因，避免把正常 Native 退出留成未处理扩展错误。
    const disconnectReason=this.chrome.runtime.lastError?.message;
    if(this.port!==port)return;this.port=null;this.connecting=null;
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('云端连接已断开'));}this.pending.clear();
    this.setState({...this.state,state:'unavailable',online:false,fullAccess:false,error:disconnectReason?'云端连接已断开，正在重新连接。':'云端服务未连接，请检查安装。'});this.scheduleReconnect();
   });
   const state=await this.request('hello',{instance_id:instanceId,browser});
   if(this.port!==port)throw Error('云端连接已失效');
   this.setState(state);this.reconnectDelay=1500;return this.view();
  })().catch(()=>{
   // 中文注释：握手失败的端口不能继续复用；扩展重载时旧实例锁释放后可由下一次刷新恢复。
   const failed=this.port;this.port=null;failed?.disconnect();
   this.setState({state:'unavailable',online:false,paired:false,fullAccess:false,error:'云端服务未连接，正在重新连接。'});this.scheduleReconnect();
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
 async receive(message,source=this.port){
  if(source!==this.port)return;
  if(message?.method==='cloud.status_changed'){
   if(message.params?.instanceId!==this.instanceId)return;
   this.setState(message.params);return;
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
  const revision=this.authorizationGeneration;
  const check=()=>{if(!this.authorized()||revision!==this.authorizationGeneration)throw Error('云端尚未配对');};
  check();
  if(params?.instanceId!==this.instanceId||params.mode!=='full'||typeof params.taskId!=='string'||!Number.isInteger(params.generation))throw Error('云端任务身份不匹配');
  const bridge=this.localBridge();if(!bridge)throw Error('本地桥未连接');
  const currentTasks=await bridge.request('extension.tasks');check();
  for(const [id,row] of this.tasks)if(!currentTasks.some(task=>task.id===id&&task.generation===row.generation))this.tasks.delete(id);
  let task=currentTasks.find(row=>row.id===params.taskId&&row.generation===params.generation);
  if(!task||task.instanceId!==this.instanceId||!['ready','running','pending_approval'].includes(task.state))throw Error('云端任务已失效');
  const binding={generation:task.generation,mode:params.mode,revision};
  this.tasks.set(task.id,binding);
  const valid=()=>this.authorized()&&revision===this.authorizationGeneration&&!bridge.closed;
  // 中文注释：全局 consent 的内部 await 也受当前云端代次保护，且只处理这一个云端任务。
  const scopedBridge={get closed(){return !valid();},request:async(method,args,guard=()=>true)=>{
   check();const value=await bridge.request(method,args,()=>valid()&&guard());check();
   return method==='extension.tasks'?value.filter(row=>row.id===params.taskId&&row.generation===params.generation&&row.instanceId===params.instanceId):value;
  }};
  try{
   check();await this.consent.synchronize(scopedBridge);check();
   task=(await bridge.request('extension.tasks')).find(row=>row.id===params.taskId&&row.generation===params.generation);check();
   if(!task||task.instanceId!==this.instanceId||!['ready','running'].includes(task.state))throw Error('云端任务尚未就绪');
   if(task.activeMode!==params.mode){
    check();const updated=await bridge.request('extension.mode',{taskId:task.id,generation:task.generation,modeGeneration:task.modeGeneration,mode:params.mode});check();
    if(updated?.id!==task.id||updated.generation!==task.generation||updated.instanceId!==this.instanceId||!['ready','running'].includes(updated.state)||updated.activeMode!==params.mode)throw Error('云端任务已失效');
    this.executor.setMode(updated);task=updated;
   }
   check();return {verified:task.activeMode===params.mode,taskId:task.id};
  }catch(error){
   if(this.tasks.get(params.taskId)===binding){this.tasks.delete(params.taskId);this.executor.revokeMode(params.taskId);}
   throw error;
  }
 }
 async act(method,params={}){this.setState(await this.request(method,params));return this.view();}
 async refresh(){
  // 中文注释：云端端口独立断开时自行重连，不依赖本地端口断开或重启原 daemon。
  if(!this.port){if(this.instanceId)await this.connect(this.instanceId,this.browser);return;}
  if(this.connecting)return;try{this.setState(await this.request('status'));}catch{this.setState({...this.state,state:'unavailable',online:false,fullAccess:false,error:'云端状态暂时无法确认。'});}
 }
}
