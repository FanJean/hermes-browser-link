// 中文注释：验证当前扩展的 chrome.debugger 能否通过子 session 读取跨进程 iframe；不授予生产任务能力。
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';

const exec=promisify(execFile);
const binaries={chrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 edge:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
const server=createServer((request,response)=>{
 response.setHeader('Content-Type','text/html; charset=utf-8');
 response.end(request.url==='/child'?'<button id="child">OOPIF target</button>':
  `<!doctype html><iframe id="remote" src="http://frame.test:${server.address().port}/child"></iframe>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const mainUrl=`http://127.0.0.1:${server.address().port}/main`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function run(browser,binary){
 const work=await mkdtemp(path.join('/private/tmp',`hermes-oopif-${browser}-`));
 const profile=path.join(work,'profile'),extension=path.join(work,'extension');
 await mkdir(profile);await exec(process.execPath,['native-extension/build.mjs',extension]);
 const child=spawn(binary,['--headless=new','--use-mock-keychain','--password-store=basic',
  '--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
  '--site-per-process','--host-resolver-rules=MAP frame.test 127.0.0.1',
  '--remote-debugging-port=0','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'about:blank'],
 {detached:true,stdio:'ignore',cwd:work});
 let root,ui;
 try{
  const port=await waitFor(async()=>{try{return Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{return null;}},20000);
  const base=`http://127.0.0.1:${port}`;
  root=new CdpClient((await fetchJson(base+'/json/version')).webSocketDebuggerUrl);await root.connect();
  const loaded=await root.call('Extensions.loadUnpacked',{path:extension});
  await root.call('Target.createTarget',{url:`chrome-extension://${loaded.id}/popup.html`});
  const target=await waitFor(async()=>(await fetchJson(base+'/json/list')).find(item=>item.url===`chrome-extension://${loaded.id}/popup.html`));
  ui=new CdpClient(target.webSocketDebuggerUrl);await ui.connect();
  const tabId=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(mainUrl)},active:true}).then(tab=>tab.id)`);
  await waitFor(()=>ui.evaluate(`chrome.tabs.get(${tabId}).then(tab=>tab.status==='complete')`));
  const attached=await ui.evaluate(`new Promise(async resolve=>{
   let done=false;const onEvent=(source,method,params)=>{
    if(done||source.tabId!==${tabId}||method!=='Target.attachedToTarget'||params.targetInfo?.type!=='iframe')return;
    done=true;chrome.debugger.onEvent.removeListener(onEvent);
    resolve({sessionId:params.sessionId,targetId:params.targetInfo.targetId,url:params.targetInfo.url});
   };
   chrome.debugger.onEvent.addListener(onEvent);
   try{
    await chrome.debugger.attach({tabId:${tabId}},'1.3');
    await chrome.debugger.sendCommand({tabId:${tabId}},'Target.setAutoAttach',{
     autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false}]});
   }catch(error){done=true;chrome.debugger.onEvent.removeListener(onEvent);resolve({error:String(error)});}
   setTimeout(()=>{if(!done){done=true;chrome.debugger.onEvent.removeListener(onEvent);resolve({error:'no_child_session'});}},5000);
  })`);
  assert.ok(attached.sessionId,JSON.stringify(attached));
  const inspected=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId},sessionId:${JSON.stringify(attached.sessionId)}},'Runtime.evaluate',
   {expression:'({url:location.href,text:document.querySelector("#child")?.textContent})',returnByValue:true}).then(r=>r.result.value)`);
  assert.equal(inspected.text,'OOPIF target');
  const tree=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Page.getFrameTree').then(r=>r.frameTree)`);
  const childFrames=(tree.childFrames||[]).map(item=>({id:item.frame.id,url:item.frame.url,loaderId:item.frame.loaderId}));
  const childTree=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId},sessionId:${JSON.stringify(attached.sessionId)}},'Page.getFrameTree').then(r=>r.frameTree)`);
  await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'DOM.enable')`);
  const dom=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'DOM.getDocument',{depth:-1,pierce:false}).then(r=>r.root)`);
  const frameNodes=[];const scan=node=>{if(node.nodeName==='IFRAME')frameNodes.push({frameId:node.frameId,backendNodeId:node.backendNodeId});for(const child of node.children||[])scan(child);};scan(dom);
  await ui.evaluate(`chrome.debugger.detach({tabId:${tabId}})`);
  return {browser,attached:{targetId:attached.targetId,url:attached.url},childFrames,childTree:{id:childTree.frame.id,loaderId:childTree.frame.loaderId},frameNodes,inspected,extensionSession:true,
   scope:'临时扩展直接 CDP 原型；未通过任务授权、语义引用或公开工具'};
 }finally{
  ui?.close();root?.close();try{process.kill(-child.pid,'SIGTERM');}catch{}
  await pause(300);try{process.kill(-child.pid,'SIGKILL');}catch{}
  await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}

const report={executedAt:new Date().toISOString(),runs:[]};
try{
 for(const [browser,binary] of Object.entries(binaries))report.runs.push(await run(browser,binary));
 await writeFile(new URL('./evidence/oopif-prototype.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{server.close();}
