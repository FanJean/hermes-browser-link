import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor} from '../../native-extension/core.mjs';
import {createInteractionHighlight} from '../../native-extension/interaction-highlight.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

const origin='https://example.test';
const task={id:'highlight-fixture',generation:3,instanceId:'fixture-browser',approvalScope:'fixture-owner',
 modeGeneration:1,allowedOrigins:[origin],tabIds:[7]};
const rects={
 '#save':{x:10,y:10,width:24,height:16},
 '#query':{x:10,y:34,width:38,height:14},
 '#country':{x:10,y:56,width:42,height:18},
 '#source':{x:10,y:78,width:14,height:14},
 '#target':{x:65,y:78,width:18,height:14},
};
const png=()=>{const bytes=Buffer.alloc(44);bytes.writeUInt32BE(100,16);bytes.writeUInt32BE(100,20);return bytes.toString('base64');};
const copy=value=>structuredClone(value);

function createFixture({pauseHighlight=false,captureError=false,overlayEvents=true}={}){
 const dom=new JSDOM(`<!doctype html><button id="save">Save</button><input id="query" type="text"><select id="country"><option value="us">US</option></select><div id="source">Source</div><div id="target">Target</div>`,
  {url:origin+'/',runScripts:'outside-only',pretendToBeVisual:true});
 const {window}=dom,document=window.document,events=[],calls=[],objects=new Map(),listeners=new Set(),backendNodes=new Map(),backendIds=new WeakMap();
 // 中文注释：节点编号与远程句柄分开模拟，释放句柄后仍可用可信 backendNodeId 重新解析原节点。
 let remoteId=0,nextBackend=100;
 const backend=node=>{if(!backendIds.has(node)){backendIds.set(node,++nextBackend);backendNodes.set(nextBackend,node);}return backendIds.get(node);};
 const remote=node=>{const id=`remote-${++remoteId}`;objects.set(id,node);return id;};
 const argument=value=>value.objectId?objects.get(value.objectId):value.value;
 // Open the production overlay shadow root only in this synthetic fixture so its
 // rendered target box and screenshot visibility can be read back deterministically.
 const attachShadow=window.Element.prototype.attachShadow;
 window.Element.prototype.attachShadow=function(init){return attachShadow.call(this,{...init,mode:'open'});};
 window.visualViewport=Object.assign(new window.EventTarget(),{scale:1,offsetLeft:0,offsetTop:0});
 Object.defineProperty(window,'innerWidth',{value:100,configurable:true});
 Object.defineProperty(window,'innerHeight',{value:100,configurable:true});
 Object.defineProperty(window,'devicePixelRatio',{value:1,configurable:true});
 let uuid=0;
 Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>`fixture-${++uuid}`});
 for(const [selector,r] of Object.entries(rects)){
  const element=document.querySelector(selector);
  Object.defineProperty(element,'getBoundingClientRect',{configurable:true,value:()=>({x:r.x,y:r.y,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height,width:r.width,height:r.height,toJSON(){return {...r};}})});
  Object.defineProperty(element,'getClientRects',{configurable:true,value:()=>[{...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height}]});
 }
 const hitTest=(x,y)=>Object.entries(rects).map(([selector,r])=>({selector,r,element:document.querySelector(selector)}))
  .find(({r})=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)?.element||null;
 document.elementFromPoint=(x,y)=>hitTest(x,y);
 document.elementsFromPoint=(x,y)=>{const hit=hitTest(x,y);return hit?[hit]:[];};
 // 中文注释：夹具按钮显示点击状态；键盘 mock 模拟 Tab 的浏览器默认焦点转移。
 document.querySelector('#save').onclick=e=>e.currentTarget.setAttribute('aria-pressed',String(Date.now()));
 const interactionHost=()=>document.querySelector('[data-hermes-interaction-highlight]');
 const targetBox=()=>interactionHost()?.shadowRoot?.querySelector('[data-role="target"]');
 const automationTargetBox=()=>document.querySelector('[data-hermes-automation-overlay]:not([data-hermes-interaction-highlight])')?.shadowRoot?.querySelector('[data-role="target"]');
 const targetRects=()=>{
  const host=interactionHost();if(!host||host.style.display==='none')return [];
  return [...(host.shadowRoot?.querySelectorAll('[data-role="target"],[data-role="drag-start"],[data-role="drag-end"]')||[])]
   .filter(frame=>frame.style.display==='block')
   .map(frame=>({x:Number.parseFloat(frame.style.left),y:Number.parseFloat(frame.style.top),width:Number.parseFloat(frame.style.width),height:Number.parseFloat(frame.style.height)}));
 };
 const targetVisible=()=>targetRects().length>0;
 let observedHost=null,observedRectKey='';
 const observeHighlight=async()=>{
  const host=interactionHost(),rectsNow=targetRects();
  if(host&&rectsNow.length){
   const key=JSON.stringify(rectsNow);
   if(host!==observedHost||key!==observedRectKey){
    const event={type:'highlight',rects:copy(rectsNow)};events.push(event);startHighlight(event);
    observedHost=host;observedRectKey=key;
    if(pauseHighlight)await highlightGate;
   }
  }else if(observedHost){events.push({type:'highlight-clear'});observedHost=null;observedRectKey='';}
 };
 for(const [selector,name] of [['#save','click'],['#query','fill'],['#source','drag-source'],['#target','drag-target']]){
  const element=document.querySelector(selector);
  for(const eventName of (name==='click'?['click']:name==='fill'?['input']:[]))element.addEventListener(eventName,()=>events.push({type:'side-effect',name,highlightVisible:targetVisible()}));
 }
 let startHighlight,releaseHighlight;
 const highlightStarted=new Promise(resolve=>{startHighlight=resolve;});
 const highlightGate=new Promise(resolve=>{releaseHighlight=resolve;});
 let shouldCaptureError=captureError;
 const api={
  // 中文注释：写动作先激活租用的工作页，再进入高亮准备和复核。
  tabs:{get:async id=>({id,url:origin+'/',windowId:5,groupId:2,status:'complete'}),update:async()=>({active:true})},
  debugger:{
   ...(overlayEvents?{onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}:{}),
   onDetach:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
   getTargets:async()=>[{type:'page',targetId:'fixture-target',tabId:7,url:origin+'/'}],
   attach:async()=>{},detach:async()=>{},
   sendCommand:async(_target,method,params={})=>{
    calls.push({method,params:copy(params)});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:origin+'/',loaderId:'fixture-document'}}};
    if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
    if(['DOM.enable','Network.enable','Target.setAutoAttach'].includes(method))return {};
    if(method==='Page.createIsolatedWorld')return {executionContextId:17};
    if(method==='Runtime.addBinding'){window.hermesOverlayCommand=()=>{};return {};}
    if(method==='Runtime.callFunctionOn'){
     let value;
     if(params.objectId){
      const receiver=objects.get(params.objectId);
      if(!receiver)throw Error('synthetic object unavailable');
      const fn=window.eval(`(${params.functionDeclaration})`);
      value=fn.apply(receiver,(params.arguments||[]).map(argument));
     }else{
      const fn=window.eval(`(${params.functionDeclaration})`);
      value=fn(...(params.arguments||[]).map(argument));
     }
     await observeHighlight();
     if(params.returnByValue===false&&value?.nodeType===1)return {result:{objectId:remote(value)}};
     return {result:{value:copy(value)}};
    }
    if(method==='Runtime.evaluate'){const value=window.eval(params.expression);await observeHighlight();return {result:{value:copy(value)}};}
    if(method==='DOM.getNodeForLocation'){
     const node=hitTest(params.x,params.y)||document.body;
     return {backendNodeId:backend(node)};
    }
    if(method==='DOM.describeNode')return {node:{backendNodeId:backend(objects.get(params.objectId))}};
    if(method==='DOM.resolveNode')return {object:{objectId:remote(backendNodes.get(params.backendNodeId))}};
    if(method==='Runtime.releaseObject'){objects.delete(params.objectId);return {};}
    if(method==='Page.captureScreenshot'){
     const hosts=[...document.querySelectorAll('[data-hermes-automation-overlay]')];
     // Screenshots make the overlay transparent (still blocking input); record that as hidden.
     const overlayDisplays=hosts.map(host=>host.style.opacity==='0'&&host.style.display!=='none'?'none':'visible');
     events.push({type:'capture',overlayDisplays});
     if(overlayDisplays.some(display=>display!=='none'))throw Error('overlay was visible in synthetic screenshot');
     if(shouldCaptureError)throw Error('synthetic capture failure');
     return {data:png()};
    }
    if(method==='Input.dispatchMouseEvent'||method==='Input.dispatchKeyEvent'){
     events.push({type:'side-effect',name:method==='Input.dispatchKeyEvent'?'key':'pointer',event:params.type||'',highlightVisible:targetVisible()});
     // 中文注释：JSDOM 无法处理 CDP 鼠标派发；测试边界在 release 时模拟浏览器生成的点击。
     if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased')hitTest(params.x,params.y)?.click();
     if(method==='Input.dispatchKeyEvent'&&params.type==='keyDown'&&params.key==='Tab')document.querySelector('#query').focus();
     return {};
    }
    if(method==='Input.cancelDragging')return {};
    return {};
   },
  },
 };
 const executor=new Executor(api);
 return {dom,window,document,events,calls,api,executor,targetBox,automationTargetBox,targetRects,targetVisible,highlightStarted,releaseHighlight:()=>releaseHighlight(),
  setCaptureError:value=>{shouldCaptureError=value;}};
}

