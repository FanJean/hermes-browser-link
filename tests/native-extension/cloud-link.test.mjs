import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudLink} from '../../native-extension/cloud-link.mjs';
import {BrowserConsent} from '../../native-extension/bridge.mjs';

// 中文注释：真实授权类配合合成传输，检查云端、本地两种权限不会相互覆盖。
test('本地开关只同步本地任务，云端模式独立',async()=>{
 const stored={},local={id:'local',generation:1,policy:{activeMode:'smart',modeGeneration:1}},remote={id:'cloud',generation:1,policy:{activeMode:'full',modeGeneration:7}};
 const calls=[],executor={tasks:new Map([['local',local],['cloud',remote]]),revokeMode:id=>{calls.push(['revoke',id]);},setMode:task=>{calls.push(['grant',task.id]);},};
 const consent=new BrowserConsent({get:async()=>({}),set:async value=>Object.assign(stored,value)},executor,{modeForTask:t=>t.id==='cloud'?'full':null});
 const bridge={closed:false,request:async(method,p)=>{calls.push([method,p.taskId]);return {...local,modeGeneration:2,activeMode:'full'};}};
 await consent.setEnabled(true,bridge);
 assert.deepEqual(calls,[['extension.mode','local'],['grant','local']]);
 assert.equal(remote.policy.activeMode,'full');assert.equal(stored.browserFullConsent.enabled,true);
});

test('云端绑定重验本实例，并将旧 full 任务切回云端 smart',async()=>{
 let task={id:'cloud',generation:1,instanceId:'browser',state:'ready',activeMode:'full',modeGeneration:2};
 const calls=[],executor={revokeMode:id=>calls.push(['revoke',id]),setMode:()=>assert.fail('smart 不能二次授予模式')};
 const bridge={request:async(method,p)=>{calls.push([method,p]);if(method==='extension.tasks')return [task];if(method==='extension.mode'){task={...task,activeMode:p.mode,modeGeneration:p.modeGeneration+1};return task;}throw Error(method);}};
 const link=new CloudLink({}, {localBridge:()=>bridge,executor,consent:{synchronize:async()=>{}},changed:()=>{}});link.instanceId='browser';
 assert.equal((await link.bind({taskId:'cloud',generation:1,instanceId:'browser',mode:'smart'})).verified,true);
 assert.equal(link.modeForTask(task),'smart');assert.equal(link.modeForTask({id:'local',generation:1}),null);
 assert.equal(calls.filter(([method])=>method==='extension.mode').length,1);
 const before=calls.length;await assert.rejects(link.bind({taskId:'cloud',generation:1,instanceId:'other',mode:'full'}));assert.equal(calls.length,before);
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
