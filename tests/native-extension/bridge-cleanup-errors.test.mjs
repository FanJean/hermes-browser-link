import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../../native-extension/bridge.mjs';

async function request(executor,method,params={}) {
 const sent=[];
 const bridge=new Bridge({postMessage:m=>sent.push(m),onMessage:{addListener(){}}},executor);
 bridge.receive({id:'probe',method,params});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,1);
 return sent[0];
}

test('cleanup status is a read-only executor route, separate from release',async()=>{
 let reads=0,releases=0;
 const result=await request({cleanupStatus:async p=>{reads++;assert.deepEqual(p,{taskId:'a',generation:2});return {cleanupState:'unknown',remainingTabIds:[3]};},release:async()=>{releases++;}},'browser.cleanup_status',{taskId:'a',generation:2});
 assert.equal(reads,1);assert.equal(releases,0);
 assert.deepEqual(result.result,{cleanupState:'unknown',remainingTabIds:[3]});
});

test('cleanup retry is an explicit route and passes generation unchanged',async()=>{
 let retries=0;
 const result=await request({cleanupRetry:async p=>{retries++;assert.deepEqual(p,{taskId:'a',generation:2});return {cleanupState:'succeeded',remainingTabIds:[]};}},'browser.cleanup_retry',{taskId:'a',generation:2});
 assert.equal(retries,1);assert.equal(result.result.cleanupState,'succeeded');
});

test('read-only document change is typed and not an uncertain write',async()=>{
 const result=await request({execute:async()=>{throw Error('DOM_CHANGED');}},'browser.execute',{action:'semantic_snapshot'});
 assert.equal(result.error.code,'document_changed');
 assert.deepEqual(result.error.data,{outcomeUnknown:false,retryable:true,stage:'document',reasonCode:'document_changed'});
});

test('stale click keeps uncertain outcome and cannot be automatically replayed',async()=>{
 const result=await request({execute:async()=>{throw Error('STALE_REF');}},'browser.execute',{action:'ref_click'});
 assert.equal(result.error.code,'stale_reference');
 assert.deepEqual(result.error.data,{outcomeUnknown:true,retryable:false});
});

test('permission rejection is specific and never retryable',async()=>{
 const result=await request({execute:async()=>{throw Error('origin denied');}},'browser.execute',{action:'snapshot'});
 assert.equal(result.error.code,'permission_denied');
 assert.deepEqual(result.error.data,{outcomeUnknown:false,retryable:false});
});

test('unknown internal error does not expose arbitrary exception payload',async()=>{
 const result=await request({execute:async()=>{throw Error('secret-internal-payload');}},'browser.execute',{action:'snapshot'});
 assert.equal(result.error.code,'execution_denied');
 assert.equal(JSON.stringify(result).includes('secret-internal-payload'),false);
 assert.equal(result.error.data.retryable,false);
});
