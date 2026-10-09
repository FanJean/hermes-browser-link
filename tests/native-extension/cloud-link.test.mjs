import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudLink} from '../../native-extension/cloud-link.mjs';
import {BrowserConsent} from '../../native-extension/bridge.mjs';

test('云端绑定仅明确 active 在线授权可用，未知和 connecting 不能沿用旧 full',async()=>{
 for(const state of ['unknown','error','connecting','offline','pending_pairing','unavailable']){
  const calls=[],task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'full'};
  const link=new CloudLink({}, {localBridge:()=>({request:async method=>{calls.push(method);return [task];}}),executor:{},consent:{synchronize:async()=>{}},changed:()=>{}});
  link.instanceId='browser';link.state={paired:true,fullAccess:true,online:true,state};
  await assert.rejects(link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'}));
  assert.deepEqual(calls,[]);assert.equal(link.modeForTask(task),null);
 }
});

test('云端状态跨每个 await 失效，恢复 active 不能接受旧绑定回执',async()=>{
 for(const seam of ['first-list','consent','second-list','mode']){
  let task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'smart',modeGeneration:2};
  let release,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});const modes=[],grants=[],revoked=[];let lists=0;
  async function pause(at){if(at===seam){enteredResolve();await gate;}}
  const bridge={request:async(method,params)=>{
   if(method==='extension.tasks'){await pause(++lists===1?'first-list':'second-list');return [task];}
   assert.equal(method,'extension.mode');modes.push(params);await pause('mode');
   task={...task,activeMode:'full',modeGeneration:3};return task;
  }};
  const link=new CloudLink({}, {localBridge:()=>bridge,executor:{setMode:t=>grants.push(t.id),revokeMode:id=>revoked.push(id)},consent:{synchronize:()=>pause('consent')},changed:()=>{}});
  link.instanceId='browser';link.state={paired:true,fullAccess:true,online:true,state:'active'};
  const binding=link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'});
  const rejected=assert.rejects(binding);await entered;
  await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',paired:true,fullAccess:false,online:false,state:'offline'}});
  assert.equal(link.modeForTask(task),null);
  await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',paired:true,fullAccess:true,online:true,state:'active'}});
  release();await rejected;
  assert.deepEqual(grants,[]);assert.equal(link.modeForTask(task),null);
  assert.equal(modes.length,seam==='mode'?1:0);
 }
});

test('云端端口断开撤销已绑定权限，旧端口消息不能复活授权',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const ports=[],revoked=[];
 const chrome={runtime:{connectNative:()=>{
  const port={onMessage:{addListener:fn=>{port.receive=fn;}},onDisconnect:{addListener:fn=>{port.drop=fn;}},
   postMessage:message=>{if(message.method==='hello')queueMicrotask(()=>port.receive({id:message.id,result:{instanceId:'browser',state:'active',paired:true,fullAccess:true,online:true}}));},disconnect:()=>port.drop()};
  ports.push(port);return port;
 }}};
 const task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'full'};
 const link=new CloudLink(chrome,{localBridge:()=>({request:async()=>[task]}),executor:{revokeMode:id=>revoked.push(id)},consent:{synchronize:async()=>{}},changed:()=>{}});
 await link.connect('browser','Chrome');await link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'});
 assert.equal(link.modeForTask(task),'full');ports[0].drop();assert.equal(link.modeForTask(task),null);assert.deepEqual(revoked,['cloud']);
 t.mock.timers.tick(1500);await link.connecting;
 ports[0].receive({method:'cloud.status_changed',params:{instanceId:'browser',state:'unknown',paired:true,fullAccess:true,online:true}});
 assert.equal(link.view().state,'active');assert.equal(link.modeForTask(task),null);
});

