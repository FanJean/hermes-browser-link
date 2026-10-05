import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthority, createWorkspaces, groupTitle} from './index.mjs';
import {NativeWorkspaces} from '../native-extension/workspace-adapter.mjs';

function fixture(){
 let next=2, group=10; const tabs=new Map([[1,{id:1,windowId:1,groupId:-1,active:true}]]); const calls=[], groupInfo=new Map(),startupListeners=[]; let saved;
 const api={runtime:{onStartup:{addListener:f=>startupListeners.push(f)}},tabs:{async query(){return [...tabs.values()].map(t=>({...t}));},async create(p){calls.push(['create',p]);const t={id:next++,groupId:-1,...p};tabs.set(t.id,t);return {...t};},async ungroup(id){calls.push(['ungroup',id]);tabs.get(id).groupId=-1;},async get(id){if(!tabs.has(id))throw Error(`No tab with id: ${id}.`);return {...tabs.get(id)};},async group(p){calls.push(['group',p]);const g=p.groupId??group++;for(const id of [p.tabIds].flat())tabs.get(id).groupId=g;return g;},async remove(id){calls.push(['remove',id]);tabs.delete(id);}},tabGroups:{async update(id,p){calls.push(['update',id,p]);groupInfo.set(id,{id,windowId:1,...p});},async get(id){if(![...tabs.values()].some(t=>t.groupId===id))throw Error('No group');return {...groupInfo.get(id)};}},storage:{local:{async get(k){return {[k]:saved};},async set(v){saved=structuredClone(Object.values(v)[0]);}}}};
 const authority=createAuthority('instance'); const manager=createWorkspaces({chrome:api,authority});
 const grant=(task='a',generation=1)=>authority.issue({owner:'owner',task,generation,windowId:1});
 return {api,tabs,calls,authority,manager,grant,startup:()=>{for(const listener of startupListeners)listener();}};
}
test('exact cleanup allowlist survives late creation and caller mutation',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const tab=await create(p);started();await gate;return tab;};
 const pending=f.manager.open(cap,{requestId:'late',url:'https://example.test'});await ready;
 const ids=[a.tabId],cleanup=f.manager.cleanup(cap,{tabIds:ids});ids.push(3);release();
 await assert.rejects(pending,/CANCELLED/);await cleanup;await f.manager.reconcile();
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.reconcile();await restored.cleanup(cap);
 assert.ok(!f.tabs.has(a.tabId));assert.ok(f.tabs.has(3),'late tab must survive every cleanup path');
});

test('retry revalidates moved tabs after inventory lookup and preserves late additions',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const native=new NativeWorkspaces(f.api,'instance'),e=new (await import('../native-extension/core.mjs')).Executor(f.api);e.workspaces=native;await native.ready;
 const status=e.cleanupStatus.bind(e);let late;
 e.cleanupStatus=async p=>{const snapshot=await status(p);late=await f.manager.open(cap,{requestId:'late',url:'https://example.test'});f.tabs.get(a.tabId).groupId=999;return snapshot;};
 // Use the live manager so the ownership addition lands after status but before deletion.
 native.manager=f.manager;e.tasks.set('a',{id:'a',generation:1,revoked:true,workspaceCapability:cap});
 const result=await e.cleanupRetry({taskId:'a',generation:1,tabIds:[a.tabId]});
 assert.ok(f.tabs.has(a.tabId));assert.ok(f.tabs.has(late.tabId));assert.ok(result.remainingTabIds.includes(late.tabId));
});

test('recovered legacy opener ownership is uncertain and cannot be deleted',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const key='hermes.backgroundWorkspaces.v1',stored=(await f.api.storage.local.get(key))[key];
 stored.tasks[0][1].requests[0][1].source='opener';await f.api.storage.local.set({[key]:stored});
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.cleanup(cap);
 assert.ok(f.tabs.has(a.tabId));assert.equal((await restored.status(cap)).cleanupState,'unknown');
});

