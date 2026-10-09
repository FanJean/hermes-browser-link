import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {Executor,pageAction,semanticWorldDeclaration} from '../../native-extension/core.mjs';
import {Bridge,isUiSender} from '../../native-extension/bridge.mjs';
import {workspaceFixture,trustedTask} from './workspace-fixture.mjs';
import {withSyntheticOverlay} from './overlay-fixture.mjs';

const action=(taskId,selector='#link')=>({taskId,generation:1,tabId:taskId==='a'?1:9,action:'click',clickMode:'open_link_in_task_tab',selector,allowedOrigins:['https://example.com'],modeGeneration:2});
async function start(e,id='a',ids=[1]) {const t=trustedTask(id,ids);await e.approve(t);e.setMode({...t,activeMode:'full',modeGeneration:2});}
async function listeners(e) {
 const events={};// 中文注释：合成后台提供通知事件 API，不访问系统通知中心。
 const chrome={notifications:{onClicked:{addListener(){}},clear:async()=>true},runtime:{id:'ext',onMessage:{addListener:fn=>events.message=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{onCreated:{addListener:fn=>events.created=fn},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},debugger:{onDetach:{addListener(){}}}};
 let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'').replace(/^const executor=new Executor\(chrome,.*\);$/m,'const executor=injectedExecutor;').replace(/^const consent=new BrowserConsent.*;$/m,'const consent={load:async()=>{}};').replace(/connect\(\);\s*$/,'');
 vm.runInNewContext(source,{CloudLink,CookieMirror,reloadForInstalledBuild:async()=>false,BUILD_ID:'',registerWorkspaceStartup:()=>{},chrome,isUiSender,injectedExecutor:e});return events;
}
function cdp(f,inspect=()=>({kind:'blank_anchor',url:'https://example.com/child'})) {
 let installDeclaration;
 const calls=[];f.api.debugger={attach:async()=>{},detach:async()=>{},sendCommand:async(_,method,params)=>{
  calls.push(method);
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/',loaderId:'loader'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Network.enable')return {};
  if(method==='Runtime.callFunctionOn'){
   // 中文注释：外部效果探针不伪造效果，只有模拟派发发出的网络事件能让生产观察器确认。
   if(params.functionDeclaration.startsWith('function effectProbe'))return {result:{value:params.arguments[0].value!=='read'}};
   // 中文注释：语义库安装与动作调用分开模拟，动作断言仍执行生产函数。
   if(params.functionDeclaration.includes('globalThis.__hermesSemanticLibrary={')){installDeclaration=params.functionDeclaration;return {result:{value:true}};}
   return {result:{value:inspect({...params,installDeclaration})}};
  }
  throw Error(`unexpected CDP ${method}`);
 }};f.highlights=[];f.api.debugger=withSyntheticOverlay(f.api.debugger,{calls:f.highlights});
 f.inputEffect=()=>{for(const listener of f.api.debugger.overlayListeners)listener({tabId:1},'Network.requestWillBeSent',{});};
 return calls;
}
function eventSurface(){
 const listeners=new Map();
 return {
  addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
  removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
  emit(type,isTrusted=true){for(const listener of listeners.get(type)||[])listener({type,isTrusted});},
 };
}

// 中文注释：沿用 complex-ui 的离线 DOM 几何夹具；资格、引用和动作守卫仍执行生产代码。
function pageFixture(html){
 const dom=new JSDOM(html,{url:'https://example.com/',runScripts:'outside-only',pretendToBeVisual:true});
 const {window}=dom,document=window.document,node=document.querySelector('#target');
 Object.defineProperty(window,'innerWidth',{value:100});Object.defineProperty(window,'innerHeight',{value:100});
 window.HTMLElement.prototype.getBoundingClientRect=()=>({left:1,top:1,right:21,bottom:21,width:20,height:20});
 window.HTMLElement.prototype.getClientRects=()=>[{}];
 document.elementFromPoint=()=>node;
 // 中文注释：只替换渲染边界，生产 prepare 与 confirm 不跳过。
 window.__hermesAutomationOverlay={highlight:{prepare:()=>({ok:true}),verify:()=>({ok:true})}};
 const call=window.eval(`(${semanticWorldDeclaration})`);
 return {window,document,node,close:()=>window.close(),token(binding){
  const page=call('semantic_snapshot',{binding,options:{root:'#target',mode:'interactive',budget:5000}});
  assert.equal(window.__hermesNativeSemanticsV2.version,8);
  assert.equal(page.items.length,1);
  return {binding,snapshotId:page.snapshotId,ref:page.items[0].ref};
 }};
}
function semanticCdp(f,page){
 return cdp(f,p=>{
  page.window.eval(`(${p.installDeclaration})()`);
  return page.window.eval(`(${p.functionDeclaration})`)(...p.arguments.map(argument=>argument.value));
 });
}

