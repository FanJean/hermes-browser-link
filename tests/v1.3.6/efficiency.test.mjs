import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {groupTitle} from '../../native-extension/workspace-adapter.mjs';
import {Executor,pageAction,classifySensitiveField} from '../../native-extension/core.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('同任务新页不占用整个加载等待屏障',async()=>{
 // 中文注释：两次建页同时进入执行器；任务级清理写者仍等待两次读者完成。
 const executor=new Executor({tabs:{},debugger:{}}),gate=deferred(),entered=[];
 const task={id:'t',generation:1,allowedOrigins:['https://site.test'],policy:{modeGeneration:1},overlays:new Map()};
 executor.tasks.set('t',task);
 executor.perform=async(_task,p)=>{entered.push(p.requestId);await gate.promise;return {tabId:entered.length};};
 const run=id=>executor.executeAction({taskId:'t',generation:1,allowedOrigins:task.allowedOrigins,action:'new_tab',url:'https://site.test/',requestId:id});
 const first=run('one'),second=run('two');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(entered,['one','two']);
 gate.resolve();await Promise.all([first,second]);
});

test('加载中内容稳定半秒后返回 partial',async()=>{
 // 中文注释：模拟正文已解析、阻塞脚本尚未结束的页面，不等待完整加载期限。
 const api={tabs:{get:async()=>({id:7,url:'https://site.test/slow',status:'loading'})},debugger:{
  attach:async()=>{},sendCommand:async(_target,method)=>{
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://site.test/slow',loaderId:'doc'}}};
   if(method==='Page.createIsolatedWorld')return {executionContextId:1};
   return {result:{value:{ready:'loading',title:'慢页',heading:true,textLength:150,elementCount:4}}};
  },
 }};
 const executor=new Executor(api),task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test']};
 executor.tasks.set('t',task);executor.leases.set(7,'t');
 const started=performance.now();
 const result=await executor.settledTab(7,()=>{},null,8000,task,'https://site.test/slow');
 assert.equal(result.ready,'partial');
 assert.ok(performance.now()-started<3500);
});

test('四个慢页建页等待并行完成',async()=>{
 // 中文注释：工作区只串行登记新页；每页 1.2 秒加载在各自标签锁中同时等待。
 let next=0;
 const api={tabs:{get:async id=>({id,url:`https://site.test/slow/${id}`,windowId:1,groupId:2,status:'loading'})},debugger:{}};
 const executor=new Executor(api),task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test'],
  tabIds:new Set(),agentTabs:new Set(),workspaceCapability:{},title:'任务'};
 executor.tasks.set('t',task);
 executor.workspaces={open:async()=>({tabId:++next,groupId:2}),authority:{resolve:()=>({windowId:1})}};
 executor.settledTab=async(_id,_guard,tab)=>{await new Promise(resolve=>setTimeout(resolve,1200));return {tab,ready:'interactive'};};
 executor.restoreOverlay=async()=>{};
 const started=performance.now();
 const opened=await Promise.all([1,2,3,4].map(page=>executor.openOwnedTab(task,
  {action:'new_tab',requestId:`page-${page}`},()=>{},`https://site.test/slow/${page}`)));
 assert.equal(opened.length,4);
 assert.ok(performance.now()-started<2500);
});

test('第五页只回收最旧模型页，保留用户页',async()=>{
 // 中文注释：回收对象只从 agentTabs 中选；用户原有租约页不参与。
 const removed=[];const api={tabs:{get:async id=>({id,url:'https://site.test/',windowId:1,groupId:2,status:'complete'}),
  remove:async id=>{removed.push(id);}},tabGroups:{get:async()=>({windowId:1,title:groupTitle('任务')})},debugger:{}};
 const executor=new Executor(api),task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test'],
  tabIds:new Set([99,1,2,3,4]),agentTabs:new Set([1,2,3,4]),agentTabGroups:new Map([1,2,3,4].map(id=>[id,2])),workspaceCapability:{},title:'任务',
  policy:{modeGeneration:1,activeMode:'full'},overlays:new Map()};
 executor.tasks.set('t',task);
 for(const id of task.tabIds)executor.leases.set(id,'t');
 executor.performSettled=async()=>({ok:true});
 // 中文注释：刚用过的第一页移到最近使用位置，第五页应回收第二页。
 await executor.executeAction({taskId:'t',generation:1,allowedOrigins:task.allowedOrigins,action:'snapshot',tabId:1});
 executor.workspaces={open:async()=>({tabId:5,groupId:2}),authority:{resolve:()=>({windowId:1})}};
 executor.settledTab=async(_id,_guard,tab)=>({tab,ready:'complete'});
 executor.restoreOverlay=async()=>{};
 executor.tabEvent=async id=>{task.agentTabs.delete(id);task.tabIds.delete(id);executor.leases.delete(id);};
 const receipt=await executor.openOwnedTab(task,{action:'new_tab',requestId:'n'},()=>{},'https://site.test/');
 assert.deepEqual(receipt.closedTabs,[2]);assert.deepEqual(removed,[2]);
 assert.ok(task.tabIds.has(99));assert.equal(task.agentTabs.size,4);
});

