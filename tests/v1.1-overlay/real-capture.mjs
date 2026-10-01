// 中文注释：真实插件、桥接、扩展与 Chrome/Edge 截图；故障仅注入临时扩展的截图传输。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {CdpClient,fetchJson,waitFor} from '../native-v2/cdp-client.mjs';
const server=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>body{background:#fff}button{position:fixed;left:30px;top:100px}</style><h1>截图验收</h1><button id="target" onclick="window.clicks++">页面按钮</button><script>window.clicks=0</script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,browser=process.argv.includes('--edge')?'edge':'chrome';let session,worker;
try{
 session=await openRealSession({browser,label:'sc'});await session.enableFullAccess();
 const a=await openTask(session,{origins:[origin],url:origin+'/',title:'截图甲'}),b=await openTask(session,{owner:'capture-b',origins:[origin],url:origin+'/other',title:'截图乙'});
 await a.run('snapshot');
 const send=(method,params={})=>session.ui.evaluate(`chrome.debugger.sendCommand({tabId:${a.tabId}},${JSON.stringify(method)},${JSON.stringify(params)})`);
 const state=()=>a.read(`(()=>{const host=document.querySelector('[data-hermes-automation-overlay]');return {connected:!!host,pointer:host?.style.pointerEvents,opacity:host?.style.opacity,clicks:window.clicks}})()`);
 await a.read("document.querySelector('[data-hermes-automation-overlay]').style.opacity='0'");const plain=await send('Page.captureScreenshot',{format:'png'});await a.read("document.querySelector('[data-hermes-automation-overlay]').style.removeProperty('opacity')");
 const shot=await a.run('screenshot');assert.equal(shot.data,plain.data,'实际截图不能包含遮罩装饰');assert.equal((await state()).pointer,'auto');assert.notEqual((await state()).opacity,'0');
 assert.equal(await session.ui.evaluate('chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0].id)'),b.tabId,'后台截图不抢活动页');
 const target=await waitFor(async()=>(await fetchJson(session.base+'/json/list')).find(t=>t.type==='service_worker'&&t.url.startsWith(`chrome-extension://${session.extensionId}/`)));
 worker=new CdpClient(target.webSocketDebuggerUrl);await worker.connect();
 // 中文注释：丢失截图传输回执，真实等待执行器的超时与恢复，宿主不能先撤销任务。
 await worker.evaluate("globalThis.__auditCaptureSend=chrome.debugger.sendCommand;chrome.debugger.sendCommand=(target,method,params)=>method==='Page.captureScreenshot'?new Promise(()=>{}):globalThis.__auditCaptureSend(target,method,params)");
 const started=Date.now(),timed=await a.run('screenshot');assert.equal(timed.bridgeCode,'screenshot_timeout',JSON.stringify(timed));assert.equal(timed.retryable,false);assert.equal(timed.data,undefined);
 const timeoutElapsedMs=Date.now()-started;assert.notEqual((await state()).opacity,'0');assert.equal((await state()).pointer,'auto');
 await worker.evaluate("chrome.debugger.sendCommand=(target,method,params)=>method==='Page.captureScreenshot'?Promise.reject(Error('合成截图失败')):globalThis.__auditCaptureSend(target,method,params)");
 const failed=await a.run('screenshot');assert.ok(failed.error);assert.equal(failed.data,undefined);assert.notEqual((await state()).opacity,'0');assert.equal((await state()).pointer,'auto');
 await worker.evaluate("chrome.debugger.sendCommand=(target,method,params)=>method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='restore'?Promise.resolve({result:{value:false}}):globalThis.__auditCaptureSend(target,method,params)");
 const unrestored=await a.run('screenshot');assert.ok(unrestored.error);assert.equal(unrestored.data,undefined);assert.equal((await state()).connected,true,'恢复失败不能删除遮罩');assert.equal((await state()).pointer,'auto');
 for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:50,y:110,button:'left',clickCount:1});assert.equal((await state()).clicks,0,'恢复失败后真实点击仍被拦截');
 await worker.evaluate('chrome.debugger.sendCommand=globalThis.__auditCaptureSend;delete globalThis.__auditCaptureSend');
 console.log(JSON.stringify({browser,version:session.version.Browser,timeoutElapsedMs,passed:['后台截图不激活','截图像素与无遮罩基线一致','截图成功恢复','截图抛错恢复','截图回执超时后恢复且不重试','恢复失败保留拦截','失败不返回截图','恢复失败后真实点击被拦截']}));
}finally{if(worker){await worker.evaluate('if(globalThis.__auditCaptureSend)chrome.debugger.sendCommand=globalThis.__auditCaptureSend').catch(()=>{});worker.close();}await session?.close();await new Promise(resolve=>server.close(resolve));}
