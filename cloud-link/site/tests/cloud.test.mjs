import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';
import { Store, hash, now } from '../worker/store.js';

// 中文注释：使用真正 SQLite 执行 D1 的 SQL，验证原子领取和租户条件；不代表生产 D1 验收。
export class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync(new URL('../drizzle', import.meta.url)).filter(name => name.endsWith('.sql')))
      this.db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const db = this.db; let args = [];
    const statement = { bind(...values) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const value = db.prepare(sql).run(...args); return { meta: { changes: Number(value.changes) } }; } };
    return statement;
  }
  async batch(statements) {
    // 中文注释：D1 原子批次串行提交，单连接 SQLite 夹具也必须遵循这一约束。
    const work=async()=>{this.db.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }};
    const result=(this.tail||Promise.resolve()).then(work);this.tail=result.catch(()=>{});return result;
  }
}
const rid = value => {const h=createHash('sha256').update(value).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
const secret = 'a'.repeat(43), code = 'BCDEFG-234567';
const deviceRequest = path => new Request('https://relay.test' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + secret } });
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  'oai-authenticated-user-id': 'owner-a', 'oai-authenticated-user-email': 'test@example.test' };
async function fixture() {
  const db = new LocalD1(), store = new Store(db);
  const paired = await store.pair(deviceRequest('/device/pair'), { code, instance_id: 'browser-a', label: '测试浏览器', allowed_origins: ['https://example.com'] });
  await store.pairing('owner-a', code, true);
  let device = await store.device(deviceRequest('/device/poll'));
  await store.heartbeat(device, { browser_connected: true, full_access: false });
  device = await store.device(deviceRequest('/device/poll'));
  return { db, store, device, id: paired.device_id };
}

test('配对前不能调用、配对码只能消费一次、密钥仅存摘要', async () => {
  const db = new LocalD1(), store = new Store(db);
  await store.pair(deviceRequest('/device/pair'), { code, instance_id: 'browser-a', label: '浏览器', allowed_origins: ['https://example.com'] });
  await assert.rejects(store.device(deviceRequest('/device/poll')), /pairing_required/);
  await store.pairing('owner-a', code, true);
  await assert.rejects(store.pairing('owner-b', code, true), /pairing_unavailable/);
  const row = db.db.prepare('SELECT * FROM devices').get();
  assert.equal(row.token_hash, await hash(secret)); assert.equal(row.code_hash, null); assert.equal(row.owner_id, 'owner-a');
});

test('跨用户、未配对网站及伪造会话不能入队', async () => {
  const { store, id } = await fixture();
  const args = { device_id: id, request_id: rid('create-a'), title: '测试', allowed_origins: ['https://example.com'] };
  await assert.rejects(store.enqueue('owner-b', 'create', args), /device_denied/);
  await assert.rejects(store.enqueue('owner-a', 'create', { ...args, allowed_origins: ['https://other.test'] }), /origin_denied/);
  await assert.rejects(store.enqueue('owner-a', 'get', { device_id: id, request_id: rid('get-a'), session_id: 'forged', task_id: 'local-task' }), /session_denied/);
});

test('同请求去重、改参冲突、领取一次、结果补交、私有查询', async () => {
  const { store, device, id, db } = await fixture();
  const args = { device_id: id, request_id: rid('create-a'), title: '测试', allowed_origins: ['https://example.com'] };
  const queued = await store.enqueue('owner-a', 'create', args);
  assert.equal((await store.enqueue('owner-a', 'create', args)).command_id, queued.command_id);
  await assert.rejects(store.enqueue('owner-a', 'create', { ...args, title: '改参' }), /request_conflict/);
  const claimed = await store.poll(device); assert.equal(claimed.command.id, queued.command_id);
  assert.equal((await store.poll(device)).command, null);
  await store.complete(device, { command_id: queued.command_id, result: { id: 'native-cloud-task' } });
  await store.complete(device, { command_id: queued.command_id, result: { id: 'native-cloud-task' } });
  assert.equal((await store.result('owner-a', queued.command_id)).result.id, 'native-cloud-task');
  assert.equal((await store.result('owner-a', queued.command_id)).result, null);
  assert.equal(db.db.prepare('SELECT result,tool,args FROM commands').get().result, null);
  await assert.rejects(store.result('owner-b', queued.command_id), /command_denied/);
  assert.equal(db.db.prepare('SELECT args FROM commands').get().args, '{}');
});

test('超时不重排、撤销不再领取、结果到期不返回正文', async () => {
  const { store, device, id, db } = await fixture();
  const queued = await store.enqueue('owner-a', 'create', { device_id: id, request_id: rid('old'), title: '测试', allowed_origins: ['https://example.com'] });
  await store.poll(device);
  db.db.prepare('UPDATE commands SET expires_at=?').run(now() - 1);
  assert.equal((await store.result('owner-a', queued.command_id)).state, 'outcome_unknown');
  assert.equal((await store.poll(device)).command, null);
  await store.revoke(id, 'owner-a');
  await assert.rejects(store.device(deviceRequest('/device/poll')), /device_denied/);
});