test('queued cleanup retains its own immutable allowlist across another retry',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'}),b=await f.manager.open(cap,{requestId:'b',url:'https://example.test'});
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),get=f.api.tabs.get;
 f.api.tabs.get=async id=>{if(id===a.tabId){started();await gate;}return get(id);};
 const first=f.manager.cleanup(cap,{tabIds:[a.tabId]});await ready;
 const second=f.manager.cleanup(cap,{tabIds:[a.tabId,b.tabId]});
 // Observe the exact first invocation before the second can run.
 const remove=f.api.tabs.remove;f.api.tabs.remove=async id=>{if(id===b.tabId)assert.equal(firstDone,true,'earlier cleanup expanded its allowlist');return remove(id);};
 let firstDone=false;first.then(()=>firstDone=true);release();await first;await second;
});

test('retry preserves a tab leased by another task while ownership lookup is pending',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const e=new (await import('../native-extension/core.mjs')).Executor(f.api),native=new NativeWorkspaces(f.api,'instance');await native.ready;
 native.manager=f.manager;e.workspaces=native;e.tasks.set('a',{id:'a',generation:1,revoked:true,workspaceCapability:cap});
 const cleanup=native.cleanup.bind(native);native.cleanup=(cap,options)=>{e.leases.set(a.tabId,'other');return cleanup(cap,options);};
 await e.cleanupRetry({taskId:'a',generation:1,tabIds:[a.tabId]});assert.ok(f.tabs.has(a.tabId));
});

test('late-create cancellation cleanup also honors retry dispatch guard',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const tab=await create(p);started();await gate;return tab;};
 const pending=f.manager.open(cap,{requestId:'late',url:'https://example.test'});await ready;
 const cleanup=f.manager.cleanup(cap,{tabIds:[a.tabId],canDelete:()=>false});release();
 await assert.rejects(pending,/CANCELLED/);await cleanup;await f.manager.reconcile();assert.ok(f.tabs.has(a.tabId));
});

test('cleanup retry uses recovered scoped journal and refuses unknown create provenance',async()=>{
 const f=fixture(),cap=f.grant(),a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const native=new NativeWorkspaces(f.api,'instance');
 const e=new (await import('../native-extension/core.mjs')).Executor(f.api);e.workspaces=native;
 await e.release({taskId:'a',generation:1,closeAgentTabs:false});
 const status=await e.cleanupStatus({taskId:'a',generation:1});assert.ok(status.preservedTabIds.includes(a.tabId));
 // A retry must use the reconciled inventory, not implicitly delete retained tabs.
 await assert.rejects(e.cleanupRetry({taskId:'a',generation:1}),/inventory changed/);
 await e.cleanupRetry({taskId:'a',generation:1,tabIds:[]});assert.ok(f.tabs.has(a.tabId));assert.ok(f.tabs.has(1));
 await assert.rejects(e.cleanupRetry({taskId:'missing',generation:1}),/uncertain/);
});

test('ambiguous spawned tab is not grouped or announced owned',async()=>{
 const f=fixture(),cap=f.grant();
 f.api.tabs.group=async()=>{assert.fail('ambiguous tabs must not be grouped');};
 f.tabs.set(17,{id:17,openerTabId:1,url:'https://example.test/',windowId:1,groupId:-1});
 const result=await f.manager.spawned(cap,{...f.tabs.get(17)});
 assert.equal(result,null);await f.manager.cleanup(cap);assert.ok(f.tabs.has(17));
});

test('reusing a request ID for a different safe link never returns the first page',async()=>{
 const f=fixture(),cap=f.grant();await f.manager.open(cap,{requestId:'same',url:'https://example.test/one'});
 await assert.rejects(f.manager.open(cap,{requestId:'same',url:'https://example.test/two'}),/INVALID_REQUEST/);
 assert.equal(f.calls.filter(([method])=>method==='create').length,1);
});

