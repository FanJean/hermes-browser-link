import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {Executor} from '../../native-extension/core.mjs';
import {createAutomationOverlay} from '../../native-extension/automation-overlay.mjs';

const origin='https://example.test';
const task={id:'highlight-wiring',generation:3,instanceId:'fixture-browser',approvalScope:'fixture-owner',
  modeGeneration:1,allowedOrigins:[origin],tabIds:[7]};
const rects={
  '#save':{x:10,y:10,width:24,height:16},
  '#source':{x:10,y:40,width:18,height:18},
  '#target':{x:62,y:40,width:22,height:18},
};
const png=()=>{const bytes=Buffer.alloc(44);bytes.writeUInt32BE(100,16);bytes.writeUInt32BE(100,20);return bytes.toString('base64');};
const copy=value=>structuredClone(value);

function fixture({afterHighlight=null,afterHide=null,overlayEvents=true}={}){
  const dom=new JSDOM('<!doctype html><button id="save">Save</button><div id="source">Source</div><div id="target">Target</div>',
    {url:origin+'/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,document=window.document,events=[],calls=[],objects=new Map(),listeners=new Set();
  let executor;
  const attachShadow=window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow=function(init){return attachShadow.call(this,{...init,mode:'open'});};
  window.visualViewport=Object.assign(new window.EventTarget(),{scale:1,offsetLeft:0,offsetTop:0});
  Object.defineProperty(window,'innerWidth',{value:100,configurable:true});
  Object.defineProperty(window,'innerHeight',{value:100,configurable:true});
  Object.defineProperty(window,'devicePixelRatio',{value:1,configurable:true});
  for(const [selector,r] of Object.entries(rects)){
    const element=document.querySelector(selector);
    Object.defineProperty(element,'getBoundingClientRect',{configurable:true,value:()=>({x:r.x,y:r.y,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height,width:r.width,height:r.height})});
    Object.defineProperty(element,'getClientRects',{configurable:true,value:()=>[{...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height}]});
  }
  const hitTest=(x,y)=>Object.entries(rects).map(([selector,r])=>({selector,r,element:document.querySelector(selector)}))
    .find(({r})=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)?.element||null;
  document.elementFromPoint=(x,y)=>hitTest(x,y);
  document.elementsFromPoint=(x,y)=>{const hit=hitTest(x,y);return hit?[hit]:[];};
  const highlightHost=()=>document.querySelector('[data-hermes-interaction-highlight]');
  const highlightRects=()=>{
    const host=highlightHost();if(!host||host.style.display==='none')return [];
    return [...(host.shadowRoot?.querySelectorAll('[data-role="target"],[data-role="drag-start"],[data-role="drag-end"]')||[])]
      .filter(frame=>frame.style.display==='block')
      .map(frame=>({x:Number.parseFloat(frame.style.left),y:Number.parseFloat(frame.style.top),width:Number.parseFloat(frame.style.width),height:Number.parseFloat(frame.style.height)}));
  };
  const highlightVisible=()=>highlightRects().length>0;
  let observedHost=null,observedRectKey='';
  const observeHighlight=async()=>{
    const host=highlightHost(),now=highlightRects();
    if(host&&now.length){
      const key=JSON.stringify(now);
      if(host!==observedHost||key!==observedRectKey){events.push({type:'highlight',rects:copy(now)});observedHost=host;observedRectKey=key;afterHighlight?.(document);}
    }else if(observedHost){events.push({type:'highlight-clear'});observedHost=null;observedRectKey='';}
  };
  for(const [selector,name] of [['#save','click']])document.querySelector(selector).addEventListener(name,()=>events.push({type:'side-effect',name,highlightVisible:highlightVisible()}));
  const api={
    // 中文注释：合成浏览器模拟写动作前激活工作页。
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
        if(['DOM.enable','Target.setAutoAttach'].includes(method))return {};
        if(method==='Page.createIsolatedWorld')return {executionContextId:17};
        if(method==='Runtime.addBinding'){window.hermesOverlayCommand=()=>{};return {};}
        if(method==='Runtime.callFunctionOn'){
          let value;
          if(params.objectId){
            const receiver=objects.get(params.objectId);if(!receiver)throw Error('synthetic object unavailable');
            value=window.eval(`(${params.functionDeclaration})`).call(receiver);
          }else{
            const fn=window.eval(`(${params.functionDeclaration})`);
            value=fn(...(params.arguments||[]).map(item=>item.value));
          }
          await observeHighlight();
          if(params.arguments?.[0]?.value==='hide')afterHide?.(executor);
          return {result:{value:copy(value)}};
        }
        if(method==='Runtime.evaluate'){
          const value=window.eval(params.expression);await observeHighlight();return {result:{value:copy(value)}};
        }
        if(method==='DOM.getNodeForLocation'){
          const node=hitTest(params.x,params.y);if(!node)throw Error('no real DOM target at coordinate');
          const backendNodeId=100+objects.size;objects.set(`hit-${backendNodeId}`,node);return {backendNodeId};
        }
        if(method==='DOM.resolveNode')return {object:{objectId:`hit-${params.backendNodeId}`}};
        if(method==='Runtime.releaseObject')return {};
        if(method==='Page.captureScreenshot'){
          const hosts=[...document.querySelectorAll('[data-hermes-automation-overlay]')];
          if(hosts.some(host=>host.style.opacity!=='0'||host.style.display==='none'))throw Error('overlay visible in synthetic capture or not blocking');
          return {data:png()};
        }
        if(method==='Input.dispatchMouseEvent'){
          events.push({type:'side-effect',name:'pointer',event:params.type,highlightVisible:highlightVisible()});return {};
        }
        if(method==='Input.cancelDragging')return {};
        return {};
      },
    },
  };
  executor=new Executor(api);
  return {dom,window,document,events,calls,api,executor,highlightHost,highlightRects,highlightVisible};
}

