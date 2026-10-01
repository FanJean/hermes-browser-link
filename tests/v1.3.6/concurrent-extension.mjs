// 中文注释：只替换 Chrome API 和加载时钟，保留真实授权、工作区、锁、租约及关闭事件。
import readline from 'node:readline';
import {Bridge} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';
import {workspaceFixture,trustedTask} from '../native-extension/workspace-fixture.mjs';
const fixture=workspaceFixture({nextTabId:100}),executor=new Executor(fixture.api);
// 中文注释：Chrome 的已关闭标签错误用于工作区回收判定，保留真实 API 错误格式。
// 中文注释：导航仍运行真实 Executor.perform，仅模拟 Chrome 的 URL 更新。
fixture.api.tabs.update=async(id,params)=>{Object.assign(fixture.tabs.get(id),params);return fixture.api.tabs.get(id);};
const get=fixture.api.tabs.get;
fixture.api.tabs.get=async id=>{if(!fixture.tabs.has(id))throw Error(`No tab with id: ${id}.`);return get(id);};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let peak=0;const create=fixture.api.tabs.create;
fixture.api.tabs.create=async params=>{const tab=await create(params);peak=Math.max(peak,fixture.tabs.size-2);return tab;};
const bridge=new Bridge({postMessage:send,onMessage:{addListener(){}}},executor);
executor.restoreOverlay=async()=>{};
executor.settledTab=async(id,guard)=>{
 await new Promise(resolve=>setTimeout(resolve,80+(id%4)*25));
 guard();return {tab:await fixture.api.tabs.get(id),ready:'interactive'};
};
executor.onEvent=params=>send({event:params});
await executor.approve(trustedTask('parallel',[]));
executor.setMode({...trustedTask('parallel',[]),modeGeneration:2,activeMode:'full'});
// 中文注释：逐行接收但不逐行等待，确保 Python 的并发请求实际进入同一执行器。
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 void (async()=>{
  try{
   if(msg.method==='browser.execute'){bridge.receive(msg);return;}
   if(msg.method==='collision')executor.leases.set(100,'other-task');
   if(msg.method==='move')fixture.tabs.get(msg.params.tabId).groupId=999;
   const result={tabs:[...executor.tasks.get('parallel').agentTabs],removed:fixture.removed,creates:fixture.creates,peak};
   send({id:msg.id,result});
  }catch(error){send({id:msg.id,error:{code:error.code||'execution_denied',message:error.message,data:{outcomeUnknown:!error.preDispatch}}});}
 })();
});
