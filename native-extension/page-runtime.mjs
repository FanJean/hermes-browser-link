// 中文注释：任务页面运行时（JavaScript / CDP）；只使用现有任务与浏览器访问授权。
// 与凭据填写在同一页面互斥。隔离执行世界不等于只读沙箱，结果不做秘密过滤承诺。
import {cdpMethodAllowed,scrubCdpEvent} from './cdp-policy.mjs';
import {NetworkEvidence} from './network-evidence.mjs';
import {debuggerTargetId} from './official-actions.mjs';
import {filterPageResult} from './content-filter.mjs';

export const MAX_JS_RESULT_CHARS=256*1024;
export const MAX_EXPRESSION_CHARS=100000;
export const EVENT_BUFFER_LIMIT=500;
export const CHUNK_CHARS=512*1024;
const MAX_CHUNKS=64;
const JS_DEFAULT_TIMEOUT_MS=10000,JS_MAX_TIMEOUT_MS=60000;
// 中文注释：原始 CDP 输入的遮罩放行窗口。按下未松开（鼠标、触摸、拖动中）时放长窗口，避免按下与松开落在不同目标上。
export const INPUT_WINDOW_MS=600,INPUT_HOLD_MS=5000;
const OVERLAY_INPUT_TIMEOUT_MS=1000;
const holdingInput=(method,params)=>method==='Input.dispatchMouseEvent'&&params.type==='mousePressed'||
 method==='Input.dispatchTouchEvent'&&['touchStart','touchMove'].includes(params.type)||
 method==='Input.dispatchDragEvent'&&['dragEnter','dragOver'].includes(params.type);

// 中文注释：派发前被拒绝的错误标记 preDispatch，调用方据此报告“未派发”，不按未知写入处理。
const fail=(code,extra={})=>Object.assign(Error(code),{preDispatch:!extra.outcomeUnknown},extra);

