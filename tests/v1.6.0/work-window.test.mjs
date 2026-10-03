// 中文注释：只使用合成浏览器 API 和离线 DOM，不调用 git/rg，也不访问用户浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Interactions} from '../../browser-interactions/index.mjs';
import {WorkWindow} from '../../native-extension/work-window.mjs';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {effectProbe,observeInputEffect,NO_EFFECT_HINT} from '../../native-extension/action-effects.mjs';
function fixture(){
 let stored={},next=10;const tabs=new Map(),windows=new Map(),calls=[];
 const api={runtime:{getURL:p=>`chrome-extension://fixture/${p}`},storage:{local:{get:async()=>stored,set:async v=>{stored={...stored,...v}}}},
  tabs:{get:async id=>{if(!tabs.has(id))throw Error(`No tab with id: ${id}.`);return {...tabs.get(id)}},update:async(id,p)=>{calls.push(['tabs.update',id,p]);for(const t of tabs.values())if(t.windowId===tabs.get(id).windowId)t.active=t.id===id;return tabs.get(id)}},
  windows:{get:async id=>{if(!windows.has(id))throw Error('No window');return windows.get(id)},create:async p=>{calls.push(['windows.create',p]);const id=next++,tab={id:next++,windowId:id,url:p.url,active:true};tabs.set(tab.id,tab);const win={id,tabs:[tab]};windows.set(id,win);return win}}};
 return {api,tabs,windows,calls};
}
test('并发任务只创建一个独立窗口，不聚焦、不最小化，关闭后重建',async()=>{
 const f=fixture(),w=new WorkWindow(f.api);const ids=await Promise.all([w.ensure(),w.ensure(),w.ensure()]);
 assert.equal(new Set(ids).size,1);assert.deepEqual(f.calls,[['windows.create',{url:'chrome-extension://fixture/work-window.html',type:'normal',focused:false,state:'normal'}]]);
 const restored=new WorkWindow(f.api);assert.equal(await restored.ensure(),ids[0]);
 f.windows.delete(ids[0]);assert.notEqual(await w.ensure(),ids[0]);assert.equal(f.calls.length,2);
});
test('持久编号指向用户页面时不采用该窗口',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure();const tab=[...f.tabs.values()][0];tab.url='https://fixture.test';
 assert.notEqual(await w.ensure(),id);
});
test('同窗口切前台加输入串行，独立窗口和只读不阻塞，不聚焦窗口',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),windowId=await w.ensure();
 f.tabs.set(1,{id:1,windowId,active:false});f.tabs.set(2,{id:2,windowId,active:false});f.tabs.set(3,{id:3,windowId:99,active:false});
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),events=[];
 const a=w.input(windowId,1,()=>{},async()=>{events.push('a');started();await gate;events.push('a-end')});await ready;
 const b=w.input(windowId,2,()=>{},async()=>events.push('b'));
 await w.input(99,3,()=>{},async()=>events.push('independent'));
 const native=Object.create(NativeWorkspaces.prototype);native.workWindow=w;
 await native.withInput({workWindowMode:'separate'}, {action:'snapshot'},()=>{},async()=>events.push('read'));
 assert.deepEqual(events,['a','independent','read']);release();await Promise.all([a,b]);assert.deepEqual(events,['a','independent','read','a-end','b']);
 assert.ok(f.calls.filter(c=>c[0]==='tabs.update').every(c=>JSON.stringify(c[2])==='{"active":true}'));
});
test('current 配置不切前台；拖走的页不在原工作窗口切前台',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure();f.tabs.set(2,{id:2,windowId:99,groupId:3,active:false});
 const native=Object.create(NativeWorkspaces.prototype);Object.assign(native,{api:f.api,workWindow:w,authority:{resolve:()=>({windowId:id})}});
 let count=0;const t={workWindowMode:'separate',workspaceCapability:{},agentTabs:new Set([2]),agentTabGroups:new Map([[2,3]])};
 await native.withInput(t,{action:'ref_click',tabId:2},()=>{},async()=>count++);
 await native.withInput({...t,workWindowMode:'current'},{action:'ref_click',tabId:2},()=>{},async()=>count++);
 assert.equal(count,2);assert.equal(f.calls.filter(c=>c[0]==='tabs.update').length,0);
});
test('原始 CDP 输入进入窗口队列，非输入命令不切前台',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure();f.tabs.set(2,{id:2,windowId:id,groupId:3,active:false});
 const native=Object.create(NativeWorkspaces.prototype);Object.assign(native,{api:f.api,workWindow:w,authority:{resolve:()=>({windowId:id})}});
 const t={workWindowMode:'separate',workspaceCapability:{},agentTabs:new Set([2]),agentTabGroups:new Map([[2,3]])};
 await native.withInput(t,{action:'cdp.send',method:'Runtime.evaluate',tabId:2},()=>{},async()=>{});
 assert.equal(f.calls.filter(c=>c[0]==='tabs.update').length,0);
 await native.withInput(t,{action:'cdp.send',method:'Input.dispatchKeyEvent',tabId:2},()=>{},async()=>{});
 assert.equal(f.calls.filter(c=>c[0]==='tabs.update').length,1);
});
test('隐藏语义目标先派发真实输入，页面核验后不依赖不可用的 CDP 命中接口',async()=>{
 const events=[];const state={visibility:'hidden',documentId:'d',token:'t',url:'http://fixture.localhost',viewport:{width:100,height:80},dpr:1,scroll:{x:0,y:0},visual:{scale:1,x:0,y:0}};
 const adapter={evaluate:async()=>state,send:async(_method,p)=>events.push(p.type),verifyHit:async()=>{throw Error('hidden hit interface unavailable')}};
 const input=new Interactions(adapter,{taskId:'t',generation:1});
 await input.clickBoundTarget({taskId:'t',generation:1},{readTarget:async()=>({x:20,y:20})});
 assert.deepEqual(events,['mouseMoved','mousePressed','mouseReleased']);
 state.visibility='visible';
 await assert.rejects(input.clickBoundTarget({taskId:'t',generation:1},{readTarget:async()=>({x:20,y:20})}),error=>error.preDispatch===true);
});
function effectFixture(){
 const dom=new JSDOM('<button id="button">Apply</button><output></output>',{url:'http://fixture.localhost/',runScripts:'outside-only'}),listeners=new Set();
 const api={debugger:{onEvent:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},sendCommand:async(_t,method,p)=>{
  if(method==='Network.enable')return {};
  assert.equal(method,'Runtime.callFunctionOn');return {result:{value:dom.window.eval(`(${p.functionDeclaration})(${p.arguments.map(a=>JSON.stringify(a.value)).join(',')})`)}};
 }}};
 const run=(work,timeoutMs=90)=>observeInputEffect({api,target:{tabId:1},contextId:1,guard:()=>{},work,timeoutMs});
 return {dom,listeners,run};
}
for(const change of ['dom','focus','submit','request'])test(`${change} 效果返回 observed，监听器退出后收回`,async()=>{
 const f=effectFixture();try{
  const r=await f.run(async()=>{const d=f.dom.window.document;
   if(change==='dom')setTimeout(()=>d.querySelector('output').textContent='done',20);
   if(change==='focus')d.querySelector('button').focus();
   if(change==='submit')d.dispatchEvent(new f.dom.window.Event('submit'));
   if(change==='request')for(const listener of f.listeners)listener({tabId:1},'Network.requestWillBeSent');
   return {clicked:true,kind:'trusted-input',effect:'unverified'};
  });assert.equal(r.effect,'observed');assert.equal(f.listeners.size,0);assert.equal(f.dom.window.__hermesInputEffect,undefined);
 }finally{f.dom.window.close()}
});
test('迟到的探针清理不卸载下一动作的观察器',()=>{
 const f=effectFixture();try{
  const call=(op,token)=>f.dom.window.eval(`(${effectProbe.toString()})(${JSON.stringify(op)},${JSON.stringify(token)})`);
  call('arm','a');call('arm','b');call('clear','a');
  assert.equal(f.dom.window.__hermesInputEffect.token,'b');
  call('clear','b');assert.equal(f.dom.window.__hermesInputEffect,undefined);
 }finally{f.dom.window.close()}
});
test('Shadow DOM 内变化也返回 observed',async()=>{
 const f=effectFixture();try{
  const host=f.dom.window.document.createElement('div');f.dom.window.document.body.append(host);const shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<output></output>';
  const result=await f.run(async()=>{shadow.querySelector('output').textContent='Applied';return {clicked:true,kind:'trusted-input',effect:'unverified'}});
  assert.equal(result.effect,'observed');
 }finally{f.dom.window.close()}
});
test('合成点击无效果抛 click_no_effect，装饰变化不算网页效果',async()=>{
 const f=effectFixture();try{
  await assert.rejects(f.run(async()=>{const host=f.dom.window.document.createElement('div');host.setAttribute('data-hermes-automation-overlay','');f.dom.window.document.body.append(host);return {clicked:true,kind:'dom-synthetic',effect:'unverified'};}),e=>e.code==='CLICK_NO_EFFECT'&&e.effect==='unobserved'&&e.suggestion===NO_EFFECT_HINT&&e.outcomeUnknown===true);
  assert.equal(f.listeners.size,0);
 }finally{f.dom.window.close()}
});
