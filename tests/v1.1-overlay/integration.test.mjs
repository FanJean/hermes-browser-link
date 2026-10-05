import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor,pageAction} from '../../native-extension/core.mjs';
import {createPageSemantics} from '../../page-semantics/index.js';
import {createCDPAdapter} from '../../browser-interactions/index.mjs';

const url='https://example.com/';
function fixture(){
 const calls=[], listeners=new Set(), tab={id:1,url,windowId:4};
 const api={tabs:{get:async()=>({...tab})},debugger:{
  onEvent:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},
  onDetach:{addListener(){},removeListener(){}},
  attach:async()=>{},detach:async()=>{},
  sendCommand:async(_,method,params={})=>{
   calls.push([method,params]);
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url,loaderId:'doc-1'}}};
   if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
   if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
   if(method==='Page.createIsolatedWorld')return {executionContextId:17};
   if(method==='Runtime.callFunctionOn')return {result:{value:params.functionDeclaration.includes('globalThis.__hermesSemanticLibrary={')||params.functionDeclaration.includes('createAutomationOverlay')||params.functionDeclaration.includes('overlay.withHidden')?true:{hasSensitiveValue:false,ok:true}}};
   if(method==='Page.captureScreenshot')return {data:'png'};
   return {};
  }
 }};
 return {api,calls,tab,listeners};
}
const task={id:'work',generation:2,instanceId:'browser',approvalScope:'owner',allowedOrigins:['https://example.com'],tabIds:[1]};
const request=action=>({taskId:'work',generation:2,tabId:1,action,allowedOrigins:task.allowedOrigins});

test('production executor installs isolated overlay only after authorized tab/frame readback and cleans on leave',async()=>{
 const {api,calls,tab}=fixture(),e=new Executor(api);
 await assert.rejects(e.execute(request('snapshot')),/stale generation/);
 assert.equal(calls.length,0);
 await e.approve(task);
 await e.execute(request('snapshot'));
 const worlds=calls.filter(([m])=>m==='Page.createIsolatedWorld').map(([,p])=>p.worldName);
 assert.ok(worlds.some(x=>x.startsWith('hermes-automation-overlay')));
 const inject=calls.find(([m,p])=>m==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('createAutomationOverlay'));
 assert.ok(inject);
 tab.url='https://other.test/';await e.tabEvent(1,'navigated',tab.url);
 assert.ok(calls.some(([m,p])=>m==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('overlay.remove')));
 // 离开授权网站只冻结该页：任务、租约保持，页面动作被拒绝，导航回授权网站后恢复。
 assert.equal(e.tasks.get('work').revoked,false);
 assert.equal(e.leases.get(1),'work');
 await assert.rejects(e.execute(request('snapshot')),/TAB_OUT_OF_SCOPE/);
 tab.url=url;await e.tabEvent(1,'navigated',tab.url);
 assert.equal(e.tasks.get('work').offScopeTabs.has(1),false);
 await e.execute(request('snapshot'));
});

test('both screenshot paths hide overlay before capture and restore even on capture failure',async()=>{
 const {api,calls}=fixture(),e=new Executor(api);await e.approve(task);
 const direct=await e.execute(request('screenshot'));assert.equal(direct.data,'png');
 const sequence=calls.filter(([m,p])=>m==='Page.captureScreenshot'||m==='Runtime.callFunctionOn'&&['hide','restore'].includes(p.arguments?.[0]?.value));
 assert.deepEqual(sequence.map(([m])=>m),['Runtime.callFunctionOn','Page.captureScreenshot','Runtime.callFunctionOn']);
 // A thrown capture still performs the restore call.
 api.debugger.sendCommand=async(t,m,p)=>{if(m==='Page.captureScreenshot')throw Error('capture failed');return fixtureResponse(m,p);};
 function fixtureResponse(m,p){calls.push([m,p]);if(m==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url,loaderId:'doc-1'}}};if(m==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};if(m==='Page.createIsolatedWorld')return {executionContextId:17};if(m==='Runtime.callFunctionOn')return {result:{value:p.functionDeclaration.includes('overlay.withHidden')?true:{hasSensitiveValue:false}}};return {};}
 await assert.rejects(e.execute(request('screenshot')),/capture failed/);
 assert.equal(calls.filter(([m,p])=>m==='Runtime.callFunctionOn'&&['hide','restore'].includes(p.arguments?.[0]?.value)).length,4);
});

