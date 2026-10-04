import {INPUT_ACTIONS} from './work-window.mjs';
import {observeInputEffect} from './action-effects.mjs';
import {DiagnosticEventBuffer,observeAction} from '../browser-diagnostics/js/diagnostics.mjs';
import {NativeWorkspaces,groupTitle} from './workspace-adapter.mjs';
import {createApprovalPolicy,POLICY_VERSION} from '../approval-policy/policy.mjs';
import {createPageSemantics} from '../page-semantics/index.js';
import {createPageParser} from '../page-semantics/parser.mjs';
import {createAutomationOverlay} from './automation-overlay.mjs';
import {createInteractionHighlight} from './interaction-highlight.mjs';
import {readyState as officialReadyState,navigate as officialNavigate,openTab as officialOpenTab} from './official-actions.mjs';
const canonical=value=>JSON.stringify(value, function(key,item){return item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item;});
// 中文注释：滚动会改变页面状态，智能审批必须按交互动作处理。
const policyAction=action=>({'images':'snapshot','console':'snapshot','dialog':'click','scroll':'click','back':'navigate','page.observe':'snapshot','page.parse':'snapshot','semantic_snapshot':'snapshot','frame_catalog':'snapshot','interaction.capture':'screenshot','interaction.bounds':'snapshot','interaction.click':'click','interaction.drag_coordinates':'click','interaction.drag_elements':'click','official.ready_state':'snapshot','official.goto_url':'navigate','official.new_tab':'new_tab'}[action]||action);
import {Interactions,createChromeDebuggerAdapter} from '../browser-interactions/index.mjs';
import {DownloadTracker} from './downloads.mjs';
import {PageRuntime} from './page-runtime.mjs';
import {observePage} from './page-observation.mjs';
import {PageObservers,listImages} from './page-observers.mjs';
import {VaultController} from './vault.mjs';

const MAX_PENDING_INTERACTION_PROBES=32;
const MAX_PENDING_INTERACTION_CLEANUPS=32;
const INTERACTION_CLEANUP_TIMEOUT_MS=300;
const INTERACTION_CLEANUP_TIMEOUT=Symbol('interaction cleanup timeout');
const RELEASE_DEADLINE_MS=2500;
const RELEASE_DEADLINE_EXPIRED=Symbol('release deadline expired');
const DOWNLOAD_KEY=/^[0-9a-f]{16}$/;

// 中文注释：调试会话重新附加后 Page 事件需重新开启；分离时同步清除标记。
// 中文注释：语义库安装记录同样随调试会话失效，键以 [tabId, 开头。
class AttachedTabs extends Set{
 constructor(){super();this.pageEvents=new Set();this.semanticWorlds=new Set();}
 delete(id){this.pageEvents.delete(id);for(const key of this.semanticWorlds)if(key.startsWith(`[${id},`))this.semanticWorlds.delete(key);return super.delete(id);}
 clear(){this.pageEvents.clear();this.semanticWorlds.clear();super.clear();}
}

const waitUntil=(promise,deadline)=>{
 const remaining=deadline-Date.now();
 if(remaining<=0)return Promise.resolve(RELEASE_DEADLINE_EXPIRED);
 let timer;
 return Promise.race([
  Promise.resolve(promise),
  new Promise(resolve=>{
    // 中文注释：定时器可能略早于绝对截止点触发；重读时钟后才宣布过期。
    const expire=()=>{const left=deadline-Date.now();if(left>0)timer=setTimeout(expire,left);else resolve(RELEASE_DEADLINE_EXPIRED);};
    timer=setTimeout(expire,remaining);
   }),
 ]).finally(()=>clearTimeout(timer));
};

const rememberCleanupUncertainty=(task,reason,tabIds=[])=>{
 if(!task)return;
 let disposition=task.cleanupUncertainty;
 if(!disposition||disposition.taskId!==task.id||disposition.generation!==task.generation){
  disposition={taskId:task.id,generation:task.generation,reasons:new Set(),tabIds:new Set()};
  task.cleanupUncertainty=disposition;
 }
 disposition.reasons.add(reason||'cleanup_uncertain');
 for(const id of tabIds)if(Number.isInteger(id))disposition.tabIds.add(id);
};

// 中文注释：在扩展后台用 OffscreenCanvas 把编号框画到 PNG 上；坐标按截图像素与 CSS 视口的比例换算。
async function annotatePng(base64,rows,viewport){
 const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
 const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
 const scale=bitmap.width/Math.max(1,viewport.width);
 const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
 ctx.drawImage(bitmap,0,0);
 ctx.lineWidth=Math.max(1,2*scale);ctx.font=`bold ${Math.round(12*scale)}px sans-serif`;ctx.textBaseline='top';
 for(const row of rows){
  const x=row.x*scale,y=row.y*scale,text=`[${row.label}]`,height=16*scale,width=ctx.measureText(text).width+6*scale;
  ctx.strokeStyle='#d0104c';ctx.strokeRect(x,y,row.width*scale,row.height*scale);
  const top=y>=height?y-height:y;
  ctx.fillStyle='#d0104c';ctx.fillRect(x,top,width,height);ctx.fillStyle='#ffffff';ctx.fillText(text,x+3*scale,top+2*scale);
 }
 const out=new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
 let binary='';for(let i=0;i<out.length;i+=0x8000)binary+=String.fromCharCode(...out.subarray(i,i+0x8000));
 return btoa(binary);
}

// 中文注释：遮罩只修改截图字节；先裁剪到 PNG 像素边界，避免任何敏感像素进入回执。
export async function maskCapturePng(base64,rects,viewport,format='png'){
 const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
 const mimeType=format==='jpeg'?'image/jpeg':'image/png';
 const bitmap=await createImageBitmap(new Blob([bytes],{type:mimeType}));
 const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
 if(!ctx||!viewport?.width||!viewport?.height)throw Error('CAPTURE_MASK_FAILED');
 ctx.drawImage(bitmap,0,0);ctx.fillStyle='#202124';
 for(const rect of rects){
  const left=Math.max(0,Math.floor(rect.x*bitmap.width/viewport.width));
  const top=Math.max(0,Math.floor(rect.y*bitmap.height/viewport.height));
  const right=Math.min(bitmap.width,Math.ceil((rect.x+rect.width)*bitmap.width/viewport.width));
  const bottom=Math.min(bitmap.height,Math.ceil((rect.y+rect.height)*bitmap.height/viewport.height));
  if(right>left&&bottom>top)ctx.fillRect(left,top,right-left,bottom-top);
 }
 const out=new Uint8Array(await (await canvas.convertToBlob({type:mimeType})).arrayBuffer());
 let binary='';for(let i=0;i<out.length;i+=0x8000)binary+=String.fromCharCode(...out.subarray(i,i+0x8000));
 return btoa(binary);
}

// 中文注释：语义页面函数在任何点击、赋值或按键之前抛出的原因；据此报告未派发。
const PRE_DISPATCH_PAGE_REASONS=new Set(['TARGET_OCCLUDED','TARGET_NOT_ACTIONABLE','TARGET_UNSTABLE','SENSITIVE_TARGET','STALE_REF','STALE_SNAPSHOT',
 'TARGET_DISABLED','TARGET_HIDDEN','TARGET_ZERO_SIZE','TARGET_OUT_OF_VIEWPORT','REF_TARGET_MISSING','REF_TARGET_AMBIGUOUS',
 'BINDING_MISMATCH','DOCUMENT_REPLACED','UNSUPPORTED_FRAME_TRANSFORM','POINTER_FRAME_UNSUPPORTED','TARGET_STATE_UNKNOWN','RADIO_CANNOT_UNCHECK',
 'INVALID_CHECKED_STATE','INVALID_SELECT_OPTIONS','SELECT_OPTION_AMBIGUOUS','SELECT_OPTION_DISABLED','SELECT_OPTION_MISSING','PRESS_TARGET_CHANGED']);

// 中文注释：只检查控件直接关联的字段语义；注入页面时序列化此纯函数，三个入口共用同一实现。
export function classifySensitiveField(e){
 if(!e)return null;
 if(String(e.type||'').toLowerCase()==='password')return 'password';
 const autocomplete=String(e.autocomplete||e.getAttribute?.('autocomplete')||'').toLowerCase().split(/\s+/);
 if(autocomplete.some(token=>['current-password','new-password'].includes(token)))return 'password';
 if(autocomplete.some(token=>/^cc-[a-z0-9-]+$/.test(token)))return 'payment';
 if(autocomplete.includes('one-time-code'))return 'otp';
 const described=String(e.getAttribute?.('aria-describedby')||'').split(/\s+/).filter(Boolean)
  .map(id=>e.ownerDocument?.getElementById(id)?.textContent||'').join(' ');
 const fields=[e.name,e.id,e.getAttribute?.('aria-label'),e.placeholder,...[...(e.labels||[])].map(label=>label.textContent),described];
 const words=fields.filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase();
 if(/password|passwd|passcode|密码/.test(words)||/(^|[^a-z0-9])(?:secret|token)(?=$|[^a-z0-9])/.test(words))return 'password';
 if(/银行卡|安全码|卡号/.test(words)||/(^|[^a-z0-9])(?:cvv|cvc|csc)\d?(?=$|[^a-z0-9])/.test(words))return 'payment';
 if(/(^|[^a-z0-9])(?:credit[ _-]?card|card[ _-]?(?:number|num|no)|cc[ _-]?(?:number|csc|cvc|cvv))(?=$|[^a-z0-9])/.test(words))return 'payment';
 if(/验证码/.test(words)||/(^|[^a-z0-9])(?:otp|mfa|one[ _-]?time(?:[ _-]?code)?|verification[ _-]?code)\d?(?=$|[^a-z0-9])/.test(words))return 'otp';
 return null;
}

// 中文注释：注入函数保留原函数头（诊断与测试按函数名识别），在函数体开头内联共用敏感判定。
function withSensitiveClassifier(fn){
 const source=fn.toString(),body=source.indexOf('{');
 return `${source.slice(0,body+1)}const classifySensitiveField=(${classifySensitiveField.toString()});const fileUploadVisualTarget=(${fileUploadVisualTarget.toString()});${source.slice(body+1)}`;
}

// 中文注释：文件输入仍是唯一派发目标；只选择页面上关联且可见的区域绘制高亮。
export function fileUploadVisualTarget(input){
 if(!input)return null;
 const doc=input.ownerDocument,linked=input.id?[...doc.querySelectorAll('label[for]')].find(label=>label.htmlFor===input.id):null;
 const candidates=[input,input.closest('label'),linked,input.closest('[data-upload],.upload,[role="button"]'),input.parentElement];
 return candidates.find(element=>{
  if(!element?.isConnected||!element.getClientRects().length)return false;
  const style=doc.defaultView.getComputedStyle(element),rect=element.getBoundingClientRect();
  return style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0&&
   rect.bottom>0&&rect.right>0&&rect.top<doc.defaultView.innerHeight&&rect.left<doc.defaultView.innerWidth;
 })||null;
}

// 中文注释：导出同一份页面执行函数供真实浏览器验收，避免测试复制动作实现。
export const semanticWorldDeclaration=`function(op,p){
 const createPageSemantics=${createPageSemantics.toString().replace(/^\s*\/\/[^\n]*\n/gm,'')};
 const createPageParser=${createPageParser.toString().replace(/^\s*\/\/[^\n]*\n/gm,'')};
 const same=(a,b)=>a&&b&&a.taskId===b.taskId&&a.documentId===b.documentId&&a.leaseId===b.leaseId;
 const make=()=>({binding:p.binding,semantics:createPageSemantics({document,taskId:p.binding.taskId,documentId:p.binding.documentId,leaseId:p.binding.leaseId,
  shadowRootOf:node=>node.shadowRoot||globalThis.__hermesClosedShadowRoots?.get(node)||null})});
 const classifySensitiveField=${classifySensitiveField.toString()};
 const sensitive=e=>classifySensitiveField(e)!==null;
 const fieldKind=e=>classifySensitiveField(e)||'sensitive';
 // 中文注释：遮挡时改点关联 label。
 const controlVisual=e=>{
  if(e.tagName!=='INPUT'||!['checkbox','radio'].includes(e.type))return e;
  const v=e.ownerDocument.defaultView,r=e.getBoundingClientRect(),h=r.width&&r.height?e.getRootNode().elementFromPoint(r.left+r.width/2,r.top+r.height/2):null;
  if(v.getComputedStyle(e).opacity!=='0'&&h&&![...e.labels].some(l=>l.contains(h)))return e;
  for(const l of e.labels){
   const b=l.getBoundingClientRect(),s=v.getComputedStyle(l);
   if(b.width>0&&b.height>0&&s.display!=='none'&&s.visibility==='visible')return l;
  }
  return e;
 };
 // 中文注释：frame 只支持正向轴对齐变换。
 const axisAligned=transform=>{
  if(transform==='none')return true;
  const m=/^matrix\\(([^)]+)\\)$/.exec(transform);if(!m)return false;
  const [a,b,c,d]=m[1].split(',').map(Number);
  return b===0&&c===0&&a>0&&d>0;
 };
 // 中文注释：可操作性检查和指针定位共用同源 frame 坐标换算，错误码仍由调用阶段指定。
 const framePoint=(frame,point,code)=>{
  const style=frame.ownerDocument.defaultView.getComputedStyle(frame);
  if(!axisAligned(style.transform))throw Error('UNSUPPORTED_FRAME_TRANSFORM');
  const box=frame.getBoundingClientRect(),scaleX=box.width/frame.offsetWidth,scaleY=box.height/frame.offsetHeight;
  if(!Number.isFinite(scaleX)||!Number.isFinite(scaleY)||scaleX<=0||scaleY<=0)throw Error(code);
  return {x:box.left+(frame.clientLeft+point.x)*scaleX,y:box.top+(frame.clientTop+point.y)*scaleY};
 };
 const actionable=(e,preferredPoint=null)=>{
  if(!e?.isConnected)throw Error('TARGET_NOT_ACTIONABLE');
  const first=e.getBoundingClientRect();let point=preferredPoint||{x:first.left+first.width/2,y:first.top+first.height/2};
  let current=e;
  while(current){
   const doc=current.ownerDocument,view=doc.defaultView,root=current.getRootNode();
   if(current.disabled||current.getAttribute('aria-disabled')==='true')throw Error('TARGET_DISABLED');
   if(current.closest('[inert],[aria-hidden="true"]'))throw Error('TARGET_HIDDEN');
   const style=view.getComputedStyle(current),r=current.getBoundingClientRect();
   if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||!current.getClientRects().length||r.width<=0||r.height<=0)throw Error('TARGET_ZERO_SIZE');
   if(point.x<0||point.y<0||point.x>=view.innerWidth||point.y>=view.innerHeight)throw Error('TARGET_OUT_OF_VIEWPORT');
   const hit=(root.host?root:doc).elementFromPoint(point.x,point.y);
   // 中文注释：隐藏页合成点击容许空命中。
   if(hit?.closest?.('[data-hermes-automation-overlay]')||(!hit&&!(p.syntheticHidden&&doc.visibilityState==='hidden'))||hit&&(hit!==current&&!current.contains(hit))){
    // 中文注释：遮挡摘要只取脱敏名称。
    let obstruction={role:hit?.getAttribute?.('role')||hit?.localName||'unknown',name:'',closeButton:null};
    if(hit?.ownerDocument===document&&state?.semantics){
     try{
      const blocker=hit.closest('[role="dialog"],[role="alertdialog"],[role="banner"],dialog')||hit;
      const snap=state.semantics.snapshot({root:blocker,mode:'interactive',budget:1800});
      const close=snap.items.find(item=>item.role==='button'&&/close|dismiss|关闭|取消/i.test(item.name));
      obstruction={role:blocker.getAttribute('role')||blocker.localName,name:snap.items.find(item=>item.ref!==close?.ref)?.name?.slice(0,80)||'',
       closeButton:close?{binding:snap.binding,snapshotId:snap.snapshotId,ref:close.ref,role:close.role,name:close.name}:null};
     }catch{}
    }
    throw Error('TARGET_OCCLUDED|'+encodeURIComponent(JSON.stringify(obstruction)));
   }
   if(sensitive(current)||sensitive(hit))throw Error('SENSITIVE_TARGET');
   if(root.host){current=root.host;continue;}
   if(doc===document)break;
   const frame=view.frameElement;if(!frame?.isConnected)throw Error('TARGET_NOT_ACTIONABLE');
   // 中文注释：跨同源 frame 时逐层换算 CSS 视口坐标；旋转/倾斜 frame 暂时显式拒绝。
   point=framePoint(frame,point,'TARGET_NOT_ACTIONABLE');
   current=frame;
  }
 };
 const prepareHighlight=(kind,target)=>{
  const overlay=globalThis.__hermesAutomationOverlay,highlight=overlay?.highlight;
  if(!highlight||!p.highlightBinding)return {ok:false,code:'HIGHLIGHT_UNAVAILABLE'};
  // 中文注释：只用控件可访问名称，绝不读取输入值作为可视化标签。
  const name=sensitive(target)?'敏感字段':(target.getAttribute?.('aria-label')||target.labels?.[0]?.textContent||target.innerText||'').trim().slice(0,48);
  const result=highlight.prepare({...p.highlightBinding,kind,target,label:name});
  if(result?.ok!==true)return result;
  const token=p.highlightBinding.operationToken;overlay.operationToken=token;overlay.paintedToken=null;
  const raf=globalThis.requestAnimationFrame?.bind(globalThis)||(callback=>setTimeout(callback,16));
  raf(()=>raf(()=>{if(globalThis.__hermesAutomationOverlay===overlay&&overlay.operationToken===token)overlay.paintedToken=token;}));
  return {ok:true,targetSummary:{role:String(target.getAttribute?.('role')||target.localName||'元素').slice(0,32),name}};
 };
 const verifyHighlight=target=>{
  const result=globalThis.__hermesAutomationOverlay?.highlight?.verify(p.highlightBinding,{target});
  if(result?.ok!==true)throw Error('INTERACTION_HIGHLIGHT_'+(result?.code||'UNAVAILABLE'));
  return result;
 };
 let state=globalThis.__hermesNativeSemanticsV2;
 if(op==='semantic_snapshot'||op==='page.parse'){
  if(!state||!same(state.binding,p.binding)){try{state?.semantics.revoke();}catch{}state=make();globalThis.__hermesNativeSemanticsV2=state;}
  try{if(op==='page.parse'){state.parser??=createPageParser(state.semantics.parsingContext());return state.parser.parse(p.options||{});}return state.semantics.snapshot(p.options||{});}catch(error){
   if(error?.message!=='DOCUMENT_REPLACED')throw error;
   try{state.semantics.revoke();}catch{}state=make();globalThis.__hermesNativeSemanticsV2=state;if(op==='page.parse'){state.parser=createPageParser(state.semantics.parsingContext());return state.parser.parse(p.options||{});}return state.semantics.snapshot(p.options||{});
  }
 }
 if(!state||!same(state.binding,p.binding))throw Error('BINDING_MISMATCH');
 const delivery=state.deliveryProbe;
 const deliveryMatches=()=>delivery&&delivery.snapshotId===p.snapshotId&&delivery.ref===p.ref&&delivery.token===p.highlightBinding?.operationToken;
 const clearDelivery=()=>{
  if(!state.deliveryProbe)return;
  for(const type of ['pointerdown','mousedown','click']){
   window.removeEventListener(type,state.deliveryProbe.globalListener,true);
   state.deliveryProbe.node.removeEventListener(type,state.deliveryProbe.targetListener,true);
  }
  state.deliveryProbe=null;
 };
 if(op==='probe_ref_delivery'||op==='clear_ref_delivery'){
  if(!deliveryMatches())throw Error('STALE_REF');
  const result={visibility:document.visibilityState,global:{...delivery.global},target:{...delivery.target}};
  if(op==='clear_ref_delivery')clearDelivery();
  return result;
 }
 if(op==='annotation_rects'){
  // 中文注释：只为本文档内仍可解析、在视口中的引用返回 CSS 视口矩形；子 frame 不标注。
  const rows=[];
  for(const entry of (Array.isArray(p.labels)?p.labels:[]).slice(0,200)){
   let node;try{node=state.semantics.resolve({...p.binding,snapshotId:p.snapshotId,ref:entry.ref});}catch{continue;}
   if(node.ownerDocument!==document)continue;
   const r=node.getBoundingClientRect();
   if(r.width<=0||r.height<=0||r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)continue;
   rows.push({label:entry.label,x:r.left,y:r.top,width:r.width,height:r.height});
  }
  return {rows,viewport:{width:innerWidth,height:innerHeight}};
 }
 // 中文注释：回读使用本次计划保存的节点。
 const reading=op==='read_ref_set_checked'||op==='read_ref_select_option';
 const usingDelivery=op==='synthetic_ref_click'||op==='synthetic_ref_set_checked';
 const usingSelection=op==='synthetic_ref_select_option'||op==='pointer_target'&&p.selectionTarget===true;
 const pending=(reading||usingSelection)&&state.pendingTarget?.snapshotId===p.snapshotId&&state.pendingTarget?.ref===p.ref?state.pendingTarget:null;
 if((reading||usingSelection)&&!pending||usingDelivery&&!deliveryMatches())throw Error('STALE_REF');
 const node=(usingDelivery?delivery.node:pending?.node)||state.semantics.resolve({...p.binding,snapshotId:p.snapshotId,ref:p.ref});
 // 中文注释：预审、准备和填写复用同一资格判断；disabled 仍由各阶段原有检查拒绝。
 const fillable=()=>!(!['INPUT','TEXTAREA'].includes(node.tagName)&&!node.isContentEditable&&node.getAttribute('contenteditable')!=='true'||node.type==='file'||node.type==='hidden'||node.readOnly);
 // 中文注释：计划和指针定位共用选项查找，保留缺失、歧义及禁用检查，不缓存页面节点。
 const ariaList=ids=>node.getAttribute('role')==='listbox'?node:node.getRootNode().getElementById?.(ids[0])||node.ownerDocument.getElementById(ids[0]);
 const ariaOption=list=>{
  const matches=[...(list?.querySelectorAll('[role="option"]')||[])].filter(option=>(p.by==='label'?(option.getAttribute('aria-label')||option.textContent||'').trim():option.getAttribute('data-value')??option.getAttribute('value'))===p.values[0]);
  if(matches.length!==1)throw Error(matches.length?'SELECT_OPTION_AMBIGUOUS':'SELECT_OPTION_MISSING');
  if(matches[0].disabled||matches[0].getAttribute('aria-disabled')==='true')throw Error('SELECT_OPTION_DISABLED');
  return matches[0];
 };
 if(reading)state.pendingTarget=null;
 if(op==='input_visibility')return {visibility:document.visibilityState};
 if(op==='ref_relocation')return {relocated:state.semantics.relocation()};
 if(op==='scroll_ref'){
  // 中文注释：只滚动目标所在的最近可滚动容器一屏的 80%，由调用方有上限地循环查找虚拟列表中未挂载的项。
  if(!['up','down'].includes(p.direction))throw Error('INVALID_SCROLL');
  const scrollable=e=>{const st=e.ownerDocument.defaultView.getComputedStyle(e);return /(auto|scroll)/.test(st.overflowY)&&e.scrollHeight>e.clientHeight+1;};
  let box=node;
  while(box&&!(box.nodeType===1&&scrollable(box)))box=box.parentElement||box.getRootNode?.().host||null;
  if(!box)throw Error('TARGET_NOT_SCROLLABLE');
  const before=box.scrollTop;
  box.scrollBy({top:(p.direction==='up'?-1:1)*Math.max(1,Math.round(box.clientHeight*0.8)),behavior:'instant'});
  return {scrolled:box.scrollTop!==before,container:'element',scrollTop:Math.round(box.scrollTop),atStart:box.scrollTop<=0,atEnd:box.scrollTop+box.clientHeight>=box.scrollHeight-1};
 }
 // A sensitive field is reported (kind only, never its value) so the person can fill it.
 if(op==='assess_ref_fill'||op==='assess_ref_press'){
  if(sensitive(node))return {targetAssessment:'sensitive',fieldKind:fieldKind(node)};
  // 中文注释：预审只判字段类别；视口和遮挡留给批准后的 prepare 阶段滚动并重查。
  if(op==='assess_ref_fill'&&(!fillable()||node.disabled))throw Error('TARGET_NOT_ACTIONABLE');
  if(op==='assess_ref_press'&&(typeof node.focus!=='function'||node.disabled||node.matches?.('input[type="file"],input[type="hidden"]')))throw Error('TARGET_NOT_ACTIONABLE');
  return {targetAssessment:'ordinary'};
 }
 const rectOf=()=>{const r=node.getBoundingClientRect();return [r.left,r.top,r.width,r.height];};
 if(op==='rect_ref')return rectOf();
 if(op.startsWith('prepare_ref_')||op==='reveal_ref'){
  // 中文注释：目标不可操作时居中滚动。
  let scrolled=false;
  const reveal=(block,target)=>{
   scrolled=true;
   target.scrollIntoView({behavior:'instant',block,inline:'nearest'});
   if(state.semantics.resolve({...p.binding,snapshotId:p.snapshotId,ref:p.ref})!==node)throw Error('STALE_REF');
  };
  const visual=p.checked!==undefined?controlVisual(node):node;
  try{actionable(visual);}catch(error){
   if(!['TARGET_OUT_OF_VIEWPORT','TARGET_OCCLUDED'].includes(String(error?.message||'').split('|',1)[0])||sensitive(node)||typeof node.scrollIntoView!=='function')throw error;
   // 中文注释：固定定位且在视口外的目标无法靠滚动移入；直接返回可恢复的视口错误。
   if(String(error?.message||'').startsWith('TARGET_OUT_OF_VIEWPORT')&&node.ownerDocument.defaultView.getComputedStyle(node).position==='fixed')throw error;
   reveal('center',visual);
   actionable(visual);
  }
  if(op==='reveal_ref'){actionable(visual);return {rect:rectOf(),scrolled};}
 }
 if(!reading)actionable(p.checked!==undefined?controlVisual(node):node);
 if(op==='confirm_ref')return {confirmed:true};
 if(op==='arm_ref_delivery'){
  // 中文注释：分别记录目标和整页事件。

  clearDelivery();
  const probe={node,snapshotId:p.snapshotId,ref:p.ref,token:p.highlightBinding.operationToken,
   global:{pointerdown:0,mousedown:0,click:0},target:{pointerdown:0,mousedown:0,click:0,trustedClick:0}};
  probe.globalListener=event=>{if(Object.hasOwn(probe.global,event.type))probe.global[event.type]++;};
  probe.targetListener=event=>{if(Object.hasOwn(probe.target,event.type))probe.target[event.type]++;if(event.type==='click'&&event.isTrusted)probe.target.trustedClick++;};
  for(const type of ['pointerdown','mousedown','click']){
   window.addEventListener(type,probe.globalListener,true);
   node.addEventListener(type,probe.targetListener,true);
  }
  state.deliveryProbe=probe;return {visibility:document.visibilityState};
 }
 if(op==='synthetic_ref_click'){

  const before=delivery.target.click;node.click();
  const received=delivery.target.click>before;
  return {clicked:received,kind:'dom-synthetic',delivery:received?'confirmed':'unconfirmed',
   fallbackReason:p.fallbackReason,effect:'unverified',...(received?{}:{outcomeUnknown:true})};
 }
 if(op==='prepare_ref_click')return prepareHighlight('click',node);
 if(op==='prepare_ref_set_checked')return prepareHighlight('click',controlVisual(node));
 if(op==='prepare_ref_select_option')return prepareHighlight('click',node);
 if(op==='prepare_ref_press')return prepareHighlight('input',node);
 if(op==='prepare_ref_fill'){
  if(!fillable())throw Error('TARGET_NOT_ACTIONABLE');
  return prepareHighlight('input',node);
 }
 if(op==='verify_ref_click'||op==='verify_ref_fill'||op==='verify_ref_press'||op==='verify_ref_set_checked'||op==='verify_ref_select_option')return verifyHighlight(op==='verify_ref_set_checked'?controlVisual(node):node);
 if(op==='focus_ref_press'||op==='press_check_ref'){
  // 中文注释：键盘事件仅在当前引用仍是实际焦点时派发，Shadow 与 iframe 分别检查自身根。

  if(op==='focus_ref_press')node.focus({preventScroll:true});
  if(node.getRootNode().activeElement!==node)throw Error('PRESS_TARGET_CHANGED');
  return {focused:true};
 }
 if(op==='inspect_ref_click'){
  if(node.tagName==='A'&&typeof node.target==='string'&&node.target.toLowerCase()==='_blank'&&node.hasAttribute('href')&&!node.hasAttribute('download'))return {kind:'blank_anchor',url:node.href};
  return {kind:'unsupported'};
 }
 if(op==='pointer_target'){

  // 中文注释：派发前复核指针命中。
  let target=p.checked!==undefined?controlVisual(node):node;
  if(p.optionTarget){
   const ids=(node.getAttribute('aria-controls')||'').trim().split(/\\s+/).filter(Boolean);
   target=ariaOption(ariaList(ids));
   target.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});
  }
  const r=target.getBoundingClientRect();let point={x:p.optionTarget?r.left+Math.min(12,r.width/4):r.left+r.width/2,y:r.top+r.height/2},doc=target.ownerDocument;
  actionable(target,point);
  // 中文注释：逐层映射 frame 坐标。
  while(doc!==document){
   const frame=doc.defaultView?.frameElement;if(!frame)throw Error('POINTER_FRAME_UNSUPPORTED');
   point=framePoint(frame,point,'POINTER_FRAME_UNSUPPORTED');
   doc=frame.ownerDocument;
  }
  return point;
 }
 // 中文注释：引用点击只能由宿主派发可信输入；页面世界不再提供合成点击入口。
 if(op==='plan_ref_set_checked'||op==='read_ref_set_checked'||op==='synthetic_ref_set_checked'){
  // 中文注释：先验状态再由宿主点击。
  if(typeof p.checked!=='boolean')throw Error('INVALID_CHECKED_STATE');
  const native=node.tagName==='INPUT'&&['checkbox','radio'].includes(node.type);
  const role=node.getAttribute('role');
  const aria=!native&&['checkbox','switch','radio'].includes(role);
  if(!native&&!aria)throw Error('TARGET_NOT_ACTIONABLE');
  const read=()=>native?node.checked:node.getAttribute('aria-checked');
  const before=read();
  if(aria&&!['true','false','mixed'].includes(before))throw Error('TARGET_STATE_UNKNOWN');
  if((native&&node.type==='radio'||role==='radio')&&!p.checked)throw Error('RADIO_CANNOT_UNCHECK');
  const matches=before===p.checked||before===String(p.checked);
  if(op==='plan_ref_set_checked'){state.pendingTarget={snapshotId:p.snapshotId,ref:p.ref,node};return {needsClick:!matches};}
  if(op==='synthetic_ref_set_checked'){

   const clicks=delivery.target.click;node.click();
   const after=read(),verified=node.isConnected&&(after===p.checked||after===String(p.checked))&&delivery.target.click>clicks;
   return {checked:after===true||after==='true',changed:true,verified,kind:'dom-synthetic',
    delivery:delivery.target.click>clicks?'confirmed':'unconfirmed',fallbackReason:p.fallbackReason,...(verified?{}:{outcomeUnknown:true})};
  }
  const verified=node.isConnected&&matches;
  return {checked:before===true||before==='true',changed:true,verified,kind:'trusted-input',...(verified?{}:{outcomeUnknown:true})};
 }
 if(op==='plan_ref_select_option'||op==='read_ref_select_option'||op==='apply_native_ref_select_option'||op==='synthetic_ref_select_option'){
  // 中文注释：原生控件按 value、去首尾空白的 Unicode 标签或零基 index 精确定位，校验全部选项后才写入。
  if(!Array.isArray(p.values)||p.values.length>100||!['value','label','index'].includes(p.by)||
   p.values.some(value=>p.by==='index'?!Number.isSafeInteger(value)||value<0:typeof value!=='string'||value.length>1000))throw Error('INVALID_SELECT_OPTIONS');
  if(node.tagName==='SELECT'){
   if(node.disabled)throw Error('TARGET_NOT_ACTIONABLE');
   if(!node.multiple&&p.values.length!==1)throw Error('INVALID_SELECT_OPTIONS');
   const options=[...node.options],selected=p.values.map(value=>{
    const matches=options.filter((option,index)=>p.by==='index'?index===value:p.by==='label'?option.label.trim()===value.trim():option.value===value);
    if(matches.length!==1)throw Error(matches.length?'SELECT_OPTION_AMBIGUOUS':'SELECT_OPTION_MISSING');
    if(matches[0].disabled||matches[0].parentElement?.disabled)throw Error('SELECT_OPTION_DISABLED');
    return matches[0];
   });
   if(new Set(selected).size!==selected.length)throw Error('INVALID_SELECT_OPTIONS');
   const wanted=new Set(selected),changed=options.some(option=>option.selected!==wanted.has(option));
   if(op==='plan_ref_select_option')return {kind:'native',needsChange:changed};
   if(op==='apply_native_ref_select_option'){

    // 中文注释：浏览器原生下拉弹层不能可靠按网页坐标操作；与 selectOption 相同，设置 selected 后派发两个冒泡事件。
    for(const option of options)option.selected=wanted.has(option);
    node.dispatchEvent(new Event('input',{bubbles:true}));
    node.dispatchEvent(new Event('change',{bubbles:true}));
    const finalOptions=[...node.options];
    const selectedOptions=[...node.selectedOptions].map(option=>({value:option.value,label:option.label.trim(),index:finalOptions.indexOf(option)}));
    const verified=node.isConnected&&node.options.length===options.length&&options.every((option,index)=>node.options[index]===option&&option.selected===wanted.has(option));
    return {changed,verified,selectedCount:selectedOptions.length,selectedOptions,kind:'native-select',...(verified?{}:{outcomeUnknown:true})};
   }
   throw Error('INVALID_SELECT_OPTIONS');
  }
  if(op==='apply_native_ref_select_option')throw Error('INVALID_SELECT_OPTIONS');
  // 中文注释：自定义 listbox/combobox 仍只支持单选，并由宿主派发可信指针点击。
  if(p.by==='index'||p.values.length!==1)throw Error('INVALID_SELECT_OPTIONS');
  const role=node.getAttribute('role'),ids=(node.getAttribute('aria-controls')||'').trim().split(/\\s+/).filter(Boolean);
  if(!['combobox','listbox'].includes(role)||role==='combobox'&&ids.length!==1)throw Error('INVALID_SELECT_OPTIONS');
  const list=ariaList(ids);
  if(op==='plan_ref_select_option'&&role==='combobox'&&node.getAttribute('aria-expanded')!=='true'&&!list){
   state.pendingTarget={snapshotId:p.snapshotId,ref:p.ref,node};
   return {kind:'aria',needsChange:true,needsOpen:true};
  }
  const option=ariaOption(list),selected=option.getAttribute('aria-selected')==='true';
  if(op==='plan_ref_select_option'){state.pendingTarget={snapshotId:p.snapshotId,ref:p.ref,node};return {kind:'aria',needsChange:!selected,needsOpen:role==='combobox'&&node.getAttribute('aria-expanded')!=='true'};}
  if(op==='synthetic_ref_select_option'){

   if(p.needsOpen)node.click();
   option.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});
   actionable(option);
   let clicks=0;const capture=()=>clicks++;
   option.addEventListener('click',capture,true);
   try{option.click();}finally{option.removeEventListener('click',capture,true);}
   const verified=option.isConnected&&option.getAttribute('aria-selected')==='true'&&clicks>0;
   return {changed:true,verified,selectedCount:option.getAttribute('aria-selected')==='true'?1:0,
    kind:'dom-synthetic',delivery:clicks>0?'confirmed':'unconfirmed',fallbackReason:p.fallbackReason,...(verified?{}:{outcomeUnknown:true})};
  }
  const verified=option.isConnected&&selected;
  return {changed:true,verified,selectedCount:selected?1:0,kind:'trusted-input',delivery:verified?'confirmed':'unconfirmed',...(verified?{}:{outcomeUnknown:true})};
 }
 if(op==='ref_fill'){
  if(!fillable())throw Error('TARGET_NOT_ACTIONABLE');
  if(node.isContentEditable||node.getAttribute('contenteditable')==='true'){node.focus();node.textContent=p.text;}
  else{
   const proto=node.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
   Object.getOwnPropertyDescriptor(proto,'value').set.call(node,p.text);
  }
  node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
  const readBack=node.isContentEditable||node.getAttribute('contenteditable')==='true'?node.textContent:node.value;
  return {filled:readBack===p.text,verified:readBack===p.text,kind:'dom-synthetic',...(readBack===p.text?{}:{outcomeUnknown:true})};
 }
 throw Error('unsupported semantic action');
}`.replace(/^\s*\/\/[^\n]*\n/gm,'').replace(/^\s*\n/gm,'').replace(/^ +/gm,'');

