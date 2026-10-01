// 中文注释：真实扩展弹窗 → Native Messaging → daemon → 执行器与页面遮罩；全程临时 profile。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
const server=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>接管验收</title><input id="draft"><button id="save" onclick="window.clicks++">点击</button><script>window.clicks=0</script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=process.argv.includes('--edge')?'edge':'chrome';let session;
try{
 session=await openRealSession({browser,label:'tk'});await session.enableFullAccess();
 const a=await openTask(session,{origins:[origin],url:origin+'/',title:'任务甲'});
 const second=await session.rpc(a.owner,'run',{task_id:a.task.id,request_id:'second',action:'new_tab',url:origin+'/second'});
 const b=await openTask(session,{owner:'session-b',origins:[origin],url:origin+'/other',title:'任务乙'});
 await a.run('snapshot');await session.rpc(a.owner,'run',{task_id:a.task.id,request_id:'snapshot-second',action:'snapshot',tab_id:second.tabId});await b.run('snapshot');
 const pointers=tabId=>session.readPage(tabId,`document.querySelector('[data-hermes-automation-overlay]')?.style.pointerEvents`);
 const taskState=()=>session.rpc(a.owner,'get',{task_id:a.task.id}).then(t=>t.state);
 // 中文注释：每个状态等待都记录具体等待点及最后读数，失败时可直接定位弹窗、任务或遮罩。
 const until=(label,read,ready=Boolean)=>waitFor(read,15000,{label,ready});
 const popupState=()=>session.ui.evaluate(`(async()=>{const section=document.querySelector('#page-task'),button=document.querySelector('#takeover');const active=await chrome.tabs.query({active:true,currentWindow:true});return {pageTaskHidden:section?.hidden,taskId:section?.dataset.taskId,tabId:section?.dataset.tabId,text:button?.textContent,disabled:button?.disabled,activeTabId:active[0]?.id}})()`);
 // 中文注释：读取和点击在同一次弹窗求值中完成，刷新若切到另一任务，本轮不发送控制命令。
 const clickCurrent=(selector,label,expectedText)=>until(label,()=>session.ui.evaluate(`(()=>{const section=document.querySelector('#page-task'),button=document.querySelector(${JSON.stringify(selector)});const state={taskId:section?.dataset.taskId,tabId:section?.dataset.tabId,text:button?.textContent,disabled:button?.disabled};if(state.taskId!==${JSON.stringify(a.task.id)}||state.tabId!==${JSON.stringify(String(a.tabId))}||state.text!==${JSON.stringify(expectedText)}||state.disabled)return {...state,clicked:false};button.click();return {...state,clicked:true}})()`),s=>s.clicked);
 // 中文注释：测试页中的 popup.html 保持后台，避免它作为普通标签页抢走当前任务页身份；执行真实按钮监听器。
 await session.ui.evaluate(`chrome.tabs.update(${a.tabId},{active:true}).then(()=>chrome.runtime.sendMessage({type:'changed'}))`);
 await until('弹窗显示任务甲接管按钮',popupState,s=>s.pageTaskHidden===false&&s.taskId===a.task.id&&s.tabId===String(a.tabId)&&s.activeTabId===a.tabId&&s.text==='接管'&&s.disabled===false);
 await clickCurrent('#takeover','弹窗点击任务甲接管','接管');await until('弹窗接管后任务甲暂停',async()=>({task:await taskState(),popup:await popupState()}),s=>s.task==='paused');
 await until('接管后任务甲两个页面放开',async()=>({first:await pointers(a.tabId),second:await pointers(second.tabId)}),s=>s.first==='none'&&s.second==='none');assert.equal(await pointers(b.tabId),'auto');
 // 中文注释：用户接管期间自己导航，新文档仍保持接管，不恢复 Hermes 派发。
 await session.ui.evaluate(`chrome.tabs.update(${second.tabId},{url:${JSON.stringify(origin+'/second-navigated')}}).then(()=>true)`);
 await until('接管期间第二页导航完成',()=>session.ui.evaluate(`chrome.tabs.get(${second.tabId}).then(t=>({status:t.status,url:t.url}))`),s=>s.status==='complete'&&s.url===origin+'/second-navigated');
 await until('接管期间第二页仍放开',()=>pointers(second.tabId),s=>s==='none');assert.equal(await taskState(),'paused');
 const denied=await a.run('click',{selector:'#save'});assert.equal(denied.bridgeCode,'task_paused',JSON.stringify(denied));assert.equal(denied.retryable,false);assert.equal(await a.read('window.clicks'),0);
 const other=await b.run('fill',{selector:'#draft',text:'其他任务仍可执行'});assert.equal(other.ok,true,JSON.stringify(other));assert.equal(await b.read("document.querySelector('#draft').value"),'其他任务仍可执行');
 await until('弹窗显示任务甲可用的继续按钮',popupState,s=>s.taskId===a.task.id&&s.tabId===String(a.tabId)&&s.text==='继续'&&s.disabled===false);
 await clickCurrent('#takeover','弹窗点击任务甲继续','继续');await until('弹窗继续后任务甲就绪',async()=>({task:await taskState(),popup:await popupState()}),s=>s.task==='ready');
 await until('继续后任务甲两个页面恢复拦截',async()=>({first:await pointers(a.tabId),second:await pointers(second.tabId)}),s=>s.first==='auto'&&s.second==='auto');
 const clicked=await a.run('click',{selector:'#save'});assert.equal(clicked.clicked,true,JSON.stringify(clicked));assert.equal(await a.read('window.clicks'),1);
 // 中文注释：动作成功和派发失败后均用真实指针再次命中业务按钮，不能只检查 CSS 属性。
 const blockedClick=async()=>{
  const point=await a.read("(()=>{const r=document.querySelector('#save').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  for(const type of ['mousePressed','mouseReleased'])await session.ui.evaluate(`chrome.debugger.sendCommand({tabId:${a.tabId}},'Input.dispatchMouseEvent',${JSON.stringify({type,...point,button:'left',clickCount:1})})`);
  assert.equal(await a.read('window.clicks'),1);
 };
 await blockedClick();const failed=await a.run('click',{selector:'#missing'});assert.ok(failed.error);await blockedClick();

 // 中文注释：在页面闭合影子树上发送真实鼠标事件，再由弹窗读取同一个 paused 状态。
 await session.ui.evaluate(`(async()=>{const target={tabId:${a.tabId}},tree=await chrome.debugger.sendCommand(target,'DOM.getDocument',{depth:-1,pierce:true});
 const find=node=>{const a=node.attributes||[];if(a.some((key,i)=>key==='data-action'&&a[i+1]==='takeover'))return node;for(const child of [...node.children||[],...node.shadowRoots||[]]){const hit=find(child);if(hit)return hit;}};
 const node=find(tree.root),{model}=await chrome.debugger.sendCommand(target,'DOM.getBoxModel',{nodeId:node.nodeId});const x=(model.content[0]+model.content[4])/2,y=(model.content[1]+model.content[5])/2;
 for(const type of ['mousePressed','mouseReleased'])await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});})()`);
 await until('页面遮罩接管后任务甲暂停',taskState,s=>s==='paused');await until('页面遮罩接管后弹窗显示继续',popupState,s=>s.taskId===a.task.id&&s.tabId===String(a.tabId)&&s.text==='继续');
 await clickCurrent('#stop-task','弹窗点击任务甲停止','停止');await until('停止后任务甲结束',taskState,s=>['cancelled','closed'].includes(s));
 await until('停止后任务甲页面关闭',()=>session.ui.evaluate(`chrome.tabs.query({}).then(t=>t.filter(x=>x.id===${a.tabId}||x.id===${second.tabId}).map(x=>({id:x.id,url:x.url,status:x.status})))`),s=>s.length===0);
 assert.equal((await b.run('snapshot')).url,origin+'/other');
 console.log(JSON.stringify({browser,version:session.version.Browser,passed:['弹窗接管','所有任务页放开','接管期间导航不恢复派发','暂停工具明确拒绝且不重试','其他任务不受影响','继续恢复拦截','成功和失败收尾后真实点击被拦截','遮罩接管同步弹窗','停止清理任务页']}));
}finally{await session?.close();await new Promise(resolve=>server.close(resolve));}
