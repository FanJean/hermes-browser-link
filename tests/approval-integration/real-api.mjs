// 中文注释：真实浏览器中验证同源页面请求在智能审批与全部访问下的行为，所有数据均为合成值。
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
 session=await openRealSession({browser,label:'ap'});
 await session.enableFullAccess();
 const task=await openTask(session,{origins:[origin],url:`${origin}/login`,title:'页面请求权限验收'});
 const command={world:'main',expression:'fetch("/api",{credentials:"include"}).then(response=>response.json())'};
 const full=await task.run('js.evaluate',command);
 assert.equal(full.value.count,1,JSON.stringify(full));
 assert.equal(full.value.authenticated,true);
 assert.equal(hits,1);
 // 中文注释：降级为智能审批后，页面请求先等待批准；拒绝不产生 HTTP 请求。
 await session.clickPopup('#access-toggle');
 await waitFor(async()=>(await session.rpc(task.owner,'get',{task_id:task.task.id})).activeMode==='smart',15000);
 const rejectedId='api-reject';
 assert.equal((await task.run('js.evaluate',command,rejectedId)).status,'approval_required');
 await session.approvePanel('reject','执行页面 JavaScript');
 const rejected=await task.run('js.evaluate',command,rejectedId);
 assert.equal(rejected.bridgeCode,'approval_denied',JSON.stringify(rejected));
 assert.equal(hits,1);
 const approvedId='api-approve';
 assert.equal((await task.run('js.evaluate',command,approvedId)).status,'approval_required');
 await session.approvePanel('approve','执行页面 JavaScript');
 const approved=await waitFor(async()=>{
  const result=await task.run('js.evaluate',command,approvedId);
  return result.value?.count===2?result:null;
 },15000);
 assert.equal(approved.value.count,2);
 assert.equal(approved.value.authenticated,true);
 console.log(JSON.stringify({browser,fullDirect:true,smartRejected:true,smartApproved:true,requestCount:hits}));
}finally{await session?.close();server.close();}
