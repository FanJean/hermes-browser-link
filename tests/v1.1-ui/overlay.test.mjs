import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutomationOverlay} from '../../native-extension/automation-overlay.mjs';
function styleFixture(){
 const priorities=new Map();
 return {
  getPropertyValue(name){return this[name]||'';},
  getPropertyPriority(name){return priorities.get(name)||'';},
  setProperty(name,value,priority=''){this[name]=String(value);if(priority)priorities.set(name,priority);else priorities.delete(name);},
  removeProperty(name){const previous=this[name]||'';delete this[name];priorities.delete(name);return previous;},
 };
}
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.style=styleFixture();this.dataset={};this.listeners={};this.attributes=new Map();this.textContent='';this.removed=false;this.isConnected=false;this.parentNode=null;}
 attachShadow(){this.shadow=new Element('shadow');this.shadow.parentNode=this;return this.shadow;}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 getAttribute(name){return this.attributes.get(name)||null;}
 hasAttribute(name){return this.attributes.has(name);}
 removeAttribute(name){this.attributes.delete(name);}
 append(...children){for(const child of children){this.children.push(child);child.parentNode=this;child.isConnected=this.isConnected;}}
 replaceChildren(...children){this.children=[];this.append(...children);}
 addEventListener(type,fn){this.listeners[type]=fn;}
 remove(){this.removed=true;this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
 async fire(type,event){return this.listeners[type]?.(event);}
}
function fixture(){const body=new Element('body'),documentElement=new Element('html');documentElement.isConnected=true;const doc={location:{origin:'https://example.test'},documentElement,defaultView:{innerWidth:800,innerHeight:600,getComputedStyle:element=>({display:element.style.display||'block',opacity:element.style.opacity||'1'})},createElement:t=>new Element(t)};documentElement.append(body);return {doc,body};}
const scope={taskId:'task-1',generation:2,tabId:7,origin:'https://example.test'};
// 中文注释：解析反馈必须随真实步骤开始和结束，不能在接管、异常或输入时继续显示扫描。
test('解析步骤显示扫描，切换状态立即收起，截图隐藏后可恢复',async()=>{
 const {doc}=fixture(),overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const scan=overlay.host.shadow.children.find(x=>x.dataset.role==='parsing-scan');
 assert.equal(scan.style.display,'none');
 for(const step of ['snapshot','semantic_snapshot','page.parse','page.observe','frame_catalog']){
  overlay.update({state:'running',step});assert.equal(scan.style.display,'block',step);assert.equal(scan.style.pointerEvents,'none');
  await overlay.withHidden(async()=>assert.equal(overlay.host.style.opacity,'0'));
  assert.notEqual(overlay.host.style.opacity,'0');assert.equal(scan.style.display,'block');
  for(const state of ['paused','pausing','unknown','disconnected','waiting']){overlay.update({state});assert.equal(scan.style.display,'none',state);overlay.update({state:'running',step});}
 }
 overlay.update({state:'running',step:'ref_click'});assert.equal(scan.style.display,'none');overlay.remove();
});
// 中文注释：只绘制实际解析回执中的可见矩形；完成后的短暂反馈不阻塞任务，旧定时器不能清掉新扫描。
test('解析元素边框有数量和矩形限制，新步骤或异常清除旧完成反馈',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const {doc}=fixture(),overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const frames=overlay.host.shadow.children.find(x=>x.dataset.role==='parsing-elements');
 assert.equal(overlay.showParsedElements([{x:20,y:80,width:120,height:36}]),false);
 overlay.update({state:'running',step:'semantic_snapshot'});
 assert.equal(overlay.showParsedElements([{x:20,y:80,width:120,height:36},{x:NaN,y:0,width:50,height:10}]),true);
 assert.equal(frames.children.length,1);assert.equal(frames.children[0].style.left,'20px');assert.equal(frames.children[0].style.pointerEvents,'none');
 overlay.update({state:'waiting'});assert.equal(frames.style.opacity,'1');context.mock.timers.tick(600);assert.equal(frames.style.opacity,'0');
 overlay.update({state:'running',step:'page.parse'});context.mock.timers.tick(220);assert.equal(frames.children.length,0);
 overlay.showParsedElements(Array.from({length:40},()=>({x:20,y:80,width:120,height:36})));assert.equal(frames.children.length,24);
 overlay.update({state:'unknown'});assert.equal(frames.children.length,0);assert.equal(frames.style.display,'none');
 const style=overlay.host.shadow.children.find(x=>x.tagName==='style').textContent;
 assert.match(style,/prefers-reduced-motion:reduce/);assert.match(style,/parsing-beam/);overlay.remove();
});
test('overlay is scoped, decorative surfaces ignore pointers and screenshot hide restores',async()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 assert.equal(doc.documentElement.children.length,2);const host=doc.documentElement.children[1];
 assert.equal(host.dataset.hermesAutomationOverlay,'');assert.equal(host.style.pointerEvents,'auto');
 assert.equal(host.shadow.children[0].style.pointerEvents,'none');
 // 截图期间遮罩只变透明，仍在布局中并继续拦截点击。
 const result=await overlay.withHidden(async()=>{assert.equal(host.style.opacity,'0');assert.notEqual(host.style.display,'none');assert.equal(host.style.pointerEvents,'auto');assert.equal(host.isConnected,true);return 42;});assert.equal(result,42);assert.notEqual(host.style.opacity,'0');
 await assert.rejects(overlay.withHidden(async()=>{throw Error('shot');}),/shot/);assert.notEqual(host.style.opacity,'0');
 overlay.remove();assert.equal(host.removed,true);
});

