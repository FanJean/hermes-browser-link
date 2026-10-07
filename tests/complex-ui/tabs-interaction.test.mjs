import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor,semanticWorldDeclaration} from '../../native-extension/core.mjs';
import {observeInputEffect} from '../../native-extension/action-effects.mjs';
function page(html){
 const dom=new JSDOM(html,{url:'https://fixture.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.HTMLElement.prototype.getClientRects=()=>[{width:100,height:30}];w.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:120,bottom:50,width:100,height:30});w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.document.elementFromPoint=()=>w.document.body.firstElementChild;
 const call=w.eval(`(${semanticWorldDeclaration})`),binding={taskId:'task',documentId:'doc',leaseId:'lease'};
 const snapshot=call('semantic_snapshot',{binding,options:{budget:6000}});return {dom,w,call,token:{binding,snapshotId:snapshot.snapshotId,ref:snapshot.items[0].ref}};
}
test('选项标签规范化 Unicode 和内部空白，写入前不存在匹配则明确拒绝',()=>{
 const f=page('<select aria-label="Region"><option value="a"> New   Zealand </option></select>');try{
  assert.equal(f.call('plan_ref_select_option',{...f.token,by:'label',values:['New Zealand']}).kind,'native');
  assert.throws(()=>f.call('plan_ref_select_option',{...f.token,by:'value',values:['missing']}),/SELECT_OPTION_MISSING/);
 }finally{f.dom.window.close();}
});
test('未关联列表的自定义下拉在任何展开点击前返回处理路径',()=>{
 const f=page('<div role="combobox" aria-label="Region" tabindex="0">Region</div>');try{
  assert.throws(()=>f.call('plan_ref_select_option',{...f.token,by:'label',values:['CN']}),/CUSTOM_SELECT_UNSUPPORTED/);
 }finally{f.dom.window.close();}
});
test('准备阶段等待延迟启用及短暂遮挡，保持固定检查上限',async()=>{
 const e=new Executor({tabs:{},debugger:{}});let calls=0;
 e.callSemanticWorld=async(_target,_frame,op)=>{calls++;if(calls===1)throw Error('TARGET_DISABLED');if(op==='reveal_ref')return {rect:[0,0,100,30]};return [0,0,100,30];};
 await e.settleSemanticTarget({tabId:1},'main',{},()=>{});assert.ok(calls>=4);
});
test('保护复查失败不覆盖已确认点击，回执只保留固定动作证据',async()=>{
 const e=new Executor({tabs:{},debugger:{}});const settings={enabled:true,rules:{}};e.shieldSettings=async()=>settings;
 let calls=0,dispatches=0;e.shieldInventory=async()=>{if(calls++)throw Error('CONTENT_SHIELD_UNINSPECTABLE');return {document:'doc',tokens:[],writeTarget:null};};
 e.performSettled=async()=>{dispatches++;return {clicked:true,delivery:'confirmed',effect:'observed',privateText:'must disappear'};};
 const result=await e.performProtected({}, {tabId:1,action:'ref_click'});
 assert.equal(result.clicked,true);assert.equal(result.outcomeUnknown,false);assert.equal(result.postCheck.code,'content_shield_uninspectable');assert.equal(result.privateText,undefined);assert.equal(dispatches,1);
});
test('明确 SPA 或整页导航证据可确认已派发点击，不重放工作函数',async()=>{
 for(const method of ['Page.navigatedWithinDocument','Page.frameNavigated']){
  let listener,dispatched=0;const api={debugger:{onEvent:{addListener(fn){listener=fn;},removeListener(){}},sendCommand:async()=>({result:{value:true}})}};
  const result=await observeInputEffect({api,target:{tabId:1},contextId:1,guard(){},work:async mark=>{dispatched++;mark();listener({tabId:1},method,{frame:{id:'main'},frameId:'main',url:'https://fixture.test/next'});throw Error('CONTEXT_GONE');}});
  assert.equal(result.clicked,true);assert.equal(result.navigation.kind,method==='Page.frameNavigated'?'document':'same_document');assert.equal(dispatched,1);
 }
});
test('导航发生在派发前不能确认点击，任意网络请求不确认丢失的点击',async()=>{
 let listener;const api={debugger:{onEvent:{addListener(fn){listener=fn;},removeListener(){}},sendCommand:async()=>({result:{value:true}})}};
 await assert.rejects(observeInputEffect({api,target:{tabId:1},contextId:1,guard(){},work:async()=>{listener({tabId:1},'Page.frameNavigated',{frame:{id:'main',url:'https://fixture.test/next'}});throw Object.assign(Error('TARGET_DISABLED'),{preDispatch:true});}}),/TARGET_DISABLED/);
});

test('有界遮挡等待不会用内部快照淘汰调用方引用',()=>{
 const f=page('<button>Apply</button><aside role="dialog" aria-label="Cookie banner"><button>Close</button></aside>');try{
  f.w.document.elementFromPoint=()=>f.w.document.querySelector('aside');
  for(let i=0;i<12;i++)assert.throws(()=>f.call('reveal_ref',f.token),/TARGET_OCCLUDED/);
  f.w.document.querySelector('aside').remove();f.w.document.elementFromPoint=()=>f.w.document.querySelector('button');
  assert.equal(f.call('confirm_ref',f.token).confirmed,true);
 }finally{f.dom.window.close();}
});

test('结构读取在保护预检遇到导航中的 CDP 上下文时最多重试一次，写入不重放',async()=>{
 for(const action of ['semantic_snapshot','ref_fill']){
  const e=new Executor({tabs:{},debugger:{}});let attempts=0;e.check=()=>{};e.shieldSettings=async()=>({enabled:true,rules:{}});
  e.performProtectedAttempt=async()=>{attempts++;if(attempts===1)throw Error('{"code":-32000,"message":"Execution context was destroyed"}');return {items:[]};};
  if(action==='semantic_snapshot'){assert.deepEqual(await e.performProtected({}, {action}),{items:[]});assert.equal(attempts,2);}
  else{await assert.rejects(e.performProtected({}, {action}),/destroyed/);assert.equal(attempts,1);}
 }
});
test('浏览器已丢弃的页明确拒绝读取，不自动重载或执行调试命令',async()=>{
 let commands=0;const e=new Executor({tabs:{get:async()=>({url:'https://fixture.test',status:'complete',discarded:true})},debugger:{sendCommand:async()=>{commands++;}}});
 e.allowed=()=>{};
 await assert.rejects(e.domReadyTab({}, {tabId:1},()=>{}),/TAB_DISCARDED/);assert.equal(commands,0);
});
test('身份变化的过期引用给出当前候选，绝不点击相似的新目标',()=>{
 const f=page('<button>Apply</button>');try{
  f.w.document.querySelector('button').textContent='Other record';
  assert.throws(()=>f.call('confirm_ref',f.token),error=>/REF_TARGET_MISSING/.test(error.message)&&decodeURIComponent(error.message).includes('Other record'));
 }finally{f.dom.window.close();}
});
test('动作后设置变化仍拒绝页面输出，同时明确点击已确认，旧正文不回放',async()=>{
 const e=new Executor({tabs:{},debugger:{}});let settings={enabled:true,rules:{}};
 e.shieldSettings=async()=>settings;e.shieldInventory=async()=>({document:'doc',tokens:[],writeTarget:null});
 e.performSettled=async()=>{settings={enabled:true,rules:{'https://fixture.test':['#private']}};return {clicked:true,delivery:'confirmed',effect:'observed',privateText:'PRIVATE_CANARY'};};
 const p={tabId:1,action:'ref_click'},result=await e.performProtected({},p);
 assert.equal(result.privateText,undefined);
 await assert.rejects(e.shieldResponse({method:'browser.execute',params:p},result),error=>error.message==='CONTENT_SHIELD_STALE'&&error.actionConfirmed===true);
});
test('创建日志恢复失败与真正没有日志分开报告，均不授予清理权限',async()=>{
 const e=new Executor({tabs:{},debugger:{}});
 assert.equal((await e.cleanupStatus({taskId:'missing',generation:1})).cleanupReason,'no_journal');
 e.workspaces={ready:Promise.reject(Error('PRIVATE_STORAGE_ERROR'))};
 const result=await e.cleanupStatus({taskId:'missing',generation:1});
 assert.equal(result.cleanupState,'unknown');assert.equal(result.cleanupReason,'workspace_unknown');assert.deepEqual(result.remainingTabIds,[]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_STORAGE_ERROR/);
});