export class PageRuntime{
 constructor(executor,{pushEvents=async()=>{},now=()=>Date.now()}={}){
  this.network=new NetworkEvidence(executor);
  this.executor=executor;this.pushEvents=pushEvents;this.now=now;
  this.pending=[];this.flushTimer=null;this.chunks=new Map();
 }
 // 中文注释：这里只缓存运行资源，不生成授权、期限或第二套代次。
 state(t){
  if(t?.revoked||!['smart','full'].includes(t?.policy?.activeMode))return null;
  return t.execution??null;
 }
 assertAccess(t){
  if(!t||t.revoked||!['smart','full'].includes(t.policy?.activeMode))throw fail('BROWSER_ACCESS_REQUIRED');
  if(t.paused||t.pauseRequested)throw fail('task paused');
 }
 clear(t){
  // 中文注释：撤销时清除本任务分块，不能让缓存越过授权生命周期。
  for(const [id,row] of this.chunks)if(row.task===t)this.chunks.delete(id);
  const state=t?.execution;if(!state)return;
  t.execution=null;
  // 中文注释：撤权时逐个移除原始 CDP 持久脚本；释放任务会等待这批移除命令。
  const cleanup=Promise.allSettled([...state.scripts.values()].map(({target,identifier})=>
   this.executor.api.debugger.sendCommand(target,'Page.removeScriptToEvaluateOnNewDocument',{identifier})));
  t.scriptCleanup=cleanup;
  return cleanup;
 }
 assert(t,p){
  this.assertAccess(t);
  if(t.credentialTabs?.has(p.tabId))throw fail('CREDENTIAL_MODE_CONFLICT');
  if(this.executor.leases.get(p.tabId)!==t.id)throw fail('tab lease denied');
  const state=t.execution??=( {tabs:new Set(),subscriptions:new Map(),buffers:new Map(),worlds:new Map(),scripts:new Map()} );
  state.tabs.add(p.tabId);
  (t.scriptedTabs??=new Set()).add(p.tabId);
  return state;
 }
 // 中文注释：网关缓存的 target 不能代替实时来源校验；跳转尚未提交也先阻断。
 async assertTargetScope(t,p,guard,target={tabId:p.tabId},{allFrames=false}={}){
  this.assert(t,p);
  const tab=await this.executor.api.tabs.get(p.tabId);guard();
  if(t.offScopeTabs?.has(p.tabId))throw fail('TAB_OUT_OF_SCOPE');
  const allowed=url=>{
   if(url==='about:blank'&&t.officialBlank?.has(p.tabId)&&!target.sessionId)return;
   try{this.executor.allowed(t,url);}catch{throw fail('TAB_OUT_OF_SCOPE');}
  };
  allowed(tab.url);
  if(tab.pendingUrl)allowed(tab.pendingUrl);
  if(target.sessionId||allFrames){
   // 中文注释：顶层页面仍须属于任务；额外子框架来源由本次调试命令审批说明承载。
   const tree=await this.executor.api.debugger.sendCommand(target,'Page.getFrameTree',{});guard();
   if(!target.sessionId)allowed(tree?.frameTree?.frame?.url);
  }
 }
 async frameTarget(t,p,guard){
  const target={tabId:p.tabId};
  const tree=await this.executor.checkedFrameTree(target,t,guard,false);
  if(!p.frameToken)return {target,frame:tree.frame};
  const resolved=await this.executor.resolveFrame(t,p,tree,guard);
  return {target:resolved.target,frame:resolved.frame};
 }
 async evaluate(t,p,guard){
  const world=p.world||'isolated';
  if(!['isolated','main'].includes(world))throw fail('INVALID_JS_WORLD');
  const resources=this.assert(t,p);
  if(typeof p.expression!=='string'||!p.expression||p.expression.length>MAX_EXPRESSION_CHARS)throw fail('INVALID_JS_EXPRESSION');
  const timeout=p.timeoutMs===undefined?JS_DEFAULT_TIMEOUT_MS:p.timeoutMs;
  if(!Number.isInteger(timeout)||timeout<100||timeout>JS_MAX_TIMEOUT_MS)throw fail('INVALID_JS_TIMEOUT');
  const {target,frame}=await this.frameTarget(t,p,guard);
  const api=this.executor.api.debugger;
  let contextId;
  if(world==='isolated'){
   const key=`${p.tabId}|${target.sessionId||''}|${frame.id}|${frame.loaderId}`;
   contextId=resources.worlds.get(key);
   if(!contextId){
    const created=await api.sendCommand(target,'Page.createIsolatedWorld',{frameId:frame.id,worldName:'hermes-page-runtime',grantUniveralAccess:false});guard();
    contextId=created.executionContextId;resources.worlds.set(key,contextId);
   }
  }else if(frame.parentId&&!target.sessionId)throw fail('MAIN_WORLD_FRAME_UNSUPPORTED');
  let expired=false;
  const check=()=>{guard();if(expired)throw fail('JS_TIMEOUT',{outcomeUnknown:true});};
  // 中文注释：函数参数作为 CDP 值传递，不插入可执行源码。
  const evaluation=(async()=>{
   const callable=Object.hasOwn(p,'arguments');
   const value=await api.sendCommand(target,'Runtime.evaluate',{expression:callable?`(${p.expression})`:p.expression,...(contextId?{contextId}:{}),
    returnByValue:false,awaitPromise:callable?false:p.awaitPromise!==false,timeout,userGesture:false,generatePreview:false,objectGroup:'hermes-page-runtime'});
   check();
   if(!callable||value.exceptionDetails)return value;
   // 中文注释：表达式已经求值，类型校验失败不能撤销期间产生的页面副作用。
   if(value.result?.type!=='function'||!value.result.objectId)throw fail('INVALID_JS_FUNCTION',{outcomeUnknown:true});
   return api.sendCommand(target,'Runtime.callFunctionOn',{objectId:value.result.objectId,functionDeclaration:'function(argument){return this(argument)}',
    arguments:[{value:p.arguments}],returnByValue:false,awaitPromise:true,userGesture:false,objectGroup:'hermes-page-runtime'});
  })().then(async response=>{
   check();
   const after=await this.frameTarget(t,p,check);
   if(after.frame.loaderId!==frame.loaderId)throw fail('DOCUMENT_CHANGED',{outcomeUnknown:true});
   if(response.exceptionDetails){
    const details=response.exceptionDetails;
    // 中文注释：只保留异常类型和经页面文字过滤的首行；语法错误确定没有执行。
    const type=String(details.exception?.className||'Error').slice(0,80);
    const raw=String(details.exception?.description||details.text||'Uncaught').split(/\r?\n/,1)[0].slice(0,200);
    const text=filterPageResult('js.evaluate',{ok:true,value:raw}).value;
    const syntax=type==='SyntaxError';
    return {ok:false,code:syntax?'js_syntax_error':'js_exception',outcomeUnknown:!syntax,
     exception:{type,text,lineNumber:details.lineNumber,columnNumber:details.columnNumber},world};
   }
   return {ok:true,world,...await this.remoteValue(target,response.result,check)};
  });
  // 中文注释：结果序列化也会执行页面代码，必须包含在同一期限内；超时后迟到回执不能继续处理。
  let timer;
  const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(fail('JS_TIMEOUT',{outcomeUnknown:true}));},timeout+500);});
  try{return await Promise.race([evaluation,timed]);}
  catch(error){
   if(error?.message==='JS_TIMEOUT')await api.sendCommand(target,'Runtime.terminateExecution').catch(()=>{});
   throw error;
  }finally{
   clearTimeout(timer);
   // 中文注释：包括撤权和序列化异常，所有已创建的远端句柄都走相同释放路径。
   await api.sendCommand(target,'Runtime.releaseObjectGroup',{objectGroup:'hermes-page-runtime'}).catch(()=>{});
  }
 }
 // 中文注释：结果以值返回；DOM 节点、循环对象等不可序列化值只给类型描述，不外泄调试句柄。
 async remoteValue(target,object,guard){
  const base={type:object?.type,...(object?.subtype?{subtype:object.subtype}:{}),...(object?.className?{className:String(object.className).slice(0,128)}:{})};
  if(!object)return {type:'undefined'};
  if(Object.hasOwn(object,'value'))return this.bounded({...base,value:object.value});
  if(object.unserializableValue)return {...base,unserializableValue:String(object.unserializableValue).slice(0,64)};
  if(!object.objectId||object.type==='function'||['node','error','proxy','promise','weakmap','weakset','generator'].includes(object.subtype))
   return {...base,description:String(object.description||'').slice(0,500),serializable:false};
  const json=await this.executor.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{objectId:object.objectId,
   functionDeclaration:`function(limit){try{const text=JSON.stringify(this);if(text===undefined)return {kind:'undefined'};if(text.length>limit)return {kind:'too_large',size:text.length};return {kind:'json',text};}catch(error){return {kind:'error',name:String(error&&error.name||'Error')};}}`,
   arguments:[{value:MAX_JS_RESULT_CHARS}],returnByValue:true}).catch(()=>null);guard();
  const verdict=json?.result?.value;
  if(verdict?.kind==='json')return {...base,value:JSON.parse(verdict.text)};
  if(verdict?.kind==='too_large')return {...base,description:String(object.description||'').slice(0,500),serializable:false,truncated:true,size:verdict.size};
  return {...base,description:String(object.description||'').slice(0,500),serializable:false,
   ...(verdict?.kind==='error'?{reason:verdict.name==='TypeError'?'circular_or_unsupported':'serialization_error'}:{})};
 }
 bounded(result){
  const text=JSON.stringify(result.value);
  if(text!==undefined&&text.length>MAX_JS_RESULT_CHARS)return {type:result.type,serializable:false,truncated:true,size:text.length};
  return result;
 }
 // 中文注释：原始 CDP 共用任务授权；方法逐项放行，导航必须留在任务来源内。
 async send(t,p,guard,{gateway=false,filesVerified=false}={}){
  this.assert(t,p);
  const timeout=p.timeoutMs===undefined?30000:p.timeoutMs;
  if(!Number.isInteger(timeout)||timeout<100||timeout>60000)throw fail('INVALID_CDP_PARAMS');
  const bounded=async work=>{
   let timer;
   try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(
    ()=>reject(fail('CDP_TIMEOUT',{outcomeUnknown:true})),timeout);})]);}
   finally{clearTimeout(timer);}
  };
  const verdict=cdpMethodAllowed(p.method,{gateway});
  if(!verdict.allowed)throw fail('CDP_METHOD_DENIED',{category:verdict.category});
  const params=p.params===undefined?{}:p.params;
  if(!params||typeof params!=='object'||Array.isArray(params)||JSON.stringify(params).length>MAX_EXPRESSION_CHARS*10)throw fail('INVALID_CDP_PARAMS');
  // 中文注释：脚本及 CDP 网关的原始输入也共用窗口队列；非输入命令直接执行。
  const execute=()=>this.sendAuthorized(t,p,guard,{gateway,filesVerified},params,verdict,bounded);
  return this.executor.workspaces&&p.method.startsWith('Input.')?this.executor.workspaces.withInput(t,{...p,action:'cdp.send'},guard,execute):execute();
 }
 async sendAuthorized(t,p,guard,{gateway,filesVerified},params,verdict,bounded){
  if(p.targetId){
   const all=await this.executor.api.debugger.getTargets();guard();
   const page=all.find(row=>debuggerTargetId(row)===p.targetId&&row.type==='page'&&row.tabId===p.tabId);
   if(!page)throw fail('TARGET_NOT_OWNED');
  }
  const target={tabId:p.tabId,...(p.childSessionId?{sessionId:p.childSessionId}:{})};
  if(p.frameToken){
   const tree=await this.executor.checkedFrameTree({tabId:p.tabId},t,guard,false);
   const resolved=await this.executor.resolveFrame(t,p,tree,guard);
   if(resolved.target.sessionId)target.sessionId=resolved.target.sessionId;
  }
  if(verdict.category==='navigation'){
   let url=params.url;
   if(p.method==='Page.navigateToHistoryEntry'){
    const history=await this.executor.api.debugger.sendCommand(target,'Page.getNavigationHistory');guard();
    url=history?.entries?.find(entry=>entry.id===params.entryId)?.url;
   }
   this.executor.allowed(t,url);
  }
  let inputWindow;
  try{
  if(p.method.startsWith('Input.'))inputWindow=await this.openInputWindow(t,p.tabId,p.method,params,guard,{gateway});
  await this.assertTargetScope(t,p,guard,target,{allFrames:true});
  const result=await bounded(this.executor.api.debugger.sendCommand(target,p.method,params));guard();
  // 中文注释：脚本标识与调试目标一起登记；任务结束或切回智能审批时移除。
  if(p.method==='Page.addScriptToEvaluateOnNewDocument'&&typeof result?.identifier==='string'){
   t.execution.scripts.set(`${p.tabId}|${target.sessionId||''}|${result.identifier}`,{target,identifier:result.identifier});
  }else if(p.method==='Page.removeScriptToEvaluateOnNewDocument'){
   t.execution.scripts.delete(`${p.tabId}|${target.sessionId||''}|${params.identifier}`);
  }
  // 中文注释：派发期间离站时丢弃结果；动作可能已发生，不能标记为未派发。
  try{await this.assertTargetScope(t,p,guard,target,{allFrames:true});}catch(error){error.preDispatch=false;error.outcomeUnknown=true;throw error;}
  if(!gateway)this.subscribe(t,p.tabId,target.sessionId||null,'buffer');
  return this.maybeChunk(result,t);
  }finally{
   // 中文注释：只关闭本次派发的窗口；并发新窗口不会被迟到的 finally 收回。
   if(inputWindow){
    let timer;
    try{await Promise.race([this.executor.overlayCall(p.tabId,inputWindow.entry,'reblock',{expectedActionToken:inputWindow.token}).catch(()=>false),new Promise(resolve=>{timer=setTimeout(resolve,OVERLAY_INPUT_TIMEOUT_MS);})]);}
    finally{clearTimeout(timer);}
   }
  }
 }
 // 中文注释：遮罩平时拦截用户点击与键盘；只在原始 CDP 输入派发前短暂放行，窗口到期由页面自行恢复拦截。
 // 中文注释：导航后先补上新遮罩；无法确认放行时拒绝派发，避免把点击遮罩误报为操作成功。
 async openInputWindow(t,tabId,method,params,guard,{gateway=false}={}){
  if(this.executor.observers?.pending?.(t,tabId))return;
  const token=crypto.randomUUID();
  const update={state:'running',step:'cdp.input',holdMs:holdingInput(method,params)?INPUT_HOLD_MS:INPUT_WINDOW_MS};
  const bounded=work=>{let timer;return Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),OVERLAY_INPUT_TIMEOUT_MS);})]).finally(()=>clearTimeout(timer));};
  const call=entry=>entry?bounded(this.executor.overlayCall(tabId,entry,'update',{update,actionToken:token})).catch(()=>false):Promise.resolve(false);
  const current=t.overlays?.get(tabId);
  if(await call(current)===true)return {entry:current,token};
  // 中文注释：网关请求不持有标签页锁，走带锁的补遮罩；动作队列内已持锁，直接补，避免自锁。
  const entry=await bounded(gateway?this.executor.restoreOverlay(t,tabId):this.executor.ensureOverlay(t,tabId,{tabId},guard)).catch(()=>null);
  guard();
  if(entry&&await call(entry)===true)return {entry,token};
  throw fail('INTERACTION_HIGHLIGHT_UNAVAILABLE');
 }
 maybeChunk(result,t){
  const text=JSON.stringify(result??{});
  if(text.length<=CHUNK_CHARS)return result??{};
  // 中文注释：分块发生在命令已派发之后，结果存不下不能宣称未产生副作用。
  if(text.length>CHUNK_CHARS*MAX_CHUNKS)throw fail('CDP_RESULT_TOO_LARGE',{outcomeUnknown:true});
  const id=crypto.randomUUID(),parts=[];
  for(let offset=0;offset<text.length;offset+=CHUNK_CHARS)parts.push(text.slice(offset,offset+CHUNK_CHARS));
  for(const [key,value] of this.chunks)if(this.now()-value.at>=60000)this.chunks.delete(key);
  // 中文注释：所有任务共享固定容量，超限明确拒绝，不挤掉其他正在读取的结果。
  if([...this.chunks.values()].reduce((count,row)=>count+row.parts.length,parts.length)>MAX_CHUNKS)throw fail('CHUNK_CAPACITY',{outcomeUnknown:true});
  this.chunks.set(id,{parts,at:this.now(),task:t,generation:t.generation,modeGeneration:t.policy.modeGeneration});
  return {__hermesChunked:{id,count:parts.length,size:text.length}};
 }
 chunk({id,index,taskId,generation,modeGeneration},t){
  const entry=this.chunks.get(id);
  if(entry&&this.now()-entry.at>=60000){this.chunks.delete(id);throw fail('CHUNK_UNAVAILABLE');}
  if(!entry||entry.task!==t||t?.revoked||taskId!==t.id||generation!==entry.generation||generation!==t.generation||modeGeneration!==entry.modeGeneration||modeGeneration!==t.policy.modeGeneration||!Number.isInteger(index)||index<0||index>=entry.parts.length)throw fail('CHUNK_UNAVAILABLE');
  const part=entry.parts[index];
  if(index===entry.parts.length-1)this.chunks.delete(id);
  return {index,data:part};
 }
 subscribe(t,tabId,childSessionId,mode){
  const resources=t.execution;if(!resources)return;
  // 中文注释：缓冲读取和网关推送各自登记，不能因另一个入口订阅而停止。
  const key=`${tabId}|${childSessionId||''}`;
  const sub=resources.subscriptions.get(key)||{tabId,childSessionId,buffer:false,push:false};
  sub[mode]=true;resources.subscriptions.set(key,sub);
 }
 unsubscribe(t,tabId,childSessionId){
  const key=`${tabId}|${childSessionId||''}`,sub=t.execution?.subscriptions.get(key);
  if(!sub)return;
  sub.push=false;if(!sub.buffer)t.execution.subscriptions.delete(key);
 }
 // 中文注释：只转发已授权任务页（含其子会话）且已订阅的事件；缓冲有上限，溢出如实计数。
 observe(source,method,params){
  const tabId=source?.tabId,t=this.executor.tasks.get(this.executor.leases.get(tabId));
  if(!t||t.revoked||t.offScopeTabs?.has(tabId))return;
  const resources=this.state(t);if(!resources)return;
  this.network.observe(t,source,method,params);
  const sub=resources.subscriptions.get(`${tabId}|${source.sessionId||''}`);if(!sub)return;
  const scrubbed=scrubCdpEvent(method,params);if(scrubbed===null)return;
  if(sub.buffer){
   const buffer=resources.buffers.get(tabId)||{events:[],dropped:0};resources.buffers.set(tabId,buffer);
   if(buffer.events.length>=EVENT_BUFFER_LIMIT)buffer.dropped++;
   else buffer.events.push({method,params:scrubbed,...(source.sessionId?{childSession:true}:{})});
  }
  if(!sub.push)return;
  if(this.pending.length>=EVENT_BUFFER_LIMIT*4){this.dropped=(this.dropped||0)+1;return;}
  this.pending.push({taskId:t.id,generation:t.generation,tabId,childSessionId:source.sessionId||null,method,params:scrubbed});
  if(!this.flushTimer)this.flushTimer=setTimeout(()=>this.flush(),30);
 }
 async flush(){
  this.flushTimer=null;
  const batch=this.pending.splice(0,200),dropped=this.dropped||0;this.dropped=0;
  if(!batch.length&&!dropped)return;
  try{await this.pushEvents({events:batch,dropped});}catch{}
  if(this.pending.length&&!this.flushTimer)this.flushTimer=setTimeout(()=>this.flush(),30);
 }
 drain(t,p,max=200){
  this.assert(t,p);
  const buffer=t.execution.buffers.get(p.tabId)||{events:[],dropped:0};
  const events=buffer.events.splice(0,Math.min(Math.max(1,max),EVENT_BUFFER_LIMIT));
  const dropped=buffer.dropped;buffer.dropped=0;
  return {events,dropped,remaining:buffer.events.length};
 }
 // 中文注释：网关列出的目标只含本任务租约内、来源已授权的页面与已发现的子 frame 会话。
 async targets(t,p,guard){
  this.assertAccess(t);
  const all=await this.executor.api.debugger.getTargets();guard();
  const rows=[];
  for(const tabId of t.tabIds){
   if(this.executor.leases.get(tabId)!==t.id||t.credentialTabs?.has(tabId))continue;
   let tab;try{tab=await this.executor.api.tabs.get(tabId);this.executor.allowed(t,tab.url);}catch{if(!t.officialBlank?.has(tabId))continue;}
   const page=all.find(item=>item.tabId===tabId&&item.type==='page'&&debuggerTargetId(item));
   if(!page)continue;
   rows.push({targetId:debuggerTargetId(page),type:'page',url:tab?.url||'about:blank',title:tab?.title||'',tabId,attached:true});
   if(!this.executor.attached.has(tabId)){
    await this.executor.api.debugger.attach({tabId},'1.3');guard();this.executor.attached.add(tabId);
   }
   const sessions=await this.executor.ensureFrameSessions(t,tabId,guard);
   for(const [targetId,child] of sessions.sessions){
    let site=null;try{site=new URL(child.url).origin;}catch{}
    if(!t.allowedOrigins.includes(site))continue;
    rows.push({targetId,type:'iframe',url:child.url,title:'',tabId,childSessionId:child.sessionId,attached:true});
   }
  }
  return {targets:rows};
 }
}
