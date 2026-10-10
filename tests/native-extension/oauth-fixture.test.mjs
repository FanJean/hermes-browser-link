import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {JSDOM} from 'jsdom';
import {configureOAuthFixture,oauthFixtureMode,oauthFixtureDiagnostics,oauthReturnReadDiagnostics} from '../native-v2/oauth-fixture.mjs';
import {Executor} from '../../native-extension/core.mjs';
import {trustedTask} from './workspace-fixture.mjs';
import {oauthSourcePage,oauthProviderPage,oauthDonePage,OAUTH_DONE_MARKER} from '../complex-ui/oauth-fixture-page.mjs';
import {createHash} from 'node:crypto';
import {createPageSemantics} from '../../page-semantics/index.js';

const providers=[{origin:'http://login.localhost:9000',paths:['/oauth-provider']}];
test('completion marker appears in the actual content semantic snapshot of the new document',()=>{
 const dom=new JSDOM(oauthDonePage,{url:'http://127.0.0.1:9000/oauth-done',pretendToBeVisual:true});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:240,height:38}];
 const semantics=createPageSemantics({document:dom.window.document,taskId:'task',documentId:'new-document',leaseId:'lease'});
 try{
  const read=semantics.snapshot({mode:'content',budget:5000});
  assert.ok(JSON.stringify(read.items).includes(OAUTH_DONE_MARKER));
  assert.equal(read.binding.documentId,'new-document');
 }finally{semantics.revoke();dom.window.close();}
});
test('return-read failure diagnostics preserve the complete receipt and correlate the executed tab by request hash',async()=>{
 const receipt={items:[],binding:{documentId:'doc-new'},popupClosed:{returnedTo:1}},request={requestId:'return-read',tabId:2,action:'semantic_snapshot'};
 const requestIdHash=createHash('sha256').update(request.requestId).digest('hex');
 let actualTab;
 const diagnostic=await oauthReturnReadDiagnostics({receipt,request,
  readTask:async()=>({currentOperation:{action:'semantic_snapshot',requestIdHash,tabId:1}}),
  readTab:async id=>{actualTab=id;return {url:'http://127.0.0.1:9000/oauth-done',status:'complete'};}});
 assert.deepEqual(diagnostic.receipt,receipt);assert.equal(diagnostic.bindingDocumentId,'doc-new');
 assert.equal(diagnostic.itemsSummary.count,0);assert.equal(actualTab,1);
 assert.equal(diagnostic.actualRead.tabId,1);assert.equal(diagnostic.actualRead.url,'http://127.0.0.1:9000/oauth-done');
});
test('stale persisted operations do not invent an actual return-read target',async()=>{
 const diagnostic=await oauthReturnReadDiagnostics({receipt:{items:[],binding:{documentId:'new'}},request:{requestId:'new'},
  readTask:async()=>({currentOperation:{requestIdHash:'old',tabId:9}}),readTab:async()=>assert.fail('must not read a guessed tab')});
 assert.equal(diagnostic.actualRead,undefined);assert.match(diagnostic.actualReadError,/not been persisted/);
 assert.equal(diagnostic.receipt.binding.documentId,'new');
});
test('temporary OAuth setup keeps the production background and sender guard, changes only its own build and compiles',async()=>{
 const before=await readFile('native-extension/background.mjs','utf8'),work=await mkdtemp(path.join(tmpdir(),'oauth-bg-'));
 try{
  await mkdir(path.join(work,'vendor'));
  await writeFile(path.join(work,'background.mjs'),before);
  await writeFile(path.join(work,'BUILD-DEPS.json'),JSON.stringify({version:1,dependencies:{},buildId:'old'}));
  await writeFile(path.join(work,'build-id.mjs'),"export const BUILD_ID='old';\n");
  const configured=await configureOAuthFixture(work,providers),body=await readFile(path.join(work,'background.mjs'),'utf8');
  assert.equal((body.match(/new Executor\(/g)||[]).length,1,'沿用真实 background 的唯一执行器');
  assert.ok(body.indexOf("if(!isUiSender(sender,chrome.runtime.id))return false;")<body.indexOf("if(m.type==='oauth_fixture_mode')"));
  assert.ok(body.indexOf("if(!isUiSender(sender,chrome.runtime.id))return false;")<body.indexOf("if(m.type==='oauth_fixture_diagnostics')"));
  assert.ok(body.includes("await current.request('extension.popup_adopted',p).then(result=>"));
  assert.ok(body.includes('chrome.tabs.onCreated.addListener(tab=>executor.tabCreated(tab)'));
  assert.ok(body.includes('onOverlayCommand:overlayCommand'));
  assert.ok(body.includes('chrome.runtime.connectNative'));
  assert.equal(await readFile('native-extension/background.mjs','utf8'),before);
  assert.notEqual(configured.buildId,'old');
  assert.equal(JSON.parse(await readFile(path.join(work,'BUILD-DEPS.json'),'utf8')).buildId,configured.buildId);
  assert.ok((await readFile(path.join(work,'build-id.mjs'),'utf8')).includes(configured.buildId));
  execFileSync(process.execPath,['--check',path.join(work,'background.mjs')]);
 }finally{await rm(work,{recursive:true,force:true});}
});

test('diagnostics retain raw URLs, pending navigation, candidates and native receipts for only the selected task',async()=>{
 const candidate={candidateRef:'r',tabId:2,origin:'http://login.localhost:9000'};
 const executor={tasks:new Map([['a',{tabIds:new Set([1]),popupDiscoveries:new Map([['r',{candidateRef:'r',tabId:2,candidate,autoWork:Promise.resolve(),automaticBlocked:true}]])}]])};
 const api={tabs:{get:async id=>id===1?{url:'http://127.0.0.1:9000/'}:{url:'about:blank',pendingUrl:'http://login.localhost:9000/oauth-provider',status:'loading'}}};
 const receipts=[{taskId:'a',error:{code:'approval_stale'}},{taskId:'other',result:{adopted:true}}];
 const result=await oauthFixtureDiagnostics({api,executor,receipts,taskId:'a'});
 assert.equal(result.tabs[1].url,'about:blank');assert.equal(result.tabs[1].pendingUrl,'http://login.localhost:9000/oauth-provider');
 assert.deepEqual(result.receipts,[receipts[0]]);assert.equal(result.candidates[0].working,true);assert.equal(result.candidates[0].automaticBlocked,true);
 assert.deepEqual(result.candidates[0].candidate,candidate);
});

for(const origin of ['https://accounts.google.com','http://login.localhost.evil.test','http://user:pass@localhost:9000','http://localhost:9000/path'])test(`fixture rejects ${origin} before touching any extension`,async()=>{
 await assert.rejects(configureOAuthFixture('/unavailable-fixture',[{origin,paths:['/oauth-provider']}]),/local origins/);
});

test('smart fixture mode travels through extension.mode and the real Executor.setMode without granting any action',async()=>{
 const task={...trustedTask(),modeGeneration:2,activeMode:'full',state:'ready'},executor=new Executor({});
 await executor.approve({...trustedTask(),tabIds:[]});executor.setMode(task);
 const requests=[],bridge={request:async(method,params)=>{
  requests.push({method,params});
  if(method==='extension.tasks')return [task];
  assert.equal(method,'extension.mode');assert.deepEqual(params,{taskId:'a',generation:1,modeGeneration:2,mode:'smart'});
  return {...task,activeMode:'smart',modeGeneration:3};
 }};
 const result=await oauthFixtureMode({bridge,executor,message:{taskId:'a',mode:'smart'}});
 assert.equal(result.activeMode,'smart');assert.equal(executor.tasks.get('a').policy.activeMode,'smart');
 assert.equal(executor.actionGrants.size,0);assert.equal(requests.length,2);
});

for(const change of ['revoked','generation','mode generation','task running'])test(`fixture mode rejects ${change} before a native mode change`,async()=>{
 const task={...trustedTask(),modeGeneration:2,activeMode:'full',state:'ready'},executor=new Executor({});
 await executor.approve({...trustedTask(),tabIds:[]});executor.setMode(task);
 if(change==='revoked')executor.tasks.get('a').revoked=true;
 if(change==='generation')task.generation=2;
 if(change==='mode generation')task.modeGeneration=3;
 if(change==='task running')task.state='running';
 let writes=0;const bridge={request:async method=>{if(method!=='extension.tasks')writes++;return [task];}};
 await assert.rejects(oauthFixtureMode({bridge,executor,message:{taskId:'a',mode:'smart'}}),/scope changed/);
 assert.equal(writes,0);
});

for(const [label,features] of [['只开授权小窗','popup,width=430,height=560'],['只开同窗授权标签',undefined],['只开非白名单小窗','popup,width=430,height=560']])test(`${label} onclick only opens the requested local window without changing source DOM or URL`,()=>{
 const origin='http://127.0.0.1:9000',loginOrigin='http://login.localhost:9000',manualOrigin='http://manual.localhost:9000';
 const dom=new JSDOM(oauthSourcePage({origin,loginOrigin,manualOrigin,flow:'flow'}),{url:origin+'/oauth-source?flow=flow',runScripts:'dangerously'});
 try{
  const opened=[];dom.window.open=(...args)=>{opened.push(args);return {};};
  const before=dom.window.document.querySelector('main').outerHTML,url=dom.window.location.href;
  const button=[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===label);
  assert.match(button.getAttribute('onclick'),/^window\.open\(/);button.click();
  assert.equal(opened.length,1);assert.equal(opened[0][2],features);
  assert.equal(new URL(opened[0][0]).origin,label==='只开非白名单小窗'?manualOrigin:loginOrigin);
  assert.equal(dom.window.document.querySelector('main').outerHTML,before);assert.equal(dom.window.location.href,url);
  assert.equal(dom.window.oauthClickCount,1);
 }finally{dom.window.close();}
});

test('completion waits for the local authorization server and the page itself posts to its opener and closes',async()=>{
 const dom=new JSDOM(oauthProviderPage(),{url:'http://login.localhost:9000/oauth-provider?flow=flow&source=http%3A%2F%2F127.0.0.1%3A9000',runScripts:'dangerously'});
 const dispose=dom.window.close.bind(dom.window);
 try{
  let finish,closed=0;const messages=[],requests=[];
  dom.window.fetch=async url=>{requests.push(url);return new Promise(resolve=>finish=resolve);};
  dom.window.opener={postMessage:(...args)=>messages.push(args)};dom.window.close=()=>closed++;
  dom.window.document.querySelector('button').click();
  assert.deepEqual(requests,['/oauth-complete?flow=flow']);assert.equal(closed,0);assert.equal(messages.length,0);
  finish({ok:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(messages.length,1);assert.equal(messages[0][1],'http://127.0.0.1:9000');assert.equal(messages[0][0].flow,'flow');assert.equal(closed,1);
 }finally{dispose();}
});
