import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: repoRoot });
const repoPath = relativePath => path.join(repoRoot, relativePath);

test('ignores generated build and release output only', async () => {
  for (const generated of [
    'native-extension/dist-native/core.mjs',
    'artifacts/browser-link/native-extension/core.mjs',
    'release/browser-link/native-extension/core.mjs',
  ]) {
    assert.equal(await eslint.isPathIgnored(repoPath(generated)), true, generated);
  }

  assert.equal(await eslint.isPathIgnored(repoPath('scripts/package-executor.mjs')), false);
});

test('keeps active native-extension source in the root lint scope', async () => {
  const sourceFiles = [
    'native-extension/automation-overlay.mjs',
    'native-extension/core.mjs',
  ];

  for (const sourceFile of sourceFiles) {
    assert.equal(await eslint.isPathIgnored(repoPath(sourceFile)), false, sourceFile);
  }

  const results = await eslint.lintFiles(sourceFiles);
  assert.deepEqual(
    results.flatMap(result => result.messages.filter(message => message.severity === 2)),
    [],
  );
});

test('retains no-undef as an error for an in-memory source negative control', async () => {
  const [result] = await eslint.lintText(
    'const lintScopeNegativeControl = undeclaredLintScopeIdentifier;',
    { filePath: repoPath('native-extension/core.mjs') },
  );

  assert.ok(result.messages.some(message =>
    message.ruleId === 'no-undef'
      && message.severity === 2
      && message.message.includes('undeclaredLintScopeIdentifier')));
});
