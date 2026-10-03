// Screenshot-coordinate bridge. No vision model; no authorization bypass.
export class InteractionError extends Error {
  constructor(code) { super(code); this.name='InteractionError'; this.code=code; }
}
const fail=code=>{throw new InteractionError(code);};
const copy=value=>structuredClone(value);
function pageOperation(op,arg={}) {
  const isOverlay=node=>{for(let n=node;n;n=n.parentNode||n.host)if(n.nodeType===1&&n.hasAttribute?.('data-hermes-automation-overlay'))return true;return false;};
  const realMutation=r=>r.type==='childList' ? !isOverlay(r.target)&&([...(r.addedNodes||[]),...(r.removedNodes||[])].some(n=>!isOverlay(n))) : !isOverlay(r.target);
  let s=globalThis.__hermesInteractions;
  if(!s || s.document!==document) {
    s=globalThis.__hermesInteractions={document,token:crypto.getRandomValues(new Uint32Array(4)).join('-'),revision:0,nodes:new Map()};
    s.observer=new MutationObserver(records=>{if(records.some(realMutation))s.revision++;});
    s.observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  }
  if(s.observer.takeRecords().some(realMutation)) s.revision++;
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const clearProbe=()=>{
    if(!s.probe)return;
    for(const type of ['pointerdown','mousedown','click','pointerup']){
      window.removeEventListener(type,s.probe.globalListener,true);
      s.probe.node.removeEventListener(type,s.probe.targetListener,true);
    }
    s.probe=null;
  };
  if(op==='probe')return s.probe?{global:{...s.probe.global},target:{...s.probe.target}}:{error:'INPUT_PROBE_MISSING'};
  if(op==='clear-probe'){clearProbe();return {ok:true};}
  if(op==='arm-probe'){
    const item=s.nodes.get(arg.ref);if(!item?.e.isConnected)return {error:'INVALID_NODE_REF'};
    clearProbe();
    const probe={node:item.e,global:{pointerdown:0,mousedown:0,click:0,pointerup:0},target:{pointerdown:0,mousedown:0,click:0,trustedClick:0}};
    probe.globalListener=event=>{probe.global[event.type]++;};
    probe.targetListener=event=>{probe.target[event.type]++;if(event.type==='click'&&event.isTrusted)probe.target.trustedClick++;};
    for(const type of ['pointerdown','mousedown','click','pointerup']){
      window.addEventListener(type,probe.globalListener,true);
      item.e.addEventListener(type,probe.targetListener,true);
    }
    s.probe=probe;return {ok:true};
  }
  if(op==='html5') {
    const check=endpoint=>pageOperation('check',endpoint);
    for(const endpoint of [arg.from,arg.to]) {const c=check(endpoint);if(c.error)return c;}
    const source=s.nodes.get(arg.from.ref).e,target=s.nodes.get(arg.to.ref).e;
    if(!source.draggable)return {error:'NOT_HTML5_DRAGGABLE'};
    const dataTransfer=new DataTransfer();
    const emit=(node,type,p)=>node.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,dataTransfer}));
    if(!emit(source,'dragstart',arg.from))return {error:'DRAGSTART_CANCELLED'};
    try {
      // Site handlers can mutate synchronously: re-hit-test before every target event.
      for(const type of ['dragenter','dragover','drop']) {
        const c=check(arg.to);if(c.error)return c;
        const allowed=emit(target,type,arg.to);
        if(type==='dragover'&&allowed)return {error:'DROP_NOT_ACCEPTED'};
      }
      return {ok:true,kind:'html5-synthetic',trusted:false};
    } finally {emit(source,'dragend',arg.to);}
  }
  if(op==='check') {
    const item=s.nodes.get(arg.ref); if(!item||!item.e.isConnected) return {error:'INVALID_NODE_REF'};
    const e=item.e;let hit=document.elementsFromPoint(arg.x,arg.y).find(node=>!isOverlay(node));
    // Fail closed on all editable fields, embeds and shadow hosts, not just passwords.
    const sensitive=node=>!!node && (!!node.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[autocomplete],iframe,object,embed,[data-sensitive]')||!!node.shadowRoot);
    if(sensitive(e)||sensitive(hit)) return {error:'SENSITIVE_TARGET'};
    if(arg.coveringRef) {
      const covering=s.nodes.get(arg.coveringRef)?.e;
      if(covering && hit && (hit===covering||covering.contains(hit))) {
        hit=document.elementsFromPoint(arg.x,arg.y).find(node=>!isOverlay(node)&&node!==covering&&!covering.contains(node));
        if(sensitive(hit))return {error:'SENSITIVE_TARGET'};
      }
    }
    // 中文注释：隐藏页无法命中时仍限定已绑定截图引用；命中其他真实元素则拒绝。
    if((!hit&&!(arg.allowHiddenHitUnavailable&&document.visibilityState==='hidden'))||hit&&(hit!==e&&!e.contains(hit))) return {error:'TARGET_OCCLUDED'};
    if(JSON.stringify(rect(e))!==JSON.stringify(item.rect)) return {error:'NODE_MOVED'};
    if(e.matches(':disabled')||getComputedStyle(e).visibility!=='visible'||Number(getComputedStyle(e).opacity)===0) return {error:'TARGET_NOT_ACTIONABLE'};
    return {ok:true};
  }
  if(op==='synthetic-click'){
    const checked=pageOperation('check',arg);if(checked.error)return checked;
    const item=s.nodes.get(arg.ref);let count=0;
    const received=()=>count++;
    item.e.addEventListener('click',received,true);
    try{item.e.click();}finally{item.e.removeEventListener('click',received,true);}
    return {ok:count>0,kind:'dom-synthetic',delivery:count>0?'confirmed':'unconfirmed',
      fallbackReason:arg.fallbackReason,...(count>0?{}:{outcomeUnknown:true})};
  }
  // 中文注释：新截图不再使用旧引用，读取状态时同步释放页面侧节点，避免长任务累积。
  if(op==='state') {if(arg.resetRefs===true)s.nodes.clear();return {token:s.token,revision:s.revision,url:location.href,visibility:document.visibilityState,viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,scroll:{x:scrollX,y:scrollY},visual:{scale:visualViewport.scale,x:visualViewport.offsetLeft,y:visualViewport.offsetTop}};}
  if(op==='bounds') {
    const es=[...document.querySelectorAll(arg.selector)].filter(e=>!isOverlay(e));
    if(es.length!==1) return {error:'SELECTOR_NOT_UNIQUE'};
    const e=es[0],r=rect(e),id=crypto.getRandomValues(new Uint32Array(4)).join('-');s.nodes.set(id,{e,rect:r});
    // 中文注释：与宿主同样最多保留 256 个坐标引用，淘汰后明确拒绝旧引用。
    while(s.nodes.size>256)s.nodes.delete(s.nodes.keys().next().value);
    return {ref:id,rect:r};
  }
}
export function createCDPAdapter(send) {
  let isolatedContext;
  const world='hermes-interactions-'+crypto.getRandomValues(new Uint32Array(4)).join('-');
  return {
    send,
    async evaluate(op,arg) {
      const {frameTree}=await send('Page.getFrameTree');
      const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:world});
      isolatedContext=executionContextId;
      const r=await send('Runtime.evaluate',{expression:`(${pageOperation.toString()})(${JSON.stringify(op)},${JSON.stringify(arg||{})})`,contextId:executionContextId,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails) fail('PAGE_EVALUATION_FAILED');
      return {...r.result.value,documentId:frameTree.frame.loaderId+':'+r.result.value?.token};
    },
    async verifyHit(point,{allowOpenShadow=false,allowClosedShadow=false}={}) {
      const state=await this.evaluate('state');
      // DOM.getNodeForLocation uses document CSS coordinates; Input uses viewport CSS.
      // 中文注释：只命中网页元素，不进入浏览器内部密码控件；网页封闭 Shadow Root 仍由下方复核拒绝。
      const hit=await send('DOM.getNodeForLocation',{x:Math.floor(point.x+state.scroll.x),y:Math.floor(point.y+state.scroll.y),includeUserAgentShadowDOM:false});
      const {object}=await send('DOM.resolveNode',{backendNodeId:hit.backendNodeId,executionContextId:isolatedContext});
      try {
        const r=await send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(allowOpenShadow,allowClosedShadow){const root=this.getRootNode();return !!this.closest?.("[data-hermes-automation-overlay]") || !!root.host?.hasAttribute("data-hermes-automation-overlay") || (root instanceof ShadowRoot && !(root.mode==="open"?allowOpenShadow:allowClosedShadow));}',arguments:[{value:allowOpenShadow},{value:allowClosedShadow}],returnByValue:true});
        if(r.exceptionDetails) fail('HIT_RECHECK_FAILED');
        if(r.result.value) fail('UNSUPPORTED_SHADOW_DOM');
      } finally {await send('Runtime.releaseObject',{objectId:object.objectId});}
    },
    async screenshot() {return (await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})).data;},
  };
}
export function createChromeDebuggerAdapter(debuggerAPI,{tabId,sessionId=null}) {
  if(!Number.isSafeInteger(tabId)||tabId<0) fail('INVALID_TAB');
  if(sessionId!==null&&(typeof sessionId!=='string'||!sessionId))fail('INVALID_SESSION');
  // 中文注释：跨进程 iframe 的 CDP 子会话与任务标签页一起固定，不接受调用方改写 target。
  const target=Object.freeze(sessionId?{tabId,sessionId}:{tabId});let detached=false;
  const onDetach=source=>{if(source.tabId===tabId) detached=true;};
  debuggerAPI.onDetach.addListener(onDetach);
  const adapter=createCDPAdapter(async(method,params={})=>{
    if(detached) fail('ADAPTER_DETACHED');
    return debuggerAPI.sendCommand(target,method,params);
  });
  // Caller owns attach/detach and task authorization; close only releases our listener.
  adapter.close=()=>{detached=true;debuggerAPI.onDetach.removeListener(onDetach);};
  return adapter;
}
export async function createPlaywrightAdapter(page) {
  const session=await page.context().newCDPSession(page);
  const adapter=createCDPAdapter((method,params)=>session.send(method,params));
  adapter.screenshot=async()=> (await page.screenshot({type:'png',fullPage:false,scale:'device',caret:'initial'})).toString('base64');
  adapter.close=()=>session.detach();return adapter;
}
export class Interactions {
  #adapter; #binding; #shots=new Map(); #refs=new Map(); #busy=false; #ttl; #now;
  constructor(adapter,{taskId,generation,ttlMs=5000,now=()=>performance.now()}) {
    if(typeof taskId!=='string'||!taskId||!Number.isSafeInteger(generation)||generation<0||!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>60000) fail('INVALID_BINDING');
    this.#adapter=adapter;this.#binding={taskId,generation};this.#ttl=ttlMs;this.#now=now;
  }
  async #exclusive(fn) {
    if(this.#busy) fail('INTERACTION_BUSY');this.#busy=true;
    try {return await fn();} finally {this.#busy=false;}
  }
  capture(r) {return this.#exclusive(()=>this.#capture(r));}
  bounds(r) {return this.#exclusive(()=>this.#bounds(r));}
  clickCoordinates(r) {return this.#exclusive(()=>this.#clickCoordinates(r));}
  clickBoundTarget(r,{readTarget,guard=()=>{}}={}) {return this.#exclusive(()=>this.#clickBoundTarget(r,readTarget,guard));}
  dragCoordinates(r) {return this.#exclusive(()=>this.#dragCoordinates(r));}
  dragElements(r) {return this.#exclusive(()=>this.#dragElements(r));}
  #scope(r) {if(r.taskId!==this.#binding.taskId||r.generation!==this.#binding.generation) fail('SCOPE_MISMATCH');}
  async #capture(r) {
    this.#scope(r);
    // 中文注释：截图尝试开始即同步作废宿主与页面侧引用，失败也不恢复已清除的旧句柄。
    this.#shots.clear();this.#refs.clear();
    const before=await this.#adapter.evaluate('state',{resetRefs:true});
    if(before.visual.scale!==1||before.visual.x||before.visual.y) fail('UNSUPPORTED_VISUAL_VIEWPORT');
    const data=await this.#adapter.screenshot();
    const after=await this.#adapter.evaluate('state');
    if(JSON.stringify(before)!==JSON.stringify(after)) fail('CAPTURE_CHANGED');
    const bytes=Uint8Array.from(atob(data.slice(0,44)),c=>c.charCodeAt(0));
    const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
    if(Math.abs(width-before.viewport.width*before.dpr)>1||Math.abs(height-before.viewport.height*before.dpr)>1) fail('IMAGE_GEOMETRY_MISMATCH');
    const shot={id:crypto.getRandomValues(new Uint32Array(4)).join('-'),...this.#binding,...before,image:{width,height,data,mimeType:'image/png'},createdAt:this.#now(),expiresInMs:this.#ttl};
    this.#shots.clear();this.#refs.clear();this.#shots.set(shot.id,shot);return copy(shot);
  }
  async #validate(r) {
    this.#scope(r);const shot=this.#shots.get(r.screenshotId);if(!shot) fail('UNKNOWN_SCREENSHOT');
    await this.#guard(shot);return shot;
  }
  async #guard(shot,allowMutation=false) {
    if(this.#now()-shot.createdAt>=this.#ttl) fail('SCREENSHOT_EXPIRED');
    const state=await this.#adapter.evaluate('state');
    for(const key of ['documentId','token','revision','url','viewport','dpr','scroll','visual']) if(!(allowMutation&&key==='revision')&&JSON.stringify(state[key])!==JSON.stringify(shot[key])) fail('STALE_SCREENSHOT');
    return shot;
  }
  #point(shot,p) {
    if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>=shot.image.width||p.y>=shot.image.height) fail('INVALID_COORDINATES');
    return {x:p.x/shot.dpr,y:p.y/shot.dpr};
  }
  async #check(point,ref,coveringRef,{hidden=false}={}) {
    if(!this.#refs.has(ref)) fail('INVALID_NODE_REF');
    const v=await this.#adapter.evaluate('check',{...point,ref,coveringRef,allowHiddenHitUnavailable:hidden});if(v.error) fail(v.error);
    if(!hidden)await this.#adapter.verifyHit(point);
  }
  async #deliveryProbe(kind){
    let observed;
    for(let attempt=0;attempt<4;attempt++){
      observed=await this.#adapter.evaluate('probe');
      if(observed.error)fail(observed.error);
      if(kind==='click'?observed.target.trustedClick:observed.target.pointerdown&&observed.global.pointerup)break;
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    return observed;
  }
  async #clickCoordinates(r) {
    const shot=await this.#validate(r),point=this.#point(shot,r.point);
    // 中文注释：工作窗口切前台仅改变可见性，不使同文档且几何未变的截图引用失效。
    const hidden=(await this.#adapter.evaluate('state')).visibility==='hidden';
    await this.#check(point,r.expectedRef,null,{hidden});await this.#validate(r);
    this.#shots.delete(shot.id);
    await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await this.#guard(shot);await this.#check(point,r.expectedRef,null,{hidden});
    const armed=await this.#adapter.evaluate('arm-probe',{ref:r.expectedRef});if(armed.error)fail(armed.error);
    try{
      try {await this.#adapter.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});}
      finally {await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});}
      const observed=await this.#deliveryProbe('click');
      if(observed.target.trustedClick)return {ok:true,kind:'coordinate-click',delivery:'confirmed'};
      if(!observed.global.pointerdown&&!observed.global.mousedown&&!observed.global.click){
        const synthetic=await this.#adapter.evaluate('synthetic-click',{...point,ref:r.expectedRef,allowHiddenHitUnavailable:hidden,fallbackReason:'pointer_input_not_delivered'});
        return synthetic.error?{ok:false,kind:'coordinate-click',delivery:'unconfirmed',outcomeUnknown:true}:synthetic;
      }
      return {ok:false,kind:'coordinate-click',delivery:'partial',outcomeUnknown:true};
    }finally{await this.#adapter.evaluate('clear-probe').catch(()=>{});}
  }
  async #clickBoundTarget(r,readTarget,guard) {
    this.#scope(r);
    if(typeof readTarget!=='function'||typeof guard!=='function')fail('INVALID_TARGET_READER');
    let point;
    try{point=await this.#boundTargetPoint(readTarget,guard);}
    // 中文注释：按下鼠标前的所有核实失败都未派发点击（仅可能已有悬停移动）。
    catch(error){if(error&&typeof error==='object')error.preDispatch=true;throw error;}
    try {await this.#adapter.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});}
    finally {await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});}
    return {ok:true,kind:'pointer-click'};
  }
  async #boundTargetPoint(readTarget,guard) {
    const before=await this.#adapter.evaluate('state');
    if(before.visual.scale!==1||before.visual.x||before.visual.y)fail('UNSUPPORTED_VISUAL_VIEWPORT');
    guard();
    const point=await readTarget();
    if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.y<0||point.x>=before.viewport.width||point.y>=before.viewport.height)fail('INVALID_COORDINATES');
    // 中文注释：语义目标的命中身份由页面侧逐层核实，这里只排除覆盖层，允许开放与封闭 Shadow。
    // 中文注释：后台 CDP 的 DOM 命中接口可能不可用；readTarget 仍核对引用、遮挡和几何，按派发后可信事件确认送达。
    if(before.visibility!=='hidden')await this.#adapter.verifyHit(point,{allowOpenShadow:true,allowClosedShadow:true});guard();
    await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    guard();
    const after=await this.#adapter.evaluate('state');
    // 中文注释：悬停后重新读取同一语义目标及视口；变化时在按下鼠标前拒绝。
    for(const key of ['documentId','token','url','viewport','dpr','scroll','visual'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))fail('TARGET_CHANGED');
    const current=await readTarget();guard();
    if(!Number.isFinite(current?.x)||!Number.isFinite(current?.y)||Math.abs(current.x-point.x)>0.5||Math.abs(current.y-point.y)>0.5)fail('NODE_MOVED');
    if(after.visibility!=='hidden')await this.#adapter.verifyHit(point,{allowOpenShadow:true,allowClosedShadow:true});guard();
    return point;
  }
  async #dragCoordinates(r) {
    if(r.mode && r.mode!=='pointer') fail('UNSUPPORTED_DRAG_MODE');
    const steps=r.steps??12;
    if(!Number.isSafeInteger(steps)||steps<2||steps>100) fail('INVALID_STEPS');
    const shot=await this.#validate(r),from=this.#point(shot,r.from?.point),to=this.#point(shot,r.to?.point);
    // 中文注释：后台拖动无法等价地合成用户指针轨迹；在任何 CDP 输入前明确拒绝。
    if(shot.visibility==='hidden')throw Object.assign(new InteractionError('BACKGROUND_POINTER_UNSUPPORTED'),{preDispatch:true});
    await this.#check(from,r.from.expectedRef);await this.#check(to,r.to.expectedRef);await this.#guard(shot);
    this.#shots.delete(shot.id);
    await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
    await this.#guard(shot);await this.#check(from,r.from.expectedRef);await this.#check(to,r.to.expectedRef);
    const armed=await this.#adapter.evaluate('arm-probe',{ref:r.from.expectedRef});if(armed.error)fail(armed.error);
    try{
      let last=from,complete=false;
      try {
        await this.#adapter.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...from});
        for(let i=1;i<=steps;i++) {
          await this.#guard(shot,true);
          last={x:from.x+(to.x-from.x)*i/steps,y:from.y+(to.y-from.y)*i/steps};
          await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...last});
        }
        await this.#guard(shot,true);await this.#check(to,r.to.expectedRef,r.from.expectedRef);complete=true;
      } finally {
        if(!complete) {
          last={x:-1,y:-1};
          await this.#adapter.send('Input.cancelDragging').catch(()=>{});
        }
        await this.#adapter.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...last});
      }
      const observed=await this.#deliveryProbe('drag');
      if(observed.target.pointerdown&&observed.global.pointerup)return {ok:true,kind:'pointer-drag',delivery:'confirmed',from,to,steps};
      // 中文注释：部分或全部未送达都不能报告拖动成功，也不能在已派发后补做另一种拖动。
      return {ok:false,kind:'pointer-drag',delivery:'unconfirmed',outcomeUnknown:true,from,to,steps};
    }finally{await this.#adapter.evaluate('clear-probe').catch(()=>{});}
  }
  async #dragElements(r) {
    const mode=r.mode??'pointer';
    if(!['pointer','html5-synthetic'].includes(mode)) fail('UNSUPPORTED_DRAG_MODE');
    const source=await this.#bounds({...r,selector:r.source}),target=await this.#bounds({...r,selector:r.target});
    const from={point:source.imageCenter,expectedRef:source.ref},to={point:target.imageCenter,expectedRef:target.ref};
    if(mode==='pointer') return this.#dragCoordinates({...r,mode,from,to});
    const shot=await this.#validate(r),a=this.#point(shot,from.point),b=this.#point(shot,to.point);
    await this.#check(a,source.ref);await this.#check(b,target.ref);await this.#guard(shot);
    this.#shots.delete(shot.id);
    const result=await this.#adapter.evaluate('html5',{from:{...a,ref:source.ref},to:{...b,ref:target.ref}});
    if(result.error) fail(result.error);return result;
  }
  async #bounds(r) {
    const shot=await this.#validate(r);const result=await this.#adapter.evaluate('bounds',{selector:r.selector});
    if(result.error) fail(result.error);
    this.#refs.set(result.ref,shot.id);
    while(this.#refs.size>256)this.#refs.delete(this.#refs.keys().next().value);
    return {...result,imageCenter:{x:(result.rect.x+result.rect.width/2)*shot.dpr,y:(result.rect.y+result.rect.height/2)*shot.dpr}};
  }
}
