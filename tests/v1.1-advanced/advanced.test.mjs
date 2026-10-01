// 中文注释：任务页面执行离线测试；合成调试会话，不启动浏览器。
import assert from 'node:assert/strict';
import test from 'node:test';
import {PageRuntime,CHUNK_CHARS,EVENT_BUFFER_LIMIT} from '../../native-extension/page-runtime.mjs';
import {cdpMethodAllowed,classifyCdpMethod,scrubCdpEvent,CDP_METHOD_POLICY} from '../../native-extension/cdp-policy.mjs';

function fixture({now=1_000_000}={}){
 const sent=[];let clock=now;
 const task={id:'t1',generation:3,revoked:false,policy:{activeMode:'full'},allowedOrigins:['https://site.test'],tabIds:new Set([7]),agentTabs:new Set([7])};
 const replies={};
 const executor={tasks:new Map([['t1',task]]),leases:new Map([[7,'t1']]),attached:new Set([7]),
  api:{debugger:{sendCommand:async(target,method,params)=>{sent.push({target,method,params});
   if(replies[method])return replies[method](params,target);
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'F1',url:'https://site.test/a'}}};return {};},getTargets:async()=>[{tabId:7,type:'page',targetId:'T7'}]},
   tabs:{get:async()=>({url:'https://site.test/a',title:'A'})}},
  checkedFrameTree:async()=>({frame:{id:'F1',loaderId:'L1',url:'https://site.test/a'}}),
  resolveFrame:async()=>({target:{tabId:7,sessionId:'S-child'},frame:{id:'F2',loaderId:'L2',url:'https://site.test/f'}}),
  allowed(t,url){if(!t.allowedOrigins.includes(new URL(url).origin))throw Error('origin denied');},
  ensureFrameSessions:async()=>({sessions:new Map()})};
 const pushed=[];
 const controller=new PageRuntime(executor,{pushEvents:async batch=>{pushed.push(batch);},now:()=>clock});
 return {task,executor,controller,sent,replies,pushed,advance:ms=>{clock+=ms;}};
}
const guard=()=>{};

test('智能审批授权后的运行资源没有独立期限，撤权和暂停仍会阻断',()=>{
 const f=fixture();
 f.task.policy.activeMode='smart';
 assert.ok(f.controller.assert(f.task,{tabId:7}));
 f.task.policy.activeMode='full';
 const resources=f.controller.assert(f.task,{tabId:7});
 assert.equal(Object.hasOwn(resources,'expiresAt'),false);
 f.advance(24*60*60000);
 assert.equal(f.controller.assert(f.task,{tabId:7}),resources);
 f.task.paused=true;
 assert.throws(()=>f.controller.assert(f.task,{tabId:7}),/task paused/);
 f.task.paused=false;f.task.revoked=true;
 assert.throws(()=>f.controller.assert(f.task,{tabId:7}),/BROWSER_ACCESS_REQUIRED/);
});

test('credential-filled pages and foreign tabs are excluded',()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.task.credentialTabs=new Set([7]);
 assert.throws(()=>f.controller.assert(f.task,{tabId:7}),/CREDENTIAL_MODE_CONFLICT/);
 f.task.credentialTabs=new Set();
 assert.throws(()=>f.controller.assert(f.task,{tabId:9}),/tab lease denied/);
});

test('isolated evaluation returns values and releases handles',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.replies['Page.createIsolatedWorld']=()=>({executionContextId:44});
 f.replies['Runtime.evaluate']=params=>({result:{type:'number',value:params.contextId===44?42:-1}});
 const result=await f.controller.evaluate(f.task,{tabId:7,expression:'40+2'},guard);
 assert.deepEqual(result,{ok:true,world:'isolated',type:'number',value:42});
 assert.ok(f.sent.some(row=>row.method==='Runtime.releaseObjectGroup'));
 const main=await f.controller.evaluate(f.task,{tabId:7,expression:'1',world:'main'},guard);
 assert.equal(main.ok,true,'主上下文复用相同浏览器授权');
});

