import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const scratch = path.join(process.env.HOME, '.hermes/cache/scratch');
const sha256 = data => createHash('sha256').update(data).digest('hex');

test('native build copies exact browser-safe module sources and rewrites imports locally', async () => {
  const work = await mkdtemp(path.join(scratch, 'native-v2-build-'));
  const output = path.join(work, 'dist-native');
  try {
    await exec(process.execPath, [path.join(root, 'native-extension/build.mjs'), output], {cwd: root});
    const manifest = JSON.parse(await readFile(path.join(output, 'BUILD-DEPS.json'), 'utf8'));
    const expected = {
      'vendor/page-semantics.mjs': path.join(root, 'page-semantics/index.js'),
      'vendor/browser-interactions.mjs': path.join(root, 'browser-interactions/index.mjs'),
    };
    for (const [relative, source] of Object.entries(expected)) {
      const [built, canonical] = await Promise.all([
        readFile(path.join(output, relative)),
        readFile(source),
      ]);
      assert.equal(sha256(built), sha256(canonical));
      assert.equal(manifest.dependencies[relative].sha256, sha256(canonical));
      assert.equal(manifest.dependencies[relative].source, path.relative(root, source).split(path.sep).join('/'));
    }
    const core = await readFile(path.join(output, 'core.mjs'), 'utf8');
    assert.match(core, /from '\.\/vendor\/page-semantics\.mjs'/);
    assert.match(core, /from '\.\/vendor\/browser-interactions\.mjs'/);
    assert.doesNotMatch(core, /\.\.\/page-semantics|\.\.\/browser-interactions/);
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});