test('延迟 status 回执不能覆盖较新的 Native fence 代次',async()=>{
 const link=new CloudLink({}, {localBridge:()=>null,executor:{},consent:{},changed:()=>{}});
 link.instanceId='browser';link.port={};
 await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',state:'active',online:true,paired:true,fullAccess:true,authorizationGeneration:4}});
 let resolve;link.request=()=>new Promise(done=>{resolve=done;});const refresh=link.refresh();
 await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',state:'offline',online:false,paired:true,fullAccess:false,authorizationGeneration:5}});
 resolve({instanceId:'browser',state:'active',online:true,paired:true,fullAccess:true,authorizationGeneration:4});await refresh;
 assert.equal(link.view().state,'offline');assert.equal(link.view().fullAccess,false);
});

test('真实 BrowserConsent 在云端审批 await 中撤权不能晚授 full 或审批本地任务',async()=>{
 const cloud={id:'cloud',generation:1,instanceId:'browser',state:'pending_approval',allowedOrigins:['https://example.com'],modeGeneration:1};
 const local={...cloud,id:'local'};let release,enter;const entered=new Promise(resolve=>{enter=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});const approvals=[],grants=[];
 const executor={tasks:new Map([['cloud',{...cloud}],['local',{...local}]]),
  revokeMode:id=>{executor.tasks.get(id).revoked=true;},setMode:task=>grants.push(task.id),release:async()=>{}};
 const bridge={closed:false,request:async(method,params)=>{
  if(method==='extension.tasks')return [cloud,local];
  if(method==='extension.approve'){approvals.push(params.taskId);enter();await gate;return {...cloud,state:'ready'};}
  if(method==='extension.mode')return {...cloud,state:'ready',activeMode:'full'};
  if(method==='extension.stop')return {};
  assert.fail(method);
 }};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor,consent:new BrowserConsent({},executor),changed:()=>{}});
 link.instanceId='browser';link.state={state:'active',online:true,paired:true,fullAccess:true};
 const binding=link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'}),rejected=assert.rejects(binding);
 await entered;
 await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',state:'offline',online:false,paired:true,fullAccess:false}});
 await link.receive({method:'cloud.status_changed',params:{instanceId:'browser',state:'active',online:true,paired:true,fullAccess:true}});
 release();await rejected;
 assert.deepEqual(grants,[]);assert.deepEqual(approvals,['cloud']);assert.equal(executor.tasks.get('local').revoked,undefined);
});

test('已配对云端拒绝 smart 降级，不改变任务或本地权限',async()=>{
 let task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'full',modeGeneration:2};
 const calls=[],executor={revokeMode:()=>assert.fail('不能撤回 full'),setMode:()=>assert.fail('拒绝不改变权限')};
 const bridge={request:async(method,p)=>{calls.push([method,p]);if(method==='extension.tasks')return [task];if(method==='extension.mode'){task={...task,activeMode:p.mode,modeGeneration:p.modeGeneration+1};return task;}throw Error(method);}};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor,consent:{synchronize:async()=>{}},changed:()=>{}});link.instanceId='browser';link.state={paired:true,fullAccess:true,online:true,state:'active'};
 await assert.rejects(link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'smart'}));
 assert.deepEqual(calls,[]);assert.equal(task.activeMode,'full');assert.equal(link.modeForTask(task),null);
});

test('未配对云端不能通过绑定 full 授予任务权限',async()=>{
 const calls=[],task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'full'};
 const bridge={request:async method=>{calls.push(method);return [task];}};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor:{},consent:{synchronize:async()=>{}},changed:()=>{}});link.instanceId='browser';
 await assert.rejects(link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'}));
 assert.deepEqual(calls,[]);assert.equal(link.modeForTask(task),null);assert.equal(link.view().paired,false);
});

test('已配对云端将旧 smart 云端任务升级 full，代次不匹配不能沿用模式',async()=>{
 let task={id:'cloud',generation:1,instanceId:'browser',state:'running',activeMode:'smart',modeGeneration:2};
 const modes=[],grants=[];
 const bridge={request:async(method,p)=>{
  if(method==='extension.tasks')return [task];
  assert.equal(method,'extension.mode');modes.push(p);task={...task,activeMode:p.mode,modeGeneration:3};return task;
 }};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor:{setMode:t=>grants.push(t.id)},consent:{synchronize:async()=>{}},changed:()=>{}});
 link.instanceId='browser';link.state={paired:true,fullAccess:true,online:true,state:'active'};
 assert.deepEqual(await link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'}),{verified:true,taskId:'cloud'});
 assert.deepEqual(modes,[{taskId:'cloud',generation:1,modeGeneration:2,mode:'full'}]);assert.deepEqual(grants,['cloud']);
 assert.equal(link.modeForTask(task),'full');assert.equal(link.modeForTask({...task,generation:2}),null);
 assert.equal(link.modeForTask({id:'local',generation:1}),null);
});