test('non-serializable, circular and oversize values become bounded descriptions',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.replies['Runtime.evaluate']=()=>({result:{type:'object',subtype:'node',className:'HTMLDivElement',description:'div#x',objectId:'o1'}});
 let result=await f.controller.evaluate(f.task,{tabId:7,expression:'document.body',world:'main'},guard);
 assert.equal(result.serializable,false);assert.equal(result.description,'div#x');assert.equal(result.subtype,'node');
 f.replies['Runtime.evaluate']=()=>({result:{type:'object',className:'Object',description:'Object',objectId:'o2'}});
 f.replies['Runtime.callFunctionOn']=()=>({result:{value:{kind:'error',name:'TypeError'}}});
 result=await f.controller.evaluate(f.task,{tabId:7,expression:'a',world:'main'},guard);
 assert.equal(result.reason,'circular_or_unsupported');
 f.replies['Runtime.callFunctionOn']=()=>({result:{value:{kind:'too_large',size:999999}}});
 result=await f.controller.evaluate(f.task,{tabId:7,expression:'a',world:'main'},guard);
 assert.equal(result.truncated,true);assert.equal(result.size,999999);
 f.replies['Runtime.callFunctionOn']=()=>({result:{value:{kind:'json',text:'{"a":[1,2]}'}}});
 result=await f.controller.evaluate(f.task,{tabId:7,expression:'a',world:'main'},guard);
 assert.deepEqual(result.value,{a:[1,2]});
 f.replies['Runtime.evaluate']=()=>({result:{type:'undefined'},exceptionDetails:{text:'Uncaught',exception:{description:'Error: boom\n at x'}}});
 result=await f.controller.evaluate(f.task,{tabId:7,expression:'throw 1',world:'main'},guard);
 assert.equal(result.ok,false);assert.equal(result.exception.text,'Error: boom');
});

test('JavaScript syntax and runtime errors carry stable codes and bounded first line',async()=>{
 // 中文注释：语法错误在执行前确定，运行时异常按已执行表达式保留副作用未知。
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.replies['Runtime.evaluate']=()=>({exceptionDetails:{text:'Uncaught',exception:{className:'SyntaxError',description:'SyntaxError: Unexpected token *\n at private'}}});
 let result=await f.controller.evaluate(f.task,{tabId:7,expression:'1 +* 1',world:'main'},guard);
 assert.equal(result.code,'js_syntax_error');assert.equal(result.outcomeUnknown,false);
 f.replies['Runtime.evaluate']=()=>({exceptionDetails:{text:'Uncaught',exception:{className:'TypeError',description:'TypeError: Cannot read properties of null\n at private'}}});
 result=await f.controller.evaluate(f.task,{tabId:7,expression:'document.querySelector("#nope").textContent',world:'main'},guard);
 assert.equal(result.code,'js_exception');assert.equal(result.outcomeUnknown,true);
 assert.equal(result.exception.type,'TypeError');assert.ok(result.exception.text.length<=200);
});

test('document replacement during evaluation is reported as unknown outcome',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 let calls=0;f.executor.checkedFrameTree=async()=>({frame:{id:'F1',loaderId:calls++?'L-new':'L1',url:'https://site.test/a'}});
 f.replies['Runtime.evaluate']=()=>({result:{type:'number',value:1}});
 await assert.rejects(f.controller.evaluate(f.task,{tabId:7,expression:'location.reload()',world:'main'},guard),
  error=>error.message==='DOCUMENT_CHANGED'&&error.outcomeUnknown===true);
});

test('有效 CDP 方法只由两档模式控制，任务来源仍限制导航',async()=>{
 for(const method of ['Network.getCookies','Storage.getCookies','Fetch.enable','Network.setRequestInterception','Browser.grantPermissions',
  'Browser.close','Target.createTarget','Debugger.enable','Page.setDownloadBehavior','Tracing.start'])
  assert.equal(cdpMethodAllowed(method).allowed,true,method);
 for(const method of ['Runtime.evaluate','DOM.getDocument','Input.dispatchMouseEvent','Page.captureScreenshot','Accessibility.getFullAXTree','Network.enable'])
  assert.equal(cdpMethodAllowed(method).allowed,true,method);
 assert.equal(classifyCdpMethod('Debugger.enable'),'unlisted');
 assert.equal(cdpMethodAllowed('DOM.setFileInputFiles').allowed,true);
 assert.equal(cdpMethodAllowed('DOM.setFileInputFiles',{gateway:true}).allowed,true);
 assert.ok(Object.keys(CDP_METHOD_POLICY).length>100);
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 await f.controller.send(f.task,{tabId:7,method:'Network.getAllCookies'},guard);
 await f.controller.send(f.task,{tabId:7,method:'DOM.setFileInputFiles',params:{files:['/etc/hosts']}},guard,{gateway:true});
 assert.ok(f.sent.some(row=>row.method==='Network.getAllCookies'));
 assert.ok(f.sent.some(row=>row.method==='DOM.setFileInputFiles'));
 await assert.rejects(f.controller.send(f.task,{tabId:7,method:'Page.navigate',params:{url:'https://evil.test/'}},guard),/origin denied/);
 assert.equal(f.sent.filter(row=>row.method==='Page.navigate').length,0);
 await f.controller.send(f.task,{tabId:7,method:'Page.navigate',params:{url:'https://site.test/b'}},guard);
 assert.equal(f.sent.filter(row=>row.method==='Page.navigate').length,1);
});