test('production onCreated cannot claim a simultaneous manual tab; safe link opens a task-created grouped child',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),events=await listeners(e),calls=cdp(f);
 await start(e);const created=f.api.tabs.create;
 f.api.tabs.create=async p=>{
  f.tabs.set(11,{id:11,url:'https://example.com/personal',openerTabId:1,windowId:7,groupId:-1});events.created({...f.tabs.get(11)});
  const child=await created(p);events.created({...child});return child;
 };
 const result=await e.execute(action('a'));
 assert.equal(result.clicked,false);assert.equal(result.openedVia,'safe_link_navigation');assert.equal(result.url,'https://example.com/child');
 assert.ok(calls.includes('Runtime.callFunctionOn'));assert.ok(f.tabs.has(result.tabId));assert.equal(f.tabs.get(result.tabId).groupId,result.groupId);
 assert.equal(e.leases.get(result.tabId),'a');assert.equal(e.leases.has(11),false);
 const done=await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.ok(!f.tabs.has(result.tabId));assert.ok(f.tabs.has(11));assert.ok(f.tabs.has(1));assert.ok(f.tabs.has(9));assert.equal(done.cleanupState,'succeeded');
});

test('explicit link-navigation mode refuses a non-anchor without dispatch',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),calls=cdp(f,()=>({kind:'unsupported'}));await start(e);
 assert.deepEqual(await e.execute(action('a','#button')),{unsupported:true,code:'CHILD_CREATION_UNSUPPORTED',clicked:false});
 assert.equal(calls.filter(x=>x==='Runtime.callFunctionOn').length,1);assert.deepEqual(f.creates,[]);
 assert.deepEqual(f.groups,[]);assert.deepEqual(f.removed,[]);
});

test('production bridge returns explicit unsupported result without uncertain-write error',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),sent=[];cdp(f,()=>({kind:'unsupported'}));await start(e);
 const bridge=new Bridge({postMessage:message=>sent.push(message),onMessage:{addListener(){}}},e);
 bridge.receive({id:'click-1',method:'browser.execute',params:action('a','#button')});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,1);assert.deepEqual(sent[0].result,{unsupported:true,code:'CHILD_CREATION_UNSUPPORTED',clicked:false});
 assert.equal(sent[0].error,undefined);assert.deepEqual(f.creates,[]);
});

test('safe link cannot expand origin authority or silently invoke a page click',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),calls=cdp(f,()=>({kind:'blank_anchor',url:'https://evil.test/'}));await start(e);
 await assert.rejects(e.execute(action('a')),/origin denied/);
 assert.deepEqual(f.creates,[]);assert.equal(e.leases.has(9),false);
 assert.equal(calls.filter(x=>x==='Runtime.callFunctionOn').length,1);
});