const request=(action,extra={})=>({taskId:task.id,generation:task.generation,modeGeneration:2,tabId:7,action,allowedOrigins:task.allowedOrigins,...extra});
const readRequest=(action,extra={})=>request(action,{modeGeneration:1,...extra});
async function authorizeFull(executor){
 await executor.approve(task);
 executor.setMode({...task,activeMode:'full',modeGeneration:2});
}
async function snapshotFor(executor){return executor.execute(request('semantic_snapshot'));}
// 中文注释：生产执行器与 Bridge 使用真实引用和节点范围，验证重放只交付原结果，不再次写入字段。
test('目标级保护贯穿引用、输入和结果回放，伪造范围不能扩大权限',async()=>{
 const f=createFixture();f.executor.onContentShield=async()=>({enabled:true,rules:{}});await authorizeFull(f.executor);
 const iframe=f.document.createElement('iframe');f.document.body.append(iframe);Object.defineProperty(iframe,'contentDocument',{get:()=>null});
 iframe.getBoundingClientRect=()=>({x:60,y:10,width:30,height:25});
 try{
  const snapshot=await snapshotFor(f.executor),input=snapshot.items.find(item=>item.role==='textbox');assert.ok(input);
  const params=request('ref_fill',{binding:snapshot.binding,snapshotId:snapshot.snapshotId,ref:input.ref,text:'scope-fixture-value'});
  let reply;const bridge=new Bridge({onMessage:{addListener(){}},postMessage:value=>reply(value)},f.executor,()=>{},{onContentFilter:async()=>true});
  const call=()=>new Promise(resolve=>{reply=resolve;bridge.receive({id:'target-scope',method:'browser.execute',params});});
  const first=await call();assert.equal(first.error,undefined,JSON.stringify(first));assert.equal(f.document.querySelector('#query').value,'scope-fixture-value');
  const replay=await call();assert.deepEqual(replay,first);assert.equal(f.events.filter(e=>e.type==='side-effect'&&e.name==='fill').length,1);
  assert.equal(JSON.stringify(first).includes('backendNodeId'),false);
  await assert.rejects(f.executor.execute({...params,binding:{...params.binding,leaseId:'forged'},writeTarget:{backendNodeId:1}}),error=>error.message==='BINDING_MISMATCH'&&error.preDispatch===true);
  assert.equal(f.events.filter(e=>e.type==='side-effect'&&e.name==='fill').length,1);
 }finally{f.document.querySelector('[data-hermes-automation-overlay]')?.dispatchEvent(new f.window.Event('hermes-overlay-release'));f.dom.window.close();}
});
// 中文注释：从执行器真实语义回执绘制边框，验证效果不混入返回值、截图或下一次输入。
test('语义解析回执显示真实元素边框，截图隐藏装饰，新动作清除解析反馈',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  const result=await snapshotFor(f.executor),host=f.document.querySelector('[data-hermes-automation-overlay]');
  const frames=host.shadowRoot.querySelector('[data-role="parsing-elements"]');
  assert.ok(frames.children.length>0);assert.equal(frames.style.display,'block');
  const save=[...frames.children].find(node=>node.style.left==='10px'&&node.style.top==='10px');
  assert.equal(save.style.width,'24px');assert.equal(save.style.height,'16px');
  assert.equal(JSON.stringify(result).includes('parsing-elements'),false);
  await f.executor.execute(request('screenshot'));
  assert.ok(f.events.some(event=>event.type==='capture'&&event.overlayDisplays.every(display=>display==='none')));
  assert.equal(frames.children.length,0);
  const parsedCall=f.calls.find(({method,params})=>method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='parsed');
  assert.ok(parsedCall);assert.equal(typeof parsedCall.params.arguments[1].value.expectedActionToken,'string');
  const entry=f.executor.tasks.get(task.id).overlays.get(7);
  assert.equal(await f.executor.overlayCall(7,entry,'parsed',{expectedActionToken:'old-step',rects:[{x:1,y:2,width:30,height:40}]}),false);
 }finally{f.document.querySelector('[data-hermes-automation-overlay]')?.dispatchEvent(new f.window.Event('hermes-overlay-release'));f.dom.window.close();}
});
function assertTargetShownBeforeEffect(fixture,effectName,expectedRects=[]){
 const effects=fixture.events.filter(event=>event.type==='side-effect'&&event.name===effectName);
 assert.ok(effects.length>0,`synthetic ${effectName} side effect was not observed`);
 const highlights=fixture.events.filter(event=>event.type==='highlight');
 assert.ok(highlights.length>0,'production action path did not render a target highlight');
 assert.ok(fixture.events.indexOf(highlights[0])<fixture.events.indexOf(effects[0]),'target highlight must be painted before page/input side effects');
 assert.ok(effects.every(event=>event.highlightVisible),'target highlight must remain visible while the action is dispatched');
 for(const expected of expectedRects){
  // 中文注释：加粗边框可以外扩目标，但必须完整包住原元素且外扩不超过 6px。
  const covers=rect=>rect.x<=expected.x&&rect.y<=expected.y
   &&rect.x+rect.width>=expected.x+expected.width&&rect.y+rect.height>=expected.y+expected.height
   &&expected.x-rect.x<=6&&expected.y-rect.y<=6
   &&rect.x+rect.width-(expected.x+expected.width)<=6
   &&rect.y+rect.height-(expected.y+expected.height)<=6;
  assert.ok(highlights.some(event=>event.rects.some(covers)),`missing target-covering highlight ${JSON.stringify(expected)}`);
 }
 return highlights;
}

