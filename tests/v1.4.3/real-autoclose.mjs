// 中文注释：手动验收仅启动临时 Chrome/Edge profile 与本地夹具；不会清理真实浏览器。node tests/v1.4.3/real-autoclose.mjs [--edge]
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {createBenchServer} from '../../bench/site/server.mjs';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';

const exec=promisify(execFile),server=createBenchServer(),results=[];
// 中文注释：原 helper 的工具进程和浏览器 native host 均继承测试秒数；两者使用同一隔离 daemon。
// 中文注释：立即关闭验收不注入覆盖值，直接使用 daemon 的默认行为。
const immediate=process.argv.includes('--immediate');
if(immediate)delete process.env.HERMES_BROWSER_IDLE_CLOSE_SECONDS;else process.env.HERMES_BROWSER_IDLE_CLOSE_SECONDS='3';
process.env.HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS='3600';
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://www.bench.localhost:${server.address().port}`;
let session;
const check=async(label,fn)=>{await fn();results.push({label,ok:true});};
try{
 session=await openRealSession({browser:process.argv.includes('--edge')?'edge':'chrome',label:'ac143',
  hostRules:'MAP *.localhost 127.0.0.1',idleCloseSeconds:immediate?undefined:3,taskIdleTimeoutSeconds:3600});
 await session.enableFullAccess();
 const hook=async(owner,event)=>{
  await exec(process.env.HERMES_PYTHON||path.join(process.env.HOME,'.hermes/hermes-agent/venv/bin/python'),
   [path.join(import.meta.dirname,'real-autoclose-helper.py'),session.work,owner,event],
   {env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:40000});
 };
 const tab=id=>session.ui.evaluate(`chrome.tabs.get(${id}).then(t=>({id:t.id,groupId:t.groupId,windowId:t.windowId})).catch(()=>null)`);
 const group=id=>session.ui.evaluate(`chrome.tabGroups.get(${id}).then(g=>({id:g.id,title:g.title,windowId:g.windowId})).catch(()=>null)`);
 const open=owner=>openTask(session,{owner,origins:[origin],url:origin+'/real-form-cases',title:'自动收组验收'});
 const user=await session.ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin+'/real-form-cases')},active:false}).then(async t=>({tabId:t.id,groupId:await chrome.tabs.group({tabIds:[t.id],createProperties:{windowId:t.windowId}})}))`);
 await session.ui.evaluate(`chrome.tabGroups.update(${user.groupId},{title:'自动收组验收',color:'green'}).then(()=>true)`);
 if(immediate){
  await check('completed：默认立即关闭，仅关闭本 owner 工作页',async()=>{
   const task=await open('completed-owner'),other=await open('other-owner'),before=await tab(task.tabId);
   await hook(task.owner,'completed');
   assert.equal(await tab(task.tabId),null);assert.equal(await group(before.groupId),null);
   assert.ok(await tab(other.tabId));
   const status=await session.rpc(task.owner,'get',{task_id:task.task.id});
   assert.equal(status.cleanupState,'succeeded');assert.equal(status.cleanupReason,'verified_complete');
   await session.rpc(other.owner,'close',{task_id:other.task.id});
  });
 }else{
 await check('completed：短命插件进程结束后，daemon 宽限期仍生效；改标题仍可清理',async()=>{
  const task=await open('completed-owner'),before=await tab(task.tabId);
  await session.ui.evaluate(`chrome.tabGroups.update(${before.groupId},{title:'[已完成] 用户修改标题'}).then(()=>true)`);
  const start=performance.now();await hook(task.owner,'completed');
  assert.ok(await tab(task.tabId),'宽限期之前就删页');
  await waitFor(async()=>!(await tab(task.tabId)),12000);
  assert.ok(performance.now()-start>=2500,'宽限提前结束');assert.equal(await group(before.groupId),null);
 });
 await check('宽限期内再次调用取消计时，直到下一次 completed 才收组',async()=>{
  const task=await open('continue-owner');await hook(task.owner,'completed');
  const read=await task.run('snapshot');assert.ok(!read.error,JSON.stringify(read));
  await new Promise(resolve=>setTimeout(resolve,4000));assert.ok(await tab(task.tabId));
  await hook(task.owner,'completed');await waitFor(async()=>!(await tab(task.tabId)),12000);
 });
 }
 for(const event of ['stop','interrupted','failed'])await check(`${event}：立即关闭 Agent 页和组`,async()=>{
  const task=await open(event+'-owner'),before=await tab(task.tabId);await hook(task.owner,event);
  await waitFor(async()=>!(await tab(task.tabId)),2500);assert.equal(await group(before.groupId),null);
 });
 await check('keep_tabs=true：任务撤权，页面保留，任务组收掉',async()=>{
  const task=await open('keep-owner'),before=await tab(task.tabId);
  const result=await session.rpc(task.owner,'close',{task_id:task.task.id,keep_tabs:true});
  assert.equal(result.state,'closed');await waitFor(async()=>(await tab(task.tabId))?.groupId===-1,12000);
  assert.equal(await group(before.groupId),null);assert.ok(await tab(task.tabId));
  const denied=await task.run('snapshot');assert.ok(denied.error,'终态仍有操作权');
 });
 await check('用户自建的同名组和页面全程保留',async()=>{
  assert.equal((await tab(user.tabId)).groupId,user.groupId);
  assert.equal((await group(user.groupId)).title,'自动收组验收');
 });
 console.log(JSON.stringify({browser:session.browser,passed:true,results},null,2));
}finally{
 try{if(session)await session.close();}finally{await new Promise(resolve=>server.close(resolve));}
}
