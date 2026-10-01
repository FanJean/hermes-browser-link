import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';
import {appendMultilingualCorpus, LARGE_CORPUS_SIZE, makeLongMultilingualText} from './fixtures.mjs';

const reports = {};
const failures = [];
const runStartedAt = new Date().toISOString();

function fixture(limits = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://quality.example.test/'});
  const {document} = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () {return [this.getBoundingClientRect()];};
  const semantics = createPageSemantics({document, taskId: 'quality-task', documentId: 'quality-document', leaseId: 'quality-lease', ...limits});
  return {dom, document, semantics, close() {semantics.revoke(); dom.window.close();}};
}

function measured(semantics) {
  const calls = [];
  return {
    calls,
    snapshot(options) {
      const page = semantics.snapshot(options);
      const json = JSON.stringify(page);
      calls.push({
        snapshotId: page.snapshotId,
        kind: page.kind,
        itemCount: page.items.length,
        jsonCharacters: json.length,
        estimatedUnits: Math.ceil(json.length / 4),
        budgetLimit: page.budget.limit,
        hasNextCursor: page.nextCursor !== null,
      });
      return page;
    },
  };
}

function collectPages(api, options) {
  const pages = [];
  const cursors = new Set();
  let cursor = null;
  for (let guard = 0; guard < 256; guard++) {
    const page = api.snapshot({...options, ...(cursor ? {cursor} : {})});
    pages.push(page);
    if (!page.nextCursor) return pages;
    assert.ok(!cursors.has(page.nextCursor), 'pagination cursor must advance without cycling');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.fail('pagination exceeded the 256-call fixture guard');
}

function responseMetrics(pages, calls) {
  const characters = calls.map(call => call.jsonCharacters);
  return {
    snapshotCalls: calls.length,
    responseCount: pages.length,
    responseJsonCharactersTotal: characters.reduce((sum, value) => sum + value, 0),
    responseJsonCharactersMax: Math.max(0, ...characters),
    responseEstimatedUnitsSum: calls.reduce((sum, call) => sum + call.estimatedUnits, 0),
    calls,
  };
}

function runQualityTest(name, fn) {
  test(name, () => {
    try {
      fn();
    } catch (error) {
      failures.push({name, error: String(error?.stack || error)});
      throw error;
    }
  });
}

runQualityTest('large multilingual noisy corpus reconstructs completely across bounded pages', () => {
  const f = fixture({maxScan: 30000, maxItems: 53, maxText: 256});
  try {
    const expected = appendMultilingualCorpus(f.document, LARGE_CORPUS_SIZE);
    const api = measured(f.semantics);
    const budget = 4000;
    const pages = collectPages(api, {mode: 'content', budget});
    const entries = pages.flatMap(page => page.items);
    const names = entries.map(item => item.name);
    const expectedValues = expected.values();
    const entryMatches = names.map(name => name === expectedValues.next().value);
    const uniqueRefs = new Set(entries.map(item => item.ref));

    assert.ok(pages.length > 1, 'fixture must exercise continuation paging');
    assert.equal(pages.at(-1).nextCursor, null);
    assert.deepEqual(names, expected, 'every multilingual entry must remain exact after documented control scrubbing');
    assert.equal(entries.length, LARGE_CORPUS_SIZE);
    assert.equal(uniqueRefs.size, LARGE_CORPUS_SIZE, 'same text shape must not alias distinct nodes');
    assert.ok(entries.every(item => item.fragment === undefined), 'short corpus entries must not be silently fragmented');
    assert.ok(pages.every(page => page.coverage.matched === LARGE_CORPUS_SIZE));
    assert.ok(pages.every(page => page.coverage.traversalComplete));
    assert.equal(api.calls.length, pages.length, 'one measured module snapshot call per response page');
    assert.ok(api.calls.every(call => call.estimatedUnits <= budget));

    reports.largeMultilingualCorpus = {
      inputEntries: LARGE_CORPUS_SIZE,
      rawInputCharacters: Array.from({length: LARGE_CORPUS_SIZE}, (_, i) => appendLength(i)).reduce((a, b) => a + b, 0),
      reconstructedEntries: names.length,
      exactEntries: entryMatches.filter(Boolean).length,
      uniqueNodeRefs: uniqueRefs.size,
      completeReconstruction: names.length === expected.length && entryMatches.every(Boolean),
      declaredResponseBudgetEstimatedUnits: budget,
      ...responseMetrics(pages, api.calls),
    };
  } finally {f.close();}
});

function appendLength(index) {
  // Recreate the fixture text length without retaining a second 1,024-node DOM.
  const id = String(index).padStart(4, '0');
  return `Entry ${id} | Ca\u0000fé e\u0301 | العربية | हि\u0085न्दी | 中文 | 日本語 | 한국어 | Ελληνικά | 👩‍💻`.length;
}

runQualityTest('same-name controls remain distinct across light DOM, open shadow DOM and same-origin frame', () => {
  const f = fixture();
  try {
    const light = f.document.createElement('button');
    light.textContent = 'Save';
    light.id = 'light-save';
    const host = f.document.createElement('div');
    f.document.body.append(light, host);
    const shadow = host.attachShadow({mode: 'open'});
    const shadowButton = f.document.createElement('button');
    shadowButton.textContent = 'Save';
    shadowButton.id = 'shadow-save';
    shadow.append(shadowButton);
    const frame = f.document.createElement('iframe');
    frame.src = 'about:blank';
    f.document.body.append(frame);
    const frameDocument = frame.contentDocument;
    assert.ok(frameDocument?.body, 'synthetic about:blank frame should be same-origin and readable');
    assert.equal(frameDocument.defaultView.parent.document, f.document, 'frame parent access proves the fixture is same-origin');
    frameDocument.defaultView.HTMLElement.prototype.getClientRects = function () {return [this.getBoundingClientRect()];};
    const frameButton = frameDocument.createElement('button');
    frameButton.textContent = 'Save';
    frameButton.id = 'frame-save';
    frameDocument.body.append(frameButton);

    const api = measured(f.semantics);
    const lightPage = api.snapshot({mode: 'interactive'});
    assert.deepEqual(lightPage.items.map(item => item.name), ['Save'], 'default traversal remains light-DOM only');
    const composedPage = api.snapshot({mode: 'interactive', composed: true});
    assert.deepEqual(composedPage.items.map(item => item.name), ['Save', 'Save', 'Save']);
    assert.equal(new Set(composedPage.items.map(item => item.ref)).size, 3);
    assert.equal(f.semantics.resolve({...composedPage.binding, snapshotId: composedPage.snapshotId, ref: composedPage.items[0].ref}), light);
    assert.equal(f.semantics.resolve({...composedPage.binding, snapshotId: composedPage.snapshotId, ref: composedPage.items[1].ref}), shadowButton);
    assert.equal(f.semantics.resolve({...composedPage.binding, snapshotId: composedPage.snapshotId, ref: composedPage.items[2].ref}), frameButton);
    assert.match(composedPage.coverage.scope, /open-shadow/);
    assert.match(composedPage.coverage.scope, /same-origin-frame/);
    assert.equal(api.calls.length, 2);

    reports.composedDuplicateControls = {
      lightDomControlCount: lightPage.items.length,
      composedControlCount: composedPage.items.length,
      distinctRefs: new Set(composedPage.items.map(item => item.ref)).size,
      exactTargetsResolved: true,
      sameOriginFrameAccessVerified: true,
      ...responseMetrics([lightPage, composedPage], api.calls),
    };
  } finally {f.close();}
});

runQualityTest('sensitive strings are redacted before fragment splitting', () => {
  const f = fixture({maxItems: 100, maxText: 24});
  try {
    const raw = `Lead|${'a'.repeat(51)}; password=CAPTURE_SENTINEL_PASSWORD; token=CAPTURE_SENTINEL_TOKEN; Bearer CAPTURE_SENTINEL_BEARER; alice@example.com; 4111111111111111; 尾`;
    const paragraph = f.document.createElement('p');
    paragraph.textContent = raw;
    f.document.body.append(paragraph);
    const api = measured(f.semantics);
    const pages = collectPages(api, {mode: 'content', budget: 5000});
    const items = pages.flatMap(page => page.items);
    const reconstructed = items.map(item => item.name).join('');
    const wire = JSON.stringify(pages);

    const leakChecks = {
      passwordValue: wire.includes('CAPTURE_SENTINEL_PASSWORD'),
      tokenValue: wire.includes('CAPTURE_SENTINEL_TOKEN'),
      bearerValue: wire.includes('CAPTURE_SENTINEL_BEARER'),
      email: wire.includes('alice@example.com'),
      cardNumber: wire.includes('4111111111111111'),
    };
    reports.sensitiveFragmentRedaction = {
      rawInputCharacters: raw.length,
      reconstructedRedactedCharacters: reconstructed.length,
      returnedFragments: items.length,
      leakChecks,
      redactionMarkers: ['password=[redacted]', 'token=[redacted]', 'Bearer [redacted]', '[email]', '[number]'],
      ...responseMetrics(pages, api.calls),
    };

    assert.ok(items.length > 1, 'fixture must split the redacted field into fragments');
    assert.ok(items.every(item => item.fragment?.field === 'name'));
    assert.deepEqual(Object.entries(leakChecks).filter(([, leaked]) => leaked).map(([kind]) => kind), [], 'no sensitive value may appear in serialized fragments');
    assert.ok(reconstructed.includes('password=[redacted]'));
    assert.ok(reconstructed.includes('token=[redacted]'));
    assert.ok(reconstructed.includes('Bearer [redacted]'));
    assert.ok(reconstructed.includes('[email]'));
    assert.ok(reconstructed.includes('[number]'));
    assert.equal(pages.at(-1).nextCursor, null);

    reports.sensitiveFragmentRedaction = {
      rawInputCharacters: raw.length,
      reconstructedRedactedCharacters: reconstructed.length,
      returnedFragments: items.length,
      sensitiveLeakDetected: /CAPTURE_SENTINEL|alice@example\.com|4111111111111111/.test(wire),
      redactionMarkers: ['password=[redacted]', 'token=[redacted]', 'Bearer [redacted]', '[email]', '[number]'],
      ...responseMetrics(pages, api.calls),
    };
  } finally {f.close();}
});

// Settled credential-tail contract (see tests/v1.1-semantics/enhancement.test.mjs):
// an unquoted credential consumes the ambiguous remainder, pipes included, because
// a secret may itself contain '|'. Only a complete quoted value keeps its suffix.
runQualityTest('pipe after an unquoted credential is not trusted as a separator', () => {
  const f = fixture();
  try {
    const raw = 'Safe prefix | password=QUALITY_SENTINEL_SECRET|SAFE_SUFFIX';
    const paragraph = f.document.createElement('p');
    paragraph.textContent = raw;
    f.document.body.append(paragraph);
    const api = measured(f.semantics);
    const pages = collectPages(api, {mode: 'content', budget: 3000});
    const reconstructed = pages.flatMap(page => page.items).map(item => item.name).join('');
    const wire = JSON.stringify(pages);
    const metrics = {
      rawInputCharacters: raw.length,
      reconstructedCharacters: reconstructed.length,
      sensitiveLeakDetected: wire.includes('QUALITY_SENTINEL_SECRET'),
      safeSuffixPreserved: reconstructed.includes('SAFE_SUFFIX'),
      ...responseMetrics(pages, api.calls),
    };
    reports.pipeDelimiterRedactionRepro = metrics;

    assert.equal(metrics.sensitiveLeakDetected, false, 'synthetic secret must remain redacted');
    assert.equal(metrics.safeSuffixPreserved, false, 'an unquoted credential tail is ambiguous; fail toward redaction');
    assert.ok(reconstructed.startsWith('Safe prefix |'), 'text before the credential label is kept');
  } finally {f.close();}
});

runQualityTest('read-cap boundary drops unfinished sensitive token and reports irreversible truncation', () => {
  const f = fixture({maxItems: 100, maxText: 400});
  const sourceText = `${'A'.repeat(16370)} token=CAP_SENTINEL_BEYOND_READ_CAP`;
  const paragraph = f.document.createElement('p');
  paragraph.textContent = sourceText;
  f.document.body.append(paragraph);
  const Text = f.document.defaultView.Text;
  const originalSubstringData = Text.prototype.substringData;
  let rawCharactersRead = 0;
  Text.prototype.substringData = function (start, count) {
    const value = originalSubstringData.call(this, start, count);
    rawCharactersRead += value.length;
    return value;
  };
  try {
    const api = measured(f.semantics);
    const pages = collectPages(api, {mode: 'content', budget: 12000});
    const items = pages.flatMap(page => page.items);
    const wire = JSON.stringify(pages);
    const reconstructed = items.map(item => item.name).join('');

    assert.ok(rawCharactersRead <= 16384, `raw field reads must stay within the cap; got ${rawCharactersRead}`);
    assert.ok(!wire.includes('CAP_SENTINEL_BEYOND_READ_CAP'));
    assert.ok(!reconstructed.includes('token='), 'unfinished token at the irreversible boundary must be discarded');
    assert.equal(reconstructed, 'A'.repeat(16370));
    assert.ok(pages.some(page => page.coverage.truncated === 1));
    assert.ok(pages.every(page => page.coverage.complete === false));

    reports.sensitiveReadCap = {
      sourceCharacters: sourceText.length,
      rawCharactersRead,
      configuredRawReadCap: 16384,
      reconstructedCharacters: reconstructed.length,
      irreversibleTruncationReported: pages.some(page => page.coverage.truncated === 1),
      sensitiveLeakDetected: wire.includes('CAP_SENTINEL_BEYOND_READ_CAP'),
      ...responseMetrics(pages, api.calls),
    };
  } finally {
    Text.prototype.substringData = originalSubstringData;
    f.close();
  }
});

runQualityTest('tight response budget paginates and packs multiple long-text fragments per call', () => {
  const f = fixture({maxItems: 200, maxText: 128});
  try {
    const expected = makeLongMultilingualText(160);
    const paragraph = f.document.createElement('p');
    paragraph.textContent = expected;
    f.document.body.append(paragraph);
    const api = measured(f.semantics);
    const budget = 700;
    const pages = collectPages(api, {mode: 'content', budget});
    const items = pages.flatMap(page => page.items);
    const reconstructed = items.map(item => item.name).join('');

    assert.ok(pages.length > 1, 'budget, not maxItems, must force continuation');
    assert.ok(pages.every(page => page.items.length > 1), 'response should pack multiple fragments instead of one fragment per call');
    assert.ok(api.calls.every(call => call.estimatedUnits <= budget));
    assert.equal(pages.at(-1).nextCursor, null);
    assert.equal(reconstructed, expected);
    assert.ok(items.length > 10);
    assert.ok(items.every(item => item.fragment?.field === 'name'));
    assert.equal(api.calls.length, pages.length);

    reports.budgetConstrainedFragments = {
      inputCharacters: expected.length,
      reconstructedCharacters: reconstructed.length,
      fragmentCount: items.length,
      declaredResponseBudgetEstimatedUnits: budget,
      allResponsesWithinDeclaredEstimate: api.calls.every(call => call.estimatedUnits <= budget),
      ...responseMetrics(pages, api.calls),
    };
  } finally {f.close();}
});

runQualityTest('delta upserts preserve fragment identity and reconstruct the complete changed field', () => {
  const f = fixture({maxItems: 200, maxText: 128});
  try {
    const originalText = makeLongMultilingualText(120);
    const paragraph = f.document.createElement('p');
    paragraph.textContent = originalText;
    f.document.body.append(paragraph);
    const api = measured(f.semantics);
    const options = {mode: 'content', budget: 10000};
    const baseline = api.snapshot(options);
    assert.equal(baseline.nextCursor, null, 'large budget should materialize the full fragment baseline');
    assert.ok(baseline.items.length > 10);
    const offset = originalText.indexOf('العربية', 128);
    assert.ok(offset > 128);
    const changedText = `${originalText.slice(0, offset)}X${originalText.slice(offset + 1)}`;
    paragraph.textContent = changedText;
    const delta = api.snapshot({...options, baselineId: baseline.snapshotId});

    assert.equal(delta.kind, 'delta');
    assert.equal(delta.items.length, 1, 'one changed range should produce one fragment upsert');
    assert.equal(delta.removed.length, 0);
    assert.equal(new Set(delta.order).size, baseline.items.length);
    const key = item => JSON.stringify([item.ref, item.fragment.field, item.fragment.index ?? null, item.fragment.start]);
    const materialized = new Map(baseline.items.map(item => [key(item), item]));
    for (const removed of delta.removed) materialized.delete(removed);
    for (const item of delta.items) materialized.set(key(item), item);
    const reconstructed = delta.order.map(id => materialized.get(id).name).join('');

    assert.equal(reconstructed, changedText);
    assert.ok(Math.ceil(JSON.stringify(delta).length / 4) <= options.budget);
    assert.equal(api.calls.length, 2, 'one full baseline call and one delta call');

    reports.deltaFragments = {
      baselineFragments: baseline.items.length,
      deltaUpserts: delta.items.length,
      deltaRemovals: delta.removed.length,
      orderedFragmentEntries: delta.order.length,
      reconstructedCharacters: reconstructed.length,
      exactReconstruction: reconstructed === changedText,
      declaredResponseBudgetEstimatedUnits: options.budget,
      ...responseMetrics([baseline, delta], api.calls),
    };
  } finally {f.close();}
});

runQualityTest('automation overlay fixture is omitted without losing visible page controls', () => {
  const f = fixture();
  try {
    const visible = f.document.createElement('button');
    visible.id = 'visible-control';
    visible.textContent = 'Visible';
    const overlay = f.document.createElement('div');
    overlay.setAttribute('data-hermes-automation-overlay', '');
    const hidden = f.document.createElement('button');
    hidden.textContent = 'OVERLAY_SHOULD_NOT_APPEAR';
    overlay.append(hidden);
    const shadowHost = f.document.createElement('div');
    overlay.append(shadowHost);
    const overlayShadow = shadowHost.attachShadow({mode: 'open'});
    const shadowOnlyButton = f.document.createElement('button');
    shadowOnlyButton.textContent = 'OVERLAY_SHADOW_SHOULD_NOT_APPEAR';
    overlayShadow.append(shadowOnlyButton);
    f.document.body.append(visible, overlay);
    const api = measured(f.semantics);
    const page = api.snapshot({mode: 'interactive', composed: true});

    assert.deepEqual(page.items.map(item => item.name), ['Visible']);
    assert.ok(!JSON.stringify(page).includes('OVERLAY_SHOULD_NOT_APPEAR'));
    assert.equal(f.semantics.resolve({...page.binding, snapshotId: page.snapshotId, ref: page.items[0].ref}), visible);
    assert.equal(api.calls.length, 1);

    reports.overlayExclusion = {
      returnedVisibleControls: page.items.length,
      overlayControlsExcluded: true,
      exactVisibleTargetResolved: true,
      ...responseMetrics([page], api.calls),
    };
  } finally {f.close();}
});

after(async () => {
  // Both inputs are fixed module-relative source files, not caller-controlled paths.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const moduleBytes = await readFile(new URL('../../page-semantics/index.js', import.meta.url));
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fixtureBytes = await readFile(new URL('./fixtures.mjs', import.meta.url));
  const report = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    parserSha256: createHash('sha256').update(moduleBytes).digest('hex'),
    fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    measurement: {
      snapshotCalls: 'Count of direct page-semantics.snapshot API invocations made by these fixtures; not model, transport, or browser-tool calls.',
      jsonSize: 'Measured JavaScript JSON.stringify(response).length UTF-16 code units per actual response.',
      estimatedUnits: 'The parser contract estimate ceil(JSON UTF-16 characters / 4); not tokenizer output, token savings, or a quality score.',
      savingsClaimed: false,
    },
    failures,
    scenarios: reports,
  };
  const runDirectory = fileURLToPath(new URL('./runs/', import.meta.url));
  // The destination is fixed to this test-owned directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(runDirectory, {recursive: true});
  const filename = `semantics-quality-${Date.now()}-${randomUUID()}.json`;
  const outputPath = join(runDirectory, filename);
  // A unique name plus wx makes each run append-only; existing evidence is never replaced.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const handle = await open(outputPath, 'wx');
  try {await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');}
  finally {await handle.close();}
  console.log(`SEMANTICS_QUALITY_JSON=${outputPath}`);
});
