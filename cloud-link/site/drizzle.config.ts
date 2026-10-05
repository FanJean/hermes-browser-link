import { defineConfig } from 'drizzle-kit';
// 中文注释：生产只使用发布前迁移，不在请求中创建或修改表结构。
export default defineConfig({ dialect: 'sqlite', schema: './db/schema.ts', out: './drizzle' });