test('failed execution keeps overlay visible with unknown status instead of stale running',async()=>{
 const {api,calls}=fixture();const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,m,p)=>{if(m==='Page.captureScreenshot')throw Error('camera unavailable');return send(target,m,p);};
 const e=new Executor(api);await e.approve(task);
 await assert.rejects(e.execute(request('screenshot')),/camera unavailable/);
 const status=calls.filter(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='update').at(-1)?.[1].arguments[1].value.update.state;
 assert.equal(status,'unknown');
});

test('pre-dispatch rejection re-blocks the overlay instead of leaving the dispatch pass-through open',async()=>{
 const {api,calls}=fixture();
 const e=new Executor(api);await e.approve(task);
 await e.execute(request('snapshot'));
 e.perform=async()=>{await e.overlayCall(1,[...e.tasks.get('work').overlays.values()][0],'update',{update:{state:'running',step:'ref_click'}});throw Object.assign(Error('TARGET_OCCLUDED'),{preDispatch:true});};
 await assert.rejects(e.execute(request('ref_click')),/TARGET_OCCLUDED/);
 await new Promise(resolve=>setImmediate(resolve));
 const states=calls.filter(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='update').map(([,p])=>p.arguments[1].value.update);
 assert.deepEqual(states.at(-1),{state:'waiting'});
});
test('screenshot refuses capture when the page cannot confirm the overlay is hidden',async()=>{
 const {api}=fixture();let captured=false;
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,m,p)=>{
  if(m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='hide')return {result:{value:false}};
  if(m==='Page.captureScreenshot')captured=true;
  return send(target,m,p);
 };
 const e=new Executor(api);await e.approve(task);
 await assert.rejects(e.execute(request('screenshot')),/overlay hide failed/);
 assert.equal(captured,false);
});

test('production CDP declarations create and restore a real overlay in an isolated synthetic world',async()=>{
 const dom=new JSDOM('<!doctype html><button id="real">Real</button>',{url,runScripts:'outside-only'});
 const {window}=dom,{api}=fixture();window.hermesOverlayCommand=()=>{};
 api.debugger.sendCommand=async(_,method,params={})=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url,loaderId:'doc-1'}}};
  if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[]}};
  if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
  if(method==='Page.createIsolatedWorld')return {executionContextId:17};
  if(method==='Runtime.callFunctionOn'){
   try{return {result:{value:window.eval(`(${params.functionDeclaration})(${params.arguments.map(a=>JSON.stringify(a.value)).join(',')})`)}};}
   catch(error){throw Error(`synthetic CDP: ${error.message}`);}
  }
  if(method==='Page.captureScreenshot'){
   const host=window.document.querySelector('[data-hermes-automation-overlay]');
   // 截图时遮罩透明但仍在，继续拦截点击。
   assert.equal(host?.style.opacity,'0');assert.notEqual(host.style.display,'none');
   return {data:'png'};
  }
  return {};
 };
 const e=new Executor(api);await e.approve(task);
 await e.execute(request('screenshot'));
 assert.ok(window.document.querySelector('[data-hermes-automation-overlay]'));
 assert.notEqual(window.document.querySelector('[data-hermes-automation-overlay]').style.opacity,'0');
 await e.release({taskId:'work',generation:2,closeAgentTabs:false});
 assert.equal(window.document.querySelector('[data-hermes-automation-overlay]'),null);
 dom.window.close();
});

