import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';

const task=generation=>({id:'task',instanceId:'browser',approvalScope:'scope',generation,tabIds:[7],allowedOrigins:['https://example.test']});
const api=()=>({tabs:{get:async id=>({id,url:'https://example.test/'})},debugger:{detach:async()=>{}}});

// 中文注释：旧关闭事件等待资源清理时，任务已换代；迟到回调不能删除新租约或报告新任务关闭。
test('late tab close cannot remove the replacement generation lease',async()=>{
 const events=[],executor=new Executor(api(),event=>events.push(event));
 await executor.approve(task(1));
 let release,started;const entered=new Promise(resolve=>{started=resolve;});let first=true;
 const original=executor.closeTabResources.bind(executor);
 executor.closeTabResources=async(...args)=>{if(first){first=false;started();await new Promise(resolve=>{release=resolve;});}return original(...args);};
 const closing=executor.tabEvent(7,'closed');await entered;
 await executor.release({taskId:'task',generation:1,closeAgentTabs:false});
 await executor.approve(task(2));
 release();await closing;
 assert.equal(executor.leases.get(7),'task');
 assert.equal(executor.tasks.get('task').generation,2);
 assert.equal(events.length,0);
});

// 中文注释：页面事件必须带任务代次，宿主才能拒绝重连后旧连接的迟到事件。
test('navigation and close events carry their approved task generation',async()=>{
 const events=[],executor=new Executor(api(),event=>events.push(event));
 await executor.approve(task(3));
 await executor.tabEvent(7,'navigated','https://example.test/next');
 await executor.tabEvent(7,'closed');
 assert.deepEqual(events.map(event=>[event.event,event.generation]),[['navigated',3],['closed',3]]);
});
