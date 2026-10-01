import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedSample,measureSample} from './mechanical-runner.mjs';

// 中文注释：第一项任务失败后第二项仍独立创建；关闭耗时不计入动作耗时。
test('失败项保留桥接和诊断码，下一项独立执行',async()=>{
 const closed=[],seen=[];let sequence=0;
 const run=work=>isolatedSample({create:async()=>({id:++sequence}),work,close:async task=>{closed.push(task.id);}});
 const first=await run(async task=>{seen.push(task.id);return {error:'需要同步',code:'bridge_error',bridgeCode:'needs_sync',_diagnostic:{code:'PROTOCOL_ERROR'}};});
 const second=await run(async task=>{seen.push(task.id);return {ready:'interactive'};});
 assert.equal(first.sample.success,false);assert.equal(first.sample.bridgeCode,'needs_sync');
 assert.equal(first.sample._diagnostic.code,'PROTOCOL_ERROR');
 assert.equal(second.sample.success,true);assert.deepEqual(seen,[1,2]);assert.deepEqual(closed,[1,2]);
});

test('准备阶段和抛出异常也保留具体码',async()=>{
 // 中文注释：失败既可能来自公共工具回执，也可能由传输层直接抛出。
 const error=Object.assign(Error('busy'),{bridgeCode:'task_busy',_diagnostic:{code:'BUSY'}});
 const prepared=await isolatedSample({create:async()=>{throw error;},work:()=>assert.fail('不应执行'),close:async()=>{}});
 assert.equal(prepared.sample.phase,'prepare');assert.equal(prepared.sample.bridgeCode,'task_busy');
 const measured=await measureSample(async()=>{throw error;});
 assert.equal(measured.sample._diagnostic.code,'BUSY');
});