// 中文注释：跨源框架不阻断组合读取，但不在该框架创建隔离世界；全框架操作仍保留来源校验。
test('semantic snapshot skips unrelated cross-origin frames without granting their action authority',async()=>{
 const {api,calls}=fixture(),e=new Executor(api);await e.approve(task);
 await e.execute({...request('semantic_snapshot'),options:{mode:'content',composed:true}});
 const semantic=calls.find(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[1]?.value?.options?.composed===true)?.[1];
 assert.equal(semantic.arguments[1].value.options.composed,true);
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(t,m,p)=>m==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url,loaderId:'doc-1'},childFrames:[{frame:{id:'foreign',url:'https://other.test/'}}]}}:send(t,m,p);
 await e.execute({...request('semantic_snapshot'),options:{composed:true}});
 assert(!calls.some(([m,p])=>m==='Page.createIsolatedWorld'&&p.frameId==='foreign'));
 await assert.rejects(e.checkedFrameTree({tabId:1},e.tasks.get('work'),()=>{},true),/frame origin denied/);
});

test('interaction.capture hides overlay throughout state/screenshot/state, then restores',async()=>{
 const {api,calls}=fixture();const e=new Executor(api);await e.approve(task);
 const image=Buffer.alloc(44);image.writeUInt32BE(100,16);image.writeUInt32BE(50,20);
 const state={token:'doc',revision:0,url,viewport:{width:100,height:50},dpr:1,scroll:{x:0,y:0},visual:{scale:1,x:0,y:0}};
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,m,p)=>{
  if(m==='Runtime.evaluate'){calls.push([m,p]);return {result:{value:state}};}
  if(m==='Page.captureScreenshot'){calls.push([m,p]);return {data:image.toString('base64')};}
  return send(target,m,p);
 };
 const result=await e.execute(request('interaction.capture'));
 assert.equal(result.image.width,100);
 const ops=calls.filter(([m,p])=>m==='Runtime.callFunctionOn'&&['hide','restore'].includes(p.arguments?.[0]?.value)||m==='Page.captureScreenshot');
 assert.deepEqual(ops.map(([m,p])=>m==='Page.captureScreenshot'?'capture':p.arguments[0].value),['hide','capture','restore']);
});

test('execution publishes running state and navigation keeps the old document overlay until the new page takes over',async()=>{
 const {api,calls,tab}=fixture(),e=new Executor(api);
 api.tabs.update=async(id,{url:next})=>{
  assert.equal(calls.some(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='remove'),false,'old page stays blocked while navigating');
  assert.ok(calls.some(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='update'&&p.arguments?.[1]?.value?.update?.step==='navigate'));
  tab.url=next;return {...tab};
 };
 await e.approve(task);await e.execute(request('snapshot'));
 const running=calls.find(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='scope-running'&&p.arguments?.[1]?.value?.update?.state==='running');
 assert.ok(running);
 e.setMode({...task,modeGeneration:2,activeMode:'full'});
 await e.execute({...request('navigate'),url:'https://example.com/next',modeGeneration:2});
});

test('overlay stop binding cannot mark stopped without trusted host fence/readback',async()=>{
 const {api,calls,listeners}=fixture();let reply=null;
 const e=new Executor(api,()=>{},{onOverlayCommand:async()=>({state:'stopped',verified:false,taskId:'work',generation:2})});
 await e.approve(task);await e.execute(request('snapshot'));
 const inject=calls.find(([m,p])=>m==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('createAutomationOverlay'))[1];
 const nonce=inject.arguments[0].value.nonce;
 api.debugger.sendCommand=async(_,m,p)=>{if(m==='Runtime.callFunctionOn'&&p.arguments[0].value==='reply')reply=p.arguments[1].value.result;return {result:{value:true}};};
 const evt={name:'hermesOverlayCommand',executionContextId:17,payload:JSON.stringify({nonce,commandId:1,kind:'stop'})};
 for(const listener of listeners)listener({tabId:1},'Runtime.bindingCalled',evt);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(reply,{state:'unknown'});assert.equal(e.tasks.get('work').revoked,false);
});