test('creates one background owned group and rejects forged context',async()=>{
 const f=fixture(),cap=f.grant();
 await assert.rejects(()=>f.manager.open({...cap},{requestId:'x',url:'https://example.test'}),/UNTRUSTED/);
 const a=await f.manager.open(cap,{requestId:'x',url:'https://example.test'});
 const b=await f.manager.open(cap,{requestId:'x',url:'https://example.test'});
 assert.deepEqual(a,b);assert.equal(f.tabs.size,2);assert.equal(f.tabs.get(a.tabId).active,false);assert.equal(f.tabs.get(1).groupId,-1);
 assert.match(f.calls.find(x=>x[0]==='update')[2].title,/^AI 工作/);
});
test('cancellation during creation cleans late tab without touching peer or user',async()=>{
 const f=fixture(),a=f.grant('a'),b=f.grant('b');
 const peer=await f.manager.open(b,{requestId:'p',url:'https://example.test'});
 let release,started; const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const t=await create(p);started();await gate;return t;};
 const pending=f.manager.open(a,{requestId:'r',url:'https://example.test'});await ready;
 const cancelled=f.manager.cleanup(a);release();await assert.rejects(pending,/CANCELLED/);await cancelled;await f.manager.cleanup(a);
 assert.deepEqual([...f.tabs.keys()],[1,peer.tabId]);
 await assert.rejects(()=>f.manager.open(a,{requestId:'again',url:'https://example.test'}),/CANCELLED/);
});
test('worker recovery preserves moved tabs and never recreates released requests',async()=>{
 const f=fixture(),cap=f.grant(); const r=await f.manager.open(cap,{requestId:'x',url:'https://example.test'});
 f.tabs.get(r.tabId).groupId=99;
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});
 await restored.reconcile();
 await assert.rejects(()=>restored.open(cap,{requestId:'x',url:'https://example.test'}),/RELEASED/);
 await restored.cleanup(cap);assert.ok(f.tabs.has(r.tabId));assert.ok(f.tabs.has(1));
});
test('concurrent tasks have distinct groups, generations cannot be forged or reused',async()=>{
 const f=fixture(),a=f.grant('a'),b=f.grant('b');
 const [x,y]=await Promise.all([f.manager.open(a,{requestId:'x',url:'https://example.test'}),f.manager.open(b,{requestId:'x',url:'https://example.test'})]);
 assert.notEqual(x.groupId,y.groupId);f.grant('a',2);
 await assert.rejects(()=>f.manager.open(a,{requestId:'stale',url:'https://example.test'}),/STALE/);
 await f.manager.cleanup(a);assert.ok(f.tabs.has(y.tabId));
});
test('failed create is unknown and is not retried after worker recovery',async()=>{
 const f=fixture(),cap=f.grant();let calls=0;
 f.api.tabs.create=async()=>{calls++;throw Error('response lost');};
 await assert.rejects(()=>f.manager.open(cap,{requestId:'x',url:'https://example.test'}),/response lost/);
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});
 await assert.rejects(()=>restored.open(cap,{requestId:'x',url:'https://example.test'}),/UNKNOWN/);assert.equal(calls,1);
});
test('revocation during creation cleans returned ungrouped tab',async()=>{
 const f=fixture(),cap=f.grant();const create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const t=await create(p);f.grant('a',2);return t;};
 await assert.rejects(()=>f.manager.open(cap,{requestId:'x',url:'https://example.test'}),/STALE/);
 assert.deepEqual([...f.tabs.keys()],[1]);
});
test('adding tabs preserves user group title and ignores untrusted labels',async()=>{
 const f=fixture(),cap=f.grant();
 const x=await f.manager.open(cap,{requestId:'1',url:'https://example.test',title:'untrusted'});
 const y=await f.manager.open(cap,{requestId:'2',url:'https://example.test',title:'untrusted'});
 assert.equal(x.groupId,y.groupId);assert.equal(f.calls.filter(x=>x[0]==='update').length,1);
});
test('revocation while group API resolves returns no stale authority',async()=>{
 const f=fixture(),cap=f.grant();const group=f.api.tabs.group;
 f.api.tabs.group=async p=>{const id=await group(p);f.grant('a',2);return id;};
 await assert.rejects(()=>f.manager.open(cap,{requestId:'x',url:'https://example.test'}),/STALE/);
 assert.deepEqual([...f.tabs.keys()],[1]);
});
test('preserving release fences execution and survives worker reconciliation',async()=>{
 const f=fixture(),cap=f.grant();const r=await f.manager.open(cap,{requestId:'x',url:'https://example.test'});
 await f.manager.cleanup(cap,{closeTabs:false});
 assert.ok(f.tabs.has(r.tabId));
 await assert.rejects(()=>f.manager.open(cap,{requestId:'y',url:'https://example.test'}),/CANCELLED/);
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.reconcile();
 assert.ok(f.tabs.has(r.tabId));
 // A later explicit completion may clean recoverable tabs.
 await restored.cleanup(cap);assert.ok(!f.tabs.has(r.tabId));assert.ok(f.tabs.has(1));
});
test('preserving release during create keeps the late tab recoverable',async()=>{
 const f=fixture(),cap=f.grant();let release,started;const gate=new Promise(r=>release=r),start=new Promise(r=>started=r),create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const t=await create(p);started();await gate;return t;};
 const pending=f.manager.open(cap,{requestId:'late',url:'https://example.test'});await start;
 const cleanup=f.manager.cleanup(cap,{closeTabs:false});release();await assert.rejects(pending,/CANCELLED/);await cleanup;
 assert.equal(f.tabs.size,2);await f.manager.cleanup(cap);assert.deepEqual([...f.tabs.keys()],[1]);
});
test('explicitly kept task tabs survive cleanup and recovery',async()=>{
 const f=fixture(),cap=f.grant();const a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'}),b=await f.manager.open(cap,{requestId:'b',url:'https://example.test'});
 await f.manager.cleanup(cap,{keepTabIds:[a.tabId,1]});assert.ok(f.tabs.has(a.tabId));assert.ok(!f.tabs.has(b.tabId));assert.ok(f.tabs.has(1));
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.reconcile();await restored.cleanup(cap);assert.ok(f.tabs.has(a.tabId));
});
test('cleanup is bounded and never starts delayed deletion after timeout',async()=>{
 const f=fixture(),cap=f.grant();const a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const get=f.api.tabs.get;let resume;const gate=new Promise(r=>resume=r);f.api.tabs.get=async id=>{await gate;return get(id);};
 const result=await Promise.race([f.manager.cleanup(cap,{timeoutMs:10}).then(()=> 'success',e=>e.message),new Promise(r=>setTimeout(()=>r('UNBOUNDED'),100))]);
 resume();assert.equal(result,'WORKSPACE_CLEANUP_TIMEOUT');await f.manager.reconcile();assert.ok(f.tabs.has(a.tabId));
});
test('failed deletion preserves remaining recoverable state without automatic retry',async()=>{
 const f=fixture(),cap=f.grant();const a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});let calls=0;
 f.api.tabs.remove=async()=>{calls++;throw Error('remove failed');};
 await assert.rejects(f.manager.cleanup(cap),/remove failed/);
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.reconcile();assert.equal(calls,1);assert.ok(f.tabs.has(a.tabId));
});
test('native adapter forwards preservation for live and recovered cleanup',async()=>{
 const f=fixture(),native=new NativeWorkspaces(f.api,'instance');const cap=await native.install({workWindowMode:'current',instanceId:'instance',approvalScope:'owner',id:'a',generation:1},[{windowId:1}]);
 const a=await native.open(cap,{requestId:'a',url:'https://example.test'});await native.cleanup(cap,{closeTabs:false});assert.ok(f.tabs.has(a.tabId));
 const restored=new NativeWorkspaces(f.api,'instance');await restored.cleanupRecovered('a',1,{closeTabs:false});assert.ok(f.tabs.has(a.tabId));
 assert.equal((await restored.status())[0].state,'preserved');await restored.cleanupRecovered('a',1);assert.ok(!f.tabs.has(a.tabId));
});
test('keep intent survives a preserving release followed by recovery',async()=>{
 const f=fixture(),cap=f.grant();const a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 await f.manager.cleanup(cap,{closeTabs:false,keepTabIds:[a.tabId]});
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await restored.cleanup(cap);assert.ok(f.tabs.has(a.tabId));
});
test('timeout before journal restoration never overwrites recoverable entries',async()=>{
 const f=fixture(),cap=f.grant();await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 const get=f.api.storage.local.get;let resume;const gate=new Promise(r=>resume=r);f.api.storage.local.get=async key=>{await gate;return get(key);};
 const restored=createWorkspaces({chrome:f.api,authority:f.authority});await assert.rejects(restored.cleanup(cap,{timeoutMs:10}),/WORKSPACE_CLEANUP_TIMEOUT/);
 assert.equal((await get('hermes.backgroundWorkspaces.v1'))['hermes.backgroundWorkspaces.v1'].tasks.length,1);
 resume();await restored.reconcile();assert.equal(f.tabs.size,2);
});
test('keep requested while ownership lookup is pending prevents deletion',async()=>{
 const f=fixture(),cap=f.grant();const a=await f.manager.open(cap,{requestId:'a',url:'https://example.test'});
 let resume,started;const gate=new Promise(r=>resume=r),start=new Promise(r=>started=r),get=f.api.tabs.get;
 f.api.tabs.get=async id=>{started();await gate;return get(id);};
 const first=f.manager.cleanup(cap);await start;const second=f.manager.cleanup(cap,{keepTabIds:[a.tabId]});resume();await Promise.all([first,second]);assert.ok(f.tabs.has(a.tabId));
});
test('startup inventory protects original tab even when recovered ownership says regrouped and ready',async()=>{
 const f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'new',url:'https://example.test'});
 const key='hermes.backgroundWorkspaces.v1',journal=(await f.api.storage.local.get(key))[key];
 f.tabs.get(1).groupId=work.groupId;
 journal.tasks[0][1].requests.push(['bad-old-ownership',{status:'ready',tabId:1,groupId:work.groupId}]);
 await f.api.storage.local.set({[key]:journal});
 const recovered=createWorkspaces({chrome:f.api,authority:f.authority});
 await recovered.cleanup(cap);
 assert.ok(f.tabs.has(1),'startup tab must survive conflicting ownership');
 assert.ok(!f.tabs.has(work.tabId),'positive explicit creation remains cleanable');
 assert.ok((await recovered.status(cap)).preservedTabIds.includes(1));
});