test('云端绑定不能给其他实例的任务授予 full',async()=>{
 const task={id:'cloud',generation:1,instanceId:'other-browser',state:'ready',activeMode:'full'};
 const bridge={request:async method=>{assert.equal(method,'extension.tasks');return [task];}};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor:{},consent:{synchronize:async()=>assert.fail('错误实例不能同步授权')},changed:()=>{}});
 link.instanceId='browser';link.state={paired:true,fullAccess:true,online:true,state:'active'};
 await assert.rejects(link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'full'}));
 assert.equal(link.modeForTask(task),null);
});

test('Native 反向请求不能开启云端完全访问，错误实例状态不能改界面',async()=>{
 const sent=[],link=new CloudLink({}, {localBridge:()=>null,executor:{},consent:{},changed:()=>{}});link.instanceId='browser';link.port={postMessage:m=>sent.push(m)};
 await link.receive({id:'remote',method:'full_access',params:{enabled:true}});
 assert.equal(sent[0].error,'cloud_policy_denied');assert.equal(link.view().fullAccess,false);
 await link.receive({method:'cloud.status_changed',params:{instanceId:'other',fullAccess:true}});assert.equal(link.view().fullAccess,false);
});

test('云端端口断开后按原实例重连，不触碰本地桥',async()=>{
 // 中文注释：重连复用已认证实例，只有云端端口恢复，不调用本地连接入口。
 const link=new CloudLink({}, {localBridge:()=>assert.fail('重连不能操作本地桥'),executor:{},consent:{},changed:()=>{}});
 link.instanceId='browser';link.browser='Chrome';const calls=[];
 link.connect=async(...args)=>calls.push(args);
 await link.refresh();assert.deepEqual(calls,[['browser','Chrome']]);
});

test('云端 Native 断开后快速重连，失败时退避且只保留一个重连计时器',async t=>{
 // 中文注释：使用虚拟时间和真实握手流程，检查恢复速度与连续断开的连接次数。
 t.mock.timers.enable({apis:['setTimeout']});
 const ports=[];
 const chrome={runtime:{connectNative:()=>{
  const port={onMessage:{addListener:fn=>{port.receive=fn;}},onDisconnect:{addListener:fn=>{port.drop=fn;}},
   postMessage:message=>{if(message.method==='hello')queueMicrotask(()=>port.receive({id:message.id,result:{state:'active',online:true}}));},disconnect:()=>port.drop()};
  ports.push(port);return port;
 }}};
 const link=new CloudLink(chrome,{localBridge:()=>assert.fail('云端重连不能改本地桥'),executor:{},consent:{},changed:()=>{}});
 await link.connect('browser','Chrome');ports[0].drop();
 t.mock.timers.tick(1499);assert.equal(ports.length,1);
 t.mock.timers.tick(1);await link.connecting;assert.equal(ports.length,2);assert.equal(link.view().online,true);
 // 中文注释：连接未握手就再次断开时递增等待，旧端口重复事件不能增加计时器。
 chrome.runtime.connectNative=()=>{
  const port={onMessage:{addListener:()=>{}},onDisconnect:{addListener:fn=>{port.drop=fn;}},postMessage:()=>queueMicrotask(()=>port.drop()),disconnect:()=>port.drop()};
  ports.push(port);return port;
 };
 ports[1].drop();t.mock.timers.tick(1500);await link.connecting;assert.equal(ports.length,3);
 ports[1].drop();t.mock.timers.tick(2999);assert.equal(ports.length,3);
 t.mock.timers.tick(1);await link.connecting;assert.equal(ports.length,4);
});