test('selector click paints its exact target before dispatching the real page click',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  await f.executor.execute(request('click',{selector:'#save'}));
  assertTargetShownBeforeEffect(f,'click',[rects['#save']]);
 }finally{f.dom.window.close();}
});

// 中文注释：真实执行器、页面函数与桥接错误投影一起验证，frame 比 tabs 先更新也不能误报拒绝。
for(const action of ['click','ref_click'])for(const tabUpdated of [false,true]){
 test(`${action} 跨来源导航已提交时如实返回且不重放，tabs 更新=${tabUpdated}`,async()=>{
  const f=createFixture();await authorizeFull(f.executor);
  try{
   const snap=await snapshotFor(f.executor),save=snap.items.find(item=>item.name==='Save');
   let navigated=false,effects=0;
   f.document.querySelector('#save').addEventListener('click',()=>{navigated=true;effects++;});
   const send=f.api.debugger.sendCommand,get=f.api.tabs.get;
   f.api.tabs.get=async id=>({...await get(id),...(navigated&&tabUpdated?{url:'https://outside.test/private'}:{})});
   f.api.debugger.sendCommand=async(target,method,params)=>{
    // 中文注释：JSDOM 的 click() 恒为非可信；此处模拟浏览器已确认的 CDP click，再核对离站回执。
    if(navigated&&action==='ref_click'&&method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='probe_ref_delivery')
     return {result:{value:{visibility:'visible',global:{pointerdown:1,mousedown:1,click:1},target:{click:1,trustedClick:1}}}};
    return navigated&&method==='Page.getFrameTree'?
     {frameTree:{frame:{id:'main',loaderId:'outside-document',url:'https://outside.test/private'}}}:send(target,method,params);
   };
   const sent=[],bridge=new Bridge({onMessage:{addListener(){}},postMessage:message=>sent.push(message)},f.executor);
   const args=action==='click'?{selector:'#save'}:{binding:snap.binding,snapshotId:snap.snapshotId,ref:save.ref};
   const message={id:'cross-origin',method:'browser.execute',params:request(action,args)};
   bridge.receive(message);
   for(let i=0;i<100&&!sent.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(sent[0]?.error,undefined,JSON.stringify(sent[0]));
   assert.equal(sent[0]?.result?.clicked,true);
   assert.equal(sent[0]?.result?.outOfScope,true);
   assert.equal(sent[0]?.result?.documentChanged,true);
   assert.equal(JSON.stringify(sent[0]).includes('outside.test'),false);
   bridge.receive(message);await new Promise(resolve=>setTimeout(resolve,20));
   assert.equal(effects,1);
  }finally{f.dom.window.close();}
 });
}

// 中文注释：Tab 的默认动作会转移焦点；派发后的焦点变化不能阻止配对的 keyUp。
test('press Tab 转移焦点后仍发送 keyUp，且不重放 keyDown',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  const send=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,params)=>{
   const reply=await send(target,method,params);
   if(method==='Input.dispatchKeyEvent'&&params.type==='keyDown')f.document.querySelector('#query').focus();
   return reply;
  };
  assert.deepEqual(await f.executor.execute(request('press',{selector:'#save',key:'Tab'})),{ok:true,effect:'observed',delivery:'cdp-key-events'});
  assert.deepEqual(f.calls.filter(call=>call.method==='Input.dispatchKeyEvent').map(call=>call.params.type),['keyDown','keyUp']);
  assert.equal(f.document.activeElement.id,'query');
 }finally{f.dom.window.close();}
});

