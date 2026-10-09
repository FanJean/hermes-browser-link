import {RequestLedger} from './request-ledger.mjs';
import {filterPageResult} from './content-filter.mjs';
export const isUiSender=(sender,id)=>sender?.id===id&&sender?.url===`chrome-extension://${id}/popup.html`;
const sameValues=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
function executionError(error,message){
 // 中文注释：滚动会触发页面副作用，不归入只读动作，丢失回执时禁止自动重试。
 const readOnly=['browser.assess','browser.popup_prepare','browser.read_origin','browser.cleanup_status'].includes(message.method)||['browser.cdp_targets','browser.cdp_version','browser.cdp_chunk','browser.cdp_subscribe'].includes(message.method)||(message.method==='browser.execute'&&['tabs','snapshot','page.observe','page.parse','semantic_snapshot','frame_catalog','screenshot','interaction.capture','interaction.bounds','official.ready_state','cdp.events','network.inspect','images','console'].includes(message.params?.action));
 // CDP exception descriptions contain `Error: CODE` followed by a stack.
 // Match only the complete first-line reason against the allowlists below;
 // never search stack frames or expose arbitrary page exception text.
 const detail=String(error?.message||'').split(/\r?\n/,1)[0].replace(/^Error: /,'');
 const reason=String(error?.code||detail).split('|',1)[0];
 let code='execution_denied',text='Browser operation could not be completed.';
 // 中文注释：并发资源冲突只拒绝当前请求，保留是否已创建页面的派发事实。
 if(reason==='TASK_BUSY'){code='task_busy';text='任务标签正被其他操作使用，请先核对本次结果。';}
 else if(reason==='POPUP_STALE'){code='popup_stale';text='登录弹窗身份、来源或授权已变化；请重新发现候选，不会自动重试。';}
 // 中文注释：已派发但未观察到效果是失败，禁止当作点击成功。
 else if(reason==='CLICK_NO_EFFECT'){code='click_no_effect';text='输入已派发，但在观察期限内没有效果；请先读取页面核对。';}
 else if(reason==='TASK_PAUSED'||reason==='task paused'){code='task_paused';text='用户已接管，任务已暂停；请等待用户继续，不会自动重试。';}
 else if(error?.code==='workspace_unknown'){code='workspace_unknown';text='Workspace ownership or operation outcome is uncertain.';}
 else if(/^CONTENT_SHIELD_(?:UNAVAILABLE|INVALID_RULES|UNSUPPORTED|STALE|CHANGED|UNINSPECTABLE|UNSUPPORTED_VIEWPORT|BLOCKER_OVERLAP|RENDER_UNSUPPORTED)$/.test(reason)){code=reason.toLowerCase();text='页面内容保护未能确认，本次输出已拒绝；请核对保护状态后重新读取，写入结果未知时不要重试。';}
 else if(reason==='SCREENSHOT_TIMEOUT'){code='screenshot_timeout';text='截图超时，未返回截图；请核对页面状态。';}
 else if(reason==='SCREENSHOT_TARGET_MISSING'){code='element_timeout';text='截图目标未唯一找到；请重新读取页面并缩小名称或选择器范围。';}
 else if(reason==='CAPTURE_SENSITIVE_BLOCKED'){code='capture_sensitive_blocked';text='敏感字段遮罩无法确认；请隐藏该字段或让用户手动截图后重试。';}
 else if(reason==='CAPTURE_FRAME_UNINSPECTABLE'){code='capture_frame_uninspectable';text='无法确定框架的遮罩位置；请滚动移开该框架或让用户手动截图。';}
 else if(reason==='SCREENSHOT_EXPIRED'){code='screenshot_expired';text='Screenshot expired; capture a new one.';}
 else if(['STALE_SCREENSHOT','UNKNOWN_SCREENSHOT'].includes(reason)){code='stale_screenshot';text='Screenshot no longer matches the page; capture a new one.';}
 else if(reason==='SENSITIVE_TARGET'){code='sensitive_target';text='Sensitive page target is not available for automation.';}
 else if(detail==='sensitive target blocked'){code='sensitive_target';text='Let the user fill this field, then read the page again.';}
 else if(reason==='TARGET_OCCLUDED'){code='target_occluded';text='The target is covered by another element; nothing was clicked.';}
 // 中文注释：指针命中复核失败保留明确错误码，派发前状态由交互库提供，不输出底层异常。
 else if(reason==='HIT_RECHECK_FAILED'){code='target_hit_unverified';text='无法确认点击命中，请重新读取页面定位。';}
 else if(reason==='TARGET_DISABLED'){code='target_disabled';text='The target is disabled.';}
 else if(reason==='TARGET_HIDDEN'){code='target_hidden';text='The target is inert or hidden from accessibility.';}
 else if(reason==='TARGET_ZERO_SIZE'){code='target_zero_size';text='The target has no usable size.';}
 else if(reason==='TARGET_OUT_OF_VIEWPORT'){code='target_out_of_viewport';text='The target is outside the viewport.';}
 else if(reason==='UNSUPPORTED_SHADOW_DOM'){code='closed_shadow_unavailable';text='This closed shadow root cannot be accessed.';}
 else if(reason==='NESTED_FRAME_ACTION_UNAVAILABLE'){code='cross_origin_frame_unavailable';text='This nested frame cannot be operated through the available frame session.';}
 else if(reason==='REF_TARGET_MISSING'){code='reference_target_missing';text='No unique target matches this reference in the current document.';}
 else if(reason==='REF_TARGET_AMBIGUOUS'){code='reference_target_ambiguous';text='Multiple targets match this reference in the current document.';}
 else if(['TARGET_UNSTABLE','NODE_MOVED'].includes(reason)){code='target_unstable';text='The target kept moving; nothing was dispatched.';}
 else if(reason==='UNSUPPORTED_FRAME_TRANSFORM'){code='unsupported_frame_transform';text='Rotated or skewed frames are not supported for this action.';}
 else if(reason==='BACKGROUND_POINTER_UNSUPPORTED'){code='background_pointer_unavailable';text='Pointer dragging cannot be confirmed in a background tab.';}
 else if(['TARGET_NOT_ACTIONABLE','SELECTOR_NOT_UNIQUE','UNSUPPORTED_SHADOW_DOM','TARGET_NOT_SCROLLABLE','target unavailable','target not found'].includes(reason)){code='target_unavailable';text='Read the current page again; use a frame token if the target is inside an iframe.';}
 else if(reason==='RADIO_CANNOT_UNCHECK'){code='radio_cannot_uncheck';text='A radio button cannot be unchecked directly; select another option.';}
 else if(['TARGET_STATE_UNKNOWN','INVALID_CHECKED_STATE'].includes(reason)){code='invalid_target_state';text='The requested control state cannot be changed.';}
 else if(reason==='SELECT_OPTION_MISSING'){code='select_option_missing';text='The requested option does not exist.';}
 else if(reason==='SELECT_OPTION_AMBIGUOUS'){code='select_option_ambiguous';text='More than one option matches; use a unique value.';}
 else if(reason==='SELECT_OPTION_DISABLED'){code='select_option_disabled';text='The requested option is disabled.';}
 else if(reason==='INVALID_SELECT_OPTIONS'){code='invalid_select_option';text='The requested options are invalid for this control.';}
 else if(reason==='CUSTOM_SELECT_UNSUPPORTED'){code='custom_select_unsupported';text='先点击展开自定义下拉，读取新的 option 引用后逐项点击；未派发选择。';}
 else if(reason==='SEMANTIC_LIBRARY_UNAVAILABLE'){code='semantic_library_unavailable';text='页面解析器未就绪；请等导航完成后重新读取。';}
 else if(reason==='INPUT_EFFECT_PROBE_FAILED'){code='input_effect_probe_failed';text='无法确认点击效果；请读取页面核实，不要重放点击。';}
 else if(reason==='ADAPTER_DETACHED'){code='debugger_detached';text='页面调试连接已失效；请核对任务状态后重新读取。';}
 else if(['TARGET_CHANGED','POINTER_FRAME_UNSUPPORTED'].includes(reason)){code='target_unavailable';text='The pointer target changed or is outside the supported document.';}
 else if(reason==='TARGET_UNAVAILABLE'){code='target_unavailable';text='The browser target changed; read the page again.';}
 else if(reason==='TAB_DISCARDED'){code='tab_discarded';text='浏览器已丢弃此标签页；请确认 URL 和此前写入结果后由用户恢复页面，再重新读取。';}
 else if(reason==='DOWNLOAD_NOT_OWNED'||reason==='DOWNLOADS_UNAVAILABLE'){code='download_not_owned';text='The download is not attributed to this task.';}
 // 中文注释：文件上传的前置拒绝使用固定错误码，既不泄露路径，也不把未派发误报为结果未知。
 else if(reason==='ARTIFACT_PATH_DENIED'){code='artifact_path_denied';text='The selected task file path is invalid.';}
 else if(reason==='ARTIFACT_ORIGIN_DENIED'){code='artifact_origin_denied';text='The selected file is outside this task page scope.';}
 else if(reason==='FILE_INPUT_NOT_UNIQUE'){code='file_input_not_unique';text='The file selector must match exactly one input.';}
 else if(reason==='NOT_FILE_INPUT'){code='not_file_input';text='The selected target is not a compatible file input.';}
 else if(reason==='BROWSER_ACCESS_REQUIRED'){code='browser_access_required';text='Browser access is not enabled for this task.';}
 else if(reason==='MAIN_WORLD_FRAME_UNSUPPORTED'){code='frame_not_supported';text='Main-world evaluation is unavailable for this frame.';}
 else if(reason==='CREDENTIAL_MODE_CONFLICT'){code='credential_mode_conflict';text='Page execution and credential filling cannot share one task page.';}
 else if(reason==='CDP_METHOD_DENIED'){code='cdp_method_denied';text='CDP method name is invalid.';}
 else if(['INVALID_JS_EXPRESSION','INVALID_JS_TIMEOUT','INVALID_JS_WORLD','INVALID_CDP_PARAMS'].includes(reason)){code='invalid_params';text='Page execution arguments are invalid.';}
 else if(reason==='JS_TIMEOUT'){code='js_timeout';text='JavaScript did not finish before the deadline; side effects may have happened.';}
 else if(reason==='SCROLL_TIMEOUT'){code='scroll_timeout';text='Scroll dispatch did not return before its deadline; inspect the page before another scroll.';}
 else if(reason==='CDP_TIMEOUT'){code='extension_timeout';text='CDP did not finish before the deadline; side effects may have happened.';}
 else if(reason==='CDP_RESULT_TOO_LARGE'||reason==='CHUNK_UNAVAILABLE'){code='result_too_large';text='The protocol result is too large or expired.';}
 else if(reason==='TARGET_NOT_OWNED'){code='target_not_owned';text='Only task-created work tabs can be closed.';}
 else if(reason==='INVALID_VAULT_ARGS'){code='invalid_params';text='Credential fill arguments are invalid.';}
 else if(reason==='NO_DIALOG'){code='no_dialog';text='No JavaScript dialog is open on this task page.';}
 else if(reason==='DIALOG_OPEN'){code='dialog_open';text='A JavaScript dialog is blocking the page; handle it with the dialog action first.';}
 else if(reason==='INVALID_DIALOG_ARGS'){code='invalid_params';text='Dialog arguments are invalid.';}
 // 中文注释：网关把浏览器返回的协议错误首行交给 CDP 客户端；这些是协议消息，不含页面异常正文。
 else if(/^browser\.cdp$/.test(message.method)&&/^\{"code":-?\d+/.test(detail)){try{const cdp=JSON.parse(detail);code='cdp_error';text=String(cdp.message||'CDP error').slice(0,300);}catch{}}
 // 中文注释：只公开固定格式的扩展内部高亮错误码，不回传网页异常文本。
 else if(/^INTERACTION_HIGHLIGHT_[A-Z_]{1,40}$/.test(reason)){code=reason.toLowerCase();text='The interaction highlight could not be confirmed.';}
 else if(detail==='overlay injection failed'){code='overlay_injection_failed';text='The page overlay could not be initialized.';}
 else if(detail==='overlay scope stale'){code='overlay_scope_stale';text='The page overlay scope changed.';}
 else if(detail==='overlay frame changed'){code='overlay_frame_changed';text='The page overlay frame changed.';}
 else if(reason==='TAB_OUT_OF_SCOPE'){code='tab_out_of_scope';text='This work tab left the approved sites; navigate it back to an approved URL.';}
 else if(reason==='REDIRECTED_OUT_OF_SCOPE'){code='redirected_out_of_scope';text='Page redirected outside this task; open a new task for the returned origin.';}
 else if(reason==='NO_PREVIOUS_PAGE'){code='target_unavailable';text='There is no previous page in this tab.';}
 // 中文注释：网络游标过期与条目淘汰可明确恢复，不泄露内部 CDP 异常。
 else if(reason==='INVALID_NETWORK_OPTIONS'){code='invalid_params';text='Invalid network options.';}
 else if(reason==='NETWORK_CAPTURE_STALE'){code='network_capture_stale';text='Start a new capture and use its captureId.';}
 else if(reason==='NETWORK_ENTRY_UNAVAILABLE'){code='network_entry_unavailable';text='List captured requests again.';}
 else if(reason==='PARSE_CURSOR_STALE'){code='parse_cursor_stale';text='Page changed; restart parsing without the old cursor.';}
 else if(reason==='BUDGET_TOO_SMALL'){code='parse_budget_too_small';text='The page result exceeds this parse budget; increase the budget or narrow sections.';}
 else if(['INVALID_PARSE_OPTIONS','INVALID_OPTIONS'].includes(reason)){code='invalid_params';text='Invalid page parser options.';}
 // 中文注释：局部无障碍读取不可用时明确失败，不猜测控件名称或回传浏览器异常正文。
 else if(reason==='ACCESSIBILITY_UNAVAILABLE'){code='accessibility_unavailable';text='局部无障碍信息无法确认，请读取页面检查。';}
 else if(reason==='DOCUMENT_CHANGED'){code='document_changed';text='Document or navigation scope changed.';}
 else if(reason==='READ_ORIGIN_CHANGED'){code='site_changed';text='The page changed sites before the read completed; request a new site approval.';}
 else if(reason==='INVALID_NODE_REF'){code='stale_reference';text='The page reference is stale; obtain a new snapshot.';}
 else if(reason==='CAPTURE_CHANGED'){code='document_changed';text='Page content changed; obtain a new snapshot.';}
 else if(['DOM_CHANGED','DOCUMENT_REPLACED','NODE_CHANGED'].includes(detail)){code='document_changed';text='Page content changed; obtain a new snapshot.';}
 else if(['STALE_REF','STALE_SNAPSHOT','BINDING_MISMATCH'].includes(detail)){code='stale_reference';text='The page reference is stale; obtain a new snapshot.';}
 else if(['FRAME_TOKEN_STALE','FRAME_DISCOVERY_UNAVAILABLE'].includes(reason)){code='stale_frame';text='The selected frame changed; discover frames again.';}
 else if(detail==='origin denied'&&typeof error?.currentOrigin==='string'){code='tab_out_of_scope';text='同站用 goto_url，新站用 browser_shared_open。';}
 else if(['origin denied','origin scheme denied','origin authority mismatch','tab lease denied','confirmation required','stale generation'].includes(detail)){code='permission_denied';text='Task, tab, origin or approval authority is not valid.';}
 else if(['INVALID_ROOT','TARGET_NOT_ACTIONABLE','target not found'].includes(detail)){code='target_unavailable';text='The requested page target is not available.';}
 else if(['navigation timeout','NAVIGATION_TIMEOUT','PAGE_NOT_READY'].includes(detail)){code='page_not_ready';text='The page did not become ready within the deadline.';}
 // 中文注释：页面加载途中旧文档被替换时的 CDP 瞬时错误，归为“页面未就绪”，只读动作可重试，不再落入笼统的拒绝执行。
 else if(/^\{"code":-?\d+,"message":"(?:Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Cannot find frame|Frame with the given id was not found|No frame for given id)/.test(detail)){code='page_not_ready';text='The page is still loading or was replaced; read it again after it loads.';}
 const filePreDispatch=['artifact_path_denied','artifact_origin_denied','file_input_not_unique','not_file_input'].includes(code);
 let candidates;
 if(['reference_target_missing','reference_target_ambiguous','element_timeout'].includes(code)&&detail.includes('|')){
  try{const parsed=JSON.parse(decodeURIComponent(detail.slice(detail.indexOf('|')+1)));if(Array.isArray(parsed))candidates=parsed.slice(0,5).filter(item=>typeof item?.role==='string'&&typeof item?.name==='string').map(item=>({role:item.role.slice(0,40),name:item.name.slice(0,80)}));}catch{}
 }
 let obstruction;
 if(code==='target_occluded'&&detail.includes('|')){
  try{const parsed=JSON.parse(decodeURIComponent(detail.slice(detail.indexOf('|')+1)));if(typeof parsed?.role==='string'&&typeof parsed?.name==='string'){
   obstruction={role:parsed.role.slice(0,40),name:parsed.name.slice(0,80)};
   const button=parsed.closeButton;
   if(button&&typeof button.ref==='string'&&typeof button.snapshotId==='string'&&typeof button.name==='string')obstruction.closeButton={binding:button.binding,snapshotId:button.snapshotId,ref:button.ref,role:'button',name:button.name.slice(0,80)};
  }}catch{}
 }
 // 中文注释：目标几何或状态在派发前已拒绝，回执明确可重新读取后重试。
 const refusedBeforeDispatch=error?.preDispatch!==false&&['target_out_of_viewport','target_hidden','target_disabled','target_zero_size','target_unavailable','target_occluded','custom_select_unsupported'].includes(code);
 // 中文注释：仅附固定阶段码与合法 origin，任何路径、查询和网页异常文本都不转发。
 let currentOrigin;try{const url=new URL(error?.currentOrigin);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)currentOrigin=url.origin;}catch{}
 const stage = code==='document_changed'||code==='overlay_frame_changed'?{stage:'document',reasonCode:'document_changed'}:code==='overlay_injection_failed'&&error?.stage==='overlay'&&['initialization_exception','return_type_invalid'].includes(error?.reasonCode)?{stage:'overlay',reasonCode:error.reasonCode}:{};
 const actionConfirmed=error?.actionConfirmed===true&&code.startsWith('content_shield_');
 return {code,message:text,data:{outcomeUnknown:!actionConfirmed&&code!=='cdp_error'&&!readOnly&&!filePreDispatch&&!refusedBeforeDispatch&&error?.preDispatch!==true,retryable:readOnly&&['document_changed','stale_reference','stale_screenshot','screenshot_expired','page_not_ready','overlay_frame_changed','overlay_injection_failed'].includes(code),
  ...(actionConfirmed?{actionConfirmed:true}:{}),
  ...stage,
  ...(code==='click_no_effect'?{effect:'unobserved',suggestion:'输入已派发但未观察到效果；请读取目标页核对，检查按钮状态或改用页面支持的操作，不要反复重试。'}:{}),
  ...(['origin_denied','tab_out_of_scope'].includes(code)&&currentOrigin?{currentOrigin,scopeHint:'同站用 goto_url，新站用 browser_shared_open。'}:{}),
  ...(candidates?{candidates}:{}),
  ...(obstruction?{obstruction}:{}),
  ...(code==='redirected_out_of_scope'&&typeof error?.finalOrigin==='string'?{finalOrigin:error.finalOrigin}:{})}};
}
// 中文注释：连接授权就是任务页的完整访问授权；旧智能审批偏好不再参与连接。
export class BrowserConsent {
 constructor(_storage,executor){this.executor=executor;this.enabled=false;this.status='unknown';}
 async readStatus(){
  return 'enabled';
 }
 async load(){this.status=await this.readStatus();this.enabled=this.status==='enabled';return this.status;}
 synchronize(bridge){
  const valid=()=>!bridge.closed;
  const run=async()=>{
   if(!valid())return;
   const tasks=await bridge.request('extension.tasks');
   for(const task of tasks){
    if(!valid())return;
    if(task.state!=='pending_approval')continue;
    try{
     const approved=await bridge.request('extension.approve',{taskId:task.id,generation:task.generation,tabIds:[],allowedOrigins:task.allowedOrigins,workspaceOnly:true},valid);
     if(!valid())throw Error('browser consent revoked');
     // 中文注释：完整访问仍需宿主确认当前任务代次，连接不能授权浏览器里原有的个人标签页。
     const updated=await bridge.request('extension.mode',{taskId:task.id,generation:approved.generation,modeGeneration:approved.modeGeneration,mode:'full'});
     if(!valid())throw Error('browser mode changed');
     this.executor.setMode(updated);
    }catch(error){
     const local=this.executor.tasks.get(task.id);
     if(local&&!local.revoked&&local.generation===task.generation)await this.executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:false});
     if(!bridge.closed)await bridge.request('extension.stop',{taskId:task.id,generation:task.generation}).catch(()=>{});
     throw error;
    }
   }
  };
  const next=(this.syncQueue||Promise.resolve()).catch(()=>{}).then(run);this.syncQueue=next;return next;
 }
}
export class Bridge {
 constructor(port,executor,onChanged=()=>{},handlers={}) {
  this.ledger=new RequestLedger();this.port=port;this.executor=executor;this.pending=new Map();this.seen=new Map();this.privateSeen=new Set();this.onChanged=onChanged;this.closed=false;this.approvalBarrier=Promise.resolve();
  this.onConsentStatus=typeof handlers.onConsentStatus==='function'?handlers.onConsentStatus:async()=>'unknown';
  // 中文注释：配置由可信弹窗保存；发送前读取，缓存重放也使用当前开关。
  this.onContentFilter=handlers.onContentFilter||(async()=>false);
  this.onAccessRequest=typeof handlers.onAccessRequest==='function'?handlers.onAccessRequest:async()=>{throw Error('unsupported');};
  // 中文注释：Cookie 请求在账本前分流，禁止缓存 Cookie 载荷、指纹或结果。
  this.onCookieMirror=handlers.onCookieMirror;this.onCookieDisconnect=handlers.onCookieDisconnect;
  this.accessRequests=new Map();
  port.onMessage.addListener(m=>this.receive(m));
 }
 request(method,params={},guard=()=>true) {
  if(this.closed)return Promise.reject(Error('native disconnected'));
  if(this.pending.size>=128)return Promise.reject(Error('too many pending requests'));
  return new Promise((resolve,reject)=>{
   const id=crypto.randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('native request timed out'));},30000);
   this.pending.set(id,{resolve,reject,timer,method,params,guard});this.port.postMessage({id,method,params});
  });
 }
 close() {
  if(this.closed)return;this.closed=true;
  try{this.executor.diagnostics?.recordSafely({component:'mv3_background',event_type:'connection_state',connection_id:this.executor.diagnosticConnection,status:'disconnected',error_code:'DISCONNECTED'});}catch{}
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('native disconnected'));}
  this.onCookieDisconnect?.();
  this.pending.clear();this.seen.clear();this.privateSeen.clear();this.accessRequests.clear();
 }
 send(message) {if(!this.closed)this.port.postMessage(message);}
 async sendResult(request,response) {
  if(response.error||!['browser.execute','browser.status'].includes(request.method)){this.send(response);return;}
  try {
   const enabled=await this.onContentFilter();
   // 中文注释：已按 DOM 文本块处理的输出不能再次全字段正则匹配，否则会把相邻正常段落误拼成公告。
   if(this.executor.shieldResponse){const result=await this.executor.shieldResponse(request,response.result);this.send({...response,result:enabled&&result?.contentFilter?.enabled!==true?filterPageResult(request.params?.action,result):result});return;}
   this.send(enabled?{...response,result:filterPageResult(request.params.action,response.result)}:response);
  } catch(error) {
   if(error?.message==='CONTENT_SHIELD_STALE'){
    const data={outcomeUnknown:request.params.action==='popup_adopt',retryable:false};
    this.send({id:response.id,error:{code:'content_shield_stale',message:'屏蔽设置或页面已变化，请核对结果；不要重放写入。',data}});return;
   }
   // 中文注释：配置读取失败时不泄露未过滤正文，也不把已执行的脚本报告为未执行。
   const outcomeUnknown=['js.evaluate','popup_adopt'].includes(request.params.action);
   this.send({id:response.id,error:{code:'content_filter_unavailable',message:'Content filter settings could not be read; result withheld.',data:{outcomeUnknown,retryable:!outcomeUnknown}}});
  }
 }
 validateApproval(request,result) {
  if(!result||result.id!==request.taskId||(request.generation!==undefined&&result.generation!==request.generation)||!Number.isInteger(result.generation)||!sameValues(result.tabIds,request.tabIds)||!sameValues(result.allowedOrigins,request.allowedOrigins))throw Error('approval response mismatch');
 }
 receive(m) {
  if(this.closed||!m||typeof m!=='object')return;
  if(!m.method){
   const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);
   if(m.error){p.reject(Error(m.error.message));return;}
   if(p.method==='extension.mode'&&(!m.result||m.result.id!==p.params.taskId||m.result.generation!==p.params.generation||m.result.modeGeneration!==p.params.modeGeneration+1||m.result.activeMode!==p.params.mode)){p.reject(Error('mode response mismatch'));return;}
   if(p.method==='extension.approve'){
    const install=this.approvalBarrier.catch(()=>{}).then(async()=>{if(!p.guard())throw Error('browser consent revoked');this.validateApproval(p.params,m.result);await this.executor.approve(m.result,()=>!this.closed&&p.guard());return m.result;});
    this.approvalBarrier=install.catch(()=>{});install.then(p.resolve,p.reject);
   } else p.resolve(m.result);
   return;
  }
  if(m.method==='extension.consent_status'){
   if(!m.id||!m.params||Object.keys(m.params).length){if(m.id)this.send({id:m.id,error:{code:'invalid_params',message:'invalid consent status request'}});return;}
   Promise.resolve().then(()=>this.onConsentStatus()).then(value=>{
    const consentStatus=['enabled','disabled','unknown'].includes(value)?value:'unknown';
    this.send({id:m.id,result:{consentStatus}});
   },()=>this.send({id:m.id,result:{consentStatus:'unknown'}}));
   return;
  }
  if(m.method==='extension.access_request'){
   const p=m.params;
   if(!m.id||!p||Object.keys(p).length!==3||typeof p.requestId!=='string'||!p.requestId
    ||typeof p.instanceId!=='string'||!p.instanceId||typeof p.connectionGeneration!=='string'||!p.connectionGeneration){
    if(m.id)this.send({id:m.id,error:{code:'invalid_params',message:'invalid access request'}});return;
   }
   const scope=JSON.stringify([p.instanceId,p.connectionGeneration]);
   const prior=this.accessRequests.get(p.requestId);
   if(prior){
    if(prior.scope!==scope){this.send({id:m.id,error:{code:'request_conflict',message:'access request scope mismatch'}});return;}
    prior.promise.then(response=>this.send({id:m.id,...response}));return;
   }
   if(this.accessRequests.size>=128){this.send({id:m.id,error:{code:'capacity',message:'reconnect required'}});return;}
   const promise=Promise.resolve().then(()=>this.onAccessRequest({...p})).then(value=>{
    if(!value||Object.keys(value).length!==4||value.requestId!==p.requestId||value.instanceId!==p.instanceId
     ||value.connectionGeneration!==p.connectionGeneration||value.status!=='opened')throw Error('invalid access acknowledgement');
    return {result:{requestId:p.requestId,instanceId:p.instanceId,connectionGeneration:p.connectionGeneration,status:'opened'}};
   }).catch(()=>({error:{code:'access_request_failed',message:'authorization management could not be opened'}}));
   this.accessRequests.set(p.requestId,{scope,promise});
   promise.then(response=>this.send({id:m.id,...response}));
   return;
  }
  if(typeof m.method==='string'&&m.method.startsWith('browser.cookie_mirror.')){
   if(!m.id||typeof m.id!=='string'||!/^srv:[a-f0-9]{32}$/.test(m.id)||this.privateSeen.has(m.id)||this.privateSeen.size>=4096||!this.onCookieMirror){
    this.send({id:m.id,error:{code:'cookie_mirror_denied',message:'Cookie mirror private request denied.'}});return;
   }
   this.privateSeen.add(m.id);
   Promise.resolve().then(()=>this.onCookieMirror(m.method.slice('browser.cookie_mirror.'.length),m.params))
    .then(result=>this.send({id:m.id,result}),()=>this.send({id:m.id,error:{code:'cookie_mirror_denied',message:'Cookie mirror private request denied.'}}));
   return;
  }
  if(m.method==='tasks.changed'){this.onChanged();return;}
  if(!m.id)return;
  if(m.method==='browser.vault_inspect'||m.method==='browser.vault_fill'){
   // 中文注释：私有凭据请求只存一次性编号，不进入通用 JSON 指纹或结果重放缓存。
   if(typeof m.id!=='string'||!/^srv:[a-f0-9]{32}$/.test(m.id)||this.privateSeen.has(m.id)||this.privateSeen.size>=4096){
    this.send({id:m.id,error:{code:'vault_denied',message:'Vault private operation denied.'}});return;
   }
   this.privateSeen.add(m.id);
   Promise.resolve().then(()=>m.method==='browser.vault_inspect'?this.executor.vault.inspect(m.params):this.executor.vault.fill(m.params))
    .then(result=>this.send({id:m.id,result}),()=>this.send({id:m.id,error:{code:'vault_denied',message:'Vault private operation denied.'}}));
   return;
  }
  // 中文注释：网关 CDP 请求量大，不进入重放缓存；每个请求在执行器内重新核实授权，重复 ID 仅按新请求处理。
  if(typeof m.method==='string'&&/^browser\.cdp(?:_(?:targets|subscribe|close|activate|chunk|version))?$/.test(m.method)){
   if(this.gatewayInflight>=256){this.send({id:m.id,error:{code:'too_many_pending',message:'gateway backlog'}});return;}
   this.gatewayInflight=(this.gatewayInflight||0)+1;
   (async()=>{
    try{await this.approvalBarrier;if(this.closed)throw Error('native disconnected');return {id:m.id,result:await this.executor.gateway(m.method,m.params)};}
    catch(e){return {id:m.id,error:executionError(e,m)};}
   })().then(async r=>{this.gatewayInflight--;
    // 中文注释：原始请求执行期间用户可能开启过滤；发送前再检查，读失败也不交付原图。
    if(!r.error)try{if(await this.onContentFilter()){this.send({id:m.id,error:{code:'content_shield_unsupported',message:'过滤开启时拒绝原始 CDP 输出。'}});return;}}catch{this.send({id:m.id,error:{code:'content_filter_unavailable',message:'过滤设置无法读取，输出已拒绝。'}});return;}
    this.send(r);});
   return;
  }
  if(m.sequence!==undefined&&m.method!=='browser.credentials'){
   void this.ledger.run(m,()=>this.executeRequest(m)).then(r=>this.sendResult(m,r));return;
  }
  const payload=JSON.stringify(m);const prior=this.seen.get(m.id);
  if(prior){if(prior.payload!==payload)this.send({id:m.id,error:{code:'request_conflict',message:'request payload mismatch'}});else prior.promise.then(r=>this.sendResult(m,r));return;}
  if(this.seen.size>=2048){this.send({id:m.id,error:{code:'capacity',message:'reconnect required'}});return;}
  if(m.method==='browser.credentials'){
   // Retain only a denial tombstone, never a promise resolved with cookies.
   const denied={id:m.id,error:{code:'credential_replay_denied',message:'credential requests are single-use'}};
   this.seen.set(m.id,{payload,promise:Promise.resolve(denied)});
   (async()=>{try{await this.approvalBarrier;if(this.closed)return;
    const result=await this.executor.credentials(m.params);
    this.send({id:m.id,result});
   }catch{this.send({id:m.id,error:{code:'execution_denied',message:'API credential scope denied'}});}})();
   return;
  }
  const promise=this.executeRequest(m);
  this.seen.set(m.id,{payload,promise});promise.then(r=>this.sendResult(m,r));
 }
 async executeRequest(m){

   try{
    await this.approvalBarrier;
    if(this.closed)throw Error('native disconnected');
    let result;if(m.method==='browser.popup_prepare')result=await this.executor.preparePopup(m.params);else if(m.method==='browser.status')result=await this.executor.status(m.params);else if(m.method==='browser.assess')result=await this.executor.assess(m.params);else if(m.method==='browser.read_origin')result=await this.executor.readOrigin(m.params);else if(m.method==='browser.execute')result=await this.executor.execute(m.params);else if(m.method==='browser.release')result=await this.executor.release(m.params);else if(m.method==='browser.cleanup_status')result=await this.executor.cleanupStatus(m.params);else if(m.method==='browser.cleanup_retry')result=await this.executor.cleanupRetry(m.params);else if(m.method==='browser.download_cancel'){if(!this.executor.downloads)throw Error('DOWNLOADS_UNAVAILABLE');result=await this.executor.downloads.cancel(m.params);}else throw Error('unsupported method');
    return {id:m.id,result};
   } catch(e){return {id:m.id,error:executionError(e,m)};}
 }
}