test('missing startup inventory fails closed even during stale create and retry',async()=>{
 const f=fixture(),cap=f.grant();
 f.api.tabs.query=async()=>{throw Error('inventory unavailable');};
 const create=f.api.tabs.create;
 f.api.tabs.create=async p=>{const tab=await create(p);f.grant('a',2);return tab;};
 await assert.rejects(f.manager.open(cap,{requestId:'stale',url:'https://example.test'}),/STALE/);
 assert.ok(f.tabs.has(2),'stale-create cleanup must not bypass unavailable baseline');
 const result=await f.manager.cleanup(cap);
 assert.equal(result.cleanupState,'unknown');assert.equal(result.cleanupReason,'baseline_unavailable');
 const recovered=createWorkspaces({chrome:f.api,authority:f.authority});await recovered.cleanup(cap,{tabIds:[2]});
 assert.ok(f.tabs.has(2));assert.deepEqual(f.calls.filter(x=>x[0]==='remove'),[]);
});

test('cancel while startup inventory is pending prevents any tab creation',async()=>{
 const f=fixture(),cap=f.grant();let entered,resume;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>resume=r),query=f.api.tabs.query;
 f.api.tabs.query=async()=>{entered();await gate;return query();};
 const opening=f.manager.open(cap,{requestId:'cancelled-before-start',url:'https://example.test'});
 const rejected=assert.rejects(opening,/CANCELLED/);await started;
 const cleanup=f.manager.cleanup(cap);resume();await rejected;await cleanup;
 assert.deepEqual(f.calls.filter(x=>x[0]==='create'),[]);
 assert.deepEqual([...f.tabs.keys()],[1]);
});