test('截图恢复失败仍保留拦截，且优先报告恢复失败',async()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const host=doc.documentElement.children[1],getComputedStyle=doc.defaultView.getComputedStyle;
 let restorationBlocked=false;
 doc.defaultView.getComputedStyle=element=>element===host&&restorationBlocked?{display:'block',opacity:'0'}:getComputedStyle(element);
 const captureError=Error('shot');

 await assert.rejects(overlay.withHidden(async()=>{restorationBlocked=true;throw captureError;}),error=>{
  assert.equal(error.message,'overlay restore failed');
  assert.notEqual(error,captureError,'restoration failure remains the observable error, matching prior finally semantics');
  return true;
 });
 assert.equal(host.removed,false);assert.equal(host.style.pointerEvents,'auto');
 assert.equal(doc.documentElement.children.includes(host),true);overlay.remove();
});

test('cross-origin scope fails closed and stop is not merely a visual dismissal',async()=>{
 const {doc}=fixture();assert.throws(()=>createAutomationOverlay({document:doc,...scope,origin:'https://other.test',onStop:async()=>{}}),/scope/);
 let calls=0;const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>{calls++;return {state:'stopped'};},onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const host=doc.documentElement.children[1];const stop=host.shadow.children.find(x=>x.dataset.role==='status').children.find(x=>x.dataset.role==='actions').children.find(x=>x.dataset.action==='stop');
 await stop.fire('click',{isTrusted:false});assert.equal(calls,0);
 await stop.fire('click',{isTrusted:true});assert.equal(calls,1);assert.equal(host.removed,true);
});

test('unknown stop remains visible and a target needs a fresh bounded rectangle',async()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'unknown'}),onTakeover:async()=>({state:'unknown'}),onResume:async()=>({state:'unknown'})});
 const host=doc.documentElement.children[1],target=host.shadow.children.find(x=>x.dataset.role==='target');
 overlay.update({state:'running',step:'定位结果',targetRect:{x:10,y:20,width:80,height:25}});
 assert.equal(target.style.left,'10px');assert.equal(target.style.width,'80px');
 overlay.update({state:'unknown',targetRect:{x:NaN,y:1,width:2,height:3}});assert.equal(target.style.display,'none');
 const stop=host.shadow.children.find(x=>x.dataset.role==='status').children.find(x=>x.dataset.role==='actions').children.find(x=>x.dataset.action==='stop');await stop.fire('click',{isTrusted:true});assert.equal(host.removed,false);
 overlay.remove();
});

test('terminal update removes only this overlay and stops presenting stale target',()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const host=doc.documentElement.children[1];overlay.update({state:'running',targetRect:{x:1,y:2,width:30,height:40}});
 overlay.update({state:'stopped'});assert.equal(host.removed,true);
});

