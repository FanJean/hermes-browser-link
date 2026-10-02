// 中文注释：仅使用临时 profile、临时 daemon 与本地测试页；--baseline 记录修复前行为。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession,openTask,helperCall} from '../native-v2/real-session.mjs';
import {CdpClient,fetchJson,waitFor} from '../native-v2/cdp-client.mjs';
const baseline=process.argv.includes('--baseline'),browser=process.argv.includes('--edge')?'edge':'chrome';
const server=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>浮层断连验收</title><input id="draft"><button id="save" onclick="window.clicks++">保存</button><script>window.clicks=0</script>');});
// 中文注释：显式指定测试 Hermes，避免公共 helper 的默认路径读取真实运行副本。
if(!process.env.HERMES_SOURCE||!process.env.HERMES_PYTHON)throw Error('请设置隔离测试的 HERMES_SOURCE 和 HERMES_PYTHON（参考 docs/testing.md）');
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;let session;
const results=[];
// 中文注释：闭合影子树只通过浏览器 DOM 域观察；页面脚本无法读取浮层私有状态。
async function inspect(client){
 const {root}=await client.call('DOM.getDocument',{depth:-1,pierce:true});const texts=[],buttons={};let hosts=0;
 function visit(node){const a=node.attributes||[];if(a.includes('data-hermes-automation-overlay'))hosts++;if(node.nodeType===3)texts.push(node.nodeValue);const i=a.indexOf('data-action');if(i>=0)buttons[a[i+1]]=node.nodeId;for(const child of [...node.children||[],...node.shadowRoots||[]])visit(child);}
 visit(root);return {hosts,text:texts.join(' '),buttons};
}
async function click(client,action){
 const state=await inspect(client);assert.ok(state.buttons[action],`${action}: ${state.text}`);
 const {model}=await client.call('DOM.getBoxModel',{nodeId:state.buttons[action]});const x=(model.content[0]+model.content[4])/2,y=(model.content[1]+model.content[5])/2;
 for(const type of ['mousePressed','mouseReleased'])await client.call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
}
async function prepare(name){
 const task=await openTask(session,{origins:[origin],url:`${origin}/${name}`,title:name});assert.ok(!(await task.run('snapshot')).error);
 const target=await waitFor(async()=>(await fetchJson(`${session.base}/json/list`)).find(t=>t.url===`${origin}/${name}`));
 const client=new CdpClient(target.webSocketDebuggerUrl);await client.connect();await waitFor(()=>inspect(client),15000,{ready:s=>s.hosts===1});return {task,client};
}
async function observed(name,task,client){
 let state=await inspect(client);
 if(state.hosts){
  try{await click(client,'takeover');}catch(error){if((await inspect(client)).hosts)throw error;}
  await new Promise(resolve=>setTimeout(resolve,8500));state=await inspect(client);}
 const host=await session.rpc(task.owner,'get',{task_id:task.task.id});
 results.push({name,state:host.state,overlay:state.hosts,text:state.text,stuck:state.text.includes('正在暂停')});
 if(!baseline){
  assert.ok(!state.text.includes('正在暂停'),JSON.stringify(results.at(-1)));
  if(state.hosts){assert.match(state.text,/与扩展的连接已断开/);await click(client,'release');}
  await waitFor(()=>inspect(client),5000,{ready:s=>s.hosts===0});
  // 中文注释：真实点击与键盘确认捕获监听器也已卸载，不能仅检查宿主 DOM。
  const point=await client.evaluate("(()=>{const r=document.querySelector('#save').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  for(const type of ['mousePressed','mouseReleased'])await client.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  assert.equal(await client.evaluate('window.clicks'),1);
  await client.evaluate("document.querySelector('#draft').focus()");await client.call('Input.insertText',{text:'已恢复'});assert.equal(await client.evaluate("document.querySelector('#draft').value"),'已恢复');
  assert.notEqual((await session.rpc(task.owner,'get',{task_id:task.task.id})).state,'paused');
 }
 client.close();
}
try{
 session=await openRealSession({browser,label:'orphan',headed:process.argv.includes('--headed')});await session.enableFullAccess();
 let f=await prepare('detach');await session.ui.evaluate(`chrome.debugger.detach({tabId:${f.task.tabId}}).then(()=>true)`);await observed('debugger 分离',f.task,f.client);
 f=await prepare('reload');
 // 中文注释：重载仅限本次临时扩展，旧页面 CDP 保留用于观察残留浮层。
 await session.reloadExtension();
 await observed('扩展重载',f.task,f.client);
 f=await prepare('needs-sync');
 // 中文注释：inspect 只返回当前 fixture 的 daemon，先核对临时根目录再终止，禁止触及真实运行副本。
 const daemon=await helperCall('inspect',session.work);assert.ok(daemon.daemonPath.startsWith(`${session.work}/`));process.kill(daemon.daemonPid,'SIGTERM');
 await waitFor(async()=>{const t=await session.rpc(f.task.owner,'get',{task_id:f.task.task.id});return t.state==='needs_sync';},35000,{label:'临时 daemon 重启后 needs_sync'});
 await observed('needs_sync',f.task,f.client);
 f=await prepare('long-action');const running=f.task.run('js.evaluate',{expression:'new Promise(r=>setTimeout(()=>r(42),11000))',timeout_ms:15000});
 // 中文注释：浮层运行中显示"Hermes 正在工作"；等长动作已派发（守护进程报告 running）再点接管。
 await waitFor(async()=>(await session.rpc(f.task.owner,'get',{task_id:f.task.task.id})).state==='running',5000,{label:'长动作已开始'});await click(f.client,'takeover');
 const progress=await waitFor(()=>inspect(f.client),3000,{label:'长动作接管反馈',ready:s=>baseline||s.text.includes('等待当前步骤结束')});results.push({name:'长动作接管',text:progress.text});
 if(!baseline){
  assert.match(progress.text,/等待当前步骤结束/);
  // 中文注释：超过八秒仍有后台等待进度时不能误报断开，也不能提前放开页面。
  await new Promise(resolve=>setTimeout(resolve,8500));const waiting=await inspect(f.client);assert.match(waiting.text,/等待当前步骤结束/);assert.doesNotMatch(waiting.text,/与扩展的连接已断开/);
 }
 await running;await waitFor(async()=>(await session.rpc(f.task.owner,'get',{task_id:f.task.task.id})).state==='paused',15000);
 f.client.close();console.log(JSON.stringify({browser,baseline,results}));
}catch(error){console.error('BODY-ERROR',error?.stack||error,JSON.stringify(results));throw error;}finally{await session?.close();await new Promise(resolve=>server.close(resolve));}
