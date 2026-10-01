import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function fixture(text, limits = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://redaction-lint.example.test/'});
  const {document} = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () {return [this.getBoundingClientRect()];};
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  document.body.append(paragraph);
  const semantics = createPageSemantics({document, taskId: 'redaction-lint-task', documentId: 'redaction-lint-document', leaseId: 'redaction-lint-lease', ...limits});
  return {dom, semantics, close() {semantics.revoke(); dom.window.close();}};
}

test('page semantics passes ESLint without suppressing no-control-regex', () => {
  const eslintCli = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const result = spawnSync(process.execPath, [eslintCli, 'page-semantics/index.js'], {cwd: repoRoot, encoding: 'utf8'});
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /no-control-regex|Unused eslint-disable/u);
});

test('all scrubbed C0 and C1 controls cannot reveal an ambiguous secret tail', () => {
  const controls = Array.from({length: 0xa0}, (_, code) => code)
    .filter(code => code <= 0x08 || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))
    .map(code => String.fromCharCode(code))
    .join('');
  const f = fixture(`Safe prefix | password=CONTROL_${controls}SENTINEL|SAFE_SUFFIX`);
  try {
    const page = f.semantics.snapshot({mode: 'content', budget: 3000});
    const output = page.items.map(item => item.name).join('');
    const wire = JSON.stringify(page);
    assert.equal(output, 'Safe prefix | password=[redacted]');
    assert.ok(!wire.includes('CONTROL_SENTINEL'));
    assert.ok(!wire.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('C0/C1 cleanup preserves TAB, LF and CR for normal whitespace handling', () => {
  const f = fixture('Safe\tline\nnext\rword');
  try {
    const page = f.semantics.snapshot({mode: 'content', budget: 3000});
    assert.equal(page.items.map(item => item.name).join(''), 'Safe line next word');
  } finally {f.close();}
});

test('escaped quotes remain inside a structured secret while its verified suffix survives', () => {
  const escapedQuote = ['ESCAPED_SECRET', '\\', '"', 'FRAGMENT'].join('');
  const f = fixture(`Safe prefix | password="${escapedQuote} | INNER_TEXT"|SAFE_SUFFIX`);
  try {
    const page = f.semantics.snapshot({mode: 'content', budget: 3000});
    const output = page.items.map(item => item.name).join('');
    const wire = JSON.stringify(page);
    assert.equal(output, 'Safe prefix | password=[redacted]|SAFE_SUFFIX');
    assert.ok(!wire.includes('ESCAPED_SECRET'));
    assert.ok(!wire.includes('INNER_TEXT'));
  } finally {f.close();}
});

test('a credential cut by the irreversible text cap stays hidden and reports truncation', () => {
  const f = fixture(`${'A'.repeat(16370)} password=TRUNCATION_SENTINEL|SAFE_SUFFIX`, {maxItems: 100, maxText: 400});
  try {
    const page = f.semantics.snapshot({mode: 'content', budget: 12000});
    const wire = JSON.stringify(page);
    assert.equal(page.coverage.truncated, 1);
    assert.equal(page.coverage.complete, false);
    assert.ok(!wire.includes('TRUNCATION_SENTINEL'));
    assert.ok(!wire.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});
