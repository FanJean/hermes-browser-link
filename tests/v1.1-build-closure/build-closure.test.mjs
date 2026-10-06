import {verifyPackageVersions} from '../../scripts/package-version.mjs';
/* eslint-disable security/detect-non-literal-fs-filename -- file paths are confined to owned scratch fixtures or staged output roots. */
/* eslint-disable security/detect-object-injection -- lookup keys come from fixed closure maps and build manifests under test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
// 中文注释：构建验收只使用系统临时目录，避免写入实际 Hermes 安装。
const scratch = await realpath(tmpdir());
const dependencyFiles = [
  'browser-workspaces/index.mjs',
  'browser-diagnostics/js/diagnostics.mjs',
  'approval-policy/policy.mjs',
  'page-semantics/index.js',
  'page-semantics/parser.mjs',
  'browser-interactions/index.mjs',
];
const sourceCopies = [
  // 中文注释：新增工作窗口和效果模块同样进入显式构建闭包。
  'action-effects.mjs', 'work-window.mjs', 'work-window.html',
  'manifest.json',
  // 中文注释：四种尺寸图标必须逐字复制，发布包不能遗漏资源。
  'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png',
  // 中文注释：独立云端连接和弹窗必须进入显式产物清单并逐字核验。
  'cloud-link.mjs', 'cloud-popup.mjs',
  'bridge.mjs',
  'request-ledger.mjs',
  'background.mjs',
  'automation-overlay.mjs',
  'interaction-highlight.mjs',
  'official-actions.mjs',
  'downloads.mjs',
  'page-runtime.mjs', 'network-evidence.mjs', 'content-filter.mjs', 'content-shield.mjs',
  'cdp-policy.mjs',
  'page-observers.mjs',
  // 中文注释：有界页面观察是 1.4.4 起的运行依赖，必须逐字复制并校验哈希。
  'page-observation.mjs',
  'vault.mjs',
  'approval-notifier.mjs',
  'approval-panel.html',
  'approval-panel.css',
  'approval-panel.mjs',
  'popup.html',
  'popup.css',
  'popup.mjs',
];
const vendorSources = {
  'cookie-mirror.mjs': 'native-extension/cookie-mirror.mjs',
  'vendor/browser-workspaces.mjs': 'browser-workspaces/index.mjs',
  'vendor/browser-diagnostics.mjs': 'browser-diagnostics/js/diagnostics.mjs',
  'vendor/approval-policy.mjs': 'approval-policy/policy.mjs',
  'vendor/page-parser.mjs': 'page-semantics/parser.mjs',
  'vendor/page-semantics.mjs': 'page-semantics/index.js',
  'vendor/browser-interactions.mjs': 'browser-interactions/index.mjs',
};
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function fixture(parent) {
  const sourceRoot = path.join(parent, 'source');
  await mkdir(sourceRoot, {recursive: true});
  await cp(path.join(root, 'native-extension'), path.join(sourceRoot, 'native-extension'), {
    recursive: true,
    filter: source => !source.split(path.sep).includes('dist-native'),
  });
  for (const relative of dependencyFiles) {
    const destination = path.join(sourceRoot, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await cp(path.join(root, relative), destination);
  }
  return sourceRoot;
}

function runBuild(sourceRoot, output) {
  return spawnSync(process.execPath, [path.join(sourceRoot, 'native-extension/build.mjs'), ...(output ? [output] : [])], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(file));
    else files.push(file);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function outputHashes(directory) {
  const rows = [];
  for (const file of await collectFiles(directory)) {
    rows.push([path.relative(directory, file).split(path.sep).join('/'), sha256(await readFile(file))]);
  }
  return Object.fromEntries(rows);
}

async function assertRelativeClosure(directory) {
  const rootPath = path.resolve(directory);
  const resolveReference = async (from, reference, rootRelative = false) => {
    if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return;
    const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    if (!pathname) return;
    const useRoot = rootRelative || pathname.startsWith('/');
    const target = path.resolve(useRoot ? rootPath : from, useRoot ? pathname.replace(/^[/\\]+/, '') : pathname);
    const relative = path.relative(rootPath, target);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${reference} escapes staged extension`);
    assert.equal((await stat(target)).isFile(), true, `${path.relative(rootPath, from)} references missing ${reference}`);
  };
  const files = await collectFiles(rootPath);
  const manifest = JSON.parse(await readFile(path.join(rootPath, 'manifest.json'), 'utf8'));
  const manifestReferences = [
    manifest.background?.service_worker,
    ...(manifest.background?.scripts || []),
    manifest.action?.default_popup,
    manifest.browser_action?.default_popup,
    manifest.page_action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.side_panel?.default_path,
    manifest.devtools_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])]),
    ...(manifest.web_accessible_resources || []).flatMap(resource => resource.resources || []),
  ].filter(value => typeof value === 'string');
  for (const reference of manifestReferences) await resolveReference(rootPath, reference, true);

  const modulePatterns = [
    /\b(?:from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  ];
  const htmlPattern = /\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi;
  const cssPatterns = [
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    /@import\s+(['"])([^'"]+)\1/gi,
  ];
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!['.mjs', '.js', '.html', '.css'].includes(extension)) continue;
    const code = await readFile(file, 'utf8');
    if (extension === '.mjs' || extension === '.js') {
      for (const pattern of modulePatterns) for (const match of code.matchAll(pattern)) await resolveReference(path.dirname(file), match[2]);
    } else if (extension === '.html') {
      for (const match of code.matchAll(htmlPattern)) await resolveReference(path.dirname(file), match[2]);
    } else {
      for (const pattern of cssPatterns) for (const match of code.matchAll(pattern)) await resolveReference(path.dirname(file), match[2]);
    }
  }
}

async function assertBuildContents(sourceRoot, output) {
  const expectedFiles = [
    ...sourceCopies,
    'core.mjs',
    'workspace-adapter.mjs',
    'BUILD-DEPS.json',
    ...Object.keys(vendorSources),
  ].sort();
  const actualFiles = (await collectFiles(output)).map(file => path.relative(output, file).split(path.sep).join('/')).sort();
  assert.deepEqual(actualFiles, expectedFiles, 'staged layout stays explicit and excludes unrelated/unintegrated modules');
  assert.equal(actualFiles.some(file => file.startsWith('browser-files/')), false);

  for (const relative of sourceCopies) {
    const staged = await readFile(path.join(output, relative));
    const source = await readFile(path.join(sourceRoot, 'native-extension', relative));
    assert.deepEqual(staged, source, `${relative} source`);
    assert.equal(sha256(staged), sha256(source), `${relative} source hash`);
  }
  const sourceCore = await readFile(path.join(sourceRoot, 'native-extension/core.mjs'), 'utf8');
  const expectedCore = sourceCore
    .replace("from '../browser-diagnostics/js/diagnostics.mjs'", "from './vendor/browser-diagnostics.mjs'")
    .replace("from '../approval-policy/policy.mjs'", "from './vendor/approval-policy.mjs'")
    .replace("from '../page-semantics/parser.mjs'", "from './vendor/page-parser.mjs'")
    .replace("from '../page-semantics/index.js'", "from './vendor/page-semantics.mjs'")
    .replace("from '../browser-interactions/index.mjs'", "from './vendor/browser-interactions.mjs'");
  assert.equal(await readFile(path.join(output, 'core.mjs'), 'utf8'), expectedCore);
  const expectedAdapter = (await readFile(path.join(sourceRoot, 'native-extension/workspace-adapter.mjs'), 'utf8'))
    .replace("from '../browser-workspaces/index.mjs'", "from './vendor/browser-workspaces.mjs'");
  assert.equal(await readFile(path.join(output, 'workspace-adapter.mjs'), 'utf8'), expectedAdapter);

  const deps = JSON.parse(await readFile(path.join(output, 'BUILD-DEPS.json'), 'utf8'));
  assert.deepEqual(Object.keys(deps.dependencies).sort(), Object.keys(vendorSources).sort());
  for (const [staged, source] of Object.entries(vendorSources)) {
    const bytes = await readFile(path.join(sourceRoot, source));
    assert.deepEqual(await readFile(path.join(output, staged)), bytes, `${staged} source`);
    assert.equal(deps.dependencies[staged].source, source);
    assert.equal(deps.dependencies[staged].sha256, sha256(bytes), `${staged} source hash`);
    assert.equal(sha256(await readFile(path.join(output, staged))), deps.dependencies[staged].sha256, `${staged} staged hash`);
  }

  const sourceManifest = JSON.parse(await readFile(path.join(sourceRoot, 'native-extension/manifest.json'), 'utf8'));
  const stagedManifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(stagedManifest.permissions, sourceManifest.permissions, 'build must not add permissions');

  for (const file of await collectFiles(output)) {
    if (!['.mjs', '.js'].includes(path.extname(file).toLowerCase())) continue;
    const syntax = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8', timeout: 10000});
    assert.equal(syntax.status, 0, `${path.relative(output, file)} syntax: ${syntax.stderr}`);
  }
  await assertRelativeClosure(output);
}

test('native build refuses an imported runtime module missing from its explicit copy closure', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-missing-'));
  try {
    const sourceRoot = await fixture(work);
    const backgroundPath = path.join(sourceRoot, 'native-extension/background.mjs');
    const background = await readFile(backgroundPath, 'utf8');
    await writeFile(backgroundPath, `${background}\nimport './not-staged.mjs';\n`);

    const result = runBuild(sourceRoot, path.join(work, 'output'));

    assert.notEqual(result.status, 0, 'build must not report a non-closed extension as successful');
    assert.match(`${result.stderr}\n${result.stdout}`, /not-staged\.mjs/);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('native build refuses an HTML resource missing from its explicit copy closure', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-html-'));
  try {
    const sourceRoot = await fixture(work);
    const popupPath = path.join(sourceRoot, 'native-extension/popup.html');
    const popup = await readFile(popupPath, 'utf8');
    await writeFile(popupPath, `${popup}\n<link rel="stylesheet" href="not-staged.css">\n`);

    const result = runBuild(sourceRoot, path.join(work, 'output'));

    assert.notEqual(result.status, 0, 'build must reject an HTML resource absent from the staged extension');
    assert.match(`${result.stderr}\n${result.stdout}`, /not-staged\.css/);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('native build refuses a CSS URL resource missing from its explicit copy closure', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-css-'));
  try {
    const sourceRoot = await fixture(work);
    const cssPath = path.join(sourceRoot, 'native-extension/popup.css');
    const css = await readFile(cssPath, 'utf8');
    await writeFile(cssPath, `${css}\n.logo { background-image: url('./not-staged.svg'); }\n`);

    const result = runBuild(sourceRoot, path.join(work, 'output'));

    assert.notEqual(result.status, 0, 'build must reject a CSS resource absent from the staged extension');
    assert.match(`${result.stderr}\n${result.stdout}`, /not-staged\.svg/);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('clean scratch build is closed, syntactically valid, source-matched and hash-verified', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-clean-'));
  try {
    const sourceRoot = await fixture(work);
    const unintegrated = path.join(sourceRoot, 'browser-files/index.mjs');
    await mkdir(path.dirname(unintegrated), {recursive: true});
    await writeFile(unintegrated, 'export const notIntegrated = true;\n');
    const output = path.join(work, 'native-extension');
    const result = runBuild(sourceRoot, output);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    await assertBuildContents(sourceRoot, output);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('native artifacts are identical before and after another build has populated dist-native', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-order-'));
  try {
    const sourceRoot = await fixture(work);
    const unintegrated = path.join(sourceRoot, 'browser-files/index.mjs');
    await mkdir(path.dirname(unintegrated), {recursive: true});
    await writeFile(unintegrated, 'export const notIntegrated = true;\n');

    const before = path.join(work, 'before-prior-build');
    const first = runBuild(sourceRoot, before);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

    const priorOutput = path.join(sourceRoot, 'native-extension/dist-native');
    const prior = runBuild(sourceRoot, priorOutput);
    assert.equal(prior.status, 0, `${prior.stderr}\n${prior.stdout}`);
    await writeFile(path.join(priorOutput, 'stale-unintegrated.mjs'), 'export const stale = true;\n');

    const after = path.join(work, 'after-prior-build');
    const second = runBuild(sourceRoot, after);
    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
    assert.deepEqual(await outputHashes(after), await outputHashes(before));
    await assertBuildContents(sourceRoot, after);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('native build refuses to replace its source directory without changing it', async () => {
  await mkdir(scratch, {recursive: true});
  const work = await mkdtemp(path.join(scratch, 'v1.1-build-closure-overwrite-'));
  try {
    const sourceRoot = await fixture(work);
    const sourceDir = path.join(sourceRoot, 'native-extension');
    const before = await outputHashes(sourceDir);
    const result = runBuild(sourceRoot, sourceDir);
    assert.notEqual(result.status, 0, 'source directory must never be a build destination');
    assert.match(`${result.stderr}\n${result.stdout}`, /output must not replace source/);
    assert.deepEqual(await outputHashes(sourceDir), before);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});

test('1.8.2 发布入口报告同一个版本', async () => {
  // 中文注释：以包版本为发布基准，插件、桌面 API、扩展和 Native 握手必须一致。
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const plugin = await readFile(path.join(root, 'executor-plugin/plugin.yaml'), 'utf8');
  const version = /^version:\s*([^\s]+)$/m.exec(plugin)?.[1];
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, '1.8.2');
  assert.equal(version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const desktop = JSON.parse(await readFile(path.join(root, 'executor-plugin/dashboard/manifest.json'), 'utf8'));
  const extension = JSON.parse(await readFile(path.join(root, 'native-extension/manifest.json'), 'utf8'));
  // 中文注释：对外的安装包、扩展与插件描述统一中文，避免仅改 GitHub 简介而漏掉管理页元数据。
  assert.match(pkg.description, /[\u4e00-\u9fff]/u);
  assert.match(extension.description, /[\u4e00-\u9fff]/u);
  assert.match(/^description:\s*(.+)$/m.exec(plugin)[1], /[\u4e00-\u9fff]/u);
  const background = await readFile(path.join(root, 'native-extension/background.mjs'), 'utf8');
  assert.equal(desktop.version, version);
  assert.equal(extension.version, version);
  assert.ok(background.includes(`version:'${version}'`));
});

// 中文注释：工具栏独有图标引用也必须闭包检查，不能只检查 manifest.icons。
test('native build rejects a missing toolbar-only icon resource',async()=>{
 const work=await mkdtemp(path.join(scratch,'toolbar-icon-'));
 try{
  const sourceRoot=await fixture(work),manifestPath=path.join(sourceRoot,'native-extension/manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.action.default_icon={'16':'missing-toolbar-icon.png'};
  await writeFile(manifestPath,JSON.stringify(manifest));
  const result=runBuild(sourceRoot,path.join(work,'output'));
  assert.notEqual(result.status,0);assert.match(result.stderr,/missing referenced resource.*missing-toolbar-icon/);
 }finally{await rm(work,{recursive:true,force:true})}
});

// 中文注释：版本漂移必须在构建和打包之前被共用门禁拒绝，不能只靠发布测试发现。
test('版本闭包拒绝桌面、锁文件及运行握手错配',async()=>{
 const work=await mkdtemp(path.join(scratch,'version-closure-'));
 const files=['package.json','package-lock.json','executor-plugin/plugin.yaml','executor-plugin/dashboard/manifest.json','native-extension/manifest.json','native-extension/background.mjs','cloud-link/site/package.json','cloud-link/site/package-lock.json'];
 try{
  for(const file of files){await mkdir(path.dirname(path.join(work,file)),{recursive:true});await cp(path.join(root,file),path.join(work,file));}
  const expected=await verifyPackageVersions(root);assert.equal(await verifyPackageVersions(work),expected);
  for(const file of files){
   const original=await readFile(path.join(work,file),'utf8');
   await writeFile(path.join(work,file),original.replaceAll(expected,'0.0.0'));
   await assert.rejects(verifyPackageVersions(work),/Package versions must match/);
   await writeFile(path.join(work,file),original);
  }
 }finally{await rm(work,{recursive:true,force:true});}
});