test('原始目标列表可返回调试器数据，显式 target_id 仍须属于任务标签',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 const scope={tabId:7};
 // 中文注释：原始目标列表由浏览器返回，显式转发目标仍核对任务租约。
 f.replies['Target.getTargets']=()=>({targetInfos:[{targetId:'T7',url:'https://site.test/a'}]});
 const listed=await f.controller.send(f.task,{...scope,method:'Target.getTargets',params:{}},guard);
 assert.deepEqual(listed.targetInfos.map(row=>row.targetId),['T7']);
 assert.equal(listed.targetInfos[0].url,'https://site.test/a');
 await f.controller.send(f.task,{...scope,method:'DOM.getDocument',targetId:'T7'},guard);
 assert.ok(f.sent.some(row=>row.method==='DOM.getDocument'&&row.target.tabId===7));
 await assert.rejects(f.controller.send(f.task,{...scope,method:'DOM.getDocument',targetId:'foreign'},guard),
  /TARGET_NOT_OWNED/);
 assert.equal(f.sent.filter(row=>row.method==='DOM.getDocument').length,1);
});

test('custom CDP timeout reports unknown outcome without a second dispatch',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.replies['DOM.getDocument']=()=>new Promise(()=>{});
 // 中文注释：超时后的协议命令可能仍在浏览器执行，调用方必须先核实页面，不能自动重发。
 await assert.rejects(f.controller.send(f.task,{tabId:7,
  method:'DOM.getDocument',timeoutMs:100},guard),
  error=>error.message==='CDP_TIMEOUT'&&error.outcomeUnknown===true);
 assert.equal(f.sent.filter(row=>row.method==='DOM.getDocument').length,1);
});

test('large results are chunked and chunks expire after the last read',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 const big='x'.repeat(CHUNK_CHARS*2+10);
 f.replies['Page.captureScreenshot']=()=>({data:big});
 const result=await f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard,{gateway:true});
 const meta=result.__hermesChunked;assert.equal(meta.count,3);
 const text=[0,1,2].map(index=>f.controller.chunk({id:meta.id,index,taskId:f.task.id,generation:f.task.generation},f.task).data).join('');
 assert.equal(JSON.parse(text).data,big);
 assert.throws(()=>f.controller.chunk({id:meta.id,index:0,taskId:f.task.id,generation:f.task.generation},f.task),/CHUNK_UNAVAILABLE/);
});

