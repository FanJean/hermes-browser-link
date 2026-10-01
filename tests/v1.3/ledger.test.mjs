import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestLedger} from '../../native-extension/request-ledger.mjs';
// 中文注释：超过旧连接容量并淘汰结果后，旧请求仍拒绝重放，清理继续可用。
test('5001 sequenced requests preserve cleanup and bounded replay state',async()=>{
 const ledger=new RequestLedger({maxBytes:2048,maxEntries:8});let calls=0;
 for(let sequence=1;sequence<=5000;sequence++)await ledger.run({id:`srv:${sequence}`,sequence,method:'browser.execute',params:{}},async()=>{calls++;return {result:'x'.repeat(400)};});
 assert(ledger.entries.size<=8);assert(ledger.bytes<=2048);
 const old=await ledger.run({id:'srv:1',sequence:1,method:'browser.execute',params:{}},()=>{calls++;});assert.equal(old.error.code,'request_outcome_unavailable');assert.equal(calls,5000);
 const done=await ledger.run({id:'srv:5001',sequence:5001,method:'browser.release',params:{}},async()=>({result:{released:true}}));assert.equal(done.result.released,true);
});
test('inflight duplicate executes once and mismatched payload is rejected',async()=>{
 const ledger=new RequestLedger();let calls=0;const m={id:'srv:1',sequence:1,method:'browser.execute',params:{a:1}};
 const execute=async()=>{calls++;return {result:42};};
 const [a,b]=await Promise.all([ledger.run(m,execute),ledger.run(m,execute)]);assert.deepEqual(a,b);assert.equal(calls,1);
 assert.equal((await ledger.run({...m,params:{a:2}},execute)).error.code,'request_conflict');
});