// 中文注释：从 Bridge 到真实 Executor/语义库/解析器，再到当前文字过滤设置，验证读取链路。
test('页面读取、表格解析与字段提取经过同一桥接并遵循过滤开关',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  f.window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
  f.document.body.insertAdjacentHTML('beforeend','<main><p>业务正文。禁止自动化操作。403 Access denied。</p><table><tr><td>苹果</td><td>12</td></tr></table><ul><li><b>苹果</b><span>12</span></li></ul></main>');
  let enabled=false,resolve;
  const bridge=new Bridge({onMessage:{addListener(){}},postMessage:response=>resolve(response)},f.executor,()=>{},{onContentFilter:async()=>enabled});
  let sequence=0;
  const run=async(action,options)=>{
   const answer=new Promise(done=>{resolve=done;});
   bridge.receive({id:`read-${++sequence}`,method:'browser.execute',params:request(action,{options})});
   const response=await answer;assert.equal(response.error,undefined,JSON.stringify(response));return response.result;
  };
  for(const setting of [false,true,false]){
   enabled=setting;
   const snap=await run('semantic_snapshot',{mode:'content'});
   assert.equal(JSON.stringify(snap).includes('禁止自动化操作'),!setting);
   assert.match(JSON.stringify(snap),/403 Access denied/);
   assert.equal(snap.binding.taskId,task.id);
  }
  const parsed=await run('page.parse',{sections:['tables']});assert.equal(parsed.tables[0].cells[1].text,'12');
  const extracted=await run('page.parse',{sections:[],schema:{record:'li',fields:{name:{selector:'b'},count:{selector:'span',type:'number'}}}});
  assert.deepEqual(extracted.records[0].fields,{name:'苹果',count:12});
  assert.ok(extracted.records[0].sources.name.sourceRef);
 }finally{f.dom.window.close();}
});