test('events are scrubbed, filtered to subscriptions and bounded',async()=>{
 const scrubbed=scrubCdpEvent('Network.requestWillBeSent',{request:{url:'u',headers:{Cookie:'a=b',Authorization:'x',Accept:'*/*'}}});
 assert.deepEqual(scrubbed.request.headers,{Accept:'*/*'});
 assert.deepEqual(scrubCdpEvent('Network.requestWillBeSentExtraInfo',{headers:{Cookie:'a=b',Accept:'*/*'}}),{headers:{Accept:'*/*'}});
 assert.deepEqual(scrubCdpEvent('Network.responseReceivedExtraInfo',{headers:{'Set-Cookie':'a=b','Proxy-Authorization':'Bearer secret',Server:'fixture'},blockedCookies:[{cookieLine:'a=b'}]}),{headers:{Server:'fixture'}});
 // 中文注释：额外来源的网络事件保留，但整段原始头文本和正文中的 Bearer 令牌必须剥离。
 assert.deepEqual(scrubCdpEvent('Network.responseReceivedExtraInfo',{headersText:'Set-Cookie: a=b',headers:{Server:'fixture'},statusCode:200}),{headers:{Server:'fixture'},statusCode:200});
 assert.deepEqual(scrubCdpEvent('Runtime.consoleAPICalled',{text:'Bearer synthetic-token'}),{text:'Bearer [redacted]'});
 assert.equal(scrubCdpEvent('Runtime.executionContextCreated',{context:{name:'hermes-automation-overlay'}}),null);
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.controller.observe({tabId:7},'Page.loadEventFired',{});
 assert.equal(f.task.execution.buffers.size,0,'no subscription, no buffering');
 f.controller.subscribe(f.task,7,null,'buffer');
 for(let i=0;i<EVENT_BUFFER_LIMIT+5;i++)f.controller.observe({tabId:7},'Page.loadEventFired',{i});
 f.controller.observe({tabId:8},'Page.loadEventFired',{});
 const drained=f.controller.drain(f.task,{tabId:7},EVENT_BUFFER_LIMIT);
 assert.equal(drained.events.length,EVENT_BUFFER_LIMIT);assert.equal(drained.dropped,5);
 f.controller.subscribe(f.task,7,'S1','push');
 f.controller.observe({tabId:7,sessionId:'S1'},'Runtime.consoleAPICalled',{type:'log'});
 await f.controller.flush();
 assert.equal(f.pushed[0].events[0].childSessionId,'S1');
});

// 中文注释：持久脚本在任务结束时按登记的标识移除。
test('持久脚本可执行且任务结束后移除',async()=>{
 const f=fixture();
 f.replies['Page.addScriptToEvaluateOnNewDocument']=()=>({identifier:'script-1'});
 await f.controller.send(f.task,{tabId:7,method:'Page.addScriptToEvaluateOnNewDocument',params:{source:'globalThis.mark=1'}},guard);
 await f.controller.clear(f.task);assert.equal(f.task.execution,null);
 assert.ok(f.sent.some(row=>row.method==='Page.removeScriptToEvaluateOnNewDocument'&&row.params.identifier==='script-1'));
});

test('raw CDP input opens a short overlay pass-through window before dispatch; other methods keep the overlay blocking',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 const order=[];const entry={contextId:1};f.task.overlays=new Map([[7,entry]]);
 f.executor.overlayCall=async(tabId,current,op,extra)=>{order.push({tabId,op,update:extra.update});return true;};
 const base=f.executor.api.debugger.sendCommand;f.executor.api.debugger.sendCommand=async(target,method,params)=>{if(method!=='Page.getFrameTree')order.push({method});return base(target,method,params);};
 await f.controller.send(f.task,{tabId:7,method:'DOM.getDocument',params:{}},guard);
 assert.deepEqual(order.map(row=>row.op||row.method),['DOM.getDocument']);
 order.length=0;
 await f.controller.send(f.task,{tabId:7,method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:1,y:1,button:'left'}},guard);
 await f.controller.send(f.task,{tabId:7,method:'Input.dispatchMouseEvent',params:{type:'mouseReleased',x:1,y:1,button:'left'}},guard);
 assert.deepEqual(order.map(row=>row.op||row.method),['update','Input.dispatchMouseEvent','reblock','update','Input.dispatchMouseEvent','reblock']);
 assert.deepEqual(order[0].update,{state:'running',step:'cdp.input',holdMs:5000});
 assert.deepEqual(order[3].update,{state:'running',step:'cdp.input',holdMs:600});
});

test('旧文档重建遮罩后派发输入，无法确认遮罩时拒绝派发',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 const fresh={contextId:2},calls=[];f.task.overlays=new Map([[7,{contextId:1}]]);
 f.executor.overlayCall=async(tabId,entry)=>{calls.push(entry.contextId);if(entry.contextId===1)throw Error('Cannot find context');return true;};
 f.executor.restoreOverlay=async()=>{f.task.overlays.set(7,fresh);return fresh;};
 await f.controller.send(f.task,{tabId:7,method:'Input.dispatchKeyEvent',params:{type:'keyDown',key:'a'}},guard,{gateway:true});
 assert.deepEqual(calls,[1,2,2]);
 f.executor.overlayCall=async()=>{throw Error('gone');};f.executor.restoreOverlay=async()=>null;
 await assert.rejects(f.controller.send(f.task,{tabId:7,method:'Input.insertText',params:{text:'x'}},guard,{gateway:true}),/INTERACTION_HIGHLIGHT_UNAVAILABLE/);
 assert.equal(f.sent.some(row=>row.method==='Input.insertText'),false);
});

