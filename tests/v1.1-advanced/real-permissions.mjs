// 中文注释：在隔离 Chrome/Edge 中验证两档模式、第三方子框架审批与持久脚本撤权清理。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask,helperCall} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';

const outside=createServer((_request,response)=>{
 response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>额外来源</title><p>第三方框架</p>');
});
await new Promise(resolve=>outside.listen(0,'127.0.0.1',resolve));
const outsideOrigin=`http://127.0.0.1:${outside.address().port}`;
const other=createServer((_request,response)=>{
 response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>第二网站</title><p>第二网站正文</p>');
});
await new Promise(resolve=>other.listen(0,'127.0.0.1',resolve));
const otherOrigin=`http://127.0.0.1:${other.address().port}`;
const site=createServer((request,response)=>{
 response.setHeader('Content-Type','text/html');
 response.end(request.url==='/framed'
  ?`<!doctype html><title>权限测试</title><iframe src="${outsideOrigin}/"></iframe>`
  :'<!doctype html><title>权限测试</title><p>任务页面</p>');
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
const browser=process.argv.includes('--edge')?'edge':'chrome';
let session;
try{
 session=await openRealSession({browser,label:'pm'});
 await session.enableFullAccess();
 const task=await openTask(session,{origins:[origin,otherOrigin],url:`${origin}/framed`,title:'两档权限验收'});
 const frameReady=()=>session.ui.evaluate(`chrome.debugger.sendCommand({tabId:${task.tabId}},'Page.getFrameTree',{}).then(r=>r.frameTree?.childFrames?.some(f=>f.frame.url.startsWith(${JSON.stringify(outsideOrigin)})))`);
 await waitFor(frameReady,15000);
 // 中文注释：全部访问的原始 CDP 在包含额外来源的任务页直接执行。
 const full=await task.run('cdp.send',{method:'DOM.getDocument',cdp_params:{depth:1}});
 assert.ok(full.root,JSON.stringify(full));
 const registered=await task.run('cdp.send',{method:'Page.addScriptToEvaluateOnNewDocument',cdp_params:{source:'globalThis.__permissionScript=1'}});
 assert.equal(typeof registered.identifier,'string',JSON.stringify(registered));
 await task.run('navigate',{url:`${origin}/next`});
 assert.equal(await task.read('globalThis.__permissionScript'),1);
 // 中文注释：切回智能审批先移除已登记脚本；下一次导航不得再次运行该脚本。
 await session.clickPopup('#access-toggle');
 await waitFor(async()=>(await session.rpc(task.owner,'get',{task_id:task.task.id})).activeMode==='smart',15000);
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/framed')}}).then(()=>true)`);
 await waitFor(frameReady,15000);
 assert.equal(await task.read('globalThis.__permissionScript'),undefined);
 // 中文注释：tabs 只返回任务租约页；降级后首次读页需确认，同站下一次读取直接执行。
 const ownedTabs=await task.run('tabs');
 assert.deepEqual(ownedTabs.map(tab=>tab.id),[task.tabId]);
 const firstReadId='first-site-read';
 assert.equal((await task.run('snapshot',{},firstReadId)).status,'approval_required');
 await session.approvePanel('approve',`允许读取的网站：${origin}`);
 const firstRead=await waitFor(async()=>{const value=await task.run('snapshot',{},firstReadId);return value.elements?value:null;},15000);
 assert.ok(firstRead.elements);
 assert.ok((await task.run('snapshot',{},'same-site-read')).elements);
 // 中文注释：跨来源跳转后首次读取再次询问；拒绝不读取，后续新请求可重新获批。
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(otherOrigin+'/')}}).then(()=>true)`);
 await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.url.startsWith(${JSON.stringify(otherOrigin)})&&t.status==='complete')`),15000);
 const rejectedReadId='new-site-read-rejected';
 assert.equal((await task.run('snapshot',{},rejectedReadId)).status,'approval_required');
 await session.approvePanel('reject',`允许读取的网站：${otherOrigin}`);
 assert.equal((await task.run('snapshot',{},rejectedReadId)).bridgeCode,'approval_denied');
 const approvedReadId='new-site-read-approved';
 assert.equal((await task.run('snapshot',{},approvedReadId)).status,'approval_required');
 await session.approvePanel('approve',`允许读取的网站：${otherOrigin}`);
 await waitFor(async()=>{const value=await task.run('snapshot',{},approvedReadId);return value.elements?value:null;},15000);
 assert.ok((await task.run('snapshot',{},'new-site-read-next')).elements);
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/framed')}}).then(()=>true)`);
 await waitFor(frameReady,15000);
 assert.ok((await task.run('snapshot',{},'old-site-still-approved')).elements);
 const writeId='write-still-single-action';
 assert.equal((await task.run('click',{selector:'#missing-button'},writeId)).status,'approval_required');
 await session.approvePanel('reject','点击页面');
 assert.equal((await task.run('click',{selector:'#missing-button'},writeId)).bridgeCode,'approval_denied');
 // 中文注释：智能审批先返回等待；批准后相同请求只派发一次，文案列出命令与额外来源。
 const requestId='smart-third-party-cdp';
 const command={method:'DOM.getDocument',cdp_params:{depth:1}};
 const waiting=await task.run('cdp.send',command,requestId);
 assert.equal(waiting.status,'approval_required',JSON.stringify(waiting));
 await session.approvePanel('approve',outsideOrigin);
 const approved=await waitFor(async()=>{
  const result=await task.run('cdp.send',command,requestId);
  return result.root?result:null;
 },15000);
 assert.ok(approved.root);
 const rejectedId='smart-reject-cdp';
 const rejectedCommand={method:'Runtime.evaluate',cdp_params:{expression:'globalThis.__deniedCdp=1'}};
 assert.equal((await task.run('cdp.send',rejectedCommand,rejectedId)).status,'approval_required');
 await session.approvePanel('reject','Runtime.evaluate');
 const rejected=await task.run('cdp.send',rejectedCommand,rejectedId);
 assert.equal(rejected.bridgeCode,'approval_denied',JSON.stringify(rejected));
 assert.equal(await task.read('globalThis.__deniedCdp'),undefined);
 // 中文注释：真实 Python browser_exec 经 daemon 审批后取得一次网关资格，脚本完成立即关闭。
 const script='print("PERMISSION_TABS="+str(len(list_tabs())))';
 const browserExec=()=>helperCall('browser_exec',session.work,task.owner,task.task.id,script,`perm-${browser}`);
 const waitingExec=await browserExec();
 assert.equal(waitingExec.status,'approval_required',JSON.stringify(waitingExec));
 await session.approvePanel('approve','browser_exec');
 const completedExec=await waitFor(async()=>{
  const result=await browserExec();return result.success===true?result:null;
 },20000);
 assert.match(completedExec.output,/PERMISSION_TABS=1/);
 // 中文注释：智能审批的持久脚本说明必须提示跨站持续执行，批准后脚本可在后续页面生效。
 const smartScriptId='smart-persistent-script';
 const smartScript={method:'Page.addScriptToEvaluateOnNewDocument',cdp_params:{source:'globalThis.__smartPersistent=1'}};
 assert.equal((await task.run('cdp.send',smartScript,smartScriptId)).status,'approval_required');
 await session.approvePanel('approve','该脚本会在之后打开的页面上持续执行');
 const smartRegistered=await waitFor(async()=>{
  const result=await task.run('cdp.send',smartScript,smartScriptId);return result.identifier?result:null;
 },15000);
 assert.equal(typeof smartRegistered.identifier,'string');
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/next')}}).then(()=>true)`);
 await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.status==='complete')`),15000);
 assert.equal(await task.read('globalThis.__smartPersistent'),1);
 // 中文注释：恢复全部访问后再次注册持久脚本，任务结束必须完成移除命令及工作页清理。
 await session.clickPopup('#access-toggle');
 await session.clickPopup('#confirm-enable');
 await waitFor(async()=>(await session.rpc(task.owner,'get',{task_id:task.task.id})).activeMode==='full',15000);
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/after-upgrade')}}).then(()=>true)`);
 await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.status==='complete')`),15000);
 assert.equal(await task.read('globalThis.__smartPersistent'),undefined);
 const ending=await task.run('cdp.send',{method:'Page.addScriptToEvaluateOnNewDocument',cdp_params:{source:'globalThis.__taskEndScript=1'}});
 assert.equal(typeof ending.identifier,'string',JSON.stringify(ending));
 await task.run('navigate',{url:`${origin}/next`});
 assert.equal(await task.read('globalThis.__taskEndScript'),1);
 const closed=await session.rpc(task.owner,'cancel',{task_id:task.task.id});
 const remaining=await session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(()=>true,()=>false)`);
 if(remaining){
  // 中文注释：清理若保留了工作页，离开任务后再导航也不得触发旧注册脚本。
  await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/after-end')}}).then(()=>true)`);
  await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.status==='complete')`),15000);
  assert.equal(await session.readUrl(`${origin}/after-end`,'globalThis.__taskEndScript'),undefined);
 }
 await session.clickPopup('#access-toggle');
 const fresh=await session.rpc(task.owner,'create',{title:'新任务站点确认',instance_id:task.instance.instanceId,allowed_origins:[origin]});
 await waitFor(async()=>(await session.rpc(task.owner,'get',{task_id:fresh.id})).state==='ready',15000);
 const freshOpen={task_id:fresh.id,request_id:'fresh-task-open',action:'new_tab',url:`${origin}/next`};
 assert.equal((await session.rpc(task.owner,'run',freshOpen)).status,'approval_required');
 await session.approvePanel('reject',`允许读取的网站：${origin}`);
 assert.equal((await session.rpc(task.owner,'run',freshOpen)).bridgeCode,'approval_denied');
 const freshApproved={...freshOpen,request_id:'fresh-task-open-approved'};
 assert.equal((await session.rpc(task.owner,'run',freshApproved)).status,'approval_required');
 await session.approvePanel('approve',`允许读取的网站：${origin}`);
 const newPage=await waitFor(async()=>{const result=await session.rpc(task.owner,'run',freshApproved);return Number.isInteger(result.tabId)?result:null;},15000);
 const newRead=await session.rpc(task.owner,'run',{task_id:fresh.id,request_id:'fresh-read',action:'snapshot',tab_id:newPage.tabId});
 assert.ok(newRead.elements,JSON.stringify(newRead));
 console.log(JSON.stringify({browser,fullIframeCdp:true,firstReadApproved:true,sameSiteDirect:true,newSiteRejected:true,newSiteApproved:true,taskScopeConfirmed:true,newTabGrantConfirmed:true,smartApproved:true,smartRejected:true,browserExecApproved:true,smartPersistentApproved:true,scriptRemovedOnModeChange:true,scriptRemovedOnTaskEnd:true,cleanupState:closed.cleanupState}));
}finally{
 await session?.close();site.close();outside.close();other.close();
}
