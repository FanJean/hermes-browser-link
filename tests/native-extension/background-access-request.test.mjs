import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Synthetic windows API: records created/focused windows; no browser starts.
function fakeWindows({focused={id:1,left:100,top:50,width:1200,height:900},failCreate=false}={}){
 const created=[],updates=[],removed={listeners:[]};let next=500;
 return {created,updates,
  api:{
   getLastFocused:async()=>focused,
   create:async options=>{if(failCreate)return {};created.push(options);return {id:next++,tabs:[{id:next}],focused:true};},
   update:async(id,info)=>{if(!created.some((_,i)=>500+i===id))throw Error('no such window');updates.push([id,info]);return {id,focused:true};},
   onRemoved:{addListener(fn){removed.listeners.push(fn);}},
  },
  close:id=>{for(const fn of removed.listeners)fn(id);},
 };
}

async function loadAccessRequestHandler({windows=fakeWindows(),bridgeRequest=async()=>({closed:true})}={}){
 const events={},executor={tasks:new Map(),leases:new Map(),diagnostics:{recordSafely(){},size:0}},chrome={
  runtime:{id:'extension-id',getURL:path=>`chrome-extension://extension-id/${path}`,onMessage:{addListener(fn){events.message=fn;}}},
  windows:windows.api,alarms:{create(){},onAlarm:{addListener(){}}},
  tabs:{onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
  debugger:{onDetach:{addListener(){}}},
  storage:{local:{get:async()=>({}),set:async()=>{}},session:{get:async()=>({}),set:async()=>{}}},
 };
 let source=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'')
  .replace('const consent=new BrowserConsent(chrome.storage.local,executor);',"const consent={load:async()=>{},readStatus:async()=>'disabled'};")
  .replace(/connect\(\);\s*$/,"globalThis.openAccessManagementRequest=openAccessManagementRequest;bridge=injectedBridge;connected=true;connectedInstanceId='browser-a';connectedGeneration='generation-a';");
 const context={chrome,Executor:function(){return executor;},registerWorkspaceStartup:()=>{},NativeWorkspaces:class{},Bridge:class{},BrowserConsent:class{},origin(){},isUiSender:()=>false,createApprovalNotifier(){},injectedBridge:{request:bridgeRequest}};
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