function interactionHighlightCommand(op,payload){
 const state=globalThis.__hermesAutomationOverlay;
 const binding=payload?.binding;
 if(!state||!state.highlight||!binding||binding.taskId!==state.taskId||binding.generation!==state.generation||binding.documentId!==state.documentId)return {ok:false,code:'STALE_DOCUMENT'};
 const finishPrepare=result=>{
  if(result?.ok!==true)return result;
  const token=binding.operationToken;state.operationToken=token;state.paintedToken=null;
  const raf=globalThis.requestAnimationFrame?.bind(globalThis)||(callback=>setTimeout(callback,16));
  raf(()=>raf(()=>{if(globalThis.__hermesAutomationOverlay===state&&state.operationToken===token)state.paintedToken=token;}));
  return {ok:true};
 };
 const unique=selector=>{
  let nodes;try{nodes=document.querySelectorAll(selector);}catch{throw Error('invalid selector');}
  if(nodes.length!==1)throw Error('TARGET_NOT_UNIQUE');
  return nodes[0];
 };
 if(op==='prepare-selector'){
  if(!Array.isArray(payload.allowedOrigins)||!payload.allowedOrigins.includes(location.origin))throw Error('origin denied');
  const target=(payload.selector===':focus'?document.querySelector(':focus')||document.body:document.querySelector(payload.selector));
  if(!target)throw Error('target not found');
  if(payload.kind==='input'&&classifySensitiveField(target))throw Error('sensitive target blocked');
  // 中文注释：文件输入可隐藏；高亮与复核指向关联的可见标签，文件选择仍只作用于原输入。
  const visual=payload.fileUpload?fileUploadVisualTarget(target):target;
  const name=classifySensitiveField(target)?'敏感字段':(visual?.getAttribute?.('aria-label')||visual?.labels?.[0]?.textContent||visual?.innerText||'').trim().slice(0,48);
  const prepared=finishPrepare(state.highlight.prepare({...binding,kind:payload.kind,target:visual,label:name,point:payload.point}));
  return prepared.ok?{...prepared,targetSummary:{role:String(visual?.getAttribute?.('role')||visual?.localName||'元素').slice(0,32),name}}:prepared;
 }
 if(op==='prepare-drag-selectors'){
  const from=unique(payload.fromSelector),to=unique(payload.toSelector);
  return finishPrepare(state.highlight.prepare({...binding,kind:'drag',from,to,label:'拖动元素'}));
 }
 if(op==='verify-selector'){
  const input=(payload.selector===':focus'?document.querySelector(':focus')||document.body:document.querySelector(payload.selector));
  const target=payload.fileUpload?fileUploadVisualTarget(input):input;
  return state.highlight.verify(binding,{target});
 }
 if(op==='verify-drag-selectors'){
  return state.highlight.verify(binding,{from:unique(payload.fromSelector),to:unique(payload.toSelector)});
 }
 // 中文注释：后台页不依赖 rAF；verify 同时核实挂载、目标几何及本次 token。
 if(op==='painted')return document.visibilityState==='hidden'?state.highlight.verify(binding):{ok:state.paintedToken===binding.operationToken};
 if(op==='complete')return state.highlight.complete({...binding,durationMs:payload.durationMs??500});
 if(op==='clear'){
  const result=state.highlight.clear(binding);
  if(state.operationToken===binding.operationToken){state.operationToken=null;state.paintedToken=null;}
  return result;
 }
 return {ok:false,code:'UNSUPPORTED_HIGHLIGHT_COMMAND'};
}

function hideCaptureDecorations(){
 // 中文注释：只调透明度，遮罩仍占位拦截点击。
 const nodes=[...new Set(document.querySelectorAll('[data-hermes-automation-overlay],[data-hermes-interaction-highlight]'))];
 const saved=nodes.map(element=>({element,opacity:element.style.getPropertyValue('opacity'),priority:element.style.getPropertyPriority('opacity'),computed:getComputedStyle(element).opacity}));
 globalThis.__hermesScreenshotSuppression={saved};
 try{
  for(const item of saved)item.element.style.setProperty('opacity','0','important');
  if(saved.some(item=>getComputedStyle(item.element).opacity!=='0'))throw Error('hide not confirmed');
  return {ok:true,count:saved.length};
 }catch{
  restoreCaptureDecorations();return {ok:false,code:'HIDE_FAILED'};
 }
}
function restoreCaptureDecorations(){
 const saved=globalThis.__hermesScreenshotSuppression?.saved||[];let ok=true;
 for(const item of saved){
  if(!item.element.isConnected)continue;
  try{
   if(item.opacity)item.element.style.setProperty('opacity',item.opacity,item.priority);else item.element.style.removeProperty('opacity');
   if(getComputedStyle(item.element).opacity!==item.computed)ok=false;
  }catch{ok=false;}
 }
 if(!ok)for(const item of saved)if(item.element.isConnected)item.element.remove();
 delete globalThis.__hermesScreenshotSuppression;
 return {ok};
}

export function origin(url) {
 const u=new URL(url);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('origin scheme denied');
 return u.origin;
}

