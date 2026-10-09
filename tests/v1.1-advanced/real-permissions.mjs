// 中文注释：隔离 Chrome/Edge 验证连接授权直执行、来源边界、断开撤权与持久脚本清理。
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
 response.end(`<!doctype html><title>权限测试</title><p>任务页面</p>
  <button id="write" onclick="document.body.dataset.writes=String(Number(document.body.dataset.writes||0)+1)">写入</button>
  ${request.url==='/framed'?`<iframe src="${outsideOrigin}/"></iframe>`:''}`);
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
const browser=process.argv.includes('--edge')?'edge':'chrome';
let session;
try{
 session=await openRealSession({browser,label:'pm',compactScratch: true});
 await session.enableFullAccess();
 const task=await openTask(session,{origins:[origin,otherOrigin],url:`${origin}/framed`,title:'连接授权验收'});
 const frameReady=()=>session.ui.evaluate(`chrome.debugger.sendCommand({tabId:${task.tabId}},'Page.getFrameTree',{}).then(r=>r.frameTree?.childFrames?.some(f=>f.frame.url.startsWith(${JSON.stringify(outsideOrigin)})))`);
 await waitFor(frameReady,15000);
 // 中文注释：额外子框架不再触发普通动作审批，但顶层来源与任务归属仍逐次检查。
 const command={method:'DOM.getDocument',cdp_params:{depth:1}};
 const full=await task.run('cdp.send',command,'connected-third-party-cdp');
 assert.ok(full.root,JSON.stringify(full));
 assert.deepEqual(await task.run('cdp.send',command,'connected-third-party-cdp'),full);
 assert.deepEqual((await task.run('tabs')).map(tab=>tab.id),[task.tabId]);
 assert.ok((await session.rpc('foreign-owner','get',{task_id:task.task.id})).error);
 const foreign=await task.run('cdp.send',{method:'DOM.getDocument',target_id:'foreign-target'});
 assert.equal(foreign.bridgeCode,'target_not_owned',JSON.stringify(foreign));
 const offsite=await task.run('navigate',{url:`${outsideOrigin}/`});
 assert.ok(offsite.error,JSON.stringify(offsite));
 assert.equal(new URL(await task.read('location.href')).origin,origin);
 assert.ok((await task.run('snapshot',{},'first-site-read')).elements);
 assert.ok((await task.run('snapshot',{},'same-site-read')).elements);
 await task.run('navigate',{url:`${otherOrigin}/`});
 assert.ok((await task.run('snapshot',{},'second-site-read')).elements);
 await task.run('navigate',{url:`${origin}/framed`});
 await waitFor(frameReady,15000);
 assert.ok((await task.run('snapshot',{},'return-site-read')).elements);
 const write={selector:'#write'};
 const written=await task.run('click',write,'direct-write');
 assert.equal(written.error,undefined,JSON.stringify(written));
 assert.notEqual(written.status,'approval_required');
 assert.deepEqual(await task.run('click',write,'direct-write'),written);
 assert.equal(await task.read('document.body.dataset.writes'),'1','same request never repeats a write');
 // 中文注释：真实 browser_exec 直接取得本任务网关，结束后停止自己的 CLI 会话。
 const completedExec=await helperCall('browser_exec',session.work,task.owner,task.task.id,
  'print("PERMISSION_TABS="+str(len(list_tabs())))',`perm-${browser}`);
 try{
  assert.equal(completedExec.success,true,JSON.stringify(completedExec));
  assert.match(completedExec.output,/PERMISSION_TABS=1/);
 }finally{if(completedExec.harness)await helperCall('harness_stop',session.work,completedExec.harness);}
 const scriptCommand={method:'Page.addScriptToEvaluateOnNewDocument',cdp_params:{source:'globalThis.__permissionScript=1'}};
 const registered=await task.run('cdp.send',scriptCommand,'persistent-script');
 assert.equal(typeof registered.identifier,'string',JSON.stringify(registered));
 assert.deepEqual(await task.run('cdp.send',scriptCommand,'persistent-script'),registered,'script registration is not replayed');
 await task.run('navigate',{url:`${origin}/next`});
 assert.equal(await task.read('globalThis.__permissionScript'),1);
 // 中文注释：仅杀本 fixture daemon 触发真实 Native disconnect；保留页用于证明持久脚本被移除。
 await helperCall('kill_daemon',session.work);
 await waitFor(async()=>(await session.rpc(task.owner,'get',{task_id:task.task.id})).state==='needs_sync',45000);
 await session.instance();
 const revoked=await task.run('cdp.send',scriptCommand,'persistent-script');
 assert.ok(revoked.error,JSON.stringify(revoked));
 const blockedWrite=await task.run('click',write,'after-disconnect-write');
 assert.ok(blockedWrite.error,JSON.stringify(blockedWrite));
 assert.equal(await session.readUrl(`${origin}/next`,'globalThis.__permissionScript'),1,'existing page code is not rolled back');
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(`${origin}/after-disconnect`)}}).then(()=>true)`);
 await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.status==='complete')`),15000);
 assert.equal(await session.readUrl(`${origin}/after-disconnect`,'globalThis.__permissionScript'),undefined,'disconnect removes persistent script before next navigation');
 // 中文注释：重新连接不复活旧任务；新任务直接授权，结束后同请求及新请求均拒绝。
 const fresh=await openTask(session,{owner:task.owner,origins:[origin],url:`${origin}/fresh`,title:'断开后新任务'});
 assert.ok((await fresh.run('snapshot')).elements);
 const ending=await fresh.run('cdp.send',scriptCommand,'ending-script');
 assert.equal(typeof ending.identifier,'string',JSON.stringify(ending));
 await fresh.run('navigate',{url:`${origin}/next-fresh`});
 assert.equal(await fresh.read('globalThis.__permissionScript'),1);
 const cancelled=await session.rpc(fresh.owner,'cancel',{task_id:fresh.task.id});
 assert.equal(cancelled.state,'cancelled',JSON.stringify(cancelled));
 assert.equal(cancelled.cleanupState,'succeeded',JSON.stringify(cancelled));
 assert.equal((await fresh.run('cdp.send',scriptCommand,'ending-script')).bridgeCode,'task_closed');
 assert.equal((await fresh.run('click',write,'after-cancel-write')).bridgeCode,'task_closed');
 await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${fresh.tabId}).then(()=>false,()=>true)`));
 console.log(JSON.stringify({browser,connectionAuthorized:true,fullIframeCdp:true,firstAndSameSiteDirect:true,secondSiteDirect:true,taskScopeConfirmed:true,originGuard:true,writeExactlyOnce:true,browserExecDirect:true,scriptRemovedOnDisconnect:true,oldTaskNotRevived:true,newTaskDirect:true,cancelRevokes:true,cleanupState:cancelled.cleanupState}));
}finally{
 await session?.close();site.close();outside.close();other.close();
}
