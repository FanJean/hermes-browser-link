import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';

// 中文注释：只监听 loopback；预览进程的测试身份不会进入生产 Worker。
const db = new DatabaseSync(':memory:');
for (const name of readdirSync('drizzle').filter(name => name.endsWith('.sql'))) db.exec(readFileSync('drizzle/' + name, 'utf8'));
const binding = {
  prepare(sql) {
    let values = []; const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return db.prepare(sql).get(...values) || null; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
    }; return statement;
  },
  async batch(statements) {
    db.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers(incoming.headers);
    headers.set('oai-authenticated-user-id', 'local-preview');
    headers.set('oai-authenticated-user-email', 'preview@sites.test');
    const request = new Request('http://127.0.0.1:8794' + incoming.url, { method: incoming.method, headers,
      ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) });
    const response = await worker.fetch(request, { DB: binding });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('preview_unavailable'); }
}).listen(8794, '127.0.0.1', () => process.stdout.write('Local preview: http://127.0.0.1:8794\n'));