test('fill paints only target geometry before input and never forwards the input value to highlight UI',async()=>{
 const f=createFixture();await authorizeFull(f.executor);const secret='fixture-only-not-a-real-secret';
 try{
  await f.executor.execute(request('fill',{selector:'#query',text:secret}));
  const highlights=assertTargetShownBeforeEffect(f,'fill',[rects['#query']]);
  assert.equal(f.document.querySelector('#query').value,secret,'the synthetic page should receive the test value');
  assert.equal(JSON.stringify(highlights).includes(secret),false,'highlight payloads must not contain typed input');
  assert.equal(f.window.__hermesAutomationOverlay.overlay?._label?.textContent?.includes(secret)||false,false);
 }finally{f.dom.window.close();}
});

test('official single-tool ref click/fill paths share the pre-side-effect target highlight',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  const snap=await snapshotFor(f.executor);
  const save=snap.items.find(item=>item.name==='Save');
  const query=snap.items.find(item=>item.role==='textbox'&&item.name==='');
  assert.ok(save&&query,'synthetic semantic snapshot must supply stable refs for click and type');
  await f.executor.execute(request('ref_click',{binding:snap.binding,snapshotId:snap.snapshotId,ref:save.ref}));
  assertTargetShownBeforeEffect(f,'click',[rects['#save']]);
  f.events.length=0;
  const next=await snapshotFor(f.executor);
  const input=next.items.find(item=>item.ref===query.ref);
  assert.ok(input,'query ref should still be available after a fresh snapshot');
  await f.executor.execute(request('ref_fill',{binding:next.binding,snapshotId:next.snapshotId,ref:input.ref,text:'fixture-type-value'}));
  assertTargetShownBeforeEffect(f,'fill',[rects['#query']]);
 }finally{f.dom.window.close();}
});

