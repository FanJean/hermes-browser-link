import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const mod = await import('../index.mjs').catch(()=>({}));
const scope={taskId:'a',generation:1};
test('coordinate click requires a live unobscured nonsensitive node and consumes screenshot',async t=>{
 const {page}=await fixture(t);const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope);
 const shot=await b.capture(scope),r={...scope,screenshotId:shot.id};
 const target=await b.bounds({...r,selector:'#target'});
 await page.evaluate(()=>document.querySelector('#target').addEventListener('click',()=>window.clicked=true));
 assert.equal(typeof b.clickCoordinates,'function','coordinate action missing');
 await b.clickCoordinates({...r,point:target.imageCenter,expectedRef:target.ref});
 assert.equal(await page.evaluate(()=>window.clicked),true);
 await assert.rejects(()=>b.clickCoordinates({...r,point:target.imageCenter,expectedRef:target.ref}),{code:'UNKNOWN_SCREENSHOT'});
});
test('hidden tab coordinate click uses confirmed DOM event and pointer drag refuses before dispatch',async t=>{
 const {page}=await fixture(t);
 // 中文注释：headless 的隔离世界可能仍报告 visible；固定适配器状态测试分支，真实有界面状态由页面链验收。
 await page.evaluate(()=>{window.received=[];target.addEventListener('click',event=>window.received.push(event.isTrusted));});
 const adapter=await mod.createPlaywrightAdapter(page),evaluate=adapter.evaluate.bind(adapter);
 adapter.evaluate=async(op,arg)=>{const result=await evaluate(op,arg);return op==='state'?{...result,visibility:'hidden'}:result;};
 const b=new mod.Interactions(adapter,scope);
 const shot=await b.capture(scope),request={...scope,screenshotId:shot.id};
 const target=await b.bounds({...request,selector:'#target'});
 // 中文注释：截图引用仍需 DOM 命中验证，隐藏页只更换交付方式，不激活标签页。
 const result=await b.clickCoordinates({...request,point:target.imageCenter,expectedRef:target.ref});
 assert.equal(result.kind,'dom-synthetic');assert.equal(result.delivery,'confirmed');
 assert.equal(result.fallbackReason,'background_tab_input_unreliable');
 assert.deepEqual(await page.evaluate(()=>window.received),[false]);
 const next=await b.capture(scope),bound=await b.bounds({...scope,screenshotId:next.id,selector:'#target'});
 const endpoint={point:bound.imageCenter,expectedRef:bound.ref};
 await assert.rejects(b.dragCoordinates({...scope,screenshotId:next.id,from:endpoint,to:endpoint}),{code:'BACKGROUND_POINTER_UNSUPPORTED',preDispatch:true});
 assert.deepEqual(await page.evaluate(()=>window.received),[false]);
});
test('silent CDP click is confirmed absent before one synthetic fallback',async t=>{
 const {page}=await fixture(t),adapter=await mod.createPlaywrightAdapter(page),send=adapter.send;
 await page.evaluate(()=>{window.received=[];target.addEventListener('click',event=>window.received.push(event.isTrusted));});
 // 中文注释：模拟 CDP 返回成功却未向渲染器送入任何事件，验证不能伪报可信点击。
 adapter.send=(method,params)=>method==='Input.dispatchMouseEvent'?Promise.resolve({}):send(method,params);
 const b=new mod.Interactions(adapter,scope),shot=await b.capture(scope),r={...scope,screenshotId:shot.id};
 const target=await b.bounds({...r,selector:'#target'});
 const result=await b.clickCoordinates({...r,point:target.imageCenter,expectedRef:target.ref});
 assert.equal(result.kind,'dom-synthetic');assert.equal(result.delivery,'confirmed');
 assert.equal(result.fallbackReason,'pointer_input_not_delivered');
 assert.deepEqual(await page.evaluate(()=>window.received),[false]);
});
test('partial CDP pointer delivery stays unknown and never repeats the click',async t=>{
 const {page}=await fixture(t),adapter=await mod.createPlaywrightAdapter(page),send=adapter.send;
 await page.evaluate(()=>{window.received=[];target.addEventListener('click',event=>window.received.push(event.isTrusted));});
 adapter.send=async(method,params)=>{
  if(method==='Input.dispatchMouseEvent'){
   if(params.type==='mousePressed')await page.evaluate(()=>target.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));
   return {};
  }
  return send(method,params);
 };
 const b=new mod.Interactions(adapter,scope),shot=await b.capture(scope),r={...scope,screenshotId:shot.id};
 const target=await b.bounds({...r,selector:'#target'});
 const result=await b.clickCoordinates({...r,point:target.imageCenter,expectedRef:target.ref});
 assert.equal(result.ok,false);assert.equal(result.outcomeUnknown,true);assert.equal(result.delivery,'partial');
 assert.deepEqual(await page.evaluate(()=>window.received),[]);
});
test('drag does not report success when CDP silently drops pointer events',async t=>{
 const {page}=await fixture(t);
 await page.setContent(await readFile(new URL('./fixture.html',import.meta.url),'utf8'));
 await page.evaluate(()=>scrollTo(0,500));
 const adapter=await mod.createPlaywrightAdapter(page),send=adapter.send;
 // 中文注释：CDP 命令返回成功但没有 pointerdown/up，拖动结果必须明确为未知。
 adapter.send=(method,params)=>method==='Input.dispatchMouseEvent'?Promise.resolve({}):send(method,params);
 const b=new mod.Interactions(adapter,scope),shot=await b.capture(scope),r={...scope,screenshotId:shot.id};
 const source=await b.bounds({...r,selector:'#source'}),target=await b.bounds({...r,selector:'#drop'});
 const result=await b.dragCoordinates({...r,from:{point:source.imageCenter,expectedRef:source.ref},to:{point:target.imageCenter,expectedRef:target.ref}});
 assert.equal(result.ok,false);assert.equal(result.outcomeUnknown,true);assert.equal(result.delivery,'unconfirmed');
 assert.equal(await page.evaluate(()=>results.pointer),false);
});
test('refs are bound to their screenshot, not reusable on a new capture',async t=>{
 const {page}=await fixture(t);const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope);
 const first=await b.capture(scope);const target=await b.bounds({...scope,screenshotId:first.id,selector:'#target'});
 const second=await b.capture(scope);
 await assert.rejects(()=>b.clickCoordinates({...scope,screenshotId:second.id,point:target.imageCenter,expectedRef:target.ref}),{code:'INVALID_NODE_REF'});
});
test('coordinate pointer drag reaches target in CSS coordinates after DPR and scroll conversion',async t=>{
 const {page}=await fixture(t);await page.setContent(await readFile(new URL('./fixture.html',import.meta.url),'utf8'));await page.evaluate(async()=>{scrollTo(0,500);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope),shot=await b.capture(scope),r={...scope,screenshotId:shot.id};
 const from=await b.bounds({...r,selector:'#source'}),to=await b.bounds({...r,selector:'#drop'});
 assert.equal(typeof b.dragCoordinates,'function','drag bridge missing');
 await b.dragCoordinates({...r,from:{point:from.imageCenter,expectedRef:from.ref},to:{point:to.imageCenter,expectedRef:to.ref}});
 assert.equal(await page.evaluate(()=>results.pointer),true);
 const events=await page.evaluate(()=>results.events);assert.equal(events.at(-1).x,430);assert.equal(events.at(-1).y,250);assert.ok(events.every(e=>e.trusted));
});
test('element drag supports pointer and explicit synthetic HTML5 without conflating trust',async t=>{
 const {page}=await fixture(t);await page.setContent(await readFile(new URL('./fixture.html',import.meta.url),'utf8'));await page.evaluate(()=>scrollTo(0,500));
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope);
 assert.equal(typeof b.dragElements,'function','element drag missing');
 let shot=await b.capture(scope);
 await b.dragElements({...scope,screenshotId:shot.id,source:'#source',target:'#drop',mode:'pointer'});
 assert.equal(await page.evaluate(()=>results.pointer),true);
 shot=await b.capture(scope);
 await b.dragElements({...scope,screenshotId:shot.id,source:'#htmlSource',target:'#htmlDrop',mode:'html5-synthetic'});
 assert.equal(await page.evaluate(()=>results.html5),true);
 assert.equal(await page.evaluate(()=>results.events.filter(e=>e.type==='drop').every(e=>!e.trusted)),true);
});
test('one bridge rejects overlapping capture/action requests',async t=>{
 const {page}=await fixture(t);const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope);
 const first=b.capture(scope);
 await assert.rejects(()=>b.capture(scope),{code:'INTERACTION_BUSY'});await first;
});
test('chrome.debugger adapter binds immutable tab target and fails after detach',async()=>{
 assert.equal(typeof mod.createChromeDebuggerAdapter,'function','chrome.debugger adapter missing');
 const calls=[],listeners=new Set();
 const api={sendCommand:async(target,method,params)=>{calls.push({target,method,params});return {};},onDetach:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)}};
 const target={tabId:12};const a=mod.createChromeDebuggerAdapter(api,target);target.tabId=99;
 await a.send('Page.enable',{});assert.equal(calls[0].target.tabId,12);
 for(const f of listeners) f({tabId:12},'canceled_by_user');
 await assert.rejects(()=>a.send('Page.enable',{}),{code:'ADAPTER_DETACHED'});
 a.close();assert.equal(listeners.size,0);
});

