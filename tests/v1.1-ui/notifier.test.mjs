import test from 'node:test';
import assert from 'node:assert/strict';
import {createApprovalNotifier, isApprovalPanelSender} from '../../native-extension/approval-notifier.mjs';

function fixture({focusFails=false, createFails=false, wrongTabWindow=false, popupUnfocused=false}={}) {
 const calls=[], removed=[];let windowId=90;
 const chrome={runtime:{id:'ext-123',getURL:path=>`chrome-extension://ext-123/${path}`},
  tabs:{get:async id=>({id,windowId:wrongTabWindow?13:12,url:'https://example.test/path'})},
  windows:{get:async id=>{calls.push(['get',id]);return {id,left:100,top:50,width:1000,height:800,type:'normal'};},update:async(id,p)=>{calls.push(['focus',id,p]);if(focusFails)throw Error('focus denied');return {id,focused:true};},create:async p=>{calls.push(['create',p]);if(createFails)throw Error('create denied');return {id:++windowId,tabs:[{id:400+windowId}],...p,focused:!popupUnfocused};},remove:async id=>{removed.push(id);}},
  action:{setBadgeText:async p=>calls.push(['badge',p.text]),setTitle:async p=>calls.push(['title',p.title])}};
 const notifier=createApprovalNotifier({chrome,instanceId:'instance-A'});
 const expiresAt=Date.now()+60000;
 const req=(id='r1',overrides={})=>({id,instanceId:'instance-A',taskId:'task-1',generation:2,tabId:7,windowId:12,origin:'https://example.test',action:'click',scope:'本次操作',expiresAt,digest:'sha-opaque',taskTitle:'资料整理',...overrides});
 return {chrome,calls,removed,notifier,req};
}

test('one validated request focuses target once and centers extension-owned panel',async()=>{
 const {calls,notifier,req}=fixture();await notifier.sync([req()]);await notifier.sync([req()]);
 assert.equal(calls.filter(c=>c[0]==='focus').length,1);
 const p=calls.find(c=>c[0]==='create')[1];
 assert.equal(p.url,'chrome-extension://ext-123/approval-panel.html');
 assert.equal(p.type,'popup');assert.equal(p.left,100+(1000-p.width)/2);assert.equal(p.top,50+(800-p.height)/2);
 assert.equal(notifier.view().id,'r1');
});

test('deduplicates and queues, while later closes the panel without granting',async()=>{
 const {notifier,calls,req}=fixture();
 await notifier.sync([req(),req('r2')]);assert.equal(calls.filter(c=>c[0]==='create').length,1);
 const sender={id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:notifier.panel().tabId,windowId:notifier.panel().windowId}};
 assert.equal(notifier.isSender(sender),true);
 await notifier.decide({sender,requestId:'r1',decision:'later'});
 assert.equal(notifier.view().id,'r2');assert.equal(notifier.pending().length,2);
 await notifier.sync([req(),req('r2')]);assert.equal(notifier.view().id,'r2');
 assert.equal(calls.filter(c=>c[0]==='focus').length,2);
});

test('rejects invalid scope, conflicting IDs, and stale or forged decisions',async()=>{
 const {notifier,req}=fixture();
 await assert.rejects(notifier.sync([req('x',{origin:'https://evil.test/path'})]),/scope/);
 await assert.rejects(notifier.sync([req(),req('r1',{tabId:8})]),/conflict/);
 await notifier.sync([req()]);const panel=notifier.panel();
 const sender={id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:panel.tabId,windowId:panel.windowId}};
 assert.equal(isApprovalPanelSender({...sender,url:'https://example.test/'},'ext-123',panel.windowId,panel.tabId),false);
 await assert.rejects(notifier.decide({sender:{...sender,tab:{...sender.tab,id:999}},requestId:'r1',decision:'approve'}),/sender/);
 await assert.rejects(notifier.decide({sender,requestId:'r1',decision:'approve',verify:async()=>false,dispatch:async()=>{throw Error('must not dispatch');}}),/stale/);
 await notifier.sync([]);assert.equal(notifier.view(),null);assert.equal(notifier.panel(),null);
 await assert.rejects(notifier.decide({sender,requestId:'r1',decision:'approve'}),/sender|stale/);
});