test('screenshot-bound coordinate click and drag highlight target geometry before CDP input events',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  const shot=await f.executor.execute(request('interaction.capture'));
  const save=await f.executor.execute(request('interaction.bounds',{screenshotId:shot.id,selector:'#save'}));
  await f.executor.execute(request('interaction.click',{screenshotId:shot.id,point:save.imageCenter,expectedRef:save.ref}));
  assertTargetShownBeforeEffect(f,'pointer',[rects['#save']]);
  f.events.length=0;
  const dragShot=await f.executor.execute(request('interaction.capture'));
  const result=await f.executor.execute(request('interaction.drag_elements',{screenshotId:dragShot.id,source:'#source',target:'#target'}));
  assert.equal(result.kind,'pointer-drag');
  assertTargetShownBeforeEffect(f,'pointer',[rects['#source'],rects['#target']]);
 }finally{f.dom.window.close();}
});

test('a stale operation token cannot clear the newer target on the production highlighter',async()=>{
 const f=createFixture({overlayEvents:false});await authorizeFull(f.executor);
 try{
  const t=f.executor.tasks.get(task.id),modeGeneration=t.policy.modeGeneration;
  const highlighter=createInteractionHighlight({document:f.document,taskId:t.id,generation:t.generation,documentId:'fixture-document',
   isCurrent:binding=>!t.revoked&&binding.generation===t.generation&&t.policy.modeGeneration===modeGeneration});
  const binding={taskId:t.id,generation:t.generation,documentId:'fixture-document'};
  assert.deepEqual(highlighter.prepare({...binding,operationToken:'new-token',kind:'click',target:f.document.querySelector('#target')}),{ok:true});
  assert.deepEqual(highlighter.clear({...binding,operationToken:'old-token'}),{ok:false,code:'STALE_OPERATION'});
  const box=f.targetBox();
  assert.ok(box?.isConnected,'stale cleanup for an old operation must leave the current highlight mounted');
  assert.equal(box.style.left,`${rects['#target'].x}px`,'the newer target geometry must remain current');
 }finally{f.dom.window.close();}
});