test('接管后页面可点击，退出接管后遮罩恢复',async()=>{
 const {doc}=fixture();let pauses=0,resumes=0;
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),
  onTakeover:async()=>{pauses++;return {state:'paused'};},onResume:async()=>{resumes++;return {state:'running'};}});
 const actions=overlay.host.shadow.children.find(x=>x.dataset.role==='status').children.find(x=>x.dataset.role==='actions');
 overlay.update({state:'waiting'});assert.equal(overlay.host.style.pointerEvents,'auto');
 await actions.children.find(x=>x.dataset.action==='takeover').fire('click',{isTrusted:true});
 assert.equal(pauses,1);assert.equal(overlay.host.style.pointerEvents,'none');
 await actions.children.find(x=>x.dataset.action==='resume').fire('click',{isTrusted:true});
 assert.equal(resumes,1);assert.equal(overlay.host.style.pointerEvents,'auto');
 overlay.remove();
});

test('遮罩在任务期间一直拦截点击，只有派发点击类步骤时短暂放行',()=>{
 const {doc}=fixture();
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 for(const step of ['snapshot','semantic_snapshot','screenshot','navigate','frame_catalog']){
  overlay.update({state:'running',step});assert.equal(overlay.host.style.pointerEvents,'auto',step);
 }
 for(const step of ['ref_click','click','fill','interaction.click','scroll','press','ref_press']){
  overlay.update({state:'running',step});assert.equal(overlay.host.style.pointerEvents,'none',step);
 }
 overlay.update({state:'waiting'});assert.equal(overlay.host.style.pointerEvents,'auto');
 // 中文注释：全部访问同样拦截用户点击，只在原始 CDP 输入派发时放行；撤销后仍是普通遮罩。
 overlay.update({state:'running'});assert.equal(overlay.host.style.pointerEvents,'auto');
 overlay.update({state:'running',step:'cdp.input',holdMs:600});assert.equal(overlay.host.style.pointerEvents,'none');
 overlay.update({state:'running'});assert.equal(overlay.host.style.pointerEvents,'auto');
 overlay.update({state:'waiting'});assert.equal(overlay.host.style.pointerEvents,'auto');
 overlay.update({state:'paused'});assert.equal(overlay.host.style.pointerEvents,'none');
 overlay.remove();
});
test('全部访问输入放行窗口到期后自动恢复拦截，键盘也随之拦截',async()=>{
 const {doc}=fixture();const keys=new Map();doc.defaultView.addEventListener=(type,fn)=>keys.set(type,fn);doc.defaultView.removeEventListener=()=>{};
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const key=()=>{let blocked=false;keys.get('keydown')({isTrusted:true,composedPath:()=>[],preventDefault(){blocked=true;},stopImmediatePropagation(){}});return blocked;};
 overlay.update({state:'running'});assert.equal(key(),true);
 overlay.update({state:'running',step:'cdp.input',holdMs:30});assert.equal(overlay.host.style.pointerEvents,'none');assert.equal(key(),false);
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(overlay.host.style.pointerEvents,'auto');assert.equal(key(),true);
 overlay.remove();
});
test('reblock closes a dispatch pass-through but never overrides a user takeover',()=>{
 const {doc}=fixture();
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 overlay.update({state:'running',step:'ref_click'});assert.equal(overlay.host.style.pointerEvents,'none');
 overlay.reblock();assert.equal(overlay.host.style.pointerEvents,'auto');
 overlay.update({state:'paused'});overlay.reblock();assert.equal(overlay.host.style.pointerEvents,'none');
 overlay.remove();
});
test('交互高亮带醒目边框并把标签贴在目标旁边',()=>{
 const {doc}=fixture();
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const binding={taskId:scope.taskId,generation:scope.generation,operationToken:'op'};
 assert.deepEqual(overlay.interactionSurface.update({...binding,kind:'click',rects:[{left:100,top:200,width:80,height:30}]}),{ok:true});
 const parts=overlay.host.shadow.children,target=parts.find(x=>x.dataset.role==='target'&&x.style.display==='block'),label=parts.find(x=>x.dataset.role==='interaction-status');
 assert.match(target.style.border,/^3px solid/);assert.match(target.style.animation,/hermes-pulse/);
 assert.equal(label.style.top,'172px');assert.equal(label.style.left,'100px');assert.equal(label.textContent,'准备点击');
 overlay.remove();
});

