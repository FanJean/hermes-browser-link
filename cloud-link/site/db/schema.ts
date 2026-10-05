import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// 中文注释：设备密钥和配对码只保存摘要，用户归属由 Sites 认证请求建立。
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), ownerId: text('owner_id'), tokenHash: text('token_hash').notNull(),
  codeHash: text('code_hash'), instanceId: text('instance_id').notNull(), label: text('label').notNull(),
  origins: text('origins').notNull(), state: text('state').notNull(), expiresAt: integer('expires_at').notNull(),
  lastSeen: integer('last_seen'), browserConnected: integer('browser_connected').notNull().default(0),
  fullAccess: integer('full_access').notNull().default(0),
  accessScope: text('access_scope').notNull().default('selected_sites'), browser: text('browser').notNull().default('chrome'),
}, table => [uniqueIndex('idx_devices_token').on(table.tokenHash), uniqueIndex('idx_devices_code').on(table.codeHash),
  index('idx_devices_owner').on(table.ownerId, table.state)]);

// 中文注释：云端工作会话由服务端创建；模型只能引用已归属于当前用户和设备的会话。
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id), createdAt: integer('created_at').notNull(),
  // 中文注释：会话生命周期属于通信路由，关闭后不再接收新页面动作。
  state: text('state').notNull().default('active'), lastSeen: integer('last_seen').notNull().default(0),
});

// 中文注释：仅保留通信信封和去重摘要；正文取走即清除，不作为云端执行日志。
export const commands = sqliteTable('commands', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  requestKey: text('request_key').notNull(), digest: text('digest').notNull(), tool: text('tool').notNull(),
  args: text('args').notNull(), state: text('state').notNull(), result: text('result'),
  createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(),
  claimedAt: integer('claimed_at'), resultExpiresAt: integer('result_expires_at'),
  responseDigest: text('response_digest'), resultDelivered: integer('result_delivered').notNull().default(0),
}, table => [uniqueIndex('idx_commands_request').on(table.ownerId, table.deviceId, table.sessionId, table.requestKey),
  index('idx_commands_queue').on(table.deviceId, table.state, table.createdAt)]);
