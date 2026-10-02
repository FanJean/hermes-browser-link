import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRepository, CHECKER_INPUTS } from '../../scripts/check-v1.1-integration.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function fixtureRoot(t) {
  const scratch = process.env.TMPDIR || path.join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'v11-integration-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of CHECKER_INPUTS) {
    const source = path.join(repo, relative);
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
  return root;
}

function action(report, name) {
  const result = report.actions.find(item => item.action === name);
  assert.ok(result, `missing action row: ${name}`);
  return result;
}

test('public actions traverse their real schema, daemon, extension and package routes', () => {
  const report = analyzeRepository(repo);
  const row = action(report, 'interaction.capture');
  const api = action(report, 'api_request');
  assert.equal(report.schemaVersion, 'v1.1.integration-check/v1');
  assert.deepEqual(row.layers, {
    declaration: true, schema: true, daemon: true, extension: true, package: true,
  });
  assert.equal(row.supported, true);
  // 中文注释：新增控件动作必须通过同一条公开 schema、daemon、扩展和打包链路。
  for(const name of ['page.parse','semantic_snapshot','ref_fill','ref_set_checked','ref_select_option','ref_press'])assert.equal(action(report,name).supported,true);
  assert.deepEqual(api.layers, {
    declaration: true, schema: true, daemon: true, extension: true, package: true,
  });
  assert.equal(api.supported, true);
});

test('文件上传走当前私有登记链，其他未实现文件动作仍不公开', () => {
  // 中文注释：文件上传已替换旧实验模块；下载动作仍须另行开发和验收。
  const report = analyzeRepository(repo);
  assert.equal(action(report,'files.upload').supported,true);
  assert.equal(report.actions.some(row => row.action === 'files.download.start'), false);
  assert.equal(report.sourceAnalysis.package.base, true);
  assert.equal(report.status, 'pass');
});

test('negative control: leftover action mentions cannot hide a missing daemon allowlist entry', async t => {
  const root = await fixtureRoot(t);
  const daemonPath = path.join(root, 'native-bridge/daemon.py');
  const daemon = await readFile(daemonPath, 'utf8');
  const needle = "    'interaction.drag_coordinates', ";
  assert.ok(daemon.includes(needle), 'negative-control fixture must target the active daemon allowlist');
  await writeFile(daemonPath, daemon.replace(needle, ''));

  const report = analyzeRepository(root);
  const row = action(report, 'interaction.drag_coordinates');
  assert.equal(row.layers.schema, true);
  assert.equal(row.layers.daemon, false);
  assert.equal(row.layers.extension, true);
  assert.equal(row.supported, false);
  assert.ok(row.gaps.some(gap => gap.code === 'missing_daemon_allowlist'));
  assert.equal(report.status, 'fail');
});

test('语义动作声明不能掩盖缺失的执行分支或页面函数', async t => {
  // 中文注释：保留公开声明和其他同名引用，只破坏实际分支，检查器仍必须报告缺口。
  const controls = [
    {name: 'page.parse', needle: "else if(['page.observe','page.parse',", replacement: "else if(['page.observe',"},
    {name: 'ref_fill', needle: "if(op==='ref_fill'){", replacement: "if(op==='removed_ref_fill'){"},
  ];
  for (const control of controls) {
    await t.test(control.name, async child => {
      const root = await fixtureRoot(child);
      const corePath = path.join(root, 'native-extension/core.mjs');
      const core = await readFile(corePath, 'utf8');
      assert.ok(core.includes(control.needle), '负向夹具必须命中当前执行分支');
      await writeFile(corePath, core.replace(control.needle, control.replacement));
      const report = analyzeRepository(root);
      const row = action(report, control.name);
      assert.equal(row.layers.schema, true);
      assert.equal(row.layers.daemon, true);
      assert.equal(row.layers.extension, false);
      assert.equal(row.supported, false);
      assert.ok(row.gaps.some(gap => gap.code === 'missing_extension_route'));
      assert.equal(report.status, 'fail');
    });
  }
});