// 中文注释：连续定位不能在隔离世界永久保留旧节点；新截图也必须回收上一张截图的引用。
test('coordinate references are bounded in both adapter and page and cleared by a new capture',{timeout:30000},async t=>{
 const {page,context}=await fixture(t),session=await context.newCDPSession(page);let contextId;
 const adapter=mod.createCDPAdapter(async(method,params)=>{
  const reply=await session.send(method,params);
  if(method==='Page.createIsolatedWorld')contextId=reply.executionContextId;
  return reply;
 });
 adapter.screenshot=async()=>(await page.screenshot({type:'png',fullPage:false,scale:'device',caret:'initial'})).toString('base64');
 const b=new mod.Interactions(adapter,{...scope,ttlMs:30000});
 const shot=await b.capture(scope),request={...scope,screenshotId:shot.id},first=await b.bounds({...request,selector:'#target'});
 for(let i=0;i<256;i++)await b.bounds({...request,selector:'#target'});
 const count=async()=>(await session.send('Runtime.evaluate',{contextId,expression:'globalThis.__hermesInteractions.nodes.size',returnByValue:true})).result.value;
 assert.equal(await count(),256);
 await assert.rejects(()=>b.clickCoordinates({...request,point:first.imageCenter,expectedRef:first.ref}),{code:'INVALID_NODE_REF'});
 await b.capture(scope);assert.equal(await count(),0);
 await session.detach();
});
// 中文注释：回归真实 Chrome 对浏览器内部密码节点的 CDP 挂起，检查必须有界结束且不派发点击。
test('closed shadow DOM cannot conceal a sensitive input behind a safe host ref',{timeout:10000},async t=>{
 const {page}=await fixture(t);await page.evaluate(()=>{const host=document.querySelector('#target');const div=document.createElement('div');div.id='shadow';div.style.cssText=host.style.cssText+'position:absolute;left:100px;top:700px;width:100px;height:60px';host.replaceWith(div);div.attachShadow({mode:'closed'}).innerHTML='<input type="password" style="width:100px;height:60px;box-sizing:border-box">';});
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope);const shot=await b.capture(scope),r={...scope,screenshotId:shot.id},node=await b.bounds({...r,selector:'#shadow'});
 await assert.rejects(()=>b.clickCoordinates({...r,point:node.imageCenter,expectedRef:node.ref}),{code:'UNSUPPORTED_SHADOW_DOM'});
});
test('moving dragged element may cover its destination but not an unrelated overlay',async t=>{
 const {page}=await fixture(t);await page.setContent(await readFile(new URL('./fixture.html',import.meta.url),'utf8'));await page.evaluate(()=>{scrollTo(0,500);source.style.zIndex='10';let start;source.addEventListener('pointerdown',e=>{start={x:e.clientX,y:e.clientY};});source.addEventListener('pointermove',e=>{if(start&&e.buttons)source.style.transform=`translate(${e.clientX-start.x}px,${e.clientY-start.y}px)`;});});
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope),shot=await b.capture(scope);
 await b.dragElements({...scope,screenshotId:shot.id,source:'#source',target:'#drop',mode:'pointer'});
 assert.equal(await page.evaluate(()=>results.pointer),true);
 const rect=await page.locator('#source').boundingBox();assert.equal(rect.x+rect.width/2,430);assert.equal(rect.y+rect.height/2,250);
});
test('failed final target recheck cancels release away from destination',async t=>{
 const {page}=await fixture(t);await page.setContent(await readFile(new URL('./fixture.html',import.meta.url),'utf8'));await page.evaluate(()=>{scrollTo(0,500);source.addEventListener('pointermove',e=>{if(e.buttons&&e.clientX>300){cover.style.cssText='left:360px;top:700px;width:140px;height:100px;z-index:30';}});});
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope),shot=await b.capture(scope);
 await assert.rejects(()=>b.dragElements({...scope,screenshotId:shot.id,source:'#source',target:'#drop',mode:'pointer'}),{code:'TARGET_OCCLUDED'});
 assert.equal(await page.evaluate(()=>results.pointer),false,'aborted drag must not release over destination');
});
test('hover-induced scroll invalidates a screenshot even for a fixed target',async t=>{
 const {page}=await fixture(t);await page.evaluate(()=>{target.style.cssText='position:fixed;left:100px;top:200px';target.addEventListener('pointerenter',()=>scrollTo(0,510));target.addEventListener('click',()=>window.clicked=true);});
 const b=new mod.Interactions(await mod.createPlaywrightAdapter(page),scope),shot=await b.capture(scope),r={...scope,screenshotId:shot.id},node=await b.bounds({...r,selector:'#target'});
 await assert.rejects(()=>b.clickCoordinates({...r,point:node.imageCenter,expectedRef:node.ref}),{code:'STALE_SCREENSHOT'});
 assert.notEqual(await page.evaluate(()=>window.clicked),true);
});
export async function fixture(t) {
 const dir=await mkdtemp(path.join(process.env.TMPDIR||os.tmpdir(),'interactions-test-'));
 // 中文注释：只用临时配置，显式禁用系统钥匙串访问并保留真实 HOME。
 const context=await chromium.launchPersistentContext(dir,{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:{width:800,height:600},deviceScaleFactor:2,args:['--use-mock-keychain','--password-store=basic'],env:{...process.env,HOME:process.env.HOME}});
 t.after(async()=>{await context.close();await rm(dir,{recursive:true,force:true});});
 const page=context.pages()[0]; await page.setContent('<style>body{margin:0;height:2000px}#target{position:absolute;left:100px;top:700px;width:100px;height:60px}</style><button id="target">Target</button>');
 await page.evaluate(async()=>{scrollTo(0,500);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 return {page,context};
}
test('capture binds screenshot to task, document, viewport, DPR and scroll',async t=>{
 assert.equal(typeof mod.createPlaywrightAdapter,'function','Playwright adapter must exist');
 const {page}=await fixture(t);
 const bridge=new mod.Interactions(await mod.createPlaywrightAdapter(page),{taskId:'a',generation:1});
 const shot=await bridge.capture({taskId:'a',generation:1});
 assert.equal(shot.taskId,'a'); assert.equal(shot.generation,1);
 assert.ok(shot.documentId); assert.equal(shot.viewport.width,800);assert.equal(shot.dpr,2);assert.equal(shot.scroll.y,500);
 assert.equal(shot.image.width,1600);assert.equal(shot.image.height,1200);
 const target=await bridge.bounds({taskId:'a',generation:1,screenshotId:shot.id,selector:'#target'});
 assert.equal(target.rect.y,200);assert.equal(target.imageCenter.y,460);
});
