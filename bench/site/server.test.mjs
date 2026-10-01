// 中文注释：直接调用 HTTP 处理器，沙箱无需绑定 TCP 端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {Buffer} from 'node:buffer';
import {createBenchServer, parseMultipart, ROWS} from './server.mjs';

const server=createBenchServer();
server.address=()=>({port:8765});
const handler=server.listeners('request')[0];
async function request(url,{method='GET',host='www.bench.localhost:8765',body='',contentType=''}={}) {
  const input=Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(input,{url,method,headers:{host,'content-type':contentType}});
  return new Promise((resolve,reject)=>{
    const response={status:200,headers:{},writeHead(status,headers={}){this.status=status;this.headers=headers;},end(value=''){resolve({status:this.status,headers:this.headers,body:Buffer.isBuffer(value)?value.toString():value});}};
    Promise.resolve(handler(input,response)).catch(reject);
  });
}

test('站点重定向、页面、分页、提交和日志重置', async () => {
  const apex=await request('/directory-submit',{host:'bench.localhost:8765'});
  assert.equal(apex.status,301);assert.equal(apex.headers.location,'http://www.bench.localhost:8765/directory-submit');
  for(const page of ['/directory-submit','/data-table','/spa-search','/overlay','/slow','/widgets','/login','/real-form-cases']) {
    const response=await request(page);assert.equal(response.status,200);assert.ok(response.body.includes('<h1>'));
  }
  const rows=JSON.parse((await request('/api/rows?page=5')).body);assert.equal(rows.rows.length,50);assert.deepEqual(rows.rows.at(-1),ROWS.at(-1));
  const boundary='bench-boundary';
  const parts=[['product','测试'],['website','https://example.invalid'],['email','a@example.invalid'],['tagline','介绍'],['description','详情'],['category','设计与创意']];
  let body=parts.map(([name,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
  body+=`--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\nlogo-bytes\r\n`;
  body+=`--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\nshot\r\n--${boundary}--\r\n`;
  assert.equal((await request('/directory-submit',{method:'POST',body,contentType:`multipart/form-data; boundary=${boundary}`})).status,200);
  await request('/api/click',{method:'POST',body:'{"target":"primary"}'});
  const log=JSON.parse((await request('/__bench/log')).body);assert.equal(log.submissions.length,1);assert.equal(log.submissions[0].fields.category,'设计与创意');assert.deepEqual(log.submissions[0].files.logo,{name:'logo.png',size:10});assert.deepEqual(log.pageRequests,[5]);assert.deepEqual(log.clicks,['primary']);
  await request('/__bench/reset',{method:'POST'});const cleared=JSON.parse((await request('/__bench/log')).body);assert.deepEqual(cleared.pageRequests,[]);assert.deepEqual(cleared.submissions,[]);
});

test('multipart 保留二进制字节数并拒绝无边界', () => {
  const body=Buffer.from('--x\r\nContent-Disposition: form-data; name="logo"; filename="x.png"\r\n\r\na\x00b\r\n--x--\r\n','binary');
  assert.deepEqual(parseMultipart(body,'multipart/form-data; boundary=x').files.logo,{name:'x.png',size:3});
  assert.throws(()=>parseMultipart(body,'multipart/form-data'),/missing_boundary/);
});

test('目录详情延迟接口和第二主机查询', async () => {
  // 中文注释：不绑定端口，直接确认 Host 隔离、八条链接与查询日志。
  const catalog=await request('/catalog');
  assert.equal((catalog.body.match(/href="\/catalog\/item-/g)||[]).length,8);
  assert.ok((await request('/catalog/item-01')).body.includes('api/catalog/item-01'));
  const detail=JSON.parse((await request('/api/catalog/item-01')).body);
  assert.deepEqual(detail,{id:'item-01',name:'样本产品 01',category:'开发工具',price:'9'});
  assert.equal((await request('/query',{host:'tools.localhost:8765'})).status,200);
  const queried=JSON.parse((await request('/api/query',{method:'POST',host:'tools.localhost:8765',body:'{"value":"BENCH-01"}'})).body);
  assert.equal(queried.result,'已核对 BENCH-01');
  assert.equal((await request('/query')).status,404);
  const log=JSON.parse((await request('/__bench/log')).body);
  assert.deepEqual(log.catalogRequests,['item-01']);
  assert.deepEqual(log.toolQueries,['BENCH-01']);
});
