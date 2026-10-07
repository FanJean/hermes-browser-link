/* eslint-disable security/detect-non-literal-fs-filename -- 中文注释：测试只操作临时副本内的固定文件。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {JSON_VERSION_FILES, TEXT_VERSION_FILES, verifyReleaseVersions} from '../../scripts/package-version.mjs';
import {setVersion} from '../../scripts/version-set.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const current = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const parts = current.split('.').map(BigInt);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1n}`;
const inputs = [...JSON_VERSION_FILES, ...TEXT_VERSION_FILES, 'native-extension/background.mjs', 'CHANGELOG.md', 'docs/release-template.md', `docs/release-${current}.md`, 'scripts/package-version.mjs', 'scripts/version-set.mjs'];
async function fixture(fn) {
 const work = await mkdtemp(path.join(tmpdir(), 'bl-version-'));
 try {
  for (const file of inputs) {
   await mkdir(path.dirname(path.join(work, file)), {recursive: true});
   await cp(path.join(root, file), path.join(work, file));
  }
  await fn(work);
 } finally { await rm(work, {recursive: true, force: true}); }
}
async function snapshot(work) {
 return await Promise.all(inputs.map(file => readFile(path.join(work, file), 'utf8')));
}

test('version:set 更新全部发布副本，保留历史、固定身份和外部依赖', async () => fixture(async work => {
 const originals = await snapshot(work);
 const oldManifest = JSON.parse(await readFile(path.join(work, 'native-extension/manifest.json'), 'utf8'));
 const lock = JSON.parse(await readFile(path.join(work, 'package-lock.json'), 'utf8'));
 // 中文注释：即使依赖恰好同版本，也只更新根包字段。
 lock.packages['node_modules/version-fixture'] = {version: current};
 await writeFile(path.join(work, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
 const result = spawnSync('npm', ['run', 'version:set', next], {cwd: work, encoding: 'utf8', timeout: 30000});
 assert.equal(result.status, 0, result.stdout + result.stderr);
 for (const file of [...JSON_VERSION_FILES, ...TEXT_VERSION_FILES, 'CHANGELOG.md', `docs/release-${next}.md`]) assert.ok(result.stdout.includes(`- ${file}\n`), file);
 assert.equal(await verifyReleaseVersions(work), next);
 assert.equal(JSON.parse(await readFile(path.join(work, 'native-extension/manifest.json'), 'utf8')).key, oldManifest.key);
 assert.equal(JSON.parse(await readFile(path.join(work, 'package-lock.json'), 'utf8')).packages['node_modules/version-fixture'].version, current);
 const changelog = await readFile(path.join(work, 'CHANGELOG.md'), 'utf8');
 assert.ok(changelog.startsWith(`# Changelog\n\n## ${next} — `));
 assert.match(changelog.split('\n')[2], / — \d{4}-\d{2}-\d{2}$/);
 assert.equal(changelog.replace(/^## .*\n\n/m, ''), originals[inputs.indexOf('CHANGELOG.md')]);
 assert.equal(await readFile(path.join(work, `docs/release-${current}.md`), 'utf8'), originals[inputs.indexOf(`docs/release-${current}.md`)]);
 const draft = await readFile(path.join(work, `docs/release-${next}.md`), 'utf8');
 assert.ok(!draft.includes('{{')); assert.ok(draft.includes('草稿')); assert.ok(draft.includes('待记录测试命令'));
 for (const file of ['README.md', 'README.zh-CN.md']) {
  const requirements = text => text.split('\n').filter(line => /^\| (?:Hermes Agent|Node.js) \|/.test(line));
  assert.deepEqual(requirements(await readFile(path.join(work, file), 'utf8')), requirements(originals[inputs.indexOf(file)]));
 }
 // 中文注释：后续升级也必须继续追加，不能把刚生成的发布节覆盖掉。
 const following = `${parts[0]}.${parts[1]}.${parts[2] + 2n}`;
 await setVersion(work, following);
 assert.equal(await verifyReleaseVersions(work), following);
 assert.equal(await readFile(path.join(work, `docs/release-${next}.md`), 'utf8'), draft);
}));

test('拒绝同版本、降级、非法格式和多余参数，文件不变', async () => fixture(async work => {
 const original = await snapshot(work);
 const downgrade = parts[2] > 0n ? `${parts[0]}.${parts[1]}.${parts[2] - 1n}` : '0.0.0';
 for (const version of [current, downgrade, '01.2.3', '1.2', '1.2.3-beta', '../1.2.3']) {
  await assert.rejects(setVersion(work, version), /must be greater|expects x.y.z/);
  assert.deepEqual(await snapshot(work), original);
 }
 const result = spawnSync(process.execPath, ['scripts/version-set.mjs', next, 'extra'], {cwd: work, encoding: 'utf8'});
 assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
 assert.deepEqual(await snapshot(work), original);
}));

test('预检拒绝已有草稿、损坏模板及版本漂移，避免部分更新', async () => fixture(async work => {
 const original = await snapshot(work), releasePath = path.join(work, `docs/release-${next}.md`);
 await writeFile(releasePath, 'existing historical note');
 await assert.rejects(setVersion(work, next), /refusing to overwrite release history/);
 assert.deepEqual(await snapshot(work), original);
 assert.equal(await readFile(releasePath, 'utf8'), 'existing historical note');
 await rm(releasePath);
 const template = path.join(work, 'docs/release-template.md');
 await writeFile(template, 'invalid template');
 const broken = await snapshot(work);
 await assert.rejects(setVersion(work, next), /missing version\/date placeholders/);
 assert.deepEqual(await snapshot(work), broken);
 await cp(path.join(root, 'docs/release-template.md'), template);
 const plugin = path.join(work, 'executor-plugin/plugin.yaml');
 await writeFile(plugin, (await readFile(plugin, 'utf8')).replace(`version: ${current}`, `version: ${next}`));
 const drifted = await snapshot(work);
 await assert.rejects(setVersion(work, next), /executor-plugin\/plugin.yaml:2:/);
 assert.deepEqual(await snapshot(work), drifted);
}));

test('文档、下载标签、锁根字段和握手漂移报告具体文件与行', async () => fixture(async work => {
 for (const file of [...JSON_VERSION_FILES, ...TEXT_VERSION_FILES.filter(file => file !== 'scripts/migrate-to-browser-link.py'), 'CHANGELOG.md', `docs/release-${current}.md`]) {
  const target = path.join(work, file), original = await readFile(target, 'utf8');
  const offset = original.indexOf(current);
  assert.ok(offset >= 0, file);
  await writeFile(target, original.slice(0, offset) + next + original.slice(offset + current.length));
  const line = original.slice(0, offset).split('\n').length;
  const expectedLocation = file === 'package.json' ? 'package-lock.json:3:' : `${file}:${line}:`;
  await assert.rejects(verifyReleaseVersions(work), error => error.message.includes(expectedLocation), file);
  await writeFile(target, original);
 }
 for (const file of ['README.md', 'README.zh-CN.md']) {
  const target = path.join(work, file), original = await readFile(target, 'utf8');
  const token = `/download/v${current}/`, offset = original.indexOf(token);
  await writeFile(target, original.replace(token, `/download/v${next}/`));
  const line = original.slice(0, offset).split('\n').length;
  await assert.rejects(verifyReleaseVersions(work), error => error.message.includes(`${file}:${line}:`));
  await writeFile(target, original.replace('https://github.com/fanjing188/hermes-browser-link/releases/download/', 'https://wrong.example/releases/download/'));
  await assert.rejects(verifyReleaseVersions(work), /missing current release reference/);
  await writeFile(target, original);
 }
 const backgroundFile = 'native-extension/background.mjs', backgroundPath = path.join(work, backgroundFile);
 const background = await readFile(backgroundPath, 'utf8');
 await writeFile(backgroundPath, background.replaceAll('getManifest().version', 'getManifest().name'));
 await assert.rejects(verifyReleaseVersions(work), /native-extension\/background.mjs:\d+:.*getManifest/);
 await writeFile(backgroundPath, background);
 const release = `docs/release-${current}.md`;
 await rm(path.join(work, release));
 await assert.rejects(verifyReleaseVersions(work), error => error.message.includes(`${release}:1: ENOENT`));
}));

test('损坏生成模板导致最终校验失败时恢复本次写入', async () => fixture(async work => {
 const template = path.join(work, 'docs/release-template.md');
 await writeFile(template, '# wrong title {{version}}\n{{date}}\n');
 const before = await snapshot(work);
 await assert.rejects(setVersion(work, next), /release title/);
 assert.deepEqual(await snapshot(work), before);
 await assert.rejects(readFile(path.join(work, `docs/release-${next}.md`)), {code: 'ENOENT'});
}));