test('HTTP 管理入口拒绝跨站及无身份请求，MCP 发现不泄露配对数据', async () => {
  const { db } = await fixture();
  const denied = await worker.fetch(new Request('https://relay.test/api/devices'), { DB: db });
  assert.equal(denied.status, 401);
  const crossSite = await worker.fetch(new Request('https://relay.test/api/pair/approve', { method: 'POST', headers: { ...headers, Origin: 'https://other.test' }, body: '{}' }), { DB: db });
  assert.equal(crossSite.status, 403);
  const response = await worker.fetch(new Request('https://relay.test/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), { DB: db });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /cloud_browser_run/); assert.doesNotMatch(text, /browser-a|owner-a/);
});

test('MCP 参数验证拒绝模型指定本机实例和本地文件', async () => {
  const { db, id } = await fixture();
  for (const [name, args] of [
    ['cloud_browser_create', { device_id: id, request_id: rid('bad'), title: 'x', allowed_origins: ['https://example.com'], instance_id: 'local' }],
    ['cloud_browser_run', { device_id: id, session_id: 'x', request_id: rid('bad2'), task_id: 'x', action: 'files.upload', paths: ['/tmp/private'] }],
  ]) {
    const response = await worker.fetch(new Request('https://relay.test/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) }), { DB: db });
    const text = await response.text(); assert.match(text, /error|isError/);
  }
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM commands').get().n, 0);
});

test('Sites 转发保留身份校验并恢复现代 MCP 发现和工具路由头', async () => {
  const { db } = await fixture();
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {} };
  async function invoke(method, params, extra = {}) {
    return worker.fetch(new Request('https://relay.test/mcp', { method: 'POST', headers: {
      ...headers, 'MCP-Protocol-Version': '2026-07-28', 'x-dispatched-app': 'site-test', ...extra },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method, params: { ...params, _meta: meta } }) }), { DB: db });
  }
  const discover = await invoke('server/discover', {});
  assert.equal(discover.status, 200); assert.equal((await discover.json()).result.resultType, 'complete');
  const tools = await invoke('tools/list', {});
  assert.equal(tools.status, 200); assert.equal((await tools.json()).result.tools.length, 9);
  const devices = await invoke('tools/call', { name: 'cloud_browser_devices', arguments: {} });
  assert.equal(devices.status, 200); assert.equal((await devices.json()).result.structuredContent.devices.length, 1);
  // 中文注释：不能覆盖矛盾头，也不能用转发标记或路由头代替用户身份。
  assert.equal((await invoke('tools/list', {}, { 'Mcp-Method': 'tools/call' })).status, 400);
  const anonymous = await invoke('tools/call', { name: 'cloud_browser_devices', arguments: {} },
    { 'oai-authenticated-user-id': '', 'oai-authenticated-user-email': '' });
  assert.match(JSON.stringify(await anonymous.json()), /sign_in_required/);
});

test('浏览器断开时不能只靠客户端心跳显示在线或接收命令',async()=>{
 const {store,device,id}=await fixture();
 await store.heartbeat(device,{browser_connected:false,full_access:false});
 const rows=await store.devices('owner-a');assert.equal(rows[0].connection_online,true);assert.equal(rows[0].online,false);
 await assert.rejects(store.enqueue('owner-a','create',{device_id:id,request_id:rid('offline'),title:'x',allowed_origins:['https://example.com']}),/device_offline/);
});

test('回执正文只交付一次，领取后不保留输入、动作或执行历史',async()=>{
 const {store,device,id,db}=await fixture();
 const queued=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('private-request-name'),title:'不应留存的任务标题',allowed_origins:['https://example.com']});
 await store.poll(device);
 let row=db.db.prepare('SELECT * FROM commands').get();assert.equal(row.args,'{}');assert.equal(row.tool,'');assert.match(row.request_key,/^sha256:/);assert.doesNotMatch(row.request_key,/private/);
 await store.complete(device,{command_id:queued.command_id,result:{content:'仅供中转的正文'}});
 const [first,second]=await Promise.all([store.result('owner-a',queued.command_id),store.result('owner-a',queued.command_id)]);
 assert.equal([first,second].filter(value=>value.result?.content).length,1);
 row=db.db.prepare('SELECT * FROM commands').get();assert.equal(row.result,null);assert.equal(row.result_delivered,1);
 await store.complete(device,{command_id:queued.command_id,result:{content:'仅供中转的正文'}});
 assert.equal(db.db.prepare('SELECT result FROM commands').get().result,null);
});

test('完全访问只是设备状态镜像，网页不提供开启接口',async()=>{
 const {store,device,id,db}=await fixture();
 await store.heartbeat(device,{browser_connected:true,full_access:true});
 const row=(await store.devices('owner-a'))[0];assert.equal(row.full_access,true);
 const req=new Request('https://relay.test/api/device/full-access',{method:'POST',headers:{...headers,Origin:'https://relay.test'},body:JSON.stringify({device_id:id,enabled:true})});
 assert.equal((await worker.fetch(req,{DB:db})).status,404);
});