test('a decision dispatches once after live scope readback and advances the queue',async()=>{
 const {notifier,req}=fixture();await notifier.sync([req(),req('r2')]);const panel=notifier.panel();
 const sender={id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:panel.tabId,windowId:panel.windowId}};
 const sent=[];const verify=async r=>r.id==='r1';const dispatch=async (r,decision)=>{sent.push([r.id,decision]);return {accepted:true};};
 await notifier.decide({sender,requestId:'r1',decision:'reject',verify,dispatch});
 assert.deepEqual(sent,[['r1','reject']]);assert.equal(notifier.view().id,'r2');
 await assert.rejects(notifier.decide({sender,requestId:'r1',decision:'approve',verify,dispatch}),/sender|stale/);
});

test('focus or popup failure falls back to badge without claiming a foreground panel',async()=>{
 for(const options of [{focusFails:true},{createFails:true}]){
  const {notifier,req,calls}=fixture(options);await notifier.sync([req()]);
  assert.equal(notifier.panel(),null);assert.equal(notifier.view(),null);
  assert.equal(notifier.pending().length,1);assert(calls.some(c=>c[0]==='badge'&&c[1]==='1'));
  await notifier.sync([req()]);assert.equal(calls.filter(c=>c[0]==='focus').length,1);
 }
});

test('expired requests disappear on reconciliation; mode full cannot request repeat approval',async()=>{
 const {notifier,req}=fixture();await notifier.sync([req()]);
 await notifier.sync([req('r1',{expiresAt:Date.now()-1})]);
 assert.equal(notifier.panel(),null);assert.equal(notifier.pending().length,0);
 await assert.rejects(notifier.sync([req('full',{mode:'full'})]),/scope/);
});

test('closed panel does not replay focus; explicit reopen can show deferred request',async()=>{
 const {notifier,req,calls}=fixture();await notifier.sync([req()]);
 await notifier.panelClosed(notifier.panel().windowId);await notifier.sync([req()]);
 assert.equal(notifier.panel(),null);assert.equal(calls.filter(x=>x[0]==='focus').length,1);
 await notifier.openPending('r1');assert.equal(notifier.view().id,'r1');
});

test('tab origin or window drift prevents focus and retains a pending fallback',async()=>{
 const {notifier,req,calls}=fixture({wrongTabWindow:true});await notifier.sync([req()]);
 assert.equal(calls.filter(c=>c[0]==='focus').length,0);
 assert.equal(notifier.panel(),null);assert.equal(notifier.pending().length,1);
});

test('panel read is sender-bound and omits host-only digest and browser identity',async()=>{
 const {notifier,req}=fixture();await notifier.sync([req()]);const p=notifier.panel();
 const sender={id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:p.tabId,windowId:p.windowId}};
 assert.equal(notifier.viewFor({...sender,url:'https://example.test/'}),null);
 assert.deepEqual(notifier.viewFor(sender),{id:'r1',taskTitle:'资料整理',origin:'https://example.test',action:'click',scope:'本次操作',expiresAt:req().expiresAt});
});

test('uncertain dispatch cannot automatically replay, even after a stale host refresh',async()=>{
 const {notifier,req}=fixture();await notifier.sync([req()]);const p=notifier.panel();
 const sender={id:'ext-123',url:'chrome-extension://ext-123/approval-panel.html',tab:{id:p.tabId,windowId:p.windowId}};
 let dispatched=0;await assert.rejects(notifier.decide({sender,requestId:'r1',decision:'approve',verify:async()=>true,dispatch:async()=>{dispatched++;throw Error('response lost');}}),/response lost/);
 await notifier.sync([req()]);assert.equal(notifier.view(),null);assert.equal(dispatched,1);
 assert.equal(notifier.pending().length,1);assert.equal(notifier.pending()[0].unknown,true);
 assert.equal(notifier.status().kind,'unknown');
 await assert.rejects(notifier.openPending('r1'),/unknown/);
 await notifier.sync([]);assert.equal(notifier.pending().length,0);
});

test('popup that is created but not focused is closed and badge stays pending',async()=>{
 const {notifier,req,removed}=fixture({popupUnfocused:true});await notifier.sync([req()]);
 assert.equal(notifier.panel(),null);assert.equal(notifier.pending().length,1);assert.deepEqual(removed,[91]);
});
test('mode generation drift invalidates the visible decision panel',async()=>{
 const {notifier,req,removed}=fixture();await notifier.sync([req('r1',{modeGeneration:1})]);
 await notifier.sync([req('r1',{modeGeneration:2})]);
 assert.deepEqual(removed,[91]);assert.equal(notifier.pending()[0].modeGeneration,2);
});
