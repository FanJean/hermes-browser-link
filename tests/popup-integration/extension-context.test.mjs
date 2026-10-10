import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForExtensionPage,activateTestExtensionTab} from '../native-v2/cdp-client.mjs';
const extensionId='fixture-extension',url=`chrome-extension://${extensionId}/popup.html`;
const ready={url,readyState:'complete',runtimeId:extensionId,hasRuntime:true,hasTabs:true,hasDebugger:true,popupMounted:true};
const dragging='Tabs cannot be edited right now (user may be dragging a tab).';
test('fixture activation retries the exact transient tab-edit error before any input or decision',async()=>{
 const calls=[];let attempts=0;
 const client={evaluate:async()=>{attempts++;if(attempts<3)throw Error('Error: '+dragging);},call:async method=>calls.push(method)};
 await activateTestExtensionTab(client,'panel',{call:async method=>calls.push(method)});
 assert.equal(attempts,3);assert.deepEqual(calls,['Target.activateTarget','Emulation.setFocusEmulationEnabled']);
});
test('persistent tab dragging fails after three bounded activation attempts',async()=>{
 let attempts=0;
 const client={evaluate:async()=>{attempts++;throw Error(dragging);},call:async()=>assert.fail('must not send input')};
 await assert.rejects(activateTestExtensionTab(client,'panel',{call:async()=>assert.fail('must not activate')}),error=>error.message===dragging);
 assert.equal(attempts,3);
});
for(const message of ['No tab with id: 2.','Execution context was destroyed.',dragging+' Other failure.'])test(`activation does not retry ${message}`,async()=>{
 let attempts=0;
 await assert.rejects(activateTestExtensionTab({evaluate:async()=>{attempts++;throw Error(message);}},'panel',{}),error=>error.message===message);
 assert.equal(attempts,1);
});
test('a target activation error after successful tabs.update is not retried',async()=>{
 let attempts=0;
 await assert.rejects(activateTestExtensionTab({evaluate:async()=>attempts++},'panel',{call:async()=>{throw Error(dragging);}}),error=>error.message===dragging);
 assert.equal(attempts,1);
});

test('fixture waits through about:blank and an extension page without chrome.runtime before evaluating privileged code',async()=>{
 const states=[{...ready,url:'about:blank',runtimeId:null,hasRuntime:false},{...ready,runtimeId:null,hasRuntime:false},ready];
 let reads=0;
 const client={evaluate:async()=>states[reads++]};
 assert.deepEqual(await waitForExtensionPage(client,{extensionId,url}),ready);
 assert.equal(reads,3);
});

for(const [reason,change] of [
 ['wrong extension identity',{runtimeId:'other-extension'}],
 ['wrong document',{url:'chrome-error://chromewebdata/'}],
 ['loading document',{readyState:'loading'}],
 ['missing debugger permission',{hasDebugger:false}],
])test(`fixture refuses ${reason} and records the actual context instead of invoking getURL`,async()=>{
 const state={...ready,...change};
 await assert.rejects(waitForExtensionPage({evaluate:async()=>state},{extensionId,url,timeoutMs:20}),error=>{
  assert.match(error.message,/扩展页面与 API 就绪/);
  assert.ok(error.message.includes(JSON.stringify(state)));
  return true;
 });
});

test('fixture accepts the committed extension document after an old execution context is destroyed',async()=>{
 let reads=0;
 const client={evaluate:async()=>{if(++reads===1)throw Error('Execution context was destroyed');return ready;}};
 assert.deepEqual(await waitForExtensionPage(client,{extensionId,url}),ready);
 assert.equal(reads,2);
});
