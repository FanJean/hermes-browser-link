// 中文注释：首次访问预审只返回任务页来源；换站后旧读取范围不能派发页面动作。
import assert from 'node:assert/strict';
import test from 'node:test';
import {Executor} from '../../native-extension/core.mjs';

const SITE_A='https://site-a.test',SITE_B='https://site-b.test';
const scope={id:'site-task',instanceId:'browser',approvalScope:'owner',generation:1,tabIds:[7],allowedOrigins:[SITE_A,SITE_B]};

test('site origin probe reads no page content and fences pending cross-site navigation',async()=>{
 const tab={id:7,url:`${SITE_A}/inbox`};let reads=0;
 const api={tabs:{get:async()=>{reads++;return {...tab};}}};
 const executor=new Executor(api);await executor.approve(scope);
 const before=reads;
 assert.deepEqual(await executor.readOrigin({taskId:scope.id,generation:1,modeGeneration:1,tabId:7}),{origin:SITE_A});
 assert.equal(reads,before+1);
 tab.pendingUrl=`${SITE_B}/admin`;
 await assert.rejects(executor.readOrigin({taskId:scope.id,generation:1,modeGeneration:1,tabId:7}),/PAGE_NOT_READY/);
 tab.pendingUrl=undefined;tab.url=`${SITE_B}/admin`;
 await assert.rejects(executor.execute({taskId:scope.id,generation:1,modeGeneration:1,requestId:'old-site',action:'snapshot',tabId:7,allowedOrigins:scope.allowedOrigins,approvedReadOrigin:SITE_A}),/READ_ORIGIN_CHANGED/);
});

test('site origin probe rejects foreign tabs and stale task generations',async()=>{
 const executor=new Executor({tabs:{get:async()=>({id:7,url:`${SITE_A}/`})}});await executor.approve(scope);
 await assert.rejects(executor.readOrigin({taskId:scope.id,generation:1,modeGeneration:1,tabId:8}),/TAB_OUT_OF_SCOPE/);
 await assert.rejects(executor.readOrigin({taskId:scope.id,generation:2,modeGeneration:1,tabId:7}),/stale generation/);
});

test('task-owned about blank page has no website to approve',async()=>{
 let url=`${SITE_A}/`;
 const executor=new Executor({tabs:{get:async()=>({id:7,url})}});await executor.approve(scope);
 url='about:blank';
 executor.tasks.get(scope.id).officialBlank=new Set([7]);
 assert.deepEqual(await executor.readOrigin({taskId:scope.id,generation:1,modeGeneration:1,tabId:7}),{origin:'about:blank'});
});
