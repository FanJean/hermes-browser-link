// 中文注释：所有用户数据查询带 owner 条件，设备调用另验证配对密钥；不信任请求参数中的用户身份。
export class Denied extends Error {
  constructor(code, status = 403) { super(code); this.status = status; }
}
export const now = () => Math.floor(Date.now() / 1000);
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    n => n.toString(16).padStart(2, '0')).join('');
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function user(request) {
  // 中文注释：这些头由 Sites 平台覆盖并注入；本地预览不伪造生产认证。
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || !request.headers.get('oai-authenticated-user-email')) throw new Denied('sign_in_required', 401);
  return id;
}
export function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
export async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Denied('json_required', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Denied('invalid_body', 400);
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 512 * 1024) { await reader.cancel(); throw new Denied('payload_too_large', 413); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new Denied('invalid_json', 400); }
}
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new Denied('origin_denied');
}
export function origin(value) {
  let url; try { url = new URL(value); } catch { throw new Denied('origin_invalid', 400); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Denied('origin_invalid', 400);
  return url.origin;
}
// 中文注释：输入允许大小写、分组短横线和空格，但只保存规范化连接码的摘要。
export function pairingCode(value) {
  if (typeof value !== 'string') throw new Denied('pairing_invalid', 400);
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[2-9A-HJ-NP-Z]{12}$/.test(normalized)) throw new Denied('pairing_invalid', 400);
  return normalized;
}
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

