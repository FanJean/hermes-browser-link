import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../../native-extension/bridge.mjs';

test('task approval response cannot change task, generation, tab or origin scope',()=>{
 const b=new Bridge({onMessage:{addListener(){}},postMessage(){}},{});
 // 中文注释：API 请求已归入两档模式，任务批准只核对身份与页面范围。
 const request={taskId:'a',tabIds:[1],allowedOrigins:['https://example.com'],generation:2};
 const result={id:'a',generation:2,tabIds:[1],allowedOrigins:request.allowedOrigins};
 assert.throws(()=>b.validateApproval(request,{...result,generation:1}));
 assert.throws(()=>b.validateApproval(request,{...result,id:'b'}));
 assert.throws(()=>b.validateApproval(request,{...result,tabIds:[2]}));
 assert.throws(()=>b.validateApproval(request,{...result,allowedOrigins:['https://other.example']}));
 b.validateApproval(request,result);
});
