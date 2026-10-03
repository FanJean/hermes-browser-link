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
}finally{await session?.close();await new Promise(r=>server.close(r));}
