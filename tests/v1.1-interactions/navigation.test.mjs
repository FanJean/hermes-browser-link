// 中文注释：经真实 Bridge/Executor 验证导航提交时序，浏览器 API 使用受控异步事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';
import {trustedTask,workspaceFixture} from '../native-extension/workspace-fixture.mjs';

test('离开范围的工作页导航回授权网站时等待提交，不把旧 URL 当成新导航失败',async()=>{
 const {api,tabs}=workspaceFixture(),listeners=new Set();
 api.tabs.onUpdated={addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)};
 const executor=new Executor(api),task=trustedTask('nav',[1]);await executor.approve(task);
 executor.setMode({...task,modeGeneration:2,activeMode:'full'});
 tabs.get(1).url='https://outside.test/private';executor.tasks.get(task.id).offScopeTabs=new Set([1]);
 let updates=0,timer;
 api.tabs.update=async(id,{url})=>{
  updates++;const tab=tabs.get(id);tab.status='loading';tab.pendingUrl=url;
  timer=setTimeout(()=>{tab.url=url;tab.status='complete';delete tab.pendingUrl;for(const listener of listeners)listener(id,{status:'complete'},tab);},20);
  return {...tab};
 };
 let resolve;
 const bridge=new Bridge({onMessage:{addListener(){}},postMessage:message=>resolve(message)},executor);
 const message={id:'return',method:'browser.execute',params:{taskId:task.id,generation:1,modeGeneration:2,allowedOrigins:task.allowedOrigins,tabId:1,action:'navigate',url:'https://example.com/return'}};
 try{
  const response=new Promise(done=>{resolve=done;});bridge.receive(message);
  const reply=await response;
  assert.equal(reply.error,undefined,JSON.stringify(reply));
  assert.deepEqual(reply.result,{tabId:1,url:'https://example.com/return',ready:'complete'});
  const replay=new Promise(done=>{resolve=done;});bridge.receive(message);assert.deepEqual(await replay,reply);
  assert.equal(updates,1);assert.equal(listeners.size,0);
 }finally{clearTimeout(timer);}
});
