// 中文注释：只使用合成浏览器 API 和离线 DOM，不调用 git/rg，也不访问用户浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Interactions} from '../../browser-interactions/index.mjs';
import {WorkWindow} from '../../native-extension/work-window.mjs';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {effectProbe,observeInputEffect,NO_EFFECT_HINT} from '../../native-extension/action-effects.mjs';
function fixture(){
 // 中文注释：模拟查询、分组及最后一页关闭后窗口消失，覆盖适配器的真实清理入口。
 let stored={},next=10,nextGroup=100;const tabs=new Map(),windows=new Map(),groups=new Map(),calls=[];
 const api={runtime:{getURL:p=>`chrome-extension://fixture/${p}`,onStartup:{addListener:()=>{}}},storage:{local:{get:async()=>structuredClone(stored),set:async v=>{stored={...stored,...structuredClone(v)}}}},
  tabs:{query:async p=>[...tabs.values()].filter(t=>(p.url===undefined||t.url===p.url)&&(p.windowId===undefined||t.windowId===p.windowId)).map(t=>({...t})),
   get:async id=>{if(!tabs.has(id))throw Error(`No tab with id: ${id}.`);return {...tabs.get(id)}},
   create:async p=>{const tab={id:next++,groupId:-1,...p};tabs.set(tab.id,tab);return {...tab}},
   group:async p=>{const id=p.groupId??nextGroup++;for(const tabId of [p.tabIds].flat())tabs.get(tabId).groupId=id;if(!groups.has(id))groups.set(id,{id,windowId:tabs.get([p.tabIds].flat()[0]).windowId});return id},
   remove:async id=>{calls.push(['tabs.remove',id]);const tab=tabs.get(id);tabs.delete(id);if(![...tabs.values()].some(t=>t.windowId===tab.windowId))windows.delete(tab.windowId)},
   update:async(id,p)=>{calls.push(['tabs.update',id,p]);for(const t of tabs.values())if(t.windowId===tabs.get(id).windowId)t.active=t.id===id;return tabs.get(id)}},
  tabGroups:{get:async id=>({...groups.get(id)}),update:async(id,p)=>groups.set(id,{...groups.get(id),...p})},
  windows:{get:async id=>{if(!windows.has(id))throw Error('No window');return windows.get(id)},create:async p=>{calls.push(['windows.create',p]);const id=next++,tab={id:next++,windowId:id,url:p.url,groupId:-1,active:true};tabs.set(tab.id,tab);const win={id,type:'normal',tabs:[tab]};windows.set(id,win);return win}}};
 return {api,tabs,windows,calls};
}
test('并发任务只创建一个独立窗口，不聚焦、不最小化，关闭后重建',async()=>{
 const f=fixture(),w=new WorkWindow(f.api);const ids=await Promise.all([w.ensure(),w.ensure(),w.ensure()]);
 assert.equal(new Set(ids).size,1);assert.deepEqual(f.calls,[['windows.create',{url:'chrome-extension://fixture/work-window.html',type:'normal',focused:false,state:'normal'}]]);
 const restored=new WorkWindow(f.api);assert.equal(await restored.ensure(),ids[0]);
 f.windows.delete(ids[0]);f.tabs.clear();assert.notEqual(await w.ensure(),ids[0]);assert.equal(f.calls.length,2);
});
test('保存编号丢失或浏览器恢复编号变化时复用已有首页，不新增窗口',async()=>{
 for(const reset of ['storage','ids']){
  const f=fixture(),first=new WorkWindow(f.api),id=await first.ensure();
  if(reset==='storage')await f.api.storage.local.set({'hermes.workWindow.v1':null});
  else{const tab=[...f.tabs.values()][0];f.tabs.delete(tab.id);f.windows.delete(id);tab.id+=100;tab.windowId+=100;f.tabs.set(tab.id,tab);f.windows.set(tab.windowId,{id:tab.windowId,type:'normal'});}
  const restored=new WorkWindow(f.api),expected=[...f.tabs.values()][0].windowId;
  assert.equal(await restored.ensure(),expected);assert.equal(f.calls.length,1);
  assert.equal((await f.api.storage.local.get())['hermes.workWindow.v1'].windowId,expected);
 }
});
test('最后一个任务完成才关闭空工作窗口，下一任务可以重建',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure('a');await w.ensure('b');
 await w.closeIdle('a',id);assert.ok(f.windows.has(id));
 await w.closeIdle('b',id);assert.ok(!f.windows.has(id));assert.equal(w.windowId,null);
 assert.equal((await f.api.storage.local.get())['hermes.workWindow.v1'],null);
 assert.notEqual(await w.ensure('c'),id);
});
test('保留结果页、用户页、被改写或拖走的首页都不自动关闭',async()=>{
 for(const kind of ['result','user','navigated','moved','kept','leased']){
  const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure('a'),marker=[...f.tabs.values()][0];
  if(kind==='result'||kind==='user')f.tabs.set(1,{id:1,windowId:id,url:`https://fixture.test/${kind}`});
  if(kind==='navigated')marker.url='https://fixture.test';
  if(kind==='moved')marker.windowId=99;
  await w.closeIdle('a',id,{keepTabIds:kind==='kept'?[marker.id]:[],canDelete:()=>kind!=='leased'});
  assert.ok(f.tabs.has(marker.id));assert.equal(f.calls.filter(c=>c[0]==='tabs.remove').length,0);
 }
});
test('空窗口查询期间开始新任务，保留同一窗口供新任务使用',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure('a'),query=f.api.tabs.query;
 let resume,started;const gate=new Promise(r=>resume=r),ready=new Promise(r=>started=r);
 f.api.tabs.query=async p=>{if(p.windowId===id){started();await gate;}return query(p)};
 const cleanup=w.closeIdle('a',id);await ready;const install=w.ensure('b');resume();await cleanup;
 assert.equal(await install,id);assert.equal(f.calls.filter(c=>c[0]==='tabs.remove').length,0);
});
test('空窗口查询超过期限，不补做迟到的删除',async()=>{
 const f=fixture(),w=new WorkWindow(f.api),id=await w.ensure('a'),query=f.api.tabs.query;
 f.api.tabs.query=async p=>{await new Promise(r=>setTimeout(r,20));return query(p)};
 await w.closeIdle('a',id,{timeoutMs:5});assert.ok(f.windows.has(id));
});
test('适配器在工作页关闭后回收首页；保留页及恢复清理沿用相同规则',async()=>{
 for(const preserve of [false,true]){
  const f=fixture(),native=new NativeWorkspaces(f.api,'instance');
  const cap=await native.install({instanceId:'instance',approvalScope:'owner',id:'a',generation:1},[]);
  const id=native.authority.resolve(cap).windowId,work=await native.open(cap,{requestId:'page',url:'https://fixture.test'});
  assert.equal((await native.cleanup(cap,{closeTabs:!preserve})).cleanupState,'succeeded');
  assert.equal(f.windows.has(id),preserve);assert.equal(f.tabs.has(work.tabId),preserve);
  if(preserve){const restored=new NativeWorkspaces(f.api,'instance');await restored.cleanupRecovered('a',1,{closeTabs:true});assert.ok(!f.windows.has(id));}
 }
});
test('只有授权而未建工作页的任务结束后不留下首页',async()=>{
 const f=fixture(),native=new NativeWorkspaces(f.api,'instance');
 const cap=await native.install({instanceId:'instance',approvalScope:'owner',id:'read',generation:1},[]);
 await native.cleanup(cap);assert.equal(f.windows.size,0);
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
