// 中文注释：真实 Chrome/Edge 验收只使用新 profile、合成文件和密码；测试扩展没有后台宿主连接入口。
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';

const browser=process.argv.includes('--edge')?'edge':'chrome';
const binary=browser==='edge'?'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root=path.resolve(import.meta.dirname,'../..');
const work=await mkdtemp('/private/tmp/hermes-files-');
const profile=path.join(work,'profile'),extension=path.join(work,'extension'),hermes=path.join(work,'hermes'),temp=path.join(work,'tmp');
const server=createServer((req,res)=>{
 if(req.url==='/file'){
  res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="report.txt"'});
  res.end('synthetic-download');return;
 }
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end('<!doctype html><input id="file" type="file"><input id="password" type="password" autocomplete="current-password"><a id="download" href="/file" download>Download</a>');
});
let child,browserCdp,ui;
try{
 await Promise.all([profile,hermes,temp,path.join(profile,'Default'),path.join(work,'downloads')].map(dir=>mkdir(dir,{recursive:true})));
 await writeFile(path.join(profile,'Default/Preferences'),JSON.stringify({download:{default_directory:path.join(work,'downloads'),prompt_for_download:false}}));
 const built=spawnSync(process.execPath,[path.join(root,'native-extension/build.mjs'),extension],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 // 中文注释：沿用生产模块和所需权限，删除 Native Messaging 后台入口，绝不触碰个人安装。
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Hermes file and Vault audit',version:'1.0',permissions:['debugger','tabs','tabGroups','downloads','storage']}));
 await writeFile(path.join(extension,'harness.html'),'<script type="module" src="harness.mjs"></script>');
 await writeFile(path.join(extension,'harness.mjs'),`import {Executor} from './core.mjs';
 globalThis.reports=[];
 globalThis.executor=new Executor(chrome,()=>{},{onDownloadEvent:async row=>reports.push(row)});
 chrome.downloads.onCreated.addListener(item=>executor.downloads.created(item));
 chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>executor.downloads.determine(item,suggest));
 chrome.downloads.onChanged.addListener(delta=>void executor.downloads.changed(delta));
 chrome.debugger.onEvent.addListener((source,method,params)=>{executor.downloads.observeCdp(source,method,params);executor.pageRuntime.observe(source,method,params);executor.observers.observe(source,method,params);});
 chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(change.url||change.status)void executor.tabEvent(id,'navigated',change.url||tab.url,{status:change.status||null,urlChanged:!!change.url}).catch(()=>{});});
 globalThis.setup=async origin=>{
  await executor.approve({id:'audit',generation:1,instanceId:'isolated',approvalScope:'audit',tabIds:[],allowedOrigins:[origin],downloadKey:'0123456789abcdef'});
  executor.setMode({id:'audit',generation:1,instanceId:'isolated',approvalScope:'audit',modeGeneration:2,activeMode:'full'});
  globalThis.scope={taskId:'audit',instanceId:'isolated',generation:1,modeGeneration:2,allowedOrigins:[origin]};
  const tab=await executor.execute({...scope,action:'new_tab',url:origin+'/',requestId:'audit-open'});
  scope.tabId=tab.tabId;
  return scope;
 };
 globalThis.read=async expression=>(await chrome.debugger.sendCommand({tabId:scope.tabId},'Runtime.evaluate',{expression,returnByValue:true})).result.value;
 globalThis.ready=true;`);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const origin=`http://127.0.0.1:${server.address().port}`;
 child=spawn(binary,['--headless=new','--use-mock-keychain','--password-store=basic','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],
  {detached:true,stdio:'ignore',env:{HOME:process.env.HOME,HERMES_HOME:hermes,TMPDIR:temp,PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8'}});
 const port=await waitFor(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]));
 const base=`http://127.0.0.1:${port}`;
 browserCdp=new CdpClient((await fetchJson(base+'/json/version')).webSocketDebuggerUrl);await browserCdp.connect();
 const {id}=await browserCdp.call('Extensions.loadUnpacked',{path:extension});
 await browserCdp.call('Target.createTarget',{url:`chrome-extension://${id}/harness.html`});
 const target=await waitFor(async()=>(await fetchJson(base+'/json/list')).find(row=>row.url===`chrome-extension://${id}/harness.html`));
 ui=new CdpClient(target.webSocketDebuggerUrl);await ui.connect();await waitFor(()=>ui.evaluate('globalThis.ready'));
 const scope=await ui.evaluate(`setup(${JSON.stringify(origin)})`);
 assert.ok(Number.isInteger(scope.tabId));
 // 中文注释：先通过生产 ArtifactStore 复制文件，再由生产上传路径设置真实 file input。
 const source=path.join(work,'upload.txt');await writeFile(source,'synthetic-upload');
 const registered=spawnSync('python3',['-c',`import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from artifacts import ArtifactStore,LOCAL_PATH_ORIGIN
store=ArtifactStore(Path(sys.argv[2]));task={'id':'audit','generation':1,'state':'ready'}
row=store.register_path(task=task,owner='audit',path=sys.argv[3])
print(json.dumps(str(store.resolve(task=task,owner='audit',origin=LOCAL_PATH_ORIGIN,artifact_id=row['id'])[1])))`,path.join(root,'native-bridge'),hermes,source],{encoding:'utf8'});
 assert.equal(registered.status,0,registered.stderr);
 const upload=await ui.evaluate(`executor.execute({...scope,action:'files.upload',selector:'#file',filePaths:[${registered.stdout.trim()}],artifactOrigin:null})`);
 assert.equal(upload.selectedCount,1);assert.equal(upload.selectionState,'applied');
 assert.equal(upload.selectedFiles.length,1);assert.equal(upload.websiteState,'unverified');
 assert.deepEqual(await ui.evaluate(`read('Array.from(document.querySelector("#file").files,f=>({name:f.name,size:f.size}))')`),[{name:'upload.txt',size:16}]);
 // 中文注释：上传与下载没有执行任意页面脚本，之后仍可用 Vault；测试读回只用于核实合成值。
 await ui.evaluate(`executor.execute({...scope,action:'click',selector:'#download'})`);
 await waitFor(()=>ui.evaluate(`reports.some(row=>row.event==='complete')`));
 const reports=await ui.evaluate('reports');
 const completed=reports.find(row=>row.event==='complete');
 assert.equal(completed.taskId,'audit');assert.equal(completed.generation,1);
 assert.equal(await readFile(completed.path,'utf8'),'synthetic-download');
 assert.ok(completed.path.includes('/hermes-tasks/0123456789abcdef/'));
 await ui.evaluate(`executor.vault.inspect({...scope,nonce:'a'.repeat(48)}).then(value=>(globalThis.inspected=value))`);
 // 中文注释：用真实页面验证检查后字段变成只读时不会写入合成凭据。
 await ui.evaluate(`read('document.querySelector("#password").readOnly=true')`);
 const readonly=await ui.evaluate(`executor.vault.fill({...scope,nonce:'a'.repeat(48),expectedOrigin:${JSON.stringify(origin)},documentGeneration:inspected.documentGeneration,kind:'login',fills:[{index:1,token:'current-password',value:'SyntheticVaultOnly!'}]})`);
 assert.deepEqual(readonly,{filled:0,refused:'inspection_stale'});
 assert.equal(await ui.evaluate(`read('document.querySelector("#password").value')`),'');
 await ui.evaluate(`read('document.querySelector("#password").readOnly=false')`);
 await ui.evaluate(`executor.vault.inspect({...scope,nonce:'a'.repeat(48)}).then(value=>(globalThis.inspected=value))`);
 const filled=await ui.evaluate(`executor.vault.fill({...scope,nonce:'a'.repeat(48),expectedOrigin:${JSON.stringify(origin)},documentGeneration:inspected.documentGeneration,kind:'login',fills:[{index:1,token:'current-password',value:'SyntheticVaultOnly!'}]})`);
 assert.deepEqual(filled,{filled:1});
 assert.equal(await ui.evaluate(`read('document.querySelector("#password").value')`),'SyntheticVaultOnly!');
 const blocked=await ui.evaluate(`executor.execute({...scope,action:'js.evaluate',expression:'document.title',world:'main'}).then(()=>false,error=>error.message)`);
 assert.match(blocked,/CREDENTIAL_MODE_CONFLICT/);
 const screenshot=await ui.evaluate(`executor.execute({...scope,action:'screenshot'}).then(()=>false,error=>error.message)`);
 assert.ok(screenshot,'敏感字段存在时不能把截图交给 agent');
 const replay=await ui.evaluate(`executor.vault.fill({...scope,nonce:'a'.repeat(48),expectedOrigin:${JSON.stringify(origin)},documentGeneration:inspected.documentGeneration,kind:'login',fills:[{index:1,token:'current-password',value:'AnotherSynthetic!'}]})`);
 assert.deepEqual(replay,{filled:0,refused:'inspection_stale'});
 assert.equal(JSON.stringify(await ui.evaluate('executor.diagnostics.snapshot()')).includes('SyntheticVaultOnly!'),false);
 await ui.evaluate(`executor.release({taskId:'audit',generation:1,closeAgentTabs:true})`);
 console.log(JSON.stringify({browser,upload:'passed',download:'attributed',vault:'filled-once',scriptConflict:'denied',screenshot,profile:'temporary'}));
}finally{
 ui?.close();browserCdp?.close();
 if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(resolve=>setTimeout(resolve,300));try{process.kill(-child.pid,'SIGKILL');}catch{}}
 await new Promise(resolve=>server.close(resolve));
 await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
