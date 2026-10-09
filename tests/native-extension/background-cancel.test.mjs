import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {isUiSender} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';
import {workspaceFixture, trustedTask} from './workspace-fixture.mjs';

async function background(){
 const events={},releases=[],requests=[],cleanup=[];let finish;
 const task={id:'task',generation:3,revoked:false};
 // 中文注释：替身保留生产 detach 路径的浮层清理依赖；只有 CDP 外部边界被替换。
 const executor={closingTabs:new Set(),overlayCleanupTabs:new Set(),tasks:new Map([['task',task]]),leases:new Map([[7,'task']]),attached:new Set([7]),removeLocalOverlayInput:async()=>{cleanup.push('input');},cleanupDetachedOverlay:async()=>{cleanup.push('overlay');},release:async p=>{releases.push(p);task.revoked=true;await new Promise(r=>finish=r);}};
 const bridge={request:async(method,params)=>{requests.push({method,params});return {state:'cancelled'};}};
 const event=name=>({addListener:fn=>events[name]=fn});
 // 中文注释：合成后台提供通知事件 API，不访问系统通知中心。
 const chrome={notifications:{onClicked:{addListener(){}},clear:async()=>true},runtime:{id:'ext',onMessage:event('message')},alarms:{create(){},onAlarm:event('alarm')},tabs:{onCreated:event('created'),onRemoved:event('removed'),onUpdated:event('updated')},debugger:{onDetach:event('detach')}};
 let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'').replace('const executor=new Executor(chrome,p=>bridge?.request(\'extension.tab_event\',p).catch(()=>{}));','const executor=injectedExecutor;').replace(/^const consent=new BrowserConsent.*;$/m,'const consent={load:async()=>{}};').replace(/connect\(\);\s*$/,'bridge=injectedBridge;connected=true;');
 vm.runInNewContext(source,{CloudLink,CookieMirror,registerWorkspaceStartup:()=>{},chrome,isUiSender,Executor:function(){return executor;},injectedExecutor:executor,injectedBridge:bridge});
 return {events,releases,requests,cleanup,executor,finish:()=>finish()};
}

test('production popup stop closes owned tabs and waits for cleanup before daemon stop',async()=>{
 const f=await background();let response;
 f.events.message({type:'stop',taskId:'task'},{id:'ext',url:'chrome-extension://ext/popup.html'},r=>response=r);
 await new Promise(r=>setImmediate(r));
 assert.equal(f.releases[0].closeAgentTabs,true);
 assert.equal(f.requests.length,0);
 f.finish();await new Promise(r=>setImmediate(r));
 assert.equal(f.requests[0].method,'extension.stop');assert.equal(response.result.state,'cancelled');
});

test('production debugger detach preserves recoverable tabs',async()=>{
 const f=await background();f.events.detach({tabId:7});
 assert.equal(f.releases[0].closeAgentTabs,false);
 assert.deepEqual(f.cleanup,['input'],'local input cleanup starts before release completes');
 assert.equal(f.requests.length,0,'daemon notification must wait for local release');
 f.finish();await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.cleanup,['input','overlay'],'detached overlay cleanup precedes daemon stop');
 assert.equal(f.requests[0].method,'extension.stop');
});

test('production debugger detach from overlay cleanup does not revoke the task again',async()=>{
 const f=await background();f.executor.overlayCleanupTabs.add(7);f.events.detach({tabId:7});
 assert.equal(f.executor.attached.has(7),false);assert.deepEqual(f.releases,[]);assert.deepEqual(f.requests,[]);assert.deepEqual(f.cleanup,[]);
});

