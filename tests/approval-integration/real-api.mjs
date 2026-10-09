// 中文注释：隔离浏览器验证连接授权的同源请求、停止撤权与同请求不重放；数据均为合成值。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';

let hits=0;
const server=createServer((request,response)=>{
 if(request.url==='/login'){
  response.setHeader('Set-Cookie','fixture_login=present; HttpOnly; SameSite=Strict; Path=/');
  response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>API 验收</title>');return;
 }
 if(request.url==='/api'){
  hits++;
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify({count:hits,authenticated:request.headers.cookie?.includes('fixture_login=present')===true,token:'SYNTHETIC_SECRET'}));return;
 }
 response.writeHead(404);response.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=process.argv.includes('--edge')?'edge':'chrome';
let session;
try{
 session=await openRealSession({browser,label:'ap',compactScratch: true});
 await session.enableFullAccess();
 const task=await openTask(session,{origins:[origin],url:`${origin}/login`,title:'页面请求权限验收'});
 const command={world:'main',expression:'fetch("/api",{credentials:"include"}).then(response=>response.json())'};
 const full=await task.run('js.evaluate',command,'api-direct');
 assert.equal(full.value.count,1,JSON.stringify(full));
 assert.equal(full.value.authenticated,true);
 assert.equal(hits,1);
 assert.deepEqual(await task.run('js.evaluate',command,'api-direct'),full);
 assert.equal(hits,1,'same request ID reads the result without another HTTP request');
 assert.ok((await session.rpc('foreign-owner','run',{task_id:task.task.id,request_id:'foreign-api',action:'js.evaluate',tab_id:task.tabId,...command})).error);
 assert.ok((await task.run('navigate',{url:'https://example.com/'})).error);
 assert.equal(new URL(await task.read('location.href')).origin,origin);
 // 中文注释：通过真实弹窗停止事件撤权，旧请求和新请求都不得产生 HTTP 请求。
 await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{active:true}).then(()=>chrome.runtime.sendMessage({type:'changed'}))`);
 await waitFor(()=>session.ui.evaluate(`(()=>{const e=document.querySelector('#page-task');return !e.hidden&&e.dataset.taskId===${JSON.stringify(task.task.id)}&&!document.querySelector('#stop-task').disabled})()`),15000);
 await session.ui.evaluate(`document.querySelector('#stop-task').click()`);
 const stopped=await waitFor(async()=>{const current=await session.rpc(task.owner,'get',{task_id:task.task.id});return current.state==='cancelled'?current:null;},15000);
 assert.equal(stopped.cleanupState,'succeeded',JSON.stringify(stopped));
 assert.equal((await task.run('js.evaluate',command,'api-direct')).bridgeCode,'task_closed');
 assert.equal((await task.run('js.evaluate',command,'api-after-stop')).bridgeCode,'task_closed');
 assert.equal(hits,1);
 const fresh=await openTask(session,{origins:[origin],url:`${origin}/login`,title:'停止后新任务请求'});
 const direct=await fresh.run('js.evaluate',command,'api-fresh');
 assert.equal(direct.value.count,2,JSON.stringify(direct));
 assert.equal(direct.value.authenticated,true);
 assert.deepEqual(await fresh.run('js.evaluate',command,'api-fresh'),direct);
 assert.equal(hits,2,'only explicitly new task action produces the second request');
 console.log(JSON.stringify({browser,connectionAuthorized:true,fullDirect:true,taskOwnershipGuard:true,originGuard:true,stopRevokes:true,newTaskDirect:true,noReplay:true,requestCount:hits}));
}finally{await session?.close();server.close();}
