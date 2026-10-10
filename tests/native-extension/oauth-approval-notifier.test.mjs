// 中文注释：沿用真实 background 审批投影和通知器，合成窗口 API，不连接浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createApprovalNotifier} from '../../native-extension/approval-notifier.mjs';

const background=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
async function fixture({windowType='popup',leased=true}={}){
 const calls=[],tab={id:2,windowId:8,url:'http://login.localhost:9000/oauth-provider'};
 let nextWindow=90;
 const chrome={runtime:{id:'ext',getURL:p=>`chrome-extension://ext/${p}`},
  tabs:{get:async()=>({...tab}),update:async()=>({...tab})},
  windows:{get:async id=>({id,type:windowType,left:0,top:0,width:430,height:560}),
   update:async(id,p)=>{calls.push(['focus',id]);return {id,...p};},
   create:async p=>{calls.push(['create',p]);return {id:++nextWindow,tabs:[{id:nextWindow+100}],focused:true};},
   remove:async id=>calls.push(['remove',id])},
  action:{setBadgeText:async()=>{},setTitle:async()=>{}}};
 const task={id:'task',instanceId:'instance',state:'ready',generation:1,activeMode:'smart',modeGeneration:3,allowedOrigins:['http://login.localhost:9000'],title:'OAuth D'};
 const local={...task,policy:{activeMode:'smart',modeGeneration:3}};
 const executor={tasks:new Map([['task',local]]),leases:new Map(leased?[[2,'task']]:[])};
 const context={chrome,executor,origin:url=>new URL(url).origin};
 vm.runInNewContext(background.slice(background.indexOf('const approvalActions='),background.indexOf('async function collectApprovals('))+'\nglobalThis.project=pendingAction;',context);
 const approval={taskId:'task',generation:1,modeGeneration:3,nonce:'nonce',digest:'digest',expiresAt:Date.now()/1000+60,
  request:{taskId:'task',tabId:2,requestId:'complete',action:'ref_click'}};
 const project=()=>context.project(approval,task,'instance');
 const notifier=createApprovalNotifier({chrome,instanceId:'instance'});
 const sender=()=>({id:'ext',url:chrome.runtime.getURL('approval-panel.html'),tab:{id:notifier.panel().tabId,windowId:notifier.panel().windowId}});
 return {calls,tab,chrome,task,local,executor,approval,project,notifier,sender};
}

test('smart adopted popup write projects a request and opens a sender-bound panel without approving it',async()=>{
 const f=await fixture(),request=await f.project();assert.ok(request);
 await f.notifier.sync([request]);
 assert.equal(f.notifier.status().panelOpen,true);
 assert.equal(f.notifier.pending().length,1);assert.equal(f.notifier.view().id,request.id);
 assert.equal(f.calls.find(row=>row[0]==='create')[1].url,'chrome-extension://ext/approval-panel.html');
 assert.equal(f.notifier.viewFor(f.sender()).scope,'本次操作');
 assert.equal(f.calls.filter(row=>row[0]==='focus').length,1);
});

test('first site read in a leased popup also opens the normal readOrigin approval panel',async()=>{
 const f=await fixture();f.approval.request.action='semantic_snapshot';f.approval.readOrigin=f.task.allowedOrigins[0];
 const request=await f.project();assert.ok(request);assert.equal(request.scope,'本任务此网站读取');
 await f.notifier.sync([request]);assert.equal(f.notifier.status().panelOpen,true);
 assert.equal(f.notifier.viewFor(f.sender()).readOrigin,f.approval.readOrigin);
});

test('previous normal-window decision is cleaned before the next popup task approval',async()=>{
 const f=await fixture(),popup=await f.project(),normal={...popup,id:'previous',taskId:'C',tabId:1,windowId:7};
 const getTab=f.chrome.tabs.get,getWindow=f.chrome.windows.get;
 f.chrome.tabs.get=async id=>id===1?{id:1,windowId:7,url:f.tab.url}:getTab(id);
 f.chrome.windows.get=async id=>id===7?{id,type:'normal',left:0,top:0,width:1000,height:800}:getWindow(id);
 await f.notifier.sync([normal]);const previous=f.sender();let decisions=0;
 await f.notifier.decide({sender:previous,requestId:normal.id,decision:'approve',verify:async()=>true,dispatch:async()=>{decisions++;}});
 await f.notifier.sync([popup]);assert.equal(f.notifier.status().panelOpen,true);
 assert.equal(f.notifier.view().id,popup.id);assert.equal(decisions,1);
 assert.notEqual(f.notifier.panel().windowId,previous.tab.windowId);
 assert.equal(f.notifier.isSender(previous),false);
});

for(const type of ['app','devtools','panel'])test(`unsupported ${type} window never opens an approval panel`,async()=>{
 const f=await fixture({windowType:type});await f.notifier.sync([await f.project()]);
 assert.equal(f.notifier.panel(),null);assert.equal(f.notifier.pending().length,1);
 assert.equal(f.calls.length,0);
});