test('permission-generation revocation makes a live highlight stale and removes it',async()=>{
 const f=createFixture({overlayEvents:false});await authorizeFull(f.executor);
 try{
  const t=f.executor.tasks.get(task.id),modeGeneration=t.policy.modeGeneration;
  const highlighter=createInteractionHighlight({document:f.document,taskId:t.id,generation:t.generation,documentId:'fixture-document',
   isCurrent:binding=>!t.revoked&&binding.generation===t.generation&&t.policy.modeGeneration===modeGeneration});
  const binding={taskId:t.id,generation:t.generation,documentId:'fixture-document',operationToken:'revoked-operation'};
  assert.deepEqual(highlighter.prepare({...binding,kind:'click',target:f.document.querySelector('#save')}),{ok:true});
  f.executor.revokeMode(task.id);
  assert.deepEqual(highlighter.clear(binding),{ok:false,code:'STALE_DOCUMENT'});
  assert.equal(f.document.querySelector('[data-hermes-interaction-highlight]'),null,'revoked permission must remove the live target visual');
 }finally{f.dom.window.close();}
});

test('input highlight never includes typed data and semantic snapshot omits its overlay text',async()=>{
 const f=createFixture({overlayEvents:false});await authorizeFull(f.executor);
 const secret='fixture-only-not-a-real-secret';
 try{
  const t=f.executor.tasks.get(task.id),modeGeneration=t.policy.modeGeneration;
  const highlighter=createInteractionHighlight({document:f.document,taskId:t.id,generation:t.generation,documentId:'fixture-document',
   isCurrent:binding=>!t.revoked&&binding.generation===t.generation&&t.policy.modeGeneration===modeGeneration});
  const binding={taskId:t.id,generation:t.generation,documentId:'fixture-document',operationToken:'input-safe-text'};
  const input=f.document.querySelector('#query');input.value=secret;
  assert.deepEqual(highlighter.prepare({...binding,kind:'input',target:input}),{ok:true});
  const host=f.document.querySelector('[data-hermes-interaction-highlight]');
  assert.equal(host.shadowRoot.querySelector('[data-role="status"]').textContent,'正在输入');
  assert.equal(host.shadowRoot.textContent.includes(secret),false,'the highlight UI must not receive or render the input value');
  const snapshot=await f.executor.execute(request('semantic_snapshot'));
  const semantic=JSON.stringify(snapshot);
  assert.equal(semantic.includes(secret),false,'the semantic result must not expose the input value');
  assert.equal(semantic.includes('正在输入'),false,'the target highlight status must not enter page semantics');
  highlighter.clear(binding);
 }finally{f.dom.window.close();}
});

test('mode revocation while target highlight is settling cancels the action and clears only its target',async()=>{
 const f=createFixture({pauseHighlight:true});await authorizeFull(f.executor);
 try{
  const action=f.executor.execute(request('click',{selector:'#save'}));
  const actionOutcome=action.then(value=>({value}),error=>({error}));
  const observed=await Promise.race([f.highlightStarted.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),150))]);
  try{assert.equal(observed,true,'target highlight must begin on the production action path before it can be cancelled');}
  finally{f.executor.revokeMode(task.id);f.releaseHighlight();}
  const outcome=await actionOutcome;
  assert.ok(outcome.error,'revoked mode must prevent the action from continuing');
  assert.match(outcome.error.message,/mode revoked|stale generation|revoked/i);
  assert.equal(f.events.some(event=>event.type==='side-effect'&&event.name==='click'),false,'a cancelled target preview must not dispatch the click');
  const lastClear=f.events.filter(event=>event.type==='highlight-clear').at(-1);
  assert.ok(lastClear,'cancellation must clear the active target in a finally path');
 }finally{f.releaseHighlight();f.dom.window.close();}
});