test('cancellation waits for a child ownership lookup already in flight',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await e.approve(trustedTask());e.setMode({...trustedTask(),modeGeneration:2,activeMode:'full'});
 let resume,entered,finishClick,clickEntered;const gate=new Promise(r=>resume=r),started=new Promise(r=>entered=r),clickGate=new Promise(r=>finishClick=r),clickStart=new Promise(r=>clickEntered=r);
 f.api.debugger={attach:async()=>{},detach:async()=>{},sendCommand:async(_,method)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Runtime.callFunctionOn'){clickEntered();await clickGate;return {result:{value:{ok:true}}};}
 }};
 // The legacy opener heuristic is deliberately not a production click path.
 const click=e.withSpawnScope(e.tasks.get('a'),1,async()=>{clickEntered();await clickGate;});await clickStart;
 f.tabs.set(15,{id:15,url:'https://example.com/child',openerTabId:1,windowId:7,groupId:-1});
 const spawned=e.workspaces.spawned.bind(e.workspaces);e.workspaces.spawned=async(...args)=>{entered();await gate;return spawned(...args);};
 const created=e.tabCreated({...f.tabs.get(15)});await started;
 const release=e.release({taskId:'a',generation:1,closeAgentTabs:true});
 let finished=false;release.then(()=>finished=true);
 await new Promise(r=>setImmediate(r));assert.equal(finished,false,'cleanup must wait for already-observed child');
 resume();finishClick();await Promise.allSettled([click,created]);await release;
 assert.ok(f.tabs.has(15));assert.ok(!f.removed.includes(15));assert.ok(f.tabs.has(1));
});

test('production onCreated preserves ambiguous concurrent children and reports uncertainty',async()=>{
 const f=workspaceFixture(),events={};let unblock,started;
 const running=new Promise(r=>started=r),gate=new Promise(r=>unblock=r);
 f.api.debugger={attach:async()=>{},detach:async()=>{},sendCommand:async(_,method)=>{
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://example.com/'}}};
  if(method==='Page.createIsolatedWorld')return {executionContextId:1};
  if(method==='Runtime.callFunctionOn'){started();await gate;return {result:{value:{ok:true}}};}
 }};
 const e=new Executor(f.api),ownedEvents=[];e.onEvent=event=>ownedEvents.push(event);await e.approve(trustedTask());e.setMode({...trustedTask(),modeGeneration:2,activeMode:'full'});
 // 中文注释：合成后台提供通知事件 API，不访问系统通知中心。
 const chrome={notifications:{onClicked:{addListener(){}},clear:async()=>true},runtime:{id:'ext',onMessage:{addListener:fn=>events.message=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{onCreated:{addListener:fn=>events.created=fn},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},debugger:{onDetach:{addListener(){}}}};
 let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'').replace("const executor=new Executor(chrome,p=>bridge?.request('extension.tab_event',p).catch(()=>{}));",'const executor=injectedExecutor;').replace(/^const consent=new BrowserConsent.*;$/m,'const consent={load:async()=>{}};').replace(/connect\(\);\s*$/,'');
 vm.runInNewContext(source,{CloudLink,CookieMirror,registerWorkspaceStartup:()=>{},chrome,isUiSender,Executor:function(){return e;},injectedExecutor:e});
 assert.equal(typeof events.created,'function');
 const active=e.withSpawnScope(e.tasks.get('a'),1,async()=>{started();await gate;});
 await running;
 f.tabs.set(11,{id:11,openerTabId:1,url:'https://example.com/child',windowId:7,groupId:-1,active:false});
 f.tabs.set(13,{id:13,openerTabId:11,url:'https://evil.test/grandchild',windowId:7,groupId:-1,active:false});
 f.tabs.set(12,{id:12,url:'https://example.com/personal',windowId:7,groupId:-1,active:true});
 events.created({...f.tabs.get(11)});events.created({...f.tabs.get(13)});events.created({...f.tabs.get(12)});
 unblock();await active;await Promise.allSettled([...e.tasks.get('a').pendingSpawns]);
 const outcome=await e.release({taskId:'a',generation:1,closeAgentTabs:true});
 assert.deepEqual(f.removed,[]);for(const id of [1,11,12,13])assert.ok(f.tabs.has(id));
 assert.deepEqual(ownedEvents,[]);assert.equal(f.tabs.get(11).groupId,-1);
 assert.equal(outcome.cleanupState,'unknown');assert.ok(outcome.unknownTabIds.includes(11));assert.ok(outcome.unknownTabIds.includes(13));
});
