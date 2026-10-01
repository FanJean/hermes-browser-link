import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {workspaceFixture,trustedTask} from './workspace-fixture.mjs';
const journalKey='hermes.backgroundWorkspaces.v1';
const open=(e,id='a',requestId='new')=>e.execute({taskId:id,generation:1,action:'new_tab',requestId,url:'https://example.com/',allowedOrigins:['https://example.com'],modeGeneration:2});
async function approve(e,id='a',ids=[1]){const t=trustedTask(id,ids);await e.approve(t);e.setMode({...t,modeGeneration:2,activeMode:'full'});}

test('create response cannot turn an unleased startup tab into task ownership',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await approve(e,'a',[]);
 f.api.tabs.create=async()=>({...f.tabs.get(1)});
 await assert.rejects(open(e),{code:'workspace_unknown'});
 assert.deepEqual(f.groups,[]);assert.equal(e.leases.has(1),false);
 await e.release({taskId:'a',generation:1});assert.ok(f.tabs.has(1));assert.deepEqual(f.removed,[]);
});

test('failed baseline persistence cannot publish a task on a later approval retry',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api),set=f.api.storage.local.set;
 f.api.storage.local.set=async()=>{throw Error('session storage unavailable');};
 await assert.rejects(approve(e),/session storage unavailable/);assert.equal(e.tasks.size,0);
 f.api.storage.local.set=set;
 await approve(e);
 assert.ok(f.data[journalKey]?.tasks[0][1].baseline,'retry must persist protection before publishing task');
});

test('parallel task baselines subtract authority without protecting peer tabs from their real owner',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await approve(e,'a',[]);
 const a=await open(e,'a');await approve(e,'b',[]);const b=await open(e,'b');
 const records=f.data[journalKey].tasks;
 const recordA=records.find(([key])=>JSON.parse(key)[2]==='a')[1];
 const recordB=records.find(([key])=>JSON.parse(key)[2]==='b')[1];
 assert.ok(!recordA.baseline.tabIds.includes(a.tabId));assert.ok(recordB.baseline.tabIds.includes(a.tabId));
 assert.ok(!recordB.baseline.tabIds.includes(b.tabId));
 await e.release({taskId:'b',generation:1});assert.ok(f.tabs.has(a.tabId));assert.ok(!f.tabs.has(b.tabId));
 await e.release({taskId:'a',generation:1});assert.ok(!f.tabs.has(a.tabId));assert.ok(f.tabs.has(1));
});

test('used and regrouped original tabs survive recovered cleanup and explicit retry',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await approve(e);
 const work=await open(e);
 assert.deepEqual((await e.execute({taskId:'a',generation:1,action:'tabs',allowedOrigins:['https://example.com'],modeGeneration:2})).map(t=>t.id),[1,work.tabId]);
 await e.disconnect();
 const journal=f.data[journalKey],record=journal.tasks[0][1];
 f.tabs.get(1).groupId=work.groupId;record.requests.push(['old-ownership',{status:'ready',tabId:1,groupId:work.groupId}]);
 // Simulate unresolved cleanup journal, then restart the worker. No recapture allowed.
 journal.preserved=[];journal.cancelled=[];
 f.api.tabs.query=async()=>{assert.fail('recovery must not recapture startup inventory');};
 const recovered=new Executor(f.api);recovered.workspaces=new NativeWorkspaces(f.api,'fixture-browser-instance');
 const status=await recovered.cleanupStatus({taskId:'a',generation:1});
 assert.deepEqual(status.remainingTabIds,[work.tabId]);assert.ok(status.preservedTabIds.includes(1));
 await assert.rejects(recovered.cleanupRetry({taskId:'a',generation:1,tabIds:[1,work.tabId]}),/inventory changed/);
 await recovered.cleanupRetry({taskId:'a',generation:1,tabIds:[work.tabId]});
 assert.ok(f.tabs.has(1));assert.ok(f.tabs.has(9));assert.ok(!f.tabs.has(work.tabId));
});

for(const damage of ['missing','scope','malformed'])test(`recovered ${damage} baseline cannot authorize cleanup or retry`,async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await approve(e);const work=await open(e);
 const record=f.data[journalKey].tasks[0][1];
 if(damage==='missing')delete record.baseline;
 if(damage==='scope')record.baseline.scope=JSON.stringify(['other-browser','fixture-owner-a','a',1]);
 if(damage==='malformed')record.baseline.tabIds=[null];
 const recovered=new Executor(f.api);recovered.workspaces=new NativeWorkspaces(f.api,'fixture-browser-instance');
 const result=await recovered.release({taskId:'a',generation:1});
 assert.equal(result.cleanupState,'unknown');assert.equal(result.cleanupReason,'baseline_unavailable');
 await assert.rejects(recovered.cleanupRetry({taskId:'a',generation:1,tabIds:[work.tabId]}),/uncertain/);
 assert.ok(f.tabs.has(work.tabId));assert.deepEqual(f.removed,[]);
});

test('reconnect generation captures its own inventory without changing old generation baseline',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);await approve(e);const work=await open(e);await e.disconnect();
 const old=structuredClone(f.data[journalKey].tasks[0][1].baseline);
 await e.approve({...trustedTask(),generation:2});
 const records=f.data[journalKey].tasks;
 assert.deepEqual(records[0][1].baseline,old);
 assert.equal(JSON.parse(records[1][1].baseline.scope)[3],2);
 assert.ok(records[1][1].baseline.tabIds.includes(work.tabId));
 await e.release({taskId:'a',generation:2});assert.ok(f.tabs.has(work.tabId));
});

test('approval persists original all-window inventory before any task execution',async()=>{
 const f=workspaceFixture(),e=new Executor(f.api);
 f.tabs.set(99,{id:99,url:'chrome://settings/',windowId:99,groupId:-1});
 await approve(e);
 const journal=f.data[journalKey];
 assert.ok(journal?.tasks.length,'startup inventory must exist before new_tab');
 const [key,record]=journal.tasks[0];
 assert.deepEqual(record.baseline,{scope:key,tabIds:[1,9,99]});
 assert.deepEqual(f.creates,[]);assert.deepEqual(f.groups,[]);
 assert.deepEqual([...e.tasks.get('a').tabIds],[1],'inventory grants no leases');
 const work=await open(e);await e.release({taskId:'a',generation:1});
 assert.deepEqual(f.removed,[work.tabId]);assert.ok(f.tabs.has(1));assert.ok(f.tabs.has(9));
});
