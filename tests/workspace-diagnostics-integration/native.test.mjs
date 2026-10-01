import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';
export function fixture(){
 const groupInfo=new Map(),data={},tabs=new Map([[1,{id:1,url:'https://example.test/',windowId:7,groupId:-1,active:true}]]);let next=10,group=20;const creates=[],removed=[];
 const api={storage:{local:{get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))}},tabs:{query:async()=>[...tabs.values()].map(tab=>({...tab})),get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},create:async p=>{creates.push(p);const t={...p,id:next++,groupId:-1};tabs.set(t.id,t);return {...t};},group:async p=>{const g=p.groupId??group++;for(const id of p.tabIds)tabs.get(id).groupId=g;return g;},remove:async id=>{removed.push(id);tabs.delete(id);}},tabGroups:{update:async(id,p)=>{groupInfo.set(id,{id,windowId:7,...p});},get:async id=>({...groupInfo.get(id)})},debugger:{detach:async()=>{}}};
 return {api,tabs,creates,removed,data};
}
export async function approve(e,id='task',tabIds=[1]){const task={id,instanceId:'instance',approvalScope:'scope-'+id,generation:1,allowedOrigins:['https://example.test'],tabIds};await e.approve(task);e.setMode({...task,activeMode:'full',modeGeneration:2});return {taskId:id,generation:1,modeGeneration:2,allowedOrigins:task.allowedOrigins,action:'new_tab',requestId:'req',url:'https://example.test/'};}
test('late create does not bypass the cleanup-only cancellation barrier',async()=>{
 const f=fixture();let releaseCreate,created,releaseHook,hookStarted;
 const createGate=new Promise(r=>releaseCreate=r),createdGate=new Promise(r=>created=r),hookGate=new Promise(r=>releaseHook=r),hookEntered=new Promise(r=>hookStarted=r);
 const create=f.api.tabs.create;f.api.tabs.create=async p=>{const tab=await create(p);created();await createGate;return tab;};
 const e=new Executor(f.api,()=>{},{beforeLeaseRelease:async()=>{hookStarted();await hookGate;}}),p=await approve(e);
 const running=e.execute(p);const denied=assert.rejects(running);await createdGate;
 const stopping=e.release({taskId:'task',generation:1,closeAgentTabs:true});await hookEntered;releaseCreate();await new Promise(r=>setTimeout(r,0));
 const retained=f.tabs.has(10);releaseHook();await stopping;await denied;assert.equal(retained,true);assert.deepEqual(f.removed,[10]);
});
test('disconnect preserves recoverable workspace tabs and releases leases',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 await e.disconnect();assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));assert.equal(e.leases.size,0);
 assert.equal((await e.workspaces.status())[0].state,'preserved');
});
test('late new-tab guard retains the disconnect cleanup disposition',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);let entered,resume;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 // Pause at the completed workspace boundary, not its internal grouping readback.
 const open=e.workspaces.open.bind(e.workspaces);e.workspaces.open=async(...args)=>{const tab=await open(...args);entered();await gate;return tab;};
 const running=e.execute(p),denied=assert.rejects(running,/stale/);await started;
 await e.disconnect();resume();await denied;
 assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));assert.equal(e.leases.size,0);
});
test('production concurrent tasks use distinct groups and cancel only one group',async()=>{
 const f=fixture(),e=new Executor(f.api);f.tabs.set(2,{...f.tabs.get(1),id:2});
 const a=await approve(e),b=await approve(e,'second',[2]);const [x,y]=await Promise.all([e.execute(a),e.execute(b)]);
 assert.notEqual(x.groupId,y.groupId);await e.release({taskId:'task',generation:1,closeAgentTabs:true});assert.ok(!f.tabs.has(x.tabId));assert.ok(f.tabs.has(y.tabId));assert.equal(e.leases.get(y.tabId),'second');assert.ok(f.tabs.has(1)&&f.tabs.has(2));
});
test('cleanup-only hook completes before workspace closes task tabs',async()=>{
 const f=fixture();let observed=false;const e=new Executor(f.api,()=>{},{beforeLeaseRelease:async()=>{await new Promise(r=>setTimeout(r,0));observed=f.tabs.has(10);}});
 const p=await approve(e);await e.execute(p);await e.release({taskId:'task',generation:1,closeAgentTabs:true});assert.equal(observed,true);assert.deepEqual(f.removed,[10]);
});
test('recovered failure release preserves tabs until explicit completion',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 const restored=new Executor(f.api);restored.workspaces=new NativeWorkspaces(f.api,'instance');
 const result=await restored.release({taskId:'task',generation:1,closeAgentTabs:false});
 assert.deepEqual(f.removed,[]);assert.equal(result.cleanupState,'succeeded');
 await restored.release({taskId:'task',generation:1,closeAgentTabs:true});assert.deepEqual(f.removed,[10]);
});
test('recovered initialization is bounded and cannot delete tabs after timing out',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 let resume;const gate=new Promise(r=>resume=r),get=f.api.storage.local.get;
 f.api.storage.local.get=async key=>{await gate;return get(key);};
 // 中文注释：用显式短期限验证有界行为，不依赖生产默认期限。
 const restored=new Executor(f.api,()=>{},{releaseDeadlineMs:80});restored.workspaces=new NativeWorkspaces(f.api,'instance');
 const result=await Promise.race([restored.release({taskId:'task',generation:1,closeAgentTabs:true}),new Promise(r=>setTimeout(()=>r('UNBOUNDED'),250))]);
 resume();await new Promise(r=>setTimeout(r,20));
 assert.equal(result.released,true);assert.equal(result.cleanupState,'unknown');assert.deepEqual(f.removed,[]);
});
test('worker recovery release cleans known owned tabs but retains moved and unknown tabs',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);f.tabs.get(10).groupId=-1;
 await e.execute({...p,requestId:'second'});f.api.tabs.group=async()=>{throw Error('lost');};await assert.rejects(e.execute({...p,requestId:'third'}));
 const restored=new Executor(f.api);restored.workspaces=new NativeWorkspaces(f.api,'instance',id=>restored.leases.has(id));
 await restored.release({taskId:'task',generation:1,closeAgentTabs:true});assert.deepEqual(f.removed,[11]);assert.ok(f.tabs.has(10));assert.ok(f.tabs.has(12));assert.ok(f.tabs.has(1));
});
test('forged reused create result cannot group or remove a user leased tab',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);let grouped=0;
 f.api.tabs.create=async()=>({...f.tabs.get(1)});f.api.tabs.group=async()=>{grouped++;return 20;};
 await assert.rejects(e.execute(p));assert.equal(grouped,0);assert.deepEqual(f.removed,[]);assert.equal(f.tabs.get(1).groupId,-1);
});
test('workspace adapter rejects an approval from another browser instance',async()=>{
 const f=fixture(),w=new NativeWorkspaces(f.api,'instance');
 await assert.rejects(w.install({id:'task',approvalScope:'scope',instanceId:'other',generation:1},[f.tabs.get(1)]));
 assert.equal(f.creates.length,0);
});
test('cleanup-only hook runs after execution fence but before lease revocation; failure still releases lease',async()=>{
 const f=fixture();let e,called=false;
 e=new Executor(f.api,()=>{},{beforeLeaseRelease:async scope=>{called=true;assert.equal(scope.cleanupOnly,true);assert.equal(e.leases.get(1),'task');await assert.rejects(e.execute({taskId:'task',generation:1,action:'tabs',allowedOrigins:['https://example.test']}));throw Error('cleanup uncertain');}});
 await approve(e);const result=await e.release({taskId:'task',generation:1,closeAgentTabs:true});
 assert.equal(called,true);assert.equal(result.cleanupState,'unknown');assert.equal(e.leases.has(1),false);assert.ok(f.tabs.has(1));
});
test('explicitly kept workspace tabs survive completion and repeated cleanup',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);await e.execute({...p,requestId:'second'});
 await e.release({taskId:'task',generation:1,closeAgentTabs:true,keepTabIds:[10]});
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});
 assert.deepEqual(f.removed,[11]);assert.ok(f.tabs.has(10)&&f.tabs.has(1));assert.equal(e.leases.size,0);
});
test('missing workspace ownership never falls back to legacy agent-tab deletion',async()=>{
 const f=fixture(),e=new Executor(f.api);await approve(e);
 const t=e.tasks.get('task');t.agentTabs.add(1);
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});
 assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(1));assert.equal(e.leases.size,0);
});
test('preserved workspace tab adopted by another task is retained on old-task completion',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 await e.release({taskId:'task',generation:1,closeAgentTabs:false});await approve(e,'second',[10]);
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});
 assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));assert.equal(e.leases.get(10),'second');
});
test('moved workspace tab is retained and never hit by legacy agentTabs delete',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);f.tabs.get(10).groupId=-1;
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});await e.release({taskId:'task',generation:1,closeAgentTabs:true});
 assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));assert.equal(e.leases.has(10),false);
});
test('unknown group response stays visible and never recreates or closes uncertain tab',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);f.api.tabs.group=async()=>{throw Error('response lost');};
 await assert.rejects(e.execute(p),{code:'workspace_unknown'});await assert.rejects(e.execute(p),{code:'workspace_unknown'});assert.equal(f.creates.length,1);
 const status=await e.workspaces.status();assert.equal(status[0].unknown,1);
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));
});
test('late create cancellation fences and cleans observed result without moving user tabs',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);let resume,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>resume=r),create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const tab=await create(p);started();await gate;return tab;};
 const result=e.execute(p);await entered;const cancelled=e.release({taskId:'task',generation:1,closeAgentTabs:true});resume();
 await assert.rejects(result);await cancelled;assert.deepEqual(f.removed,[10]);assert.ok(f.tabs.has(1));
});
test('Bridge reports workspace uncertainty as typed non-replayable outcome',async()=>{
 const messages=[];const e={execute:async()=>{const error=Error('uncertain');error.code='workspace_unknown';throw error;}};
 const b=new Bridge({onMessage:{addListener(){}},postMessage:m=>messages.push(m)},e);
 b.receive({id:'one',method:'browser.execute',params:{}});await new Promise(r=>setTimeout(r,0));
 assert.equal(messages[0].error.code,'workspace_unknown');
});
test('disconnect emits allowlisted local connection event',()=>{
 const e=new Executor(fixture().api),b=new Bridge({onMessage:{addListener(){}},postMessage(){}},e);b.close();
 assert.equal(e.diagnostics.snapshot().at(-1)?.status,'disconnected');
});
test('executor diagnostics omit secret payloads and failure cannot affect execution',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);
 await e.execute({...p,url:'https://example.test/?secret=COOKIE_SENTINEL'});
 const events=e.diagnostics.exportBundle().events;
 assert.deepEqual(events.filter(x=>x.stage===null).map(x=>x.status),['running','succeeded']);assert.ok(!JSON.stringify(events).includes('COOKIE_SENTINEL'));
 e.diagnostics.recordSafely=()=>{throw Error('sink failed');};
 const result=await e.execute({...p,requestId:'another'});assert.equal(result.tabId,11);
});
test('cleanup hook timeout is bounded while execution stays fenced and leases stay held',async()=>{
 const f=fixture();let entered;const started=new Promise(r=>entered=r);
 const e=new Executor(f.api,()=>{},{beforeLeaseRelease:()=>{entered();return new Promise(()=>{});}}),p=await approve(e);await e.execute(p);
 const releasing=e.release({taskId:'task',generation:1,closeAgentTabs:true});await started;
 assert.equal(e.leases.get(10),'task');assert.ok(f.tabs.has(10));await assert.rejects(e.execute(p),/stale/);
 const result=await releasing;assert.equal(result.cleanupState,'unknown');assert.equal(e.leases.size,0);assert.deepEqual(f.removed,[10]);
});
test('workspace cleanup timeout releases leases and stops delayed deletion',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 let resume,entered;const gate=new Promise(r=>resume=r),started=new Promise(r=>entered=r),get=f.api.tabs.get;
 f.api.tabs.get=async id=>{if(id===10){entered();await gate;}return get(id);};
 const releasing=e.release({taskId:'task',generation:1,closeAgentTabs:true});await started;assert.equal(e.leases.get(10),'task');
 const result=await releasing;assert.equal(result.cleanupState,'unknown');assert.equal(e.leases.size,0);
 resume();await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));
});
test('disconnect during pending creation keeps the late result recoverable',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);let resume,entered;
 const gate=new Promise(r=>resume=r),started=new Promise(r=>entered=r),create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const tab=await create(p);entered();await gate;return tab;};
 const running=e.execute(p),denied=assert.rejects(running);await started;const stopping=e.disconnect();resume();await stopping;await denied;
 assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));assert.equal(e.leases.size,0);assert.equal((await e.workspaces.status())[0].state,'preserved');
});
test('failed origin transition preserves workspace tabs',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);
 await e.tabEvent(10,'updated','https://other.test/');assert.deepEqual(f.removed,[]);assert.ok(f.tabs.has(10));
 // 离开授权网站不撤销任务：租约与分组保留，该页被冻结直到回到授权网站。
 assert.equal(e.leases.get(10),'task');assert.equal(e.tasks.get('task').revoked,false);assert.ok(e.tasks.get('task').offScopeTabs.has(10));
});
test('recovered completion respects explicit kept tabs and current-generation leases',async()=>{
 const f=fixture(),e=new Executor(f.api),p=await approve(e);await e.execute(p);await e.execute({...p,requestId:'second'});
 const restored=new Executor(f.api);restored.workspaces=new NativeWorkspaces(f.api,'instance');await approve(restored,'second',[10]);
 await restored.release({taskId:'task',generation:1,closeAgentTabs:true,keepTabIds:[11]});assert.deepEqual(f.removed,[]);assert.equal(restored.leases.get(10),'second');
});
test('production executor new_tab uses background group and preserves user tab on cancel',async()=>{
 const f=fixture(),e=new Executor(f.api);const p=await approve(e);const result=await e.execute(p);
 assert.equal(result.groupId,20);assert.equal(result.windowId,7);assert.equal(f.creates[0].active,false);assert.equal(f.tabs.get(1).groupId,-1);
 await e.release({taskId:'task',generation:1,closeAgentTabs:true});assert.deepEqual(f.removed,[10]);assert.ok(f.tabs.has(1));
});