const request=(action,extra={})=>({taskId:task.id,generation:task.generation,modeGeneration:2,tabId:7,action,allowedOrigins:task.allowedOrigins,...extra});
// 中文注释：可视高亮外扩 3px；指针命中仍使用原始元素边界。
const visualRect=rect=>({x:rect.x-3,y:rect.y-3,width:rect.width+6,height:rect.height+6});
async function authorizeFull(executor){await executor.approve(task);executor.setMode({...task,activeMode:'full',modeGeneration:2});}

 test('Executor click keeps one host for controls and paints the exact target before dispatch',async()=>{
  const f=fixture();await authorizeFull(f.executor);f.document.querySelector('#save').focus();
  const activeBefore=f.document.activeElement;
  try{
    await f.executor.execute(request('click',{selector:'#save'}));
    const hosts=[...f.document.querySelectorAll('[data-hermes-automation-overlay]')];
    assert.equal(hosts.length,1,'automation controls and interaction highlight must share one host');
    assert.equal(hosts[0].hasAttribute('data-hermes-interaction-highlight'),true);
    const buttons=[...hosts[0].shadowRoot.querySelectorAll('button')].map(button=>button.textContent);
    assert.deepEqual(buttons,['接管页面','退出接管','停止任务'],'the unified host must retain takeover, resume and stop');
    const highlights=f.events.filter(event=>event.type==='highlight');
    const click=f.events.find(event=>event.type==='side-effect'&&event.name==='click');
    assert.ok(highlights.length>0,'production action path must render a target highlight');
    assert.ok(f.events.indexOf(highlights[0])<f.events.indexOf(click),'highlight must be visible before the page click');
    assert.deepEqual(highlights[0].rects,[visualRect(rects['#save'])]);
    assert.equal(click.highlightVisible,true);
    assert.equal(f.document.activeElement,activeBefore,'decorative UI must not steal focus');
  }finally{f.dom.window.close();}
});

test('missing visual host cancels the click without changing the task permission mode',async()=>{
  const f=fixture({overlayEvents:false});await authorizeFull(f.executor);
  try{
    await assert.rejects(f.executor.execute(request('click',{selector:'#save'})),/INTERACTION_HIGHLIGHT_UNAVAILABLE/);
    assert.equal(f.events.some(event=>event.type==='side-effect'&&event.name==='click'),false,
      'the action must not dispatch when no target decoration surface is available');
    assert.equal(f.executor.tasks.get(task.id).revoked,false,'a decoration failure is not a permission revocation');
    assert.equal(f.executor.tasks.get(task.id).policy.activeMode,'full','a decoration failure must not broaden or revoke task permission');
  }finally{f.dom.window.close();}
});

test('target replaced after preview is revalidated and cannot receive the pending click',async()=>{
  let replaced=false;
  const f=fixture({afterHighlight:document=>{
    if(replaced)return;replaced=true;
    const target=document.querySelector('#save');target.replaceWith(target.cloneNode(true));
  }});
  await authorizeFull(f.executor);
  try{
    await assert.rejects(f.executor.execute(request('click',{selector:'#save'})),/INTERACTION_HIGHLIGHT|target|TARGET/);
    assert.equal(replaced,true,'the preview must become visible before replacement');
    assert.equal(f.events.some(event=>event.type==='side-effect'&&event.name==='click'),false,
      'a changed target must not receive the pending action');
  }finally{f.dom.window.close();}
});

test('coordinate drag resolves and highlights both real endpoints before the first pointer event',async()=>{
  const f=fixture();await authorizeFull(f.executor);
  try{
    const shot=await f.executor.execute(request('interaction.capture'));
    const from=await f.executor.execute(request('interaction.bounds',{screenshotId:shot.id,selector:'#source'}));
    const to=await f.executor.execute(request('interaction.bounds',{screenshotId:shot.id,selector:'#target'}));
    await f.executor.execute(request('interaction.drag_coordinates',{screenshotId:shot.id,
      from:{point:from.imageCenter,expectedRef:from.ref},to:{point:to.imageCenter,expectedRef:to.ref},steps:2}));
    const highlights=f.events.filter(event=>event.type==='highlight');
    const pointer=f.events.find(event=>event.type==='side-effect'&&event.name==='pointer');
    assert.ok(highlights.length>0,'coordinate drag must highlight its real endpoint elements');
    assert.deepEqual(highlights[0].rects,[visualRect(rects['#source']),visualRect(rects['#target'])]);
    assert.ok(f.events.indexOf(highlights[0])<f.events.indexOf(pointer));
    assert.equal(pointer.highlightVisible,true);
  }finally{f.dom.window.close();}
});

