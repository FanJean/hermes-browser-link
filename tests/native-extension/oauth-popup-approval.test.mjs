// The real approval projection must show popup confirmations even in full mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {Bridge} from '../../native-extension/bridge.mjs';
const scope={source:{tabId:1,windowId:7,origin:'https://example.com',documentGeneration:0},candidate:{candidateRef:'ref-2',tabId:2,windowId:8,openerTabId:1,origin:'https://accounts.example.test',windowType:'popup'}};

async function projection(){
 const code=await readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
 const task={id:'a',generation:1,instanceId:'instance',state:'ready',activeMode:'full',modeGeneration:2,allowedOrigins:['https://example.com'],title:'OAuth'};
 let changed=false;
 const context={executor:{tasks:new Map([['a',{...task,policy:{activeMode:'full',modeGeneration:2}}]]),leases:new Map([[1,'a']]),preparePopup:async()=>changed?{...scope,candidate:{...scope.candidate,windowId:9}}:scope},chrome:{tabs:{get:async()=>({id:1,windowId:7,url:'https://example.com/'})}},origin:url=>new URL(url).origin};
 vm.runInNewContext(code.slice(code.indexOf('const approvalActions='),code.indexOf('async function collectApprovals('))+'\nglobalThis.project=pendingAction;',context);
 const approval={taskId:'a',generation:1,modeGeneration:2,nonce:'nonce',digest:'digest',expiresAt:Date.now()/1000+120,popupScope:scope,request:{taskId:'a',requestId:'adopt',action:'popup_adopt',tabId:1,candidateRef:'ref-2'}};
 return {context,task,approval,change:()=>{changed=true;}};
}
test('full mode popup approval names the exact existing window and target origin',async()=>{
 const f=await projection(),view=await f.context.project(f.approval,f.task,'instance');
 assert.ok(view);assert.ok(view.action.includes('https://accounts.example.test'));assert.ok(view.action.includes('8'));
 f.change();assert.equal(await f.context.project(f.approval,f.task,'instance'),null);
});
test('bridge routes private metadata preparation without page execution',async()=>{
 const calls=[],b=new Bridge({onMessage:{addListener(){}},postMessage(){}},{preparePopup:async p=>{calls.push(p);return scope;}});
 const response=await b.executeRequest({id:'prepare',method:'browser.popup_prepare',params:{tabId:1}});
 assert.deepEqual(response.result,scope);assert.equal(calls.length,1);
});

test('approval identity comparison is independent of transport object-key order',async()=>{
 const f=await projection();
 f.approval.popupScope={candidate:Object.fromEntries(Object.entries(scope.candidate).reverse()),source:Object.fromEntries(Object.entries(scope.source).reverse())};
 assert.ok(await f.context.project(f.approval,f.task,'instance'));
});