export {fixture};

test('group label is the sanitized short task title',async()=>{
 assert.equal(groupTitle('SEM 关键词导出'),'SEM 关键词导出');
 assert.equal(groupTitle('a\u202Eb\u0007c\n d'),'a b c d');
 assert.equal(groupTitle('一二三四五六七八九十一二三四五六七八'),'一二三四五六七八九十一二三四五…');
 assert.equal(groupTitle('  \u200B '),'AI 工作');
 assert.equal(groupTitle(undefined),'AI 工作');
 const f=fixture(),cap=f.grant();
 await f.manager.open(cap,{requestId:'x',url:'https://example.test',title:'Read sample'});
 assert.equal(f.calls.find(x=>x[0]==='update')[2].title,'Read sample');
});
test('a resumed generation keeps working in the existing group instead of creating a new one',async()=>{
 const f=fixture(),first=f.grant('a',1);
 const a=await f.manager.open(first,{requestId:'x',url:'https://example.test',title:'任务'});
 await f.manager.cleanup(first,{closeTabs:false});
 const second=f.grant('a',2);
 const b=await f.manager.open(second,{requestId:'y',url:'https://example.test',title:'任务'});
 assert.equal(b.groupId,a.groupId);
 assert.equal(f.calls.filter(x=>x[0]==='update').length,1,'the reused group is not renamed');
 // If the user closed that group, a new one is created.
 f.tabs.delete(a.tabId);f.tabs.delete(b.tabId);
 const third=f.grant('a',3);
 const c=await f.manager.open(third,{requestId:'z',url:'https://example.test'});
 assert.notEqual(c.groupId,a.groupId);
});