test('page inspection reads a visible blank anchor without firing page handlers',()=>{
 const saved={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
 let clicked=0;const anchor={tagName:'A',target:'_blank',href:'https://example.com/child',disabled:false,isConnected:true,getClientRects:()=>[{}],getBoundingClientRect:()=>({left:10,top:10,width:40,height:20}),hasAttribute:name=>name==='href',closest:()=>null,click:()=>clicked++};
 try {
  globalThis.document={querySelector:()=>anchor,elementFromPoint:()=>anchor};globalThis.location={origin:'https://example.com'};
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});globalThis.innerWidth=800;globalThis.innerHeight=600;
  assert.deepEqual(pageAction('inspect_click','#link',null,null,['https://example.com']),{kind:'blank_anchor',url:'https://example.com/child'});
  assert.equal(clicked,0);
 } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('hidden blank anchor is refused before task tab creation',()=>{
 const saved={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
 let clicked=0;const anchor={tagName:'A',target:'_blank',href:'https://example.com/child',disabled:false,isConnected:true,getClientRects:()=>[],getBoundingClientRect:()=>({left:0,top:0,width:0,height:0}),hasAttribute:name=>name==='href',closest:()=>null,click:()=>clicked++};
 try {
  globalThis.document={querySelector:()=>anchor,elementFromPoint:()=>anchor};globalThis.location={origin:'https://example.com'};
  globalThis.getComputedStyle=()=>({display:'none',visibility:'visible',opacity:'1'});globalThis.innerWidth=800;globalThis.innerHeight=600;
  assert.throws(()=>pageAction('inspect_click','#hidden',null,null,['https://example.com']),/TARGET_NOT_ACTIONABLE/);
  assert.equal(clicked,0);
 } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('user move during grouping revokes ownership and keeps the page on cleanup',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);cdp(f);await start(e);
 const group=f.api.tabs.group;
 f.api.tabs.group=async p=>{const id=await group(p);f.tabs.get(p.tabIds[0]).windowId=88;return id;};
 await assert.rejects(e.execute(action('a')),/RELEASED/);
 const child=f.creates.length&&[...f.tabs.keys()].find(id=>![1,9].includes(id));
 assert.ok(child);assert.equal(e.leases.has(child),false);
 await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.ok(f.tabs.has(child));assert.ok(!f.removed.includes(child));
});

test('user move between grouping and executor lease never grants task authority',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);cdp(f);await start(e);
 const get=f.api.tabs.get;let reads=0;
 f.api.tabs.get=async id=>{if(id!==1&&id!==9&&++reads===3)f.tabs.get(id).groupId=-1;return get(id);};
 await assert.rejects(e.execute(action('a')),/RELEASED/);
 const child=[...f.tabs.keys()].find(id=>![1,9].includes(id));
 assert.ok(f.tabs.has(child));assert.equal(e.leases.has(child),false);
 await e.release({taskId:'a',generation:1,closeAgentTabs:true});assert.ok(f.tabs.has(child));
});

test('semantic ref_click uses inspected anchor URL rather than dispatching node.click',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];
 cdp(f,params=>{ops.push(params.arguments[0].value);return {kind:'blank_anchor',url:'https://example.com/ref-child'};});
 await start(e);const t=e.tasks.get('a'),binding=e.semanticBinding(t,1,'loader');
 const result=await e.execute({...action('a'),action:'ref_click',selector:undefined,binding,snapshotId:'snap',ref:'link'});
 assert.deepEqual(ops,['inspect_ref_click']);assert.equal(result.clicked,false);
 assert.equal(f.tabs.get(result.tabId).groupId,result.groupId);
 await e.release({taskId:'a',generation:1,closeAgentTabs:true});assert.ok(!f.tabs.has(result.tabId));
});

