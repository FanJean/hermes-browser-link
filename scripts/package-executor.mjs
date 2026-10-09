import {verifyPackageVersions} from './package-version.mjs';
import { mkdir, readdir, readFile, writeFile, copyFile, lstat, rm, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) { const i=args.indexOf(name); return i<0?fallback:args[i+1]; }
const source=path.resolve(option('--source',path.join(import.meta.dirname,'..')));
const output=path.resolve(option('--output',path.join(source,'artifacts','browser-link-release')));
// 中文注释：默认产出开发候选；只有显式 --release 版本号、且源码工作区干净时才写正式发布状态并记录提交。
const releaseVersion=option('--release',null);
if(releaseVersion!==null&&!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion))throw new Error('--release expects a stable version such as 1.3.0');
function releaseCommit(){
  const status=spawnSync('git',['-C',source,'status','--porcelain','--untracked-files=normal'],{encoding:'utf8'});
  if(status.status!==0)throw new Error('Formal release needs a git checkout');
  if(status.stdout.trim())throw new Error('Formal release refuses a dirty source tree; commit first');
  const head=spawnSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'});
  if(head.status!==0||!/^[0-9a-f]{40}$/.test(head.stdout.trim()))throw new Error('Formal release cannot read HEAD');
  return head.stdout.trim();
}
// 中文注释：禁止发布状态文件与实际插件/扩展版本不一致。
const declaredVersion=await verifyPackageVersions(source);
if(releaseVersion&&releaseVersion!==declaredVersion)throw Error('Package versions must match');
const commit=releaseVersion?releaseCommit():null;
// 中文注释：正式包的每个输入都必须来自 Git 跟踪内容，忽略文件也不能混入提交声明。
const tracked=commit?new Set(spawnSync('git',['-C',source,'ls-files','-z'],{encoding:'utf8'}).stdout.split('\0').filter(Boolean)):null;
const skip=new Set(['node_modules','.git','.env','profiles','artifacts','evidence','.tmp','__pycache__','.pytest_cache','tests','test','token','token.json','bridge.sock','tasks.json','daemon.lock','service.pid']);
const hashes={};
const modules = ['page-semantics', 'browser-interactions', 'approval-policy'];
function excluded(name) {
  return skip.has(name) || name.startsWith('.') || /^(?:dist-native|coverage|downloads|ingress|approvals|file-artifacts|file-spool|sessions|logs|secrets|credentials)$/.test(name)
    || /^(?:auth|credentials|cookies|storage[-_]?state|session|secrets)(?:\.|$)/i.test(name)
    || /(?:^test\.|\.test\.|\.spec\.|^evidence\.|^test-output|\.log$|\.pyc$|\.pem$|\.key$|\.har$|^screenshot.*\.png$|\.sqlite(?:3)?$|\.db$)/i.test(name);
}

async function copyTree(from,to,excludeRoot=new Set()) {
  await mkdir(to,{recursive:true});
  for(const entry of await readdir(from,{withFileTypes:true})) {
    if(excluded(entry.name) || excludeRoot.has(entry.name)) continue;
    const src=path.join(from,entry.name), dst=path.join(to,entry.name);
    if(entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${src}`);
    if(entry.isDirectory()) await copyTree(src,dst);
    else if(entry.isFile()) await copyFile(src,dst);
  }
  if ((await readdir(to)).length === 0) await rmdir(to);
}
async function record(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${file}`);
    if(entry.isDirectory()) await record(file);
    else if(entry.isFile()) hashes[path.relative(output,file).split(path.sep).join('/')]=createHash('sha256').update(await readFile(file)).digest('hex');
    else throw new Error(`Unsupported package entry: ${file}`);
  }
}
const nativeModules = ['browser-workspaces/index.mjs', 'browser-diagnostics/js/diagnostics.mjs'];
const diagnosticsPackage = 'browser-diagnostics/python/browser_diagnostics';
const diagnosticsFiles = ['__init__.py', 'schema.py', 'runtime.py', 'sink.py'];
const inputs = ['package.json','package-lock.json','cloud-link/site/package.json','cloud-link/site/package-lock.json','executor-plugin','native-bridge','native-extension', 'cloud-link', 'browser-workspaces', 'browser-diagnostics', ...modules,
  'CHANGELOG.md','docs'];