test('gateway refuses current or pending foreign origin before any page command',async()=>{
 for(const tab of [{url:'https://outside.test/'},{url:'https://site.test/',pendingUrl:'https://outside.test/'}]){
  const f=fixture();f.executor.api.tabs.get=async()=>tab;
  await assert.rejects(f.controller.send(f.task,{tabId:7,method:'Runtime.evaluate',params:{expression:'document.body.innerText'}},guard,{gateway:true}),error=>error.message==='TAB_OUT_OF_SCOPE'&&error.preDispatch);
  assert.equal(f.sent.length,0);
 }
});

test('子会话可读取第三方框架，顶层离站后仍丢弃结果',async()=>{
 const f=fixture();f.replies['Page.getFrameTree']=()=>({frameTree:{frame:{url:'https://outside.test/frame'}}});
 await f.controller.send(f.task,{tabId:7,childSessionId:'child',method:'Runtime.evaluate',params:{expression:'1'}},guard,{gateway:true});
 assert.ok(f.sent.some(row=>row.method==='Runtime.evaluate'));
 f.replies['Page.getFrameTree']=()=>({frameTree:{frame:{url:'https://site.test/frame'}}});
 await f.controller.send(f.task,{tabId:7,childSessionId:'child',method:'Runtime.evaluate',params:{expression:'1'}},guard,{gateway:true});
 assert.equal(f.sent.find(row=>row.method==='Runtime.evaluate').target.sessionId,'child');
 // 中文注释：派发后发生跳转时必须保留未知结果语义，不能返回外站内容或声称未派发。
 const later=fixture();later.replies['Runtime.evaluate']=()=>{later.executor.api.tabs.get=async()=>({url:'https://outside.test/'});return {result:{value:'untrusted'}};};
 await assert.rejects(later.controller.send(later.task,{tabId:7,method:'Runtime.evaluate',params:{}},guard,{gateway:true}),error=>error.message==='TAB_OUT_OF_SCOPE'&&error.preDispatch===false&&error.outcomeUnknown===true);
});

// 中文注释：输入派发的收尾不依赖下一条 CDP 请求或页面计时器。
for(const outcome of ['成功','抛错','超时','导航中断','授权撤销'])test(`原始输入${outcome}后立即收回遮罩放行`,async()=>{
 const f=fixture(),ops=[];f.task.overlays=new Map([[7,{contextId:1}]]);
 f.executor.overlayCall=async(_tab,_entry,op)=>{ops.push(op);return true;};
 f.replies['Input.insertText']=async()=>{
  if(outcome==='超时')return new Promise(()=>{});
  if(outcome==='抛错'||outcome==='导航中断')throw Error(outcome);
  if(outcome==='授权撤销')f.task.revoked=true;
  return {};
 };
 await f.controller.send(f.task,{tabId:7,method:'Input.insertText',params:{text:'内容'},timeoutMs:100},()=>{if(f.task.revoked)throw Error('已撤销');},{gateway:true}).catch(()=>{});
 assert.equal(ops.at(-1),'reblock');
});

