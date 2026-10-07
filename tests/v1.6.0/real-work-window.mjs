// 中文注释：三个任务共用临时工作窗口；所有断言都经真实扩展、daemon、插件及脚本通道。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask,helperCall} from '../native-v2/real-session.mjs';
import {fixture} from './real-background-input.mjs';
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture.replace('<output', '<button id="quiet" aria-label="Quiet">Quiet</button><output'))});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let session;
try{
 session=await openRealSession({browser:process.argv.includes('--edge')?'edge':'chrome',headed:process.argv.includes('--headed'),label:'work160'});
 await session.enableFullAccess();
 const tabs=await Promise.all([1,2,3].map(i=>openTask(session,{owner:'work160',origins:[origin],url:`${origin}/${i}`,title:`并发任务 ${i}`})));
 const windows=await session.ui.evaluate(`Promise.all(${JSON.stringify(tabs.map(t=>t.tabId))}.map(id=>chrome.tabs.get(id))).then(t=>t.map(x=>x.windowId))`);
 assert.equal(new Set(windows).size,1);
 const user=await session.ui.evaluate(`chrome.windows.create({url:${JSON.stringify(origin+'/user')},focused:true,type:'normal'}).then(w=>({windowId:w.id,tabId:w.tabs[0].id}))`);
 const before=await session.ui.evaluate(`chrome.windows.getAll({populate:true}).then(ws=>({focused:ws.find(w=>w.focused)?.id??null,userFocused:ws.find(w=>w.id===${user.windowId}).focused,active:ws.find(w=>w.id===${user.windowId}).tabs.find(t=>t.active).id}))`);
 const targets=await Promise.all(tabs.map(t=>t.ref('Trusted click',['button'])));
 const results=await Promise.all(tabs.map((t,i)=>t.act('ref_click',targets[i])));
 for(let i=0;i<3;i++){assert.equal(results[i].error,undefined,JSON.stringify(results[i]));assert.equal(results[i].effect,'observed');assert.equal(await tabs[i].read('hits.trusted'),1);}
 const after=await session.ui.evaluate(`chrome.windows.getAll({populate:true}).then(ws=>({focused:ws.find(w=>w.focused)?.id??null,userFocused:ws.find(w=>w.id===${user.windowId}).focused,active:ws.find(w=>w.id===${user.windowId}).tabs.find(t=>t.active).id}))`);
 assert.deepEqual(after,before);console.log('PASS 3 并发可信点击、同一工作窗口、用户活动标签及焦点不变',JSON.stringify({windows,results,before,after}));
 const quiet=await tabs[0].ref('Quiet',['button']);await tabs[0].read(`document.getElementById('quiet').focus()`);
 const noEffect=await tabs[0].act('ref_click',quiet);
 assert.equal(noEffect.code,'click_no_effect',JSON.stringify(noEffect));assert.equal(noEffect.effect,'unobserved');assert.match(noEffect.suggestion,/核对/);console.log('PASS click_no_effect 工具通道',JSON.stringify(noEffect));
 const script=await helperCall('script',session.work,tabs[0].owner,tabs[0].task.id,`try:\n    click_element('Quiet',role='button')\nexcept BrowserError as e:\n    print(e.code,e.effect,e.suggestion)\nelse:\n    raise RuntimeError('quiet click incorrectly succeeded')`);
 assert.equal(script.exit_code,0,JSON.stringify(script));assert.match(script.stdout,/click_no_effect unobserved/);console.log('PASS click_no_effect 脚本通道',script.stdout.trim());
 // 中文注释：后台截图及 bounds 为只读，点击时才切前台，原引用仍可确认可信交付。
 const activeBeforeRead=await session.ui.evaluate(`chrome.tabs.query({windowId:${windows[0]},active:true}).then(t=>t[0].id)`);
 const shot=await tabs[1].run('interaction.capture');assert.equal(shot.error,undefined,JSON.stringify(shot));
 const bounds=await tabs[1].run('interaction.bounds',{screenshot_id:shot.id,selector:'#trusted'});assert.equal(bounds.error,undefined,JSON.stringify(bounds));
 assert.equal(await session.ui.evaluate(`chrome.tabs.query({windowId:${windows[0]},active:true}).then(t=>t[0].id)`),activeBeforeRead);
 const stateBefore=await tabs[1].read(`({revision:globalThis.__hermesInteractions?.revision,visibility:document.visibilityState,url:location.href,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}})`);
 const coordinate=await tabs[1].run('interaction.click',{screenshot_id:shot.id,point:bounds.imageCenter,expected_ref:bounds.ref});
 if(coordinate.error)console.log('coordinate debug',stateBefore,await tabs[1].read(`({revision:globalThis.__hermesInteractions?.revision,visibility:document.visibilityState,url:location.href,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY}})`));
 assert.equal(coordinate.effect,'observed',JSON.stringify(coordinate));assert.equal(await tabs[1].read('hits.trusted'),2);
 console.log('PASS 后台截图读取不切标签，切前台后坐标点击引用仍有效');
 // 中文注释：最小化仍走真实输入；不恢复窗口或聚焦用户窗口。
 await session.ui.evaluate(`chrome.windows.update(${windows[0]},{state:'minimized'}).then(()=>true)`);
 assert.equal(await tabs[0].read('document.visibilityState'),'hidden');
 const minimized=await tabs[0].act('ref_click',await tabs[0].ref('Trusted click',['button']));
 assert.equal(minimized.effect,'observed',JSON.stringify(minimized));assert.equal(await tabs[0].read('hits.trusted'),2);
 assert.equal(await session.ui.evaluate(`chrome.windows.get(${windows[0]}).then(w=>w.state)`),'minimized');
 console.log('PASS 最小化工作窗口可信点击生效，窗口仍最小化');
 await session.ui.evaluate(`chrome.windows.update(${windows[0]},{state:'normal'}).then(()=>true)`);
 let extra;
 for(let i=4;i<=7;i++)extra=await openTask(session,{owner:'work160',origins:[origin],url:`${origin}/${i}`,title:`计数任务 ${i}`});
 assert.equal(extra.opened.open_tabs,7);assert.equal(extra.opened.tab_hint,'不再用的网站先 browser_shared_close');
 console.log('PASS 会话工作页计数和超过六页的关闭提醒');
 // 中文注释：只关本 fixture 的工作窗口，再创建新任务，验证自动重建。
 await session.ui.evaluate(`chrome.windows.remove(${windows[0]}).then(()=>true)`);
 const rebuilt=await openTask(session,{owner:'rebuilt160',origins:[origin],url:`${origin}/rebuilt`,title:'重建'});
 const rebuiltWindow=await session.ui.evaluate(`chrome.tabs.get(${rebuilt.tabId}).then(t=>t.windowId)`);assert.notEqual(rebuiltWindow,windows[0]);
 assert.equal((await rebuilt.act('ref_click',await rebuilt.ref('Trusted click',['button']))).effect,'observed');console.log('PASS 用户关闭后工作窗口自动重建');
 // 中文注释：丢失保存编号时仍复用真实首页；并发任务全部结束后才关闭空窗口。
 await session.ui.evaluate(`chrome.storage.local.remove('hermes.workWindow.v1').then(()=>true)`);
 const peer=await openTask(session,{owner:'peer160',origins:[origin],url:`${origin}/peer`,title:'复用'});
 assert.equal(await session.ui.evaluate(`chrome.tabs.get(${peer.tabId}).then(t=>t.windowId)`),rebuiltWindow);
 const closed=await session.rpc(rebuilt.owner,'close',{task_id:rebuilt.task.id});assert.equal(closed.state,'closed',JSON.stringify(closed));
 assert.ok(await session.ui.evaluate(`chrome.windows.getAll().then(ws=>ws.some(w=>w.id===${rebuiltWindow}))`));
 const peerClosed=await session.rpc(peer.owner,'close',{task_id:peer.task.id});assert.equal(peerClosed.state,'closed',JSON.stringify(peerClosed));
 assert.equal(await session.ui.evaluate(`chrome.windows.getAll().then(ws=>ws.some(w=>w.id===${rebuiltWindow}))`),false);
 assert.ok(await session.ui.evaluate(`chrome.tabs.get(${user.tabId}).then(t=>t.windowId===${user.windowId})`));
 console.log('PASS 丢失编号复用工作窗口，最后任务关闭后回收空首页，用户页保留');
 // 中文注释：明确保留结果页时窗口继续存在，后续任务复用同一窗口。
 const kept=await openTask(session,{owner:'kept160',origins:[origin],url:`${origin}/kept`,title:'保留结果'});
 const keptWindow=await session.ui.evaluate(`chrome.tabs.get(${kept.tabId}).then(t=>t.windowId)`);
 const keptClosed=await session.rpc(kept.owner,'close',{task_id:kept.task.id,keep_tabs:true,handoff_reason:'user_requested'});assert.equal(keptClosed.state,'closed',JSON.stringify(keptClosed));
 const next=await openTask(session,{owner:'next160',origins:[origin],url:`${origin}/next`,title:'继续复用'});
 assert.equal(await session.ui.evaluate(`chrome.tabs.get(${next.tabId}).then(t=>t.windowId)`),keptWindow);
 await session.rpc(next.owner,'close',{task_id:next.task.id});
 assert.ok(await session.ui.evaluate(`chrome.tabs.get(${kept.tabId}).then(t=>t.windowId===${keptWindow})`));
 console.log('PASS 保留结果页不关闭窗口，后续任务继续复用');
}finally{await session?.close();await new Promise(r=>server.close(r));}
