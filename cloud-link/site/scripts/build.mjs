import { build } from 'esbuild';
import { mkdir, cp, rm } from 'node:fs/promises';
// 中文注释：Worker 使用浏览器运行时分支；SDK 不打包 Node TCP 或动态代码编译器。
await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await build({ entryPoints: ['worker/index.js'], outfile: 'dist/server/index.js', bundle: true,
  format: 'esm', platform: 'browser', conditions: ['workerd', 'browser'], target: 'es2022' });
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('drizzle', 'dist/drizzle', { recursive: true });