test('permission revocation after screenshot hide prevents capture and restores the unified host',async()=>{
  const f=fixture({afterHide:executor=>executor.revokeMode(task.id)});await authorizeFull(f.executor);
  try{
    await assert.rejects(f.executor.execute(request('screenshot')),/mode revoked|revoked/);
    assert.equal(f.calls.some(call=>call.method==='Page.captureScreenshot'),false,
      'the screenshot must not be captured after permission revocation');
    const host=f.document.querySelector('[data-hermes-automation-overlay]');
    assert.ok(host&&host.style.display!=='none'&&host.style.opacity!=='0','the unified host must be restored in finally');
  }finally{f.dom.window.close();}
});

test('overlay screenshot suppression leaves page elements that forge extension markers untouched',()=>{
  const dom=new JSDOM('<!doctype html><html><body><div id="page" data-hermes-automation-overlay></div></body></html>',{url:origin+'/'});
  const pageElement=dom.window.document.querySelector('#page');
  const overlay=createAutomationOverlay({document:dom.window.document,taskId:'t',generation:1,tabId:7,origin,
    onStop:async()=>({state:'unknown'}),onTakeover:async()=>({state:'unknown'}),onResume:async()=>({state:'unknown'})});
  const host=overlay.host;
  assert.equal(overlay.hide(),true);
  assert.equal(host.style.opacity,'0');
  assert.notEqual(host.style.display,'none','the transparent host must keep blocking pointer input');
  assert.notEqual(pageElement.style.opacity,'0','screenshot suppression must not alter page-controlled elements');
  assert.equal(overlay.restore(),true);
  dom.window.close();
});

test('遮罩恢复失败仍保留拦截节点',()=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:origin+'/'});
  const overlay=createAutomationOverlay({document:dom.window.document,taskId:'t',generation:1,tabId:7,origin,
    onStop:async()=>({state:'unknown'}),onTakeover:async()=>({state:'unknown'}),onResume:async()=>({state:'unknown'})});
  const host=dom.window.document.querySelector('[data-hermes-automation-overlay]');
  const realGetComputedStyle=dom.window.getComputedStyle.bind(dom.window);
  let restorationBlocked=false;
  dom.window.getComputedStyle=element=>element===host&&restorationBlocked?{display:'none'}:realGetComputedStyle(element);
  assert.equal(overlay.hide(),true);
  restorationBlocked=true;
  assert.equal(overlay.restore(),false,'failed restoration must be reported');
  assert.equal(host.isConnected,true);assert.equal(host.style.pointerEvents,'auto');overlay.remove();
  dom.window.close();
});

test('native build copies the interaction module and resolves its imports',async()=>{
  const scratch=await mkdtemp(path.join(tmpdir(),'highlight-wiring-'));
  try{
    const output=path.join(scratch,'native');
    // 中文注释：子进程路径使用已解码的本地文件名。
    const build=fileURLToPath(new URL('../../native-extension/build.mjs',import.meta.url));
    const run=spawnSync(process.execPath,[build,output],{encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,run.stderr);
    const files=await readdir(output);
    assert.ok(files.includes('interaction-highlight.mjs'),'the packaged runtime must include the newly imported module');
    const builtCore=await readFile(path.join(output,'core.mjs'),'utf8');
    assert.match(builtCore,/from '\.\/interaction-highlight\.mjs'/);
  }finally{await rm(scratch,{recursive:true,force:true});}
});

test('hidden page confirms mounted highlight without animation frames or activation',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 try{
  Object.defineProperty(f.document,'visibilityState',{value:'hidden'});
  f.window.requestAnimationFrame=()=>1;
  f.api.tabs.update=async()=>{throw Error('background action must not activate a tab');};
  await f.executor.execute(request('click',{selector:'#save'}));
  assert.equal(f.events.filter(event=>event.type==='side-effect').length,1);
 }finally{f.window.close();}
});

test('screenshot reuses frame discovery but inspects sensitive values twice',async()=>{
 const f=fixture();await authorizeFull(f.executor);
 try{
  await f.executor.execute(request('screenshot'));
  assert.equal(f.calls.filter(call=>call.method==='DOM.getDocument'&&call.params.depth===-1).length,1);
  assert.equal(f.calls.filter(call=>call.method==='Runtime.callFunctionOn'&&call.params.functionDeclaration.includes('function inspectPage(')).length,2);
 }finally{f.window.close();}
});