export class Store {
  constructor(db) { if (!db) throw new Denied('storage_unavailable', 503); this.db = db; }
  async device(request, pending = false) {
    const bearer = request.headers.get('authorization');
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer || '')) throw new Denied('device_denied', 401);
    const device = await first(this.db, 'SELECT * FROM devices WHERE token_hash=?', await hash(bearer.slice(7)));
    if (!device || device.state === 'revoked') throw new Denied('device_denied', 401);
    if (device.state === 'pending' && device.expires_at <= now()) throw new Denied('pairing_expired', 410);
    if (!pending && device.state !== 'active') throw new Denied('pairing_required', 403);
    return device;
  }
  async pair(request, args) {
    const bearer = request.headers.get('authorization');
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer || '')
        || typeof args.instance_id !== 'string' || !args.instance_id || args.instance_id.length > 256
        || typeof args.label !== 'string' || !args.label || args.label.length > 100
        || !Array.isArray(args.allowed_origins) || args.allowed_origins.length > 64
        || !['task_pages','selected_sites'].includes(args.access_scope || 'selected_sites')
        || (!args.allowed_origins.length && args.access_scope !== 'task_pages'))
      throw new Denied('pairing_invalid', 400);
    const code = pairingCode(args.code);
    const tokenHash = await hash(bearer.slice(7));
    if (await first(this.db, 'SELECT id FROM devices WHERE token_hash=?', tokenHash)) throw new Denied('pairing_exists', 409);
    const count = await first(this.db, "SELECT count(*) AS n FROM devices WHERE state='pending' AND expires_at>?", now());
    if (count.n >= 20) throw new Denied('pairing_queue_full', 429);
    const id = crypto.randomUUID();
    await run(this.db, 'INSERT INTO devices(id,token_hash,code_hash,instance_id,label,origins,state,expires_at,access_scope,browser) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, tokenHash, await hash(code), args.instance_id, args.label,
      JSON.stringify([...new Set(args.allowed_origins.map(origin))]), 'pending', now() + 300,
      args.access_scope || 'selected_sites', args.browser === 'edge' ? 'edge' : 'chrome');
    return { device_id: id, status: 'pending_pairing' };
  }
  async pairing(owner, code, approve) {
    const normalized = pairingCode(code);
    const row = await first(this.db, "SELECT * FROM devices WHERE code_hash=? AND state='pending' AND expires_at>?", await hash(normalized), now());
    if (!row) throw new Denied('pairing_unavailable', 404);
    if (approve) {
      const update = await run(this.db, "UPDATE devices SET owner_id=?,state='active',code_hash=NULL WHERE id=? AND state='pending' AND expires_at>?",
        owner, row.id, now());
      if (update.meta.changes !== 1) throw new Denied('pairing_unavailable', 409);
    }
    return { device_id: row.id, label: row.label, instance_id: row.instance_id, browser: row.browser,
      allowed_origins: JSON.parse(row.origins), access_scope: row.access_scope, expires_at: row.expires_at };
  }
  async devices(owner) {
    // 中文注释：只清理旧版已结束通信中的历史留存，新版未交付回执不受影响。
    const legacy = await first(this.db, "SELECT id FROM commands WHERE owner_id=? AND response_digest IS NULL AND result_delivered=0 AND state NOT IN ('queued','claimed') LIMIT 1", owner);
    if (legacy) await this.clearDelivered(owner);
    const result = await this.db.prepare("SELECT id,label,instance_id,origins,last_seen,state,browser_connected,full_access,access_scope,browser FROM devices WHERE owner_id=? ORDER BY state,label LIMIT 100").bind(owner).all();
    return result.results.map(row => ({ device_id: row.id, label: row.label, instance_id: row.instance_id,
      allowed_origins: JSON.parse(row.origins), state: row.state, browser: row.browser,
      full_access: row.full_access === 1, access_scope: row.access_scope, last_seen: row.last_seen,
      connection_online: row.state === 'active' && row.last_seen > now() - 15,
      online: row.state === 'active' && row.browser_connected === 1 && row.last_seen > now() - 15 }));
  }
  async heartbeat(device, args) {
    if (device.state === 'pending') return { status: 'pending_pairing' };
    if (typeof args.browser_connected !== 'boolean' || typeof args.full_access !== 'boolean') throw new Denied('heartbeat_invalid', 400);
    // 中文注释：此处只是本机授权的状态镜像；网页与 MCP 工具不能修改本机权限。
    await run(this.db, "UPDATE devices SET last_seen=?,browser_connected=?,full_access=? WHERE id=? AND state='active' AND (last_seen IS NULL OR last_seen<=? OR browser_connected!=? OR full_access!=?)",
      now(), Number(args.browser_connected), Number(args.full_access), device.id,now()-5,Number(args.browser_connected),Number(args.full_access));
    await this.expire(device.id);
    return { device_id: device.id };
  }
  async expire(deviceId) {
    // 中文注释：过期领取记为未知，不能恢复成 queued；输入和结果到期后擦除。
    await this.db.batch([
      this.db.prepare("UPDATE commands SET state=CASE WHEN state='claimed' THEN 'outcome_unknown' ELSE 'expired' END,args='{}',tool='' WHERE device_id=? AND state IN ('queued','claimed') AND expires_at<=?").bind(deviceId, now()),
      this.db.prepare("UPDATE commands SET result=NULL,args='{}',tool='' WHERE device_id=? AND result_expires_at<=?").bind(deviceId, now()),
    ]);
  }
  async poll(device, limit = 1) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 8) throw new Denied('poll_invalid', 400);
    if (device.state === 'pending') return { status: 'pending_pairing' };
    await this.expire(device.id);
    return this.claim(device,limit);
  }
  async claim(device,limit) {
    if (device.browser_connected !== 1 || limit === 0) return { device_id: device.id, command: null, commands: [] };
    // 中文注释：单条 UPDATE 原子领取，只允许活跃配对的命令被领取一次。
    const claimed = await this.db.prepare(`UPDATE commands SET state='claimed',claimed_at=?
      WHERE id IN (SELECT id FROM commands WHERE device_id=? AND state='queued' AND expires_at>?
        ORDER BY CASE WHEN tool='cancel' THEN 0 ELSE 1 END,rowid LIMIT ?)
      AND EXISTS(SELECT 1 FROM devices WHERE id=? AND state='active') RETURNING rowid AS queue_order,*`)
      .bind(now(), device.id, now(), limit, device.id).all();
    const commands = claimed.results.sort((a,b)=>a.queue_order-b.queue_order).map(command => ({
      id: command.id, device_id: device.id, session_id: command.session_id,
      tool: command.tool, args: JSON.parse(command.args), expires_at: command.expires_at }));
    // 中文注释：收件箱领取后立即清除输入与动作名，只保留通信身份和去重摘要。
    if (commands.length) await this.db.batch(commands.map(command => this.db.prepare("UPDATE commands SET args='{}',tool='' WHERE id=? AND state='claimed'").bind(command.id)));
    return { device_id: device.id, command: commands[0] || null, commands };
  }
  async exchange(device, args) {
    // 中文注释：一次请求完成心跳、回执和批量领取，执行线程不参与此网络循环。
    if (!Number.isInteger(args.limit) || args.limit < 0 || args.limit > 8 || !Array.isArray(args.results)
        || args.results.length > 8 || !Array.isArray(args.closed_sessions) || args.closed_sessions.length > 32
        || args.closed_sessions.some(id => typeof id !== 'string' || id.length > 256)) throw new Denied('exchange_invalid', 400);
    if (device.state === 'pending') return { device_id: device.id, status: 'pending_pairing', commands: [], receipts: [], closed_sessions: [] };
    await this.heartbeat(device, args);
    const receipts = [];
    for (const result of args.results) {
      try { receipts.push({ command_id: result.command_id, ...await this.complete(device, result) }); }
      catch (error) { if (!(error instanceof Denied)) throw error; receipts.push({ command_id: result.command_id, received: false, code: error.message }); }
    }
    // 中文注释：本机报告关闭后，擦除此会话尚未执行的输入，保留防重放摘要。
    if (args.closed_sessions.length) await this.db.batch(args.closed_sessions.flatMap(id => [
      this.db.prepare("UPDATE sessions SET state='closed',last_seen=? WHERE id=? AND device_id=?").bind(now(),id,device.id),
      this.db.prepare("UPDATE commands SET state=CASE WHEN state='claimed' THEN 'outcome_unknown' ELSE 'revoked' END,args='{}',tool='' WHERE session_id=? AND device_id=? AND state IN ('queued','claimed')").bind(id,device.id),
    ]));
    const polled = await this.claim({...device,browser_connected:Number(args.browser_connected)},args.limit);
    return { device_id:device.id, commands:polled.commands, receipts, closed_sessions:args.closed_sessions };
  }
  async enqueue(owner, suffix, args) {
    const device = await first(this.db, "SELECT * FROM devices WHERE id=? AND owner_id=? AND state='active'", args.device_id, owner);
    if (!device) throw new Denied('device_denied');
    const { device_id: deviceId, session_id: sessionId, request_id: requestId, ...parameters } = args;
    // 中文注释：调用去重只保存摘要，不把模型自定义请求名变成执行历史。
    const requestKey = 'sha256:' + await hash(requestId);
    const digest = await hash(canonical({ tool: suffix, parameters, session_id: sessionId || null }));
    const findRequest = () => suffix === 'create'
      ? first(this.db,'SELECT * FROM commands WHERE owner_id=? AND device_id=? AND request_key=?',owner,deviceId,requestKey)
      : first(this.db,'SELECT * FROM commands WHERE owner_id=? AND device_id=? AND session_id=? AND request_key=?',owner,deviceId,sessionId,requestKey);
    const existing = await findRequest();
    if (existing) {
      if (existing.digest !== digest) throw new Denied('request_conflict', 409);
      return this.consume(existing);
    }
    if (device.last_seen < now() - 15 || device.last_seen === null || device.browser_connected !== 1) throw new Denied('device_offline', 409);
    // 中文注释：不同会话的建任务标记必须是新 UUID，避免常见的 create-1 导致两个对话误复用同一任务。
    if (suffix === 'create' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Denied('create_request_uuid_required',400);
    let session;
    if (suffix === 'create') {
      const requested = parameters.allowed_origins.map(origin);
      if (!device.full_access && device.access_scope === 'selected_sites' && requested.some(value => !JSON.parse(device.origins).includes(value))) throw new Denied('origin_denied');
      session = crypto.randomUUID();
    } else {
      const row = await first(this.db, 'SELECT id,state FROM sessions WHERE id=? AND owner_id=? AND device_id=?', sessionId, owner, deviceId);
      if (!row) throw new Denied('session_denied');
      if (row.state !== 'active' && !['get','list','close','cancel'].includes(suffix)
          && !(row.state === 'cancelled' && suffix === 'resume')) throw new Denied('session_closed',409);
      session = row.id;
    }
    const count = await first(this.db, "SELECT count(*) AS n FROM commands WHERE device_id=? AND state IN ('queued','claimed')", deviceId);
    const lifecycle = ['close','cancel'].includes(suffix);
    // 中文注释：队列满时仍允许状态查询和取消；只由结束操作把路由切入关闭状态。
    const control = lifecycle || ['get','list'].includes(suffix);
    if (count.n >= (control ? 24 : 20)) throw new Denied('command_queue_full', 429);
    const ownCount = await first(this.db,"SELECT count(*) AS n FROM commands WHERE session_id=? AND state IN ('queued','claimed')",session);
    if (!control && ownCount.n >= 8) throw new Denied('session_queue_full',429);
    const id = crypto.randomUUID();
    const statements = [];
    // 中文注释：会话创建与命令入队在同一事务；同 UUID 并发重试不能留下多余会话。
    if (suffix === 'create') statements.push(this.db.prepare(`INSERT INTO sessions(id,owner_id,device_id,created_at,last_seen)
      SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM commands WHERE owner_id=? AND device_id=? AND request_key=?)
      AND (SELECT count(*) FROM commands WHERE device_id=? AND state IN ('queued','claimed'))<20`)
      .bind(session,owner,deviceId,now(),now(),owner,deviceId,requestKey,deviceId));
    else statements.push(this.db.prepare("UPDATE sessions SET last_seen=?,state=CASE WHEN ? THEN 'closing' ELSE state END WHERE id=? AND owner_id=? AND device_id=?")
      .bind(now(),Number(lifecycle),session,owner,deviceId));
    statements.push(this.db.prepare(`INSERT OR IGNORE INTO commands(id,owner_id,device_id,session_id,request_key,digest,tool,args,state,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,'queued',?,? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND owner_id=? AND state='active')
      AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND owner_id=? AND device_id=? AND (state='active' OR ?))
      AND (SELECT count(*) FROM commands WHERE device_id=? AND state IN ('queued','claimed'))<?
      AND (? OR (SELECT count(*) FROM commands WHERE session_id=? AND state IN ('queued','claimed'))<8)`)
      .bind(id, owner, deviceId, session, requestKey, digest, suffix, JSON.stringify(parameters), now(), now() + 180, deviceId, owner,
        session,owner,deviceId,Number(['get','list','close','cancel','resume'].includes(suffix)),deviceId,control?24:20,Number(control),session));
    await this.db.batch(statements);
    const row = await findRequest();
    if (!row) throw new Denied('command_not_queued',409);
    if (row.digest !== digest) throw new Denied('request_conflict', 409);
    return this.receipt(row);
  }
  receipt(row) {
    return { command_id: row.id, session_id: row.session_id, state: row.state,
      result: row.result && row.result_expires_at > now() ? JSON.parse(row.result) : null,
      result_delivered: row.result_delivered === 1,
      result_expired: row.state === 'completed' && row.result_delivered !== 1 && row.result_expires_at <= now() };
  }
  async consume(row) {
    if (!row.result || row.result_expires_at <= now()) return this.receipt(row);
    // 中文注释：完整正文只转发一次，接收时原子清除；并发读取不能重复取得正文。
    const update = await run(this.db, "UPDATE commands SET result=NULL,result_delivered=1,args='{}',tool='' WHERE id=? AND owner_id=? AND result IS NOT NULL AND result_delivered=0",
      row.id, row.owner_id);
    if (update.meta.changes !== 1) return this.receipt({ ...row, result: null, result_delivered: 1 });
    return this.receipt({ ...row, result_delivered: 1 });
  }
  async result(owner, id) {
    let row = await first(this.db, 'SELECT * FROM commands WHERE id=? AND owner_id=?', id, owner);
    if (!row) throw new Denied('command_denied', 404);
    await this.expire(row.device_id);
    row = await first(this.db, 'SELECT * FROM commands WHERE id=? AND owner_id=?', id, owner);
    return this.consume(row);
  }
  async complete(device, args) {
    const encoded = JSON.stringify(args.result);
    if (encoded === undefined || new TextEncoder().encode(encoded).length > 500 * 1024) throw new Denied('result_invalid', 400);
    const row = await first(this.db, 'SELECT * FROM commands WHERE id=? AND device_id=?', args.command_id, device.id);
    if (!row) throw new Denied('command_denied', 404);
    // 中文注释：仅同一设备的原回执可以补交；完成后重复提交必须一致。
    const digest = await hash(encoded);
    if (row.state === 'completed') {
      if (row.response_digest === digest) return { received: true };
      throw new Denied('receipt_conflict', 409);
    }
    if (row.state !== 'claimed' || row.expires_at <= now()) throw new Denied('receipt_expired', 409);
    const update = await run(this.db, "UPDATE commands SET state='completed',result=?,response_digest=?,result_expires_at=?,args='{}',tool='' WHERE id=? AND device_id=? AND state='claimed' AND EXISTS(SELECT 1 FROM devices WHERE id=? AND state='active')",
      encoded, digest, now() + 120, row.id, device.id, device.id);
    if (update.meta.changes !== 1) throw new Denied('device_denied');
    if (args.result && typeof args.result.id === 'string' && ['closed','cancelled'].includes(args.result.state)) {
      await run(this.db,"UPDATE sessions SET state=?,last_seen=? WHERE id=? AND device_id=?",args.result.state,now(),row.session_id,device.id);
    } else if (args.result && typeof args.result.id === 'string' && ['ready','pending_approval'].includes(args.result.state)) {
      // 中文注释：取消后的显式恢复可重新激活；关闭中的任务不会被并发状态查询重新开放。
      await run(this.db,"UPDATE sessions SET state='active',last_seen=? WHERE id=? AND device_id=? AND state='cancelled'",now(),row.session_id,device.id);
    }
    return { received: true };
  }
  async revoke(id, owner) {
    const device = await first(this.db, 'SELECT id FROM devices WHERE id=? AND owner_id=?', id, owner);
    if (!device) throw new Denied('device_denied');
    await this.db.batch([
      this.db.prepare("UPDATE devices SET state='revoked',token_hash=?,code_hash=NULL WHERE id=? AND owner_id=?").bind(await hash(crypto.randomUUID()), id, owner),
      this.db.prepare("UPDATE commands SET state=CASE WHEN state='claimed' THEN 'outcome_unknown' ELSE 'revoked' END,args='{}',result=NULL,tool='' WHERE device_id=? AND state IN ('queued','claimed')").bind(id),
    ]);
    return { revoked: true };
  }
  async clearDelivered(owner) {
    // 中文注释：升级时移除旧版留存的执行正文与动作名，不清理尚在传输的请求。
    await run(this.db, "UPDATE commands SET result=NULL,args='{}',tool='',result_delivered=1 WHERE owner_id=? AND response_digest IS NULL AND state NOT IN ('queued','claimed')", owner);
    const old = await this.db.prepare("SELECT id,request_key FROM commands WHERE owner_id=? AND response_digest IS NULL AND state NOT IN ('queued','claimed') AND request_key NOT LIKE 'sha256:%' LIMIT 1000").bind(owner).all();
    for (const row of old.results) await run(this.db, 'UPDATE commands SET request_key=? WHERE id=? AND owner_id=?', 'sha256:' + await hash(row.request_key), row.id, owner);
    return { cleared: true };
  }
}
