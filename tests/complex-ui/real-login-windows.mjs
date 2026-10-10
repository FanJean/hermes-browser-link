// 中文注释：手动真实浏览器验收。仅连接临时 profile 和本地双来源，不登录真实 Google，不进入默认离线门禁。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {CdpClient,fetchJson,waitFor} from '../native-v2/cdp-client.mjs';
import {oauthSourcePage,oauthProviderPage,oauthDonePage,OAUTH_DONE_MARKER} from './oauth-fixture-page.mjs';
import {oauthReturnReadDiagnostics} from '../native-v2/oauth-fixture.mjs';

const fixture=await readFile(new URL('./login-windows.html',import.meta.url),'utf8');
const completionResponses=new Map();
const server=createServer((request,response)=>{
 const origin=`http://127.0.0.1:${server.address().port}`,url=new URL(request.url,origin);
 if(url.pathname==='/oauth-complete'){
  const flow=url.searchParams.get('flow');
  if(completionResponses.has(flow)){response.writeHead(409);response.end('duplicate completion');return;}
  completionResponses.set(flow,response);return;
 }
 response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 if(url.pathname==='/oauth-source')response.end(oauthSourcePage({origin,loginOrigin:origin.replace('127.0.0.1','login.localhost'),manualOrigin:origin.replace('127.0.0.1','manual.localhost'),flow:url.searchParams.get('flow')}));
 else if(url.pathname==='/oauth-provider')response.end(oauthProviderPage());
 else if(url.pathname==='/oauth-done')response.end(oauthDonePage);
 else response.end(fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,loginOrigin=origin.replace('127.0.0.1','login.localhost'),manualOrigin=origin.replace('127.0.0.1','manual.localhost');
const browser=process.argv.includes('--edge')?'edge':'chrome';
const output=path.join(process.env.TMPDIR,`login-windows-${browser}`),results=[];
await mkdir(output,{recursive:true});
let session;
const verify=result=>{assert.equal(result?.error,undefined,JSON.stringify(result));return result;};
async function check(name,fn){
 if(process.argv.includes('--popup-only')&&!/独立小窗|关闭任务/.test(name))return;
 const started=performance.now();
 try{const detail=await fn();results.push({name,ok:true,ms:Math.round(performance.now()-started),detail});}
 catch(error){results.push({name,ok:false,error:String(error.message),stack:error.stack,diagnostics:error.diagnostics});}
}
try{
 session=await openRealSession({browser,label:'login',headed:true,compactScratch:true,hostRules:'MAP login.localhost 127.0.0.1, MAP manual.localhost 127.0.0.1',oauthProviders:[{origin:loginOrigin,paths:['/oauth-provider']}]});
 await session.enableFullAccess();
 const tab=await openTask(session,{owner:'login-windows',origins:[origin],url:origin,title:'本地登录窗口'});
 const run=async(action,params={})=>verify(await tab.run(action,params));
 const ref=async(name,root=null)=>{
  const snap=await run('semantic_snapshot',{options:{mode:'interactive',query:name,...(root?{root}:{}),budget:5000}});
  const item=snap.items.find(item=>item.name===name);assert.ok(item,`缺少控件 ${name}`);
  return {binding:snap.binding,snapshot_id:snap.snapshotId,ref:item.ref};
 };
 const reset=async()=>{await run('navigate',{url:origin});await tab.read('document.readyState');};
 await check('关闭的 dialog、popover、浮层不返回账号框',async()=>{
  const page=await run('page.parse',{options:{sections:['forms','regions']}});
  assert.ok(!page.forms.some(field=>field.fieldKind==='account'));return {forms:page.forms.length};
 });
 for(const [name,button,root,kind] of [
  ['原生模态层','打开模态登录','#modal','modal'],
  ['顶层 popover','打开顶层登录','#popover','popover'],
  ['固定浮层','打开浮层登录','#floating','floating'],
 ]){
  await check(`${name}：账号填写、下一步、密码和验证码识别`,async()=>{
   await reset();await run('ref_click',await ref(button));
   const parsed=await run('page.parse',{options:{root,sections:['forms','regions']}});
   assert.equal(parsed.regions[0].surfaceKind,kind);
   assert.equal(parsed.forms[0].fieldKind,'account');assert.ok(parsed.forms[0].actions.includes('fill'));
   assert.equal(parsed.forms[0].surfaceRef,parsed.regions[0].sourceRef);
   const snap=await run('semantic_snapshot',{options:{root}});
   if(!snap.items.length){const state=await tab.read(`(()=>{const e=document.querySelector(${JSON.stringify(root)});return {open:e.matches(':popover-open'),visible:e.getClientRects().length,controls:e.querySelectorAll('input,button').length}})()`);assert.fail(JSON.stringify({root,coverage:snap.coverage,state}));}
   assert.equal(snap.items[0].context.at(-1).surfaceKind,kind);
   await run('ref_fill',{...await ref('账号',root),text:'synthetic@example.test'});
   await run('ref_click',await ref('下一步',root));
   const next=await run('page.parse',{options:{root,sections:['forms']}});
   assert.deepEqual(next.forms.slice(0,2).map(field=>field.fieldKind),['password','otp']);
   for(const field of next.forms.slice(0,2)){assert.deepEqual(field.actions,[]);assert.equal(field.inputRequired,'vault_or_user');}
   assert.ok(!JSON.stringify(next).includes('synthetic@example.test'));return {surface:kind,fields:next.forms.map(field=>field.fieldKind||field.role)};
  });
 }
 await check('非模态原生 dialog 不误报 modal，关闭后字段消失',async()=>{
  await reset();await run('ref_click',await ref('打开模态登录'));
  await tab.read(`document.querySelector('#modal').close();document.querySelector('#modal').show();true`);
  const parsed=await run('page.parse',{options:{root:'#modal',sections:['regions','forms']}});
  assert.equal(parsed.regions[0].surfaceKind,'dialog');
  await tab.read(`document.querySelector('#modal').close();true`);
  const closed=await run('page.parse',{options:{sections:['forms']}});assert.ok(!closed.forms.some(field=>field.fieldKind));return {surface:'dialog',closed:true};
 });
 await check('positive z-index 的绝对浮层可解析',async()=>{
  await reset();await run('ref_click',await ref('打开浮层登录'));
  await tab.read(`document.querySelector('#floating').style.position='absolute';true`);
  const parsed=await run('page.parse',{options:{root:'#floating',sections:['regions','forms']}});
  assert.equal(parsed.regions[0].surfaceKind,'floating');assert.equal(parsed.forms[0].fieldKind,'account');return {surface:'floating'};
 });
 await check('跨源登录 iframe 未授权时不读取字段',async()=>{
  await reset();await run('ref_click',await ref('打开跨源登录框架'));
  const catalog=await run('frame_catalog');assert.ok(catalog.frames.some(frame=>frame.origin===loginOrigin));
  const parsed=await run('page.parse',{options:{composed:true,sections:['forms']}});
  assert.equal(parsed.status,'partial');assert.ok(!parsed.forms.some(field=>field.fieldKind==='account'));return {status:parsed.status,unreadFrames:parsed.contentFilter?.unreadFrames};
 });
 await check('1440/375 登录浮层截图与无横向溢出',async()=>{
  await reset();await run('ref_click',await ref('打开顶层登录'));
  const target=(await fetchJson(`${session.base}/json/list`)).find(target=>target.url===origin+'/');
  assert.ok(target);const cdp=new CdpClient(target.webSocketDebuggerUrl);await cdp.connect();
  try{
   for(const width of [1440,375]){
    await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await waitFor(()=>tab.read(`innerWidth===${width}`),5000,{label:'验收视口'});
    assert.ok(await tab.read('document.documentElement.scrollWidth<=innerWidth'),'页面横向溢出');
    const shot=await run('screenshot');assert.equal(typeof shot.data,'string','截图缺少图像数据');
    await writeFile(path.join(output,`popover-${width}.png`),Buffer.from(shot.data,'base64'));
   }
  }finally{cdp.close();}
  return {screenshots:['popover-1440.png','popover-375.png']};
 });
 await check('明确授权的跨源登录 iframe 可定位账号并继续下一步',async()=>{
  const framed=await openTask(session,{owner:'login-frame',origins:[origin,loginOrigin],url:origin,title:'已授权本地登录框架'});
  verify(await framed.act('ref_click',await framed.ref('打开跨源登录框架',['button'])));
  const catalog=verify(await framed.run('frame_catalog'));
  const frame=catalog.frames.find(frame=>frame.origin===loginOrigin);assert.ok(frame);
  const read=()=>framed.run('semantic_snapshot',{options:{frameToken:frame.frameToken}}).then(verify);
  const account=await read(),field=account.items.find(field=>field.fieldKind==='account');assert.ok(field);
  verify(await framed.run('ref_fill',{binding:account.binding,snapshot_id:account.snapshotId,ref:field.ref,frame_token:frame.frameToken,text:'synthetic@example.test'}));
  const fresh=await read(),next=fresh.items.find(field=>field.name==='下一步');assert.ok(next);
  verify(await framed.run('ref_click',{binding:fresh.binding,snapshot_id:fresh.snapshotId,ref:next.ref,frame_token:frame.frameToken}));
  assert.deepEqual((await read()).items.slice(0,2).map(field=>field.fieldKind),['password','otp']);
  return {authorizedOrigin:loginOrigin,fields:['account','password','otp']};
 });
 const adoptedPopups=[];
 await session.ui.evaluate(`window.popupEvents=[];chrome.tabs.onCreated.addListener(async tab=>{window.popupEvents.push({kind:'created',tabId:tab.id,windowId:tab.windowId,openerTabId:tab.openerTabId});const fresh=await chrome.tabs.get(tab.id);window.popupEvents.push({kind:'readback',tabId:fresh.id,windowId:fresh.windowId,openerTabId:fresh.openerTabId});});true`);
 for(const [label,button] of [['同步独立小窗','打开独立登录小窗'],['延迟独立小窗','延迟打开登录小窗']]){
  await check(`${label}：确认原窗口后接管，最小化仍可填写并解析密码步骤`,async()=>{
   await reset();await run('popup_catalog');
   // 中文注释：打开小窗需要浏览器真实用户激活；创建入口置前，接管后再测试最小化，不绕过 popup 拦截。
   await session.ui.evaluate(`chrome.tabs.get(${tab.tabId}).then(tab=>chrome.windows.update(tab.windowId,{state:'normal',focused:true}).then(()=>chrome.tabs.update(tab.id,{active:true}))).then(()=>true)`);
   const clicked=await tab.run('ref_click',await ref(button));
   if(clicked.error){
    const catalog=await run('popup_catalog'),state=await tab.read('window.popupTest||null');
    assert.fail(JSON.stringify({code:clicked.code,candidates:catalog.candidates.length,state}));
   }
   let catalog;
   try{catalog=await waitFor(async()=>{
    const value=await run('popup_catalog');return value.candidates.length?value:null;
   },10000,{label:'独立登录 popup 候选'});}
   catch(error){
    const state=await tab.read('window.popupTest||null');
    const windows=await session.ui.evaluate(`chrome.tabs.query({}).then(async tabs=>Promise.all(tabs.filter(tab=>tab.openerTabId===${tab.tabId}||tab.url?.startsWith(${JSON.stringify(loginOrigin)})).map(async tab=>({tabId:tab.id,openerTabId:tab.openerTabId,windowId:tab.windowId,type:(await chrome.windows.get(tab.windowId)).type}))))`);
    const events=await session.ui.evaluate('window.popupEvents');
    assert.fail(JSON.stringify({error:error.message,state,windows,events}));
   }
   assert.ok(!JSON.stringify(catalog).includes('SYNTHETIC_OAUTH_STATE'));
   const candidate=catalog.candidates.at(-1);assert.equal(candidate.origin,loginOrigin);assert.equal(candidate.windowType,'popup');
   const popupRun=(action,params={})=>session.rpc(tab.owner,'run',{task_id:tab.task.id,tab_id:candidate.tabId,request_id:tab.nextId(),action,...params});
   const before=await popupRun('semantic_snapshot');assert.equal(before.code,'foreign_tab');
   const id=tab.nextId(),args={candidate_ref:candidate.candidateRef};
   assert.equal((await tab.run('popup_adopt',args,id)).status,'approval_required');
   await session.approvePanel('approve',loginOrigin);
   // 中文注释：接管由批准回调执行；读回双方授权，不靠重复动作取得一次性回执。
   const current=await waitFor(async()=>{
    const value=verify(await session.rpc(tab.owner,'get',{task_id:tab.task.id}));
    return value.adoptedPopupTabIds?.includes(candidate.tabId)?value:null;
   },10000,{label:'原小窗接管授权读回'});
   assert.ok(current.tabIds.includes(candidate.tabId));assert.ok(current.allowedOrigins.includes(loginOrigin));
   const hostTask=JSON.parse(await readFile(path.join(session.staged.hermesHome,'plugin-data/browser-link-native/tasks.json'),'utf8')).tasks.find(task=>task.id===tab.task.id);
   assert.ok(hostTask);assert.ok(!hostTask.agentTabIds.includes(candidate.tabId));
   const replay=await tab.run('popup_adopt',args,id);
   assert.equal(replay.bridgeCode,'request_outcome_unavailable');assert.equal(replay.retryable,false);
   assert.equal(replay.adopted,undefined);
   adoptedPopups.push(candidate);
   const parsed=verify(await popupRun('page.parse',{options:{sections:['forms']}}));assert.equal(parsed.forms[0].fieldKind,'account');
   await session.ui.evaluate(`chrome.windows.update(${candidate.windowId},{state:'minimized'}).then(()=>true)`);
   const snap=verify(await popupRun('semantic_snapshot')),field=snap.items.find(field=>field.fieldKind==='account');assert.ok(field);
   verify(await popupRun('ref_fill',{binding:snap.binding,snapshot_id:snap.snapshotId,ref:field.ref,text:'synthetic@example.test'}));
   const fresh=verify(await popupRun('semantic_snapshot')),next=fresh.items.find(field=>field.name==='下一步');assert.ok(next);
   verify(await popupRun('ref_click',{binding:fresh.binding,snapshot_id:fresh.snapshotId,ref:next.ref}));
   const password=verify(await popupRun('semantic_snapshot'));assert.deepEqual(password.items.slice(0,2).map(field=>field.fieldKind),['password','otp']);
   assert.ok(await session.ui.evaluate(`chrome.tabs.get(${candidate.tabId}).then(tab=>tab.windowId===${candidate.windowId})`));
   return {adopted:true,cleanupOwned:false,windowType:candidate.windowType,minimized:true};
  });
 }
 await check('关闭任务只撤销 popup 权限，保留已接管的原小窗',async()=>{
  assert.equal(adoptedPopups.length,2);
  verify(await session.rpc(tab.owner,'close',{task_id:tab.task.id}));
  for(const candidate of adoptedPopups)assert.ok(await session.ui.evaluate(`chrome.tabs.get(${candidate.tabId}).then(tab=>tab.windowId===${candidate.windowId})`));
  return {preserved:adoptedPopups.length};
 });

 // 中文注释：只为临时实例选择 legacy smart/full，调用实际 background 的私有模式请求；不伪造审批或遮罩放行。
 const taskState=handle=>session.rpc(handle.owner,'get',{task_id:handle.task.id}).then(verify);
 let diagnostics;
 const extensionDiagnostics=handle=>session.ui.evaluate(`chrome.runtime.sendMessage({type:'oauth_fixture_diagnostics',taskId:${JSON.stringify(handle.task.id)}})`);
 const setMode=async(handle,mode)=>{
  const receipt=await session.ui.evaluate(`chrome.runtime.sendMessage({type:'oauth_fixture_mode',taskId:${JSON.stringify(handle.task.id)},mode:${JSON.stringify(mode)}})`);
  assert.equal(receipt.error,undefined,JSON.stringify(receipt));assert.equal(receipt.result.activeMode,mode);
  const current=await taskState(handle);assert.equal(current.activeMode,mode);assert.equal(current.modeGeneration,receipt.result.modeGeneration);
 };
 const confirmedRun=async(handle,action,params={})=>{
  const id=handle.nextId();
  if(diagnostics)diagnostics.lastRequest={requestId:id,action,tabId:handle.tabId};
  const first=verify(await handle.run(action,params,id));
  if(first.status!=='approval_required')return first;
  const approval={at:Date.now(),action,tabId:handle.tabId,requestId:id,receipt:structuredClone(first)};
  if(diagnostics)(diagnostics.approvals??=[]).push(approval);
  try{approval.panelTargetsBefore=await session.approvalPanelTargets();}catch(error){approval.panelTargetsBefore={error:error.message};}
  try{await session.approvePanel('approve');}
  catch(error){approval.panelTargetsAtFailure=error.approvalPanelTargets;throw error;}
  return waitFor(async()=>{
   const result=verify(await handle.run(action,params,id));
   return ['approval_required','approved','executing'].includes(result.status)?null:result;
  },15000,{label:`原请求确认后 ${action} 回执`});
 };
 const freshRef=async(handle,name)=>{
  const snapshot=await confirmedRun(handle,'semantic_snapshot',{options:{mode:'interactive',query:name,budget:5000}});
  const item=snapshot.items.find(item=>item.name===name);assert.ok(item,`缺少控件 ${name}`);
  return {binding:snapshot.binding,snapshot_id:snapshot.snapshotId,ref:item.ref};
 };
 const openOnly=async(handle,button)=>{
  const token=await freshRef(handle,button);
  const before=await handle.read('({html:document.querySelector("main").outerHTML,url:location.href})');
  await session.ui.evaluate(`chrome.tabs.get(${handle.tabId}).then(tab=>chrome.windows.update(tab.windowId,{state:'normal',focused:true}).then(()=>chrome.tabs.update(tab.id,{active:true}))).then(()=>true)`);
  const result=await confirmedRun(handle,'ref_click',token);
  if(diagnostics)diagnostics.click=structuredClone(result);
  assert.equal(result.effect,'observed');assert.ok(result.popupOpened,JSON.stringify(result));assert.notEqual(result.outcomeUnknown,true);
  assert.equal(await handle.read('window.oauthClickCount'),1,'只开窗按钮不得重放');
  assert.deepEqual(await handle.read('({html:document.querySelector("main").outerHTML,url:location.href})'),before,'来源 DOM 和 URL 必须未变化');
  if(!result.popupOpened.origin||!result.popupOpened.windowType){
   // 中文注释：保留原始点击回执；只等待 catalog 的已验证身份，绝不重放点击或放宽来源断言。
   const candidate=await waitFor(async()=>{
    const catalog=verify(await handle.run('popup_catalog'));
    if(diagnostics)(diagnostics.catalogReads??=[]).push(catalog);
    return [...catalog.candidates,...(catalog.adoptedPopups||[])].find(row=>row.candidateRef===result.popupOpened.candidateRef&&row.origin&&row.windowType);
   },10000,{label:'登录候选完成导航后的 catalog 身份'});
   return {...result,popupOpened:{candidateRef:candidate.candidateRef,origin:candidate.origin,windowType:candidate.windowType,tabId:candidate.tabId}};
  }
  return result;
 };
 const persistedTask=async handle=>(JSON.parse(await readFile(path.join(session.staged.hermesHome,'plugin-data/browser-link-native/tasks.json'),'utf8')).tasks.find(row=>row.id===handle.task.id));
 const verifyAutoAudit=async(handle,popup)=>{
  const current=await waitFor(async()=>{
   const value=await taskState(handle);return value.adoptedPopupTabIds?.includes(popup.tabId)?value:null;
  },10000,{label:'background/daemon 自动接管读回'});
  assert.ok(current.tabIds.includes(popup.tabId));assert.ok(!current.pendingInteraction);
  const saved=await waitFor(async()=>{
   const value=await persistedTask(handle);
   return value?.requestHistory.some(row=>row.action==='popup_adopt'&&row.automatic===true&&row.popupTargetTabId===popup.tabId)?value:null;
  },10000,{label:'自动接管持久化台账'});
  const entry=saved.requestHistory.find(row=>row.action==='popup_adopt'&&row.automatic===true&&row.popupTargetTabId===popup.tabId);
  assert.equal(entry.state,'confirmed');assert.equal(entry.modeGeneration,current.modeGeneration);
  assert.ok(saved.operationTimeline.some(row=>row.action==='popup_adopt'&&row.automatic===true&&row.tabId===popup.tabId));
  assert.ok(!saved.requestHistory.some(row=>row.action==='popup_adopt'&&row.automatic!==true),'自动接管不能借人工 popup_adopt 完成');
  assert.ok(!saved.agentTabIds.includes(popup.tabId),'接管不能授予删除权');
  const journal=(await readFile(path.join(session.staged.hermesHome,'plugin-data/browser-link-native/requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.ok(journal.some(row=>row.task.id===handle.task.id&&row.entry.requestIdHash===entry.requestIdHash&&row.entry.automatic===true&&row.entry.state==='confirmed'));
  return {automatic:true,tabId:popup.tabId,modeGeneration:current.modeGeneration,requestIdHash:entry.requestIdHash};
 };
 const withOAuthTask=async(label,fn)=>{
  const flow=crypto.randomUUID(),url=origin+'/oauth-source?flow='+encodeURIComponent(flow);
  const handle=await openTask(session,{owner:'oauth-'+label,origins:[origin],url,title:'OAuth '+label});
  diagnostics={taskId:handle.task.id,urlTimeline:[]};
  const capture=async()=>{try{diagnostics.urlTimeline.push(await extensionDiagnostics(handle));}catch(error){diagnostics.urlTimeline.push({at:Date.now(),error:error.message});}};
  let sampling=Promise.resolve();
  const timer=setInterval(()=>{sampling=sampling.then(capture);},100);
  try{return await fn(handle,flow);}
  catch(error){
   clearInterval(timer);await sampling;await capture();
   for(const [key,read] of Object.entries({task:()=>taskState(handle),persistedTask:()=>persistedTask(handle),catalog:()=>handle.run('popup_catalog'),approvalPanelTargets:()=>session.approvalPanelTargets(),
    journal:async()=>(await readFile(path.join(session.staged.hermesHome,'plugin-data/browser-link-native/requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.task.id===handle.task.id)})){
    try{diagnostics[key]=await read();}catch(failure){diagnostics[key]={error:failure.message};}
   }
   diagnostics.operationTimeline=diagnostics.persistedTask?.operationTimeline;
   error.diagnostics=diagnostics;throw error;
  }
  finally{clearInterval(timer);await sampling;diagnostics=null;verify(await session.rpc(handle.owner,'close',{task_id:handle.task.id}));}
 };
 for(const [label,button,windowType] of [['popup','只开授权小窗','popup'],['same-window-tab','只开同窗授权标签','normal']]){
  await check(`A ${label}：仅开窗的 ref_click 返回 observed 和 popupOpened`,()=>withOAuthTask('A-'+label,async handle=>{
   const result=await openOnly(handle,button);assert.equal(result.popupOpened.origin,loginOrigin);assert.equal(result.popupOpened.windowType,windowType);
   const target=await session.ui.evaluate(`chrome.tabs.get(${result.popupOpened.tabId})`),source=await session.ui.evaluate(`chrome.tabs.get(${handle.tabId})`);
   if(windowType==='normal')assert.equal(target.windowId,source.windowId);else assert.notEqual(target.windowId,source.windowId);
   return {effect:result.effect,popupOpened:result.popupOpened};
  }));
 }
 for(const [label,button,windowType] of [['popup','只开授权小窗','popup'],['same-window-tab','只开同窗授权标签','normal']]){
  await check(`B smart ${label}：本地白名单自动接管并登记审计`,()=>withOAuthTask('B-'+label,async handle=>{
   await setMode(handle,'smart');const result=await openOnly(handle,button);
   assert.equal(result.popupOpened.origin,loginOrigin);assert.equal(result.popupOpened.windowType,windowType);
   if(windowType==='normal')assert.equal(await session.ui.evaluate(`chrome.tabs.get(${result.popupOpened.tabId}).then(async target=>target.windowId===(await chrome.tabs.get(${handle.tabId})).windowId)`),true);
   const audit=await verifyAutoAudit(handle,result.popupOpened);
   const popup=verify(await session.rpc(handle.owner,'run',{task_id:handle.task.id,tab_id:result.popupOpened.tabId,request_id:handle.nextId(),action:'semantic_snapshot'}));
   assert.ok(popup.items.some(item=>item.name==='完成本地授权'));
   return audit;
  }));
 }
 await check('C smart 非白名单：只发现候选，人工确认后才获得租约',()=>withOAuthTask('C-manual',async handle=>{
  await setMode(handle,'smart');const result=await openOnly(handle,'只开非白名单小窗');
  assert.equal(result.popupOpened.origin,manualOrigin);
  const current=await taskState(handle);assert.ok(!current.adoptedPopupTabIds?.includes(result.popupOpened.tabId));
  const before=await session.rpc(handle.owner,'run',{task_id:handle.task.id,tab_id:result.popupOpened.tabId,request_id:handle.nextId(),action:'semantic_snapshot'});assert.equal(before.code,'foreign_tab');
  const catalog=verify(await handle.run('popup_catalog')),candidate=catalog.candidates.find(row=>row.candidateRef===result.popupOpened.candidateRef);assert.ok(candidate);
  assert.equal((await handle.run('popup_adopt',{candidate_ref:candidate.candidateRef})).status,'approval_required');
  await session.approvePanel('approve',manualOrigin);
  await waitFor(async()=>{const state=await taskState(handle);return state.adoptedPopupTabIds?.includes(candidate.tabId);},10000,{label:'非白名单人工确认授权'});
  const saved=await persistedTask(handle);assert.ok(!saved.requestHistory.some(row=>row.automatic===true));
  return {manual:true,tabId:candidate.tabId};
 }));
 await check('D smart：站点关闭登录页后回源读取新文档且不报 stale',()=>withOAuthTask('D-close',async(handle,flow)=>{
  await setMode(handle,'smart');const sourceSnapshot=await confirmedRun(handle,'semantic_snapshot',{options:{mode:'content',budget:5000}});
  const result=await openOnly(handle,'只开授权小窗');await verifyAutoAudit(handle,result.popupOpened);
  const popupHandle={...handle,tabId:result.popupOpened.tabId,run:(action,params={},id)=>handle.run(action,{...params,tab_id:result.popupOpened.tabId},id)};
  await confirmedRun(popupHandle,'ref_click',await freshRef(popupHandle,'完成本地授权'));
  const response=await waitFor(()=>completionResponses.get(flow),10000,{label:'本地授权服务收到完成请求'});
  // 中文注释：模拟异步授权服务器回调；浏览器页面执行 postMessage/close，测试不操作遮罩或强关标签。
  response.writeHead(200,{'content-type':'text/plain'});response.end('authorized');completionResponses.delete(flow);
  const current=await waitFor(async()=>{const state=await taskState(handle);return state.popupClosed?.returnedTo===handle.tabId?state:null;},15000,{label:'关闭事件自动回源'});
  assert.ok(!current.tabIds.includes(result.popupOpened.tabId));
  await waitFor(()=>handle.read('location.pathname==="/oauth-done"&&document.readyState==="complete"'),15000,{label:'来源新文档完成'});
  const read=await confirmedRun(popupHandle,'semantic_snapshot',{options:{mode:'content',budget:5000}});
  const request=diagnostics.lastRequest,requestIdHash=createHash('sha256').update(request.requestId).digest('hex');
  diagnostics.returnRead=await oauthReturnReadDiagnostics({receipt:read,request,
   readTask:()=>waitFor(async()=>{const task=await persistedTask(handle);return task?.currentOperation?.requestIdHash===requestIdHash?task:null;},1500,{label:'本次回源读取的实际执行标签落盘'}),
   readTab:id=>session.ui.evaluate(`chrome.tabs.get(${id})`)});
  assert.deepEqual(read.popupClosed,{returnedTo:handle.tabId});
  assert.ok(JSON.stringify(read.items).includes(OAUTH_DONE_MARKER));assert.notEqual(read.binding.documentId,sourceSnapshot.binding.documentId);
  return {popupClosed:read.popupClosed,newDocument:true};
 }));
 await check('E full 白名单：不自动接管，仍需要精确确认',()=>withOAuthTask('E-full',async handle=>{
  const result=await openOnly(handle,'只开授权小窗'),current=await taskState(handle);assert.equal(current.activeMode,'full');
  assert.ok(!current.adoptedPopupTabIds?.includes(result.popupOpened.tabId));
  const catalog=verify(await handle.run('popup_catalog')),candidate=catalog.candidates.find(row=>row.candidateRef===result.popupOpened.candidateRef);assert.ok(candidate);
  assert.equal((await handle.run('popup_adopt',{candidate_ref:candidate.candidateRef})).status,'approval_required');
  await session.approvePanel('reject',loginOrigin);
  assert.ok(!(await taskState(handle)).adoptedPopupTabIds?.includes(candidate.tabId));
  const saved=await persistedTask(handle);assert.ok(!saved.requestHistory.some(row=>row.automatic===true));
  return {mode:'full',automatic:false,confirmationRequired:true};
 }));
}finally{
 for(const response of completionResponses.values())response.destroy();completionResponses.clear();
 await session?.close();await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(output,'results.json'),JSON.stringify({browser,origin,oauthFixture:session?.oauthFixture,results},null,2));
}
for(const result of results)console.log(`${result.ok?'PASS':'FAIL'} ${result.name}${result.ok?'':': '+result.error}`);
console.log(JSON.stringify({browser,passed:results.filter(result=>result.ok).length,total:results.length,output}));
process.exitCode=results.length===(process.argv.includes('--popup-only')?3:19)&&results.every(result=>result.ok)?0:1;