// 中文注释：任务思考、读取和动作之间鼠标保持显示，接管、断连和后台页不误报正在操作。
test('任务鼠标固定启用，动作结束及下一步等待仍保留位置',()=>{
 const {doc}=fixture();
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const cursor=overlay.host.shadow.children.find(x=>x.dataset.role==='virtual-cursor');
 assert.equal(cursor.style.display,'block');assert.equal(overlay.setCursorEnabled,undefined);
 const binding={taskId:scope.taskId,generation:scope.generation,operationToken:'cursor-1'};
 overlay.interactionSurface.update({...binding,kind:'click',point:{x:31,y:47},rects:[{left:10,top:20,width:80,height:40}]});
 assert.equal(cursor.style.transform,'translate(31px,47px)');
 overlay.interactionSurface.clear(binding);assert.equal(cursor.style.display,'block');
 overlay.update({state:'running',step:'snapshot'});assert.equal(cursor.style.display,'block');
 overlay.update({state:'waiting'});assert.equal(cursor.style.display,'block');assert.equal(cursor.style.transform,'translate(31px,47px)');
 overlay.update({state:'paused'});assert.equal(cursor.style.display,'none');
 overlay.update({state:'waiting'});assert.equal(cursor.style.display,'block');
 doc.visibilityState='hidden';overlay.update({state:'running'});assert.equal(cursor.style.display,'none');
 doc.visibilityState='visible';overlay.update({state:'waiting'});assert.equal(cursor.style.display,'block');
 overlay.update({state:'disconnected'});assert.equal(cursor.style.display,'none');overlay.remove();
});
// 中文注释：同一绘制回调不会从旧起点重启；后续目标直接衔接当前光标位置，减少动作间闪烁。
test('鼠标连续衔接目标，移动只使用 transform 且支持减少动态效果',()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const cursor=overlay.host.shadow.children.find(x=>x.dataset.role==='virtual-cursor');
 const binding={taskId:scope.taskId,generation:scope.generation,operationToken:'move-1'};
 overlay.interactionSurface.update({...binding,kind:'input',point:{x:100,y:80},rects:[{left:80,top:70,width:80,height:20}]});
 overlay.interactionSurface.clear(binding);
 overlay.interactionSurface.update({...binding,operationToken:'move-2',kind:'input',point:{x:350,y:180},rects:[{left:330,top:170,width:80,height:20}]});
 assert.equal(cursor.style.display,'block');assert.equal(cursor.style.transform,'translate(350px,180px)');
 assert.match(cursor.style.transition,/^transform 240ms cubic-bezier/);
 assert.ok(overlay.host.shadow.children.some(node=>node.tagName==='style'&&node.textContent.includes('prefers-reduced-motion')));overlay.remove();
});

test('步骤标签只显示控件名称，最近五步的错误码有固定说明',()=>{
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const binding={taskId:scope.taskId,generation:scope.generation,operationToken:'label-1'};
 overlay.interactionSurface.update({...binding,kind:'input',label:'产品名称',rects:[{left:10,top:20,width:80,height:40}]});
 const status=overlay.host.shadow.children.find(x=>x.dataset.role==='interaction-status');
 assert.equal(status.textContent,'正在输入：产品名称');
 overlay.setRecentSteps([{time:'2026-09-30T12:00:00Z',action:'ref_fill',target:'textbox · 产品名称',durationMs:12,result:'element_timeout'}]);
 const panel=overlay.host.shadow.children.find(x=>x.dataset.role==='status').children.find(x=>x.tagName==='details');
 assert.match(panel.children[1].children[0].textContent,/目标未在期限内出现/);
 overlay.remove();
});
// 中文注释：云端错误沿用本机步骤协议，结果未知时保留错误原因，不把拒绝操作显示成连接异常。
test('最近步骤说明内容保护拒绝、失效引用和缺失选项，保留未知结果状态',()=>{
 const {doc}=fixture(),overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 overlay.setRecentSteps([
  {action:'ref_fill',result:'content_shield_uninspectable'},
  {action:'ref_set_checked',result:'unknown',errorCode:'stale_reference'},
  {action:'ref_select_option',result:'select_option_missing'},
  {action:'click',result:'execution_denied'},
  {action:'ref_click',result:'unknown',errorCode:'PRIVATE_ERROR_CANARY https://private.invalid/?token=SECRET_CANARY'},
 ]);
 const panel=overlay.host.shadow.children.find(x=>x.dataset.role==='status').children.find(x=>x.tagName==='details');
 const lines=panel.children[1].children.map(x=>x.textContent);
 assert.match(lines[0],/失败.*content_shield_uninspectable.*无法检查/);
 assert.match(lines[1],/结果不确定.*stale_reference.*引用已失效/);
 assert.match(lines[2],/select_option_missing.*选项/);
 assert.match(lines[3],/execution_denied.*安全检查/);
 assert.doesNotMatch(lines.join(' '),/PRIVATE_ERROR_CANARY|SECRET_CANARY|private.invalid/);
 overlay.remove();
});

