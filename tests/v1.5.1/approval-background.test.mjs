// 中文注释：离线模拟后台聚焦限制；测试不得访问个人浏览器或实际通知中心。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {createApprovalNotifier} from '../../native-extension/approval-notifier.mjs';
import {mountApprovalPanel} from '../../native-extension/approval-panel.mjs';

function fixture({focusThrows=false,createFocused=false,notificationFails=false}={}){
 const calls=[];let allowFocus=false,now=1000;
 const chrome={runtime:{id:'ext',getURL:p=>`chrome-extension://ext/${p}`},
  tabs:{get:async id=>({id,windowId:10,url:'https://example.test/'}),update:async id=>({id})},
  windows:{get:async id=>({id,type:'normal',left:0,top:0,width:1000,height:800}),
   update:async(id,options)=>{calls.push(['focus',id,options]);if(focusThrows&&!allowFocus)throw Error('background focus denied');return {id,focused:allowFocus};},
   create:async options=>{calls.push(['create',options]);return {id:20,tabs:[{id:21}],focused:createFocused};},
   remove:async id=>calls.push(['remove',id])},
  notifications:{create:async(id,options)=>{calls.push(['notification',id,options]);if(notificationFails)throw Error('notifications disabled');return id;},clear:async id=>calls.push(['clear',id])},
  action:{setBadgeText:async value=>calls.push(['badge',value]),setTitle:async()=>{}}};
 const notifier=createApprovalNotifier({chrome,instanceId:'source',now:()=>now});
 const request={id:'request',instanceId:'source',taskId:'task',generation:1,tabId:1,windowId:10,origin:'https://example.test',action:'read',scope:'本次操作',expiresAt:10000,digest:'digest',taskTitle:'private title'};
 return {chrome,calls,notifier,request,allowFocus(){allowFocus=true;},expire(){now=10001;}};
}

test('聚焦返回 false 或抛错仍建窗口、记录未聚焦并发送无敏感信息通知',async()=>{
 for(const focusThrows of [false,true]){
  const h=fixture({focusThrows,createFocused:true});await h.notifier.sync([h.request]);
  assert.deepEqual(h.notifier.panel(),{windowId:20,tabId:21,focusConfirmed:false});
  assert.equal(h.calls.find(c=>c[0]==='create')[1].type,'popup');
  assert.equal(h.calls.find(c=>c[0]==='create')[1].focused,true);
  assert.equal(h.calls.filter(c=>c[0]==='notification').length,1);
  const notice=h.calls.find(c=>c[0]==='notification');assert.match(notice[2].message,/网站访问/);
  assert.doesNotMatch(JSON.stringify(notice),/private title|example.test|digest/);
  await h.notifier.sync([h.request]);assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='notification').length,1);
 }
});

// 中文注释：产品的待确认按钮复用同一路径，显式重开也不能受后台聚焦结果阻断。
test('后台面板关闭后显式 openPending 仍建窗和提醒，不能自动重开',async()=>{
 const h=fixture({focusThrows:true});await h.notifier.sync([h.request]);
 await h.notifier.panelClosed(20);assert.equal(h.notifier.panel(),null);
 await h.notifier.sync([h.request]);assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
 await h.notifier.openPending(h.request.id);assert.equal(h.notifier.panel().focusConfirmed,false);
 assert.equal(h.calls.filter(c=>c[0]==='create').length,2);
 assert.equal(h.calls.filter(c=>c[0]==='notification').length,2);
 assert.equal(h.notifier.pending().length,1);
});

test('Cookie 镜像和人工输入均保留后台面板；通知按类型提示且不携带 Cookie',async()=>{
 for(const kind of ['cookie_mirror','manual_input']){
  const h=fixture();await h.notifier.sync([{...h.request,kind,...(kind==='manual_input'?{fieldKind:'password'}:{})}]);
  assert.equal(h.notifier.panel().focusConfirmed,false);
  assert.match(h.calls.find(c=>c[0]==='notification')[2].message,kind==='cookie_mirror'?/Cookie 镜像/:/人工输入/);
 }
});