test('normal click dispatches the requested page action without substituting navigation',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];let refuse=false,observe=true;
 cdp(f,p=>{const op=p.arguments[0].value;ops.push(op);if(op==='confirm_click')return {ok:!refuse};assert.equal(op,'click');if(observe)f.inputEffect();return {clicked:true,kind:'dom-synthetic'};});await start(e);
 const result=await e.execute({...action('a','#button'),clickMode:undefined});
 assert.deepEqual(ops,['confirm_click','click']);assert.equal(result.clicked,true);assert.equal(result.popupOwnership,'uncertain');assert.deepEqual(f.creates,[]);
 assert.deepEqual(f.highlights.filter(call=>call[0]==='overlay.highlight').map(call=>call[1]),['prepare-selector','painted','complete']);
 // 中文注释：夹具升级不能跳过高亮后的资格复核，也不能把已派发但无效果误报为成功。
 refuse=true;
 await assert.rejects(e.execute({...action('a','#button'),clickMode:undefined}),error=>error.message==='INTERACTION_HIGHLIGHT_TARGET_CHANGED'&&error.preDispatch===true);
 assert.deepEqual(ops,['confirm_click','click','confirm_click']);
 refuse=false;observe=false;
 await assert.rejects(e.execute({...action('a','#button'),clickMode:undefined}),error=>error.code==='CLICK_NO_EFFECT'&&error.outcomeUnknown===true);
 assert.deepEqual(ops,['confirm_click','click','confirm_click','confirm_click','click']);
 assert.deepEqual(f.creates,[]);
});

for(const [label,tagName,target] of [['normal button','BUTTON',''],['same-tab link','A',''],['target blank link with handlers','A','_blank']])test(`${label} invokes the original DOM click handler`,()=>{
 const page=pageFixture(`<${tagName.toLowerCase()} id="target" target="${target}">Target</${tagName.toLowerCase()}>`);
 let clicked=0;page.node.addEventListener('click',()=>clicked++);
 try{
  const result=page.window.eval(`(${pageAction.toString()})`)('click','#target',null,null,['https://example.com']);
  assert.equal(clicked,1);assert.equal(result.clicked,true);
  page.node.remove();
  assert.throws(()=>page.window.eval(`(${pageAction.toString()})`)('click','#target',null,null,['https://example.com']),/target not found/);
  page.document.querySelector=()=>page.node;
  assert.throws(()=>page.window.eval(`(${pageAction.toString()})`)('click','#target',null,null,['https://example.com']),/TARGET_NOT_ACTIONABLE/);
  assert.equal(clicked,1);
 }finally{page.close();}
});

test('default semantic ref click dispatches trusted pointer once',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];
 cdp(f,p=>{const op=p.arguments[0].value;ops.push(op);if(op==='reveal_ref')return {rect:[60,30,20,30]};if(op==='rect_ref')return [60,30,20,30];if(op==='ref_relocation')return {relocated:false};if(op==='prepare_ref_click')return {ok:true};if(op==='confirm_ref')return {confirmed:true};if(op==='pointer_target')return {x:70,y:45};if(op==='input_visibility'||op==='arm_ref_delivery')return {visibility:'visible'};if(op==='probe_ref_delivery')return {global:{pointerdown:1,mousedown:1,click:1},target:{trustedClick:1}};if(op==='clear_ref_delivery')return {ok:true};throw Error('unexpected synthetic dispatch');});await start(e);
 // 中文注释：复用现有交互器桩，只检查页面坐标读取和单次派发委托。
 let clicks=0;e.interactionsFor=()=>({clickBoundTarget:async (_scope,{readTarget})=>{assert.deepEqual(await readTarget(),{x:70,y:45});clicks++;f.inputEffect();}});
 const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 const result=await e.execute({...action('a'),clickMode:undefined,action:'ref_click',binding,snapshotId:'snap',ref:'button'});
 assert.equal(clicks,1);assert.ok(ops.includes('pointer_target'));assert.equal(result.kind,'trusted-input');assert.equal(result.popupOwnership,'uncertain');assert.deepEqual(f.creates,[]);
 assert.deepEqual(ops,['input_visibility','reveal_ref','rect_ref','reveal_ref','rect_ref','ref_relocation','prepare_ref_click','confirm_ref','arm_ref_delivery','pointer_target','probe_ref_delivery','clear_ref_delivery']);
});