test('选择器点击与填写滚动到中部后才派发',()=>{
 // 中文注释：真实 DOM 目标先在视口外；滚动后命中测试通过才允许点击与填写。
 const dom=new JSDOM('<button id="next">下一页</button><input id="name">',{url:'https://site.test/',runScripts:'outside-only'});
 try{
  const {window}=dom,document=window.document;window.classifySensitiveField=classifySensitiveField;
  Object.defineProperty(window,'innerHeight',{configurable:true,value:600});
  window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:30}];
  document.elementFromPoint=()=>document.querySelector('#next');
  const blocks=[];let top=700;
  const button=document.querySelector('#next');button.getBoundingClientRect=()=>({left:20,top,width:100,height:30});
  button.scrollIntoView=options=>{blocks.push(options.block);top=250;};
  let clicked=0;button.addEventListener('click',()=>clicked++);
  const action=window.eval(`(${pageAction.toString()})`);
  action('click','#next',null,null,['https://site.test']);
  assert.equal(clicked,1);assert.deepEqual(blocks,['center']);
  const field=document.querySelector('#name');field.getBoundingClientRect=()=>({left:250,top:700,width:100,height:30});
  field.scrollIntoView=options=>{blocks.push(options.block);field.getBoundingClientRect=()=>({left:250,top:250,width:100,height:30});};
  document.elementFromPoint=()=>field;
  action('fill','#name','已填',null,['https://site.test']);
  assert.equal(field.value,'已填');assert.deepEqual(blocks,['center','center']);
 }finally{dom.window.close();}
});

test('新页主框架仍是 about:blank 时不关闭就绪探测',async()=>{
 // 中文注释：新建标签页提交导航前主框架是空白页；来源检查失败只能跳过本轮探测，不能退回等待全部资源加载完。
 let frames=0;
 const api={tabs:{get:async()=>({id:7,url:'https://site.test/app',status:'loading'})},debugger:{
  attach:async()=>{},sendCommand:async(_target,method)=>{
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:++frames<=2?'about:blank':'https://site.test/app',loaderId:'doc'}}};
   if(method==='Page.createIsolatedWorld')return {executionContextId:1};
   return {result:{value:{ready:'interactive',title:'应用',heading:true,textLength:10,elementCount:4}}};
  },
 }};
 const executor=new Executor(api),task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test']};
 executor.tasks.set('t',task);executor.leases.set(7,'t');
 const started=performance.now();
 const result=await executor.settledTab(7,()=>{},null,3000,task,'https://site.test/app');
 assert.equal(result.ready,'interactive');
 assert.ok(performance.now()-started<1500);
});

test('工作页跳到第三方登录页只提醒一次，普通外站不提醒',async()=>{
 // 中文注释：登录页上没有遮罩，需单独提醒用户亲自登录；同一次离站不重复提醒。
 const signIns=[],events=[];
 const executor=new Executor({tabs:{},debugger:{}},event=>events.push(event),{onSignInRedirect:row=>signIns.push(row)});
 const task={id:'t',generation:1,revoked:false,allowedOrigins:['https://site.test'],approvedOrigins:new Set(),tabIds:new Set([7,8])};
 executor.tasks.set('t',task);executor.leases.set(7,'t');executor.leases.set(8,'t');
 executor.closeTabResources=async()=>{};
 await executor.tabEvent(7,'navigated','https://accounts.google.com/o/oauth2/auth?x=1');
 await executor.tabEvent(7,'navigated','https://accounts.google.com/signin/select');
 await executor.tabEvent(8,'navigated','https://other.test/');
 assert.deepEqual(signIns,[{taskId:'t',tabId:7}]);
 assert.equal(events.filter(event=>event.outOfScope).length,2);
 assert.ok(events.every(event=>!('url' in event)));
});
