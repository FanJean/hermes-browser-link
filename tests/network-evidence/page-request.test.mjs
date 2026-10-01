// 中文注释：直接测试生产页面函数的网络约束和结果，不复制实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../executor-plugin/script_lane/page-request.js',import.meta.url),'utf8');
function fixture(response){
 const calls=[];
 const run=vm.runInNewContext(`(${source})`,{location:{href:'https://example.test/page',origin:'https://example.test'},URL,Uint8Array,TextDecoder,AbortController,setTimeout,clearTimeout,fetch:async(...args)=>{calls.push(args);if(response instanceof Error)throw response;return response;}});
 return {calls,run:options=>run({url:'/api',fields:['rows'],method:'GET',max_bytes:1024,timeout_ms:1000,...options})};
}
test('same-origin credentials, redirects rejected and selected values filtered',async()=>{
 const f=fixture(new Response(JSON.stringify({rows:[{title:'中文',password:'PRIVATE',nested:{token:'PRIVATE'}}],unused:'HIDDEN'}),{headers:{'content-type':'application/json'}}));
 const result=await f.run({fields:['rows','missing']});
 assert.equal(result.ok,true);assert.equal(result.complete,false);assert.deepEqual(Array.from(result.missingFields),['missing']);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('HIDDEN'));
 assert.equal(f.calls[0][1].credentials,'same-origin');assert.equal(f.calls[0][1].redirect,'error');
});
test('foreign URLs and embedded credentials fail before fetch',async()=>{
 for(const url of ['https://other.test/a','https://name:pass@example.test/a','data:text/plain,test']){
  const f=fixture(new Response('{}'));assert.equal((await f.run({url})).code,'origin_denied');assert.equal(f.calls.length,0);
 }
});
test('size, content type, invalid JSON, HTTP and transport failures stay distinct',async()=>{
 const cases=[
  [new Response(JSON.stringify({rows:'x'.repeat(2000)}),{headers:{'content-type':'application/json'}}),'response_too_large'],
  [new Response('text'),'non_json'],[new Response('broken',{headers:{'content-type':'application/json'}}),'invalid_json'],
  [new Response('{}',{status:401}),'http_error'],[Error('secret transport details'),'fetch_failed'],
 ];
 for(const [response,code] of cases){const value=await fixture(response).run();assert.equal(value.code,code);assert.equal(value.ok,false);assert.ok(!JSON.stringify(value).includes('secret transport'));}
});
test('HEAD and valid empty results are explicit successes',async()=>{
 const head=await fixture(new Response(null)).run({method:'HEAD'});assert.equal(head.ok,true);assert.equal(head.complete,true);
 const empty=await fixture(new Response('{"rows":[]}',{headers:{'content-type':'application/json'}})).run();assert.equal(empty.ok,true);assert.equal(empty.data.rows.length,0);
});
test('nested structure truncation cannot claim a complete result',async()=>{
 let rows={value:'deep'};for(let i=0;i<20;i++)rows={child:rows};
 const result=await fixture(new Response(JSON.stringify({rows}),{headers:{'content-type':'application/json'}})).run();
 assert.equal(result.structureTruncated,true);assert.equal(result.complete,false);
});

// 中文注释：合法 JSON 键必须作为字段返回，不能触发普通对象的原型 setter 后静默丢失。
test('selected __proto__ JSON field stays an own filtered data property',async()=>{
 const result=await fixture(new Response('{"__proto__":{"title":"value","token":"PRIVATE"}}',{headers:{'content-type':'application/json'}})).run({fields:['__proto__']});
 assert.equal(result.ok,true);
 assert.equal(result.complete,true);
 assert.equal(Object.hasOwn(result.data,'__proto__'),true);
 assert.equal(result.data.__proto__.title,'value');
 assert.equal(result.data.__proto__.token,'[REDACTED]');
 assert.ok(JSON.stringify(result).includes('value'));
});