test('screenshots suppress the overlay and restore it in finally on success and capture failure',async()=>{
 for(const fail of [false,true]){
  const f=createFixture({captureError:fail});await f.executor.approve(task);
  try{
   await f.executor.execute(readRequest('snapshot'));
   const overlay=f.window.__hermesAutomationOverlay;
   overlay.overlay.update({state:'running',targetRect:rects['#save']});
   assert.equal(f.automationTargetBox().style.display,'block');
   if(fail)await assert.rejects(f.executor.execute(readRequest('screenshot')),/synthetic capture failure/);
   else await f.executor.execute(readRequest('screenshot'));
   const capture=f.events.find(event=>event.type==='capture');
   assert.ok(capture.overlayDisplays.length>0&&capture.overlayDisplays.every(display=>display==='none'),'the legacy automation overlay must not appear in screenshot pixels');
   assert.notEqual(f.document.querySelector('[data-hermes-automation-overlay]:not([data-hermes-interaction-highlight])').style.opacity,'0','legacy overlay must be restored after screenshot');
  }finally{f.dom.window.close();}
 }
});

test('Executor screenshot hides the active target highlight and restores it in finally on both outcomes',async()=>{
 const outcomes=[];
 for(const fail of [false,true]){
  const f=createFixture({captureError:fail,overlayEvents:true});await authorizeFull(f.executor);
  // 中文注释：保留 frame 发现所需调试事件，仅让截图走无自动化覆盖层的高亮回退路径。
  f.executor.ensureOverlay=async()=>null;
  try{
   const t=f.executor.tasks.get(task.id),modeGeneration=t.policy.modeGeneration;
   const highlighter=createInteractionHighlight({document:f.document,taskId:t.id,generation:t.generation,documentId:'fixture-document',
    isCurrent:binding=>!t.revoked&&binding.generation===t.generation&&t.policy.modeGeneration===modeGeneration});
   const binding={taskId:t.id,generation:t.generation,documentId:'fixture-document',operationToken:`screenshot-${fail}`};
   assert.deepEqual(highlighter.prepare({...binding,kind:'click',target:f.document.querySelector('#save')}),{ok:true});
   let error=null;try{await f.executor.execute(request('screenshot'));}catch(cause){error=cause;}
   const capture=f.events.find(event=>event.type==='capture');
   const host=f.document.querySelector('[data-hermes-interaction-highlight]');
   outcomes.push({fail,error:error?.message||null,overlayDisplays:capture?.overlayDisplays||[],restored:host?.style.display!=='none'&&host?.style.opacity!=='0'});
   highlighter.clear(binding);
  }finally{f.dom.window.close();}
 }
 assert.equal(outcomes[0].error,null,'successful screenshot capture should complete');
 assert.equal(outcomes[1].error,'synthetic capture failure','capture failure should propagate unchanged');
 assert.ok(outcomes.every(outcome=>outcome.overlayDisplays.length>0&&outcome.overlayDisplays.every(display=>display==='none')),
  'target highlight host must be hidden for both screenshot outcomes');
 assert.ok(outcomes.every(outcome=>outcome.restored),'target highlight must be visible after the capture finally path');
});

test('semantic extraction excludes overlay status and target-highlight text',async()=>{
 const f=createFixture();await f.executor.approve(task);
 try{
  await f.executor.execute(readRequest('snapshot'));
  const snapshot=await f.executor.execute(readRequest('semantic_snapshot'));
  const labels=snapshot.items.map(item=>item.name).join(' ');
  assert.equal(/正在执行|停止|接管/.test(labels),false,'automation UI is not page semantic content');
  assert.ok(snapshot.items.some(item=>item.name==='Save'),'ordinary page targets remain readable');
 }finally{f.dom.window.close();}
});

test('select option highlighting is blocked explicitly because native V1 has no select action',async()=>{
 const f=createFixture();await authorizeFull(f.executor);
 try{
  await assert.rejects(f.executor.execute(request('select',{selector:'#country',value:'us'})),/V1 unsupported action/);
 }finally{f.dom.window.close();}
});