test('explicit semantic pointer mode uses the existing interaction executor once',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];let clicks=0;
 cdp(f,p=>{const op=p.arguments[0].value;ops.push(op);
  if(op==='ref_relocation')return {relocated:false};if(op==='prepare_ref_click')return {ok:true};if(op==='confirm_ref')return {confirmed:true};
  if(op==='reveal_ref')return {rect:[60,30,20,30]};if(op==='rect_ref')return [60,30,20,30];
  if(op==='pointer_target')return {x:70,y:45};
  if(op==='input_visibility'||op==='arm_ref_delivery')return {visibility:'visible'};
  if(op==='probe_ref_delivery')return {global:{pointerdown:1,mousedown:1,click:1},target:{trustedClick:1}};
  if(op==='clear_ref_delivery')return {ok:true};
  throw Error('unexpected semantic dispatch');
 });
 await start(e);const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 e.interactionsFor=()=>({clickBoundTarget:async (_scope,{readTarget,guard})=>{
  guard();assert.equal((await readTarget()).x,70);assert.equal((await readTarget()).y,45);clicks++;f.inputEffect();
  return {ok:true,kind:'pointer-click'};
 }});
 const result=await e.execute({...action('a'),action:'ref_click',clickMode:'pointer',binding,snapshotId:'snap',ref:'button'});
 assert.equal(clicks,1);assert.equal(result.delivery,'confirmed');assert.equal(result.effect,'observed');
 assert.equal(result.popupOwnership,'uncertain');assert.equal(ops.filter(op=>op==='ref_click').length,0);
});
test('silent semantic pointer delivery falls back once and reports synthetic kind',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];let sends=0;
 cdp(f,p=>{
  const [op,payload]=p.arguments.map(item=>item.value);ops.push(op);
  if(op==='input_visibility'||op==='arm_ref_delivery')return {visibility:'visible'};
  if(op==='reveal_ref')return {rect:[60,30,20,30]};if(op==='rect_ref')return [60,30,20,30];
  if(op==='ref_relocation')return {relocated:false};if(op==='prepare_ref_click'||op==='clear_ref_delivery')return {ok:true};if(op==='confirm_ref')return {confirmed:true};
  if(op==='pointer_target')return {x:70,y:45};
  if(op==='probe_ref_delivery')return {global:{pointerdown:0,mousedown:0,click:0},target:{trustedClick:0}};
  if(op==='synthetic_ref_click'){f.inputEffect();return {clicked:true,kind:'dom-synthetic',delivery:'confirmed',fallbackReason:payload.fallbackReason};}
  throw Error('unexpected semantic operation');
 });await start(e);
 e.interactionsFor=()=>({clickBoundTarget:async()=>{sends++;}});
 const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 const result=await e.execute({...action('a'),action:'ref_click',clickMode:undefined,binding,snapshotId:'snap',ref:'button'});
 assert.equal(sends,1);assert.equal(ops.filter(op=>op==='synthetic_ref_click').length,1);
 assert.equal(result.kind,'dom-synthetic');assert.equal(result.fallbackReason,'pointer_input_not_delivered');
});
test('partial semantic pointer delivery is unknown without fallback',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),ops=[];
 cdp(f,p=>{
  const op=p.arguments[0].value;ops.push(op);
  if(op==='input_visibility'||op==='arm_ref_delivery')return {visibility:'visible'};
  if(op==='reveal_ref')return {rect:[60,30,20,30]};if(op==='rect_ref')return [60,30,20,30];
  if(op==='ref_relocation')return {relocated:false};if(op==='prepare_ref_click'||op==='clear_ref_delivery')return {ok:true};if(op==='confirm_ref')return {confirmed:true};
  if(op==='pointer_target')return {x:70,y:45};
  if(op==='probe_ref_delivery')return {global:{pointerdown:1,mousedown:0,click:0},target:{trustedClick:0}};
  throw Error('unexpected semantic operation');
 });await start(e);
 e.interactionsFor=()=>({clickBoundTarget:async()=>{f.inputEffect();return {ok:true};}});
 const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 const result=await e.execute({...action('a'),action:'ref_click',clickMode:undefined,binding,snapshotId:'snap',ref:'button'});
 assert.equal(result.clicked,false);assert.equal(result.outcomeUnknown,true);
 assert.equal(ops.includes('synthetic_ref_click'),false);
});