async function sourceSnapshot() {
  const entries = {};
  async function visit(relative) {
    const file = path.join(source,relative), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${file}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) if (!excluded(name)&&!(relative==='cloud-link'&&name==='site')) await visit(path.join(relative,name));
    } else if (stat.isFile()) {
      if(tracked&&!tracked.has(relative.split(path.sep).join('/')))throw new Error(`Formal release input is not tracked: ${relative}`);
      entries[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  for (const input of [...inputs,'scripts/install-executor.py','scripts/install-cli.py','install.sh','docs/installation.md','LICENSE']) await visit(input);
  return JSON.stringify(entries);
}
function localPath(reference) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return null;
  let decoded;
  try { decoded=decodeURIComponent(reference.split(/[?#]/,1)[0]); }
  catch { throw new Error(`Invalid encoded package reference: ${reference}`); }
  if (!decoded || decoded.includes('*')) return null;
  return decoded;
}
async function resolvePackagedReference(root, from, reference) {
  const rel=localPath(reference);
  if (rel === null) return;
  const candidate=path.resolve(rel.startsWith('/') ? root : path.dirname(from), rel.startsWith('/') ? rel.slice(1) : rel);
  if (candidate !== root && !candidate.startsWith(root+path.sep)) throw new Error(`Package reference escapes its root: ${path.relative(root,from)} -> ${reference}`);
  const candidates=path.extname(candidate) ? [candidate] : [candidate,`${candidate}.mjs`,`${candidate}.js`,`${candidate}.cjs`,`${candidate}.json`,path.join(candidate,'index.mjs'),path.join(candidate,'index.js')];
  for (const file of candidates) {
    try {
      const stat=await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${file}`);
      if (stat.isFile()) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Unresolved packaged reference: ${path.relative(root,from)} -> ${reference}`);
}
async function verifyRuntimeClosure(root) {
  const files=[];
  async function visit(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`Unsupported package entry: ${file}`);
    }
  }
  await visit(root);
  for (const file of files) {
    const ext=path.extname(file).toLowerCase();
    if (!['.js','.mjs','.cjs','.html','.css'].includes(ext)) continue;
    const text=await readFile(file,'utf8');
    const refs=[];
    if (['.js','.mjs','.cjs'].includes(ext)) {
      for (const match of text.matchAll(/\bimport\s*(['"])(\.{1,2}\/[^'"]+)\1/g)) refs.push(match[2]);
      for (const match of text.matchAll(/\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) refs.push(match[2]);
      for (const match of text.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1/g)) refs.push(match[2]);
      for (const match of text.matchAll(/\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) refs.push(match[2]);
    }
    if (ext === '.html') {
      for (const match of text.matchAll(/\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi)) refs.push(match[2]);
    }
    if (ext === '.css') {
      for (const match of text.matchAll(/\burl\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) refs.push(match[2]);
      for (const match of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) refs.push(match[2]);
    }
    for (const reference of refs) await resolvePackagedReference(root,file,reference);
  }
  const manifestPath=path.join(root,'manifest.json');
  try {
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    const refs=[];
    for (const value of [manifest.background?.service_worker,manifest.action?.default_popup,manifest.options_page,
      manifest.options_ui?.page,manifest.devtools_page,manifest.side_panel?.default_path,
      ...Object.values(manifest.icons||{}),...Object.values(manifest.action?.default_icon||{}),
      ...Object.values(manifest.browser_action?.default_icon||{}),...Object.values(manifest.page_action?.default_icon||{}),
      ...Object.values(manifest.chrome_url_overrides||{})]) if (typeof value==='string') refs.push(value);
    for (const script of manifest.content_scripts||[]) refs.push(...(script.js||[]),...(script.css||[]));
    for (const group of manifest.web_accessible_resources||[]) refs.push(...(group.resources||[]));
    for (const reference of refs) await resolvePackagedReference(root,manifestPath,reference);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
async function verifyLayout(root) {
  const actualFiles=new Set(), actualDirs=new Set();
  async function visit(directory,relative='') {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const name=path.posix.join(relative,entry.name), file=path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in package: ${file}`);
      if (entry.isDirectory()) { actualDirs.add(name); await visit(file,name); }
      else if (entry.isFile()) actualFiles.add(name);
      else throw new Error(`Unsupported package entry: ${file}`);
    }
  }
  await visit(root);
  const expectedDirs=new Set();
  for (const file of actualFiles) {
    let parent=path.posix.dirname(file);
    while (parent!=='.') { expectedDirs.add(parent); parent=path.posix.dirname(parent); }
  }
  const emptyOrExtra=[...actualDirs].filter(name=>!expectedDirs.has(name)).sort();
  const missing=[...expectedDirs].filter(name=>!actualDirs.has(name)).sort();
  if (emptyOrExtra.length||missing.length) throw new Error(`Incomplete package directory layout: extra=${JSON.stringify(emptyOrExtra)} missing=${JSON.stringify(missing)}`);
  for (const required of ['browser-link/plugin.yaml','browser-link/script_lane/host_bridge.py',
    // 中文注释：自动更新必须携带完整维护入口与事务安装器。
    'browser-link/maintenance/update.py','browser-link/maintenance/install-cli.py','browser-link/maintenance/install-executor.py',
    'browser-link/script_lane/action_session.py','browser-link/script_lane/child.py',
    'browser-link/script_lane/tool.py','browser-link/open_tool.py',
    'browser-link/skills/use-my-browser/SKILL.md','native-extension/manifest.json',
    // 中文注释：四尺寸扩展图标是发布必需文件，构建与包清单同时验收。
    'native-extension/icon-16.png','native-extension/icon-32.png','native-extension/icon-48.png','native-extension/icon-128.png',
    'docs/python-scripting.md','docs/CHANGELOG.md',
    'LICENSE','README.md',
    'INSTALL.txt','RELEASE-STATUS.txt','install-executor.py','install-cli.py','install.sh']) {
    if (!actualFiles.has(required)) throw new Error(`Incomplete package layout: missing ${required}`);
  }
  const roots=new Set([...actualFiles].map(name=>name.split('/')[0]));
  const expectedRoots=new Set(['browser-link','native-extension','docs','LICENSE','README.md','INSTALL.txt','RELEASE-STATUS.txt','install-executor.py','install-cli.py','install.sh']);
  if (roots.has('SHA256SUMS.json')) expectedRoots.add('SHA256SUMS.json');
  if (roots.size!==expectedRoots.size||[...roots].some(name=>!expectedRoots.has(name))) throw new Error(`Unexpected package root layout: ${JSON.stringify([...roots].sort())}`);
  return actualFiles;
}
async function verifyGeneratedManifest() {
  const manifestPath=path.join(output,'SHA256SUMS.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const actual=await verifyLayout(output);
  actual.add('SHA256SUMS.json');
  if (actual.size!==Object.keys(manifest).length+1 || [...actual].some(name=>name!=='SHA256SUMS.json'&&!Object.hasOwn(manifest,name))) {
    throw new Error('Generated SHA256SUMS.json does not enumerate the exact package file set');
  }
  for (const [name,digest] of Object.entries(manifest)) {
    const actualDigest=createHash('sha256').update(await readFile(path.join(output,name))).digest('hex');
    if (actualDigest!==digest) throw new Error(`Generated SHA256SUMS.json hash mismatch: ${name}`);
  }
}
let outputCreated = false;
try {
  for (const input of [...inputs,'scripts/install-executor.py','scripts/install-cli.py','install.sh','docs/installation.md','LICENSE']) {
    const directory=path.join(source,input);
    if(output===directory || output.startsWith(directory+path.sep)) throw new Error('Output cannot be inside an input directory');
  }
  // 中文注释：候选包必须同时包含文件登记模块，缺失时拒绝生成不完整包。
  // 中文注释：私有凭据通道是安装闭包的一部分，缺任一端时禁止产出发行包。
  for(const required of ['native-bridge/cookie_mirror.py','native-extension/cookie-mirror.mjs','native-bridge/api_client.py','native-bridge/artifacts.py','native-bridge/downloads.py','native-bridge/cdp_gateway.py','native-bridge/vault_private.py','native-bridge/vault_client.py','native-bridge/daemon.py','native-bridge/client.py','native-bridge/host.py','native-extension/manifest.json','executor-plugin/plugin.yaml','executor-plugin/__init__.py','LICENSE','page-semantics/index.js','browser-interactions/index.mjs','approval-policy/policy.mjs','native-extension/build.mjs',
    'executor-plugin/script_lane/host_bridge.py','executor-plugin/script_lane/action_session.py','executor-plugin/script_lane/child.py','executor-plugin/script_lane/tool.py',
    'executor-plugin/single_tool_adapter/integration.py','executor-plugin/single_tool_adapter/adapter.py',
    'executor-plugin/vault_adapter/__init__.py','executor-plugin/vault_adapter/adapter.py',
    'executor-plugin/vault_adapter/integration.py','executor-plugin/vault_adapter/official_source.py',
    'CHANGELOG.md','docs/python-scripting.md','docs/installation.md','scripts/install-cli.py','install.sh',
    // 中文注释：先核对更新入口，再创建输出目录，避免缺模块时留下不完整产物。
    'executor-plugin/maintenance/update.py',
    ...nativeModules, ...diagnosticsFiles.map(name => `${diagnosticsPackage}/${name}`)]) {
    const info=await lstat(path.join(source,required)).catch(error=>{if(error?.code==='ENOENT')return null;throw error;});
    if(!info?.isFile()) throw new Error(`Missing input ${required}`);
  }
  const before = await sourceSnapshot();
  await mkdir(path.dirname(output),{recursive:true});
  await mkdir(output); // existing target is always refused
  outputCreated = true;
  await copyTree(path.join(source,'executor-plugin'),path.join(output,'browser-link'));
  // 中文注释：自动更新组件携带相同安装器，下载新包后仍用当前可信代码校验及事务升级。
  for (const name of ['install-cli.py','install-executor.py']) {
    await copyFile(path.join(source,'scripts',name),path.join(output,'browser-link/maintenance',name));
  }
  for (const module of modules) await copyTree(path.join(source,module),path.join(output,'browser-link',module));
  // Only the native runtime JS entries, not module tests, scripts or evidence.
  for (const relative of nativeModules) {
    const destination = path.join(output, 'browser-link', relative);
    await mkdir(path.dirname(destination), {recursive:true});
    await copyFile(path.join(source, relative), destination);
  }
  // 中文注释：独立 ESM 边界避免依赖仓库根目录的 package.json。
  await writeFile(path.join(output,'browser-link/package.json'), JSON.stringify({private:true,type:'module'})+'\n');
  await copyTree(path.join(source,'native-bridge'),path.join(output,'browser-link','native_bridge'));
  // 中文注释：云端只打包本机运行时，网页源码、执行证据和服务器配置不进入扩展安装包。
  await copyTree(path.join(source,'cloud-link'),path.join(output,'browser-link','cloud_link'),new Set(['site','evidence','tests']));
  const diagnosticsOutput = path.join(output, 'browser-link/native_bridge/browser_diagnostics');
  await mkdir(diagnosticsOutput, {recursive:true});
  for (const name of diagnosticsFiles) await copyFile(path.join(source, diagnosticsPackage, name), path.join(diagnosticsOutput, name));
  // 中文注释：只在独立输出目录构建，不修改工作区的 dist-native。
  const build = spawnSync(process.execPath,[path.join(source,'native-extension/build.mjs'),path.join(output,'native-extension')],{encoding:'utf8',timeout:30000});
  if(build.status!==0) throw new Error(`Native build failed: ${build.stderr || build.error}`);
  await copyFile(path.join(source,'LICENSE'),path.join(output,'LICENSE'));
  // 中文注释：发布包携带通用入口，用户不需要 Node.js。
  await copyFile(path.join(source,'scripts/install-executor.py'),path.join(output,'install-executor.py'));
  await copyFile(path.join(source,'scripts/install-cli.py'),path.join(output,'install-cli.py'));
  await copyFile(path.join(source,'install.sh'),path.join(output,'install.sh'));
  // 中文注释：安装文档作为包根 README 时，将同目录文档链接改为 docs/ 下的路径。
  const installation = await readFile(path.join(source,'docs/installation.md'),'utf8');
  await writeFile(path.join(output,'README.md'),installation.replace(/\]\((agent-install-prompt|configuration|development)\.md\)/g,'](docs/$1.md)'));
  await mkdir(path.join(output,'docs'));
  // 中文注释：模块索引与生成接口参考随包分发，避免脚本文档链接指向缺失文件。
  await copyTree(path.join(source,'docs'),path.join(output,'docs'));
  await copyFile(path.join(source,'CHANGELOG.md'),path.join(output,'docs/CHANGELOG.md'));
  await writeFile(path.join(output,'RELEASE-STATUS.txt'),releaseVersion?
    // 中文注释：旧更新器只识别 RELEASE V 前缀，必须在其进入旧 CLI 前拒绝共享安装包。
    `SHARED RELEASE V${releaseVersion}: formal release built from commit ${commit}. See docs/CHANGELOG.md for the verified scope and stated limits.\n`:
    `NOT FROZEN: V${declaredVersion} remains a development candidate, not a formal release. See docs/CHANGELOG.md for acceptance limits.\n`);
  // 中文注释：安装说明仅提供命令和操作；发布构建信息仍在 RELEASE-STATUS.txt。
  await writeFile(path.join(output,'INSTALL.txt'),`Browser Link ${releaseVersion || declaredVersion}
Run ./install.sh. Python 3.11+ and Hermes are needed; source installation also needs Node.js 22.12+.
Currently supported: macOS + Chrome/Edge. Tested with Hermes 0.21.4.
One shared program at <shared-root>/plugins/browser-link; named profiles use direct links, while profile settings and private data remain separate.
Upgrade migrates existing program copies without enabling disabled profiles; backups and the Hermes Desktop UI cache are retained separately.
Load the printed extension directory, confirm connection authorization in the extension and restart Hermes Desktop; ordinary task-page actions run directly.
Takeover, stop and credential protection remain available. Cookie mirroring and adopting an existing OAuth login window require separate confirmation.
Upgrade: ./install.sh --upgrade, then reload the extension and restart Hermes Desktop.
Automatic updates: ./install.sh --auto-update install (hourly, waits until browsers and Hermes exit).
Check only: ./install.sh --check-update. Update now: ./install.sh --update. Disable: ./install.sh --auto-update off.
Uninstall: ./install.sh --uninstall (keeps task data); add --purge to delete it.
Preview: ./install.sh --dry-run. Directory details: ./install.sh --verbose.
Read README.md for profiles, the connection check command and troubleshooting.
`);
  await verifyRuntimeClosure(path.join(output,'browser-link'));
  await verifyRuntimeClosure(path.join(output,'native-extension'));
  await verifyLayout(output);
  if (before !== await sourceSnapshot()) throw new Error('Source changed during packaging; discard this incomplete output and retry after writers finish');
  await record(output);
  await writeFile(path.join(output,'SHA256SUMS.json'),JSON.stringify(hashes,null,2)+'\n');
  await verifyGeneratedManifest();
  console.log(JSON.stringify({output,files:Object.keys(hashes).length,releaseStatus:releaseVersion?`RELEASE V${releaseVersion}`:'NOT FROZEN',...(commit?{commit}:{})}));
} catch(error) {
  console.error(error.message);
  if (outputCreated) {
    try { await rm(output,{recursive:true,force:true}); } catch {}
  }
  process.exitCode=1;
}
