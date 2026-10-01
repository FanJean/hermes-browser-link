// 中文注释：在临时浏览器中验证 Page 下载事件、blob 与其他用户标签的目录隔离，不接入正式任务。
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';

const exec=promisify(execFile);
const binaries={chrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 edge:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
const server=createServer((request,response)=>{
 if(request.url==='/file'){
  response.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="sample.txt"'});
  response.end('download-evidence');return;
 }
 response.setHeader('Content-Type','text/html; charset=utf-8');
 response.end(`<!doctype html><a id="http" href="/file" download>HTTP file</a>
  <button id="blob" onclick="{document.body.dataset.blobClicked='yes';const a=document.createElement('a');a.download='blob.txt';a.href=URL.createObjectURL(new Blob(['blob-evidence'],{type:'text/plain'}));document.body.append(a);a.click();}">Blob file</button>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function run(browser,binary){
 const work=await mkdtemp(path.join('/private/tmp',`hermes-download-${browser}-`));
 const profile=path.join(work,'profile'),extension=path.join(work,'extension');
 const taskDir=path.join(work,'task-downloads'),userDir=path.join(work,'user-downloads');
 await Promise.all([mkdir(profile),mkdir(taskDir),mkdir(userDir)]);
 await exec(process.execPath,['native-extension/build.mjs',extension]);
 await mkdir(path.join(profile,'Default'));
 await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:userDir,prompt_for_download:false}}));
 const child=spawn(binary,['--headless=new','--use-mock-keychain','--password-store=basic',
  '--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
  '--remote-debugging-port=0','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'about:blank'],
 {detached:true,stdio:'ignore',cwd:work});
 let root,ui,user;
 try{
  const port=await waitFor(async()=>{try{return Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{return null;}},20000);
  const base=`http://127.0.0.1:${port}`;
  root=new CdpClient((await fetchJson(base+'/json/version')).webSocketDebuggerUrl);await root.connect();
  const loaded=await root.call('Extensions.loadUnpacked',{path:extension});
  await root.call('Target.createTarget',{url:`chrome-extension://${loaded.id}/popup.html`});
  const target=await waitFor(async()=>(await fetchJson(base+'/json/list')).find(item=>item.url===`chrome-extension://${loaded.id}/popup.html`));
  ui=new CdpClient(target.webSocketDebuggerUrl);await ui.connect();
  await waitFor(()=>ui.evaluate('Boolean(chrome.tabs?.create&&chrome.debugger?.attach)'));
  const tabId=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(url)},active:true}).then(tab=>tab.id)`);
  await waitFor(()=>ui.evaluate(`chrome.tabs.get(${tabId}).then(tab=>tab.status==='complete')`));
  await ui.evaluate(`chrome.debugger.attach({tabId:${tabId}},'1.3')`);
  await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Page.enable')`);
  await ui.evaluate(`(()=>{globalThis.__downloadEvents=[];chrome.debugger.onEvent.addListener((source,method,params)=>{
   if(source.tabId===${tabId}&&method.startsWith('Page.download'))globalThis.__downloadEvents.push({method,params});
  });return true;})()`);
  let behavior;
  try{behavior=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Page.setDownloadBehavior',
   {behavior:'allow',downloadPath:${JSON.stringify(taskDir)}}).then(()=>({accepted:true}))`);}catch(error){behavior={accepted:false,error:String(error)};}
  const blobPoint=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',
   {expression:'(()=>{const r=document.querySelector("#blob").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',returnByValue:true}).then(r=>r.result.value)`);
  await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Input.dispatchMouseEvent',
   {type:'mousePressed',x:${blobPoint.x},y:${blobPoint.y},button:'left',clickCount:1})`);
  await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Input.dispatchMouseEvent',
   {type:'mouseReleased',x:${blobPoint.x},y:${blobPoint.y},button:'left',clickCount:1})`);
  await waitFor(async()=>(await readdir(taskDir)).some(name=>name.includes('blob'))||
   (await readdir(userDir)).some(name=>name.includes('blob')),10000).catch(()=>{});
  await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',
   {expression:'document.querySelector("#http").click()'})`);
  await waitFor(async()=>(await readdir(taskDir)).some(name=>name.includes('sample'))||
   (await readdir(userDir)).some(name=>name.includes('sample')),10000).catch(()=>{});
  const userTarget=await root.call('Target.createTarget',{url});
  const userPage=await waitFor(async()=>(await fetchJson(base+'/json/list')).find(item=>item.id===userTarget.targetId));
  user=new CdpClient(userPage.webSocketDebuggerUrl);await user.connect();
  await waitFor(()=>user.evaluate('document.readyState').then(state=>state==='complete'));
  await user.evaluate('document.querySelector("#http").click()');
  await pause(1000);
  const events=await ui.evaluate('globalThis.__downloadEvents');
  const taskFiles=await readdir(taskDir),userFiles=await readdir(userDir);
  const blobClicked=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',
   {expression:'document.body.dataset.blobClicked',returnByValue:true}).then(r=>r.result.value)`);
  await ui.evaluate(`chrome.debugger.detach({tabId:${tabId}})`);
  return {browser,behavior,blobClicked,events:events.map(item=>({method:item.method,url:item.params?.url,guid:item.params?.guid,
    frameId:item.params?.frameId,state:item.params?.state})),taskFiles,userFiles,
    scope:'临时扩展 Page 下载原型；不代表正式任务归属或生产隔离'};
 }finally{
  user?.close();ui?.close();root?.close();try{process.kill(-child.pid,'SIGTERM');}catch{}
  await pause(300);try{process.kill(-child.pid,'SIGKILL');}catch{}
  await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}

const report={executedAt:new Date().toISOString(),runs:[]};
try{
 for(const [browser,binary] of Object.entries(binaries))report.runs.push(await run(browser,binary));
 await writeFile(new URL('./evidence/download-prototype.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{server.close();}