// 中文注释：知道分块 ID 不能跨任务读取，过期与撤权也必须回收缓存。
test('大结果分块绑定任务、授权代次且过期后不可读取',async()=>{
 const f=fixture(),result=await f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard);
 assert.deepEqual(result,{});
 f.replies['Page.captureScreenshot']=()=>({data:'x'.repeat(CHUNK_CHARS+1)});
 const value=await f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard),id=value.__hermesChunked.id;
 const foreign={...f.task,id:'other'};
 assert.throws(()=>f.controller.chunk({id,index:0,taskId:foreign.id,generation:foreign.generation},foreign),/CHUNK_UNAVAILABLE/);
 assert.throws(()=>f.controller.chunk({id,index:0,taskId:f.task.id,generation:99},f.task),/CHUNK_UNAVAILABLE/);
 f.advance(60001);
 assert.throws(()=>f.controller.chunk({id,index:0,taskId:f.task.id,generation:f.task.generation},f.task),/CHUNK_UNAVAILABLE/);
 const next=await f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard);
 f.controller.clear(f.task);assert.equal(f.controller.chunks.size,0);
 assert.throws(()=>f.controller.chunk({id:next.__hermesChunked.id,index:0},f.task),/CHUNK_UNAVAILABLE/);
});
test('分块缓存总量有上限，不能通过反复大结果无限增长',async()=>{
 const f=fixture();f.replies['Page.captureScreenshot']=()=>({data:'x'.repeat(CHUNK_CHARS*8)});
 for(let i=0;i<7;i++)await f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard);
 await assert.rejects(f.controller.send(f.task,{tabId:7,method:'Page.captureScreenshot'},guard),/CHUNK_CAPACITY/);
 assert.ok([...f.controller.chunks.values()].reduce((n,row)=>n+row.parts.length,0)<=64);
});

// 中文注释：原始 CDP 在顶层任务页内可调试其他来源的子框架。
for(const method of ['Runtime.evaluate','DOM.getDocument','Page.createIsolatedWorld'])test(`原始 ${method} 允许包含其他来源子框架的目标`,async()=>{
 const f=fixture();
 f.replies['Page.getFrameTree']=()=>({frameTree:{frame:{id:'main',url:'https://site.test'},childFrames:[{frame:{id:'foreign',url:'https://private.test'}}]}});
 await f.controller.send(f.task,{tabId:7,method,params:method==='Page.createIsolatedWorld'?{frameId:'foreign'}:method==='Runtime.evaluate'?{expression:'document.body.innerText',contextId:99}:{}},guard);
 assert.equal(f.sent.filter(row=>row.method===method).length,1);
});
test('子框架离站后原始 CDP 仍返回结果，顶层离站则丢弃',async()=>{
 const f=fixture();let changed=false;
 f.replies['Page.getFrameTree']=()=>({frameTree:{frame:{id:'main',url:'https://site.test'},childFrames:[{frame:{id:'child',url:changed?'https://outside.test':'https://site.test/child'}}]}});
 await f.controller.send(f.task,{tabId:7,method:'DOM.getDocument'},guard);
 assert.equal(f.sent.filter(row=>row.method==='DOM.getDocument').length,1);
 f.replies['Runtime.evaluate']=()=>{changed=true;return {result:{value:'不应返回'}};};
 assert.deepEqual(await f.controller.send(f.task,{tabId:7,method:'Runtime.evaluate',params:{expression:'1'}},guard),{result:{value:'不应返回'}});
});

// 中文注释：同页 Python 事件等待和网关推送必须并存，不能因 helper 调用或网关离开互相覆盖。
test('buffer helpers and gateway subscriptions receive events independently',async()=>{
 const f=fixture();f.controller.assert(f.task,{tabId:7});
 f.controller.subscribe(f.task,7,null,'push');
 await f.controller.send(f.task,{tabId:7,method:'Network.enable'},guard);
 f.controller.observe({tabId:7},'Page.loadEventFired',{timestamp:1});
 await f.controller.flush();
 assert.equal(f.pushed[0]?.events.length,1,'helper 调用不能覆盖网关推送');
 assert.equal(f.controller.drain(f.task,{tabId:7}).events.length,1);
 f.controller.unsubscribe(f.task,7,null);
 f.controller.observe({tabId:7},'Page.loadEventFired',{timestamp:2});
 await f.controller.flush();
 assert.equal(f.pushed.length,1);
 assert.equal(f.controller.drain(f.task,{tabId:7}).events.length,1,'网关离开不能清空 helper 订阅');
});

