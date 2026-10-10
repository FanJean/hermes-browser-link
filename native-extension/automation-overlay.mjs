const states={waiting:'Hermes 正在工作',running:'Hermes 正在工作',pausing:'正在暂停…',paused:'已暂停 · 你可以操作页面',resuming:'正在恢复…',stopping:'正在停止…',stopped:'已停止',disconnected:'与扩展的连接已断开',unknown:'状态待核查'};
const interactionLabels={click:'准备点击',input:'正在输入',select:'正在选择',drag:'正在拖动'};
export const stepLabels=Object.freeze({
 tabs:'读取标签页',new_tab:'打开新标签页',navigate:'打开网页',back:'返回上一页',
 snapshot:'扫描页面',semantic_snapshot:'扫描页面','page.parse':'扫描页面','page.observe':'查看页面结构',frame_catalog:'查看页面框架',
 click:'点击页面',ref_click:'点击页面',fill:'输入内容',ref_fill:'输入内容',press:'按下按键',ref_press:'按下按键',
 ref_set_checked:'设置复选框',ref_select_option:'选择选项',scroll:'滑动页面',screenshot:'截取页面',
 'interaction.capture':'截取页面','interaction.bounds':'查看元素位置','interaction.click':'点击页面',
 'interaction.drag_coordinates':'拖动页面元素','interaction.drag_elements':'拖动页面元素',
 'official.ready_state':'检查页面是否就绪','official.goto_url':'打开网页','official.new_tab':'打开新标签页',
 'files.upload':'选择上传文件','js.evaluate':'执行页面操作','cdp.send':'执行浏览器操作','cdp.events':'查看浏览器事件','cdp.input':'操作页面',
 'network.inspect':'查看网络请求',api_request:'请求网站数据',images:'查看页面图片',console:'查看页面运行记录',dialog:'处理页面对话框',
 popup_catalog:'查看弹出窗口',popup_adopt:'接管弹出窗口','gateway.authorize':'授权浏览器连接','vault.authorize':'授权敏感信息填写','vault.fill':'填写敏感信息',
 use_tab:'切换标签页',
});
const rectOk=r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;
const highlightRectOk=r=>r&&[r.left,r.top,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0&&r.width<=100000&&r.height<=100000;

export function createAutomationOverlay({document:doc=globalThis.document,taskId,generation,tabId,origin,documentId=null,onStop,onTakeover,onResume,commandTimeoutMs=8000}={}){
 if(!doc?.documentElement||doc.location?.origin!==origin||!/^https?:\/\//.test(origin)||!taskId||!Number.isSafeInteger(generation)||generation<1||!Number.isInteger(tabId)||typeof onStop!=='function'||typeof onTakeover!=='function'||typeof onResume!=='function')throw Error('overlay scope denied');
 const host=doc.createElement('div');host.dataset.hermesAutomationOverlay='';host.dataset.hermesOverlayTask=taskId;host.dataset.hermesOverlayGeneration=String(generation);host.setAttribute?.('aria-hidden','false');
 Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'2147483647',pointerEvents:'auto',background:'transparent'});
 const shadow=host.attachShadow({mode:'closed'});
 const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
 const setStyles=(node,values)=>{for(const [key,value] of Object.entries(values))if(node.style[key]!==value)node.style[key]=value;};
 // 中文注释：透明遮罩拦截用户点击；执行页面动作时短暂让出命中测试。
 const veil=doc.createElement('div');veil.dataset.role='veil';veil.setAttribute?.('aria-hidden','true');
 Object.assign(veil.style,{position:'fixed',inset:'0',background:'rgba(13,35,25,.10)',pointerEvents:'none'});
 const border=doc.createElement('div');border.dataset.role='border';border.setAttribute?.('aria-hidden','true');
 Object.assign(border.style,{position:'fixed',inset:'0',border:'2px solid rgba(31,117,75,.55)',boxSizing:'border-box',pointerEvents:'none'});
 const target=doc.createElement('div');target.dataset.role='target';target.setAttribute?.('aria-hidden','true');
 Object.assign(target.style,{position:'fixed',display:'none',border:'2px solid #e59b17',background:'rgba(229,155,23,.12)',boxSizing:'border-box',pointerEvents:'none'});
 // 中文注释：交互高亮加粗、外发光并脉冲闪烁，标签贴在目标旁边，便于实时看清正在操作的模块。
 const pulse=doc.createElement('style');
 pulse.textContent='@keyframes hermes-pulse{0%{box-shadow:0 0 0 0 rgba(255,138,0,.65),0 0 14px rgba(255,138,0,.55)}100%{box-shadow:0 0 0 12px rgba(255,138,0,0),0 0 14px rgba(255,138,0,.55)}}@media(prefers-reduced-motion:reduce){[data-role="virtual-cursor"],[data-role="cursor-hint"]{transition:none!important}[data-role="cursor-ripple"]{transition:opacity 180ms cubic-bezier(.23,1,.32,1)!important;transform:none!important}[data-role="target"],[data-role="drag-start"],[data-role="drag-end"]{animation:none!important}}';
 // 中文注释：扫描只动画 transform 和 opacity；减少动态效果时保留静态边框，取消大幅扫屏位移。
 pulse.textContent+=`@keyframes hermes-scan{from{transform:translateY(-100%)}to{transform:translateY(calc(100vh + 100%))}}
 [data-role="parsing-beam"]{animation:hermes-scan 1400ms linear infinite}
 [data-role="parsing-elements"]{transition:opacity 220ms cubic-bezier(.23,1,.32,1)}
 @media(prefers-reduced-motion:reduce){[data-role="parsing-beam"]{animation:none;opacity:.35;transform:none}[data-role="parsing-elements"]{transition:none}}`;
 const parsingScan=doc.createElement('div');parsingScan.dataset.role='parsing-scan';parsingScan.setAttribute('aria-hidden','true');
 Object.assign(parsingScan.style,{position:'fixed',inset:'0',display:'block',opacity:'0',overflow:'hidden',pointerEvents:'none',boxShadow:'inset 0 0 28px rgba(75,210,145,.16)'});
 const parsingBeam=doc.createElement('div');parsingBeam.dataset.role='parsing-beam';
 Object.assign(parsingBeam.style,{position:'absolute',top:'0',left:'0',width:'100%',height:'96px',background:'linear-gradient(180deg,transparent,rgba(75,210,145,.05) 65%,rgba(75,210,145,.18))',borderBottom:'1px solid rgba(108,238,173,.8)',boxSizing:'border-box',pointerEvents:'none',animationPlayState:'paused'});parsingScan.append(parsingBeam);
 const parsingElements=doc.createElement('div');parsingElements.dataset.role='parsing-elements';parsingElements.setAttribute('aria-hidden','true');
 Object.assign(parsingElements.style,{position:'fixed',inset:'0',display:'none',opacity:'0',pointerEvents:'none'});
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
 // 中文注释：任务鼠标只动画 transform，240ms 加减速位移可从当前屏幕位置连续衔接新目标。
 const cursorMotion='transform 240ms cubic-bezier(0.77,0,0.175,1)';
 Object.assign(cursor.style,{position:'fixed',left:'0',top:'0',display:'none',width:'12px',height:'18px',background:'#fff',border:'2px solid #143b29',clipPath:'polygon(0 0,0 100%,35% 75%,60% 100%,75% 90%,48% 65%,100% 65%)',filter:'drop-shadow(0 1px 2px #0008)',pointerEvents:'none',transition:cursorMotion,zIndex:'3'});
 const cursorHint=doc.createElement('div');cursorHint.dataset.role='cursor-hint';cursorHint.setAttribute('aria-hidden','true');
 Object.assign(cursorHint.style,{position:'fixed',left:'0',top:'0',display:'none',padding:'2px 5px',borderRadius:'4px',background:'#163a2a',color:'#fff',font:'11px system-ui',pointerEvents:'none',transition:cursorMotion,zIndex:'3'});
 const ripple=doc.createElement('div');ripple.dataset.role='cursor-ripple';ripple.setAttribute('aria-hidden','true');
 Object.assign(ripple.style,{position:'fixed',display:'none',width:'26px',height:'26px',border:'2px solid #ff8a00',borderRadius:'50%',pointerEvents:'none',zIndex:'2',opacity:'0',transition:'opacity 180ms cubic-bezier(.23,1,.32,1),transform 180ms cubic-bezier(.23,1,.32,1)'});
 const bar=doc.createElement('div');bar.dataset.role='status';
 // 中文注释：窄窗口下将内边距计入现有宽度限制，避免解析状态栏超出视口。
 // 中文注释：控制卡片放右下角；谷歌 One Tap / FedCM 等登录框固定在右上角，放在上面会盖住“接管页面”按钮。
 Object.assign(bar.style,{position:'fixed',bottom:'16px',right:'16px',width:'min(342px,calc(100vw - 32px))',boxSizing:'border-box',padding:'14px 16px',border:'1px solid rgba(255,255,255,.16)',borderRadius:'14px',background:'#172a20',color:'#fff',font:'13px/1.45 system-ui,sans-serif',boxShadow:'0 12px 35px rgba(0,0,0,.22)',pointerEvents:'auto'});
 const eyebrow=doc.createElement('div');eyebrow.textContent='HERMES · 浏览器任务';Object.assign(eyebrow.style,{fontSize:'10px',letterSpacing:'.09em',color:'#a9c9b6',marginBottom:'6px'});bar.append(eyebrow);
 const label=doc.createElement('div');label.textContent=states.waiting;Object.assign(label.style,{fontSize:'15px',fontWeight:'650'});bar.append(label);
 const detail=doc.createElement('div');detail.textContent='页面暂不可点击 · Ctrl+Alt+Shift+F12 接管';Object.assign(detail.style,{fontSize:'12px',color:'#bfd0c4',marginTop:'3px'});bar.append(detail);
 const actions=doc.createElement('div');actions.dataset.role='actions';Object.assign(actions.style,{display:'flex',gap:'8px',marginTop:'12px'});bar.append(actions);
 const recent=doc.createElement('details');Object.assign(recent.style,{marginTop:'8px',fontSize:'11px'});
 const recentTitle=doc.createElement('summary');recentTitle.textContent='最近步骤';recent.append(recentTitle);
 const recentList=doc.createElement('ol');Object.assign(recentList.style,{paddingLeft:'18px',margin:'6px 0 0'});recent.append(recentList);bar.append(recent);
 let recentRows=[],waitingTextTimer=null;
 const waitingDetail='页面暂不可点击 · Ctrl+Alt+Shift+F12 接管';
 const roleLabels={button:'按钮',textbox:'输入框',searchbox:'搜索框',link:'链接',checkbox:'复选框',combobox:'下拉框',listbox:'下拉框',option:'选项',tab:'标签',menuitem:'菜单项',menuitemcheckbox:'菜单复选框',menuitemradio:'菜单单选项',radio:'单选框',switch:'开关',slider:'滑块',spinbutton:'数字输入框',treeitem:'树形项目'};
 function describeStep(row){
  const action=row.action,label=Object.hasOwn(stepLabels,action)?stepLabels[action]:'处理页面';
  const target=typeof row.target==='string'?row.target.slice(0,80):'',separator=target.indexOf(' · ');
  const role=separator<0?'':target.slice(0,separator),rawName=separator<0?'':target.slice(separator+3).trim();
  const sensitive=target==='敏感字段'||rawName==='敏感字段';
  const name=rawName&&rawName!=='名称未提供'&&!sensitive?`「${rawName}」`:'';
  const roleLabel=Object.hasOwn(roleLabels,role)?roleLabels[role]:'';
  const object=name+(roleLabel||'元素');
  if(['fill','ref_fill','vault.fill'].includes(action))return sensitive||action==='vault.fill'?'填写敏感信息':`在${name||roleLabel||'输入框'}输入内容`;
  if(['click','ref_click','interaction.click'].includes(action))return separator>=0?`点击${object}`:label;
  if(action==='ref_set_checked')return `设置${name+(roleLabel||'复选框')}`;
  if(action==='ref_select_option')return ['combobox','listbox'].includes(role)?`在${name}${roleLabel}选择选项`:name?`选择${name}`:label;
  return label;
 }
 host.tabIndex=-1;
 let removed=false,busy=false,hideDepth=0,hiddenHosts=null,activeHighlightToken=null,inputWindowTimer=null,inputWindowOpen=false,currentState='waiting',cursorTimer=null,dragTimer=null,cursorOperationToken=null,dragAtEnd=false,dragEndPoint=null,commandTimer=null,commandAbort=null,lastCommand=null;
 let cursorPoint={x:24,y:24};
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
 shadow.append(veil,border,target,parsingScan,parsingElements,interactionTarget,dragStart,dragEnd,interactionStatus,cursor,cursorHint,ripple,bar,pulse);doc.documentElement.append(host);
 const parsingSteps=new Set(['snapshot','semantic_snapshot','page.parse','page.observe','frame_catalog']);
 const parsingFeedbackDelayMs=120;
 let parsingStep=null,parsingStartTimer=null,parsingTimer=null,parsingFadeTimer=null;
 // 中文注释：元素反馈与扫描分别清理，旧元素淡出不能销毁下个读取使用的动画。
 function clearParsedElements(){
  clearTimeout(parsingTimer);clearTimeout(parsingFadeTimer);parsingTimer=parsingFadeTimer=null;
  setStyles(parsingElements,{display:'none',opacity:'0'});if(parsingElements.children.length)parsingElements.replaceChildren();
 }
 function pauseParsingScan(){setStyles(parsingScan,{opacity:'0'});setStyles(parsingBeam,{animationPlayState:'paused'});}
 function clearParsing(){
  clearTimeout(parsingStartTimer);parsingStartTimer=null;parsingStep=null;
  pauseParsingScan();clearParsedElements();
 }
 function syncParsing(state,step){
  if(state==='running'&&parsingSteps.has(step)){
   if(parsingStep!==step){
    // 中文注释：解析类型切换只清除旧元素反馈；保留光带与启动计时，避免动画反复从头播放。
    clearParsedElements();parsingStep=step;
   }
   // 中文注释：短读取与等待轮询不启动光带，反馈定时器不阻塞实际解析或授权检查。
   if(parsingScan.style.opacity!=='1'&&parsingStartTimer===null)parsingStartTimer=setTimeout(()=>{
    parsingStartTimer=null;if(!removed&&currentState==='running'&&parsingStep){parsingScan.style.opacity='1';parsingBeam.style.animationPlayState='running';}
   },parsingFeedbackDelayMs);
   return;
  }
  if(state==='waiting'&&parsingStep){
   clearTimeout(parsingStartTimer);parsingStartTimer=null;
   // 中文注释：每个真实动作都经过 waiting；隐藏并暂停同一个动画，下次解析只续播。
   parsingStep=null;pauseParsingScan();
   if(parsingElements.children.length){
    parsingTimer=setTimeout(()=>{parsingTimer=null;parsingElements.style.opacity='0';parsingFadeTimer=setTimeout(clearParsedElements,220);},600);return;
   }
  }
  clearParsing();
 }
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
 // 中文注释：等待模型下一步也属于任务执行；接管或连接未知时不显示模型指针。
 const cursorVisible=()=>!removed&&['waiting','running','pausing','resuming'].includes(currentState)&&doc.visibilityState!=='hidden';
 function cancelCursorMotion(){
  clearTimeout(cursorTimer);clearTimeout(dragTimer);cursorTimer=null;dragTimer=null;cursorOperationToken=null;dragAtEnd=false;
  setStyles(cursorHint,{display:'none'});setStyles(ripple,{display:'none'});
 }
 function moveCursor(point){
  const view=doc.defaultView;
  cursorPoint={x:Math.min(Math.max(0,point.x),Math.max(0,view.innerWidth-12)),y:Math.min(Math.max(0,point.y),Math.max(0,view.innerHeight-18))};
  cursor.style.transform=`translate(${cursorPoint.x}px,${cursorPoint.y}px)`;
  cursorHint.style.transform=`translate(${cursorPoint.x+14}px,${cursorPoint.y+12}px)`;
 }
 function syncCursor(){
  setStyles(cursor,{display:cursorVisible()?'block':'none'});
  if(!cursorVisible())cancelCursorMotion();
 }
 function resizeCursor(){moveCursor(cursorPoint);syncCursor();}
 doc.addEventListener?.('visibilitychange',syncCursor);
 doc.defaultView?.addEventListener?.('resize',resizeCursor);
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
   syncCursor();
   if(cursorVisible()){
    const point=request.point&&Number.isFinite(request.point.x)&&Number.isFinite(request.point.y)?request.point:
     {x:anchor.left+anchor.width/2,y:anchor.top+anchor.height/2};
    const newOperation=cursorOperationToken!==request.operationToken;
    if(newOperation){cancelCursorMotion();cursorOperationToken=request.operationToken;}
    cursorHint.style.display=request.kind==='input'?'block':'none';cursorHint.textContent=request.kind==='input'?'⌨ 输入中':'';
    if(request.kind!=='drag')moveCursor(point);
    // 中文注释：高亮每帧校准不重复启动点击反馈，旧操作的延迟回调不能作用于新目标。
    if(request.kind==='click'&&newOperation)cursorTimer=setTimeout(()=>{cursorTimer=null;if(activeHighlightToken!==request.operationToken||!cursorVisible())return;
     Object.assign(ripple.style,{display:'block',left:`${cursorPoint.x-13}px`,top:`${cursorPoint.y-13}px`,opacity:'1',transform:'scale(.4)'});
     doc.defaultView?.requestAnimationFrame?.(()=>{if(activeHighlightToken===request.operationToken&&cursorVisible())Object.assign(ripple.style,{opacity:'0',transform:'scale(1.5)'});});
    },240);
    if(request.kind==='drag'&&request.rects.length===2){const start=request.rects[0],end=request.rects[1];
     dragEndPoint={x:end.left+end.width/2,y:end.top+end.height/2};
     if(newOperation){moveCursor({x:start.left+start.width/2,y:start.top+start.height/2});
      // 中文注释：先移到拖动起点再移向终点，重复绘制不会把鼠标拉回起点。
      dragTimer=setTimeout(()=>{dragTimer=null;if(activeHighlightToken!==request.operationToken||!cursorVisible())return;dragAtEnd=true;moveCursor(dragEndPoint);},240);
     }else if(dragAtEnd)moveCursor(dragEndPoint);
    }
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
   activeHighlightToken=null;host.removeAttribute('data-hermes-interaction-highlight');cancelCursorMotion();
   interactionTarget.style.display='none';dragStart.style.display='none';dragEnd.style.display='none';interactionStatus.style.display='none';interactionStatus.textContent='';
   syncCursor();
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
  removed=true;clearTimeout(waitingTextTimer);waitingTextTimer=null;clearParsing();cancelCursorMotion();cursor.style.display='none';clearTimeout(commandTimer);commandTimer=null;commandAbort?.abort();commandAbort=null;observer?.disconnect();doc.defaultView?.removeEventListener?.('pageshow',recover);doc.defaultView?.removeEventListener?.('blur',checkFrameFocus,true);doc.removeEventListener?.('focusin',checkFrameFocus,true);doc.removeEventListener?.('visibilitychange',syncCursor);doc.defaultView?.removeEventListener?.('resize',resizeCursor);hiddenHosts=null;hideDepth=0;clearTimeout(inputWindowTimer);inputWindowTimer=null;host.remove();
  for(const type of keyEvents)doc.defaultView?.removeEventListener?.(type,blockKeys,true);
 }
 // 中文注释：清理事件只能本地卸载浮层；即使网页主动触发，也不能授予任务权限或伪造暂停。
 host.addEventListener('hermes-overlay-release',remove);
 const overlay=Object.freeze({
  host,interactionSurface,hide,restore,
  // 中文注释：只接收语义解析回执的矩形，不读取字段值、不展示网页文字，最多标出 24 个视口内元素。
  showParsedElements(rects){
   if(removed||currentState!=='running'||!parsingStep||!Array.isArray(rects))return false;
   const view=doc.defaultView;
   const visible=rects.filter(r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0&&r.x+r.width>0&&r.y+r.height>0&&r.x<view.innerWidth&&r.y<view.innerHeight).slice(0,24);
   parsingElements.replaceChildren(...visible.map(r=>{
    const box=doc.createElement('div');box.dataset.role='parsed-element';
    const left=Math.max(0,r.x),top=Math.max(0,r.y);
    Object.assign(box.style,{position:'fixed',left:`${left}px`,top:`${top}px`,width:`${Math.min(view.innerWidth,r.x+r.width)-left}px`,height:`${Math.min(view.innerHeight,r.y+r.height)-top}px`,border:'1px solid rgba(93,225,158,.9)',borderRadius:'4px',background:'rgba(75,210,145,.045)',boxShadow:'0 0 8px rgba(75,210,145,.14)',boxSizing:'border-box',pointerEvents:'none'});
    return box;
   }));
   parsingElements.style.display=visible.length?'block':'none';parsingElements.style.opacity='1';return true;
  },
  setRecentSteps(steps){
   // 中文注释：只接收守护进程的脱敏步骤字段，错误码映射为固定说明。
   if(removed||!Array.isArray(steps))return;
   const explanations={task_paused:'用户已接管页面',element_timeout:'目标未在期限内出现',target_occluded:'目标被其他元素遮挡',
    scroll_timeout:'滚动结果尚未确认',stale_ref:'页面引用已失效',document_changed:'文档已变化',
    stale_reference:'页面引用已失效，请重新解析并核对当前状态',select_option_missing:'未找到指定选项，请重新读取选项列表',
    invalid_target_state:'控件状态无法核验，请核对实际状态，不要直接重试',
    execution_denied:'安全检查未通过，请核对目标和授权',
    content_shield_uninspectable:'页面有无法检查的框架或封闭组件，本次操作已拒绝，请人工核对',
    content_shield_changed:'操作期间页面保护状态发生变化，请核对实际结果，不要重复提交',
    content_shield_unavailable:'页面内容保护状态无法确认，请检查扩展连接和设置',
    content_shield_unsupported:'此操作不支持当前内容保护模式',
    origin_denied:'目标网站不在任务授权范围',permission_denied:'浏览器权限不足',instance_unavailable:'浏览器已断开'};
   const available=[...recentRows];
   const next=steps.slice(-5).map(row=>{
    const state=typeof row.result==='string'?row.result:'';
    // 中文注释：结果未知仍显示未知；原因独立展示，任意页面异常文字不作为错误码输出。
    const reason=state==='unknown'||state==='failed'?row.errorCode:state;
    const code=typeof reason==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(reason)?reason:'';
    const failed=state!=='succeeded'&&state!=='pending';
    const time=new Date(row.time),localTime=Number.isFinite(time.getTime())?[time.getHours(),time.getMinutes(),time.getSeconds()].map(value=>String(value).padStart(2,'0')).join(':'):'';
    const duration=Number(row.durationMs);
    let text=`${describeStep(row)} · ${state==='succeeded'?'成功':state==='pending'?'等待确认':state==='unknown'?'结果不确定':'失败'}`;
    if(failed){
     const readChanged=code==='content_shield_changed'&&['snapshot','semantic_snapshot','page.parse','page.observe','official.ready_state','frame_catalog'].includes(row.action);
     const explanation=readChanged?'读取期间页面或保护状态发生变化，本次未返回内容，请重新读取':Object.hasOwn(explanations,code)?explanations[code]:'请核对页面状态，不要重复提交';
     text+=`（${explanation}）`;
    }
    if(localTime)text+=` · ${localTime}`;
    if(Number.isFinite(duration)&&duration>1000)text+=` · 用时 ${(duration/1000).toFixed(1)} 秒`;
    const title=failed?code:'',key=JSON.stringify([text,title]);
    const index=available.findIndex(entry=>entry.key===key);
    if(index>=0)return available.splice(index,1)[0];
    const item=doc.createElement('li');item.textContent=text;item.title=title;
    if(failed)item.style.color='#ffaaa2';
    return {key,item};
   });
   // 中文注释：滚动的五步窗口复用未变化行；相同回执不触碰列表，保留展开状态和节点。
   for(const {item} of available)item.remove();
   next.forEach(({item},index)=>{if(recentList.children[index]!==item)recentList.insertBefore(item,recentList.children[index]||null);});
   recentRows=next;
  },
  update({state,step='',targetRect,holdMs,scrollDirection}={}){
   if(removed)return;
   if(state==='stopped'){remove();return;}
   clearTimeout(inputWindowTimer);inputWindowTimer=null;currentState=state;
   syncParsing(state,step);
   const recovery=state==='disconnected'||state==='unknown';
   for(const node of [release,retry])setStyles(node,{display:recovery?'inline-block':'none'});
   if(retry.disabled!==!lastCommand)retry.disabled=!lastCommand;
   setStyles(stop,{display:recovery?'none':'inline-block'});
   setText(label,state==='pausing'?'等待当前步骤结束…':states[state]||states.unknown);
   // 中文注释：只延迟等待文案；权限状态、派发窗口与接管提示仍即时更新。轮询不延长等待期限。
   if(state==='waiting'&&detail.textContent.startsWith('当前步骤：')){
    if(waitingTextTimer===null)waitingTextTimer=setTimeout(()=>{waitingTextTimer=null;if(!removed&&currentState==='waiting')setText(detail,waitingDetail);},400);
   }else{
    clearTimeout(waitingTextTimer);waitingTextTimer=null;
    setText(detail,recovery?'放开页面仅恢复本地输入，不代表任务已暂停；请核查任务状态':state==='paused'?'页面操作权已交给你':state==='running'&&step?`当前步骤：${Object.hasOwn(stepLabels,step)?stepLabels[step]:'处理页面'} · Ctrl+Alt+Shift+F12 接管`:waitingDetail);
   }
   // 中文注释：遮罩一直拦截用户点击和键盘，直到用户点“接管页面”；普通模式只在页面动作派发时放行，
   // 原始 CDP 只在输入派发的短窗口内放行，窗口到期由页面内计时器自行恢复拦截。
   const dispatching=['click','fill','press','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option','interaction.click','interaction.drag_coordinates','interaction.drag_elements','scroll'];
   const scriptInput=state==='running'&&step==='cdp.input';
   // 中文注释：派发瞬间状态栏及按钮也临时放行，否则位于栏下的页面目标被判为遮挡，指针点击也会落在栏上。
   const passThrough=state==='running'&&dispatching.includes(step)||scriptInput;
   inputWindowOpen=passThrough;setStyles(host,{pointerEvents:state==='paused'||passThrough?'none':'auto'});
   if(passThrough){
    const windowMs=Number.isInteger(holdMs)&&holdMs>0?Math.min(holdMs,10000):scriptInput?600:5000;
    inputWindowTimer=setTimeout(()=>{inputWindowTimer=null;overlay.reblock();},windowMs);
   }
   for(const node of [bar,...controls])setStyles(node,{pointerEvents:passThrough?'none':'auto'});
   if(!passThrough&&state!=='paused')checkFrameFocus();
   for(const node of [veil,border])setStyles(node,{display:state==='paused'?'none':'block'});
   setStyles(takeover,{display:state==='paused'||recovery?'none':'inline-block'});setStyles(resume,{display:state==='paused'?'inline-block':'none'});
   if(rectOk(targetRect)){setStyles(target,{display:'block',left:`${targetRect.x}px`,top:`${targetRect.y}px`,width:`${targetRect.width}px`,height:`${targetRect.height}px`});}
   else setStyles(target,{display:'none'});
   syncCursor();
   if(cursorVisible()&&state==='running'&&step==='scroll'){
    setText(cursorHint,scrollDirection==='up'?'↑ 向上滚动':'↓ 向下滚动');setStyles(cursorHint,{display:'block'});
   }else if(!activeHighlightToken)setStyles(cursorHint,{display:'none'});
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
   clearParsing();
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
 moveCursor(cursorPoint);syncCursor();
 recover();
 return overlay;
}