test('接管快捷键与按钮调用同一控制回调',async()=>{
 const {doc}=fixture(),listeners=new Map();let calls=0;
 doc.defaultView.addEventListener=(type,fn)=>listeners.set(type,fn);doc.defaultView.removeEventListener=type=>listeners.delete(type);
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>{calls++;return {state:'paused'};},onResume:async()=>({state:'running'})});
 let blocked=false;
 listeners.get('keydown')({type:'keydown',key:'F12',ctrlKey:true,altKey:true,shiftKey:true,metaKey:false,isTrusted:true,
  preventDefault(){blocked=true;},stopImmediatePropagation(){},composedPath:()=>[]});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(blocked,true);assert.equal(calls,1);assert.equal(overlay.host.style.pointerEvents,'none');
 overlay.remove();
});

// 中文注释：窗口捕获拦截 top-layer 输入，不依赖事件目标落在 host 上；接管与派发窗口保留放行。
test('模态层指针与滚动在窗口捕获阶段阻断，控制按钮仍可用',()=>{
 const {doc}=fixture(),listeners=new Map();
 doc.defaultView.addEventListener=(type,fn,options)=>{listeners.set(type,{fn,options});};
 doc.defaultView.removeEventListener=type=>listeners.delete(type);
 const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const fire=(type,path=[])=>{let blocked=false;listeners.get(type).fn({isTrusted:true,composedPath:()=>path,preventDefault(){blocked=true;},stopImmediatePropagation(){}});return blocked;};
 for(const type of ['pointerdown','mouseup','click','wheel','touchmove']){
  assert.equal(fire(type),true);assert.equal(listeners.get(type).options.passive,false);
  assert.equal(fire(type,[overlay.host]),false);
 }
 overlay.host.style.pointerEvents='none';assert.equal(fire('click'),true,'样式不是授权');
 overlay.update({state:'paused'});assert.equal(fire('click'),false);
 overlay.update({state:'running',step:'click'});assert.equal(fire('click'),false);
 overlay.reblock();assert.equal(fire('click'),true);overlay.remove();assert.equal(listeners.size,0);
});

// 中文注释：持续几何校准不能重启拖动起点定时器，旧操作清理也不能影响新操作。
test('拖动先到起点再到终点，同一操作反复绘制不回跳',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const {doc}=fixture();const overlay=createAutomationOverlay({document:doc,...scope,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const cursor=overlay.host.shadow.children.find(x=>x.dataset.role==='virtual-cursor');
 const request={taskId:scope.taskId,generation:scope.generation,operationToken:'drag-smooth',kind:'drag',rects:[{left:20,top:40,width:20,height:20},{left:300,top:200,width:20,height:20}]};
 overlay.interactionSurface.update(request);assert.equal(cursor.style.transform,'translate(30px,50px)');
 context.mock.timers.tick(120);overlay.interactionSurface.update(request);
 context.mock.timers.tick(120);assert.equal(cursor.style.transform,'translate(310px,210px)');
 overlay.interactionSurface.update(request);assert.equal(cursor.style.transform,'translate(310px,210px)');
 overlay.interactionSurface.clear(request);assert.equal(cursor.style.display,'block');
 context.mock.timers.tick(500);assert.equal(cursor.style.transform,'translate(310px,210px)');overlay.remove();
});
