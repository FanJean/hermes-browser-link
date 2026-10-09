import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {showPanelNotification,clearPanelNotification} from '../../native-extension/approval-notifier.mjs';
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Synthetic windows API: records created/focused windows; no browser starts.
function fakeWindows({focused={id:1,left:100,top:50,width:1200,height:900},failCreate=false,popupUnfocused=false}={}){
 const created=[],updates=[],removed={listeners:[]};let next=500;
 return {created,updates,
  api:{
   getLastFocused:async()=>focused,
   create:async options=>{if(failCreate)return {};created.push(options);return {id:next++,tabs:[{id:next}],focused:!popupUnfocused};},
   update:async(id,info)=>{if(!created.some((_,i)=>500+i===id))throw Error('no such window');updates.push([id,info]);return {id,focused:!popupUnfocused};},
   onRemoved:{addListener(fn){removed.listeners.push(fn);}},
  },
  close:id=>{for(const fn of removed.listeners)fn(id);},
 };
}

async function loadAccessRequestHandler({windows=fakeWindows(),bridgeRequest=async()=>({closed:true})}={}){
 const events={},executor={tasks:new Map(),leases:new Map(),diagnostics:{recordSafely(){},size:0}},chrome={
  // 中文注释：离线记录通知创建与点击，不发系统通知。
  notifications:{create:async(id,options)=>events.notification={id,options},clear:async id=>{(events.cleared||=[]).push(id);return true;},onClicked:{addListener(fn){events.notificationClick=fn;}}},
  runtime:{id:'extension-id',getURL:path=>`chrome-extension://extension-id/${path}`,onMessage:{addListener(fn){events.message=fn;}}},
  windows:windows.api,alarms:{create(){},onAlarm:{addListener(){}}},
  tabs:{onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
  debugger:{onDetach:{addListener(){}}},
  storage:{local:{get:async()=>({}),set:async()=>{}},session:{get:async()=>({}),set:async()=>{}}},
 };
 let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'')
  .replace(/^const consent=new BrowserConsent.*;$/m,"const consent={load:async()=>{},readStatus:async()=>'disabled'};")
  .replace(/connect\(\);\s*$/,"globalThis.openAccessManagementRequest=openAccessManagementRequest;bridge=injectedBridge;connected=true;connectedInstanceId='browser-a';connectedGeneration='generation-a';");
 const context={CloudLink,showPanelNotification,clearPanelNotification,CookieMirror,chrome,Executor:function(){return executor;},reloadForInstalledBuild:async()=>false,BUILD_ID:'',registerWorkspaceStartup:()=>{},NativeWorkspaces:class{},Bridge:class{},BrowserConsent:class{},origin(){},isUiSender:()=>false,createApprovalNotifier(){},injectedBridge:{request:bridgeRequest}};
 vm.runInNewContext(source,context);
 return {handler:context.openAccessManagementRequest,events,chrome,windows};
}

const request={requestId:'request-1',instanceId:'browser-a',connectionGeneration:'generation-a'};

test('a Hermes access request opens the extension page as a centered, focused window',async()=>{
 const f=await loadAccessRequestHandler();
 const result=await f.handler(request);
 assert.deepEqual({...result},{...request,status:'opened'});
 assert.equal(f.windows.created.length,1);
 const options=f.windows.created[0];
 assert.equal(options.url,'chrome-extension://extension-id/popup.html');
 assert.equal(options.type,'popup');
 assert.equal(options.focused,true);
 assert.equal(options.left,100+Math.round((1200-options.width)/2));
});

test('a second request focuses the open window instead of stacking another',async()=>{
 const f=await loadAccessRequestHandler();
 await f.handler(request);
 await f.handler({...request,requestId:'request-2'});
 assert.equal(f.windows.created.length,1);
 assert.equal(JSON.stringify(f.windows.updates),JSON.stringify([[500,{focused:true}]]));
});

test('stale instance or connection generations never open a window',async()=>{
 const f=await loadAccessRequestHandler();
 await assert.rejects(f.handler({...request,instanceId:'other'}));
 await assert.rejects(f.handler({...request,connectionGeneration:'old-generation'}));
 assert.equal(f.windows.created.length,0);
});

test('a window that cannot be verified is reported as a failure, not as opened',async()=>{
 const f=await loadAccessRequestHandler({windows:fakeWindows({failCreate:true})});
 await assert.rejects(f.handler(request),/not opened/);
});

test('closing the management window reports only that the prompt ended, once',async()=>{
 const sent=[];const f=await loadAccessRequestHandler({bridgeRequest:async(method,params)=>{sent.push([method,{...params}]);return {closed:true};}});
 await f.handler(request);
 f.windows.close(999);
 assert.equal(sent.length,0,'an unrelated window closing is ignored');
 f.windows.close(500);
 assert.deepEqual(sent,[['extension.access_request_closed',{requestId:'request-1',connectionGeneration:'generation-a'}]]);
 f.windows.close(500);
 assert.equal(sent.length,1);
});

test('the latest request id is the one reported when the reused window closes',async()=>{
 const sent=[];const f=await loadAccessRequestHandler({bridgeRequest:async(method,params)=>{sent.push(params.requestId);return {closed:true};}});
 await f.handler(request);
 await f.handler({...request,requestId:'request-2'});
 f.windows.close(500);
 assert.deepEqual(sent,['request-2']);
});

// 中文注释：access_request 使用独立权限窗口，后台状态也必须留窗并提醒。
test('background access window remains open and notification click only focuses it',async()=>{
 const windows=fakeWindows({popupUnfocused:true});const sent=[];
 const f=await loadAccessRequestHandler({windows,bridgeRequest:async(method)=>{sent.push(method);}});
 assert.equal((await f.handler(request)).status,'opened');
 assert.equal(f.events.notification.id,'hermes-browser-access');
 assert.match(f.events.notification.options.message,/网站访问/);
 f.events.notificationClick('unrelated');assert.equal(windows.updates.length,0);
 windows.api.update=async(id,options)=>{windows.updates.push([id,options]);return {id,focused:true};};
 f.events.notificationClick('hermes-browser-access');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(windows.updates.length,1);assert.equal(windows.updates[0][0],500);
 assert.deepEqual(sent,[],'notification clicks must not grant consent');
 assert.ok(f.events.cleared.includes('hermes-browser-access'),'focused window clears its reminder');
 windows.close(500);f.events.notificationClick('hermes-browser-access');
 assert.equal(windows.updates.length,1,'closed windows must not be focused');
});