test('stop intent fences new local actions while trusted host readback is pending',async()=>{
 const {api,calls,listeners}=fixture();let pending,finish;
 const began=new Promise(r=>pending=r),gate=new Promise(r=>finish=r);
 const e=new Executor(api,()=>{},{onOverlayCommand:async()=>{pending();await gate;return {state:'unknown'};}});
 await e.approve(task);await e.execute(request('snapshot'));
 const nonce=calls.find(([m,p])=>m==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('createAutomationOverlay'))[1].arguments[0].value.nonce;
 for(const listener of listeners)listener({tabId:1},'Runtime.bindingCalled',{name:'hermesOverlayCommand',executionContextId:17,payload:JSON.stringify({nonce,commandId:1,kind:'stop'})});
 await began;
 await assert.rejects(e.execute(request('snapshot')),/stop|fenc/i);
 finish();
});

test('overlay host is absent from legacy snapshot and semantic traversal, while unchanged accessible identity retains refs',()=>{
 const dom=new JSDOM('<!doctype html><button id="real" aria-label="Before">Before</button><div data-hermes-automation-overlay><button>Stop</button></div>',{url});
 const {window}=dom,doc=window.document;Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return [{width:1,height:1}]}});
 const old={document:globalThis.document,location:globalThis.location};globalThis.document=doc;globalThis.location=window.location;
 try{
  assert.deepEqual(pageAction('snapshot',null,null,null,['https://example.com']).elements.map(x=>x.text),['Before']);
  const sem=createPageSemantics({document:doc,taskId:'t',documentId:'d',leaseId:'l'});
  const snap=sem.snapshot({mode:'interactive',budget:3000});assert.equal(snap.items.length,1);
  doc.querySelector('[data-hermes-automation-overlay]').setAttribute('style','display:none');
  assert.equal(sem.resolve({...snap.binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref}).id,'real');
  doc.querySelector('#real').textContent='After';
  assert.equal(sem.resolve({...snap.binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref}).id,'real');
  sem.revoke();
 }finally{globalThis.document=old.document;globalThis.location=old.location;dom.window.close();}
});

test('CDP coordinate hit-test rejects an overlay control rather than clicking through it',async()=>{
 const calls=[],dom=new JSDOM('<!doctype html><div data-hermes-automation-overlay></div>',{url,runScripts:'outside-only'});
 const {window}=dom,button=window.document.querySelector('div').attachShadow({mode:'closed'}).appendChild(window.document.createElement('button'));
 const adapter=createCDPAdapter(async(m,p)=>{
  calls.push([m,p]);
  if(m==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'doc'}}};
  if(m==='Page.createIsolatedWorld')return {executionContextId:3};
  if(m==='Runtime.evaluate')return {result:{value:{token:'t',scroll:{x:0,y:0}}}};
  if(m==='DOM.getNodeForLocation')return {backendNodeId:11};
  if(m==='DOM.resolveNode')return {object:{objectId:'overlay-button'}};
  if(m==='Runtime.callFunctionOn')return {result:{value:window.eval(`(${p.functionDeclaration})`).call(button)}};
  return {};
 });
 await assert.rejects(adapter.verifyHit({x:10,y:10}),/UNSUPPORTED_SHADOW_DOM|OVERLAY_OCCLUDED/);
 assert.ok(calls.some(([m])=>m==='Runtime.releaseObject'));
 dom.window.close();
});

test('interaction revision ignores overlay-only mutations but retains genuine page invalidation',async()=>{
 const dom=new JSDOM('<!doctype html><button id="real">Before</button><div data-hermes-automation-overlay></div>',{url,runScripts:'outside-only'});
 const {window}=dom,doc=window.document,old={document:globalThis.document,location:globalThis.location,MutationObserver:globalThis.MutationObserver};
 window.visualViewport={scale:1,offsetLeft:0,offsetTop:0};
 globalThis.document=doc;globalThis.location=window.location;globalThis.MutationObserver=window.MutationObserver;
 try{
  const send=async(m,p)=>{if(m==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'d'}}};if(m==='Page.createIsolatedWorld')return {executionContextId:2};if(m==='Runtime.evaluate')return {result:{value:window.eval(p.expression)}};};
  const adapter=createCDPAdapter(send),before=await adapter.evaluate('state');
  doc.querySelector('[data-hermes-automation-overlay]').append(doc.createElement('span'));
  assert.equal((await adapter.evaluate('state')).revision,before.revision);
  doc.querySelector('#real').textContent='After';
  assert.ok((await adapter.evaluate('state')).revision>before.revision);
 }finally{Object.assign(globalThis,old);dom.window.close();}
});