test('semantic production world invokes the resolved target handler after actionability checks',async t=>{
 const f=workspaceFixture(),e=new Executor(f.api),page=pageFixture('<button id="target">Target</button>');let clicked=0;
 t.after(page.close);const {node,window:pageWindow}=page;
 node.click=()=>{throw Error('synthetic click forbidden');};
 Object.assign(node,eventSurface());Object.assign(pageWindow,eventSurface());
 semanticCdp(f,page);await start(e);const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 // 中文注释：页面执行层只能返回落点，测试桩模拟 CDP 派发，不允许调用 node.click。
 e.interactionsFor=()=>({clickBoundTarget:async (_scope,{readTarget})=>{const point=await readTarget();assert.equal(point.x,11);assert.equal(point.y,11);for(const type of ['pointerdown','mousedown','click']){pageWindow.emit(type);node.emit(type);}clicked++;f.inputEffect();}});
 const request={...action('a'),clickMode:undefined,action:'ref_click',...page.token(binding)};
 const result=await e.execute(request);
 assert.equal(clicked,1);assert.equal(result.kind,'trusted-input');
 // 中文注释：准备成功后目标被禁用，真实 confirm_ref 必须在下一次派发前拒绝。
 pageWindow.__hermesAutomationOverlay.highlight.prepare=()=>{node.disabled=true;return {ok:true};};
 await assert.rejects(e.execute(request),error=>error.message==='TARGET_DISABLED'&&error.preDispatch===true);
 assert.equal(clicked,1);
});

test('semantic checkbox sets requested state once and verifies page state',async t=>{
 const f=workspaceFixture(),e=new Executor(f.api),page=pageFixture('<input id="target" type="checkbox" aria-label="Target">');let clicks=0;
 t.after(page.close);const {node,window:pageWindow}=page;
 node.click=()=>{throw Error('synthetic click forbidden');};
 Object.assign(node,eventSurface());Object.assign(pageWindow,eventSurface());
 // 中文注释：持久页面世界保留生产 v8 语义实例和点击计划中的目标身份。
 semanticCdp(f,page);await start(e);const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 // 中文注释：点击由交互器承担，页面世界只提供状态计划与派发后回读。
 e.interactionsFor=()=>({clickBoundTarget:async (_scope,{readTarget})=>{await readTarget();for(const type of ['pointerdown','mousedown','click']){pageWindow.emit(type);node.emit(type);}clicks++;node.checked=!node.checked;}});
 const request={...action('a'),action:'ref_set_checked',clickMode:undefined,...page.token(binding),checked:true};
 const first=await e.execute(request);assert.equal(first.checked,true);assert.equal(first.changed,true);assert.equal(first.verified,true);
 const repeat=await e.execute(request);assert.equal(repeat.checked,true);assert.equal(repeat.changed,false);assert.equal(repeat.verified,true);
 assert.equal(clicks,1);
});

