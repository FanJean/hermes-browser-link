import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';

function fixture(text, limits = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://redaction.example.test/'});
  const {document} = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () {return [this.getBoundingClientRect()];};
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  document.body.append(paragraph);
  const semantics = createPageSemantics({document, taskId: 'redaction-task', documentId: 'redaction-document', leaseId: 'redaction-lease', ...limits});
  return {dom, semantics, close() {semantics.revoke(); dom.window.close();}};
}

function snapshot(f, budget = 3000) {
  return f.semantics.snapshot({mode: 'content', budget});
}

function content(f) {
  return snapshot(f).items.map(item => item.name).join('');
}

test('unquoted secret values with spaces and pipes remain masked through ambiguous suffixes', () => {
  const f = fixture('Safe prefix | password=SPACE_SECRET WITH SPACE|SAFE_SUFFIX');
  try {
    const output = content(f);
    assert.ok(output.startsWith('Safe prefix | password=[redacted]'));
    assert.ok(!output.includes('SPACE_SECRET'));
    assert.ok(!output.includes('WITH SPACE'));
    assert.ok(!output.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('an unquoted pipe is part of an ambiguous secret, not a safe boundary', () => {
  const f = fixture('Safe prefix | password=QUALITY_SENTINEL_SECRET|SAFE_SUFFIX');
  try {
    const page = snapshot(f);
    const output = page.items.map(item => item.name).join('');
    const wire = JSON.stringify(page);
    assert.equal(output, 'Safe prefix | password=[redacted]');
    assert.ok(!wire.includes('QUALITY_SENTINEL_SECRET'));
    assert.ok(!wire.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('a redacted PII marker does not make arbitrary text after a secret safe', () => {
  const f = fixture('Safe prefix | password=PII_SECRET; alice@example.com; SAFE_SUFFIX');
  try {
    const output = content(f);
    assert.equal(output, 'Safe prefix | password=[redacted] [email]');
    assert.ok(!output.includes('PII_SECRET'));
    assert.ok(!output.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('an unquoted semicolon cannot promote a later quoted fragment into safe text', () => {
  const f = fixture('Safe prefix | password=OUTER_SECRET; token="INNER_SECRET"|SAFE_SUFFIX');
  try {
    const output = content(f);
    assert.equal(output, 'Safe prefix | password=[redacted] token=[redacted]');
    assert.ok(!output.includes('OUTER_SECRET'));
    assert.ok(!output.includes('INNER_SECRET'));
    assert.ok(!output.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('a matched quote boundary preserves only text outside a structured secret value', () => {
  const f = fixture('Safe prefix | password="QUALITY_SENTINEL_SECRET"|SAFE_SUFFIX');
  try {
    const page = snapshot(f);
    const output = page.items.map(item => item.name).join('');
    const wire = JSON.stringify(page);
    assert.equal(output, 'Safe prefix | password=[redacted]|SAFE_SUFFIX');
    assert.ok(!wire.includes('QUALITY_SENTINEL_SECRET'));
  } finally {f.close();}
});

test('quoted values safely include spaces pipes and escaped quotes', () => {
  const value = 'SPACE SECRET | QUOTED "TEXT"';
  const f = fixture(`Safe prefix | password=${JSON.stringify(value)}|SAFE_SUFFIX`);
  try {
    const output = content(f);
    assert.equal(output, 'Safe prefix | password=[redacted]|SAFE_SUFFIX');
    assert.ok(!output.includes(value));
  } finally {f.close();}
});

test('quoted Bearer credentials preserve only text beyond the balanced value', () => {
  const value = 'BEARER SECRET | QUOTED "TEXT"';
  const f = fixture(`Safe prefix | Bearer ${JSON.stringify(value)}|SAFE_SUFFIX`);
  try {
    const page = snapshot(f);
    const output = page.items.map(item => item.name).join('');
    const wire = JSON.stringify(page);
    assert.equal(output, 'Safe prefix | Bearer [redacted]|SAFE_SUFFIX');
    assert.ok(!wire.includes(value));
  } finally {f.close();}
});

test('malformed quoted values fail closed through the suffix', () => {
  const f = fixture('Safe prefix | password="UNTERMINATED_SECRET|SAFE_SUFFIX');
  try {
    const output = content(f);
    assert.equal(output, 'Safe prefix | password=[redacted]');
    assert.ok(!output.includes('UNTERMINATED_SECRET'));
    assert.ok(!output.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('control characters cannot separate an unquoted secret from an ambiguous pipe suffix', () => {
  const f = fixture('Safe prefix | password=CONTROL_\u0000SENTINEL|SAFE_SUFFIX');
  try {
    const output = content(f);
    assert.equal(output, 'Safe prefix | password=[redacted]');
    assert.ok(!output.includes('CONTROL_SENTINEL'));
    assert.ok(!output.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});

test('an irreversible text cap cannot expose an unfinished sensitive value', () => {
  const f = fixture(`${'A'.repeat(16370)} password=CAP_SENTINEL_TRUNCATED|SAFE_SUFFIX`, {maxItems: 100, maxText: 400});
  try {
    const page = f.semantics.snapshot({mode: 'content', budget: 12000});
    const wire = JSON.stringify(page);
    assert.equal(page.coverage.truncated, 1);
    assert.equal(page.coverage.complete, false);
    assert.ok(!wire.includes('CAP_SENTINEL_TRUNCATED'));
    assert.ok(!wire.includes('SAFE_SUFFIX'));
  } finally {f.close();}
});