test('same-document URL rewrites keep the overlay and snapshot document; real navigations re-cover the page',async()=>{
 const {api,calls,tab}=fixture(),e=new Executor(api);await e.approve(task);
 await e.execute(request('snapshot'));
 const doc=e.docs.get(1)||0,entry=e.tasks.get('work').overlays.get(1);
 tab.url='https://example.com/?__gmitm=abc';await e.tabEvent(1,'navigated',tab.url,{status:'loading',urlChanged:true});
 assert.equal(e.docs.get(1)||0,doc,'pushState/replaceState must not look like a new document');
 assert.equal(e.tasks.get('work').overlays.get(1),entry);
 // A real navigation (new loaderId) invalidates and immediately re-covers the page.
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,m,p)=>m==='Page.getFrameTree'?(calls.push([m,p]),{frameTree:{frame:{id:'main',url,loaderId:'doc-2'}}}):send(target,m,p);
 await e.tabEvent(1,'navigated',tab.url,{status:'complete',urlChanged:false});
 assert.equal(e.docs.get(1),doc+1);
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e.tasks.get('work').overlays.get(1)?.documentId,'doc-2');
 assert.ok(calls.some(([m,p])=>m==='Page.addScriptToEvaluateOnNewDocument'&&p.worldName==='hermes-automation-preveil'&&p.source.includes('https://example.com')));
});

test('DOM ready re-covers a new document before the page finishes loading',async()=>{
 const {api,tab}=fixture(),e=new Executor(api);await e.approve(task);
 await e.execute(request('snapshot'));
 const doc=e.docs.get(1)||0;
 const send=api.debugger.sendCommand;
 // 页面一直停在加载中（广告、长连接），不会等到 complete。
 api.debugger.sendCommand=async(target,m,p)=>m==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url,loaderId:'doc-3'}}}:send(target,m,p);
 await e.tabEvent(1,'navigated',tab.url,{status:'dom_ready',urlChanged:false});
 assert.equal(e.docs.get(1),doc+1,'a new document still invalidates old refs');
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e.tasks.get('work').overlays.get(1)?.documentId,'doc-3');
});

test('failed back navigation keeps the current page covered',async()=>{
 const {api,calls}=fixture(),e=new Executor(api);await e.approve(task);
 await e.execute(request('snapshot'));
 e.setMode({...task,modeGeneration:2,activeMode:'full'});
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,m,p)=>m==='Page.getNavigationHistory'?{currentIndex:1,entries:[{url:'https://example.com/prev'},{url}]}:send(target,m,p);
 api.tabs.goBack=async()=>{throw Error('Cannot find a next page in history.');};
 await assert.rejects(e.execute({...request('back'),modeGeneration:2}),/history/);
 assert.equal(calls.some(([m,p])=>m==='Runtime.callFunctionOn'&&p.arguments?.[0]?.value==='remove'),false);
 assert.ok(e.tasks.get('work').overlays.get(1));
});

// 中文注释：覆盖执行器外层截图清理，不能只验证页面 overlay.restore 自身保留 host。
test('截图恢复失败后执行器仍保留页面输入拦截',async()=>{
 const dom=new JSDOM('<!doctype html><button>页面</button>',{url,runScripts:'outside-only'}),{api}=fixture();
 const send=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,method,params={})=>{
  if(method==='Runtime.addBinding'){dom.window.hermesOverlayCommand=()=>{};return {};}
  if(method==='Runtime.callFunctionOn')return {result:{value:dom.window.eval(`(${params.functionDeclaration})`)(...(params.arguments||[]).map(item=>item.value))}};
  return send(target,method,params);
 };
 const e=new Executor(api);await e.approve(task);const t=e.tasks.get(task.id);
 await e.lock(1,()=>e.ensureOverlay(t,1,{tabId:1},()=>{}));
 const entry=t.overlays.get(1),host=dom.window.document.querySelector('[data-hermes-automation-overlay]');
 try{
  await assert.rejects(e.captureWithoutDecorations(t,1,entry,()=>{},async()=>{
   const computed=dom.window.getComputedStyle.bind(dom.window);
   dom.window.getComputedStyle=node=>node===host?{display:'block',opacity:'0'}:computed(node);
   return {data:'不应返回的截图'};
  }),/overlay restore failed/);
  assert.equal(host.isConnected,true,'恢复失败不能删除拦截层');
  assert.equal(host.style.pointerEvents,'auto');assert.equal(t.overlays.get(1),entry);
 }finally{dom.window.__hermesAutomationOverlay?.overlay.remove();dom.window.close();}
});