// 中文注释：结果 JSON 化会运行页面 toJSON，必须计入调用期限，否则页面锁可能永久占用。
test('evaluation deadline also covers serialization of the returned object',async()=>{
 const f=fixture();
 f.replies['Runtime.evaluate']=()=>({result:{type:'object',className:'Object',objectId:'result-object'}});
 f.replies['Runtime.callFunctionOn']=()=>new Promise(()=>{});
 let timer;
 try{
  await assert.rejects(Promise.race([
   f.controller.evaluate(f.task,{tabId:7,expression:'({toJSON(){while(true){}}})',world:'main',timeoutMs:100},guard),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test deadline exceeded')),1500);}),
  ]),error=>error.message==='JS_TIMEOUT'&&error.outcomeUnknown===true);
  assert.equal(f.sent.filter(row=>row.method==='Runtime.evaluate').length,1);
  assert.ok(f.sent.some(row=>row.method==='Runtime.terminateExecution'));
  assert.ok(f.sent.some(row=>row.method==='Runtime.releaseObjectGroup'));
 }finally{clearTimeout(timer);}
});
// 中文注释：已派发 CDP 的结果缓存超限不能误报未派发，桥接层必须保留结果未知标记。
test('CDP chunk capacity failure preserves dispatched outcome in bridge error',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');
 const f=fixture();
 f.controller.chunks.set('full',{parts:new Array(64).fill(''),at:1_000_000,task:f.task});
 f.replies['Runtime.evaluate']=()=>({result:{type:'string',value:'x'.repeat(CHUNK_CHARS)}});
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage(){}},{execute:p=>f.controller.send(f.task,p,guard)});
 const reply=await bridge.executeRequest({id:'one',method:'browser.execute',params:{action:'cdp.send',tabId:7,method:'Runtime.evaluate',params:{expression:'sideEffect()'}}});
 assert.equal(reply.error.data.outcomeUnknown,true);
 assert.equal(reply.error.data.retryable,false);
 assert.equal(f.sent.filter(row=>row.method==='Runtime.evaluate').length,1);
});

// 中文注释：凭据控制器和页面运行时共用同一任务对象，验证两个调用顺序均不能跨过互斥标记。
for(const first of ['script','credential'])test(`vault and page runtime exclude each other when ${first} runs first`,async()=>{
 const {VaultController}=await import('../../native-extension/vault.mjs');
 const f=fixture();f.task.instanceId='browser';f.task.policy.modeGeneration=1;
 f.executor.check=()=>{};f.executor.lock=async(_tab,work)=>work();f.executor.docs=new Map();
 f.executor.ensureOverlay=async()=>({contextId:42});
 f.replies['Runtime.callFunctionOn']=()=>({result:{value:{filled:1}}});
 f.replies['Runtime.evaluate']=()=>({result:{type:'number',value:1}});
 const vault=new VaultController(f.executor);
 const payload={taskId:f.task.id,generation:f.task.generation,instanceId:'browser',modeGeneration:1,tabId:7,nonce:'a'.repeat(32),kind:'login',documentGeneration:0,expectedOrigin:'https://site.test',fills:[{index:0,token:'current-password',value:'SYNTHETIC-FIXTURE'}]};
 if(first==='script'){
  await f.controller.evaluate(f.task,{tabId:7,world:'main',expression:'1'},guard);
  const before=f.sent.length;
  await assert.rejects(vault.fill(payload),/CREDENTIAL_MODE_CONFLICT/);
  assert.equal(f.sent.length,before,'凭据拒绝发生在派发前');
 }else{
  assert.equal((await vault.fill(payload)).filled,1);
  const before=f.sent.length;
  await assert.rejects(f.controller.send(f.task,{tabId:7,method:'Runtime.evaluate',params:{expression:'1'}},guard),/CREDENTIAL_MODE_CONFLICT/);
  assert.equal(f.sent.length,before,'脚本拒绝发生在派发前');
 }
});

// 中文注释：函数表达式求值本身可以有副作用，类型不是函数也不能报告为未派发。
test('non-function result after evaluating a callable expression remains uncertain',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');
 const f=fixture();f.replies['Runtime.evaluate']=()=>({result:{type:'number',value:1}});
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage(){}},{execute:p=>f.controller.evaluate(f.task,p,guard)});
 const reply=await bridge.executeRequest({id:'one',method:'browser.execute',params:{action:'js.evaluate',tabId:7,world:'main',expression:'(sideEffect(),1)',arguments:{}}});
 assert.equal(reply.error.data.outcomeUnknown,true);
 assert.equal(reply.error.data.retryable,false);
 assert.equal(f.sent.filter(row=>row.method==='Runtime.evaluate').length,1);
 assert.ok(f.sent.some(row=>row.method==='Runtime.releaseObjectGroup'));
});
