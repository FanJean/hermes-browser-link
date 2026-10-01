import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
const task={id:'task',instanceId:'browser',approvalScope:'opaque-owner-session',generation:1,allowedOrigins:['https://example.com'],tabIds:[1]};
function fixture(){let calls=0;const api={tabs:{get:async id=>({id,url:'https://example.com'}),update:async()=>{calls++;return {url:'https://example.com'};}},debugger:{detach:async()=>{}}};return {e:new Executor(api),calls:()=>calls};}
const command={taskId:'task',requestId:'r',generation:1,modeGeneration:1,allowedOrigins:task.allowedOrigins,action:'navigate',tabId:1,url:'https://example.com/next'};
test('native executor denies unconfirmed smart risk',async()=>{const {e,calls}=fixture();await e.approve(task);await assert.rejects(e.execute(command),/confirmation required/);assert.equal(calls(),0);});
test('one-use confirmation binds exact payload and revoke fences full mode',async()=>{
 const {e,calls}=fixture();await e.approve(task);
 const {generation,modeGeneration,allowedOrigins,...request}=command;
 const a={taskId:'task',nonce:'one',digest:'hash',expiresAt:Date.now()/1000+120,generation,modeGeneration,request};
 e.approveAction(a);
 await assert.rejects(e.execute({...command,url:'https://example.com/other',approval:{nonce:'one',digest:'hash'}}),/approval/);
 e.approveAction({...a,nonce:'two'});
 await e.execute({...command,approval:{nonce:'two',digest:'hash'}});assert.equal(calls(),1);
 await assert.rejects(e.execute({...command,approval:{nonce:'two',digest:'hash'}}),/approval/);
 e.setMode({...task,activeMode:'full',modeGeneration:2});
 await e.execute({...command,modeGeneration:2});assert.equal(calls(),2);
 e.revokeMode('task');
 await assert.rejects(e.execute({...command,modeGeneration:2}),/mode/);
});