test('通知点击只聚焦当前绑定面板，不能批准或操作无关窗口',async()=>{
 const h=fixture();await h.notifier.sync([h.request]);const count=h.calls.length;
 await h.notifier.notificationClicked('foreign');assert.equal(h.calls.length,count);
 h.allowFocus();await h.notifier.notificationClicked('hermes-browser-approval');
 assert.equal(h.notifier.panel().focusConfirmed,true);
 assert.equal(h.calls.filter(c=>c[0]==='focus').at(-1)[1],20);
 assert.equal(h.notifier.pending().length,1);assert.equal(h.notifier.view().id,h.request.id);
 await h.notifier.sync([]);const after=h.calls.length;
 await h.notifier.notificationClicked('hermes-browser-approval');assert.equal(h.calls.length,after);
});

test('过期通知点击无效，通知被系统禁用仍保留面板、角标和待确认状态',async()=>{
 const h=fixture({notificationFails:true});await h.notifier.sync([h.request]);
 assert.equal(h.notifier.status().panelOpen,true);assert.equal(h.notifier.status().pendingCount,1);
 assert.equal(h.calls.find(c=>c[0]==='badge')[1].text,'1');
 h.expire();const count=h.calls.length;await h.notifier.notificationClicked('hermes-browser-approval');
 assert.equal(h.calls.length,count);await h.notifier.sync([]);assert.equal(h.notifier.panel(),null);
});

test('后台面板仍校验扩展来源、窗口和实时范围；未知派发结果不重试',async()=>{
 const h=fixture();await h.notifier.sync([h.request]);let dispatched=0;
 const sender={id:'ext',url:h.chrome.runtime.getURL('approval-panel.html'),tab:{id:21,windowId:20}};
 const decide=extra=>h.notifier.decide({sender,requestId:h.request.id,decision:'approve',verify:async()=>true,dispatch:async()=>{dispatched++;throw Error('unknown');},...extra});
 await assert.rejects(decide({sender:{...sender,url:'https://example.test'}}),/untrusted/);
 await assert.rejects(decide({verify:async()=>false}),/stale/);assert.equal(dispatched,0);
 await assert.rejects(decide({}),/unknown/);assert.equal(dispatched,1);
 await h.notifier.sync([h.request]);await assert.rejects(h.notifier.openPending(h.request.id),/unknown/);
 assert.equal(h.notifier.panel(),null);assert.equal(dispatched,1);
});

test('Cookie 与网站批准、拒绝均拒绝脚本 click 和伪造事件',async()=>{
 for(const cookie of [false,true]){
  const dom=new JSDOM('<main id="app"></main>',{url:'chrome-extension://ext/approval-panel.html'});
  const sent=[];const view={id:'r',taskTitle:'确认测试',origin:'https://example.test',action:'read',scope:'本次操作',expiresAt:Date.now()+60000,
   ...(cookie?{kind:'cookie_mirror',source:{browser:'chrome',instanceId:'source'},target:{browser:'edge',instanceId:'target'},sites:[{site:'example.test',count:1}],count:1,options:{}}:{})};
  const chrome={runtime:{getURL:p=>`chrome-extension://ext/${p}`,sendMessage:async m=>{sent.push(m);return {result:view};}}};
  await mountApprovalPanel({document:dom.window.document,chrome});
  for(const button of dom.window.document.querySelectorAll('button')){button.click();button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));}
  assert.equal(sent.filter(m=>m.type==='approval_panel_decision').length,0);dom.window.close();
 }
});

test('manifest 扩展和工具栏图标都引用四种交付尺寸，并声明通知权限',async()=>{
 const root=new URL('../../native-extension/',import.meta.url);const manifest=JSON.parse(await readFile(new URL('manifest.json',root)));
 assert.ok(manifest.permissions.includes('notifications'));
 const icons={'16':'icon-16.png','32':'icon-32.png','48':'icon-48.png','128':'icon-128.png'};
 assert.deepEqual(manifest.icons,icons);assert.deepEqual(manifest.action.default_icon,icons);
 for(const [size,file] of Object.entries(icons)){
  const png=await readFile(new URL(file,root));assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),Number(size));assert.equal(png.readUInt32BE(20),Number(size));
 }
});