// 中文注释：另一任务的开页不能被慢 create 阻塞；日志写入仍一次一个。
test('different task creates overlap while local saves remain serialized',async()=>{
 const f=fixture(),a=f.grant('a'),b=f.grant('b');let release,entered,activeSaves=0;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const create=f.api.tabs.create,set=f.api.storage.local.set;
 f.api.tabs.create=async p=>{if(p.url.endsWith('/slow')){entered();await gate;}return create(p);};
 f.api.storage.local.set=async value=>{assert.equal(++activeSaves,1);await new Promise(resolve=>setImmediate(resolve));await set(value);activeSaves--;};
 const slow=f.manager.open(a,{requestId:'slow',url:'https://example.test/slow'});await started;
 const fast=await f.manager.open(b,{requestId:'fast',url:'https://example.test/fast'});
 assert.ok(f.tabs.has(fast.tabId));release();await slow;
 const stored=(await f.api.storage.local.get('hermes.backgroundWorkspaces.v1'))['hermes.backgroundWorkspaces.v1'];
 assert.equal(stored.tasks.length,2);assert.ok(stored.tasks.every(([,task])=>task.requests[0][1].status==='ready'));
});

// 中文注释：重载只丢失 session，local 归属及完整组身份仍可证明本任务创建。
test('extension reload retains local ownership and closes only its work tab',async()=>{
 const f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'reload',url:'https://example.test',title:'重载任务'});
 f.api.storage.session={get:async()=>({}),set:async()=>{}};
 const restored=new NativeWorkspaces(f.api,'instance');await restored.cleanupRecovered('a',1,{closeTabs:true});
 assert.ok(!f.tabs.has(work.tabId));assert.ok(f.tabs.has(1));
 assert.equal((await restored.manager.status([...restored.recovered.values()][0])).cleanupReason,'verified_complete');
});

// 中文注释：模拟浏览器启动事件撞上 ready 的旧读取，复用相同 ID 和标题也不得恢复删除权。
test('browser startup invalidates loaded and in-flight local journal before reused IDs can be deleted',async()=>{
 for(const duringRead of [false,true]){
  const f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'restart',url:'https://example.test',title:'重启任务'});
  let resume,readStarted;const gate=new Promise(r=>resume=r),entered=new Promise(r=>readStarted=r),get=f.api.storage.local.get;
  let first=true;
  if(duringRead)f.api.storage.local.get=async key=>{const value=structuredClone(await get(key));if(first){first=false;readStarted();await gate;}return value;};
  const restored=createWorkspaces({chrome:f.api,authority:f.authority});
  if(duringRead)await entered;else await restored.ready;
  f.startup();resume();await restored.cleanup(cap);
  assert.ok(f.tabs.has(work.tabId));assert.equal((await restored.status(cap)).cleanupReason,'browser_restarted');
  const again=createWorkspaces({chrome:f.api,authority:f.authority});await again.cleanup(cap);assert.ok(f.tabs.has(work.tabId));
 }
});

