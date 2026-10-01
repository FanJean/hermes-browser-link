// 中文注释：真实工作区管理器和 Native Executor 共用模拟 Chrome API，覆盖创建证明、改标题、移交与用户组边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthority,createWorkspaces} from '../../browser-workspaces/index.mjs';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {Executor} from '../../native-extension/core.mjs';

async function fixture(){
 let next=2,nextGroup=10,saved;
 const tabs=new Map([[1,{id:1,windowId:1,groupId:90}]]),groups=new Map([[90,{id:90,windowId:1,title:'用户自己的组'}]]),calls=[],startup=[];
 const api={runtime:{onStartup:{addListener:fn=>startup.push(fn)}},storage:{local:{
  get:async key=>({[key]:structuredClone(saved)}),set:async value=>{saved=structuredClone(Object.values(value)[0]);},
 }},tabs:{
  query:async()=>[...tabs.values()].map(row=>({...row})),
  create:async props=>{const tab={...props,id:next++,groupId:-1};tabs.set(tab.id,tab);return {...tab};},
  get:async id=>{if(!tabs.has(id))throw Error(`No tab with id: ${id}.`);return {...tabs.get(id)};},
  group:async props=>{const id=props.groupId??nextGroup++;if(!groups.has(id))groups.set(id,{id,windowId:1,title:''});for(const tabId of props.tabIds)tabs.get(tabId).groupId=id;return id;},
  remove:async id=>{calls.push(['remove',id]);tabs.delete(id);},
  ungroup:async id=>{calls.push(['ungroup',id]);tabs.get(id).groupId=-1;},
 },tabGroups:{get:async id=>{if(![...tabs.values()].some(row=>row.groupId===id))throw Error('No group');return {...groups.get(id)};},
  update:async(id,props)=>groups.set(id,{...groups.get(id),...props}),
 }};
 const authority=createAuthority('fixture'),manager=createWorkspaces({chrome:api,authority});
 const cap=authority.issue({owner:'owner',task:'task',generation:1,windowId:1});
 await manager.start(cap);
 const work=await manager.open(cap,{requestId:'new',url:'https://fixture.test/',title:'任务'});
 const executor=new Executor(api);executor.workspaces=new NativeWorkspaces(api,'fixture');await executor.workspaces.ready;
 const closeGroup=records=>executor.cleanupRetry({taskId:'task',generation:1,state:'closed',ungroupOnly:true,title:'任务',workTabs:records});
 return {api,tabs,groups,calls,manager,cap,work,executor,closeGroup,record:{...work,windowId:1},startup};
}

test('标题改成状态前缀后，自动关闭仍删除 Agent 页而保留用户组',async()=>{
 const f=await fixture();await f.api.tabGroups.update(f.work.groupId,{title:'[已完成] 用户修改标题'});
 await f.manager.cleanup(f.cap);
 assert.ok(!f.tabs.has(f.work.tabId));assert.equal(f.tabs.get(1).groupId,90);
 assert.equal(f.groups.get(90).title,'用户自己的组');
});

test('keep_tabs 移交和扩展重载后的收组保留页面，改标题不阻止收组',async()=>{
 const f=await fixture();await f.api.tabGroups.update(f.work.groupId,{title:'[停止] 任务'});
 await f.executor.release({taskId:'task',generation:1,closeAgentTabs:false});
 const result=await f.closeGroup([f.record]);
 assert.equal(result.cleanupState,'succeeded');assert.equal(f.tabs.get(f.work.tabId).groupId,-1);
 assert.ok(f.tabs.has(f.work.tabId));assert.equal(f.tabs.get(1).groupId,90);
 assert.equal(f.calls.filter(([name])=>name==='remove').length,0);
});

test('用户把任务页移进自建组后，不删页也不收用户组',async()=>{
 const f=await fixture();await f.api.tabs.group({tabIds:[f.work.tabId],groupId:90});
 await f.executor.release({taskId:'task',generation:1,closeAgentTabs:true});
 await f.closeGroup([f.record]);
 assert.equal(f.tabs.get(f.work.tabId).groupId,90);assert.equal(f.tabs.get(1).groupId,90);
 assert.equal(f.calls.length,0);
});

test('用户自己的页放进任务组，不被任务清单或伪造组标题认领',async()=>{
 const f=await fixture();await f.api.tabs.group({tabIds:[1],groupId:f.work.groupId});
 await f.api.tabGroups.update(f.work.groupId,{title:'任务'});
 await f.executor.release({taskId:'task',generation:1,closeAgentTabs:false});
 await f.closeGroup([f.record,{tabId:1,groupId:f.work.groupId,windowId:1}]);
 assert.equal(f.tabs.get(f.work.tabId).groupId,-1);assert.equal(f.tabs.get(1).groupId,f.work.groupId);
 assert.deepEqual(f.calls,[['ungroup',f.work.tabId]]);
});

test('无扩展创建日志时，daemon 的 tab/group/window 和相同标题不构成收组证明',async()=>{
 const f=await fixture();f.executor.workspaces=null;
 const result=await f.closeGroup([f.record,{tabId:1,groupId:90,windowId:1}]);
 assert.equal(result.cleanupReason,'no_journal');assert.equal(f.calls.length,0);
});

test('浏览器启动撤销旧创建证明，复用相同 tab 和 group ID 也不能收组',async()=>{
 const f=await fixture();for(const listener of f.startup)listener();
 const result=await f.closeGroup([f.record]);
 assert.equal(result.cleanupState,'unknown');assert.equal(result.cleanupReason,'browser_restarted');
 assert.equal(f.calls.length,0);
});

test('已删除的记录不再被汇总成 ownership_unknown，错误窗口不扩大权限',async()=>{
 const f=await fixture();f.tabs.delete(f.work.tabId);
 const result=await f.closeGroup([f.record]);assert.equal(result.cleanupState,'succeeded');
 const second=await fixture();await second.closeGroup([{...second.record,windowId:2}]);
 assert.equal(second.calls.length,0);
});

test('另一个任务的租约和未确认的在途清理始终限制收组',async()=>{
 const f=await fixture();f.executor.leases.set(f.work.tabId,'other-task');
 const result=await f.closeGroup([f.record]);assert.equal(result.cleanupState,'unknown');assert.equal(f.calls.length,0);
 f.executor.leases.clear();
 f.executor.tasks.set('task',{id:'task',generation:1,revoked:true,cleanupUncertainty:{taskId:'task',generation:1}});
 const uncertain=await f.closeGroup([f.record]);assert.equal(uncertain.cleanupState,'unknown');assert.equal(uncertain.cleanupReason,'cleanup_uncertain');
});
