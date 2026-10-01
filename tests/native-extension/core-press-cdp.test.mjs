import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {CdpClient, fetchJson, waitFor} from '../native-v2/cdp-client.mjs';

const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root=path.resolve(import.meta.dirname,'../..');
const securityAgents=()=>new Set(spawnSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).stdout.split('\n').filter(x=>/\/(?:SecurityAgent|securityagent)(?:\s|$)/.test(x)).map(x=>x.trim()));

// An ephemeral extension imports the source core through the real chrome.debugger API.
async function fixtureExtension(dir){
 // 中文注释：复用正式构建闭包，避免手写复制清单漏掉运行模块。
 const built=spawnSync(process.execPath,[path.join(root,'native-extension/build.mjs'),dir],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 await writeFile(path.join(dir,'manifest.json'),JSON.stringify({manifest_version:3,name:'Native core CDP press fixture',version:'1.0',permissions:['debugger','tabs'],host_permissions:['http://127.0.0.1/*']}));
 await writeFile(path.join(dir,'harness.html'),'<script type="module" src="harness.mjs"></script>');
 await writeFile(path.join(dir,'harness.mjs'),`import {Executor} from './core.mjs';
  const commandLog=[];
  const debuggerApi={onEvent:chrome.debugger.onEvent,onDetach:chrome.debugger.onDetach,attach:(...args)=>chrome.debugger.attach(...args),detach:(...args)=>chrome.debugger.detach(...args),sendCommand:async (target,method,params)=>{commandLog.push({method,params});return chrome.debugger.sendCommand(target,method,params);}};
  globalThis.ready=true;
  globalThis.run=async(tabId,origin)=>{
   const e=new Executor({tabs:chrome.tabs,debugger:debuggerApi});
   await e.approve({id:'test',generation:1,instanceId:'isolated',approvalScope:'isolated',tabIds:[tabId],allowedOrigins:[origin]});
   const request={taskId:'test',tabId,action:'press',selector:'#button',key:'Enter'};
   const nonce=crypto.randomUUID(),digest='test-digest';
   e.approveAction({taskId:'test',generation:1,modeGeneration:1,request,nonce,digest,expiresAt:Date.now()/1000+60});
   const activations=[],onActivated=event=>activations.push(event);
   chrome.tabs.onActivated.addListener(onActivated);
   let result, error;
   try{result=await e.execute({...request,generation:1,modeGeneration:1,allowedOrigins:[origin],approval:{nonce,digest}});}
   catch(e){error=e.message;}
   finally{chrome.tabs.onActivated.removeListener(onActivated);}
   const readback=await chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression:'({title:document.title,active:document.activeElement?.id,events:window.events})',returnByValue:true});
   const output={result,error,readback:readback.result.value,commands:commandLog,activations};
   await e.release({taskId:'test',generation:1,closeAgentTabs:false});return output;
  };`);
}

test('inactive press preserves active tab and produces a trusted DOM click', {timeout:30000,skip:process.platform!=='darwin'||!existsSync(chrome)}, async()=>{
 // 中文注释：系统授权进程可能由其他应用短暂启动；等它明确退出后再记录本测试基线。
 const baseline=await waitFor(()=>{const current=securityAgents();return current.size===0?current:null;},5000);
 const work=await mkdtemp(path.join(process.env.TMPDIR||tmpdir(),'core-press-cdp-'));
 const extension=path.join(work,'extension'),profile=path.join(work,'profile');
 // 中文注释：只隔离 Hermes 和临时文件，HOME 保持真实用户目录，避免钥匙串对话框。
 const hermes=path.join(work,'hermes'),temp=path.join(work,'tmp');
 const server=createServer((_,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><button id="button">Go</button><script>
  window.events=[];for(const name of ['focus','keydown','keypress','keyup','click'])document.querySelector('#button').addEventListener(name,e=>window.events.push({type:e.type,key:e.key,code:e.code,isTrusted:e.isTrusted}));
  document.querySelector('#button').addEventListener('click',()=>document.title='clicked');
 </script>`);});
 let browser,ui,pageClient,child,monitor,securityFailure;
 try{
  await fixtureExtension(extension);await Promise.all([profile,hermes,temp].map(dir=>mkdir(dir)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  child=spawn(chrome,['--window-size=720,540','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--use-mock-keychain','--password-store=basic','--enable-unsafe-extension-debugging','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{detached:true,stdio:'ignore',env:{HOME:process.env.HOME,HERMES_HOME:hermes,TMPDIR:temp,PATH:process.env.PATH||'/usr/bin:/bin',LANG:process.env.LANG||'en_US.UTF-8'}});
  monitor=setInterval(()=>{for(const p of securityAgents())if(!baseline.has(p)){securityFailure=Error(`SecurityAgent appeared: ${p}`);try{process.kill(-child.pid,'SIGTERM');}catch{}}},200);
  const port=await waitFor(async()=>{try{return (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},15000);
  const base=`http://127.0.0.1:${port}`;
  browser=new CdpClient((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl);await browser.connect();
  const {id}=await browser.call('Extensions.loadUnpacked',{path:extension});
  await browser.call('Target.createTarget',{url:`chrome-extension://${id}/harness.html`});
  const target=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(t=>t.url===`chrome-extension://${id}/harness.html`),5000);
  ui=new CdpClient(target.webSocketDebuggerUrl);await ui.connect();await ui.call('Runtime.enable');
  await waitFor(()=>ui.evaluate('Boolean(globalThis.ready)'),5000);
  const tabId=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin+'/')},active:false}).then(t=>t.id)`);
  assert.ok(Number.isInteger(tabId));
  assert.equal((await ui.evaluate(`chrome.tabs.get(${tabId})`)).active,false,'fixture target must begin inactive');
  const fixturePage=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(t=>t.type==='page'&&t.url===`${origin}/`),5000);
  pageClient=new CdpClient(fixturePage.webSocketDebuggerUrl);await pageClient.connect();
  assert.equal(await pageClient.evaluate('document.querySelector("#button")?.id'),'button');
  await browser.call('Target.activateTarget',{targetId:target.id});
  const windowId=(await ui.evaluate(`chrome.tabs.get(${tabId})`)).windowId;
  const activeBefore=(await ui.evaluate(`chrome.tabs.query({active:true,windowId:${windowId}})`))[0].id;
  assert.notEqual(activeBefore,tabId,'fixture must have a different active tab');
  const focusedBefore=(await ui.evaluate('chrome.windows.getAll()')).filter(w=>w.focused).map(w=>w.id);
  const data=await ui.evaluate(`run(${tabId},${JSON.stringify(origin)})`);
  if(securityFailure)throw securityFailure;
  const activeAfter=(await ui.evaluate(`chrome.tabs.query({active:true,windowId:${windowId}})`))[0].id;
  assert.equal(activeAfter,activeBefore,'press must preserve the active tab');
  assert.deepEqual(data.activations,[],'press must not transiently activate any tab');
  assert.deepEqual((await ui.evaluate('chrome.windows.getAll()')).filter(w=>w.focused).map(w=>w.id),focusedBefore,'press must preserve browser window focus');
  const methods=data.commands.map(c=>c.method);
  assert.ok(!methods.includes('Page.bringToFront'),'activation forbidden');
  const readback=await pageClient.evaluate('({title:document.title,active:document.activeElement?.id,events:window.events})');
  assert.deepEqual(data.readback,readback);
  assert.deepEqual(data.result,{ok:true},`press must not return no-op success or failure: ${data.error||''}`);
  assert.equal(methods.filter(method=>method==='Input.dispatchKeyEvent').length,2);
  assert.ok(methods.indexOf('Emulation.setFocusEmulationEnabled')<methods.indexOf('Input.dispatchKeyEvent'));
  assert.deepEqual(data.commands.filter(c=>c.method==='Emulation.setFocusEmulationEnabled').map(c=>c.params.enabled),[true,false]);
  assert.equal(readback.active,'button');
  assert.equal(readback.title,'clicked',JSON.stringify({readback,methods}));
  for(const type of ['keydown','keyup','click'])assert.ok(readback.events.some(e=>e.type===type&&e.isTrusted),JSON.stringify(readback));
  assert.equal(readback.events.filter(e=>e.type==='click').length,1);
 }finally{
  clearInterval(monitor);pageClient?.close();ui?.close();browser?.close();
  if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,250));try{process.kill(-child.pid,'SIGKILL');}catch{}}
  server.close();await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
});