// 中文注释：截图回执丢失时必须在桥接超时之前恢复遮罩并退出，迟到结果不能作为成功返回。
test('截图回执超时后恢复遮罩并丢弃迟到结果',async context=>{
 const {createAutomationOverlay}=await import('../../native-extension/automation-overlay.mjs');
 const dom=new JSDOM('<!doctype html><button>页面</button>',{url});
 const overlay=createAutomationOverlay({document:dom.window.document,taskId:'timed',generation:1,tabId:7,origin:'https://example.com',onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});
 const entry={overlay},t={id:'timed',generation:1,overlays:new Map([[7,entry]])},e=new Executor({tabs:{},debugger:{}});
 e.overlayCall=async(_tab,_entry,op)=>op==='hide'?overlay.hide():op==='restore'?overlay.restore():false;
 context.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 let finish,result;const pending=new Promise(resolve=>{finish=resolve;});
 const capture=e.captureWithoutDecorations(t,7,entry,()=>{},()=>pending).then(value=>{result={value};},error=>{result={error};});
 try{
  for(let i=0;i<6;i++)await Promise.resolve();assert.equal(overlay.host.style.opacity,'0');
  context.mock.timers.tick(8001);for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(result?.error?.message,'SCREENSHOT_TIMEOUT');assert.equal(overlay.host.isConnected,true);assert.equal(overlay.host.style.pointerEvents,'auto');assert.notEqual(overlay.host.style.opacity,'0');
 }finally{finish({data:'迟到的截图'});await capture;overlay.remove();dom.window.close();}
});

// 中文注释：CSS 伪元素的真实宿主仍须通过浮层和 Shadow 检查，不能因为有 element 属性就放行。
for(const kind of ['public','overlay','missing'])test(`CDP CSSPseudoElement 宿主复核 ${kind}`,async()=>{
 const dom=new JSDOM('<button>公开</button><div data-hermes-automation-overlay><button>浮层</button></div>',{url,runScripts:'outside-only'}),calls=[];
 const element=kind==='missing'?null:dom.window.document.querySelector(kind==='overlay'?'div button':'button');
 const adapter=createCDPAdapter(async(m,p)=>{
  calls.push(m);
  if(m==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'doc'}}};
  if(m==='Page.createIsolatedWorld')return {executionContextId:3};
  if(m==='Runtime.evaluate')return {result:{value:{token:'t',scroll:{x:0,y:0}}}};
  if(m==='DOM.getNodeForLocation')return {backendNodeId:11};
  if(m==='DOM.resolveNode')return {object:{objectId:'pseudo',className:'CSSPseudoElement'}};
  if(m==='Runtime.callFunctionOn'){
   try{return {result:{value:dom.window.eval(`(${p.functionDeclaration})`).call({element},...(p.arguments||[]).map(a=>a.value))}};}
   catch{return {exceptionDetails:{text:'fixture failure'}};}
  }
  return {};
 });
 try{if(kind==='public')await adapter.verifyHit({x:10,y:10});else await assert.rejects(adapter.verifyHit({x:10,y:10}),kind==='missing'?/HIT_RECHECK_FAILED/:/UNSUPPORTED_SHADOW_DOM/);assert(calls.includes('Runtime.releaseObject'));}finally{dom.window.close();}
});
