// 中文注释：只启动全新临时 profile，保留真实 HOME，测试结束清理浏览器和临时文件。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {preveilSource} from '../../native-extension/core.mjs';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';
const browser=process.argv.includes('--edge')?'edge':'chrome';
const binary=browser==='edge'?'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work=await mkdtemp(path.join(process.env.TMPDIR||'/private/tmp','hermes-overlay-')),profile=path.join(work,'profile'),temp=path.join(work,'tmp');
await mkdir(temp);await mkdir(path.join(work,'home'));
const browserEnv={HOME:process.env.HOME,HERMES_HOME:path.join(work,'home','.hermes'),TMPDIR:temp,PATH:process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin',LANG:process.env.LANG||'en_US.UTF-8'};
const source=await readFile(new URL('../../native-extension/automation-overlay.mjs',import.meta.url),'utf8');
const server=createServer((req,res)=>{
 if(req.url==='/preveil-only'){res.setHeader('Content-Type','text/html');res.end("<!doctype html><dialog id='dialog'><button onclick='window.clicks++'>加载中的模态按钮</button></dialog><script>window.clicks=0;document.querySelector('dialog').showModal()</script>");return;}
 res.setHeader('Content-Type',req.url==='/overlay.mjs'?'text/javascript':'text/html');
 res.end(req.url==='/frame'?'<input id=frame-input aria-label=框架输入>':req.url==='/overlay.mjs'?source:`<!doctype html><style>body{min-height:4000px}#frame{position:fixed;left:400px;top:100px;width:280px;height:160px}</style><script>window.blockedAtFirstScript=!!document.querySelector('[data-hermes-preveil]')</script><button id="target" style="position:fixed;left:50px;top:80px" onclick="window.clicks++">测试点击</button><iframe id="frame" src="http://localhost:${server.address().port}/frame"></iframe><dialog id="dialog"><button onclick="window.clicks++">模态按钮</button></dialog><div id="pop" popover="manual"><button onclick="window.clicks++">浮层按钮</button></div><script>window.clicks=0</script><script type="module">import {createAutomationOverlay} from '/overlay.mjs';window.overlay=createAutomationOverlay({taskId:'t',generation:1,tabId:7,origin:location.origin,onStop:async()=>({state:'stopped'}),onTakeover:async()=>({state:'paused'}),onResume:async()=>({state:'running'})});</script>`);
});
let proc,cdp;
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const url=`http://127.0.0.1:${server.address().port}/`;
 proc=spawn(binary,['--headless=new','--site-per-process','--no-proxy-server','--host-resolver-rules=MAP localhost 127.0.0.1','--use-mock-keychain','--password-store=basic',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check',url],{env:browserEnv,stdio:'ignore'});
 let launchError;proc.once('error',error=>{launchError=error;});
 const port=await waitFor(async()=>{if(launchError)throw launchError;return (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];},10000);
 const target=await waitFor(async()=>(await fetchJson(`http://127.0.0.1:${port}/json/list`)).find(row=>row.url===url));
 cdp=new CdpClient(target.webSocketDebuggerUrl);await cdp.connect();await waitFor(()=>cdp.evaluate('!!window.overlay'));
 const click=async()=>{for(const type of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,x:75,y:90,button:'left',clickCount:1});};
 await click();assert.equal(await cdp.evaluate('window.clicks'),0);
 await cdp.evaluate("overlay.update({state:'running',step:'click',holdMs:50})");
 await waitFor(()=>cdp.evaluate("overlay.host.style.pointerEvents==='auto'"));await click();assert.equal(await cdp.evaluate('window.clicks'),0);
 await cdp.evaluate('overlay.host.remove()');await waitFor(()=>cdp.evaluate('overlay.host.isConnected'));await click();assert.equal(await cdp.evaluate('window.clicks'),0);
 // 中文注释：网页修改 DOM 样式不能授予用户接管权限。
 await cdp.evaluate("overlay.host.style.pointerEvents='none'");await click();assert.equal(await cdp.evaluate('window.clicks'),0,'DOM 样式不能决定是否放行');await cdp.evaluate('overlay.reblock()');
 await cdp.evaluate("overlay.update({state:'paused'})");await click();assert.equal(await cdp.evaluate('window.clicks'),1);
 await cdp.evaluate("overlay.update({state:'running'})");await click();assert.equal(await cdp.evaluate('window.clicks'),1);
 // 中文注释：模态框和 popover 位于 top layer，不能靠 z-index 推断是否拦截，必须真实命中测试。
 const pressAt=async point=>{for(const type of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});};
 const pointFor=selector=>cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await cdp.evaluate("document.querySelector('#dialog').showModal()");await pressAt(await pointFor('#dialog button'));assert.equal(await cdp.evaluate('window.clicks'),1,'模态框不能绕过遮罩');await cdp.evaluate("document.querySelector('#dialog').close()");
 await cdp.evaluate("document.querySelector('#pop').showPopover()");await pressAt(await pointFor('#pop button'));assert.equal(await cdp.evaluate('window.clicks'),1,'popover 不能绕过遮罩');await cdp.evaluate("document.querySelector('#pop').hidePopover()");
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:75,y:90,deltaX:0,deltaY:600});
 await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.equal(await cdp.evaluate('scrollY'),0,'滚轮不能改变页面');
 // 中文注释：栏的空白位置不能点击下面的页面，也不能冒泡给页面普通监听器。
 await cdp.evaluate("window.pageEvents=0;document.addEventListener('click',()=>window.pageEvents++)");
 const width=await cdp.evaluate('innerWidth');await pressAt({x:width-25,y:30});assert.equal(await cdp.evaluate('window.pageEvents'),0);
 // 中文注释：localhost 与 127.0.0.1 分别形成跨站进程，直接验证 iframe 焦点与输入。
 const targets=await cdp.call('Target.getTargets'),frame=targets.targetInfos.find(t=>t.type==='iframe'&&t.url.includes('/frame'));assert.ok(frame,'必须存在真实跨进程 iframe');
 const attached=await cdp.call('Target.attachToTarget',{targetId:frame.targetId,flatten:true});
 const frameEval=async expression=>(await cdp.call('Runtime.evaluate',{expression,returnByValue:true},attached.sessionId)).result.value;
 await cdp.evaluate("overlay.update({state:'paused'})");await frameEval("document.querySelector('input').focus()");
 await cdp.call('Input.insertText',{text:'用户输入'});assert.equal(await frameEval("document.querySelector('input').value"),'用户输入');
 await cdp.evaluate("overlay.update({state:'waiting'})");await cdp.call('Input.insertText',{text:'不应输入'});assert.equal(await frameEval("document.querySelector('input').value"),'用户输入');
 await cdp.call('Target.detachFromTarget',{sessionId:attached.sessionId});
 // 中文注释：新文档第一个内联脚本运行时预遮罩必须已在 DOM 中。
 await cdp.call('Page.enable');await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:preveilSource([url.slice(0,-1)]),worldName:'hermes-automation-preveil'});
 await cdp.call('Page.navigate',{url:url+'navigate'});await waitFor(()=>cdp.evaluate('location.pathname==="/navigate"&&!!window.overlay'));
 assert.equal(await cdp.evaluate('window.blockedAtFirstScript'),true,'导航首个脚本前应有预遮罩');await click();assert.equal(await cdp.evaluate('window.clicks'),0);
 await cdp.evaluate("document.open();document.write('<html><body><button onclick=window.clicks++>替换文档</button></body></html>');document.close()");await waitFor(()=>cdp.evaluate('overlay.host.isConnected'));
 assert.equal(await cdp.evaluate("overlay.host.style.pointerEvents"),'auto');
 await cdp.call('Page.navigate',{url:url+'preveil-only'});await waitFor(()=>cdp.evaluate("location.pathname==='/preveil-only'&&document.querySelector('dialog')?.open"));
 await pressAt(await pointFor('dialog button'));assert.equal(await cdp.evaluate('window.clicks'),0,'完整遮罩注入前模态层也不能绕过预遮罩');
 console.log(JSON.stringify({browser,passed:['真实命中拦截','放行到期恢复','DOM 重挂','样式修改不授予接管','接管继续','modal/popover','滚轮','状态栏空白','跨进程 iframe 输入','导航首个脚本','document.open','完整模块注入前的模态层拦截']}));
}finally{
 cdp?.close();proc?.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,300));if(proc&&proc.exitCode===null)proc.kill('SIGKILL');
 await new Promise(resolve=>server.close(resolve));await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
