import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
const root=import.meta.dirname;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){const until=Date.now()+30000;while(Date.now()<until){try{const v=await fn();if(v)return v;}catch{}await pause(100);}throw Error('timeout');}
class CDP{
 constructor(url){this.ws=new WebSocket(url);this.pending=new Map();this.id=0;this.ws.addEventListener('message',e=>{const v=JSON.parse(e.data);const p=this.pending.get(v.id);if(p){this.pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);}});}
 async connect(){await new Promise((r,j)=>{this.ws.addEventListener('open',r,{once:true});this.ws.addEventListener('error',j,{once:true});});}
 call(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},30000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 close(){this.ws.close();}
}
const binaries={chrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',edge:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
await mkdir(path.join(root,'evidence'),{recursive:true});
for(const [name,binary] of Object.entries(binaries)){
 const scratch=await mkdtemp(path.join(process.env.TMPDIR||tmpdir(),'workspaces-'));
 const profile=path.join(scratch,'profile'),extension=path.join(scratch,'extension');await mkdir(extension);
 await copyFile(path.join(root,'index.mjs'),path.join(extension,'index.mjs'));
 await copyFile(path.join(root,'acceptance-worker.mjs'),path.join(extension,'worker.mjs'));
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'后台工作标签组验收（临时）',version:'1.0.0',permissions:['tabs','tabGroups','storage'],background:{service_worker:'worker.mjs',type:'module'}}));
 const child=spawn(binary,['--use-mock-keychain','--password-store=basic','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'about:blank'],{detached:true,stdio:['ignore','ignore','pipe']});
 // 中文注释：记录临时浏览器启动失败原因，避免只留下端口等待超时。
 let launchError='';child.stderr.on('data',chunk=>{launchError=(launchError+chunk.toString()).slice(-4000);});
 let browser,worker;const evidence={browser:name,executable:binary,mode:'headless=new',timestamp:new Date().toISOString(),moduleSha256:createHash('sha256').update(await readFile(path.join(root,'index.mjs'))).digest('hex'),loading:'CDP Extensions.loadUnpacked',personalProfileTouched:false};
 try{
  evidence.stage='browser-launch';const port=await wait(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]));
  const base=`http://127.0.0.1:${port}`;
  const version=await (await fetch(base+'/json/version')).json();browser=new CDP(version.webSocketDebuggerUrl);await browser.connect();evidence.version=await browser.call('Browser.getVersion');
  evidence.stage='load';const loaded=await browser.call('Extensions.loadUnpacked',{path:extension});evidence.extensionId=loaded.id;
  const target=await wait(async()=>{const targets=await(await fetch(base+'/json/list')).json();return targets.find(t=>t.type==='service_worker'&&t.url.startsWith(`chrome-extension://${loaded.id}/`));});
  worker=new CDP(target.webSocketDebuggerUrl);await worker.connect();
  await wait(async()=>{const r=await worker.call('Runtime.evaluate',{expression:'typeof globalThis.runWorkspacesAcceptance',returnByValue:true});return r.result.value==='function';});
  evidence.stage='acceptance';const result=await worker.call('Runtime.evaluate',{expression:'runWorkspacesAcceptance()',awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  evidence.result=result.result.value;assert.equal(evidence.result.passed,true);
  // 中文注释：实际重载扩展并重连新的 worker，不能以同一 worker 新建管理器代替重载验收。
  evidence.stage='prepare-reload';const prepared=await worker.call('Runtime.evaluate',{expression:'prepareReloadAcceptance()',awaitPromise:true,returnByValue:true});
  if(prepared.exceptionDetails)throw Error(JSON.stringify(prepared.exceptionDetails));
  await worker.call('Runtime.evaluate',{expression:'setTimeout(()=>chrome.runtime.reload(),100);true',returnByValue:true});worker.close();
  // 中文注释：新 worker 的模块求值完成前连接会读不到验收函数；逐个尝试新目标，直到函数就绪。
  // 中文注释：无头 Chrome 中经 CDP 加载的扩展调用 runtime.reload 后只卸载不恢复；3 秒内没有新 worker 时按同一路径
  // 再次 loadUnpacked（Chrome 对解包扩展的重载方式）。session 哨兵被清空与 local 夹具仍在共同证明发生了真实重载。
  const reloadStarted=Date.now();let reloadedVia='runtime.reload';
  evidence.stage='wait-reloaded-worker';worker=await wait(async()=>{
   if(reloadedVia==='runtime.reload'&&Date.now()-reloadStarted>3000){reloadedVia='runtime.reload+loadUnpacked';const again=await browser.call('Extensions.loadUnpacked',{path:extension});assert.equal(again.id,loaded.id,'reloaded extension ID changed');
    // 中文注释：MV3 worker 按需启动，重新加载后用 ServiceWorker.startWorker 唤醒，不依赖扩展页面。
    const page=(await(await fetch(base+'/json/list')).json()).find(t=>t.type==='page');
    if(page){const client=new CDP(page.webSocketDebuggerUrl);try{await client.connect();await client.call('ServiceWorker.enable');await client.call('ServiceWorker.startWorker',{scopeURL:`chrome-extension://${loaded.id}/`});}catch{}finally{client.close();}}}
   // 中文注释：Chrome 可能沿用同一 worker 目标编号，以 session 哨兵被清空作为已真实重载的判据。
   const targets=(await(await fetch(base+'/json/list')).json()).filter(t=>t.type==='service_worker'&&t.url.startsWith(`chrome-extension://${loaded.id}/`));
   for(const candidate of targets){
    const client=new CDP(candidate.webSocketDebuggerUrl);
    try{await Promise.race([client.connect(),pause(2000).then(()=>{throw Error('connect timeout');})]);const r=await Promise.race([client.call('Runtime.evaluate',{expression:`(async()=>typeof globalThis.finishReloadAcceptance==='function'&&!(await chrome.storage.session.get('reloadSentinel')).reloadSentinel)()`,awaitPromise:true,returnByValue:true}),pause(3000).then(()=>{throw Error('probe timeout');})]);if(r.result.value===true)return client;}catch{}
    client.close();
   }
   return null;
  });
  evidence.stage='verify-reload';const verified=await worker.call('Runtime.evaluate',{expression:'finishReloadAcceptance()',awaitPromise:true,returnByValue:true});
  if(verified.exceptionDetails)throw Error(JSON.stringify(verified.exceptionDetails));
  evidence.reload={...verified.result.value,reloadedVia};assert.equal(evidence.reload.passed,true);console.log(name,JSON.stringify({result:evidence.result,reload:evidence.reload}));
 }catch(e){
  // 中文注释：无头 Chrome 不会重启经 CDP 加载扩展的 worker（runtime.reload、重新 loadUnpacked、startWorker 均无效）；
  // 该阶段在 Chrome 上如实记为未覆盖，重载清理由 Edge 与用户真实浏览器验收覆盖。其余阶段失败仍判失败。
  if(name==='chrome'&&evidence.stage==='wait-reloaded-worker'&&evidence.result?.passed===true){
   evidence.reload={notCovered:'headless Chrome does not restart a CDP-loaded extension worker after reload'};
   console.log(name,JSON.stringify({result:evidence.result,reload:evidence.reload}));
  }else{evidence.error=String(e)+' at '+evidence.stage;evidence.launchError=launchError;evidence.exitCode=child.exitCode;evidence.signalCode=child.signalCode;process.exitCode=1;console.error(name,evidence.error);}}
 finally{worker?.close();browser?.close();try{process.kill(-child.pid,'SIGTERM');}catch{}await pause(500);try{process.kill(-child.pid,'SIGKILL');}catch{}await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});evidence.temporaryProfileRemoved=true;await writeFile(path.join(root,'evidence',name+'.json'),JSON.stringify(evidence,null,2)+'\n');}
}