// 中文注释：标题改变仍使用私有创建日志收组；缺日志不能凭 daemon 清单认领用户页。
test('terminal ungroup uses private journal without deleting pages or touching mismatches',async()=>{
 const {Executor}=await import('../native-extension/core.mjs');
 for(const mismatch of [null,'title','groupId','windowId']){
  const f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'lost',url:'https://example.test',title:'结束任务'});
  const record={...work,windowId:1};
  if(mismatch==='title')await f.api.tabGroups.update(work.groupId,{title:'用户命名'});
  if(mismatch==='groupId')f.tabs.get(work.tabId).groupId=999;
  if(mismatch==='windowId')record.windowId=2;
  const e=new Executor(f.api);e.workspaces=new NativeWorkspaces(f.api,'instance');const result=await e.cleanupRetry({taskId:'a',generation:1,ungroupOnly:true,state:'closed',title:'结束任务',workTabs:[record]});
  assert.equal(f.tabs.size,2);assert.ok(f.tabs.has(1));assert.equal(f.calls.filter(([op])=>op==='remove').length,0);
  assert.equal(f.calls.filter(([op])=>op==='ungroup').length,mismatch&&mismatch!=='title'?0:1);
  assert.equal(result.cleanupState,mismatch==='windowId'?'pending':'succeeded');
 }
});

// 中文注释：恢复态保留组；明确终态且保留页面时，页面交还用户并移出任务组。
test('needs_sync retains prior group while terminal preserved pages are ungrouped',async()=>{
 const {Executor}=await import('../native-extension/core.mjs'),f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'kept',url:'https://example.test'});
 const e=new Executor(f.api);e.workspaces=new NativeWorkspaces(f.api,'instance');
 await e.release({taskId:'a',generation:1,closeAgentTabs:false});
 const params={taskId:'a',generation:1,ungroupOnly:true,workTabs:[{...work,windowId:1}]};
 await e.cleanupRetry({...params,state:'needs_sync'});assert.equal(f.tabs.get(work.tabId).groupId,work.groupId);
 await e.cleanupRetry({...params,state:'cancelled'});assert.equal(f.tabs.get(work.tabId).groupId,-1);assert.ok(f.tabs.has(1));
});

// 中文注释：释放期限内不越过页锁，超时返回后等待在途动作结束，再按原归属补清理一次。
test('release deadline queues one cleanup after in-flight tab lock settles',async()=>{
 for(const settledBeforeReturn of [false,true]){
 const {Executor}=await import('../native-extension/core.mjs'),f=fixture();f.tabs.get(1).url='https://example.test/';
 const e=new Executor(f.api,()=>{},{releaseDeadlineMs:30});
 await e.approve({workWindowMode:'current',id:'a',instanceId:'instance',approvalScope:'owner',generation:1,allowedOrigins:['https://example.test'],tabIds:[1]});
 const t=e.tasks.get('a'),work=await e.workspaces.open(t.workspaceCapability,{requestId:'busy',url:'https://example.test'});
 t.tabIds.add(work.tabId);t.agentTabs.add(work.tabId);e.leases.set(work.tabId,'a');
 let resume,entered;const gate=new Promise(r=>resume=r),started=new Promise(r=>entered=r);
 const running=e.lock(work.tabId,async()=>{entered();await gate;});await started;
 // 中文注释：同时覆盖超时返回前锁刚好释放的窄窗口，不能漏掉补清理。
 if(settledBeforeReturn){const releaseOwned=e.releaseOwned.bind(e);e.releaseOwned=async p=>{const result=await releaseOwned(p);resume();await running;return result;};}
 const result=await e.release({taskId:'a',generation:1});assert.equal(result.cleanupState,'unknown');assert.ok(f.tabs.has(work.tabId));
 assert.ok(t.deferredCleanup);resume();await running;await t.deferredCleanup;
 assert.ok(!f.tabs.has(work.tabId));assert.ok(f.tabs.has(1));assert.equal(f.calls.filter(([op])=>op==='remove').length,1);
 }
});

