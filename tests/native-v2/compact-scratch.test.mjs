// 中文注释：离线验证真实会话的短 socket 隔离布局；只构建和安装 fixture，不启动浏览器。
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdtemp, readFile, readdir, realpath, rm, unlink} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as runner from './real-session.mjs';

const exec = promisify(execFile);
const python = process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');

test('real-session verifies connection access without removed approval controls',async()=>{
 for(const file of ['real-session.mjs','real-native-v2.mjs']){
  const source=await readFile(new URL(`./${file}`,import.meta.url),'utf8');
  assert.doesNotMatch(source,/#access-toggle|#confirm-enable/,file);
  assert.ok(source.includes("browserFullConsentStatus==='enabled'"),file);
 }
});

test('compactScratch stages isolated source and package homes with a bindable socket', async () => {
  assert.equal(typeof runner.stageRealSession, 'function', 'offline staging must be available');
  const scratch = await realpath(process.env.TMPDIR);
  const fixtures = [];
  try {
    for (const packageMode of [false, true]) {
      const fixture = await runner.stageRealSession({browser: 'chrome', packageMode, compactScratch: true, label: 'compact-test'});
      fixtures.push(fixture);
      const {work, profile, staged, compactHome, temp} = fixture;
      assert.equal(path.dirname(work), scratch);
      assert.equal(path.dirname(compactHome), scratch);
      assert.match(path.basename(compactHome), /^[a-f0-9]{4}$/u);
      assert.equal(staged.hermesHome, compactHome);
      assert.equal(profile, path.join(work, 'profile'));
      assert.equal(temp, path.join(work, 'tmp'));
      assert.equal(staged.home, path.join(work, 'h'));
      for (const filename of [staged.host, staged.plugin, ...staged.manifests]) {
        assert.ok(filename.startsWith(`${work}/`) || filename.startsWith(`${compactHome}/`), filename);
        await access(filename);
      }
      const socketPath = path.join(compactHome, 'plugin-data/browser-link-native/bridge.sock');
      assert.ok(Buffer.byteLength(socketPath) <= 103, socketPath);
      console.log(`compact socket: ${socketPath} (${Buffer.byteLength(socketPath)} bytes)`);
      await exec(python, ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', socketPath]);
      const manifest = JSON.parse(await readFile(staged.manifests[0], 'utf8'));
      assert.equal(manifest.path, staged.host);
      assert.ok((await readFile(staged.host, 'utf8')).includes(compactHome));
      const {stdout} = await exec(python, ['-c', 'import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps({k:str(v) for k,v in m["paths"](m["Path"](sys.argv[2])).items()}))', path.join(runner.root, 'tests/native-v2/real-helper.py'), work], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
      const restored = JSON.parse(stdout);
      assert.equal(restored.hermes, compactHome);
      assert.equal(restored.plugin, staged.plugin);
      assert.equal(restored.extension, staged.extension);
      await unlink(socketPath);
      // 中文注释：真实 helper RPC 仅查询空实例，验证 daemon 路径与安全清理，不启动浏览器。
      try {
        assert.deepEqual(await runner.helperCall('rpc', work, 'compact-offline', 'browsers', '{}'), []);
        const identity = await runner.helperCall('inspect', work);
        assert.ok(identity.daemonCommand.includes(compactHome));
      } finally { await runner.helperCall('cleanup', work); }
    }
    assert.notEqual(fixtures[0].compactHome, fixtures[1].compactHome);
    const shared = await runner.stageRealSession({browser: 'edge', compactScratch: true, sharedWith: fixtures[1], label: 'compact-shared'});
    try {
      assert.equal(shared.compactHome, undefined);
      assert.equal(shared.staged.hermesHome, fixtures[1].compactHome);
    } finally { await shared.dispose(); }
    await access(fixtures[1].compactHome);
    const first = fixtures[0];
    await first.dispose();
    await assert.rejects(access(first.work), {code: 'ENOENT'});
    await assert.rejects(access(first.compactHome), {code: 'ENOENT'});
    await access(fixtures[1].compactHome);
    await access(scratch);
  } finally {
    for (const fixture of fixtures) await fixture.dispose();
  }
});

test('compactScratch refuses missing or overlong TMPDIR without leaking work', async () => {
  const original = process.env.TMPDIR;
  const longScratch = await mkdtemp(path.join(await realpath(original), 'compact-too-long-'));
  try {
    await assert.rejects(runner.stageRealSession({browser: 'chrome', compactScratch: true, label: 'missing/compact-escape'}), /label/u);
    delete process.env.TMPDIR;
    await assert.rejects(runner.stageRealSession({browser: 'chrome', compactScratch: true}), /explicit TMPDIR/u);
    process.env.TMPDIR = longScratch;
    await assert.rejects(runner.stageRealSession({browser: 'chrome', compactScratch: true}), /too long/u);
    assert.deepEqual(await readdir(longScratch), []);
  } finally { process.env.TMPDIR = original; await rm(longScratch, {recursive: true, force: true}); }
});

test('helper staging without compact home preserves the legacy isolated layout', async () => {
  const work = await mkdtemp(path.join(await realpath(process.env.TMPDIR), 'compact-legacy-'));
  try {
    const staged = await runner.helperCall('stage', work, JSON.stringify(['chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/']));
    assert.equal(staged.home, path.join(work, 'h'));
    assert.equal(staged.hermesHome, path.join(work, 'h/.hermes'));
    assert.equal(staged.plugin, path.join(work, 'plugin/browser-link'));
    assert.ok((await readFile(staged.host, 'utf8')).includes(staged.hermesHome));
  } finally { await rm(work, {recursive: true, force: true}); }
});
