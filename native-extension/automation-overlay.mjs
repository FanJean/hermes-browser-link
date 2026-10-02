const states={waiting:'Hermes 正在工作',running:'Hermes 正在工作',pausing:'正在暂停…',paused:'已暂停 · 你可以操作页面',resuming:'正在恢复…',stopping:'正在停止…',stopped:'已停止',disconnected:'与扩展的连接已断开',unknown:'状态待核查'};
const interactionLabels={click:'准备点击',input:'正在输入',select:'正在选择',drag:'正在拖动'};
const stepLabels={tabs:'读取标签页',new_tab:'打开新标签页',navigate:'打开网页',snapshot:'读取页面',click:'点击页面',fill:'填写内容',press:'按键',screenshot:'截取页面',semantic_snapshot:'理解页面',frame_catalog:'读取页面结构',ref_click:'点击元素',ref_fill:'填写元素',ref_press:'按键',ref_set_checked:'设置选项',ref_select_option:'选择选项',scroll:'滚动页面',back:'返回上一页'};
const rectOk=r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;
const highlightRectOk=r=>r&&[r.left,r.top,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;

export function createAutomationOverlay({document:doc=globalThis.document,taskId,generation,tabId,origin,documentId=null,onStop,onTakeover,onResume,commandTimeoutMs=8000}={}){
 if(!doc?.documentElement||doc.location?.origin!==origin||!/^https?:\/\//.test(origin)||!taskId||!Number.isSafeInteger(generation)||generation<1||!Number.isInteger(tabId)||typeof onStop!=='function'||typeof onTakeover!=='function'||typeof onResume!=='function')throw Error('overlay scope denied');
 const host=doc.createElement('div');host.dataset.hermesAutomationOverlay='';host.dataset.hermesOverlayTask=taskId;host.dataset.hermesOverlayGeneration=String(generation);host.setAttribute?.('aria-hidden','false');
 Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'2147483647',pointerEvents:'auto',background:'transparent'});
 const shadow=host.attachShadow({mode:'closed'});
 // 中文注释：透明遮罩拦截用户点击；执行页面动作时短暂让出命中测试。
 const veil=doc.createElement('div');veil.dataset.role='veil';veil.setAttribute?.('aria-hidden','true');
 Object.assign(veil.style,{position:'fixed',inset:'0',background:'rgba(13,35,25,.10)',pointerEvents:'none'});
 const border=doc.createElement('div');border.dataset.role='border';border.setAttribute?.('aria-hidden','true');
 Object.assign(border.style,{position:'fixed',inset:'0',border:'2px solid rgba(31,117,75,.55)',boxSizing:'border-box',pointerEvents:'none'});
 const target=doc.createElement('div');target.dataset.role='target';target.setAttribute?.('aria-hidden','true');
 Object.assign(target.style,{position:'fixed',display:'none',border:'2px solid #e59b17',background:'rgba(229,155,23,.12)',boxSizing:'border-box',pointerEvents:'none'});
 // 中文注释：交互高亮加粗、外发光并脉冲闪烁，标签贴在目标旁边，便于实时看清正在操作的模块。
 const pulse=doc.createElement('style');
 pulse.textContent='@keyframes hermes-pulse{0%{box-shadow:0 0 0 0 rgba(255,138,0,.65),0 0 14px rgba(255,138,0,.55)}100%{box-shadow:0 0 0 12px rgba(255,138,0,0),0 0 14px rgba(255,138,0,.55)}}';
 const highlightStyle=color=>({position:'fixed',display:'none',border:`3px solid ${color}`,borderRadius:'4px',background:color==='#ff8a00'?'rgba(255,138,0,.16)':'rgba(56,136,232,.16)',boxSizing:'border-box',pointerEvents:'none',animation:'hermes-pulse 0.9s ease-out infinite'});
 const interactionTarget=doc.createElement('div');interactionTarget.dataset.role='target';interactionTarget.setAttribute('aria-hidden','true');
 Object.assign(interactionTarget.style,highlightStyle('#ff8a00'));
 const dragStart=doc.createElement('div');dragStart.dataset.role='drag-start';dragStart.setAttribute('aria-hidden','true');
 Object.assign(dragStart.style,highlightStyle('#3888e8'));
 const dragEnd=doc.createElement('div');dragEnd.dataset.role='drag-end';dragEnd.setAttribute('aria-hidden','true');
 Object.assign(dragEnd.style,highlightStyle('#ff8a00'));
 const interactionStatus=doc.createElement('div');interactionStatus.dataset.role='interaction-status';interactionStatus.setAttribute('aria-hidden','true');
 Object.assign(interactionStatus.style,{position:'fixed',top:'48px',left:'8px',maxWidth:'min(240px,90vw)',padding:'4px 9px',borderRadius:'6px',background:'#ff8a00',color:'#1d1300',font:'600 12px/1.35 system-ui,sans-serif',boxShadow:'0 2px 8px #0004',pointerEvents:'none',display:'none',whiteSpace:'nowrap'});
 const cursor=doc.createElement('div');cursor.dataset.role='virtual-cursor';cursor.setAttribute('aria-hidden','true');
 Object.assign(cursor.style,{position:'fixed',left:'0',top:'0',display:'none',width:'12px',height:'18px',background:'#fff',border:'2px solid #143b29',clipPath:'polygon(0 0,0 100%,35% 75%,60% 100%,75% 90%,48% 65%,100% 65%)',filter:'drop-shadow(0 1px 2px #0008)',pointerEvents:'none',transition:'transform 180ms ease-out',zIndex:'3'});
 const cursorHint=doc.createElement('div');cursorHint.setAttribute('aria-hidden','true');
 Object.assign(cursorHint.style,{position:'fixed',display:'none',padding:'2px 5px',borderRadius:'4px',background:'#163a2a',color:'#fff',font:'11px system-ui',pointerEvents:'none',zIndex:'3'});
 const ripple=doc.createElement('div');ripple.setAttribute('aria-hidden','true');
 Object.assign(ripple.style,{position:'fixed',display:'none',width:'26px',height:'26px',border:'2px solid #ff8a00',borderRadius:'50%',pointerEvents:'none',zIndex:'2',opacity:'0',transition:'opacity 180ms ease-out,transform 180ms ease-out'});
 const bar=doc.createElement('div');bar.dataset.role='status';
 Object.assign(bar.style,{position:'fixed',top:'16px',right:'16px',width:'min(342px,calc(100vw - 32px))',padding:'14px 16px',border:'1px solid rgba(255,255,255,.16)',borderRadius:'14px',background:'#172a20',color:'#fff',font:'13px/1.45 system-ui,sans-serif',boxShadow:'0 12px 35px rgba(0,0,0,.22)',pointerEvents:'auto'});
 const eyebrow=doc.createElement('div');eyebrow.textContent='HERMES · 浏览器任务';Object.assign(eyebrow.style,{fontSize:'10px',letterSpacing:'.09em',color:'#a9c9b6',marginBottom:'6px'});bar.append(eyebrow);
 const label=doc.createElement('div');label.textContent=states.waiting;Object.assign(label.style,{fontSize:'15px',fontWeight:'650'});bar.append(label);
 const detail=doc.createElement('div');detail.textContent='页面暂不可点击 · Ctrl+Alt+Shift+F12 接管';Object.assign(detail.style,{fontSize:'12px',color:'#bfd0c4',marginTop:'3px'});bar.append(detail);
 const actions=doc.createElement('div');actions.dataset.role='actions';Object.assign(actions.style,{display:'flex',gap:'8px',marginTop:'12px'});bar.append(actions);
 const recent=doc.createElement('details');Object.assign(recent.style,{marginTop:'8px',fontSize:'11px'});
 const recentTitle=doc.createElement('summary');recentTitle.textContent='最近步骤';recent.append(recentTitle);
 const recentList=doc.createElement('ol');Object.assign(recentList.style,{paddingLeft:'18px',margin:'6px 0 0'});recent.append(recentList);bar.append(recent);
 host.tabIndex=-1;
 let removed=false,busy=false,hideDepth=0,hiddenHosts=null,activeHighlightToken=null,inputWindowTimer=null,inputWindowOpen=false,currentState='waiting',cursorEnabled=true,cursorTimer=null,commandTimer=null,commandAbort=null,lastCommand=null;
 const controls=[];
 // 中文注释：控制回执有独立期限；取消等待只清理本地请求，不取消任务、不授予接管。
 const invoke=async(action,el,callback)=>{
   if(removed||busy)return;
   busy=true;lastCommand={action,el,callback};commandAbort=new AbortController();const controller=commandAbort;
   overlay.update({state:action==='takeover'?'pausing':action==='resume'?'resuming':'stopping'});el.disabled=true;
   try{
    // 中文注释：扩展确认仍在等待步骤时续期；断连后进度回执停止，八秒内进入可恢复提示。
    let expire;const timeout=new Promise(resolve=>{expire=resolve;});
    const armTimeout=()=>{clearTimeout(commandTimer);commandTimer=setTimeout(()=>{controller.abort();expire({state:'disconnected'});},commandTimeoutMs);};
    armTimeout();
    const onProgress=()=>{if(!removed&&commandAbort===controller&&!controller.signal.aborted)armTimeout();};
    const result=await Promise.race([callback(Object.freeze({taskId,generation,tabId,origin}),{signal:controller.signal,onProgress}),timeout]);
    if(removed||commandAbort!==controller)return;
    if(result?.state==='stopped'){remove();return;}
    if(result?.state==='paused'){overlay.update({state:'paused'});return;}
    if(result?.state==='running'){overlay.update({state:'waiting'});return;}
    overlay.update({state:result?.state==='disconnected'?'disconnected':'unknown'});
   }catch{if(!removed&&commandAbort===controller)overlay.update({state:'disconnected'});}
   finally{clearTimeout(commandTimer);commandTimer=null;if(commandAbort===controller){commandAbort=null;busy=false;el.disabled=false;}}
 };
 const button=(name,action,callback,local=false)=>{
  const el=doc.createElement('button');el.type='button';el.textContent=name;el.dataset.action=action;controls.push(el);
  const primary=['takeover','resume','retry'].includes(action);
  Object.assign(el.style,{padding:'7px 12px',border:'1px solid #83a28e',borderRadius:'8px',background:primary?'#e8f3eb':'transparent',color:primary?'#183b27':'#e6f2e9',font:'600 12px system-ui,sans-serif',pointerEvents:'auto',cursor:'pointer'});
  el.addEventListener('click',event=>{if(event.isTrusted)return local?callback():invoke(action,el,callback);});
  return el;
 };
 const takeover=button('接管页面','takeover',onTakeover),resume=button('退出接管','resume',onResume),stop=button('停止任务','stop',onStop);
 // 中文注释：恢复操作复用同一个按钮组件，只有真实用户事件能放开页面或重试控制。
 const release=button('放开页面','release',remove,true);
 const retry=button('重试','retry',()=>{if(lastCommand)return invoke(lastCommand.action,lastCommand.el,lastCommand.callback);},true);
 release.style.display=retry.style.display=resume.style.display='none';actions.append(takeover,resume,stop,release,retry);
 shadow.append(veil,border,target,interactionTarget,dragStart,dragEnd,interactionStatus,cursor,cursorHint,ripple,bar,pulse);doc.documentElement.append(host);
 // 中文注释：在窗口捕获阶段阻断输入，覆盖 z-index 之上的 dialog/popover；派发窗口和用户接管时放行。
 // 中文注释：是否拦截只由私有任务状态决定，网页修改 host 样式不能授予接管权限。
 const isBlocking=()=>!removed&&currentState!=='paused'&&!inputWindowOpen;
 const blockKeys=event=>{
  if(event.type==='keydown'&&event.isTrusted&&event.key==='F12'&&event.ctrlKey&&event.altKey&&event.shiftKey&&!event.metaKey&&currentState!=='paused'){
   event.preventDefault();event.stopImmediatePropagation();void invoke('takeover',takeover,onTakeover);return;
  }
  if(isBlocking()&&event.isTrusted&&!event.composedPath().includes(host)){event.preventDefault();event.stopImmediatePropagation();}
 };
 const keyEvents=['keydown','keypress','keyup','beforeinput','pointerdown','pointerup','mousedown','mouseup','click','dblclick','auxclick','contextmenu','wheel','touchstart','touchmove'];
 for(const type of keyEvents)doc.defaultView?.addEventListener?.(type,blockKeys,{capture:true,passive:false});
 const matchesScope=request=>request&&request.taskId===taskId&&request.generation===generation&&
  (documentId===null||request.documentId===documentId)&&typeof request.operationToken==='string'&&request.operationToken.length>0;
 const interactionSurface=Object.freeze({
  host,
  isAvailable(scope){return !removed&&host.isConnected&&matchesScope({...scope,operationToken:'availability'});},
  update(request){
   if(!matchesScope(request)||!['click','input','select','drag'].includes(request.kind)||!Array.isArray(request.rects)||request.rects.length!==(request.kind==='drag'?2:1)||request.rects.some(rect=>!highlightRectOk(rect)))return {ok:false,code:'INVALID_SURFACE_UPDATE'};
   if(activeHighlightToken&&activeHighlightToken!==request.operationToken)return {ok:false,code:'STALE_OPERATION'};
   activeHighlightToken=request.operationToken;host.setAttribute('data-hermes-interaction-highlight','');
   for(const element of [interactionTarget,dragStart,dragEnd]){element.style.opacity='1';element.style.transition='left 180ms ease-out, top 180ms ease-out, width 180ms ease-out, height 180ms ease-out, opacity 600ms ease-out';}
   interactionStatus.style.opacity='1';interactionStatus.textContent=`${interactionLabels[request.kind]}${request.label?`：${String(request.label).slice(0,48)}`:''}`;
   const anchor=request.rects[request.rects.length-1],view=doc.defaultView;
   const labelTop=anchor.top>=30?anchor.top-28:Math.min(anchor.top+anchor.height+6,(view?.innerHeight||10000)-28);
   Object.assign(interactionStatus.style,{display:'block',top:`${Math.max(4,labelTop)}px`,left:`${Math.max(4,Math.min(anchor.left,(view?.innerWidth||10000)-160))}px`});
   const setRect=(element,rect)=>Object.assign(element.style,{display:'block',left:`${rect.left-3}px`,top:`${rect.top-3}px`,width:`${rect.width+6}px`,height:`${rect.height+6}px`});
   if(request.kind==='drag'){
    interactionTarget.style.display='none';setRect(dragStart,request.rects[0]);setRect(dragEnd,request.rects[1]);
   }else{
    setRect(interactionTarget,request.rects[0]);dragStart.style.display='none';dragEnd.style.display='none';
   }
   if(cursorEnabled&&doc.visibilityState!=='hidden'){
    const point=request.point&&Number.isFinite(request.point.x)&&Number.isFinite(request.point.y)?request.point:
     {x:anchor.left+anchor.width/2,y:anchor.top+anchor.height/2};
    clearTimeout(cursorTimer);cursor.style.display='block';cursor.style.transform=`translate(${point.x}px,${point.y}px)`;
    cursorHint.style.display=request.kind==='input'?'block':'none';cursorHint.textContent=request.kind==='input'?'⌨ 输入中':'';
    Object.assign(cursorHint.style,{left:`${point.x+14}px`,top:`${point.y+12}px`});
    if(request.kind==='click')cursorTimer=setTimeout(()=>{if(activeHighlightToken!==request.operationToken)return;
     Object.assign(ripple.style,{display:'block',left:`${point.x-13}px`,top:`${point.y-13}px`,opacity:'1',transform:'scale(.4)'});
     doc.defaultView?.requestAnimationFrame?.(()=>Object.assign(ripple.style,{opacity:'0',transform:'scale(1.5)'}));
    },180);
    if(request.kind==='drag'&&request.rects.length===2){const start=request.rects[0],end=request.rects[1];
     cursor.style.transform=`translate(${start.left+start.width/2}px,${start.top+start.height/2}px)`;
     doc.defaultView?.requestAnimationFrame?.(()=>{if(activeHighlightToken===request.operationToken)cursor.style.transform=`translate(${end.left+end.width/2}px,${end.top+end.height/2}px)`;});}
   }
   return {ok:true};
  },
  fade(request){
   if(!matchesScope(request)||activeHighlightToken!==request.operationToken)return {ok:false,code:'STALE_OPERATION'};
   for(const element of [interactionTarget,dragStart,dragEnd,interactionStatus])element.style.opacity='0';
   return {ok:true};
  },
  clear(request){
   if(!matchesScope(request))return {ok:false,code:'INVALID_SCOPE'};
   if(!activeHighlightToken||activeHighlightToken!==request.operationToken)return {ok:false,code:'STALE_OPERATION'};
   activeHighlightToken=null;host.removeAttribute('data-hermes-interaction-highlight');clearTimeout(cursorTimer);cursorTimer=null;
   interactionTarget.style.display='none';dragStart.style.display='none';dragEnd.style.display='none';interactionStatus.style.display='none';interactionStatus.textContent='';
   cursor.style.display='none';cursorHint.style.display='none';ripple.style.display='none';
   return {ok:true};
  },
  isVisible(operationToken){
   if(removed||!host.isConnected||activeHighlightToken!==operationToken||!host.hasAttribute('data-hermes-interaction-highlight'))return false;
   try{
    if(doc.defaultView.getComputedStyle(host).display==='none'||transparent(host))return false;
    return interactionTarget.style.display==='block'||dragStart.style.display==='block'&&dragEnd.style.display==='block';
   }catch{return false;}
  },
 });
 function decoratedHosts(){return !removed&&host.isConnected?[host]:[];}
 // 中文注释：截图时只把遮罩调成全透明，不移出布局；透明层仍然拦截用户点击。
 const transparent=element=>doc.defaultView.getComputedStyle(element).opacity==='0';
 function hide(){
  if(removed)return true;
  if(hideDepth===0){
   hiddenHosts=new Map();
   try{
    for(const element of decoratedHosts()){
     hiddenHosts.set(element,{opacity:element.style.getPropertyValue('opacity'),priority:element.style.getPropertyPriority('opacity'),computed:doc.defaultView.getComputedStyle(element).opacity});
     element.style.setProperty('opacity','0','important');
    }
    if(!decoratedHosts().every(transparent))throw Error('overlay hide not confirmed');
   }catch{
    for(const [element,previous] of hiddenHosts){if(previous.opacity)element.style.setProperty('opacity',previous.opacity,previous.priority);else element.style.removeProperty('opacity');}
    hiddenHosts=null;return false;
   }
  }
  hideDepth++;
  return true;
 }
 function restore(){
  if(removed)return true;
  if(hideDepth===0)return true;
  hideDepth--;
  if(hideDepth>0)return decoratedHosts().every(transparent);
  let restored=true;
  for(const [element,previous] of hiddenHosts||[]){
   if(!element.isConnected)continue;
   try{
    if(previous.opacity)element.style.setProperty('opacity',previous.opacity,previous.priority);else element.style.removeProperty('opacity');
    if(doc.defaultView.getComputedStyle(element).opacity!==previous.computed)restored=false;
   }catch{restored=false;}
  }
  hiddenHosts=null;
  if(!restored)overlay.reblock();
  return restored;
 }
 function remove(){
  if(removed)return;
  if(activeHighlightToken)interactionSurface.clear({taskId,generation,...(documentId===null?{}:{documentId}),operationToken:activeHighlightToken});
  removed=true;clearTimeout(commandTimer);commandTimer=null;commandAbort?.abort();commandAbort=null;observer?.disconnect();doc.defaultView?.removeEventListener?.('pageshow',recover);doc.defaultView?.removeEventListener?.('blur',checkFrameFocus,true);doc.removeEventListener?.('focusin',checkFrameFocus,true);hiddenHosts=null;hideDepth=0;clearTimeout(inputWindowTimer);clearTimeout(cursorTimer);inputWindowTimer=null;host.remove();
  for(const type of keyEvents)doc.defaultView?.removeEventListener?.(type,blockKeys,true);
 }
 // 中文注释：清理事件只能本地卸载浮层；即使网页主动触发，也不能授予任务权限或伪造暂停。
 host.addEventListener('hermes-overlay-release',remove);
 const overlay=Object.freeze({
  host,interactionSurface,hide,restore,
  setCursorEnabled(enabled){cursorEnabled=enabled===true;if(!cursorEnabled){clearTimeout(cursorTimer);cursor.style.display='none';cursorHint.style.display='none';ripple.style.display='none';}},
  setRecentSteps(steps){
   // 中文注释：只接收守护进程的脱敏步骤字段，错误码映射为固定说明。
   if(removed||!Array.isArray(steps))return;
   const explanations={task_paused:'用户已接管页面',element_timeout:'目标未在期限内出现',target_occluded:'目标被其他元素遮挡',
    scroll_timeout:'滚动结果尚未确认',stale_ref:'页面引用已失效',document_changed:'文档已变化',
    origin_denied:'目标网站不在任务授权范围',permission_denied:'浏览器权限不足',instance_unavailable:'浏览器已断开'};
   recentList.replaceChildren(...steps.slice(-5).map(row=>{
    const item=doc.createElement('li');const code=typeof row.result==='string'?row.result:'';
    item.textContent=`${String(row.time||'').slice(11,19)} ${String(row.action||'').slice(0,40)} · ${String(row.target||'').slice(0,80)} · ${Number(row.durationMs)||0}ms · ${code==='succeeded'?'成功':code==='unknown'?'结果不确定':code==='failed'?'失败':code}`;
    if(code!=='succeeded'&&code!=='pending'){item.style.color='#ffaaa2';item.textContent+=`（${explanations[code]||'请核查当前页面状态'}）`;}
    return item;
   }));
  },
  update({state,step='',targetRect,holdMs,scrollDirection}={}){
   if(removed)return;
   if(state==='stopped'){remove();return;}
   clearTimeout(inputWindowTimer);inputWindowTimer=null;currentState=state;
   const recovery=state==='disconnected'||state==='unknown';
   release.style.display=retry.style.display=recovery?'inline-block':'none';retry.disabled=!lastCommand;
   stop.style.display=recovery?'none':'inline-block';
   label.textContent=state==='pausing'?'等待当前步骤结束…':states[state]||states.unknown;
   detail.textContent=recovery?'放开页面仅恢复本地输入，不代表任务已暂停；请核查任务状态':state==='paused'?'页面操作权已交给你':state==='running'&&step?`当前步骤：${stepLabels[step]||'处理页面'} · Ctrl+Alt+Shift+F12 接管`:state==='unknown'?'请核查 Hermes 中的任务状态':
    '页面暂不可点击 · Ctrl+Alt+Shift+F12 接管';
   // 中文注释：遮罩一直拦截用户点击和键盘，直到用户点“接管页面”；普通模式只在页面动作派发时放行，
   // 原始 CDP 只在输入派发的短窗口内放行，窗口到期由页面内计时器自行恢复拦截。
   const dispatching=['click','fill','press','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','interaction.click','interaction.drag_coordinates','interaction.drag_elements','scroll'];
   const scriptInput=state==='running'&&step==='cdp.input';
   // 中文注释：派发瞬间状态栏及按钮也临时放行，否则位于栏下的页面目标被判为遮挡，指针点击也会落在栏上。
   const passThrough=state==='running'&&dispatching.includes(step)||scriptInput;
   inputWindowOpen=passThrough;host.style.pointerEvents=state==='paused'||passThrough?'none':'auto';
   if(passThrough){
    const windowMs=Number.isInteger(holdMs)&&holdMs>0?Math.min(holdMs,10000):scriptInput?600:5000;
    inputWindowTimer=setTimeout(()=>{inputWindowTimer=null;overlay.reblock();},windowMs);
   }
   for(const node of [bar,...controls])node.style.pointerEvents=passThrough?'none':'auto';
   if(!passThrough&&state!=='paused')checkFrameFocus();
   veil.style.display=state==='paused'?'none':'block';border.style.display=state==='paused'?'none':'block';
   takeover.style.display=state==='paused'||recovery?'none':'inline-block';resume.style.display=state==='paused'?'inline-block':'none';
   if(rectOk(targetRect)){Object.assign(target.style,{display:'block',left:`${targetRect.x}px`,top:`${targetRect.y}px`,width:`${targetRect.width}px`,height:`${targetRect.height}px`});}
   else target.style.display='none';
   if(cursorEnabled&&state==='running'&&step==='scroll'&&doc.visibilityState!=='hidden'){
    cursorHint.textContent=scrollDirection==='up'?'↑ 向上滚动':'↓ 向下滚动';cursorHint.style.display='block';cursorHint.style.left='50%';cursorHint.style.top='50%';
   }else if(!activeHighlightToken)cursorHint.style.display='none';
  },
  async withHidden(fn){
   if(typeof fn!=='function')throw Error('screenshot callback required');
   if(removed)return fn();
   if(!hide())throw Error('overlay hide failed');
   let result,callbackFailed=false,callbackError;
   try{result=await fn();}catch(error){callbackFailed=true;callbackError=error;}
   if(!restore())throw Error('overlay restore failed');
   if(callbackFailed)throw callbackError;
   return result;
  },
  // 中文注释：授权撤销等不能写回状态的场合，只把派发放行收回为拦截；用户已接管时保持放开。
  reblock(){
   if(removed||currentState==='paused')return;
   clearTimeout(inputWindowTimer);inputWindowTimer=null;
   inputWindowOpen=false;host.style.pointerEvents='auto';for(const node of [bar,...controls])node.style.pointerEvents='auto';checkFrameFocus();
  },
  isHidden(){return !removed&&decoratedHosts().every(transparent);},
  isVisible(){return !removed&&host.isConnected&&doc.defaultView.getComputedStyle(host).display!=='none'&&!transparent(host);},
  remove,
 });
 // 中文注释：iframe 的键盘事件不会冒泡到顶层；拦截期间把子框架焦点移回遮罩。
 function checkFrameFocus(){
  if(!isBlocking())return;
  if(['IFRAME','FRAME'].includes(doc.activeElement?.tagName))host.focus?.({preventScroll:true});
 }
 // 中文注释：状态栏空白区也不能触发网页事件，滚轮和触摸滚动在遮罩上直接阻断。
 for(const type of ['click','dblclick','pointerdown','pointerup','mousedown','mouseup','contextmenu'])host.addEventListener(type,event=>event.stopPropagation());
 for(const type of ['wheel','touchmove'])host.addEventListener(type,event=>{if(currentState!=='paused'){event.preventDefault();event.stopPropagation();}},{passive:false});
 function recover(event){
  if(removed)return;
  if(event?.type==='pageshow')overlay.reblock();
  if(!host.isConnected&&doc.documentElement){doc.documentElement.append(host);overlay.reblock();}
  // 中文注释：document.open 会移除事件监听器，节点恢复时重新安装，重复注册同一函数不会累加。
  for(const type of keyEvents)doc.defaultView?.addEventListener?.(type,blockKeys,{capture:true,passive:false});
  doc.defaultView?.addEventListener?.('blur',checkFrameFocus,true);doc.addEventListener?.('focusin',checkFrameFocus,true);
  doc.defaultView?.addEventListener?.('pageshow',recover);
  checkFrameFocus();
 }
 const Observer=doc.defaultView?.MutationObserver,observer=Observer?new Observer(()=>{if(!host.isConnected)recover();}):null;
 observer?.observe(doc,{childList:true,subtree:true});
 recover();
 return overlay;
}