export function pageAction(action,selector,text,key,allowedOrigins,highlightBinding=null) {
 const overlay=e=>!!e?.closest?.('[data-hermes-automation-overlay]');
 const sensitive=e=>classifySensitiveField(e)!==null;
 if(!allowedOrigins.includes(location.origin))throw Error('origin denied');
 if(action==='snapshot')return {url:location.href,title:document.title,elements:[...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].filter(e=>!overlay(e)).slice(0,300).map(e=>({tag:e.tagName,text:sensitive(e)?'[REDACTED]':(e.innerText||e.getAttribute('aria-label')||'').slice(0,300),sensitive:sensitive(e)}))};
 // 中文注释：官方 browser_press 作用于当前焦点；页面无焦点元素时按键落到 body，与浏览器默认行为一致。
 const e=selector===':focus'&&action!=='fill'?document.querySelector(':focus')||document.body:document.querySelector(selector);
 if(!e)throw Error('target not found');
 if(overlay(e))throw Error('target unavailable');
 if(e.closest('iframe')||e.disabled)throw Error('target unavailable');
 const confirmTarget=()=>{
  if(!e.isConnected||e.disabled||e.closest('[inert],[aria-hidden="true"]'))throw Error('TARGET_NOT_ACTIONABLE');
  const style=getComputedStyle(e);
  const position=()=>{const r=e.getBoundingClientRect();return {r,x:r.left+r.width/2,y:r.top+r.height/2};};
  let {r,x,y}=position();
  if(style.display==='none'||style.visibility!=='visible'||r.width<=0||r.height<=0||!e.getClientRects().length)throw Error('TARGET_ZERO_SIZE');
  // 中文注释：选择器动作与引用动作使用同一居中规则，固定定位的视口外目标不能靠滚动修复。
  if((x<0||y<0||x>=innerWidth||y>=innerHeight)&&style.position!=='fixed'&&typeof e.scrollIntoView==='function'){
   e.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});
   ({r,x,y}=position());
  }
  if(x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('TARGET_OUT_OF_VIEWPORT');
  const hit=document.elementFromPoint(x,y);
  if(!hit||overlay(hit)||hit!==e&&!e.contains(hit))throw Error('TARGET_OCCLUDED');
  return {ok:true};
 };
 const fieldKind=e=>classifySensitiveField(e)||'sensitive';
 if((action==='assess_fill'||action==='assess_press')&&sensitive(e))return {targetAssessment:'sensitive',fieldKind:fieldKind(e)};
 if(action==='confirm_click'||action==='confirm_fill')return confirmTarget();
 if(['fill','press','press_check'].includes(action)&&sensitive(e))throw Error('sensitive target blocked');
 if(action==='assess_fill'||action==='assess_press'){if(action==='assess_fill'&&(!['INPUT','TEXTAREA'].includes(e.tagName)||['file','hidden'].includes(e.type)||e.readOnly))throw Error('unsupported field');return {targetAssessment:'ordinary'};}
 if(action==='fill'){
  if(!['INPUT','TEXTAREA'].includes(e.tagName)||['file','hidden'].includes(e.type))throw Error('unsupported field');
  confirmTarget();
  const setter=Object.getOwnPropertyDescriptor(e.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set;
  setter.call(e,text);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
 } else if(action==='inspect_click'){
  if(e.tagName==='A'&&typeof e.target==='string'&&e.target.toLowerCase()==='_blank'&&e.hasAttribute('href')&&!e.hasAttribute('download')){
   const style=getComputedStyle(e),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
   if(!e.isConnected||style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||!e.getClientRects().length||r.width<=0||r.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('TARGET_NOT_ACTIONABLE');
   const hit=document.elementFromPoint(x,y);if(overlay(hit)||!hit||(hit!==e&&!e.contains(hit)))throw Error('TARGET_NOT_ACTIONABLE');
   return {kind:'blank_anchor',url:e.href};
  }
  return {kind:'unsupported'};
 } else if(action==='click'){confirmTarget();e.click();return {clicked:true,kind:'dom-synthetic'};}
 else if(action==='press'){
  if(!['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(key))throw Error('unsupported key');
  confirmTarget();
  e.focus();if(document.activeElement!==e)throw Error('target focus failed');
 } else if(action==='press_check'){
  if(document.activeElement!==e)throw Error('press target changed');
 } else throw Error('unsupported action');
 return {ok:true};
}

export function inspectPage(allowedOrigins) {
 const sensitive=e=>classifySensitiveField(e)!==null;
 if(!allowedOrigins.includes(location.origin))throw Error('origin denied');
 const fields=[...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')];
 const visible=e=>{
  if(e.type==='hidden'||e.closest('[hidden],[inert]'))return false;
  for(let node=e;node;node=node.parentElement){
   const style=getComputedStyle(node);
   if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
  }
  const r=e.getBoundingClientRect();
  return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;
 };
 const rects=fields.filter(e=>sensitive(e)&&String('value' in e?e.value:e.textContent||'').length>0&&visible(e)).map(e=>{
  const r=e.getBoundingClientRect();
  return {x:r.left,y:r.top,width:r.width,height:r.height,kind:'sensitive_field',role:e.localName,name:'敏感字段'};
 });
 return {hasSensitiveValue:rects.length>0,rects};
}

// 中文注释：内部动作身份不进入协议请求或审批摘要。
const OVERLAY_ACTION_TOKEN=Symbol('overlayActionToken');
// 中文注释：截图留出恢复遮罩的时间，先于默认 15 秒桥接请求期限结束等待。
const CAPTURE_TIMEOUT_MS=8000,OVERLAY_RESTORE_TIMEOUT_MS=3000,PREVEIL_COMMAND_TIMEOUT_MS=2000;
// 中文注释：新建页与导航最多等待八秒，DOM 可交互时即可返回。
export const PAGE_SETTLE_MS=8000;
const SETTLING_READ_ACTIONS=new Set(['snapshot','page.observe','page.parse','semantic_snapshot','frame_catalog','screenshot','interaction.capture','interaction.bounds','images']);
// 中文注释：页面加载途中旧文档被替换时 CDP 返回的瞬时错误；只读动作等加载完后自动重做一次。
const TRANSIENT_LOAD_ERROR=/^\{"code":-?\d+,"message":"(?:Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Cannot find frame|Frame with the given id was not found|No frame for given id)|^DOCUMENT_CHANGED$|^overlay frame changed$|^overlay injection failed$|^FRAME_COVERAGE_INCOMPLETE$/;
export const isTransientLoadError=error=>TRANSIENT_LOAD_ERROR.test(String(error?.message||'').split(/\r?\n/,1)[0].replace(/^Error: /,''));
const DISPATCHING_ACTIONS=new Set(['click','ref_click','interaction.click','press','ref_press','ref_set_checked','ref_select_option']);
export function preveilSource(allowedOrigins,{taskId='',generation=0}={}){
 return `(()=>{try{
 if(window.top!==window||!${JSON.stringify(allowedOrigins)}.includes(location.origin))return;
 globalThis.__hermesRemovePreveil?.();let host=null,removed=false;
 // 中文注释：预遮罩也在窗口捕获阶段拦截 top-layer 输入，不能仅依赖 host 命中。
 const keys=['keydown','keypress','keyup','beforeinput','pointerdown','pointerup','mousedown','mouseup','click','dblclick','auxclick','contextmenu','wheel','touchstart','touchmove'];
 const block=event=>{if(host?.isConnected&&event.isTrusted){event.preventDefault();event.stopImmediatePropagation();}};
 const observer=new MutationObserver(mount);
 function mount(){
  if(removed)return;const root=document.documentElement;if(!root)return;
  if([...document.querySelectorAll('[data-hermes-automation-overlay]')].some(node=>!node.hasAttribute('data-hermes-preveil'))){observer.disconnect();host?.remove();for(const type of keys)window.removeEventListener(type,block,true);return;}
  if(!host){
   host=document.createElement('div');host.setAttribute('data-hermes-automation-overlay','');host.setAttribute('data-hermes-preveil','');host.dataset.hermesOverlayTask=${JSON.stringify(taskId)};host.dataset.hermesOverlayGeneration=${JSON.stringify(String(generation))};host.tabIndex=-1;
   host.addEventListener('hermes-overlay-release',()=>globalThis.__hermesRemovePreveil?.());
   host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:auto;background:rgba(13,35,25,.10);border:2px solid rgba(31,117,75,.55);box-sizing:border-box;margin:0';
   const label=document.createElement('div');label.textContent='Hermes 正在工作 · 页面加载中';
   label.style.cssText='position:fixed;top:16px;right:16px;padding:12px 16px;border-radius:14px;background:#172a20;color:#fff;font:600 14px/1.4 system-ui,sans-serif';
   host.attachShadow({mode:'closed'}).append(label);
   // 中文注释：预遮罩不会因等待超时自行放开，完整遮罩接手后才卸载。
   for(const type of ['wheel','touchmove'])host.addEventListener(type,event=>event.preventDefault(),{passive:false});
  }
  if(!host.isConnected)root.append(host);
  for(const type of keys)window.addEventListener(type,block,{capture:true,passive:false});
  if(['IFRAME','FRAME'].includes(document.activeElement?.tagName))host.focus({preventScroll:true});
 }
 // 中文注释：后台只能通过隔离世界卸载本地输入拦截，不能把任务标成暂停或授权。
 globalThis.__hermesRemovePreveil=()=>{removed=true;observer.disconnect();host?.remove();for(const type of keys)window.removeEventListener(type,block,true);delete globalThis.__hermesRemovePreveil;};
 globalThis.__hermesRemovePreveil.taskId=${JSON.stringify(taskId)};globalThis.__hermesRemovePreveil.generation=${generation};
 observer.observe(document,{childList:true,subtree:true});mount();
}catch{}})()`;
}

export const V1_ACTIONS = Object.freeze(['tabs','new_tab','navigate','snapshot','click','fill','press','screenshot','page.observe','page.parse','semantic_snapshot','frame_catalog','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','files.upload','interaction.capture','interaction.bounds','interaction.click','interaction.drag_coordinates','interaction.drag_elements','official.ready_state','official.goto_url','official.new_tab','scroll','back',
 'js.evaluate','cdp.send','cdp.events','network.inspect','images','console','dialog']);
const SCRIPT_ACTIONS=new Set(['js.evaluate','cdp.send','cdp.events','network.inspect']);
const SITE_READ_ACTIONS=new Set(['snapshot','screenshot','page.observe','page.parse','semantic_snapshot','frame_catalog','interaction.capture','interaction.bounds','official.ready_state','images','console']);
function assertV1Action(action) { if(!V1_ACTIONS.includes(action))throw Error('V1 unsupported action'); }

export class Executor {
 constructor(api,onEvent=()=>{},{beforeLeaseRelease=async()=>{},onOverlayCommand=null,releaseDeadlineMs=RELEASE_DEADLINE_MS,onDownloadEvent=null,onCdpEvents=null}={}) {
  this.beforeLeaseRelease=beforeLeaseRelease;
  this.releaseDeadlineMs=Number.isFinite(releaseDeadlineMs)&&releaseDeadlineMs>0?Math.min(releaseDeadlineMs,RELEASE_DEADLINE_MS):RELEASE_DEADLINE_MS;
  // Only trusted extension background code may supply this callback. It must
  // fence the host task and read back the same task/generation before success.
  this.onOverlayCommand=onOverlayCommand;
  this.api=api;this.onEvent=onEvent;this.diagnostics=new DiagnosticEventBuffer();this.diagnosticConnection=crypto.randomUUID();this.tasks=new Map();this.leases=new Map();this.taskBarriers=new Map();this.attached=new AttachedTabs();this.semanticWorlds=this.attached.semanticWorlds;this.closingTabs=new Set();this.overlayCleanupTabs=new Set();this.docs=new Map();this.tabQueues=new Map();this.approvalQueue=Promise.resolve();this.actionGrants=new Map();this.fullGrants=new Set();this.spawnScopes=new Map();this.spawnLineage=new Map();this.pendingInteractionProbes=new Set();this.pendingInteractionCleanups=new Set();this.policy=createApprovalPolicy({verifyFullAccessGrant:g=>this.fullGrants.delete(g.grantId)});
  this.downloads=api.downloads&&typeof onDownloadEvent==='function'?new DownloadTracker(this,{report:onDownloadEvent}):null;
  this.pageRuntime=new PageRuntime(this,{pushEvents:typeof onCdpEvents==='function'?onCdpEvents:async()=>{}});
  this.observers=new PageObservers(this);
  this.vault=new VaultController(this);
 }
 // 中文注释：网关请求不进入普通动作队列，但每一步都重新核实任务、代次、租约与浏览器访问。
 async gateway(method,p){
  const t=this.tasks.get(p.taskId);this.check(t,p);
  this.pageRuntime.assertAccess(t);
  const checkMode=()=>{if(p.modeGeneration!==t.policy.modeGeneration)throw Error('mode generation mismatch');};checkMode();
  const guard=()=>{this.check(t,p);checkMode();this.pageRuntime.assertAccess(t);if(Number.isInteger(p.tabId)&&this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');if(t.offScopeTabs?.has(p.tabId))throw Error('TAB_OUT_OF_SCOPE');};
  if(method==='browser.cdp_chunk')return this.pageRuntime.chunk(p,t);
  // 中文注释：用户接管期间（含暂停请求在途时）拒绝一切原始 CDP，避免与用户同时操作页面。
  if(t.paused||t.pauseRequested)throw Error('task paused');
  if(method==='browser.cdp_targets')return this.pageRuntime.targets(t,p,guard);
  if(method==='browser.cdp_version'){
   this.pageRuntime.assertAccess(t);
   const agent=globalThis.navigator?.userAgent||'';const version=/(?:Chrome|Edg)\/([\d.]+)/.exec(agent)?.[1]||'0';
   return {protocolVersion:'1.3',product:`Chrome/${version}`,revision:'',userAgent:agent,jsVersion:''};
  }
  const tabByTarget=async targetId=>{
   const all=await this.api.debugger.getTargets();guard();
   const found=all.find(item=>(item.id===targetId||item.targetId===targetId)&&item.type==='page');
   if(!found||this.leases.get(found.tabId)!==t.id)throw Error('TARGET_UNAVAILABLE');
   await this.pageRuntime.assertTargetScope(t,{...p,tabId:found.tabId},guard);
   return found.tabId;
  };
  if(method==='browser.cdp_close'){
   this.pageRuntime.assert(t,{...p,tabId:await tabByTarget(p.targetId)});
   const tabId=await tabByTarget(p.targetId);
   // 中文注释：只关闭本任务新建的工作页，用户原有标签页不因网关请求关闭。
   if(!t.agentTabs.has(tabId))throw Error('TARGET_NOT_OWNED');
   // 中文注释：主动关页导致的 debugger detach 不应撤销整个任务；失败时立即清除此标记。
   this.closingTabs.add(tabId);
   try{await this.api.tabs.remove(tabId);return {success:true};}
   catch(error){this.closingTabs.delete(tabId);throw error;}
  }
  if(method==='browser.cdp_activate'){
   const tabId=await tabByTarget(p.targetId);this.pageRuntime.assert(t,{...p,tabId});
   await this.api.tabs.update(tabId,{active:true});return {};
  }
  if(!Number.isInteger(p.tabId)||this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');
  if(method==='browser.cdp_subscribe'){
   await this.pageRuntime.assertTargetScope(t,p,guard,{tabId:p.tabId,...(p.childSessionId?{sessionId:p.childSessionId}:{})});
   if(p.subscribe===true)this.pageRuntime.subscribe(t,p.tabId,p.childSessionId||null,'push');
   else this.pageRuntime.unsubscribe(t,p.tabId,p.childSessionId||null);
   return {subscribed:p.subscribe===true};
  }
  if(method!=='browser.cdp')throw Error('unsupported method');
  const target={tabId:p.tabId};
  if(!this.attached.has(p.tabId)){await this.api.debugger.attach(target,'1.3');guard();this.attached.add(p.tabId);}
  // 中文注释：原始命令也加入任务读屏障，接管等待已派发命令收尾后才交出页面。
  return this.taskBarrier(t.id,false,()=>{guard();return this.pageRuntime.send(t,p,guard,{gateway:true,filesVerified:p.filesVerified===true});});
 }
 // 中文注释：下载归属与 JS 对话框跟踪依赖任务页 Page 事件；每次附加调试会话后开启一次。
 async ensurePageEvents(target,guard){
  if(!Number.isInteger(target?.tabId)||!this.attached.has(target.tabId)||this.attached.pageEvents.has(target.tabId))return;
  // 中文注释：Page 事件只用于下载归属与对话框观察；开启失败不阻断主动作，下次附加后重试。
  try{await this.api.debugger.sendCommand({tabId:target.tabId},'Page.enable');}catch{return;}
  guard();this.attached.pageEvents.add(target.tabId);
 }
 approve(task,stillValid=()=>true) {
  const next=this.approvalQueue.catch(()=>{}).then(()=>this.installApproval(task,stillValid));
  this.approvalQueue=next.catch(()=>{});
  return next;
 }
 async installApproval(task,stillValid) {
  if(!stillValid())throw Error('approval disconnected');
  if(!task||typeof task.id!=='string'||!Number.isInteger(task.generation))throw Error('invalid task');
  if(!Array.isArray(task.allowedOrigins)||new Set(task.allowedOrigins).size!==task.allowedOrigins.length||task.allowedOrigins.some(o=>origin(o)!==o))throw Error('invalid origin');
  if(!Array.isArray(task.tabIds)||new Set(task.tabIds).size!==task.tabIds.length||task.tabIds.some(id=>!Number.isInteger(id)))throw Error('invalid tab');
  const ids=[...task.tabIds].sort((a,b)=>a-b);
  const initial=this.tasks.get(task.id);
  if(initial&&(!initial.revoked||initial.releasing))throw Error('task already active or releasing');
  for(const id of ids)if(this.leases.has(id)&&this.leases.get(id)!==task.id)throw Error('tab claimed');
  return this.withLocks(ids,async()=>{
   if(!stillValid())throw Error('approval disconnected');
   const existing=this.tasks.get(task.id);
   if(existing&&(!existing.revoked||existing.releasing))throw Error('task already active or releasing');
   for(const id of ids)if(this.leases.has(id)&&this.leases.get(id)!==task.id)throw Error('tab claimed');
   const tabs=await Promise.all(ids.map(id=>this.api.tabs.get(id)));
   if(!stillValid())throw Error('approval disconnected');
   for(const tab of tabs)this.allowed(task,tab.url);
   const current=this.tasks.get(task.id);
   if(current&&current!==existing&&(!current.revoked||current.releasing))throw Error('task already active or releasing');
   for(const id of ids)if(this.leases.has(id)&&this.leases.get(id)!==task.id)throw Error('tab claimed');
   if(!stillValid())throw Error('approval disconnected');
   for(const id of ids)for(const prior of this.tasks.values())if(prior.revoked){prior.agentTabs.delete(id);prior.tabIds.delete(id);}
   const t={...task,workspaceTabs:tabs,tabIds:new Set(ids),agentTabs:new Set(),revoked:false,releasing:0,semanticBindings:new Map(),frameSessions:new Map(),frameRefs:new Map(),childHighlights:new Map(),interactions:new Map(),interactionRefs:new Map(),interactionOperations:new Set(),pendingInteractionProbes:new Set(),pendingInteractionCleanups:new Set()};
   // 中文注释：保留原批准来源；实际 www 来源由扩展核实后加入本任务。
   t.approvedOrigins=[...task.allowedOrigins];t.allowedOrigins=[...task.allowedOrigins];
   t.policy=this.policy.createState({browserInstanceId:task.instanceId||task.id,taskId:task.id,ownerId:task.approvalScope||task.id,sessionId:task.approvalScope||task.id,taskGeneration:task.generation,connectionGeneration:task.generation});
   if(!Number.isSafeInteger(task.modeGeneration??1)||(task.modeGeneration??1)<1||(task.modeGeneration??1)>100000)throw Error('invalid mode generation');
   if(task.downloadKey!==undefined&&!DOWNLOAD_KEY.test(task.downloadKey))throw Error('invalid download key');
   while(t.policy.modeGeneration<(task.modeGeneration??1))t.policy=this.policy.revokeFullAccess(t.policy,'reconnect');
   // Capture and persist protection before publishing an executable task. Minimal
   // read-only API adapters without local storage cannot acquire cleanup authority.
   if(this.api.storage?.local){
    if(!this.workspaces)this.workspaces=new NativeWorkspaces(this.api,t.instanceId,id=>this.leases.has(id));
    t.workspaceCapability=await this.workspaces.install(t,t.workspaceTabs);
    if(!stillValid())throw Error('approval disconnected');
   }
   this.tasks.set(task.id,t);for(const id of ids)this.leases.set(id,t.id);
   queueMicrotask(()=>{for(const id of ids)void this.restoreOverlay(t,id);});
   return t;
  });
 }
 clearActionGrants(taskId){for(const [nonce,g] of this.actionGrants)if(g.taskId===taskId)this.actionGrants.delete(nonce);}
 revokeMode(taskId){const t=this.tasks.get(taskId);if(!t)return;void this.taskBarrier(taskId,true,async()=>{});this.pageRuntime?.clear(t);this.cancelInteractionOperations(t,'mode revoked');this.clearActionGrants(taskId);t.policy=this.policy.revokeFullAccess(t.policy);for(const [tabId,overlay] of t.overlays||[])void this.overlayCall(tabId,overlay,'revoke').catch(()=>{});}
 setMode(task){
  const t=this.tasks.get(task.id);this.check(t,{generation:task.generation});
  void this.taskBarrier(t.id,true,async()=>{});
  if(task.instanceId!==t.instanceId||task.approvalScope!==t.approvalScope)throw Error('mode scope mismatch');
  if(task.modeGeneration!==t.policy.modeGeneration+1)throw Error('mode generation mismatch');
  if(!['smart','full'].includes(task.activeMode))throw Error('invalid mode');
  if(task.activeMode==='full')this.cancelInteractionOperations(t,'mode revoked');
  this.pageRuntime.clear(t);
  this.clearActionGrants(t.id);
  if(task.activeMode==='smart'){this.revokeMode(t.id);return;}
  const grant={...t.policy.scope,policyVersion:POLICY_VERSION,expectedModeGeneration:t.policy.modeGeneration,grantId:crypto.randomUUID()};
  this.fullGrants.add(grant.grantId);t.policy=this.policy.enableFullAccess(t.policy,grant);
 }
 approveAction(approval){
  const t=this.tasks.get(approval.taskId);this.check(t,{generation:approval.generation});
  if(approval.modeGeneration!==t.policy.modeGeneration||approval.expiresAt*1000<=Date.now())throw Error('approval stale');
  if(this.actionGrants.has(approval.nonce)||this.actionGrants.size>=256)throw Error('approval capacity or duplicate');
  this.actionGrants.set(approval.nonce,structuredClone(approval));
 }
 async readOrigin(p){
  // 中文注释：首次访问预审只返回当前任务页来源，不读取标题、正文或截图。
  const t=this.tasks.get(p.taskId);this.check(t,p);
  if(p.modeGeneration!==t.policy.modeGeneration||t.paused||t.pauseRequested||this.leases.get(p.tabId)!==t.id)throw Error('TAB_OUT_OF_SCOPE');
  const tab=await this.api.tabs.get(p.tabId);this.check(t,p);
  if(!tab?.url)throw Error('TAB_OUT_OF_SCOPE');
  if(tab.url==='about:blank'&&t.officialBlank?.has(p.tabId))return {origin:'about:blank'};
  if(!t.allowedOrigins.includes(origin(tab.url)))for(const site of [...t.approvedOrigins]){
   try{this.acceptCommittedOrigin(t,site+'/',tab.url);break;}catch{/* 中文注释：逐个检查已批准来源的 www 变体。 */}
  }
  try{this.allowed(t,tab.url);}catch(error){throw Object.assign(error,{currentOrigin:origin(tab.url)});}
  if(t.allowedOrigins.includes(origin(tab.url)))t.offScopeTabs?.delete(p.tabId);
  if(tab.pendingUrl&&origin(tab.pendingUrl)!==origin(tab.url))throw Error('PAGE_NOT_READY');
  return {origin:origin(tab.url)};
 }
 async assess(p){
  const t=this.tasks.get(p.taskId);this.check(t,p);
  if(!['fill','press','ref_fill','ref_press'].includes(p.action)||this.leases.get(p.tabId)!==t.id||
     ![canonical(t.allowedOrigins),canonical(t.approvedOrigins)].includes(canonical(p.allowedOrigins)))throw Error('assessment scope denied');
  return this.lock(p.tabId,()=>this.assessTarget(t,p,()=>this.check(t,p)));
 }
 async assessTarget(t,p,guard){
  const action=p.action;
  const tab=await this.api.tabs.get(p.tabId);guard();this.allowed(t,tab.url);
  const target={tabId:p.tabId};
  if(!this.attached.has(p.tabId)){await this.api.debugger.attach(target,'1.3');try{guard();}catch(e){await this.api.debugger.detach(target).catch(()=>{});throw e;}this.attached.add(p.tabId);}
  const tree=await this.checkedFrameTree(target,t,guard,false);
  if(action==='ref_fill'||action==='ref_press'){
   const resolved=p.frameToken?await this.resolveFrame(t,p,tree,guard):null;
   const frame=resolved?.frame||tree.frame,frameTarget=resolved?.target||target;
   const binding=this.semanticBinding(t,p.tabId,frame.loaderId,resolved?.record.frameId);
   if(canonical(binding)!==canonical(p.binding))throw Error('BINDING_MISMATCH');
   // 中文注释：预审必须使用快照所在的覆盖层上下文，避免在另一隔离世界中丢失引用状态。
   const overlay=resolved?null:t.overlays?.get(p.tabId);
   const contextId=overlay?.documentId===frame.loaderId?overlay.contextId:null;
   return this.callSemanticWorld(frameTarget,frame.id,'assess_'+action,{binding:p.binding,snapshotId:p.snapshotId,ref:p.ref},guard,contextId);
  }
  return this.callWorld(target,tree.frame.id,t,'assess_'+action,p.selector,null,p.key,guard);
 }
 async authorize(t,p,guard){
  if((p.modeGeneration??1)!==t.policy.modeGeneration)throw Error('mode generation mismatch');
  // 中文注释：页面脚本与 CDP 直接复用任务的完整访问，不再申请第二层授权。
  // 中文注释：脚本、网络检查和原始 CDP 与其他写动作共用单次审批凭证。
  const action=policyAction(p.action);
  let confirmed=false;
  if(p.approval){
   const g=this.actionGrants.get(p.approval.nonce);this.actionGrants.delete(p.approval.nonce);
   const {generation,modeGeneration,allowedOrigins,approval,approvedReadOrigin,...request}=p;
   if(!g||g.taskId!==t.id||g.generation!==t.generation||g.modeGeneration!==t.policy.modeGeneration||g.expiresAt*1000<=Date.now()||g.digest!==approval.digest||canonical(g.request)!==canonical(request))throw Error('approval mismatch or consumed');
   confirmed=true;
  }
  if(!['tabs','snapshot','screenshot'].includes(action)&&t.policy.activeMode!=='full'&&!confirmed)throw Error('confirmation required');
  if(SCRIPT_ACTIONS.has(p.action)){
   if(Number.isInteger(p.tabId)&&this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');
   if(t.credentialTabs?.has(p.tabId))throw Error('CREDENTIAL_MODE_CONFLICT');
   return;
  }
  let targetAssessment;
  if(['fill','press','ref_fill','ref_press'].includes(action))targetAssessment=(await this.assessTarget(t,p,guard))?.targetAssessment;
  const decision=this.policy.decide(t.policy,{action,tabId:p.tabId},{...t.policy.scope,modeGeneration:t.policy.modeGeneration,leasedTabIds:[...t.tabIds].filter(id=>this.leases.get(id)===t.id),capabilities:{[action]:true,safeFieldEnforcement:true},targetAssessment});
  if(decision.decision==='deny')throw Error(decision.code);
  if(decision.decision==='confirm'&&!confirmed)throw Error('confirmation required');
 }
 check(t,p) {if(!t||t.revoked||this.tasks.get(t.id)!==t||t.generation!==p.generation)throw Error('stale generation');if(t.overlayStopping)throw Error('stop intent fenced');}
 // 中文注释：接管只冻结后续动作，不释放标签页，也不撤销当前任务授权。
 // 中文注释：任务控制同步所有已挂载遮罩；无法确认时保持派发冻结并报告未知。
 async syncTaskOverlays(t,state){
  await Promise.all([...(t.overlays||[])].map(async([tabId,entry])=>{
   if(this.leases.get(tabId)!==t.id)return;
   const result=await waitUntil(this.overlayCall(tabId,entry,'update',{update:{state}}),Date.now()+OVERLAY_RESTORE_TIMEOUT_MS);
   if(result!==true)throw Error('任务页面控制状态未确认');
  }));
 }
 async pause(taskId,generation) {
  const t=this.tasks.get(taskId);this.check(t,{generation});
  t.pauseRequested=true;
  // 中文注释：先显示等待进度并拒绝后续派发；屏障收尾前不能展示已暂停或放行人工输入。
  await this.syncTaskOverlays(t,'pausing');
  await this.taskBarrier(taskId,true,async()=>{});
  this.check(t,{generation});
  // 中文注释：人工操作可能改变 DOM 与截图，接管后旧页面引用必须失效。
  t.semanticBindings.clear();t.frameRefs.clear();t.interactionRefs.clear();
  for(const current of t.interactions.values())current.adapter.close();
  t.interactions.clear();
  t.paused=true;
  await this.syncTaskOverlays(t,'paused');
  for(const tabId of t.tabIds)void this.syncPreveil(t,tabId).catch(()=>{});
  return {paused:true};
 }
 async resume(taskId,generation) {
  const t=this.tasks.get(taskId);this.check(t,{generation});
  await this.syncTaskOverlays(t,'waiting');
  this.check(t,{generation});t.paused=false;t.pauseRequested=false;
  for(const tabId of t.tabIds)void this.syncPreveil(t,tabId).catch(()=>{});
  return {paused:false};
 }
 allowed(t,url) {if(!t.allowedOrigins.includes(origin(url)))throw Error('origin denied');}
 cancelInteractionOperations(t,reason='interaction cancelled') {
  for(const operation of t?.interactionOperations||[]){
   operation.active=false;
   if(!operation.controller.signal.aborted)operation.controller.abort(Error(reason));
  }
 }
 async lock(tabId,fn) {
  const prior=this.tabQueues.get(tabId)||Promise.resolve();const next=prior.catch(()=>{}).then(fn);this.tabQueues.set(tabId,next);
  try{return await next;}finally{if(this.tabQueues.get(tabId)===next)this.tabQueues.delete(tabId);}
 }
 async withLocks(ids,fn,index=0) {return index>=ids.length?fn():this.lock(ids[index],()=>this.withLocks(ids,fn,index+1));}
 async withSpawnScope(t,tabId,fn){
  const prior=this.spawnScopes.get(tabId),scope={task:t,root:tabId};
  this.spawnScopes.set(tabId,scope);
  try{return await fn();}finally{if(prior)this.spawnScopes.set(tabId,prior);else this.spawnScopes.delete(tabId);}
 }
 tabCreated(tab){
  if(!Number.isInteger(tab?.id)||!Number.isInteger(tab.openerTabId))return Promise.resolve(null);
  const lineage=this.spawnLineage.get(tab.openerTabId),direct=this.spawnScopes.get(tab.openerTabId);
  const scope=direct||(lineage&&this.spawnScopes.get(lineage.root)===lineage.scope?lineage.scope:null);
  const t=scope?.task;
  if(!t||this.leases.get(scope.root)!==t.id||(!t.workspaceCapability&&this.tasks.get(t.id)!==t)||!this.api.tabs?.get)return Promise.resolve(null);
  this.spawnLineage.set(tab.id,{task:t,root:scope.root,scope});
  const work=(async()=>{
   // Timing/opener is only a candidate, never causal ownership proof.
   if(!this.workspaces)this.workspaces=new NativeWorkspaces(this.api,t.instanceId,id=>this.leases.has(id));
   if(!t.workspaceCapability)t.workspaceCapability=await this.workspaces.install(t,t.workspaceTabs);
   const owned=await this.workspaces.spawned(t.workspaceCapability,tab);
   if(!owned){this.spawnLineage.delete(tab.id);return null;}
   if(t.revoked)await this.workspaces.cleanup(t.workspaceCapability,t.spawnCleanupExpired||Date.now()>=(t.releaseDeadline||Infinity)?{closeTabs:false}:t.cleanupOptions??{closeTabs:false});
   if(owned.status==='ready'&&!t.revoked)this.onEvent({taskId:t.id,generation:t.generation,tabId:tab.id,openerTabId:tab.openerTabId,groupId:owned.groupId,windowId:tab.windowId,event:'created'});
   return owned;
  })().catch(error=>{this.spawnLineage.delete(tab.id);throw error;});
  if(!t.pendingSpawns)t.pendingSpawns=new Set();
  t.pendingSpawns.add(work);void work.then(()=>t.pendingSpawns.delete(work),()=>t.pendingSpawns.delete(work));
  return work;
 }
 async cleanupStatus({taskId,generation}){
  const unknown={cleanupState:'unknown',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[],cleanupReason:'no_journal'};
  const t=this.tasks.get(taskId);
  if(t&&t.generation!==generation)return unknown;
  let status=unknown;
  if(this.workspaces){
   try{
    await this.workspaces.ready;
    const cap=t?.workspaceCapability||[...this.workspaces.recovered].find(([key])=>{const id=JSON.parse(key);return id[2]===taskId&&id[3]===generation;})?.[1];
    status=cap?await this.workspaces.cleanupStatus(cap):unknown;
   }catch{status=unknown;}
  }
  const disposition=t?.cleanupUncertainty;
  if(disposition?.taskId===taskId&&disposition.generation===generation){
   const unknownTabIds=[...new Set([...(status.unknownTabIds||[]),...disposition.tabIds])];
   return {...status,cleanupState:'unknown',unknownTabIds,unknownCount:Math.max(status.unknownCount||0,unknownTabIds.length),cleanupReason:[...disposition.reasons].join('|')||'cleanup_uncertain'};
  }
  return status;
 }
 // 中文注释：daemon 的终态记录只允许收组，不授予删页权；每页在锁内复核完整身份。
 async ungroupTerminal({taskId,generation,state,title,workTabs=[]}){
  if(!['closed','cancelled'].includes(state))return this.cleanupStatus({taskId,generation});
  const t=this.tasks.get(taskId);
  if(t&&(!t.revoked||t.generation!==generation))throw Error('cleanup scope not terminal');
  if(t?.deferredCleanup)await t.deferredCleanup;
  // 中文注释：优先使用当前任务能力；重载后从扩展私有创建日志恢复，绝不凭标题或 daemon 清单认领用户组。
  if(!this.workspaces)return {cleanupState:'unknown',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[],cleanupReason:'no_journal'};
  const options={records:workTabs,withTabLock:(id,fn)=>this.lock(id,fn),canUngroup:id=>{
   const current=this.tasks.get(taskId),owner=this.leases.get(id);
   return (!current||(current===t&&current.revoked&&current.generation===generation))&&(owner===undefined||owner===taskId);
  }};
  const result=t?.workspaceCapability?await this.workspaces.ungroup(t.workspaceCapability,options):await this.workspaces.ungroupTerminal(taskId,generation,options);
  // 中文注释：收组成功不抹掉在途脚本、资源清理等未确认结果，也不建立额外删页证明。
  if(t?.cleanupUncertainty)return {...result,cleanupState:'unknown',cleanupReason:'cleanup_uncertain'};
  return result;
 }
 async cleanupRetry({taskId,generation,tabIds,keepTabIds=[],ungroupOnly=false,state,title,workTabs}){
  if(ungroupOnly)return this.ungroupTerminal({taskId,generation,state,title,workTabs});
  const t=this.tasks.get(taskId);
  if(t&&(!t.revoked||t.generation!==generation||t.releasing))throw Error('cleanup scope not terminal');
  // Snapshot before any await: caller mutation cannot expand deletion authority.
  tabIds=Array.isArray(tabIds)?Object.freeze([...tabIds]):tabIds;
  const status=await this.cleanupStatus({taskId,generation});
  if(status.cleanupState==='unknown'||status.cleanupState==='failed')throw Error('cleanup ownership uncertain');
  if(!Array.isArray(tabIds)||tabIds.some(id=>!Number.isInteger(id)||id<0)||new Set(tabIds).size!==tabIds.length||!Array.isArray(status.remainingTabIds)||tabIds.length!==status.remainingTabIds.length||status.remainingTabIds.some(id=>!tabIds.includes(id)))throw Error('cleanup inventory changed; reconcile required');
  if(!this.workspaces)return status;
  const cap=t?.workspaceCapability||[...this.workspaces.recovered].find(([key])=>{const id=JSON.parse(key);return id[2]===taskId&&id[3]===generation;})?.[1];
  if(!cap)throw Error('cleanup authority unavailable');
  const protectedIds=[...new Set([...keepTabIds,...[...this.leases].filter(([,owner])=>owner!==taskId||t?.generation!==generation).map(([id])=>id)])];
  const canDelete=id=>{const owner=this.leases.get(id);return owner===undefined||(owner===taskId&&this.tasks.get(taskId)===t&&t?.generation===generation);};
  return this.workspaces.cleanup(cap,{closeTabs:true,keepTabIds:protectedIds,tabIds,canDelete});
 }
 // 中文注释：释放保持有界；锁内在途动作结束后只补做一次清理，不重放动作或扩大删除范围。
 async release(params) {
  params={...params,keepTabIds:[...(params.keepTabIds||[])]};
  const initial=this.tasks.get(params.taskId),inflight=[...(initial?.tabIds||[])].map(id=>this.tabQueues.get(id)).filter(Boolean);
  const result=await this.releaseOwned(params),t=this.tasks.get(params.taskId);
  if(result.cleanupState==='unknown'&&params.closeAgentTabs!==false&&t===initial&&t?.revoked&&t.generation===params.generation&&!t.deferredCleanup){
   const pending=[...new Set([...inflight,...[...t.tabIds].map(id=>this.tabQueues.get(id)).filter(Boolean)])];
   if(pending.length)t.deferredCleanup=Promise.allSettled(pending).then(async()=>{
    if(this.tasks.get(t.id)!==t||!t.revoked||t.releasing)return;
    await this.releaseOwned(params);
   }).catch(()=>{});
  }
  return result;
 }
 async releaseOwned({taskId,generation,closeAgentTabs=true,keepTabIds=[]}) {
  const deadline=Date.now()+this.releaseDeadlineMs;
  const t=this.tasks.get(taskId);
  keepTabIds=[...new Set([...keepTabIds,...[...this.leases].filter(([,owner])=>owner!==taskId||t?.generation!==generation).map(([id])=>id)])];
  const unknownResult=(reason='release_deadline_exceeded',tabIds=[])=>({released:true,cleanupState:'unknown',remainingTabIds:[],preservedTabIds:[],unknownTabIds:[...new Set(tabIds)],cleanupReason:reason});
  if(!t||t.generation!==generation){
   try{
    const ready=await waitUntil(this.workspaces?.ready||Promise.resolve(),deadline);
    if(ready===RELEASE_DEADLINE_EXPIRED)return unknownResult();
    if(this.workspaces?.cleanupRecovered){
     const cleanup=Promise.resolve().then(()=>{
      if(Date.now()>=deadline)throw RELEASE_DEADLINE_EXPIRED;
      const canDelete=id=>this.leases.has(id)?false:Date.now()<deadline?true:'defer';
      return this.workspaces.cleanupRecovered(taskId,generation,{closeTabs:closeAgentTabs,keepTabIds:[...keepTabIds],timeoutMs:Math.max(1,deadline-Date.now()),canDelete});
     });
     if(await waitUntil(cleanup,deadline)===RELEASE_DEADLINE_EXPIRED)return unknownResult();
    }
    const details=await waitUntil(this.cleanupStatus({taskId,generation}),deadline);
    return details===RELEASE_DEADLINE_EXPIRED?unknownResult():{released:true,...details};
   }catch{return unknownResult();}
  }
  t.cleanupOptions={closeTabs:closeAgentTabs,keepTabIds:[...keepTabIds]};
  t.releaseDeadline=deadline;
  t.revoked=true;this.pageRuntime.clear(t);this.cancelInteractionOperations(t,'stale generation');t.policy=this.policy.cancelTask(t.policy);this.clearActionGrants(t.id);t.releasing=(t.releasing||0)+1;
  let cleanupState='succeeded';
  // 中文注释：先同步撤权再登记写屏障；清理沿用有界 tab 锁，不等待无法中断的 CDP 耗尽释放期限。
  void this.taskBarrier(taskId,true,async()=>{});
  const markUnknown=(reason,tabIds=[...t.tabIds])=>{cleanupState='unknown';rememberCleanupUncertainty(t,reason,tabIds);};
  const current=()=>this.tasks.get(taskId)===t&&t.generation===generation;
  try{
   // 中文注释：先等待持久脚本移除回执，再继续解绑和关闭工作页。
   if(t.scriptCleanup){
    const scriptCleanup=await waitUntil(t.scriptCleanup,deadline);
    if(scriptCleanup===RELEASE_DEADLINE_EXPIRED)markUnknown('persistent_script_cleanup_timeout');
    else if(scriptCleanup.some(row=>row.status==='rejected'))markUnknown('persistent_script_cleanup_failed');
   }
   const hookWork=Promise.resolve().then(()=>{
    if(Date.now()>=deadline||!current())throw RELEASE_DEADLINE_EXPIRED;
    return this.beforeLeaseRelease(Object.freeze({taskId:t.id,generation:t.generation,cleanupOnly:true,tabIds:Object.freeze([...t.tabIds])}));
   });
   const hookDeadline=Math.min(deadline,Date.now()+2000);
   t.cleanupBarrier=waitUntil(hookWork,hookDeadline).then(result=>result===RELEASE_DEADLINE_EXPIRED
    ?{cleanupState:'unknown',reason:Date.now()>=deadline?'release_deadline_exceeded':'cleanup_hook_timeout'}
    :{cleanupState:'succeeded'}).catch(error=>({cleanupState:'unknown',reason:error===RELEASE_DEADLINE_EXPIRED?'release_deadline_exceeded':'cleanup_hook_failed'}));
   const hookResult=await waitUntil(t.cleanupBarrier,deadline);
   if(hookResult===RELEASE_DEADLINE_EXPIRED){markUnknown('release_deadline_exceeded');t.spawnCleanupExpired=true;}
   else if(hookResult.cleanupState!=='succeeded')markUnknown(hookResult.reason);

   if(t.pendingSpawns?.size&&Date.now()<deadline){
    const spawnResult=await waitUntil(Promise.allSettled([...t.pendingSpawns]),Math.min(deadline,Date.now()+2000));
    if(spawnResult===RELEASE_DEADLINE_EXPIRED){markUnknown('spawn_ownership_timeout');t.spawnCleanupExpired=true;}
   }else if(t.pendingSpawns?.size){markUnknown('release_deadline_exceeded');t.spawnCleanupExpired=true;}

   for(const id of [...t.tabIds]){
    if(Date.now()>=deadline){markUnknown('release_deadline_exceeded',[id]);break;}
    const tabRelease=this.lock(id,async()=>{
     if(!current()||this.leases.get(id)!==taskId)return {stale:true};
     if(Date.now()>=deadline){
      markUnknown('release_deadline_exceeded',[id]);
      return {expired:true};
     }
     let resources;
     try{resources=await this.closeTabResources(t,id,deadline);}catch{resources={cleanupState:'unknown'};}
     if(resources?.cleanupState==='unknown')markUnknown('tab_resource_cleanup_unknown',[id]);
     if(!current()||this.leases.get(id)!==taskId)return {stale:true};
     if(Date.now()>=deadline){
      markUnknown('release_deadline_exceeded',[id]);
      return {expired:true};
     }
     if(this.attached.has(id)){
      let detachDispatched=false;
      const detach=Promise.resolve().then(()=>{
       if(Date.now()>=deadline||!current()||this.leases.get(id)!==taskId)throw RELEASE_DEADLINE_EXPIRED;
       detachDispatched=true;return this.api.debugger.detach({tabId:id});
      });
      try{
       const result=await waitUntil(detach,deadline);
       if(result===RELEASE_DEADLINE_EXPIRED){
        markUnknown('debugger_detach_timeout',[id]);
        if(detachDispatched){
         try{await detach;this.attached.delete(id);}catch(error){if(error!==RELEASE_DEADLINE_EXPIRED)markUnknown('debugger_detach_failed',[id]);}
        }
       }else this.attached.delete(id);
      }catch(error){
       if(error===RELEASE_DEADLINE_EXPIRED)markUnknown('release_deadline_exceeded',[id]);
       else markUnknown('debugger_detach_failed',[id]);
      }
     }
     // 中文注释：代理新建页在关闭完成前保留租约，避免清理超时后被其他任务认领。
     if(current()&&this.leases.get(id)===taskId&&(!closeAgentTabs||!t.agentTabs.has(id)))this.leases.delete(id);
     return {expired:Date.now()>=deadline};
    });
    const result=await waitUntil(tabRelease,deadline);
    if(result===RELEASE_DEADLINE_EXPIRED){markUnknown('release_deadline_exceeded',[id]);break;}
    if(result?.expired){markUnknown('release_deadline_exceeded',[id]);break;}
   }
   // 中文注释：先移除页面资源并分离调试器，再关闭工作页；已删除页面无法回应清理命令。
   if(t.workspaceCapability&&Date.now()<deadline){
    try{
      const cleanup=this.withLocks([...t.tabIds].sort((a,b)=>a-b),()=>{
       if(Date.now()>=deadline||!current())throw RELEASE_DEADLINE_EXPIRED;
       const canDelete=id=>{
        const owner=this.leases.get(id);
        if(!current()||(owner!==undefined&&owner!==taskId))return false;
        return Date.now()<deadline?true:'defer';
       };
       return this.workspaces.cleanup(t.workspaceCapability,{closeTabs:closeAgentTabs&&!t.spawnCleanupExpired,keepTabIds:[...keepTabIds],timeoutMs:Math.max(1,deadline-Date.now()),canDelete});
      });
     const result=await waitUntil(cleanup,deadline);
     if(result===RELEASE_DEADLINE_EXPIRED)markUnknown('workspace_cleanup_timeout');
     else if(result?.cleanupState&&result.cleanupState!=='succeeded'){
      const affectedIds=Array.isArray(result.unknownTabIds)&&result.unknownTabIds.length?result.unknownTabIds:[...t.tabIds];
      markUnknown(result.cleanupReason||'workspace_cleanup_unknown',affectedIds);
     }
    }catch(error){markUnknown(error===RELEASE_DEADLINE_EXPIRED?'release_deadline_exceeded':'workspace_cleanup_failed');}
   }else if(!t.workspaceCapability)markUnknown('workspace_authority_unavailable');
   else markUnknown('release_deadline_exceeded');
   if(t.pendingInteractionProbes.size)markUnknown('interaction_probe_still_in_flight',[...t.pendingInteractionProbes].map(record=>record.tabId));
   if(t.pendingInteractionCleanups.size)markUnknown('interaction_cleanup_still_in_flight',[...t.pendingInteractionCleanups].map(record=>record.tabId));
   if(cleanupState!=='succeeded'){
    const details=await waitUntil(this.cleanupStatus({taskId,generation}),deadline);
    if(details===RELEASE_DEADLINE_EXPIRED)return unknownResult('release_deadline_exceeded',[...t.cleanupUncertainty?.tabIds||[]]);
    return {...details,released:true,cleanupState:'unknown',unknownTabIds:[...new Set([...(details.unknownTabIds||[]),...[...t.cleanupUncertainty?.tabIds||[]]])],cleanupReason:[...(t.cleanupUncertainty?.reasons||[])].join('|')||'cleanup_uncertain'};
   }
   const details=await waitUntil(this.cleanupStatus({taskId,generation}),deadline);
   if(details===RELEASE_DEADLINE_EXPIRED){markUnknown('release_deadline_exceeded');return unknownResult('release_deadline_exceeded',[...t.cleanupUncertainty.tabIds]);}
   if(details.cleanupState!=='succeeded'){
    const affectedIds=Array.isArray(details.unknownTabIds)&&details.unknownTabIds.length?details.unknownTabIds:[...t.tabIds];
    markUnknown(details.cleanupReason||'workspace_readback_unknown',affectedIds);
    return {...details,released:true,cleanupState:'unknown',unknownTabIds:[...new Set([...(details.unknownTabIds||[]),...t.cleanupUncertainty.tabIds])],cleanupReason:[...t.cleanupUncertainty.reasons].join('|')};
   }
   for(const id of t.agentTabs)if(current()&&this.leases.get(id)===taskId)this.leases.delete(id);
   return {released:true,...details};
  } finally {t.releasing--;}
 }
 async disconnect() {await Promise.all([...this.tasks.values()].map(t=>this.release({taskId:t.id,generation:t.generation,closeAgentTabs:false})));}
 async tabEvent(tabId,event,url,{status=null,urlChanged=true}={}) {
  const t=this.tasks.get(this.leases.get(tabId));if(!t)return;
  // 中文注释：浏览器事件会跨异步清理，旧任务回调不得修改新任务的标签租约。
  const current=()=>this.tasks.get(t.id)===t&&!t.revoked&&this.leases.get(tabId)===t.id;
  if(!current())return;
  if(event==='navigated'&&t.officialBlank?.has(tabId)){
   if(url==='about:blank')t.officialBlankSeen?.add(tabId);
   else if(url===t.officialBlankSeeds?.get(tabId)){
    const current=await this.api.tabs.get(tabId);
    // 中文注释：仅抑制建页种子 URL 的延迟事件；空白页之后真实回到该来源仍正常上报。
    if(!t.officialBlankSeen?.has(tabId)||current.url==='about:blank'||current.pendingUrl==='about:blank')return;
   }
  }
  const bump=async(keepNetwork=false)=>{
   if(!current())return null;
   await this.closeTabResources(t,tabId,null,{keepNetwork});
   if(!current())return null;
   const documentGeneration=(this.docs.get(tabId)||0)+1;this.docs.set(tabId,documentGeneration);return documentGeneration;
  };
  if(event==='closed') {
   const documentGeneration=await bump();
   if(documentGeneration===null)return;
   this.closingTabs.delete(tabId);
   // 中文注释：关闭工作页时同时清除该页凭据和页面脚本的互斥记录。
   t.credentialTabs?.delete(tabId);t.scriptedTabs?.delete(tabId);
   t.tabIds.delete(tabId);t.agentTabs.delete(tabId);t.agentTabGroups?.delete(tabId);t.officialBlank?.delete(tabId);t.officialBlankSeeds?.delete(tabId);t.officialBlankSeen?.delete(tabId);t.officialTargets?.delete(tabId);t.offScopeTabs?.delete(tabId);t.preveils?.delete(tabId);this.leases.delete(tabId);this.attached.delete(tabId);
   // 中文注释：关闭通知可能早于建页回执；宿主以原请求核对这个尚未登记的模型页。
   const creationRequestId=t.agentTabRequests?.get(tabId);t.agentTabRequests?.delete(tabId);
   this.onEvent({taskId:t.id,generation:t.generation,tabId,event,documentGeneration,...(creationRequestId?{creationRequestId}:{})});return;
  }
  let inScope=true;
  try{
   if(!(url==='about:blank'&&t.officialBlank?.has(tabId))){
    if(!t.allowedOrigins.includes(origin(url)))for(const site of [...t.approvedOrigins]){
     try{this.acceptCommittedOrigin(t,site+'/',url);break;}catch{/* 中文注释：只接受精确的同协议 www 对换。 */}
    }
    this.allowed(t,url);
   }
  }catch{inScope=false;}
  if(!inScope){
   // 中文注释：标签页离开授权网站时只冻结该页（不读取、不操作、不上报外站网址），
   // 任务与标签组保持不变；回到授权网站后可继续，不再因此新建任务和分组。
   const first=!t.offScopeTabs?.has(tabId);
   if(!t.offScopeTabs)t.offScopeTabs=new Set();t.offScopeTabs.add(tabId);
   const documentGeneration=await bump();
   if(documentGeneration===null)return;
   if(first)this.onEvent({taskId:t.id,generation:t.generation,tabId,event,documentGeneration,outOfScope:true});
   return;
  }
  if(url!=='about:blank'&&t.officialBlankSeen?.has(tabId)){
   // 中文注释：空白页确已出现后进入真实来源，立即撤销该标签页的空白页例外。
   t.officialBlank?.delete(tabId);t.officialBlankSeeds?.delete(tabId);t.officialBlankSeen.delete(tabId);
  }
  const returned=t.offScopeTabs?.delete(tabId)===true;
  // 中文注释：网站用 pushState/replaceState 改写网址时文档并未更换，保留遮罩、快照引用与文档代次，
  // 避免“刚读完页面就报 document_changed”。只有主框架 loaderId 变化才算换了文档。
  if(returned||await this.documentChanged(t,tabId)){
   const documentGeneration=await bump(true);
   if(documentGeneration===null)return;
   this.onEvent({taskId:t.id,generation:t.generation,tabId,event,documentGeneration,...(url?{url}:{})});
  }else if(current()&&urlChanged&&url){
   this.onEvent({taskId:t.id,generation:t.generation,tabId,event,documentGeneration:this.docs.get(tabId)||0,url,sameDocument:true});
  }
  // 中文注释：DOM 就绪即补完整遮罩，不等整页加载完成（广告、长连接可能让页面一直停在加载中）。
  if(status==='complete'||status==='dom_ready')void this.restoreOverlay(t,tabId);
 }
 async documentChanged(t,tabId){
  const known=t.overlays?.get(tabId)?.documentId;
  if(!known||!this.attached.has(tabId))return true;
  try{const tree=await this.api.debugger.sendCommand({tabId},'Page.getFrameTree',{});return tree?.frameTree?.frame?.loaderId!==known;}
  catch{return true;}
 }
 // 中文注释：页面刷新或跳转后立即重新盖上遮罩；任务结束前页面始终不可点击，接管后才放开。
 restoreOverlay(t,tabId){
  if(!this.api.debugger?.onEvent?.addListener||!this.api.debugger?.attach)return Promise.resolve(null);
  const generation=t.generation;
  const guard=()=>{this.check(t,{generation});if(this.leases.get(tabId)!==t.id)throw Error('tab lease denied');};
  // 中文注释：后台补遮罩有上限时间，CDP 卡住时也不会长期占用该标签页的动作锁。
  let timer;
  const bounded=work=>Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('overlay restore timeout')),OVERLAY_RESTORE_TIMEOUT_MS);})]).finally(()=>clearTimeout(timer));
  return this.lock(tabId,()=>bounded((async()=>{
   guard();
   const tab=await this.api.tabs.get(tabId);guard();this.allowed(t,tab.url);
   const target={tabId};
   if(!this.attached.has(tabId)){
    await this.api.debugger.attach(target,'1.3');
    try{guard();}catch(e){await this.api.debugger.detach(target).catch(()=>{});throw e;}
    this.attached.add(tabId);
   }
   const entry=await this.ensureOverlay(t,tabId,target,guard);
   if(entry){await this.overlayCall(tabId,entry,'update',{update:{state:t.pauseRequested&&!t.paused?'pausing':t.paused?'paused':'waiting'}});guard();}
   return entry;
  })())).then(entry=>{if(entry)void this.syncPreveil(t,tabId);return entry;},()=>null);
 }
 // 中文注释：新文档一开始就先挂一层简易遮罩（仅授权网站、仅顶层框架），完整遮罩注入后替换它。
 async syncPreveil(t,tabId){
  if(!this.attached.has(tabId))return;
  if(!t.preveilSync)t.preveilSync=new Map();
  // 同一标签页串行执行，且每步有超时；不持有动作锁。
  const prior=t.preveilSync.get(tabId)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
   const send=(method,params)=>waitUntil(this.api.debugger.sendCommand({tabId},method,params),Date.now()+PREVEIL_COMMAND_TIMEOUT_MS)
    .then(result=>{if(result===RELEASE_DEADLINE_EXPIRED)throw Error('preveil timeout');return result;});
   const want=!t.revoked&&!t.paused&&!t.pauseRequested&&this.leases.get(tabId)===t.id&&this.attached.has(tabId);
   const have=t.preveils?.get(tabId);
   if(want&&!have){
    await send('Page.enable',{});
    const added=await send('Page.addScriptToEvaluateOnNewDocument',{source:preveilSource(t.allowedOrigins,{taskId:t.id,generation:t.generation}),worldName:'hermes-automation-preveil'});
    if(typeof added?.identifier==='string'){if(!t.preveils)t.preveils=new Map();t.preveils.set(tabId,added.identifier);}
   }else if(!want&&have){
    t.preveils.delete(tabId);
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:have}).catch(()=>{});
   }
  });
  t.preveilSync.set(tabId,next);
  // 预遮罩只是加速覆盖的尽力而为措施，失败不影响任务，也不抛出。
  try{await next;}catch{}finally{if(t.preveilSync.get(tabId)===next)t.preveilSync.delete(tabId);}
 }
 async credentials(p) {
  const t=this.tasks.get(p.taskId);this.check(t,p);
  return this.lock(p.tabId,async()=>{
   // 中文注释：页面请求只检查任务、标签与来源；权限模式由动作审批链路处理。
   const guard=()=>{this.check(t,p);if(this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');};
   guard();const u=new URL(p.url);this.allowed(t,p.url);
   if(u.username||u.password||u.hash)throw Error('API URL denied');
   const doc=this.docs.get(p.tabId)||0;
   const tab=await this.api.tabs.get(p.tabId);guard();if(origin(tab.url)!==u.origin)throw Error('same-origin API required');
   if(!this.attached.has(p.tabId)){
    await this.api.debugger.attach({tabId:p.tabId},'1.3');
    try{guard();}catch(e){await this.api.debugger.detach({tabId:p.tabId}).catch(()=>{});throw e;}
    this.attached.add(p.tabId);
   }
   const result=await this.api.debugger.sendCommand({tabId:p.tabId},'Network.getCookies',{urls:[p.url]});
   guard();const after=await this.api.tabs.get(p.tabId);guard();
   if(doc!==(this.docs.get(p.tabId)||0)||origin(after.url)!==u.origin)throw Error('API document changed');
   const cookies=(result.cookies||[]).filter(c=>{
    if(c.partitionKey||c.partitionKeyOpaque||c.secure&&u.protocol!=='https:'||c.expires>0&&c.expires<=Date.now()/1000)return false;
    const domain=c.domain||'';const host=u.hostname;const path=c.path||'/';
    const domainMatch=domain.startsWith('.')?(host===domain.slice(1)||host.endsWith(domain)):host===domain;
    return domainMatch&&(u.pathname===path||u.pathname.startsWith(path)&&(path.endsWith('/')||u.pathname[path.length]==='/'));
   }).sort((a,b)=>(b.path||'/').length-(a.path||'/').length).map(c=>({name:c.name,value:c.value}));
   return {cookies};
  });
 }
 // 中文注释：写屏障等待此前全部读者；后来读者等待写者，同页仍由 tab 锁串行。
 taskBarrier(taskId,write,work){
  let state=this.taskBarriers.get(taskId);if(!state){state={writer:Promise.resolve(),readers:new Set(),pending:0};this.taskBarriers.set(taskId,state);}
  const previous=write?Promise.allSettled([state.writer,...state.readers]):state.writer;
  state.pending++;const next=previous.then(work);const settled=next.catch(()=>{});
  if(write){state.writer=settled;state.readers.clear();}else state.readers.add(settled);
  void settled.then(()=>{state.readers.delete(settled);if(--state.pending===0&&this.taskBarriers.get(taskId)===state)this.taskBarriers.delete(taskId);});
  return next;
 }
 // 中文注释：仅记录固定动作、阶段与数字耗时，异常内容不进入诊断。
 phase(p,stage,started,status='succeeded'){try{this.diagnostics.recordSafely({component:"mv3_background",event_type:"action_state",status,action:p.action,stage,duration_ms:Math.max(0,performance.now()-started)});}catch{/* 中文注释：诊断不可用不能改变页面动作结果。 */}}
 async timed(p,stage,work){const started=performance.now();let status='failed';try{const result=await work();status='succeeded';return result;}finally{this.phase(p,stage,started,status);}}
 async execute(p) {
  return observeAction(()=>this.executeAction(p),this.diagnostics,{component:'mv3_background',event_type:'action_state',action:p.action,request_id:crypto.randomUUID(),connection_id:this.diagnosticConnection});
 }
 async executeAction(p) {
  assertV1Action(p.action);
  const t=this.tasks.get(p.taskId);this.check(t,p);
  if(t.paused||t.pauseRequested)throw Object.assign(Error('task paused'),{code:'TASK_PAUSED',preDispatch:true});
  const supplied=JSON.stringify([...(p.allowedOrigins||[])].sort());
  if(supplied!==JSON.stringify([...t.allowedOrigins].sort())&&supplied!==JSON.stringify([...t.approvedOrigins].sort()))throw Error('origin authority mismatch');
  // Scope was checked before task lookup; smart/full cannot widen V1.
  if(!['tabs','new_tab','official.new_tab'].includes(p.action)){
   if(!Number.isInteger(p.tabId))throw Error('explicit tabId required');
   if(this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');
  }
  p={...p,[OVERLAY_ACTION_TOKEN]:crypto.randomUUID()};
  const queuedAt=performance.now();
  // 中文注释：工作区管理器串行登记建页；页面加载等待不占任务写屏障，多个新页可同时等待。
  const taskWide=['tabs'].includes(p.action)||p.clickMode==='open_link_in_task_tab';
  return this.taskBarrier(t.id,taskWide,async()=>{
   if(t.paused||t.pauseRequested)throw Object.assign(Error('task paused'),{code:'TASK_PAUSED',preDispatch:true});
   const modeGeneration=t.policy.modeGeneration;
   const perform=async()=>{
    let failure=null;
    try{
     if(t.paused||t.pauseRequested)throw Object.assign(Error('task paused'),{code:'TASK_PAUSED',preDispatch:true});
     this.phase(p,'queue_wait',queuedAt);
     if(t.policy.activeMode==='smart'&&SITE_READ_ACTIONS.has(p.action)&&p.approvedReadOrigin){
      const before=await this.api.tabs.get(p.tabId);this.check(t,p);
      if(typeof before.url!=='string'||origin(before.url)!==p.approvedReadOrigin||before.pendingUrl&&origin(before.pendingUrl)!==p.approvedReadOrigin)throw Object.assign(Error('READ_ORIGIN_CHANGED'),{preDispatch:true});
     }
     const result=await (Number.isInteger(p.tabId)?this.performSettled(t,p):this.perform(t,p));
     // 中文注释：成功使用模型工作页后更新顺序，超出四页时回收最久未用的一页。
     if(Number.isInteger(p.tabId)&&t.agentTabs?.has(p.tabId)){
      t.agentTabs.delete(p.tabId);t.agentTabs.add(p.tabId);
     }
     if(t.policy.activeMode==='smart'&&SITE_READ_ACTIONS.has(p.action)&&p.approvedReadOrigin){
      const after=await this.api.tabs.get(p.tabId);this.check(t,p);
      if(t.policy.modeGeneration!==modeGeneration||typeof after.url!=='string'||origin(after.url)!==p.approvedReadOrigin||after.pendingUrl&&origin(after.pendingUrl)!==p.approvedReadOrigin)throw Object.assign(Error('READ_ORIGIN_CHANGED'),{preDispatch:false});
     }
     return result;
    }
    catch(error){failure=error;throw error;}
    finally{
     // 中文注释：在同页锁内等待收回放行；异常、超时和撤销都执行，且不把撤销后的页面重新授权。
     const entry=t.overlays?.get(p.tabId);
     if(entry&&!this.observers.pending(t,p.tabId)){
      const current=!t.revoked&&!t.paused&&!t.pauseRequested&&t.policy.modeGeneration===modeGeneration&&this.leases.get(p.tabId)===t.id;
      const op=current&&failure?.message!=='INTERACTION_HIGHLIGHT_FRAME_TIMEOUT'?'update':'reblock';
      const extra={expectedActionToken:p[OVERLAY_ACTION_TOKEN],...(op==='update'?{update:{state:failure&&!failure.preDispatch?'unknown':'waiting'}}:{})};
      await waitUntil(this.overlayCall(p.tabId,entry,op,extra).catch(()=>false),Date.now()+OVERLAY_RESTORE_TIMEOUT_MS);
     }
    }
   };
   return Number.isInteger(p.tabId)?this.lock(p.tabId,perform):perform();
  });
 }
 // 中文注释：状态投影只包含本任务实际租约页，不把允许来源当作当前页面。
 async status({taskId,generation}){
  const t=this.tasks.get(taskId);
  if(!t||t.revoked||t.generation!==generation)return {pages:[],status:'unavailable'};
  const pages=[];
  for(const tabId of t.tabIds){
   if(this.leases.get(tabId)!==taskId)continue;
   try{const tab=await this.api.tabs.get(tabId);this.allowed(t,tab.url);
    if(t.revoked||t.generation!==generation||this.leases.get(tabId)!==taskId)continue;
    pages.push({tabId,title:String(tab.title||'').slice(0,120),origin:origin(tab.url),control:t.paused?'human':'hermes'});
   }catch{continue;}
  }
  return {pages,status:'confirmed',observedAt:Date.now()};
 }
 frameUrls(frameTree) {
  const urls=[];const visit=node=>{if(!node?.frame?.url)throw Error('frame origin unavailable');urls.push(node.frame.url);for(const child of node.childFrames||[])visit(child);};visit(frameTree);return urls;
 }
 frameNodes(frameTree) {
  const nodes=[];const visit=node=>{if(!node?.frame?.id)throw Error('frame unavailable');nodes.push(node);for(const child of node.childFrames||[])visit(child);};visit(frameTree);return nodes;
 }
 async ensureFrameSessions(t,tabId,guard){
  let record=t.frameSessions.get(tabId);
  if(record)return record;
  record={sessions:new Map(),configured:new Set(),listener:null};
  record.listener=(source,method,params)=>{
   if(source?.tabId!==tabId||t.revoked||this.leases.get(tabId)!==t.id)return;
   if(method==='Target.attachedToTarget'&&params?.targetInfo?.type==='iframe'
      &&typeof params.targetInfo.targetId==='string'&&typeof params.sessionId==='string'){
    record.sessions.set(params.targetInfo.targetId,{sessionId:params.sessionId,url:params.targetInfo.url});
    let site=null;try{site=origin(params.targetInfo.url);}catch{}
    if(t.allowedOrigins.includes(site)&&!record.configured.has(params.sessionId)){
     record.configured.add(params.sessionId);
     // 中文注释：跨进程子 frame 的再下一层需要对该子 session 继续自动附加。
     void this.api.debugger.sendCommand({tabId,sessionId:params.sessionId},'Target.setAutoAttach',{
      autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false}],
     }).catch(()=>{record.configured.delete(params.sessionId);});
    }
   }
   if(method==='Target.detachedFromTarget'&&typeof params?.targetId==='string')record.sessions.delete(params.targetId);
  };
  this.api.debugger.onEvent.addListener(record.listener);
  try{
   await this.api.debugger.sendCommand({tabId},'Target.setAutoAttach',{
    autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false}],
   });guard();t.frameSessions.set(tabId,record);return record;
  }catch(error){this.api.debugger.onEvent.removeListener(record.listener);throw error;}
 }
 async frameCatalog(t,p,target,guard){
  const rootTree=await this.checkedFrameTree(target,t,guard,false);
  const sessions=await this.ensureFrameSessions(t,p.tabId,guard);
  await this.api.debugger.sendCommand(target,'DOM.enable');guard();
  const document=await this.api.debugger.sendCommand(target,'DOM.getDocument',{depth:-1,pierce:true});guard();
  if(!document?.root)throw Error('FRAME_DISCOVERY_UNAVAILABLE');
  const previous=t.frameRefs.get(p.tabId)||new Map(),refs=new Map(),rows=[],seen=new Set();
  const queue=[{root:document.root,parentToken:null,depth:0,tree:rootTree,target}];let depthLimited=false;
  const frameElements=root=>{
   const nodes=[];
   const scan=node=>{if(node?.nodeName==='IFRAME'||node?.nodeName==='FRAME')nodes.push(node);
    for(const child of node?.children||[])scan(child);for(const shadow of node?.shadowRoots||[])scan(shadow);};
   scan(root);return nodes;
  };
  while(queue.length){
   const scope=queue.shift();
   if(scope.depth>6){depthLimited=true;continue;}
   const known=new Map(this.frameNodes(scope.tree).map(item=>[item.frame.id,item.frame]));
   for(const node of frameElements(scope.root)){
    if(rows.length>=100)throw Error('FRAME_LIMIT');
    if(node.frameId&&seen.has(node.frameId))throw Error('FRAME_DUPLICATE');
    if(node.frameId)seen.add(node.frameId);
    // 中文注释：未得到子 session 时有界等待，随后以 unavailable 行报告，不猜测 frame 目标。
    for(let attempt=0;attempt<20&&node.frameId&&!known.has(node.frameId)&&!sessions.sessions.has(node.frameId);attempt++){
     await new Promise(resolve=>setTimeout(resolve,50));guard();
    }
    let frame=known.get(node.frameId),sessionId=scope.target.sessionId||null,childTree=null;
    const attached=sessions.sessions.get(node.frameId);
    if(attached){
     sessionId=attached.sessionId;
     try{
      const child=await this.api.debugger.sendCommand({tabId:p.tabId,sessionId},'Page.getFrameTree');guard();
      if(child?.frameTree?.frame?.id===node.frameId){childTree=child.frameTree;frame=childTree.frame;}
     }catch{frame=null;}
    }
    let site=null;try{site=origin(frame?.url);}catch{}
    const access=!node.frameId?'frame_id_unavailable':!frame?.loaderId||!site?'session_unavailable':!t.allowedOrigins.includes(site)?'origin_denied':'ready';
    const row={index:rows.length,origin:site,access,kind:attached?'out_of_process':sessionId?'in_process_child_session':'in_process',
     ...(scope.parentToken?{parentFrameToken:scope.parentToken}:{})};
    // 中文注释：记录 iframe 在截图中的矩形；跨源或封闭 Shadow Root 也由 CDP 后端节点定位。
    if(node.backendNodeId){
     row.captureBackendNodeId=node.backendNodeId;
     row.captureSessionId=scope.target.sessionId||null;
     try{
      const {model}=await this.api.debugger.sendCommand(scope.target,'DOM.getBoxModel',{backendNodeId:node.backendNodeId});guard();
      const q=model?.border||model?.content;
      if(q?.length===8){
       const x=Math.min(q[0],q[2],q[4],q[6]),y=Math.min(q[1],q[3],q[5],q[7]);
       const width=Math.max(q[0],q[2],q[4],q[6])-x,height=Math.max(q[1],q[3],q[5],q[7])-y;
       const parent=scope.parentToken?rows.find(item=>item.frameToken===scope.parentToken):null;
       row.captureRect=parent?.captureRect?{x:parent.captureRect.x+x,y:parent.captureRect.y+y,width,height}:{x,y,width,height};
      }
     }catch{}
    }
    if(access==='ready'){
     // 中文注释：同一文档/会话保留原 token；导航、会话更换时发行新 token。
     const existing=[...previous].find(([,old])=>old.frameId===frame.id&&old.loaderId===frame.loaderId
      &&old.rootLoaderId===rootTree.frame.loaderId&&old.url===frame.url&&old.sessionId===sessionId
      &&old.parentFrameToken===scope.parentToken);
     const frameToken=existing?.[0]||crypto.randomUUID();
     refs.set(frameToken,{taskId:t.id,generation:t.generation,tabId:p.tabId,rootLoaderId:rootTree.frame.loaderId,
      frameId:frame.id,loaderId:frame.loaderId,url:frame.url,sessionId,parentFrameToken:scope.parentToken});
     Object.assign(row,{frameToken,documentId:frame.loaderId});
     if(node.contentDocument)queue.push({root:node.contentDocument,parentToken:frameToken,
      depth:scope.depth+1,tree:scope.tree,target:scope.target});
     else if(attached&&childTree){
      const childTarget={tabId:p.tabId,sessionId};
      await this.api.debugger.sendCommand(childTarget,'DOM.enable');guard();
      const childDoc=await this.api.debugger.sendCommand(childTarget,'DOM.getDocument',{depth:-1,pierce:true});guard();
      if(!childDoc?.root)throw Error('FRAME_DISCOVERY_UNAVAILABLE');
      queue.push({root:childDoc.root,parentToken:frameToken,depth:scope.depth+1,tree:childTree,target:childTarget});
     }else if(!node.contentDocument&&!attached)depthLimited=true;
    }
    rows.push(row);
   }
  }
  t.frameRefs.set(p.tabId,refs);
  return {frames:rows,coverage:{found:rows.length,ready:rows.filter(row=>row.access==='ready').length,
   complete:!depthLimited&&rows.every(row=>row.access==='ready'),depthLimited,scope:'dom_frame_elements_including_shadow'}};
 }
 async resolveFrame(t,p,rootTree,guard){
  const token=p.frameToken||p.options?.frameToken;
  const record=t.frameRefs.get(p.tabId)?.get(token);
  if(!record||record.taskId!==t.id||record.generation!==t.generation||record.rootLoaderId!==rootTree.frame.loaderId)throw Error('FRAME_TOKEN_STALE');
  // 中文注释：嵌套 frame 写入前逐级核对祖先文档和来源；父 frame 重建不能把旧子引用交给新页面。
  const seen=new Set([token]);let parentToken=record.parentFrameToken;
  for(let depth=0;parentToken;depth++){
   if(depth>=6||seen.has(parentToken))throw Error('FRAME_TOKEN_STALE');
   seen.add(parentToken);
   const parent=t.frameRefs.get(p.tabId)?.get(parentToken);
   if(!parent||parent.taskId!==t.id||parent.generation!==t.generation||parent.rootLoaderId!==rootTree.frame.loaderId)throw Error('FRAME_TOKEN_STALE');
   const parentTarget=parent.sessionId?{tabId:p.tabId,sessionId:parent.sessionId}:{tabId:p.tabId};
   const parentTree=parent.sessionId?(await this.api.debugger.sendCommand(parentTarget,'Page.getFrameTree')).frameTree:rootTree;guard();
   const currentParent=this.frameNodes(parentTree).find(item=>item.frame.id===parent.frameId)?.frame;
   if(!currentParent||currentParent.loaderId!==parent.loaderId||currentParent.url!==parent.url)throw Error('FRAME_TOKEN_STALE');
   this.allowed(t,currentParent.url);parentToken=parent.parentFrameToken;
  }
  const target=record.sessionId?{tabId:p.tabId,sessionId:record.sessionId}:{tabId:p.tabId};
  const current=record.sessionId?(await this.api.debugger.sendCommand(target,'Page.getFrameTree')).frameTree:rootTree;guard();
  const frame=this.frameNodes(current).find(item=>item.frame.id===record.frameId)?.frame;
  if(!frame||frame.loaderId!==record.loaderId||frame.url!==record.url)throw Error('FRAME_TOKEN_STALE');
  this.allowed(t,frame.url);
  return {record,frame,target,token};
 }
 async scrollFrameChain(t,p,resolved,rootTree,guard){
  // 中文注释：从外到内滚动 iframe 宿主，避免嵌套跨进程页在视口外被浏览器暂停绘制。
  const refs=t.frameRefs.get(p.tabId),chain=[];let token=resolved.token;
  while(token){
   if(chain.length>=7)throw Error('FRAME_TOKEN_STALE');
   const record=refs?.get(token);if(!record)throw Error('FRAME_TOKEN_STALE');
   chain.unshift(record);token=record.parentFrameToken;
  }
  let parentTarget={tabId:p.tabId};
  const findHost=(node,frameId)=>{
   if(!node)return null;
   if((node.nodeName==='IFRAME'||node.nodeName==='FRAME')&&node.frameId===frameId)return node;
   for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){
    const found=findHost(child,frameId);if(found)return found;
   }
   return findHost(node.contentDocument,frameId);
  };
  for(const record of chain){
   await this.api.debugger.sendCommand(parentTarget,'DOM.enable');guard();
   const document=await this.api.debugger.sendCommand(parentTarget,'DOM.getDocument',{depth:-1,pierce:true});guard();
   const host=findHost(document?.root,record.frameId);
   if(!Number.isInteger(host?.backendNodeId)||host.backendNodeId<1)throw Error('FRAME_TOKEN_STALE');
   await this.api.debugger.sendCommand(parentTarget,'DOM.scrollIntoViewIfNeeded',{backendNodeId:host.backendNodeId});guard();
   if(record.sessionId)parentTarget={tabId:p.tabId,sessionId:record.sessionId};
  }
  const after=await this.resolveFrame(t,p,rootTree,guard);
  if(after.token!==resolved.token||after.frame.loaderId!==resolved.frame.loaderId)throw Error('FRAME_TOKEN_STALE');
  return after;
 }
 async ensureChildHighlight(t,p,resolved,guard){
  const current=t.childHighlights.get(resolved.token);
  if(current?.documentId===resolved.frame.loaderId&&current.sessionId===resolved.record.sessionId)return current;
  const world=await this.api.debugger.sendCommand(resolved.target,'Page.createIsolatedWorld',{
   frameId:resolved.frame.id,worldName:'hermes-native-semantics-v2',grantUniveralAccess:false,
  });guard();
  const contextId=world.executionContextId,nonce=crypto.randomUUID();
  const declaration=`function(scope){
   const labels=Object.freeze({click:'准备点击',input:'正在输入',select:'正在选择',drag:'正在拖动'});
   const DEFAULT_COMPLETE_MS=600,MAX_COMPLETE_MS=2000,owners=new WeakMap();
   const createInteractionHighlight=${createInteractionHighlight.toString()};
   const old=globalThis.__hermesAutomationOverlay;
   if(old?.highlight&&old.operationToken)old.highlight.clear({taskId:old.taskId,generation:old.generation,documentId:old.documentId,operationToken:old.operationToken});
   const state={taskId:scope.taskId,generation:scope.generation,documentId:scope.documentId,nonce:scope.nonce,active:true,operationToken:null,paintedToken:null};
   globalThis.__hermesAutomationOverlay=state;
   state.highlight=createInteractionHighlight({document,taskId:scope.taskId,generation:scope.generation,documentId:scope.documentId,
    isCurrent:binding=>globalThis.__hermesAutomationOverlay===state&&state.active&&binding.taskId===state.taskId&&binding.generation===state.generation&&binding.documentId===state.documentId});
   return true;
  }`;
  const result=await this.api.debugger.sendCommand(resolved.target,'Runtime.callFunctionOn',{
   executionContextId:contextId,functionDeclaration:declaration,
   arguments:[{value:{taskId:t.id,generation:t.generation,documentId:resolved.frame.loaderId,nonce}}],returnByValue:true,
  });guard();
  if(result.exceptionDetails||result.result?.value!==true)throw Error('CHILD_HIGHLIGHT_UNAVAILABLE');
  const entry={contextId,documentId:resolved.frame.loaderId,nonce,target:resolved.target,
   frameId:resolved.frame.id,sessionId:resolved.record.sessionId,tabId:p.tabId,child:true};
  t.childHighlights.set(resolved.token,entry);return entry;
 }
 async closeTabResources(t,tabId,releaseDeadline=null,{keepOverlay=false,keepNetwork=false}={}) {
  // 中文注释：释放标签资源时丢弃网络正文；导航保留同一捕获的有界记录。
  if(!keepNetwork)t.execution?.network?.delete(tabId);
  let cleanupState='succeeded';
  // 中文注释：主动跳转前保留遮罩，旧页面在新页面接手前一直不可点击；换文档后由页面事件统一清理。
  const overlay=keepOverlay?null:t?.overlays?.get(tabId);
  if(overlay){t.overlays.delete(tabId);this.api.debugger.onEvent?.removeListener(overlay.listener);
   // Navigation/detach can destroy the context first; removal is best effort.
   // Bound only our wait: Chrome's already-sent CDP request is still in flight.
   let removed;
   try{
    const remaining=Number.isFinite(releaseDeadline)?releaseDeadline-Date.now():INTERACTION_CLEANUP_TIMEOUT_MS;
    if(remaining<=0)removed={timedOut:true};
    else removed=await this.trackInteractionCleanup(t,'overlay-remove',()=>this.overlayCall(tabId,overlay,'remove'),Math.min(INTERACTION_CLEANUP_TIMEOUT_MS,remaining),releaseDeadline);
   }catch{removed={failed:true};}
   if(removed?.timedOut||removed?.failed)cleanupState='unknown';
  }
  for(const [key,current] of t?.interactions||[]){
   if(key!==tabId&&!(typeof key==='string'&&key.startsWith(`${tabId}:`)))continue;
   try{current.adapter.close();}catch{}t.interactions.delete(key);
  }
  for(const [token,child] of t?.childHighlights||[]){
   if(child.tabId!==tabId)continue;
   t.childHighlights.delete(token);
   const removed=await waitUntil(this.api.debugger.sendCommand(child.target,'Runtime.callFunctionOn',{
    executionContextId:child.contextId,
    functionDeclaration:`function(){const s=globalThis.__hermesAutomationOverlay;if(s?.highlight&&s.operationToken)s.highlight.clear({taskId:s.taskId,generation:s.generation,documentId:s.documentId,operationToken:s.operationToken});delete globalThis.__hermesAutomationOverlay;return true;}`,
    returnByValue:true,
   }).catch(()=>false),Date.now()+INTERACTION_CLEANUP_TIMEOUT_MS);
   if(removed===RELEASE_DEADLINE_EXPIRED)cleanupState='unknown';
  }
  t?.interactionRefs?.delete(tabId);
  t?.semanticBindings?.delete(tabId);
  for(const key of t?.semanticBindings?.keys()||[])if(typeof key==='string'&&key.startsWith(`${tabId}:`))t.semanticBindings.delete(key);
  t?.frameRefs?.delete(tabId);
  const sessions=t?.frameSessions?.get(tabId);
  if(sessions){
   t.frameSessions.delete(tabId);this.api.debugger.onEvent.removeListener(sessions.listener);
   const stopped=await waitUntil(this.api.debugger.sendCommand({tabId},'Target.setAutoAttach',{
    autoAttach:false,waitForDebuggerOnStart:false,flatten:true,
   }).catch(()=>false),Date.now()+INTERACTION_CLEANUP_TIMEOUT_MS);
   if(stopped===RELEASE_DEADLINE_EXPIRED)cleanupState='unknown';
  }
  return {cleanupState};
 }
 // 中文注释：只接收后台读取的本实例任务和工作区日志，不把清理能力暴露给页面或工具协议。
 async cleanupOrphanOverlays(records,instanceId){
  const stale=records.filter(t=>t.instanceId===instanceId&&['needs_sync','cancelled','closed','failed'].includes(t.state));
  if(!stale.length)return;
  const workspaces=await this.workspaces.status();
  for(const t of stale){
   const tabs=new Set(t.tabIds||[]);
   for(const row of workspaces)if(row.taskId===t.id&&row.generation<=t.generation)for(const tab of row.tabs)tabs.add(tab.tabId);
   for(const tabId of tabs){
    if(!Number.isInteger(tabId)||this.leases.has(tabId)||this.attached.has(tabId))continue;
    await this.cleanupDetachedOverlay(t,tabId);
   }
  }
 }
 // 中文注释：DOM 事件仅卸载当前任务浮层，即使 debugger 被 DevTools 占用也能恢复本地输入。
 async removeLocalOverlayInput(task,tabId){
  await this.api.scripting.executeScript({target:{tabId},world:'ISOLATED',func:scope=>{
   for(const host of document.querySelectorAll('[data-hermes-automation-overlay]')){
    if(host.dataset.hermesOverlayTask===scope.taskId&&Number(host.dataset.hermesOverlayGeneration)<=scope.generation)host.dispatchEvent(new Event('hermes-overlay-release'));
   }
  },args:[{taskId:task.id,generation:task.generation}]});
 }
 // 中文注释：短暂复用原有 debugger 权限进入原隔离世界，完整卸载监听器；不执行网页主世界代码、不接管别的调试会话。
 async cleanupDetachedOverlay(task,tabId){
  if(this.overlayCleanupTabs.has(tabId)||this.leases.has(tabId)||this.attached.has(tabId))return;
  this.overlayCleanupTabs.add(tabId);let attached=false;
  try{
   const tab=await this.api.tabs.get(tabId);if(!/^https?:/.test(tab.url||''))return;
   await this.removeLocalOverlayInput(task,tabId);
   // 中文注释：升级前的浮层没有卸载事件，通过原隔离世界清理；其他调试会话占用时不抢占。
   const targets=await this.api.debugger.getTargets();if(targets.some(target=>target.tabId===tabId&&target.attached))return;
   await this.api.debugger.attach({tabId},'1.3');attached=true;
   const {frameTree}=await this.api.debugger.sendCommand({tabId},'Page.getFrameTree');
   const world=await this.api.debugger.sendCommand({tabId},'Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'hermes-automation-overlay',grantUniveralAccess:false});
   const result=await this.api.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{
    executionContextId:world.executionContextId,
    functionDeclaration:`function(scope){
     const state=globalThis.__hermesAutomationOverlay;
     if(!state||state.taskId!==scope.taskId||state.generation>scope.generation)return false;
     state.active=false;
     if(state.operationToken)state.highlight?.clear({taskId:state.taskId,generation:state.generation,documentId:state.documentId,operationToken:state.operationToken});
     state.overlay.remove();for(const resolve of state.pending.values())resolve({state:'disconnected'});state.pending.clear();
     delete globalThis.__hermesAutomationOverlay;return true;
    }`,arguments:[{value:{taskId:task.id,generation:task.generation}}],returnByValue:true,
   });
   if(result.exceptionDetails)throw Error('orphan overlay cleanup failed');
   // 中文注释：加载中的预遮罩使用独立隔离世界，卸载它的观察器，避免移除后再次挂回。
   const preveil=await this.api.debugger.sendCommand({tabId},'Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'hermes-automation-preveil',grantUniveralAccess:false});
   await this.api.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{executionContextId:preveil.executionContextId,functionDeclaration:'function(scope){const remove=globalThis.__hermesRemovePreveil;if(remove?.taskId===scope.taskId&&remove.generation<=scope.generation)remove();return true;}',arguments:[{value:{taskId:task.id,generation:task.generation}}],returnByValue:true});
  }catch{
   // 中文注释：页面关闭或其他调试器占用时不抢占；记录清理失败，页面本地超时仍可放开。
   this.diagnostics.recordSafely({component:'mv3_background',event_type:'action_state',stage:'overlay',status:'failed',error_code:'DISCONNECTED'});
  }finally{
   if(attached)await this.api.debugger.detach({tabId}).catch(()=>{});
   this.overlayCleanupTabs.delete(tabId);
  }
 }
 async overlayCall(tabId,entry,op,extra={}){
  const result=await this.api.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{
   executionContextId:entry.contextId,
   functionDeclaration:`function(op,scope){const state=globalThis.__hermesAutomationOverlay;if(!state||state.nonce!==scope.nonce)return false;
    if(scope.expectedActionToken&&state.actionToken!==scope.expectedActionToken)return false;
    if(scope.actionToken)state.actionToken=scope.actionToken;
    const binding={taskId:state.taskId,generation:state.generation,documentId:state.documentId,operationToken:state.operationToken};
    if(op==='remove'){if(binding.operationToken)state.highlight?.clear(binding);state.active=false;state.overlay.remove();delete globalThis.__hermesAutomationOverlay;for(const node of document.querySelectorAll('[data-hermes-preveil]'))node.remove();return true;}
    if(op==='hide'){if(typeof state.overlay.withHidden!=='function')return false;return state.overlay.hide()===true&&state.overlay.isHidden()===true;}
    if(op==='restore'){const ok=state.overlay.restore()===true&&state.overlay.isVisible()===true;if(!ok){if(binding.operationToken)state.highlight?.clear(binding);state.overlay.reblock();}return ok;}
    if(op==='update'){if(!state.active&&scope.update?.state==='running')return false;state.overlay.update(scope.update);return true;}
    if(op==='log'){state.overlay.setRecentSteps(scope.steps);return true;}
    if(op==='cursor'){state.overlay.setCursorEnabled(scope.enabled);return true;}
    if(op==='reblock'){state.overlay.reblock();return true;}
    if(op==='scope'||op==='scope-running'){if(scope.taskId!==state.taskId||scope.generation!==state.generation||scope.documentId!==state.documentId||!state.active&&scope.modeGeneration<=state.modeGeneration)return false;state.modeGeneration=scope.modeGeneration;state.active=true;if(op==='scope-running')state.overlay.update(scope.update);return true;}
    if(op==='revoke'){state.active=false;if(binding.operationToken){state.highlight?.clear(binding);state.operationToken=null;state.paintedToken=null;}state.overlay.reblock?.();return true;}
    if(op==='progress'){state.pending.get(scope.commandId)?.progress?.();return true;}
    if(op==='reply'){state.pending.get(scope.commandId)?.(scope.result);state.pending.delete(scope.commandId);return true;}
    return false;}`,
   arguments:[{value:op},{value:{nonce:entry.nonce,...extra}}],returnByValue:true});
  if(result.exceptionDetails)throw Error('overlay operation failed');return result.result?.value;
 }
 async interactionHighlightCall(tabId,entry,op,payload,guard=null){
  const result=await this.api.debugger.sendCommand(entry.target||{tabId},'Runtime.callFunctionOn',{
   executionContextId:entry.contextId,functionDeclaration:withSensitiveClassifier(interactionHighlightCommand),
   arguments:[{value:op},{value:{nonce:entry.nonce,...payload}}],returnByValue:true,
  });
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'interaction highlight failed');
  guard?.();return result.result?.value;
 }
 async interactionProbe(t,operation,kind,deadline,call){
  operation.guard();
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error('INTERACTION_HIGHLIGHT_FRAME_TIMEOUT');
  if(this.pendingInteractionProbes.size>=MAX_PENDING_INTERACTION_PROBES)throw Error('INTERACTION_HIGHLIGHT_PROBE_CAPACITY');
  const record={kind,tabId:operation.tabId,operationToken:operation.binding.operationToken,startedAt:Date.now(),deadline,abandoned:false,settled:false,state:'pending'};
  t.pendingInteractionProbes.add(record);this.pendingInteractionProbes.add(record);operation.pendingProbes.add(record);
  let timer,onAbort;
  const source=Promise.resolve().then(()=>{operation.guard();return call();});
  source.then(
   ()=>{record.settled=true;record.outcome='resolved';record.state=record.abandoned?'settled_late':'settled';t.pendingInteractionProbes.delete(record);this.pendingInteractionProbes.delete(record);operation.pendingProbes.delete(record);},
   ()=>{record.settled=true;record.outcome='rejected';record.state=record.abandoned?'settled_late':'settled';t.pendingInteractionProbes.delete(record);this.pendingInteractionProbes.delete(record);operation.pendingProbes.delete(record);},
  );
  const signal=operation.controller.signal;
  const interrupted=new Promise((_,reject)=>{
   timer=setTimeout(()=>{record.abandoned=true;record.state='abandoned';reject(Error('INTERACTION_HIGHLIGHT_FRAME_TIMEOUT'));},remaining);
   onAbort=()=>{record.abandoned=true;record.state='abandoned';reject(signal.reason||Error('interaction cancelled'));};
   signal.addEventListener('abort',onAbort,{once:true});
   if(signal.aborted)onAbort();
  });
  try{
   const result=await Promise.race([source,interrupted]);
   operation.guard();
   return result;
  }catch(error){
   if(Date.now()>=deadline&&!signal.aborted)throw Error('INTERACTION_HIGHLIGHT_FRAME_TIMEOUT');
   throw error;
  }finally{
   clearTimeout(timer);signal.removeEventListener('abort',onAbort);
   if(!record.settled){record.abandoned=true;if(record.state!=='abandoned')record.state='abandoned';}
  }
 }
 async interactionPause(operation,deadline,delayMs){
  operation.guard();
  const remaining=deadline-Date.now();
  if(remaining<=0)throw Error('INTERACTION_HIGHLIGHT_FRAME_TIMEOUT');
  const signal=operation.controller.signal;
  return new Promise((resolve,reject)=>{
   let timer;
   const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);};
   const onAbort=()=>{cleanup();reject(signal.reason||Error('interaction cancelled'));};
   timer=setTimeout(()=>{cleanup();resolve();},Math.min(delayMs,remaining));
   signal.addEventListener('abort',onAbort,{once:true});
   if(signal.aborted)onAbort();
  });
 }
 async trackInteractionCleanup(t,kind,call,timeoutMs=INTERACTION_CLEANUP_TIMEOUT_MS,releaseDeadline=null){
  if(!t.pendingInteractionCleanups)t.pendingInteractionCleanups=new Set();
  if(this.pendingInteractionCleanups.size>=MAX_PENDING_INTERACTION_CLEANUPS)return {timedOut:true,capacityExceeded:true};
  const startedAt=Date.now(),localDeadline=startedAt+timeoutMs;
  const record={kind,startedAt,deadline:Number.isFinite(releaseDeadline)?Math.min(localDeadline,releaseDeadline):localDeadline,abandoned:false,settled:false,state:'pending'};
  t.pendingInteractionCleanups.add(record);this.pendingInteractionCleanups.add(record);
  const source=Promise.resolve().then(()=>{
   if(Number.isFinite(releaseDeadline)&&Date.now()>=releaseDeadline)throw RELEASE_DEADLINE_EXPIRED;
   return call();
  });
  const settle=outcome=>{
   record.settled=true;record.outcome=outcome;record.state=record.abandoned?'settled_late':'settled';
   t.pendingInteractionCleanups.delete(record);this.pendingInteractionCleanups.delete(record);
  };
  source.then(()=>settle('resolved'),()=>settle('rejected'));
  const timerRef={id:null};
  try{
   const waitMs=Math.max(1,Number.isFinite(releaseDeadline)?Math.min(timeoutMs,releaseDeadline-Date.now()):timeoutMs);
   const timeout=new Promise(resolve=>{timerRef.id=setTimeout(()=>resolve(INTERACTION_CLEANUP_TIMEOUT),waitMs);});
   const result=await Promise.race([source,timeout]);
   if(result===INTERACTION_CLEANUP_TIMEOUT){record.abandoned=true;record.state='abandoned';return {timedOut:true};}
   return result;
  }finally{clearTimeout(timerRef.id);}
 }
 async interactionCleanupCall(t,tabId,entry,op,payload,timeoutMs=INTERACTION_CLEANUP_TIMEOUT_MS){
  const deadline=t?.revoked?t.releaseDeadline:null;
  return this.trackInteractionCleanup(t,`highlight-${op}`,()=>this.interactionHighlightCall(tabId,entry,op,payload),timeoutMs,deadline);
 }
 async waitForInteractionFrame(t,p,entry,binding,operation){
  const target=entry.target||{tabId:p.tabId},deadline=Date.now()+2000;
  while(Date.now()<deadline){
   operation.guard();
   if(this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');
   const tree=await this.interactionProbe(t,operation,'frame-tree',deadline,()=>entry.child?
    this.api.debugger.sendCommand(target,'Page.getFrameTree').then(result=>result.frameTree):
    this.checkedFrameTree(target,t,operation.guard,false));
   operation.guard();const observed=entry.child?this.frameNodes(tree).find(item=>item.frame.id===entry.frameId)?.frame:tree.frame;
   if(observed?.loaderId!==binding.documentId)throw Error('document changed');
   if(entry.child)this.allowed(t,observed.url);
   const painted=await this.interactionProbe(t,operation,'painted',deadline,()=>this.interactionHighlightCall(p.tabId,entry,'painted',{binding},operation.guard));
   if(painted?.ok===true)return;
   await this.interactionPause(operation,deadline,12);
  }
  throw Error('INTERACTION_HIGHLIGHT_FRAME_TIMEOUT');
 }
 async raceDialog(t,tabId,work){
  let timer,settled=false;
  const opened=new Promise(resolve=>{
   const tick=()=>{if(settled)return;const dialog=this.observers.pending(t,tabId);
    if(dialog)resolve({dialogOpened:{type:dialog.type,message:dialog.message}});else timer=setTimeout(tick,50);};
   tick();
  });
  try{return await Promise.race([work,opened]);}
  finally{settled=true;clearTimeout(timer);work.catch?.(()=>{});}
 }
 async withInteractionHighlight({t,p,entry,guard,prepare,verify,dispatch,afterWait=null,visualOnly=false}){
  if(!entry)throw Error('INTERACTION_HIGHLIGHT_UNAVAILABLE');
  const binding={taskId:t.id,generation:t.generation,documentId:entry.documentId,operationToken:crypto.randomUUID()};
  const operation={binding,tabId:p.tabId,controller:new AbortController(),active:true,pendingProbes:new Set()};
  operation.guard=()=>{if(!operation.active||operation.controller.signal.aborted)throw operation.controller.signal.reason||Error('interaction cancelled');guard();};
  t.interactionOperations.add(operation);
  let dispatched=false,startedDispatch=false;
  try{
   // 中文注释：CDP 按 tab/session 派发指针事件；后台页不抢前台，高亮在页面内验证挂载与 token。
   operation.guard();
   const prepared=await prepare(binding);
   operation.guard();
   if(prepared?.ok!==true&&!visualOnly)throw Error(`INTERACTION_HIGHLIGHT_${prepared?.code||'PREPARE_FAILED'}`);
   if(prepared?.ok===true){
    try{await this.timed(p,'highlight',()=>this.waitForInteractionFrame(t,p,entry,binding,operation));}
    catch(error){if(!visualOnly||!String(error?.message||'').startsWith('INTERACTION_HIGHLIGHT_'))throw error;}
   }
   operation.guard();
   const tree=entry.child?(await this.api.debugger.sendCommand(entry.target,'Page.getFrameTree')).frameTree:
    await this.checkedFrameTree({tabId:p.tabId},t,operation.guard,false);
   operation.guard();const observed=entry.child?this.frameNodes(tree).find(item=>item.frame.id===entry.frameId)?.frame:tree.frame;
   if(observed?.loaderId!==binding.documentId)throw Error('document changed');
   if(entry.child)this.allowed(t,observed.url);
   if(afterWait)await afterWait(binding);
   operation.guard();
   const checked=prepared?.ok===true?await verify(binding):{ok:visualOnly};
   operation.guard();
   if(checked?.ok!==true)throw Error(`INTERACTION_HIGHLIGHT_${checked?.code||'TARGET_CHANGED'}`);
   operation.guard();
   // 中文注释：后台标签页高亮等待可能耗尽先前的放行窗口；派发前重开短窗口，不激活标签页。
   const dispatchOverlay=entry.child?t.overlays?.get(p.tabId):entry;
   if(!dispatchOverlay||await this.overlayCall(p.tabId,dispatchOverlay,'update',{update:{state:'running',step:p.action,holdMs:10000}})!==true)throw Error('overlay dispatch window unavailable');
   operation.guard();
   startedDispatch=true;
   // 中文注释：动作触发 JS 对话框时页面脚本被阻塞，派发调用可能不返回；对话框出现即视为已派发并返回，由 dialog 动作处理。
   const result=await this.timed(p,'dispatch',()=>this.raceDialog(t,p.tabId,dispatch(binding)));
   if(result?.dialogOpened){
    dispatched=true;
    // 中文注释：对话框阻断送达回读时不能把未经确认的指针或语义按键报告为成功。
    // 中文注释：新打开的 JS 对话框本身就是已观察到的页面效果。
    if(['ref_click','interaction.click'].includes(p.action))return {clicked:false,delivery:'unconfirmed',outcomeUnknown:true,effect:'observed',dialogOpened:result.dialogOpened};
    if(['ref_set_checked','ref_press'].includes(p.action))return {outcomeUnknown:true,effect:'observed',dialogOpened:result.dialogOpened};
    return p.action==='click'?{clicked:true,kind:'dom-synthetic',effect:'observed',dialogOpened:result.dialogOpened}:
     {dispatched:true,effect:'observed',dialogOpened:result.dialogOpened};
   }
   operation.guard();dispatched=true;
   return result&&typeof result==='object'&&prepared?.targetSummary?{...result,_targetSummary:prepared.targetSummary}:result;
  }catch(error){
   // 中文注释：高亮准备/复核失败时尚未进入派发阶段；后续新快照可继续工作。
   if(!startedDispatch&&error&&typeof error==='object')error.preDispatch=true;
   throw error;
  }finally{
   try{
    if(this.observers.pending(t,p.tabId)){
     (t.deferredHighlightClears||=[]).push({tabId:p.tabId,entry,binding});
     if(t.deferredHighlightClears.length>16)t.deferredHighlightClears.shift();
    }else if(dispatched){
     let completed;
     try{completed=await this.interactionCleanupCall(t,p.tabId,entry,'complete',{binding,durationMs:600});}catch{}
     if(completed?.ok!==true&&!completed?.timedOut)await this.interactionCleanupCall(t,p.tabId,entry,'clear',{binding}).catch(()=>{});
    }else await this.interactionCleanupCall(t,p.tabId,entry,'clear',{binding}).catch(()=>{});
   }finally{
    operation.active=false;
    if(!operation.controller.signal.aborted)operation.controller.abort(Error('interaction complete'));
    t.interactionOperations.delete(operation);
   }
  }
 }
 async captureWithoutDecorations(t,tabId,entry,guard,capture){
  const deadline=Date.now()+CAPTURE_TIMEOUT_MS;
  const bounded=async work=>{const value=await waitUntil(work,deadline);if(value===RELEASE_DEADLINE_EXPIRED)throw Error('SCREENSHOT_TIMEOUT');return value;};
  let fallbackContextId=null,hideAttempted=false,result,captureError=null,restoreError=null;
  try{
   if(entry){
    hideAttempted=true;
    if(await bounded(this.overlayCall(tabId,entry,'hide'))!==true)throw Error('overlay hide failed');
   }else{
    const tree=await bounded(this.checkedFrameTree({tabId},t,guard,false));
    const world=await bounded(this.api.debugger.sendCommand({tabId},'Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'hermes-screenshot-suppression',grantUniveralAccess:false}));guard();
    fallbackContextId=world.executionContextId;hideAttempted=true;
    const declaration=`function(){const restoreCaptureDecorations=${restoreCaptureDecorations.toString()};const hideCaptureDecorations=${hideCaptureDecorations.toString()};return hideCaptureDecorations();}`;
    const hidden=await bounded(this.api.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{executionContextId:fallbackContextId,functionDeclaration:declaration,returnByValue:true}));guard();
    if(hidden.exceptionDetails||hidden.result?.value?.ok!==true)throw Error('overlay hide failed');
   }
   guard();
   result=await bounded(capture());guard();
  }catch(error){captureError=error;}
  if(hideAttempted){
   try{
    let restored;
    if(entry)restored=await waitUntil(this.overlayCall(tabId,entry,'restore'),Date.now()+OVERLAY_RESTORE_TIMEOUT_MS);
    else{
     const declaration=`function(){const restoreCaptureDecorations=${restoreCaptureDecorations.toString()};return restoreCaptureDecorations();}`;
     const response=await waitUntil(this.api.debugger.sendCommand({tabId},'Runtime.callFunctionOn',{executionContextId:fallbackContextId,functionDeclaration:declaration,returnByValue:true}),Date.now()+OVERLAY_RESTORE_TIMEOUT_MS);
     restored=!response.exceptionDetails&&response.result?.value?.ok===true;
    }
    if(restored!==true)throw Error('overlay restore failed');
   }catch(error){
    restoreError=Error('overlay restore failed',{cause:error});
    // 中文注释：截图恢复失败仍保留拦截层，只清理失效引用；删除 host 会把失败页面交给用户。
    if(entry)await this.closeTabResources(t,tabId,null,{keepOverlay:true,keepNetwork:true}).catch(()=>{});
   }
  }
  if(restoreError&&captureError)throw new AggregateError([captureError,restoreError],'capture and overlay restoration failed');
  if(restoreError)throw restoreError;
  if(captureError){
   // 中文注释：截图超时后断开旧交互对象，迟到回执不能刷新下一次坐标操作的缓存。
   if(captureError.message==='SCREENSHOT_TIMEOUT')await this.closeTabResources(t,tabId,null,{keepOverlay:true,keepNetwork:true}).catch(()=>{});
   throw captureError;
  }
  return result;
 }
 async markNavigating(t,tabId,step){
  const entry=t.overlays?.get(tabId);
  if(entry)await this.overlayCall(tabId,entry,'update',{update:{state:t.pauseRequested&&!t.paused?'pausing':t.paused?'paused':'running',step}}).catch(()=>{});
 }
 async ensureOverlay(t,tabId,target,guard,allFrames=false,initialTree=null,initialTab=null){
  if(!this.api.debugger.onEvent?.addListener)return null;
  const tree=initialTree||await this.checkedFrameTree(target,t,guard,allFrames),frame=tree.frame;
  let entry=t.overlays?.get(tabId);
  if(entry?.documentId===frame.loaderId)return entry;
  if(entry)await this.closeTabResources(t,tabId,null,{keepNetwork:true});
  const tab=initialTab||await this.api.tabs.get(tabId);guard();this.allowed(t,tab.url);
  if(origin(tab.url)!==origin(frame.url))throw Error('overlay frame changed');
  const world=await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:frame.id,worldName:'hermes-automation-overlay',grantUniveralAccess:false});guard();
  const nonce=crypto.randomUUID(),binding='hermesOverlayCommand',contextId=world.executionContextId;
  await this.api.debugger.sendCommand(target,'Runtime.addBinding',{name:binding,executionContextId:contextId});guard();
  entry={contextId,documentId:frame.loaderId,nonce};
  entry.listener=(source,method,params)=>{
   if(source?.tabId!==tabId||method!=='Runtime.bindingCalled'||params?.name!==binding||params.executionContextId!==contextId||t.overlays?.get(tabId)!==entry)return;
   let command;try{command=JSON.parse(params.payload);}catch{return;}
   if(command?.nonce!==nonce||!['stop','takeover','resume'].includes(command.kind)||!Number.isSafeInteger(command.commandId))return;
   void (async()=>{
    let result={state:'unknown'};
    // 中文注释：只通过原隔离世界回报控制请求仍在处理，不授予暂停或任务权限；worker 消失后续期自动停止。
    const progress=()=>this.overlayCall(tabId,entry,'progress',{commandId:command.commandId}).catch(()=>{});
    void progress();const progressTimer=setInterval(()=>{void progress();},2000);
    try{
     this.check(t,{generation:t.generation});if(this.leases.get(tabId)!==t.id)throw Error('lease changed');
     const current=await this.api.tabs.get(tabId);this.allowed(t,current.url);
     if(origin(current.url)!==origin(tab.url))throw Error('origin changed');
     if(typeof this.onOverlayCommand==='function'){
      if(command.kind==='stop')t.overlayStopping=true;
      const response=await this.onOverlayCommand(Object.freeze({taskId:t.id,generation:t.generation,tabId,origin:origin(tab.url),kind:command.kind}));
      if(response?.state==='disconnected')result={state:'disconnected'};
      if(command.kind==='takeover'&&response?.state==='paused'&&response?.verified===true&&t.paused)result={state:'paused'};
      if(command.kind==='resume'&&response?.state==='running'&&response?.verified===true&&!t.paused)result={state:'running'};
      // No page-supplied payload can confer termination. The background must
      // return verified host readback; the local executor also must be fenced.
      if(response?.state==='stopped'&&response?.verified===true&&response.taskId===t.id&&response.generation===t.generation){
       if(!t.revoked)await this.release({taskId:t.id,generation:t.generation,closeAgentTabs:command.kind==='stop'});
       if(t.revoked)result={state:'stopped'};
      }
     }
    }catch{}finally{clearInterval(progressTimer);await this.overlayCall(tabId,entry,'reply',{commandId:command.commandId,result}).catch(()=>{});}
   })();
  };
  this.api.debugger.onEvent.addListener(entry.listener);
  try{
   const result=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:contextId,
    functionDeclaration:`function(scope){
     const states={waiting:'Hermes 正在工作',running:'Hermes 正在工作',pausing:'正在暂停…',paused:'已暂停 · 你可以操作页面',resuming:'正在恢复…',stopping:'正在停止…',stopped:'已停止',disconnected:'与扩展的连接已断开',unknown:'状态待核查'};
     const interactionLabels={click:'准备点击',input:'正在输入',select:'正在选择',drag:'正在拖动'};
     const stepLabels={tabs:'读取标签页',new_tab:'打开新标签页',navigate:'打开网页',snapshot:'读取页面',click:'点击页面',fill:'填写内容',press:'按键',screenshot:'截取页面','page.parse':'解析页面',semantic_snapshot:'理解页面',frame_catalog:'读取页面结构',ref_click:'点击元素',ref_fill:'填写元素',ref_press:'按键操作',ref_set_checked:'设置选项',ref_select_option:'选择选项','files.upload':'选择网站文件',scroll:'滚动页面',back:'返回上一页'};
     const rectOk=r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;
     const highlightRectOk=r=>r&&[r.left,r.top,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;
     const labels=Object.freeze({click:'准备点击',input:'正在输入',select:'正在选择',drag:'正在拖动'});
     const DEFAULT_COMPLETE_MS=600,MAX_COMPLETE_MS=2000,owners=new WeakMap();
     const createAutomationOverlay=${createAutomationOverlay.toString()};
     const createInteractionHighlight=${createInteractionHighlight.toString()};
     globalThis.__hermesAutomationOverlay?.highlight?.clear({taskId:globalThis.__hermesAutomationOverlay.taskId,generation:globalThis.__hermesAutomationOverlay.generation,documentId:globalThis.__hermesAutomationOverlay.documentId,operationToken:globalThis.__hermesAutomationOverlay.operationToken});
     globalThis.__hermesAutomationOverlay?.overlay.remove();
     for(const node of document.querySelectorAll('[data-hermes-preveil]'))node.remove();
     const pending=new Map();let commandId=0;
     // 中文注释：超时或本地卸载时移除 pending，迟到回执不能改写下一次重试；不向后台发取消或授权。
     const command=(kind,{signal,onProgress})=>new Promise((resolve,reject)=>{
      if(signal.aborted){resolve({state:'disconnected'});return;}
      const id=++commandId,abort=()=>{pending.delete(id);resolve({state:'disconnected'});};
      const reply=result=>{signal.removeEventListener('abort',abort);resolve(result);};reply.progress=onProgress;pending.set(id,reply);signal.addEventListener('abort',abort,{once:true});
      try{globalThis[scope.binding](JSON.stringify({nonce:scope.nonce,commandId:id,kind}));}
      catch(error){pending.delete(id);signal.removeEventListener('abort',abort);reject(error);}
     });
     const overlay=createAutomationOverlay({document,taskId:scope.taskId,generation:scope.generation,tabId:scope.tabId,origin:scope.origin,documentId:scope.documentId,onStop:(_scope,options)=>command('stop',options),onTakeover:(_scope,options)=>command('takeover',options),onResume:(_scope,options)=>command('resume',options)});
     overlay.setCursorEnabled(scope.cursorEnabled);
     const state={overlay,nonce:scope.nonce,pending,taskId:scope.taskId,generation:scope.generation,documentId:scope.documentId,origin:scope.origin,modeGeneration:scope.modeGeneration,active:true,operationToken:null,paintedToken:null};
     globalThis.__hermesAutomationOverlay=state;
     state.highlight=createInteractionHighlight({document,taskId:scope.taskId,generation:scope.generation,documentId:scope.documentId,surface:overlay.interactionSurface,
      isCurrent:binding=>globalThis.__hermesAutomationOverlay===state&&state.active&&binding.taskId===state.taskId&&binding.generation===state.generation&&binding.documentId===state.documentId});
     return true;}`,
    arguments:[{value:{taskId:t.id,generation:t.generation,tabId,origin:origin(tab.url),documentId:frame.loaderId,modeGeneration:t.policy.modeGeneration,cursorEnabled:this.visualCursorEnabled!==false,nonce,binding}}],returnByValue:true});
   // 中文注释：保留原拒绝码与重试行为，仅增加固定阶段原因，不回传异常原文。
   guard();if(result.exceptionDetails||result.result?.value!==true)throw Object.assign(Error('overlay injection failed'),{stage:'overlay',reasonCode:result.exceptionDetails?'initialization_exception':'return_type_invalid'});
   if(!t.overlays)t.overlays=new Map();t.overlays.set(tabId,entry);
   return entry;
  }catch(error){this.api.debugger.onEvent.removeListener(entry.listener);await this.overlayCall(tabId,entry,'remove').catch(()=>{});throw error;}
 }
 semanticBinding(t,tabId,loaderId,frameId=null) {
  const key=frameId?`${tabId}:${frameId}`:tabId;
  const current=t.semanticBindings.get(key);if(current?.documentId===loaderId)return current;
  const binding={taskId:t.id,documentId:loaderId,leaseId:crypto.randomUUID()};t.semanticBindings.set(key,binding);return binding;
 }
 interactionsFor(t,tabId,guard,frame=null) {
  const key=frame?`${tabId}:${frame.frameId}`:tabId;
  let current=t.interactions.get(key);
  if(current&&frame&&(current.frame?.loaderId!==frame.loaderId||current.frame?.sessionId!==frame.sessionId)){
   current.adapter.close();t.interactions.delete(key);current=null;
  }
  if(current){current.guard=guard;return current.interactions;}
  // The module checks screenshot/DOM identity; the host must also fence every
  // CDP step after revocation, navigation or a tab lease change, not only the
  // beginning and end of a multi-step drag.
  current={guard,frame};
  const debuggerApi={...this.api.debugger,sendCommand:async(target,method,params)=>{
   current.guard();
   if(this.leases.get(tabId)!==t.id)throw Error('tab lease denied');
   const tab=await this.api.tabs.get(tabId);current.guard();this.allowed(t,tab.url);
   if(frame){
    const frameTarget=frame.sessionId?{tabId,sessionId:frame.sessionId}:{tabId};
    const state=await this.api.debugger.sendCommand(frameTarget,'Page.getFrameTree');current.guard();
    const observed=state?.frameTree&&this.frameNodes(state.frameTree).find(item=>item.frame.id===frame.frameId)?.frame;
    if(observed?.id!==frame.frameId||observed?.loaderId!==frame.loaderId||observed?.url!==frame.url)throw Error('FRAME_TOKEN_STALE');
    this.allowed(t,observed.url);
   }
   const result=await this.api.debugger.sendCommand(target,method,params);
   current.guard();return result;
  }};
  current.adapter=createChromeDebuggerAdapter(debuggerApi,{tabId,sessionId:frame?.sessionId});
  current.interactions=new Interactions(current.adapter,{taskId:t.id,generation:t.generation,ttlMs:30000});
  t.interactions.set(key,current);return current.interactions;
 }
 async checkedSelectorTarget(t,p,interactions,selector,guard,documentId){
  const bound=await interactions.bounds({taskId:t.id,generation:t.generation,screenshotId:p.screenshotId,selector});guard();
  const current=t.interactions.get(p.tabId),point={x:bound.rect.x+bound.rect.width/2,y:bound.rect.y+bound.rect.height/2};
  const state=await current.adapter.evaluate('state');guard();
  const hidden=state.visibility==='hidden';
  const check=await current.adapter.evaluate('check',{...point,ref:bound.ref,allowHiddenHitUnavailable:hidden});guard();
  if(check?.error)throw Error(check.error);
  if(!hidden){await current.adapter.verifyHit(point);guard();}
  const dpr=bound.imageCenter.x/(bound.rect.x+bound.rect.width/2);
  return {...bound,dpr,selector,documentId};
 }
 async checkedCoordinateTarget(t,p,interactions,point,expectedRef,guard,documentId){
  const refs=t.interactionRefs?.get(p.tabId),meta=refs?.get(expectedRef);
  if(!meta||meta.screenshotId!==p.screenshotId||meta.documentId!==documentId)throw Error('INTERACTION_HIGHLIGHT_TARGET_UNAVAILABLE');
  const current=await this.checkedSelectorTarget(t,p,interactions,meta.selector,guard,documentId);
  if(canonical(current.rect)!==canonical(meta.rect)||current.dpr!==meta.dpr)throw Error('INTERACTION_HIGHLIGHT_TARGET_CHANGED');
  const cssPoint={x:point.x/meta.dpr,y:point.y/meta.dpr};
  const rect=meta.rect,adapter=t.interactions.get(p.tabId)?.adapter;
  if(!adapter)throw Error('interaction adapter unavailable');
  if(!Number.isFinite(cssPoint.x)||!Number.isFinite(cssPoint.y)||cssPoint.x<rect.x||cssPoint.y<rect.y||cssPoint.x>=rect.x+rect.width||cssPoint.y>=rect.y+rect.height)throw Error('INTERACTION_HIGHLIGHT_COORDINATE_OUTSIDE_TARGET');
  const state=await adapter.evaluate('state');guard();
  const hidden=state.visibility==='hidden';
  const check=await adapter.evaluate('check',{...cssPoint,ref:expectedRef,allowHiddenHitUnavailable:hidden});guard();
  if(check?.error)throw Error(check.error);
  if(!hidden){await adapter.verifyHit(cssPoint);guard();}
  return meta;
 }
 async checkedFrameTree(target,t,guard,allFrames=false) {
  const tree=await this.api.debugger.sendCommand(target,'Page.getFrameTree',{});guard();
  const urls=allFrames?this.frameUrls(tree.frameTree):[tree.frameTree?.frame?.url];
  try{this.allowed(t,urls[0]);if(allFrames)for(const url of urls.slice(1))this.allowed(t,url);}catch(e){throw Error(allFrames?'frame origin denied':e.message);}
  return tree.frameTree;
 }
 async callWorld(target,frameId,t,action,selector,text,key,guard,executionContextId=null,highlightBinding=null) {
  const world=executionContextId?{executionContextId}:await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId,worldName:'hermes-native',grantUniveralAccess:false});guard();
  const fn=action==='inspect'?inspectPage:pageAction;
  const args=action==='inspect'?[t.allowedOrigins]:[action,selector??null,text??null,key??null,t.allowedOrigins,highlightBinding??null];
  const result=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:withSensitiveClassifier(fn),arguments:args.map(value=>({value})),returnByValue:true});
  guard();if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'page action failed');return result.result?.value;
 }
 async callSemanticWorld(target,frameId,op,payload,guard,executionContextId=null) {
  // 中文注释：隔离世界保存版本化实现；只在确定尚未调用动作时重装，不重放未知写入。
  const createWorld=()=>this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId,worldName:'hermes-native-semantics-v2',grantUniveralAccess:false});
  let world=executionContextId?{executionContextId}:await createWorld();guard();
  const key=()=>JSON.stringify([target.tabId,target.sessionId,world.executionContextId]);
  const install=async()=>{const installed=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:`function(){globalThis.__hermesSemanticLibrary={version:1,call:(${semanticWorldDeclaration})};return true;}`,returnByValue:true});guard();if(installed.exceptionDetails||installed.result?.value!==true)throw Object.assign(Error('SEMANTIC_LIBRARY_UNAVAILABLE'),{preDispatch:true});this.semanticWorlds.add(key());};
  const invoke=()=>this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:op==='page.observe'?`function(op,p){const library=globalThis.__hermesSemanticLibrary;if(library?.version!==1)return {hermesSemanticMissing:true};const state=globalThis.__hermesNativeSemanticsV2;if(!state||JSON.stringify(state.binding)!==JSON.stringify(p.binding))library.call('semantic_snapshot',{binding:p.binding,options:{root:'head',mode:'content',budget:512}});return (${observePage.toString()})(globalThis.__hermesNativeSemanticsV2.semantics.parsingContext(),p.options);}`:'function(op,p){const library=globalThis.__hermesSemanticLibrary;return library?.version===1?library.call(op,p):{hermesSemanticMissing:true};}',arguments:[{value:op},{value:payload}],returnByValue:true,awaitPromise:true});
  let result;
  try{if(!this.semanticWorlds.has(key()))await install();result=await invoke();}
  catch(error){
   // 中文注释：只恢复 CDP 明确报告的不存在上下文；执行中销毁或连接错误可能已写入，绝不重试。
   let details;try{details=JSON.parse(error.message);}catch{throw error;}
   if(details.code!==-32000||details.message!=='Cannot find context with specified id')throw error;
   this.semanticWorlds.delete(key());world=await createWorld();guard();await install();result=await invoke();
  }
  guard();
  if(result.result?.value?.hermesSemanticMissing===true){await install();result=await invoke();}
  if(result.result?.value?.hermesSemanticMissing===true)throw Object.assign(Error('SEMANTIC_LIBRARY_UNAVAILABLE'),{preDispatch:true});
  guard();
  if(result.exceptionDetails){
   const error=Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'semantic action failed');
   // 中文注释：页面函数在点击、赋值或按键前做的校验失败，确定未派发，不按未知结果处理。
   const reason=error.message.split(/\r?\n/,1)[0].replace(/^Error: /,'').split('|',1)[0];
   // 中文注释：派发后的状态回读失败属于结果未知，不能再按派发前拒绝处理。
   if(op!=='semantic_snapshot'&&!op.startsWith('read_ref_')&&!['probe_ref_delivery','synthetic_ref_click','synthetic_ref_set_checked','synthetic_ref_select_option'].includes(op)&&
    (PRE_DISPATCH_PAGE_REASONS.has(reason)||/^INTERACTION_HIGHLIGHT_[A-Z_]{1,40}$/.test(reason)))error.preDispatch=true;
   throw error;
  }
  return result.result?.value;
 }
 // 中文注释：经调试接口把本文档的封闭 Shadow Root 交给语义隔离世界；不进入其他 frame，数量有上限。
 async exposeClosedShadowRoots(target,frameId,guard,executionContextId=null){
  const contextId=executionContextId||(await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId,worldName:'hermes-native-semantics-v2',grantUniveralAccess:false})).executionContextId;guard();
  const {root}=await this.api.debugger.sendCommand(target,'DOM.getDocument',{depth:-1,pierce:true});guard();
  const closed=[],stack=[root];
  while(stack.length&&closed.length<200){
   const node=stack.pop();
   for(const shadow of node?.shadowRoots||[]){if(shadow.shadowRootType==='closed')closed.push(shadow.backendNodeId);stack.push(shadow);}
   for(const child of node?.children||[])stack.push(child);
  }
  for(const backendNodeId of closed){
   const {object}=await this.api.debugger.sendCommand(target,'DOM.resolveNode',{backendNodeId,executionContextId:contextId});guard();
   try{
    await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{objectId:object.objectId,returnByValue:true,
     functionDeclaration:'function(){const roots=globalThis.__hermesClosedShadowRoots||(globalThis.__hermesClosedShadowRoots=new WeakMap());roots.set(this.host,this);return true;}'});guard();
   }finally{await this.api.debugger.sendCommand(target,'Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
  }
  return contextId;
 }
 // 中文注释：滚入视口后等待目标位置连续稳定再高亮和派发；持续移动的目标在派发前拒绝。
 async settleSemanticTarget(target,frameId,payload,guard,executionContextId=null){
  // 中文注释：未滚动的目标也可能在动画中，稳定检查不能省。由扩展按 60ms 间隔采样：逐帧采样会把缓动末段的
  // 亚像素移动误判为静止，页面内定时器在后台页又会被节流；语义库已缓存，每次采样只发小调用桩。
  const revealed=await this.callSemanticWorld(target,frameId,'reveal_ref',payload,guard,executionContextId);
  let last=revealed?.rect,stable=0;
  const deadline=Date.now()+2500;
  while(stable<2){
   await new Promise(resolve=>setTimeout(resolve,60));guard();
   const current=await this.callSemanticWorld(target,frameId,'rect_ref',payload,guard,executionContextId);
   if(Array.isArray(current)&&Array.isArray(last)&&current.every((value,index)=>Math.abs(value-last[index])<=0.5))stable++;
   else {stable=0;last=current;}
   if(stable<2&&Date.now()>deadline)throw Object.assign(Error('TARGET_UNSTABLE'),{preDispatch:true});
  }
 }
 async assertSafeCapture(target,t,guard,cache=null) {
  // 中文注释：截图允许跨源子框架存在；无法检查的子框架由 frameCatalog 给出遮罩区域。
  const tree=await this.checkedFrameTree(target,t,guard,false);
  // 中文注释：缓存只活在一次截图内；任何 frame 或 loader 变化都重新发现完整 DOM。
  const signature=async()=>{
   const trees=[tree];
   for(const {sessionId} of t.frameSessions.get(target.tabId)?.sessions.values()||[]){
    const child=await this.api.debugger.sendCommand({tabId:target.tabId,sessionId},'Page.getFrameTree');guard();trees.push(child.frameTree);
   }
   return JSON.stringify(trees.flatMap(item=>this.frameNodes(item).map(({frame})=>[frame.id,frame.loaderId,frame.url])).sort());
  };
  const fingerprint=await signature(),reused=cache?.fingerprint===fingerprint;
  let catalog;
  try{catalog=reused?cache.catalog:await this.frameCatalog(t,{tabId:target.tabId},target,guard);}
  catch(error){if(/^FRAME_(?:DISCOVERY_UNAVAILABLE|LIMIT|DUPLICATE)$/.test(error?.message||''))throw Error('CAPTURE_FRAME_UNINSPECTABLE');throw error;}
  if(reused)for(const row of catalog.frames.filter(item=>!item.parentFrameToken&&item.captureBackendNodeId)){
   // 中文注释：缓存文档发现，但每张图前后重读 frame 几何；移动后位置不一致即拒绝图片。
   try{
    const {model}=await this.api.debugger.sendCommand({tabId:target.tabId,...(row.captureSessionId?{sessionId:row.captureSessionId}:{})},
     'DOM.getBoxModel',{backendNodeId:row.captureBackendNodeId});guard();
    const q=model?.border||model?.content;
    if(q?.length!==8)throw Error('FRAME_GEOMETRY_UNAVAILABLE');
    const x=Math.min(q[0],q[2],q[4],q[6]),y=Math.min(q[1],q[3],q[5],q[7]);
    row.captureRect={x,y,width:Math.max(q[0],q[2],q[4],q[6])-x,height:Math.max(q[1],q[3],q[5],q[7])-y};
   }catch{row.captureRect=null;}
  }
  // 中文注释：首次发现会附加 OOPIF session，缓存必须包含这些新发现的文档。
  if(cache){cache.fingerprint=reused?fingerprint:await signature();cache.catalog=catalog;}
  const masks=[];
  const coverFor=row=>{
   // 中文注释：嵌套 frame 的局部坐标不能直接当顶层坐标；遮住最外层宿主框架。
   let cover=row;
   while(cover?.parentFrameToken)cover=catalog.frames.find(item=>item.frameToken===cover.parentFrameToken);
   return cover?.captureRect;
  };
  if(!catalog.coverage.complete){
   // 中文注释：无法检查的区域只能整块遮住；没有可靠矩形时明确拒绝。
   const gaps=catalog.frames.filter(row=>row.access!=='ready'||catalog.coverage.depthLimited);
   if(!gaps.length||gaps.some(row=>!coverFor(row)))throw Error('CAPTURE_FRAME_UNINSPECTABLE');
   masks.push(...gaps.map(row=>({...coverFor(row),kind:'uninspectable_frame',role:'iframe',name:'不可检查的框架'})));
  }
  const mainFrames=new Set(this.frameNodes(tree).map(item=>item.frame.id));
  for(const frame of this.frameNodes(tree)){
   const row=frame.frame.id===tree.frame.id?null:catalog.frames.find(item=>t.frameRefs.get(target.tabId)?.get(item.frameToken)?.frameId===frame.frame.id);
   if(frame.frame.id!==tree.frame.id&&row?.access!=='ready')continue;
   const inspection=await this.callWorld(target,frame.frame.id,t,'inspect',null,null,null,guard);
   if(inspection?.hasSensitiveValue&&(!Array.isArray(inspection.rects)||!inspection.rects.length))throw Error('CAPTURE_SENSITIVE_BLOCKED');
   if(frame.frame.id===tree.frame.id)masks.push(...(inspection?.rects||[]));
   else if(inspection?.hasSensitiveValue){
    if(!coverFor(row))throw Error('CAPTURE_SENSITIVE_BLOCKED');
    masks.push({...coverFor(row),kind:'sensitive_field',role:'iframe',name:'敏感字段'});
   }
  }
  for(const row of catalog.frames){
   const record=t.frameRefs.get(target.tabId)?.get(row.frameToken);
   if(!record||mainFrames.has(record.frameId))continue;
   const childTarget={tabId:target.tabId,sessionId:record.sessionId};
   const current=await this.api.debugger.sendCommand(childTarget,'Page.getFrameTree');guard();
   const observed=this.frameNodes(current?.frameTree).find(item=>item.frame.id===record.frameId)?.frame;
   if(observed?.loaderId!==record.loaderId)throw Error('CAPTURE_FRAME_UNINSPECTABLE');
   const inspection=await this.callWorld(childTarget,record.frameId,t,'inspect',null,null,null,guard);
   if(inspection?.hasSensitiveValue){
    if(!coverFor(row)||!Array.isArray(inspection.rects)||!inspection.rects.length)throw Error('CAPTURE_SENSITIVE_BLOCKED');
    masks.push({...coverFor(row),kind:'sensitive_field',role:'iframe',name:'敏感字段'});
   }
  }
  return masks;
 }
 // 中文注释：只读动作只等 DOM 可用；加载途中文档被替换导致的瞬时失败，重新核对后再读一次，
 // 避免模型把“页面还没加载完”误判成失败而反复重新打开页面。写入类动作不重做，结果仍按原规则报告。
 async performSettled(t,p){
  if(!SETTLING_READ_ACTIONS.has(p.action))return this.perform(t,p);
  const guard=()=>{this.check(t,p);if(this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');};
  await this.timed(p,'settle_wait',()=>this.domReadyTab(t,p,guard));
  try{return await this.perform(t,p);}
  catch(error){
   if(!isTransientLoadError(error))throw error;
   await this.timed(p,'settle_wait',()=>this.domReadyTab(t,p,guard));
   return this.perform(t,p);
  }
 }
 // 中文注释：读取只等 DOM 可用；导航仍保留完整加载的 8 秒等待。
 async domReadyTab(t,p,guard){
  const target={tabId:p.tabId},deadline=Date.now()+1500;
  let tab=await this.api.tabs.get(p.tabId);guard();try{this.allowed(t,tab.url);}catch{throw Object.assign(Error('TAB_OUT_OF_SCOPE'),{preDispatch:true,currentOrigin:origin(tab.url)});}
  if(tab.status==='complete')return {tab,ready:true};
  if(!this.attached.has(p.tabId)){await this.api.debugger.attach(target,'1.3');guard();this.attached.add(p.tabId);}
  while(Date.now()<deadline){
   try{
    const tree=await this.checkedFrameTree(target,t,guard,false);
    const world=await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'hermes-native',grantUniveralAccess:false});guard();
    const result=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:'function(){return document.readyState;}',arguments:[],returnByValue:true});guard();
    if(['interactive','complete'].includes(result.result?.value))return {tab,ready:true};
   }catch(error){if(!isTransientLoadError(error))throw error;}
   await new Promise(resolve=>setTimeout(resolve,40));guard();
   tab=await this.api.tabs.get(p.tabId);guard();this.allowed(t,tab.url);
   if(tab.status==='complete')return {tab,ready:true};
  }
  return {tab,ready:false};
 }
 // 中文注释：只接受同协议的 apex/www 对换；其他已提交跳转立即拒绝并仅公开来源。
 acceptCommittedOrigin(t,requested,url){
  const site=origin(url);
  if(t.allowedOrigins.includes(site))return;
  const from=new URL(requested),to=new URL(url);
  const apex=host=>host.startsWith('www.')?host.slice(4):host;
  if(from.protocol===to.protocol&&from.port===to.port&&apex(from.hostname)===apex(to.hostname)
     &&from.hostname!==to.hostname&&[from.hostname,to.hostname].includes(apex(from.hostname))){
   t.allowedOrigins.push(site);return;
  }
  throw Object.assign(Error('REDIRECTED_OUT_OF_SCOPE'),{code:'REDIRECTED_OUT_OF_SCOPE',finalOrigin:site,preDispatch:true});
 }
 async settledTab(tabId,guard,initial,waitMs=1500,t=null,requested=null,previousUrl=null){
  const deadline=Date.now()+waitMs,target={tabId};
  let tab=initial||await this.api.tabs.get(tabId),seenCommit=false,probeAt=0,probeOff=false,partialSeen=null;guard();
  while(true){
   guard();
   // 中文注释：导航期间 tabs.get 可能仍是旧页；只检查已提交的新网址。
   if(tab.url&&(!previousUrl||tab.url!==previousUrl||tab.status==='complete')){
    seenCommit=true;if(t&&requested)this.acceptCommittedOrigin(t,requested,tab.url);
   }
   if(seenCommit&&tab.status==='complete')return {tab,ready:'complete'};
   // 中文注释：只有 loading 才值得等；unloaded（休眠页）或未知状态等下去也不会变 complete。
   if(seenCommit&&tab.status!=='loading')return {tab,ready:'loading'};
   // 中文注释：readyState 探测只为提前返回；探测失败（其他调试器、DevTools、测试替身）退回按标签页状态等待，不让建页失败。
   if(seenCommit&&!probeOff&&Date.now()>=probeAt&&t&&requested&&this.api.debugger?.sendCommand&&this.api.debugger?.attach){
    probeAt=Date.now()+250;
    let state=null,redirected=false,content=null;
    try{
     if(!this.attached.has(tabId)){await this.api.debugger.attach(target,'1.3');guard();this.attached.add(tabId);}
     const tree=await this.checkedFrameTree(target,t,guard,false);
     if(origin(tree.frame.url)===origin(tab.url)){
      const world=await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'hermes-native',grantUniveralAccess:false});guard();
      const receipt=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:'function(){const body=document.body;return {ready:document.readyState,title:document.title,heading:!!body?.querySelector("h1,h2"),textLength:body?.innerText?.length||0,elementCount:body?.getElementsByTagName("*").length||0};}',arguments:[],returnByValue:true});guard();
      content=receipt.result?.value;state=content?.ready;
     }
    }catch(error){
     // 中文注释：主框架可能先于 tabs.get 提交跳转；等标签页网址更新后再判定来源。
     if(error?.message==='origin denied')redirected=true;
     else if(!isTransientLoadError(error))probeOff=true;
    }
    if(redirected){
     tab=await this.api.tabs.get(tabId);guard();
     if(tab.url&&(!previousUrl||tab.url!==previousUrl))this.acceptCommittedOrigin(t,requested,tab.url);
    }else if(['interactive','complete'].includes(state)){
     tab=await this.api.tabs.get(tabId);guard();if(tab.url)this.acceptCommittedOrigin(t,requested,tab.url);
     return {tab,ready:tab.status==='complete'?'complete':state};
    }else if(state==='loading'&&content&&(content.heading||content.textLength>=120)&&Date.now()<deadline){
     // 中文注释：脚本阻塞 DOMContentLoaded 时，内容连续半秒无变化且已等待 2.5 秒才返回部分可读状态。
     const signature=JSON.stringify([content.title,content.textLength,content.elementCount]);
     partialSeen=partialSeen?.signature===signature?partialSeen:{signature,since:Date.now()};
     if(Date.now()>=deadline-waitMs+2500&&Date.now()-partialSeen.since>=500){
      tab=await this.api.tabs.get(tabId);guard();if(tab.url)this.acceptCommittedOrigin(t,requested,tab.url);
      return {tab,ready:'partial'};
     }
    }
   }
   if(Date.now()>=deadline)return {tab,ready:'loading'};
   await new Promise(resolve=>setTimeout(resolve,40));tab=await this.api.tabs.get(tabId);
  }
 }
 async openOwnedTab(t,p,guard,url){
  this.allowed(t,url);
  // 中文注释：仅串行容量回收、创建与租约登记；加载 Promise 单独返回，不占建页队列。
  const prior=t.tabOpenQueue||Promise.resolve();
  const registration=prior.catch(()=>{}).then(async()=>{
   guard();
   if(!this.workspaces)this.workspaces=new NativeWorkspaces(this.api,t.instanceId,id=>this.leases.has(id));
   if(!t.workspaceCapability)t.workspaceCapability=await this.workspaces.install(t,t.workspaceTabs);
   const closedTabs=[];
   while(t.agentTabs.size>=4){
    const oldest=[...t.agentTabs].find(id=>id!==p.tabId);
    // 中文注释：等待旧页当前动作完成后再回收，不能删除仍在加载或执行动作的页面。
    await this.lock(oldest,async()=>{
     guard();
     if(!t.agentTabs.has(oldest))return;
     if(this.leases.get(oldest)!==t.id)throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:true});
     // 中文注释：租约之外还复核组与窗口，用户移走的页面不得回收。
     const current=await this.api.tabs.get(oldest);guard();
     const workspace=this.workspaces.authority.resolve(t.workspaceCapability);
     if(current.windowId!==workspace.windowId)throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:true});
     if(current.groupId!==t.agentTabGroups?.get(oldest))throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:true});
     const group=await this.api.tabGroups.get(current.groupId);guard();
     if(group.windowId!==workspace.windowId||group.title!==groupTitle(t.title))throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:true});
     this.closingTabs.add(oldest);
     try{await this.api.tabs.remove(oldest);closedTabs.push(oldest);await this.tabEvent(oldest,'closed',null);}
     catch(error){this.closingTabs.delete(oldest);throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:false,cause:error});}
    });
   }
   guard();
   const work=await this.workspaces.open(t.workspaceCapability,{requestId:p.action==='new_tab'?p.requestId:(p.requestId||crypto.randomUUID()),url,title:t.title});
   const tab=await this.api.tabs.get(work.tabId);guard();
   if(!Number.isInteger(tab.id))throw Error('invalid new tab');
   const windowId=this.workspaces.authority.resolve(t.workspaceCapability).windowId;
   if(tab.windowId!==windowId||tab.groupId!==work.groupId)throw Error('RELEASED');
   if(this.leases.has(tab.id))throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:false});
   this.acceptCommittedOrigin(t,url,tab.url||url);
   t.tabIds.add(tab.id);t.agentTabs.add(tab.id);this.leases.set(tab.id,t.id);
   // 中文注释：记录模型页创建时的组，用于回收前核对用户是否移走页面。
   (t.agentTabGroups??=new Map()).set(tab.id,work.groupId);
   (t.agentTabRequests??=new Map()).set(tab.id,p.requestId);
   const settled=this.lock(tab.id,async()=>{
    guard();
    const value=await this.settledTab(tab.id,guard,tab,PAGE_SETTLE_MS,t,url);guard();
    // 中文注释：来源、代次及模式仍逐次核验，新增同任务标签不属于授权变化。
    if(this.leases.get(tab.id)!==t.id)throw Object.assign(Error('TASK_BUSY'),{code:'TASK_BUSY',preDispatch:false});
    const settledUrl=value.tab.url||(value.tab.status==='loading'?value.tab.pendingUrl:undefined);
    this.allowed(t,settledUrl);
    return {tabId:tab.id,url:settledUrl,ready:value.ready,groupId:work.groupId,windowId:value.tab.windowId,closedTabs};
   });
   return {settled};
  });
  t.tabOpenQueue=registration;
  const {settled}=await registration;
  const opened=await settled;
  void this.restoreOverlay(t,opened.tabId);
  return opened;
 }
 async openSafeLink(t,p,guard,inspection){
  if(inspection?.kind!=='blank_anchor'||typeof inspection.url!=='string')return {unsupported:true,code:'CHILD_CREATION_UNSUPPORTED',clicked:false};
  this.allowed(t,inspection.url);
  const work=await this.openOwnedTab(t,p,guard,inspection.url);
  return {...work,clicked:false,openedVia:'safe_link_navigation',effect:'observed'};
 }
 async perform(t,p) {
  assertV1Action(p.action);
  this.check(t,p);const modeGeneration=t.policy.modeGeneration;const guard=()=>{this.check(t,p);if(Number.isInteger(p.tabId)&&this.leases.get(p.tabId)!==t.id)throw Error('tab lease denied');if(t.policy.modeGeneration!==modeGeneration)throw Error('mode revoked');};const get=async id=>{const tab=await this.api.tabs.get(id);guard();this.allowed(t,tab.url);return tab;};
  await this.authorize(t,p,guard);guard();
  // 中文注释：审批完成后才进入窗口输入队列，读操作不切前台。
  return this.workspaces&&INPUT_ACTIONS.has(p.action)?this.workspaces.withInput(t,p,guard,()=>this.performAuthorized(t,p,guard,get,modeGeneration)):this.performAuthorized(t,p,guard,get,modeGeneration);
 }
 async performAuthorized(t,p,guard,get,modeGeneration){
  if(p.action==='official.new_tab')return officialOpenTab(this,t,p,guard);
  if(p.action==='official.goto_url')return officialNavigate(this,t,{...p,_doc:this.docs.get(p.tabId)||0},guard);
  if(p.action==='official.ready_state')return officialReadyState(this,t,p,guard);
  if(p.action==='tabs'){
   // 中文注释：离开授权网站的工作页只返回编号与状态，不暴露外站网址或标题。
   const tabs=await Promise.all([...t.tabIds].map(async id=>{const tab=await this.api.tabs.get(id);guard();
    try{this.allowed(t,tab.url);return tab;}catch{return {id:tab.id,windowId:tab.windowId,groupId:tab.groupId,active:tab.active,status:tab.status,outOfScope:true};}}));
   guard();return tabs;
  }
  if(p.action==='new_tab'){
   return this.openOwnedTab(t,p,guard,p.url);
  }
  let initialTab;
  const offScope=t.offScopeTabs?.has(p.tabId);
  if(p.action==='navigate'&&offScope){const tab=await this.api.tabs.get(p.tabId);guard();initialTab=tab;try{this.allowed(t,tab.url);}catch{/* 允许把离开授权范围的工作页导航回授权网站 */}}
  // 中文注释：已冻结的离站工作页先完成其余身份检查，再只回报脱敏的当前来源。
  else if(offScope){try{guard();}catch(error){if(error?.message!=='TAB_OUT_OF_SCOPE')throw error;}const tab=await this.api.tabs.get(p.tabId);throw Object.assign(Error('TAB_OUT_OF_SCOPE'),{preDispatch:true,currentOrigin:origin(tab.url)});}
  else try{initialTab=await get(p.tabId);}catch(error){if(error?.message==='origin denied'){const tab=await this.api.tabs.get(p.tabId);guard();throw Object.assign(Error('TAB_OUT_OF_SCOPE'),{preDispatch:true,currentOrigin:origin(tab.url)});}throw error;}
  const target={tabId:p.tabId},captureCache={};
  if(p.action==='navigate'&&this.downloads&&!offScope){
   if(!this.attached.has(p.tabId)){
    await this.api.debugger.attach(target,'1.3');
    try{guard();}catch(e){await this.api.debugger.detach(target).catch(()=>{});throw e;}
    this.attached.add(p.tabId);
   }
   await this.ensurePageEvents(target,guard);
  }
  if(p.action==='navigate'){
   this.allowed(t,p.url);guard();await this.closeTabResources(t,p.tabId,null,{keepOverlay:true,keepNetwork:true});
   await this.markNavigating(t,p.tabId,'navigate');
   // 中文注释：加载中 tabs.update/get 仍可能返回旧的范围外 URL；目标已校验，等提交后再核对最终来源。
   await this.api.tabs.update(p.tabId,{url:p.url});guard();const current=await this.api.tabs.get(p.tabId);guard();
   const settled=await this.settledTab(p.tabId,guard,current,PAGE_SETTLE_MS,t,p.url,initialTab?.url);this.allowed(t,settled.tab.url);
   return {tabId:p.tabId,url:settled.tab.url,ready:settled.ready};
  }
  if(!this.attached.has(p.tabId)){
   await this.api.debugger.attach(target,'1.3');
   try{guard();}catch(e){await this.api.debugger.detach(target).catch(()=>{});throw e;}
   this.attached.add(p.tabId);
  }
  await this.ensurePageEvents(target,guard);
  // 中文注释：JS 对话框打开时页面脚本被阻塞，除处理对话框外的动作立即拒绝，避免挂起到超时。
  if(p.action==='dialog'){
   const handled=await this.observers.handle(t,p,target,guard);
   // 中文注释：对话框阻塞期间未能清除的高亮在处理对话框后补清，避免残留框遮住相邻目标。
   const deferred=(t.deferredHighlightClears||[]).filter(item=>item.tabId===p.tabId);
   t.deferredHighlightClears=(t.deferredHighlightClears||[]).filter(item=>item.tabId!==p.tabId);
   for(const item of deferred)await this.interactionCleanupCall(t,p.tabId,item.entry,'clear',{binding:item.binding}).catch(()=>{});
   return handled;
  }
  if(this.observers.pending(t,p.tabId)&&!['screenshot','interaction.capture'].includes(p.action))
   throw Object.assign(Error('DIALOG_OPEN'),{preDispatch:true});
  if(p.action==='console')return this.observers.console(t,p,target,guard);
  if(p.action==='images'){
   const tree=await this.checkedFrameTree(target,t,guard,false);
   const world=await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'hermes-native',grantUniveralAccess:false});guard();
   const listed=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,functionDeclaration:listImages.toString(),returnByValue:true});guard();
   if(listed.exceptionDetails)throw Error('page action failed');
   return listed.result?.value;
  }
  if(p.action==='js.evaluate')return this.pageRuntime.evaluate(t,p,guard);
  if(p.action==='cdp.send')return this.pageRuntime.send(t,p,guard);
  if(p.action==='network.inspect')return this.pageRuntime.network.inspect(t,p,guard);
  if(p.action==='cdp.events')return this.pageRuntime.drain(t,p,p.max);
  if(p.action==='frame_catalog')return this.frameCatalog(t,p,target,guard);
  if(p.action==='files.upload'){
   const tab=await get(p.tabId);
   // 中文注释：对话给出的本地文件不绑定来源（artifactOrigin 为 null），按当前任务页来源核对。
   const fileOrigin=p.artifactOrigin??origin(tab.url);
   // 中文注释：文件选择已通过本次智能审批或全部访问，仍须与当前任务页来源一致。
   if(origin(tab.url)!==fileOrigin||!t.allowedOrigins.includes(fileOrigin))throw Error('ARTIFACT_ORIGIN_DENIED');
   const artifactPrefix=`/plugin-data/browser-link-native/artifacts/${t.id}/${t.generation}/`;
   // 中文注释：UUID 目录隔离私有副本，末段保留原文件名；仍限定为本任务本代次的路径。
   if(!Array.isArray(p.filePaths)||!p.filePaths.length||p.filePaths.length>10||p.filePaths.some(file=>
    typeof file!=='string'||!file.startsWith('/')||!file.includes(artifactPrefix)
    ||!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/.test(file)))throw Error('ARTIFACT_PATH_DENIED');
   const tree=await this.checkedFrameTree(target,t,guard,false);
   const overlay=await this.ensureOverlay(t,p.tabId,target,guard,false);
   if(!overlay)throw Error('INTERACTION_HIGHLIGHT_UNAVAILABLE');
   const scoped=await this.overlayCall(p.tabId,overlay,'scope-running',{taskId:t.id,generation:t.generation,documentId:overlay.documentId,modeGeneration,actionToken:p[OVERLAY_ACTION_TOKEN],update:{state:'running',step:p.action}});
   guard();if(scoped!==true)throw Error('overlay scope stale');
   const selectFiles=async()=>{
    const current=await this.checkedFrameTree(target,t,guard,false);
    if(current.frame.loaderId!==tree.frame.loaderId||origin(current.frame.url)!==fileOrigin)throw Error('DOCUMENT_CHANGED');
    await this.api.debugger.sendCommand(target,'DOM.enable');guard();
    const document=await this.api.debugger.sendCommand(target,'DOM.getDocument',{depth:0});guard();
    const found=await this.api.debugger.sendCommand(target,'DOM.querySelectorAll',{nodeId:document.root.nodeId,selector:p.selector});guard();
    if(found?.nodeIds?.length!==1)throw Error('FILE_INPUT_NOT_UNIQUE');
    const nodeId=found.nodeIds[0];
    const described=await this.api.debugger.sendCommand(target,'DOM.describeNode',{nodeId});guard();
    const node=described?.node,attrs={};for(let i=0;i<(node?.attributes||[]).length;i+=2)attrs[node.attributes[i]]=node.attributes[i+1];
    if(node?.nodeName!=='INPUT'||attrs.type?.toLowerCase()!=='file'||(p.filePaths.length>1&&!Object.hasOwn(attrs,'multiple')))throw Error('NOT_FILE_INPUT');
    const before=await this.checkedFrameTree(target,t,guard,false);
    if(before.frame.loaderId!==tree.frame.loaderId)throw Error('DOCUMENT_CHANGED');
    // 中文注释：唯一文件输入、文档和来源确认后只派发一次；网站可能立即自动上传。
    await this.api.debugger.sendCommand(target,'DOM.setFileInputFiles',{nodeId,files:p.filePaths});guard();
    // 中文注释：原输入只用于设置文件和读回文件名；可见标签仅承担高亮，不扩大来源权限。
    const resolved=await this.api.debugger.sendCommand(target,'DOM.resolveNode',{nodeId});guard();
    let selectedFiles=[];
    try{
     const readback=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{objectId:resolved.object.objectId,
      functionDeclaration:'function(){return Array.from(this.files||[],file=>file.name)}',returnByValue:true});guard();
     selectedFiles=readback.result?.value;
    }finally{await this.api.debugger.sendCommand(target,'Runtime.releaseObject',{objectId:resolved.object.objectId}).catch(()=>{});}
    const expected=p.filePaths.map(file=>file.split('/').at(-1));
    return {selectedCount:Array.isArray(selectedFiles)?selectedFiles.length:0,selectedFiles,
     selectionState:JSON.stringify(selectedFiles)===JSON.stringify(expected)?'applied':'unconfirmed',websiteState:'unverified'};
   };
   return this.withInteractionHighlight({t,p,entry:overlay,guard,
    prepare:binding=>this.interactionHighlightCall(p.tabId,overlay,'prepare-selector',{binding,selector:p.selector,kind:'input',fileUpload:true,allowedOrigins:t.allowedOrigins},guard),
    verify:binding=>this.interactionHighlightCall(p.tabId,overlay,'verify-selector',{binding,selector:p.selector,fileUpload:true},guard),
    dispatch:selectFiles,visualOnly:true});
  }
  if(p.action==='back'){
   // Only go back to a page the task may use; check before navigating.
   const history=await this.api.debugger.sendCommand(target,'Page.getNavigationHistory');guard();
   const entry=history?.entries?.[history.currentIndex-1];
   if(!entry)throw Error('NO_PREVIOUS_PAGE');
   this.allowed(t,entry.url);await this.closeTabResources(t,p.tabId,null,{keepOverlay:true,keepNetwork:true});
   await this.markNavigating(t,p.tabId,'back');
   await this.api.tabs.goBack(p.tabId);guard();
   const settled=await this.settledTab(p.tabId,guard,await get(p.tabId),PAGE_SETTLE_MS);this.allowed(t,settled.tab.url);
   return {tabId:p.tabId,url:settled.tab.url,ready:settled.ready};
  }
  if(p.action==='scroll'&&!p.ref){
   // 中文注释：期限覆盖遮罩、布局和滚轮；若早期步骤迟到，不得在期限后继续派发滚轮。
   let scrollTimer,expired=false;
   const check=()=>{if(expired)throw Object.assign(Error('SCROLL_TIMEOUT'),{outcomeUnknown:true});guard();};
   const work=(async()=>{
    const scrollOverlay=t.overlays?.get(p.tabId);
    if(scrollOverlay)await this.overlayCall(p.tabId,scrollOverlay,'update',{actionToken:p[OVERLAY_ACTION_TOKEN],update:{state:'running',step:'scroll',scrollDirection:p.direction}}).catch(()=>{});
    check();
    const metrics=await this.api.debugger.sendCommand(target,'Page.getLayoutMetrics');check();
    const view=metrics?.cssLayoutViewport||metrics?.layoutViewport||{};
    const width=Number.isFinite(view.clientWidth)?view.clientWidth:800,height=Number.isFinite(view.clientHeight)?view.clientHeight:600;
    await this.api.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseWheel',x:Math.round(width/2),y:Math.round(height/2),
     deltaX:0,deltaY:(p.direction==='up'?-1:1)*Math.round(height*0.8)});check();
    return {tabId:p.tabId,scrolled:true,direction:p.direction};
   })();
   try{return await Promise.race([work,new Promise((_,reject)=>{scrollTimer=setTimeout(()=>{
    expired=true;reject(Object.assign(Error('SCROLL_TIMEOUT'),{outcomeUnknown:true}));
   },1800);})]);}
   finally{clearTimeout(scrollTimer);}
  }
  const doc=this.docs.get(p.tabId)||0;let result;
  const initialTree=await this.checkedFrameTree(target,t,guard,['page.observe','semantic_snapshot','page.parse'].includes(p.action)&&p.options?.composed===true);
  const overlay=await this.timed(p,'overlay',()=>this.ensureOverlay(t,p.tabId,target,guard,['page.observe','semantic_snapshot','page.parse'].includes(p.action)&&p.options?.composed===true,initialTree,initialTab));
  if(overlay)void this.syncPreveil(t,p.tabId).catch(()=>{});
  if(['click','fill','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','interaction.click','interaction.drag_coordinates','interaction.drag_elements'].includes(p.action)&&!overlay)throw Error('INTERACTION_HIGHLIGHT_UNAVAILABLE');
  if(overlay){
   const scoped=await this.overlayCall(p.tabId,overlay,'scope-running',{taskId:t.id,generation:t.generation,documentId:overlay.documentId,modeGeneration,actionToken:p[OVERLAY_ACTION_TOKEN],update:{state:'running',step:p.action}});
   guard();if(scoped!==true)throw Error('overlay scope stale');
  }
  const executionContextId=overlay?.contextId;
  if(p.action==='screenshot'){
   if(p.selector){
    // 中文注释：按唯一选择器滚到中央，不读取字段值。
    const world=await this.api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:initialTree.frame.id,worldName:'hermes-screenshot-target'});guard();
    const shown=await this.api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:world.executionContextId,
     functionDeclaration:'function(selector){const rows=[...document.querySelectorAll(selector)];if(rows.length!==1)return false;rows[0].scrollIntoView({behavior:"instant",block:"center",inline:"center"});return true;}',
     arguments:[{value:p.selector}],returnByValue:true});guard();
    if(shown.result?.value!==true){
     // 中文注释：只用脱敏语义名称给最多三个候选，不返回选择器匹配到的字段值。
     let candidates=[];
     try{
      const page=await this.callSemanticWorld(target,initialTree.frame.id,'semantic_snapshot',
       {binding:this.semanticBinding(t,p.tabId,initialTree.frame.loaderId),options:{mode:'interactive',budget:1200}},guard,executionContextId);
      candidates=(page.items||[]).slice(0,3).map(item=>({role:item.role,name:item.name}));
     }catch{}
     throw Error('SCREENSHOT_TARGET_MISSING|'+encodeURIComponent(JSON.stringify(candidates)));
    }
   }else if(p.ref){
    const binding=this.semanticBinding(t,p.tabId,initialTree.frame.loaderId);
    if(!p.binding||p.binding.taskId!==binding.taskId||p.binding.documentId!==binding.documentId||p.binding.leaseId!==binding.leaseId)throw Error('BINDING_MISMATCH');
    // 中文注释：截图对准只需滚到中央，不做点击前的遮挡检查；滚动在注入库外完成，不增加页面库体积。
    const [,top,,height]=await this.callSemanticWorld(target,initialTree.frame.id,'rect_ref',{binding:p.binding,snapshotId:p.snapshotId,ref:p.ref},guard,executionContextId);
    await this.api.debugger.sendCommand(target,'Runtime.evaluate',{expression:`window.scrollBy(0,${Math.round(top+height/2)}-innerHeight/2)`,contextId:executionContextId});guard();
   }
   const beforeMasks=await this.assertSafeCapture(target,t,guard,captureCache);
   // 中文注释：官方 browser_vision(annotate=true) 的编号标注在截图字节上绘制，不改动网页 DOM；截图前后位置必须一致。
   const mainFrameId=p.annotate?(await this.checkedFrameTree(target,t,guard,false)).frame.id:null;
   const readRects=()=>p.annotate?this.callSemanticWorld(target,mainFrameId,'annotation_rects',p.annotate,guard,executionContextId):null;
   const before=await readRects();
   result=await this.captureWithoutDecorations(t,p.tabId,overlay,guard,()=>this.api.debugger.sendCommand(target,'Page.captureScreenshot',{format:p.format||'png'}));
   const afterMasks=await this.assertSafeCapture(target,t,guard,captureCache);
   if(JSON.stringify(beforeMasks)!==JSON.stringify(afterMasks))throw Error('CAPTURE_SENSITIVE_BLOCKED');
   if(beforeMasks.length){
    try{
     const metrics=await this.api.debugger.sendCommand(target,'Page.getLayoutMetrics');guard();
     const view=metrics.cssVisualViewport||metrics.cssLayoutViewport;
     result.data=await maskCapturePng(result.data,beforeMasks,{width:view.clientWidth,height:view.clientHeight},p.format||'png');
    }catch{throw Error(beforeMasks.some(row=>row.kind==='uninspectable_frame')?'CAPTURE_FRAME_UNINSPECTABLE':'CAPTURE_SENSITIVE_BLOCKED');}
    result.masked=beforeMasks.map(({kind,role,name})=>({kind,role,name:name.slice(0,48)}));
   }
   if(p.annotate){
    const after=await readRects();
    if(JSON.stringify(before.viewport)!==JSON.stringify(after.viewport))throw Error('CAPTURE_CHANGED');
    // 中文注释：截图前后位置不一致的目标（动画、重排）不画编号，避免编号指向错误位置。
    const stable=after.rows.filter(row=>before.rows.some(prior=>JSON.stringify(prior)===JSON.stringify(row)));
    result={data:await annotatePng(result.data,stable,after.viewport),annotations:stable,omittedMoving:after.rows.length-stable.length};
   }
  } else if(['page.observe','page.parse','semantic_snapshot','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option'].includes(p.action)||(p.action==='scroll'&&p.ref)) {
   const tree=initialTree;const semanticBinding=this.semanticBinding(t,p.tabId,tree.frame.loaderId);
   if(['page.observe','semantic_snapshot','page.parse'].includes(p.action)&&p.options?.frameToken){
    const {token,frame,target:frameTarget}=await this.resolveFrame(t,p,tree,guard);
    const {frameToken:_,...options}=p.options;
    const binding=this.semanticBinding(t,p.tabId,frame.loaderId,frame.id);
    const frameContext=await this.exposeClosedShadowRoots(frameTarget,frame.id,guard);
    result=await this.callSemanticWorld(frameTarget,frame.id,p.action,{binding,options},guard,frameContext);
    result={...result,frameToken:token,items:(result.items||[]).map(item=>({...item,
     targetPath:[{kind:'frame',frameToken:token,documentId:frame.loaderId},...(item.targetPath||[])]}))};
    if(Math.ceil(JSON.stringify(result).length/4)>(options.budget??3000))throw Error('BUDGET_TOO_SMALL');
   }
   else if(['page.observe','semantic_snapshot','page.parse'].includes(p.action)){
    const context=p.options?.composed===true?await this.exposeClosedShadowRoots(target,tree.frame.id,guard,executionContextId):executionContextId;
    result=await this.callSemanticWorld(target,tree.frame.id,p.action,{binding:semanticBinding,options:p.options||{}},guard,context);
   }
   else {
    let resolved=p.frameToken?await this.resolveFrame(t,p,tree,guard):null;
    if(resolved)resolved=await this.scrollFrameChain(t,p,resolved,tree,guard);
    const frame=resolved?.frame||tree.frame,frameTarget=resolved?.target||target;
    const entry=resolved?await this.ensureChildHighlight(t,p,resolved,guard):overlay;
    const binding=resolved?this.semanticBinding(t,p.tabId,frame.loaderId,frame.id):semanticBinding;
    if(!p.binding||p.binding.taskId!==binding.taskId||p.binding.documentId!==binding.documentId||p.binding.leaseId!==binding.leaseId)throw Error('BINDING_MISMATCH');
    const basePayload={binding:p.binding,snapshotId:p.snapshotId,ref:p.ref};
    if(p.action==='scroll')return {tabId:p.tabId,direction:p.direction,...await this.callSemanticWorld(frameTarget,frame.id,'scroll_ref',{...basePayload,direction:p.direction},guard,entry?.contextId)};
    if(p.action==='ref_click'&&p.clickMode==='open_link_in_task_tab'){
     const inspection=await this.callSemanticWorld(frameTarget,frame.id,'inspect_ref_click',basePayload,guard,entry?.contextId);
     return this.openSafeLink(t,p,guard,inspection);
    }
    // 中文注释：隐藏文档也先走真实输入，空命中保留已核实的引用几何；真实遮挡仍由页面层拒绝。
    const visibility=['ref_click','ref_set_checked','ref_select_option'].includes(p.action)?
     await this.callSemanticWorld(frameTarget,frame.id,'input_visibility',basePayload,guard,entry?.contextId):null;
    const targetPayload={...basePayload,syntheticHidden:visibility?.visibility==='hidden',...(p.action==='ref_set_checked'?{checked:p.checked}:{})};
    const effectWork=work=>observeInputEffect({api:this.api,target:frameTarget,contextId:entry?.contextId,guard,work});
    let checkedPlan,selectPlan,relocated=false;
    const deliverSemanticPointer=async(highlightBinding,syntheticOp)=>{
     const payload={...targetPayload,highlightBinding};
     const arm=await this.callSemanticWorld(frameTarget,frame.id,'arm_ref_delivery',payload,guard,entry?.contextId);
     const synthetic=reason=>this.callSemanticWorld(frameTarget,frame.id,syntheticOp,{...payload,checked:p.checked,syntheticHidden:true,fallbackReason:reason},guard,entry?.contextId);
     try{
      // 中文注释：Chrome/Edge 本地实验确认后台 CDP 可送达，先走真实输入，再核实送达。
      const interactions=this.interactionsFor(t,p.tabId,guard,resolved?.record||null);
      const readTarget=()=>this.callSemanticWorld(frameTarget,frame.id,'pointer_target',payload,guard,entry?.contextId);
      try{await interactions.clickBoundTarget({taskId:t.id,generation:t.generation},{readTarget,guard});}
      catch(error){
       // 中文注释：按下前转后台则合成点击。
       if(error?.preDispatch===true){
        const now=await this.callSemanticWorld(frameTarget,frame.id,'probe_ref_delivery',payload,guard,entry?.contextId);
        if(now.visibility==='hidden')return {mode:'synthetic',result:await synthetic('background_tab_hit_test_unavailable')};
       }
       throw error;
      }
      let observed;
      for(let attempt=0;attempt<4;attempt++){
       observed=await this.callSemanticWorld(frameTarget,frame.id,'probe_ref_delivery',payload,guard,entry?.contextId);
       if(observed.target.trustedClick)break;
       await new Promise(resolve=>setTimeout(resolve,60));guard();
      }
      if(observed.target.trustedClick)return {mode:'trusted'};
      if(!observed.global.pointerdown&&!observed.global.mousedown&&!observed.global.click)
       return {mode:'synthetic',result:await synthetic('pointer_input_not_delivered')};
      // 中文注释：部分送达时禁止补发。
      return {mode:'partial'};
     }finally{
      await this.callSemanticWorld(frameTarget,frame.id,'clear_ref_delivery',payload,guard,entry?.contextId).catch(()=>{});
     }
    };
    const dispatch=highlightBinding=>effectWork(async()=>{
     if(p.action==='ref_click'){
      const delivered=await deliverSemanticPointer(highlightBinding,'synthetic_ref_click');
      if(delivered.mode==='synthetic')return delivered.result;
      if(delivered.mode==='partial')return {clicked:false,kind:'trusted-input',delivery:'partial',effect:'unverified',outcomeUnknown:true};
      return {clicked:true,kind:'trusted-input',delivery:'confirmed',effect:'unverified'};
     }
     if(p.action==='ref_set_checked'){
      if(!checkedPlan.needsClick)return {checked:p.checked,changed:false,verified:true};
      const delivered=await deliverSemanticPointer(highlightBinding,'synthetic_ref_set_checked');
      if(delivered.mode==='synthetic'){
       if(delivered.result.verified!==true)throw Error('TARGET_STATE_UNKNOWN');
       return delivered.result;
      }
      // 中文注释：关联 label 的可信点击可能不在 input 上产生可信 click；以控件选中状态核实。
      const checked=await this.callSemanticWorld(frameTarget,frame.id,'read_ref_set_checked',targetPayload,guard,entry?.contextId);
      if(checked.verified!==true)throw Error('TARGET_STATE_UNKNOWN');
      return {...checked,delivery:'confirmed'};
     }
     if(p.action==='ref_select_option'){
      if(selectPlan.kind==='native'){
       // 中文注释：原生 select 在同一页面调用内完成选中和事件派发，保留非 ASCII 标签与多选能力。
       return this.callSemanticWorld(frameTarget,frame.id,'apply_native_ref_select_option',{...targetPayload,by:p.by,values:p.values,highlightBinding},guard,entry?.contextId);
      }
      if(!selectPlan.needsChange)return {changed:false,verified:true,selectedCount:1};
      if(targetPayload.syntheticHidden){
       // 中文注释：后台自定义下拉逐项合成点击并回读状态，避免 CDP 静默丢失仍报告成功。
       return this.callSemanticWorld(frameTarget,frame.id,'synthetic_ref_select_option',{...targetPayload,highlightBinding,by:p.by,values:p.values,needsOpen:selectPlan.needsOpen,fallbackReason:'background_tab_input_unreliable'},guard,entry?.contextId);
      }
      const interactions=this.interactionsFor(t,p.tabId,guard,resolved?.record||null);
      const readTarget=optionTarget=>this.callSemanticWorld(frameTarget,frame.id,'pointer_target',{...targetPayload,highlightBinding,selectionTarget:true,optionTarget,by:p.by,values:p.values},guard,entry?.contextId);
      if(selectPlan.kind==='aria'){
       // 中文注释：自定义选择器的展开和选项点击分别走相同的可信指针路径，不重放部分完成的动作。
       if(selectPlan.needsOpen)await interactions.clickBoundTarget({taskId:t.id,generation:t.generation},{readTarget:()=>readTarget(false),guard});
       try{await interactions.clickBoundTarget({taskId:t.id,generation:t.generation},{readTarget:()=>readTarget(true),guard});}
       catch(error){
        // 中文注释：展开已经派发时，即使选项点击前失败也需先回读页面，不能报告整个操作未执行。
        if(selectPlan.needsOpen&&error&&typeof error==='object')error.preDispatch=false;
        throw error;
       }
      }
      return this.callSemanticWorld(frameTarget,frame.id,'read_ref_select_option',{...targetPayload,by:p.by,values:p.values},guard,entry?.contextId);
     }
     if(p.action==='ref_press'){
      const keyCode={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38}[p.key];
      if(!keyCode)throw Error('unsupported key');
      // 中文注释：焦点和引用在按键前再核实；子 frame 使用自己的 CDP session。
      await this.api.debugger.sendCommand(frameTarget,'Emulation.setFocusEmulationEnabled',{enabled:true});guard();
      try{
       await this.callSemanticWorld(frameTarget,frame.id,'focus_ref_press',{...targetPayload,highlightBinding},guard,entry?.contextId);
       await this.callSemanticWorld(frameTarget,frame.id,'press_check_ref',{...targetPayload,highlightBinding},guard,entry?.contextId);
       await this.api.debugger.sendCommand(frameTarget,'Input.dispatchKeyEvent',{type:'keyDown',key:p.key,code:p.key,...(p.key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}),windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode});guard();
       await this.api.debugger.sendCommand(frameTarget,'Input.dispatchKeyEvent',{type:'keyUp',key:p.key,code:p.key,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode});guard();
       // 中文注释：按键可能重绘目标；交付后由调用方重新读取业务结果，不沿用旧引用核实。
       return {pressed:true,key:p.key,delivery:'cdp-key-events',effect:'unverified'};
      }finally{await this.api.debugger.sendCommand(frameTarget,'Emulation.setFocusEmulationEnabled',{enabled:false});}
     }
     return this.callSemanticWorld(frameTarget,frame.id,p.action,{...targetPayload,text:p.text,checked:p.checked,by:p.by,values:p.values,highlightBinding},guard,entry?.contextId);
    });
    result=await this.withInteractionHighlight({t,p,entry,guard,visualOnly:true,
     prepare:async highlightBinding=>{
      await this.timed(p,'target_settle',()=>this.settleSemanticTarget(frameTarget,frame.id,targetPayload,guard,entry?.contextId));
      relocated=(await this.callSemanticWorld(frameTarget,frame.id,'ref_relocation',targetPayload,guard,entry?.contextId)).relocated===true;
      if(p.action==='ref_set_checked')checkedPlan=await this.callSemanticWorld(frameTarget,frame.id,'plan_ref_set_checked',{...targetPayload,checked:p.checked},guard,entry?.contextId);
      if(p.action==='ref_select_option')selectPlan=await this.callSemanticWorld(frameTarget,frame.id,'plan_ref_select_option',{...targetPayload,by:p.by,values:p.values},guard,entry?.contextId);
      return this.callSemanticWorld(frameTarget,frame.id,`prepare_${p.action}`,{...targetPayload,highlightBinding},guard,entry?.contextId);
     },
     verify:()=>this.callSemanticWorld(frameTarget,frame.id,'confirm_ref',targetPayload,guard,entry?.contextId).then(()=>({ok:true})),
     dispatch:highlightBinding=>['ref_click','ref_set_checked','ref_select_option'].includes(p.action)?this.withSpawnScope(t,p.tabId,()=>dispatch(highlightBinding)):dispatch(highlightBinding),
    });
    if(relocated&&result&&typeof result==='object')result={...result,relocated:true};
    if(p.action==='ref_click')result={...result,popupOwnership:'uncertain'};
   }
   // 中文注释：JS 对话框打开后该页的 CDP 调用会停住；对话框出现即结束收尾核实，并把对话框告知调用方。
   const settled=DISPATCHING_ACTIONS.has(p.action)?null:await this.raceDialog(t,p.tabId,this.checkedFrameTree(target,t,guard,false));
   if(settled?.dialogOpened&&result&&typeof result==='object'&&!result.dialogOpened)result={...result,dialogOpened:settled.dialogOpened};
  } else if(p.action.startsWith('interaction.')) {
   const interactions=this.interactionsFor(t,p.tabId,guard);const scoped={taskId:t.id,generation:t.generation};
   if(p.action==='interaction.capture'){
    const beforeMasks=await this.assertSafeCapture(target,t,guard,captureCache);
    result=await this.captureWithoutDecorations(t,p.tabId,overlay,guard,async()=>{const image=await interactions.capture(scoped);guard();return image;});
    t.interactionRefs.delete(p.tabId);
    const afterMasks=await this.assertSafeCapture(target,t,guard,captureCache);
    if(JSON.stringify(beforeMasks)!==JSON.stringify(afterMasks))throw Error('CAPTURE_SENSITIVE_BLOCKED');
    if(beforeMasks.length){
     try{result.image.data=await maskCapturePng(result.image.data,beforeMasks,result.viewport);}
     catch{throw Error(beforeMasks.some(row=>row.kind==='uninspectable_frame')?'CAPTURE_FRAME_UNINSPECTABLE':'CAPTURE_SENSITIVE_BLOCKED');}
     result.masked=beforeMasks.map(({kind,role,name})=>({kind,role,name:name.slice(0,48)}));
    }
  } else {
    const interactionTree=await this.checkedFrameTree(target,t,guard,false),documentId=interactionTree.frame.loaderId;
    if(['interaction.drag_coordinates','interaction.drag_elements'].includes(p.action)&&(p.mode||'pointer')==='pointer'){
     // 中文注释：后台指针拖动在派发前拒绝，避免 CDP 静默丢事件仍返回成功。
     const state=await t.interactions.get(p.tabId).adapter.evaluate('state');guard();
     if(state.visibility==='hidden')throw Object.assign(Error('BACKGROUND_POINTER_UNSUPPORTED'),{preDispatch:true});
    }
    if(p.action==='interaction.bounds'){
     result=await interactions.bounds({...scoped,screenshotId:p.screenshotId,selector:p.selector});guard();
     let refs=t.interactionRefs.get(p.tabId);if(!refs){refs=new Map();t.interactionRefs.set(p.tabId,refs);}
     const centerX=result.rect.x+result.rect.width/2,dpr=result.imageCenter.x/centerX;
     if(Number.isFinite(dpr)&&dpr>0){refs.set(result.ref,{screenshotId:p.screenshotId,selector:p.selector,rect:result.rect,dpr,documentId});while(refs.size>256)refs.delete(refs.keys().next().value);}
    }else if(p.action==='interaction.click'){
     if(!overlay)result=await observeInputEffect({api:this.api,target,contextId:executionContextId,guard,work:async()=>({...await this.withSpawnScope(t,p.tabId,()=>interactions.clickCoordinates({...scoped,screenshotId:p.screenshotId,point:p.point,expectedRef:p.expectedRef})),effect:'unverified'})});
     else{
      const meta=await this.checkedCoordinateTarget(t,p,interactions,p.point,p.expectedRef,guard,documentId);
      result=await this.withInteractionHighlight({t,p,entry:overlay,guard,visualOnly:true,
       prepare:binding=>this.interactionHighlightCall(p.tabId,overlay,'prepare-selector',{binding,selector:meta.selector,kind:'click',point:{x:p.point.x/meta.dpr,y:p.point.y/meta.dpr},allowedOrigins:t.allowedOrigins},guard),
       verify:async()=>{await this.checkedCoordinateTarget(t,p,interactions,p.point,p.expectedRef,guard,documentId);return {ok:true};},
       afterWait:()=>this.checkedCoordinateTarget(t,p,interactions,p.point,p.expectedRef,guard,documentId),
       dispatch:()=>observeInputEffect({api:this.api,target,contextId:executionContextId,guard,work:async()=>({...await this.withSpawnScope(t,p.tabId,()=>interactions.clickCoordinates({...scoped,screenshotId:p.screenshotId,point:p.point,expectedRef:p.expectedRef})),effect:'unverified'})}),
      });
      t.interactionRefs.delete(p.tabId);
     }
    }else if(p.action==='interaction.drag_coordinates'){
     if(!overlay)result=await interactions.dragCoordinates({...scoped,screenshotId:p.screenshotId,from:p.from,to:p.to,mode:p.mode||'pointer',...(p.steps===undefined?{}:{steps:p.steps})});
     else{
      const fromMeta=await this.checkedCoordinateTarget(t,p,interactions,p.from?.point,p.from?.expectedRef,guard,documentId);
      const toMeta=await this.checkedCoordinateTarget(t,p,interactions,p.to?.point,p.to?.expectedRef,guard,documentId);
      result=await this.withInteractionHighlight({t,p,entry:overlay,guard,
       prepare:binding=>this.interactionHighlightCall(p.tabId,overlay,'prepare-drag-selectors',{binding,fromSelector:fromMeta.selector,toSelector:toMeta.selector},guard),
       verify:binding=>this.interactionHighlightCall(p.tabId,overlay,'verify-drag-selectors',{binding,fromSelector:fromMeta.selector,toSelector:toMeta.selector},guard),
       afterWait:async()=>{
        await this.checkedCoordinateTarget(t,p,interactions,p.from?.point,p.from?.expectedRef,guard,documentId);
        await this.checkedCoordinateTarget(t,p,interactions,p.to?.point,p.to?.expectedRef,guard,documentId);
       },
       dispatch:()=>interactions.dragCoordinates({...scoped,screenshotId:p.screenshotId,from:p.from,to:p.to,mode:p.mode||'pointer',...(p.steps===undefined?{}:{steps:p.steps})}),
      });
      t.interactionRefs.delete(p.tabId);
     }
    }else if(p.action==='interaction.drag_elements'){
     if(!overlay)result=await interactions.dragElements({...scoped,screenshotId:p.screenshotId,source:p.source,target:p.target,mode:p.mode||'pointer',...(p.steps===undefined?{}:{steps:p.steps})});
     else{
      const fromMeta=await this.checkedSelectorTarget(t,p,interactions,p.source,guard,documentId);
      const toMeta=await this.checkedSelectorTarget(t,p,interactions,p.target,guard,documentId);
      result=await this.withInteractionHighlight({t,p,entry:overlay,guard,
       prepare:binding=>this.interactionHighlightCall(p.tabId,overlay,'prepare-drag-selectors',{binding,fromSelector:p.source,toSelector:p.target},guard),
       verify:binding=>this.interactionHighlightCall(p.tabId,overlay,'verify-drag-selectors',{binding,fromSelector:p.source,toSelector:p.target},guard),
       afterWait:async()=>{
        const from=await this.checkedSelectorTarget(t,p,interactions,p.source,guard,documentId);
        const to=await this.checkedSelectorTarget(t,p,interactions,p.target,guard,documentId);
        if(canonical(from.rect)!==canonical(fromMeta.rect)||canonical(to.rect)!==canonical(toMeta.rect))throw Error('INTERACTION_HIGHLIGHT_TARGET_CHANGED');
       },
       dispatch:()=>interactions.dragElements({...scoped,screenshotId:p.screenshotId,source:p.source,target:p.target,mode:p.mode||'pointer',...(p.steps===undefined?{}:{steps:p.steps})}),
      });
      t.interactionRefs.delete(p.tabId);
     }
    }else throw Error('unsupported action');
    guard();if(!DISPATCHING_ACTIONS.has(p.action))await this.checkedFrameTree(target,t,guard,false);
   }
  } else {
   if(p.action!=='snapshot'&&(typeof p.selector!=='string'||p.selector.length>4096))throw Error('invalid selector');
   if(p.action==='fill'&&(typeof p.text!=='string'||p.text.length>65536))throw Error('invalid text');
   const tree=await this.checkedFrameTree(target,t,guard,false);
   let emulatedFocus=false;
   try {
    // CDP keys to an inactive tab are dropped unless that page emulates focus.
    // Unlike Page.bringToFront this does not activate the user's tab.
    if(p.action==='press'){
     await this.api.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:true});emulatedFocus=true;guard();
    }
    if(p.action==='click'&&p.clickMode==='open_link_in_task_tab'){
     const inspection=await this.callWorld(target,tree.frame.id,t,'inspect_click',p.selector,null,null,guard,executionContextId);
     return this.openSafeLink(t,p,guard,inspection);
    }
    const dispatch=highlightBinding=>this.callWorld(target,tree.frame.id,t,p.action,p.selector,p.text,p.key,guard,executionContextId,highlightBinding);
    if(p.action==='click'||p.action==='fill'){
     const kind=p.action==='click'?'click':'input';
     result=await this.withInteractionHighlight({t,p,entry:overlay,guard,visualOnly:true,
      prepare:binding=>this.interactionHighlightCall(p.tabId,overlay,'prepare-selector',{binding,selector:p.selector,kind,allowedOrigins:t.allowedOrigins},guard),
      verify:()=>this.callWorld(target,tree.frame.id,t,`confirm_${p.action}`,p.selector,null,null,guard,executionContextId),
      dispatch:binding=>p.action==='click'?observeInputEffect({api:this.api,target,contextId:executionContextId,guard,work:async()=>({...await this.withSpawnScope(t,p.tabId,()=>dispatch(binding)),kind:'dom-synthetic',effect:'unverified'})}):dispatch(binding),
     });
    }else result=await dispatch(null);
    if(p.action==='click')result={...result,popupOwnership:'uncertain'};
    if(p.action==='press'){
     result=await observeInputEffect({api:this.api,target,contextId:executionContextId,guard,work:async()=>{
     const inspection=await this.callWorld(target,tree.frame.id,t,'inspect',null,null,null,guard);if(inspection?.hasSensitiveValue)throw Error('sensitive press blocked');
     await this.callWorld(target,tree.frame.id,t,'press_check',p.selector,null,p.key,guard);
     if(doc!==(this.docs.get(p.tabId)||0))throw Error('document changed');await get(p.tabId);
     const keyCode={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38}[p.key];if(!keyCode)throw Error('unsupported key');
     await this.api.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyDown',key:p.key,code:p.key,...(p.key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}),windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode});guard();
     // 中文注释：Tab 会转移焦点，Enter 可能导航；派发后只核对任务权限，不再要求旧焦点或旧文档存在。
     await this.api.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key:p.key,code:p.key,windowsVirtualKeyCode:keyCode,nativeVirtualKeyCode:keyCode});
     return {...result,effect:'unverified',delivery:'cdp-key-events'};
     }});
    }
    if(!DISPATCHING_ACTIONS.has(p.action))await this.checkedFrameTree(target,t,guard,false);
   } finally {
    if(emulatedFocus)await this.api.debugger.sendCommand(target,'Emulation.setFocusEmulationEnabled',{enabled:false});
   }
  }
  guard();
  // 中文注释：点击/按键已派发后页面跳转属于正常结果；如实返回，不再报“文档已变化”让模型误判为失败。
  const dispatchedInput=DISPATCHING_ACTIONS.has(p.action)&&result!==undefined;
  if(dispatchedInput){
   const tab=await this.timed(p,'post_check',()=>this.api.tabs.get(p.tabId));guard();
   // 中文注释：frame 可能先于 tabs/onUpdated 提交新文档；这里只读导航元数据，范围外不再读取页面正文。
   const after=await this.raceDialog(t,p.tabId,this.api.debugger.sendCommand(target,'Page.getFrameTree',{}));guard();
   if(after?.dialogOpened)return {...result,dialogOpened:after.dialogOpened};
   const frame=after?.frameTree?.frame;
   if(!frame?.loaderId||!frame.url)throw Error('DOCUMENT_CHANGED');
   try{this.allowed(t,tab.url);this.allowed(t,frame.url);}catch{return {...result,documentChanged:true,outOfScope:true};}
   if(doc!==(this.docs.get(p.tabId)||0)||frame.loaderId!==initialTree.frame.loaderId)return {...result,documentChanged:true,url:frame.url};
   return result;
  }
  if(doc!==(this.docs.get(p.tabId)||0))throw Error('document changed');
  await this.timed(p,'post_check',()=>get(p.tabId));return result;
 }
}
