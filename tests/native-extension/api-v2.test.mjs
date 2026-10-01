import test from 'node:test';
import assert from 'node:assert/strict';
import {Executor} from '../../native-extension/core.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

test('private cookie export checks task origin, tab and generation without separate API consent', async()=>{
 const calls=[];const url='https://example.com/api/items';
 const api={tabs:{get:async id=>({id,url:'https://example.com/home'})},debugger:{attach:async()=>{},sendCommand:async(t,m,p)=>{calls.push([m,p]);return {cookies:[{name:'sid',value:'synthetic',domain:'example.com',path:'/api',secure:true,expires:-1},{name:'foreign',value:'excluded',domain:'other.com',path:'/'},{name:'path',value:'excluded',domain:'example.com',path:'/other'},{name:'partitioned',value:'excluded',domain:'example.com',path:'/',partitionKey:{}}]};}}};
 const e=new Executor(api);const t={id:'task',generation:1,tabIds:[1],allowedOrigins:['https://example.com']};
 await e.approve(t);
 assert.equal(typeof e.credentials,'function','private credential path missing');
 const p={taskId:'task',generation:1,tabId:1,url};
 assert.deepEqual(await e.credentials(p),{cookies:[{name:'sid',value:'synthetic'}]});
 assert.deepEqual(calls,[['Network.getCookies',{urls:[url]}]]);
 // 中文注释：同一任务来源内的不同 URL 不再需要单独预登记。
 assert.deepEqual(await e.credentials({...p,url:url+'?extra=1'}),{cookies:[{name:'sid',value:'synthetic'}]});
 await assert.rejects(()=>e.credentials({...p,url:'https://other.example/api'}));
 await assert.rejects(()=>e.credentials({...p,tabId:2}));
 await assert.rejects(()=>e.credentials({...p,generation:2}));
});

test('credential result is not retained in extension replay cache',async()=>{
 const sent=[];const port={onMessage:{addListener(){}},postMessage:m=>sent.push(m)};
 const executor={credentials:async()=>({cookies:[{name:'sid',value:'synthetic'}]})};
 const b=new Bridge(port,executor);
 b.receive({id:'srv:one',method:'browser.credentials',params:{taskId:'a'}});
 await new Promise(r=>setTimeout(r,10));
 assert.equal(sent[0]?.result?.cookies?.[0]?.name,'sid');
 const entry=b.seen.get('srv:one');
 assert.ok(!JSON.stringify(await entry.promise).includes('synthetic'));
 b.receive({id:'srv:one',method:'browser.credentials',params:{taskId:'a'}});
 await new Promise(r=>setTimeout(r,10));
 assert.ok(sent.at(-1).error);
});
