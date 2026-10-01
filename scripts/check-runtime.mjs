import {readdir, readFile, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
// 中文注释：只检查当前运行链路，生成目录与验收样本不参与源码语法检查。
const roots = ['native-extension', 'executor-plugin/desktop', 'page-semantics',
  'browser-interactions', 'browser-workspaces', 'browser-diagnostics/js', 'approval-policy', 'scripts'];
async function check(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (['node_modules', 'dist-native', 'test', 'tests', 'evidence'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(mjs|js)$/.test(file) && !/\.test\./.test(file)) {
      const run = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
      if (run.status !== 0) throw Error(run.stderr || `syntax check failed: ${file}`);
    }
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'native-extension/manifest.json'), 'utf8'));
// 中文注释：公钥固定扩展身份，防止路径变更或构建过程意外改变宿主允许来源。
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c,16)));
if (extensionId !== 'dhioigkigkkhceflkkkmoljhdaefjohb') throw Error('Extension key does not match the fixed host identity');
if (manifest.manifest_version !== 3 || !manifest.permissions.includes('nativeMessaging')) throw Error('Invalid native manifest');
for (const relative of [manifest.background.service_worker, manifest.action.default_popup]) {
  if (!(await stat(path.join(root, 'native-extension', relative))).isFile()) throw Error(`Missing ${relative}`);
}
if (!process.argv.includes('--manifest')) for (const folder of roots) await check(path.join(root, folder));
console.log('Native runtime checks passed');
