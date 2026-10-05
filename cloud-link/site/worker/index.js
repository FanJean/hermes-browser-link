import packageInfo from '../package.json' with { type: 'json' };
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import schemas from './schemas.json' with { type: 'json' };
import { Store, Denied, body, json, user, sameOrigin } from './store.js';
import { page } from './page.js';

const validator = new CfWorkerJsonSchemaValidator();
const id = { type: 'string', minLength: 1, maxLength: 256 };
const descriptions = {
  create: '为当前对话创建独立任务，每个对话分别 create，request_id 必须用全新 UUID。返回专属 session_id 和 command_id；不要引用其他对话的 session_id。用 result 查询 task_id。',
  list: '列出指定云端会话的本机任务，返回 command_id，用 result 查询。',
  get: '回读指定云端会话的本机任务及审批状态，返回 command_id。',
  run: '在云端任务页执行一个动作，返回 command_id。可并发提交不同 tab_id 的操作；同一页面按提交顺序执行，new_tab 和关闭是任务屏障。审批在本机确认。用 result 获取各自回执，未知结果不能重发。结束时 close，取消等待时 cancel。',
  cancel: '取消此云端任务，不影响本地任务，返回 command_id。',
  resume: '为云端任务重新取得本机授权，不重放原动作，返回 command_id。',
  close: '完成网页任务后、回复用户前必须调用，默认关闭此任务新建的工作页；keep_tabs=true 仅用于交还用户继续操作。返回 command_id，必须用 result 核实关闭和清理状态。',
};
export const toolDefinitions = [
  { name: 'cloud_browser_devices', description: '列出当前用户已配对的浏览器、在线状态和允许的网站。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true },
  { name: 'cloud_browser_result', description: '查询同一 command_id；queued/claimed 时继续查询。完成正文只交付一次，result_delivered=true 且 result=null 时不得重发动作；用 get/list 核对本机任务。未知结果不能重发动作。',
    inputSchema: { type: 'object', properties: { command_id: id }, required: ['command_id'], additionalProperties: false }, readOnly: true },
  ...Object.entries(schemas).map(([suffix, schema]) => ({ name: 'cloud_browser_' + suffix, suffix,
    description: descriptions[suffix], readOnly: false,
    inputSchema: { ...schema, properties: { ...schema.properties, device_id: id,
      request_id: { ...id, ...(suffix === 'create' ? {format:'uuid'} : {}), description: '使用全新 UUID；同会话同标记同参数返回原命令，改参拒绝。' },
      ...(suffix === 'create' ? {} : { session_id: id }) },
      required: [...schema.required, 'device_id', 'request_id', ...(suffix === 'create' ? [] : ['session_id'])] },
  })),
];

async function mcp(store, request) {
  // 中文注释：Sites 转发没有保留 MCP 路由头；按原请求体恢复非认证头，身份与权限仍由平台和工具校验。
  // 已有路由头不覆盖，头与请求体不一致时仍由官方 SDK 拒绝；站点外请求不做此处理。
  if (request.method === 'POST' && request.headers.has('x-dispatched-app')
      && request.headers.get('mcp-protocol-version') === '2026-07-28') {
    const parsed = await body(request.clone());
    const headers = new Headers(request.headers);
    if (!headers.has('mcp-method') && typeof parsed.method === 'string') headers.set('mcp-method', parsed.method);
    if (!headers.has('mcp-name') && typeof parsed.params?.name === 'string') headers.set('mcp-name', parsed.params.name);
    request = new Request(request, { headers });
  }
  // 中文注释：每次 HTTP 创建独立实例，业务状态统一保存在 D1，身份由 Sites 平台注入。
  const handler = createMcpHandler(() => {
    // 中文注释：版本取自包元数据；云端无法获知对话结束，要求调用方结束前关闭并核实回执。
    const server = new McpServer({ name: 'hermes-browser-link-cloud', version: packageInfo.version },
      { instructions: '每个对话独立创建浏览器任务。完成网页任务后、回复用户之前，必须调用 cloud_browser_close，并用 cloud_browser_result 核实 state=closed 和 cleanupState。需要用户继续操作时才设置 keep_tabs=true。关闭结果未知时只查询状态，不重放动作。' });
    for (const definition of toolDefinitions) server.registerTool(definition.name, {
      description: definition.description, inputSchema: fromJsonSchema(definition.inputSchema, validator),
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: !definition.readOnly,
        idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
    }, async args => {
      try {
        const owner = user(request);
        const result = definition.name === 'cloud_browser_devices' ? { devices: await store.devices(owner) }
          : definition.name === 'cloud_browser_result' ? await store.result(owner, args.command_id)
            : await store.enqueue(owner, definition.suffix, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const code = error instanceof Denied ? error.message : 'cloud_unavailable';
        return { content: [{ type: 'text', text: JSON.stringify({ code, retryable: false }) }], isError: true };
      }
    });
    return server;
  });
  return handler.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      sameOrigin(request);
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') {
        user(request);
        return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'" } });
      }
      const store = new Store(env.DB);
      if (path === '/mcp') return await mcp(store, request);
      if (path === '/api/devices' && request.method === 'GET') return json({ devices: await store.devices(user(request)) });
      if (request.method !== 'POST') return json({ code: 'not_found' }, 404);
      if (path.startsWith('/api/')) {
        // 中文注释：配对与撤销必须是本站的明确 POST，不能由跨站表单或预取触发。
        if (request.headers.get('origin') !== new URL(request.url).origin) throw new Denied('origin_required');
        const owner = user(request); const args = await body(request);
        if (path === '/api/pair/inspect') return json(await store.pairing(owner, args.code, false));
        if (path === '/api/pair/approve') return json(await store.pairing(owner, args.code, true));
        if (path === '/api/device/revoke') return json(await store.revoke(args.device_id, owner));
        if (path === '/api/communication/clear') return json(await store.clearDelivered(owner));
      }
      if (path === '/device/pair') return json(await store.pair(request, await body(request)));
      if (path.startsWith('/device/')) {
        const device = await store.device(request, ['/device/poll', '/device/revoke', '/device/heartbeat','/device/exchange'].includes(path));
        if (path === '/device/exchange') return json(await store.exchange(device, await body(request)));
        if (path === '/device/poll') return json(await store.poll(device));
        if (path === '/device/heartbeat') {
          // 中文注释：心跳不领取命令，长操作期间仍能核验撤销并保持在线状态。
          return json(await store.heartbeat(device, await body(request)));
        }
        if (path === '/device/result') return json(await store.complete(device, await body(request)));
        if (path === '/device/revoke') {
          if (device.state === 'pending') {
            await env.DB.prepare("UPDATE devices SET state='revoked' WHERE id=?").bind(device.id).run();
            return json({ revoked: true });
          }
          return json(await store.revoke(device.id, device.owner_id));
        }
      }
      return json({ code: 'not_found' }, 404);
    } catch (error) {
      // 中文注释：不返回数据库、令牌、网页原文或异常栈。
      return json({ code: error instanceof Denied ? error.message : 'cloud_unavailable' }, error instanceof Denied ? error.status : 503);
    }
  },
};
