// 中文注释：只验证 Bridge/Executor 与浏览器，不启动 Native Messaging；完整连接验收由 real-session 提供。
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';
import {browserPaths,root} from '../native-v2/real-session.mjs';

export async function openExecutorSession({browser}){
 const work=await mkdtemp('/tmp/hermes-page-c-'),extension=path.join(work,'extension'),profile=path.join(work,'profile'),temp=path.join(work,'tmp');
 await mkdir(temp);await mkdir(path.join(work,'hermes'));
 const built=spawnSync(process.execPath,[path.join(root,'native-extension/build.mjs'),extension],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Page chain isolated fixture',version:'1.0',permissions:['debugger','tabs','tabGroups','storage','scripting','downloads'],host_permissions:['http://127.0.0.1/*','http://localhost/*']}));
 await writeFile(path.join(extension,'harness.html'),'<script type="module" src="harness.mjs"></script>');
 await writeFile(path.join(extension,'harness.mjs'),`
  // 中文注释：用生产 Bridge 投影结果，测试专用可信入口安装任务，不伪造网页授权。
  import {Executor} from './core.mjs';import {Bridge} from './bridge.mjs';
  const executor=new Executor(chrome),pending=new Map();
  const bridge=new Bridge({onMessage:{addListener(){}},postMessage:response=>{pending.get(response.id)?.(response);pending.delete(response.id);}},executor,()=>{},{onContentFilter:async()=>(await chrome.storage.local.get('pageContentFilter')).pageContentFilter===true});
  chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(change.url||change.status)void executor.tabEvent(id,'navigated',tab.url,{status:change.status,urlChanged:!!change.url});});
  chrome.tabs.onRemoved.addListener(id=>void executor.tabEvent(id,'closed'));
  globalThis.makeTask=async(url,origins)=>{
   const tab=await chrome.tabs.create({url,active:true});
   while((await chrome.tabs.get(tab.id)).status!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
   const task={id:crypto.randomUUID(),instanceId:'page-fixture',approvalScope:'fixture-owner',generation:1,tabIds:[tab.id],allowedOrigins:origins};
   await executor.approve(task);executor.setMode({...task,modeGeneration:2,activeMode:'full'});return {...task,tabId:tab.id};
  };
  globalThis.request=message=>new Promise(resolve=>{pending.set(message.id,resolve);bridge.receive(message);});
  globalThis.stopTask=taskId=>executor.release({taskId,generation:1,closeAgentTabs:true});
  globalThis.ready=true;`);
 let child,browserClient,ui;
 const close=async()=>{ui?.close();browserClient?.close();if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(resolve=>setTimeout(resolve,300));try{process.kill(-child.pid,'SIGKILL');}catch{}}await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});};
 try{
  child=spawn(browserPaths[browser],['--headless=new','--use-mock-keychain','--password-store=basic','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'about:blank'],{detached:true,stdio:'ignore',env:{...process.env,HOME:process.env.HOME,HERMES_HOME:path.join(work,'hermes'),TMPDIR:temp}});
  const port=await waitFor(async()=>(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
  const base=`http://127.0.0.1:${port}`,version=await fetchJson(`${base}/json/version`);
  browserClient=new CdpClient(version.webSocketDebuggerUrl);await browserClient.connect();
  const {id}=await browserClient.call('Extensions.loadUnpacked',{path:extension});
  await browserClient.call('Target.createTarget',{url:`chrome-extension://${id}/harness.html`});
  const target=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(row=>row.url===`chrome-extension://${id}/harness.html`));
  ui=new CdpClient(target.webSocketDebuggerUrl);await ui.connect();await waitFor(()=>ui.evaluate('globalThis.ready===true'));
  return {ui,version,work,close,enableFullAccess:async()=>{},rpc:(_owner,suffix,args)=>{assert.equal(suffix,'close');return ui.evaluate(`stopTask(${JSON.stringify(args.task_id)})`);}};
 }catch(error){await close();throw error;}
}

export async function openExecutorTask(session,{url,origins}){
 const task=await session.ui.evaluate(`makeTask(${JSON.stringify(url)},${JSON.stringify(origins)})`);
 let sequence=0;
 const handle={task,tabId:task.tabId,owner:'fixture-owner'};
 handle.run=async(action,extra={})=>{
  const rename={snapshot_id:'snapshotId',screenshot_id:'screenshotId',expected_ref:'expectedRef',frame_token:'frameToken'};
  const params={taskId:task.id,generation:1,modeGeneration:2,allowedOrigins:origins,tabId:task.tabId,requestId:`page-${++sequence}`,action,...Object.fromEntries(Object.entries(extra).map(([key,value])=>[rename[key]||key,value]))};
  const response=await session.ui.evaluate(`request(${JSON.stringify({id:params.requestId,method:'browser.execute',params})})`);
  return response.error?{error:response.error.message,bridgeCode:response.error.code,...response.error.data}:response.result;
 };
 handle.read=expression=>session.ui.evaluate(`chrome.debugger.sendCommand({tabId:${task.tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true,awaitPromise:true}).then(reply=>{if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text);return reply.result.value})`);
 handle.ref=async(query,roles)=>{const snap=await handle.run('semantic_snapshot',{options:{mode:'interactive',query,roles,budget:3000}});assert.equal(snap.items?.length,1,JSON.stringify(snap));return {binding:snap.binding,snapshot_id:snap.snapshotId,ref:snap.items[0].ref,item:snap.items[0]};};
 return handle;
}