for(const change of ['foreign lease','paused','revoked','mode generation','tab window','origin'])test(`popup approval rejects ${change} before creating a panel`,async()=>{
 const f=await fixture();
 if(change==='foreign lease')f.executor.leases.set(2,'peer');
 if(change==='paused')f.task.state='paused';
 if(change==='revoked')f.local.revoked=true;
 if(change==='mode generation')f.local.policy.modeGeneration++;
 const request=await f.project();
 if(['tab window','origin'].includes(change)){
  assert.ok(request);
  if(change==='tab window')f.tab.windowId=9;else f.tab.url='http://manual.localhost:9000/';
  await f.notifier.sync([request]);assert.equal(f.notifier.panel(),null);
 }else assert.equal(request,null);
 assert.equal(f.calls.length,0);
});

test('popup decisions still reject forged senders and stale scope and never replay a missing acknowledgment',async()=>{
 const f=await fixture(),request=await f.project();await f.notifier.sync([request]);
 assert.ok(f.notifier.panel());const sender=f.sender();let decisions=0;
 const decide=extra=>f.notifier.decide({sender,requestId:request.id,decision:'approve',verify:async()=>true,dispatch:async()=>{decisions++;throw Error('receipt lost');},...extra});
 await assert.rejects(decide({sender:{...sender,url:f.tab.url}}),/untrusted/);
 await assert.rejects(decide({verify:async()=>false}),/stale/);assert.equal(decisions,0);
 await assert.rejects(decide({}),/receipt lost/);assert.equal(decisions,1);
 await f.notifier.sync([request]);assert.equal(f.notifier.panel(),null);
 await assert.rejects(f.notifier.openPending(request.id),/unknown/);assert.equal(decisions,1);
});

test('unbound new-tab requests cannot focus an unrelated popup window',async()=>{
 const f=await fixture(),request=await f.project();await f.notifier.sync([{...request,tabId:null}]);
 assert.equal(f.notifier.panel(),null);assert.equal(f.calls.length,0);
});

test('missing real-session approval target preserves its CDP target inventory without extending the deadline',async()=>{
 const source=await readFile(new URL('../native-v2/real-session.mjs',import.meta.url),'utf8');
 const targets=[{id:'source',type:'page',url:'http://127.0.0.1:9000/oauth-source',title:'OAuth'}];
 const session={},waits=[];
 const context={session,base:'http://synthetic-cdp',expectedExtensionId:'ext',fetchJson:async()=>targets,
  waitFor:async(probe,timeout,options)=>{waits.push({timeout,options});assert.equal(await probe(),undefined);throw Error('panel missing');}};
 vm.runInNewContext(source.slice(source.indexOf('  session.approvalPanelTargets ='),source.indexOf('  // 中文注释：重载只作用于本 fixture 扩展；')),context);
 await assert.rejects(session.approvePanel(),error=>{
  assert.equal(error.message,'panel missing');
  assert.equal(error.approvalPanelTargets.expectedUrl,'chrome-extension://ext/approval-panel.html');
  assert.deepEqual(JSON.parse(JSON.stringify(error.approvalPanelTargets.targets)),targets);return true;
 });
 assert.equal(waits.length,1);assert.equal(waits[0].timeout,20000);assert.equal(waits[0].options.label,'审批面板目标出现');
});

test('confirmedRun records the original approval_required receipt and both target lists without replaying a failed approval',async()=>{
 const source=await readFile(new URL('../complex-ui/real-login-windows.mjs',import.meta.url),'utf8');
 const receipt={status:'approval_required',requestId:'complete',digest:'opaque',expiresAt:123,message:'请确认本次操作'};
 const inventory={expectedUrl:'chrome-extension://ext/approval-panel.html',targets:[]};
 const failure=Object.assign(Error('panel missing'),{approvalPanelTargets:inventory});let calls=0;
 const diagnostics={},session={approvalPanelTargets:async()=>inventory,approvePanel:async()=>{throw failure;}};
 const context={diagnostics,session,verify:result=>result,structuredClone};
 vm.runInNewContext(source.slice(source.indexOf(' const confirmedRun='),source.indexOf(' const freshRef='))+'\nglobalThis.run=confirmedRun;',context);
 await assert.rejects(context.run({tabId:2,nextId:()=>receipt.requestId,run:async()=>{calls++;return receipt;}},'ref_click'),error=>error===failure);
 assert.equal(calls,1);assert.equal(diagnostics.approvals[0].action,'ref_click');assert.equal(diagnostics.approvals[0].tabId,2);
 assert.deepEqual(diagnostics.approvals[0].receipt,receipt);
 assert.deepEqual(diagnostics.approvals[0].panelTargetsBefore,inventory);
 assert.deepEqual(diagnostics.approvals[0].panelTargetsAtFailure,inventory);
});