test('合并交换保持心跳、批量顺序和会话内去重，关闭后拒绝新动作',async()=>{
 // 中文注释：两个独立会话可使用相同操作标记，路由和回执仍分别匹配。
 const {store,device,id,db}=await fixture();
 const a=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('parallel-create-a'),title:'a',allowed_origins:['https://example.com']});
 const b=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('parallel-create-b'),title:'b',allowed_origins:['https://example.com']});
 const base={browser_connected:true,full_access:false,limit:8,results:[],closed_sessions:[]};
 const first=await store.exchange(device,base);assert.deepEqual(first.commands.map(c=>c.id),[a.command_id,b.command_id]);
 assert.equal(db.db.prepare("SELECT count(*) n FROM commands WHERE args!='{}' OR tool!=''").get().n,0);
 await store.exchange(device,{...base,results:[{command_id:a.command_id,result:{id:'task-a',state:'ready'}},{command_id:b.command_id,result:{id:'task-b',state:'ready'}}]});
 const ra=await store.enqueue('owner-a','run',{device_id:id,session_id:a.session_id,request_id:'same-name',task_id:'task-a',action:'snapshot',tab_id:1});
 const rb=await store.enqueue('owner-a','run',{device_id:id,session_id:b.session_id,request_id:'same-name',task_id:'task-b',action:'snapshot',tab_id:1});
 assert.notEqual(ra.command_id,rb.command_id);
 const claimed=await store.exchange(device,base);assert.equal(claimed.commands.length,2);
 const close=await store.enqueue('owner-a','close',{device_id:id,session_id:a.session_id,request_id:'close-a',task_id:'task-a'});
 await assert.rejects(store.enqueue('owner-a','run',{device_id:id,session_id:a.session_id,request_id:'after-close',task_id:'task-a',action:'snapshot',tab_id:1}),/session_closed/);
 await store.exchange(device,base);
 await store.exchange(device,{...base,results:[{command_id:ra.command_id,result:{title:'a'}},{command_id:rb.command_id,result:{title:'b'}},{command_id:close.command_id,result:{id:'task-a',state:'closed'}}],closed_sessions:[a.session_id]});
 assert.equal(db.db.prepare('SELECT state FROM sessions WHERE id=?').get(a.session_id).state,'closed');
 assert.equal(db.db.prepare('SELECT state FROM sessions WHERE id=?').get(b.session_id).state,'active');
 assert.equal((await store.devices('owner-a'))[0].online,true);
});

test('并发建任务重试不会产生孤儿会话，固定短标记不能误共享任务',async()=>{
 const {store,id,db}=await fixture();
 const args={device_id:id,request_id:rid('racing-create'),title:'a',allowed_origins:['https://example.com']};
 const [a,b]=await Promise.all([store.enqueue('owner-a','create',args),store.enqueue('owner-a','create',args)]);
 assert.equal(a.command_id,b.command_id);assert.equal(db.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
 await assert.rejects(store.enqueue('owner-a','create',{...args,request_id:'create-1'}),/create_request_uuid_required/);
});

test('一个会话队列满时仍可取消，并为另一会话保留容量',async()=>{
 const {store,id,device}=await fixture();
 const a=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('quota-a'),title:'a',allowed_origins:['https://example.com']});
 await store.poll(device);await store.complete(device,{command_id:a.command_id,result:{id:'task-a',state:'ready'}});
 for(let i=0;i<8;i++)await store.enqueue('owner-a','run',{device_id:id,session_id:a.session_id,request_id:'q-'+i,task_id:'task-a',action:'snapshot',tab_id:i});
 await assert.rejects(store.enqueue('owner-a','run',{device_id:id,session_id:a.session_id,request_id:'overflow',task_id:'task-a',action:'snapshot',tab_id:9}),/session_queue_full/);
 const b=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('quota-b'),title:'b',allowed_origins:['https://example.com']});assert.equal(b.state,'queued');
 const cancel=await store.enqueue('owner-a','cancel',{device_id:id,session_id:a.session_id,request_id:'cancel-a',task_id:'task-a'});
 const next=await store.poll(device);assert.equal(next.command.id,cancel.command_id);
});

test('会话页面队列满时可查询状态，查询不会把会话标为关闭中',async()=>{
 // 中文注释：查询必须保留控制容量，不能让八个等待动作挡住取消前的状态核实。
 const {store,id,device,db}=await fixture();
 const created=await store.enqueue('owner-a','create',{device_id:id,request_id:rid('status-capacity'),title:'a',allowed_origins:['https://example.com']});
 await store.poll(device);await store.complete(device,{command_id:created.command_id,result:{id:'task-a',state:'ready'}});
 for(let i=0;i<8;i++)await store.enqueue('owner-a','run',{device_id:id,session_id:created.session_id,request_id:'wait-'+i,task_id:'task-a',action:'snapshot',tab_id:i});
 const status=await store.enqueue('owner-a','get',{device_id:id,session_id:created.session_id,request_id:'status',task_id:'task-a'});
 assert.equal(status.state,'queued');assert.equal(db.db.prepare('SELECT state FROM sessions WHERE id=?').get(created.session_id).state,'active');
});