// 中文注释：校验真实验收 worker 的标题断言和延迟创建夹具，浏览器启动受限时也能发现脚本自身错误。
test('real-browser acceptance worker uses sanitized title and a complete creation adapter',async()=>{
 const f=fixture(),previous=globalThis.chrome;f.api.windows={getAll:async()=>[{id:1,type:'normal',focused:true}]};globalThis.chrome=f.api;
 try{await import('./acceptance-worker.mjs');const result=await globalThis.runWorkspacesAcceptance();assert.equal(result.passed,true);}
 finally{globalThis.chrome=previous;delete globalThis.runWorkspacesAcceptance;delete globalThis.prepareReloadAcceptance;delete globalThis.finishReloadAcceptance;}
});

// 中文注释：过期可延期重查；保护性否决不能在租约消失后重新取得删除权。
test('deferred deadline guard retries but protective guard denial remains kept',async()=>{
 for(const decision of [false,'defer']){
  const f=fixture(),cap=f.grant(),work=await f.manager.open(cap,{requestId:'guard',url:'https://example.test'});
  await f.manager.cleanup(cap,{canDelete:()=>decision});await f.manager.cleanup(cap,{canDelete:()=>true});
  assert.equal(f.tabs.has(work.tabId),decision===false);assert.ok(f.tabs.has(1));
 }
});

test('local journal drops completed and restart-invalidated terminal tasks but keeps live ones',async()=>{
 const f=fixture(),key='hermes.backgroundWorkspaces.v1';
 const done=f.grant('done'),live=f.grant('live');
 await f.manager.open(done,{requestId:'d',url:'https://example.test/d',title:'done'});
 await f.manager.open(live,{requestId:'l',url:'https://example.test/l',title:'live'});
 await f.manager.cleanup(done);
 let stored=(await f.api.storage.local.get(key))[key];
 const tasksOf=journal=>journal.tasks.map(([k])=>JSON.parse(k)[2]);
 assert.deepEqual(tasksOf(stored),['live'],'a fully released terminal task is not persisted');
 assert.equal(stored.cancelled.length,0);
 // 中文注释：内存围栏仍在，已结束任务不能再开页。
 await assert.rejects(f.manager.open(done,{requestId:'again',url:'https://example.test/x'}),/CANCELLED/);
 f.startup();await f.manager.cleanup(live);
 stored=(await f.api.storage.local.get(key))[key];
 assert.deepEqual(tasksOf(stored),[],'a terminal task invalidated by browser restart is not persisted');
});

test('人工移交保留标签组并撤销旧工作区操作权',async()=>{
 // 中文注释：模拟扩展收到 closeAgentTabs=false 后的工作区清理；旧能力句柄不能再开页。
 const f=fixture(),cap=f.grant();
 const work=await f.manager.open(cap,{requestId:'handoff',url:'https://example.test/form'});
 const group=f.tabs.get(work.tabId).groupId;
 const result=await f.manager.cleanup(cap,{closeTabs:false});
 assert.equal(result.cleanupState,'succeeded');
 assert.ok(f.tabs.has(work.tabId));
 assert.equal(f.tabs.get(work.tabId).groupId,group);
 assert.equal(f.calls.filter(([method])=>method==='remove').length,0);
 await assert.rejects(()=>f.manager.open(cap,{requestId:'stale',url:'https://example.test/form'}),/CANCELLED/);
});

test('可信空任务可确认回收，缺失创建日志仍报告未知',async()=>{
 // 中文注释：只改变有可信 start 记录的空任务状态，不操作任何个人标签页。
 const f=fixture(),cap=f.grant();
 assert.equal((await f.manager.status(cap)).cleanupState,'unknown');
 await f.manager.start(cap);
 const status=await f.manager.status(cap);assert.equal(status.cleanupState,'succeeded');assert.equal(status.cleanupReason,'verified_complete');
 const cleanup=await f.manager.cleanup(cap,{closeTabs:true});assert.equal(cleanup.cleanupState,'succeeded');
 assert.equal(f.calls.filter(c=>c[0]==='remove').length,0);
});