test('native select supports Unicode labels, values, indexes and multi-select events',async t=>{
 const f=workspaceFixture(),e=new Executor(f.api),events=[];let reorder=false;
 const page=pageFixture('<select id="target" multiple aria-label="Target"><option value="a"> 甲 </option><option value="b">乙</option><option value="c">丙</option></select>');
 t.after(page.close);const {node}=page,options=[...node.options];
 node.addEventListener('input',event=>events.push([event.type,event.bubbles]));
 node.addEventListener('change',event=>{events.push([event.type,event.bubbles]);if(reorder)node.append(...[...node.options].reverse());});
 semanticCdp(f,page);await start(e);const binding=e.semanticBinding(e.tasks.get('a'),1,'loader');
 const request={...action('a'),action:'ref_select_option',...page.token(binding)};
 // 中文注释：先校验全部目标，再同步设置 selected 并派发冒泡 input/change；回执反映最终选项。
 const first=await e.execute({...request,by:'label',values:['甲','丙']});
 assert.equal(first.kind,'native-select');assert.equal(first.selectedCount,2);
 assert.deepEqual(JSON.parse(JSON.stringify(first.selectedOptions)),[{value:'a',label:'甲',index:0},{value:'c',label:'丙',index:2}]);
 assert.deepEqual(events,[['input',true],['change',true]]);
 const same=await e.execute({...request,by:'label',values:['甲','丙']});assert.equal(same.changed,false);assert.equal(events.length,4);
 const value=await e.execute({...request,by:'value',values:['b']});assert.equal(value.selectedOptions[0].value,'b');
 const index=await e.execute({...request,by:'index',values:[0,2]});assert.equal(index.selectedCount,2);
 const before=events.length;
 await assert.rejects(e.execute({...request,by:'value',values:['missing']}),/SELECT_OPTION_MISSING/);
 options[1].disabled=true;
 await assert.rejects(e.execute({...request,by:'value',values:['b']}),/SELECT_OPTION_DISABLED/);
 node.disabled=true;
 // 中文注释：真实资格描述在 settle 阶段更早拒绝禁用控件；仍精确校验错误与无派发。
 await assert.rejects(e.execute({...request,by:'value',values:['a']}),error=>error.message==='TARGET_DISABLED'&&error.preDispatch===true);
 assert.equal(events.length,before);assert.equal(options[0].selected,true);assert.equal(options[2].selected,true);
 // 中文注释：页面 change 回调重排选项后，回执仍报告当前索引，并标记核实结果未知。
 node.disabled=false;reorder=true;
 const reordered=await e.execute({...request,by:'value',values:['a']});
 assert.equal(reordered.verified,false);assert.equal(reordered.outcomeUnknown,true);
 assert.equal(reordered.selectedOptions[0].index,2);
});

test('normal popup-capable click preserves uncertain children, concurrent manual pages and startup tabs',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),events=await listeners(e),ops=[];
 cdp(f,p=>{
  const op=p.arguments[0].value;ops.push(op);
  if(op==='confirm_click')return {ok:true};
  assert.equal(op,'click');f.inputEffect();
  for(const id of [11,12]){f.tabs.set(id,{id,url:'https://example.com/child',openerTabId:1,windowId:7,groupId:-1});events.created({...f.tabs.get(id)});}
  return {clicked:true,kind:'dom-synthetic'};
 });
 await start(e);
 const result=await e.execute({...action('a','#button'),clickMode:undefined});
 assert.equal(result.clicked,true);assert.equal(result.popupOwnership,'uncertain');assert.deepEqual(ops,['confirm_click','click']);
 const done=await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 for(const id of [1,9,11,12]){assert.ok(f.tabs.has(id));assert.equal(e.leases.has(id),false);}
 assert.deepEqual(f.groups,[]);assert.deepEqual(f.removed,[]);
 assert.ok(done.unknownTabIds.includes(11));assert.ok(done.unknownTabIds.includes(12));
});

test('new_tab still requires an explicit idempotency request ID',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await start(e);
 await assert.rejects(e.execute({taskId:'a',generation:1,action:'new_tab',url:'https://example.com/',allowedOrigins:['https://example.com'],modeGeneration:2}),/INVALID_REQUEST/);
 assert.deepEqual(f.creates,[]);
});

test('parallel task children remain isolated through cancellation and late create',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);f.tabs.get(9).url='https://example.com/';cdp(f);
 await start(e,'a',[1]);await start(e,'b',[9]);let resume,entered;
 const gate=new Promise(r=>resume=r),started=new Promise(r=>entered=r),create=f.api.tabs.create;
 let blocked=false;f.api.tabs.create=async p=>{const tab=await create(p);if(!blocked){blocked=true;entered();await gate;}return tab;};
 const a=e.execute(action('a'));await started;
 const bWork=e.execute(action('b'));
 const cancel=e.release({taskId:'a',generation:1,closeAgentTabs:true});resume();
 await assert.rejects(a,/CANCELLED|stale generation/);const b=await bWork;await cancel;
 assert.ok(f.tabs.has(b.tabId));assert.ok(!f.tabs.has(3));assert.ok(f.tabs.has(1));assert.ok(f.tabs.has(9));
 await e.release({taskId:'b',generation:1,closeAgentTabs:true});assert.ok(!f.tabs.has(b.tabId));
});
