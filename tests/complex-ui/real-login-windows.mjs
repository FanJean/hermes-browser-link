// 中文注释：手动真实浏览器验收。仅连接临时 profile 和本地双来源，不登录真实 Google，不进入默认离线门禁。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
import {CdpClient,fetchJson,waitFor} from '../native-v2/cdp-client.mjs';

const fixture=await readFile(new URL('./login-windows.html',import.meta.url),'utf8');
const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,loginOrigin=origin.replace('127.0.0.1','login.localhost');
const browser=process.argv.includes('--edge')?'edge':'chrome';
const output=path.join(process.env.TMPDIR,`login-windows-${browser}`),results=[];
await mkdir(output,{recursive:true});
let session;
const verify=result=>{assert.equal(result?.error,undefined,JSON.stringify(result));return result;};
async function check(name,fn){
 if(process.argv.includes('--popup-only')&&!/独立小窗|关闭任务/.test(name))return;
 const started=performance.now();
 try{const detail=await fn();results.push({name,ok:true,ms:Math.round(performance.now()-started),detail});}
 catch(error){results.push({name,ok:false,error:String(error.message).slice(0,1000)});}
}
try{
 session=await openRealSession({browser,label:'login',headed:true,compactScratch:true});
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
}finally{
 await session?.close();await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(output,'results.json'),JSON.stringify({browser,origin,results},null,2));
}
for(const result of results)console.log(`${result.ok?'PASS':'FAIL'} ${result.name}${result.ok?'':': '+result.error}`);
console.log(JSON.stringify({browser,passed:results.filter(result=>result.ok).length,total:results.length,output}));
process.exitCode=results.every(result=>result.ok)?0:1;
