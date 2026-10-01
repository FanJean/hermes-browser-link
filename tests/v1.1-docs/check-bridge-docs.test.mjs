import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 中文注释：仓库路径含中文时必须把文件 URL 解码后交给子进程。
const checker = fileURLToPath(new URL('../../scripts/check-bridge-docs.mjs', import.meta.url));
function fixture() {
  assert.ok(process.env.TMPDIR, 'Set TMPDIR to an isolated scratch directory for tests');
  const root = mkdtempSync(join(process.env.TMPDIR, 'bridge-docs-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'README.md'), '# Project\n\n[Usage](docs/usage.md)\n');
  writeFileSync(join(root, 'docs', 'usage.md'), '# Usage\n\n[Project](../README.md)\n');
  return root;
}
function run(root) { return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' }); }
function inFixture(fn) {
  const root = fixture();
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('valid docs pass without touching a browser', () => inFixture(root => {
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Docs OK \(2 files\)/);
}));

test('a missing README fails', () => inFixture(root => {
  rmSync(join(root, 'README.md'));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: missing/);
}));

test('broken local markdown links fail with source location', () => inFixture(root => {
  writeFileSync(join(root, 'docs', 'usage.md'), '# Usage\n\n[Missing](../NO-SUCH-FILE.md)\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/usage\.md:3: broken local link/);
}));

test('links inside code fences are not followed', () => inFixture(root => {
  writeFileSync(join(root, 'docs', 'usage.md'), '# Usage\n\n```md\n[Example](missing.md)\n```\n');
  assert.equal(run(root).status, 0);
}));

test('personal absolute paths are rejected everywhere, including code fences', () => inFixture(root => {
  writeFileSync(join(root, 'docs', 'usage.md'), '# Usage\n\n```sh\ncat /Users/example/secret/report.json\n```\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/usage\.md:4: personal absolute path/);
}));

test('credential assignments are rejected without echoing their values', () => inFixture(root => {
  writeFileSync(join(root, 'README.md'), '# Project\n\nAPI_SERVER_KEY=' + 'synthetic-do-not-ship-' + '123456\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:3: possible credential/);
  assert.doesNotMatch(result.stderr, /synthetic-do-not-ship/);
}));

const publicChecker = fileURLToPath(new URL('../../scripts/check-public-release.sh', import.meta.url));
function publicFixture(fn) {
  inFixture(root => {
    // 中文注释：临时 Git 索引只登记合成夹具，不修改源仓库或创建提交。
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    const track = name => assert.equal(spawnSync('git', ['add', '--', name], { cwd: root }).status, 0);
    const scan = extra => spawnSync('bash', [publicChecker], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PUBLIC_RELEASE_EXTRA_KEYWORDS: extra || '' },
    });
    fn(root, track, scan);
  });
}

test('public scanner allows public key and fictional paths; skips deleted tracked records', () => publicFixture((root, track, scan) => {
  // 中文注释：公钥不属于凭据；已删除的文件不属于当前待发布源码。
  writeFileSync(join(root, 'source.txt'), '/Users/example/fixture\n/Users/x/fixture\nkey="MIIBpublicFixture"\n');
  track('source.txt');
  assert.equal(scan().status, 0);
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence', 'result.json'), '{}');
  track('evidence/result.json');
  rmSync(join(root, 'evidence', 'result.json'));
  assert.equal(scan().status, 0);
}));

test('public scanner rejects private markers and secrets without printing values', () => publicFixture((root, track, scan) => {
  // 中文注释：分段构造检测负例，避免检测器源码自身成为明文令牌样本。
  const marker = 'private-' + 'release-marker';
  const token = 'gh' + 'p_' + 'a'.repeat(36);
  const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----';
  writeFileSync(join(root, 'source.txt'), `${marker}\n${token}\n${privateKey}\n`);
  track('source.txt');
  const result = scan(marker);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extra private marker/);
  assert.match(result.stderr, /provider-token/);
  assert.match(result.stderr, /private-key/);
  assert.ok(!result.stderr.includes(marker) && !result.stderr.includes(token));
}));

test('public scanner rejects generated files, real paths, email and oversized content', () => publicFixture((root, track, scan) => {
  // 中文注释：逐项确认每条发布边界单独失败，不能由其他命中掩盖缺失规则。
  const cases = [
    ['source.txt', '/Users/' + 'synthetic-owner/private', 'personal-path'],
    ['source.txt', 'test@' + 'mail-domain.dev', 'email'],
    ['source.txt', 'api_key="' + 'a'.repeat(32) + '"', 'credential-assignment'],
    ['source.txt', 'x'.repeat(1024 * 1024 + 1), 'exceeds 1 MiB'],
    ['artifacts/result.json', '{}', 'tracked generated/private file'],
    ['bench/results/result.json', '{}', 'tracked generated/private file'],
    ['.env', 'VALUE=fixture', 'tracked generated/private file'],
  ];
  for (const [name, content, reason] of cases) {
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.';
    mkdirSync(join(root, parent), { recursive: true });
    writeFileSync(join(root, name), content); track(name);
    const result = scan();
    assert.equal(result.status, 1, name);
    assert.ok(result.stderr.includes(reason), result.stderr);
    rmSync(join(root, name));
  }
}));
