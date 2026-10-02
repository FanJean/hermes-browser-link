// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
// Synthetic native port and extension event loop; never launches a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, readdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Bridge, BrowserConsent, isUiSender} from '../../native-extension/bridge.mjs';

const source=new URL('../../native-extension/',import.meta.url);
const background=await readFile(new URL('background.mjs',source),'utf8');
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
function harness({hostState='cancelled',stopFails=false,resumeState='ready',resumeResponseLost=false,pauseGate=null}={}){
 const calls=[],listeners={};let receiver,disconnect,executor,instance='instance-1';
 let host={id:'task-1',instanceId:instance,generation:3,state:'ready',tabIds:[7],allowedOrigins:['https://example.test']};
 let tab={id:7,url:'https://example.test/page',windowId:4};
 const port={onMessage:{addListener:fn=>receiver=fn},onDisconnect:{addListener:fn=>disconnect=fn},postMessage:message=>{
  calls.push(message);
  queueMicrotask(()=>{
   if(stopFails&&message.method==='extension.stop'){receiver({id:message.id,error:{message:'lost response'}});return;}
   if(message.method==='extension.stop')host={...host,state:hostState};
   if(message.method==='extension.pause')host={...host,state:'paused'};
   if(message.method==='extension.unpause'){host={...host,state:resumeState};if(resumeResponseLost){receiver({id:message.id,error:{message:'lost response'}});return;}};
   let result;
   if(message.method==='extension.hello')result={};
   else if(message.method==='extension.tasks')result=[{...host}];
   else if(message.method==='extension.approvals')result=[];
   else if(['extension.stop','extension.pause','extension.unpause'].includes(message.method))result={...host};
   else throw Error(`unexpected ${message.method}`);
   receiver({id:message.id,result});
  });
 }};
 class FakeExecutor{
  constructor(_api,_onEvent,options){executor=this;this.onOverlayCommand=options?.onOverlayCommand;
   this.tasks=new Map([['task-1',{id:'task-1',instanceId:instance,generation:3,revoked:false,tabIds:new Set([7]),allowedOrigins:['https://example.test'],policy:{activeMode:'smart'}}]]);
   this.docs=new Map([[7,1]]);
   this.leases=new Map([[7,'task-1']]);this.attached=new Set();this.actionGrants=new Map();
   this.diagnostics={size:0,recordSafely(){},exportBundle(){return {};}};
  }
  async release(args){calls.push({method:'local.release',params:args,leaseAtEntry:this.leases.get(7)});this.tasks.get('task-1').revoked=true;this.leases.delete(7);return {released:true,cleanupState:'unknown'};}
  async pause(taskId,generation){const t=this.tasks.get(taskId);assert.equal(t.generation,generation);t.pauseRequested=true;if(pauseGate)await pauseGate;if(t.revoked)throw Error('已撤销');t.paused=true;calls.push({method:'local.pause'});return {paused:true};}
  resume(taskId,generation){const t=this.tasks.get(taskId);assert.equal(t.generation,generation);t.paused=false;t.pauseRequested=false;calls.push({method:'local.resume'});return {paused:false};}
  async disconnect(){}
 }
 class FakeWorkspace{constructor(){this.manager={reconcile:async()=>{}};}async status(){return [];}}
 // 中文注释：合成后台提供通知事件 API，不访问系统通知中心。
 const chrome={notifications:{onClicked:{addListener(){}},clear:async()=>true},runtime:{id:'extension',getURL:p=>`chrome-extension://extension/${p}`,connectNative:()=>port,onMessage:{addListener:f=>listeners.message=f},sendMessage:async()=>{}},storage:{local:{get:async()=>({browserInstanceId:instance}),set:async()=>{}},session:{get:async()=>({instanceId:instance}),set:async()=>{}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{get:async()=>({...tab}),query:async()=>[],onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},debugger:{onDetach:{addListener(){}}}};
 vm.runInNewContext(background.replace(/^import .*;\n/gm,''),{CookieMirror,registerWorkspaceStartup:()=>{},NativeWorkspaces:FakeWorkspace,Executor:FakeExecutor,Bridge,BrowserConsent,isUiSender,createApprovalNotifier:()=>null,origin:u=>new URL(u).origin,chrome,crypto:globalThis.crypto,navigator:{userAgent:'Node'},console,setTimeout,clearTimeout});
 return {calls,tick,command:p=>executor.onOverlayCommand(p),local:()=>executor.tasks.get('task-1'),lease:owner=>executor.leases.set(7,owner),host:x=>host={...host,...x},tab:x=>tab={...tab,...x},disconnect:()=>disconnect?.()};
}
const scope={taskId:'task-1',generation:3,tabId:7,origin:'https://example.test',kind:'stop'};

test('overlay stop releases owned workspace before host revocation and verifies exact cancelled readback',async()=>{
 const h=harness();await h.tick();const result=await h.command(scope);
 assert.deepEqual({...result},{state:'stopped',verified:true,taskId:'task-1',generation:3});
 const methods=h.calls.map(c=>c.method);const release=methods.indexOf('local.release'),stop=methods.indexOf('extension.stop');
 assert.ok(release>=0&&stop>release,methods.join(','));assert.equal(h.calls[release].leaseAtEntry,'task-1');
 assert.equal(h.calls[release].params.closeAgentTabs,true);
 assert.ok(methods.lastIndexOf('extension.tasks')>stop);
});

test('takeover pauses the same task and resume keeps its page lease',async()=>{
 const h=harness();await h.tick();const paused=await h.command({...scope,kind:'takeover'});
 assert.deepEqual({...paused},{state:'paused',verified:true,taskId:'task-1',generation:3});
 assert.equal(h.calls.some(c=>c.method==='local.release'||c.method==='extension.stop'),false);
 assert.equal(h.local().revoked,false);
 const resumed=await h.command({...scope,kind:'resume'});
 assert.deepEqual({...resumed},{state:'running',verified:true,taskId:'task-1',generation:3});
 assert.equal(h.local().paused,false);
 assert.equal(h.calls.some(c=>c.method==='local.release'),false);
});

test('stale instance, generation, lease and origin fail before any stop or release',async()=>{
 for(const mutation of [h=>h.host({instanceId:'other'}),h=>h.host({generation:4}),h=>h.host({state:'failed'}),h=>h.tab({url:'https://other.test/'})]){
  const h=harness();await h.tick();mutation(h);assert.equal((await h.command(scope)).state,'unknown');
  assert.equal(h.calls.some(c=>['local.release','extension.stop'].includes(c.method)),false);
 }
 const h=harness();await h.tick();assert.equal((await h.command({...scope,tabId:8})).state,'unknown');
 assert.equal((await h.command({...scope,origin:'https://other.test'})).state,'unknown');
 assert.equal(h.calls.some(c=>c.method==='extension.stop'),false);
 h.lease('different-task');assert.equal((await h.command(scope)).state,'unknown');
 assert.equal(h.calls.some(c=>c.method==='local.release'),false);
});

test('disconnected bridge cannot verify or replay an overlay stop',async()=>{
 const h=harness();await h.tick();h.disconnect();
 assert.equal((await h.command(scope)).state,'unknown');
 assert.equal(h.calls.some(c=>c.method==='extension.stop'),false);
});

test('lost stop response or non-cancelled readback is unknown and never replays',async()=>{
 for(const options of [{stopFails:true},{hostState:'ready'}]){
  const h=harness(options);await h.tick();const result=await h.command(scope);
  assert.notEqual(result.verified,true);
  assert.equal(result.state,'unknown');
  assert.equal(h.calls.filter(c=>c.method==='extension.stop').length,1);
 }
});

test('clean scratch build includes exact runtime imports and all local panel assets',async()=>{
 const scratch=await mkdtemp(path.join(tmpdir(),'native-overlay-build-'));
 try{
  const target=path.join(scratch,'extension');
  // 中文注释：中文工作目录的文件 URL 须解码为本地路径。
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('build.mjs',source)),target],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  const names=(await readdir(target)).sort();
  for(const name of ['automation-overlay.mjs','approval-notifier.mjs','approval-panel.html','approval-panel.css','approval-panel.mjs','background.mjs','bridge.mjs','core.mjs','manifest.json'])assert.ok(names.includes(name),name);
  for(const name of ['automation-overlay.mjs','approval-notifier.mjs','approval-panel.html','approval-panel.css','approval-panel.mjs']){
   assert.deepEqual(await readFile(path.join(target,name)),await readFile(new URL(name,source)),name);
  }
  for(const name of [...names.filter(n=>n.endsWith('.mjs')),...(await readdir(path.join(target,'vendor'))).filter(n=>n.endsWith('.mjs')).map(n=>`vendor/${n}`)]){
   const code=await readFile(path.join(target,name),'utf8');
   for(const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g))await readFile(path.resolve(target,path.dirname(name),match[1]));
   const syntax=spawnSync(process.execPath,['--check',path.join(target,name)],{encoding:'utf8',timeout:10000});
   assert.equal(syntax.status,0,`${name}: ${syntax.stderr}`);
  }
  const html=await readFile(path.join(target,'approval-panel.html'),'utf8');
  for(const match of html.matchAll(/(?:src|href)="([^"#]+)"/g))await readFile(path.join(target,match[1]));
 }finally{await rm(scratch,{recursive:true,force:true});}
});

// 中文注释：恢复与新动作可以交错，running 仍是有效恢复回执；丢失回执后只按已核实状态修复本地暂停。
test('继续后宿主已运行新动作仍能确认恢复',async()=>{
 const h=harness({resumeState:'running'});await h.tick();await h.command({...scope,kind:'takeover'});
 const result=await h.command({...scope,kind:'resume'});assert.equal(result.verified,true);assert.equal(h.local().paused,false);
});
test('继续回执丢失后再次显式继续可恢复，且不重发已生效的宿主命令',async()=>{
 const h=harness({resumeResponseLost:true});await h.tick();await h.command({...scope,kind:'takeover'});
 assert.equal((await h.command({...scope,kind:'resume'})).state,'unknown');assert.equal(h.local().paused,true);
 const recovered=await h.command({...scope,kind:'resume'});assert.equal(recovered.verified,true);assert.equal(h.local().paused,false);
 assert.equal(h.calls.filter(c=>c.method==='extension.unpause').length,1);
});

// 中文注释：不同页面控制入口不能在交出页面前执行继续；停止仍应可以中断正在暂停的任务。
test('等待在途动作暂停期间拒绝其他入口提前继续',async()=>{
 let finish;const gate=new Promise(resolve=>{finish=resolve;});const h=harness({pauseGate:gate});await h.tick();
 const pausing=h.command({...scope,kind:'takeover'});await h.tick();
 try{const early=await h.command({...scope,kind:'resume'});assert.notEqual(early.verified,true);assert.equal(h.calls.some(c=>c.method==='local.resume'),false);}
 finally{finish();await pausing;}
 assert.equal((await h.command({...scope,kind:'resume'})).verified,true);
});
test('正在暂停的任务仍能从其他入口停止',async()=>{
 let finish;const gate=new Promise(resolve=>{finish=resolve;});const h=harness({pauseGate:gate});await h.tick();
 const pausing=h.command({...scope,kind:'takeover'});await h.tick();
 try{const stopped=await h.command(scope);assert.equal(stopped.state,'stopped');assert.equal(stopped.verified,true);}
 finally{finish();await pausing;}
 assert.equal(h.local().revoked,true);
});
