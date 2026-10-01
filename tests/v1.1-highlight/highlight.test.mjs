import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';

const modulePromise = import('../../native-extension/interaction-highlight.mjs').catch(error => ({importError: error}));
const binding = Object.freeze({taskId: 'task-1', generation: 7, documentId: 'document-4'});
const request = operationToken => ({...binding, operationToken});

function fixture(markup = '<button id="target">Run</button>') {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {url: 'https://example.test/', pretendToBeVisual: true});
  const {window} = dom;
  const roots = [];
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function(options) {
    const root = attachShadow.call(this, options);
    roots.push(root);
    return root;
  };
  const target = window.document.querySelector('#target');
  let rect = {left: 12, top: 18, width: 72, height: 24};
  target.getBoundingClientRect = () => ({...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {return this;}});
  target.getClientRects = () => [target.getBoundingClientRect()];
  return {dom, window, document: window.document, target, roots, setRect(value) {rect = value;}};
}

async function loadModule(t) {
  const loaded = await modulePromise;
  assert.equal(loaded.importError, undefined, 'interaction highlight module should be present');
  t.after(() => {});
  return loaded;
}

test('prepare outlines a click target in one closed, non-intercepting host without taking focus', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  f.target.focus();
  const activeBefore = f.document.activeElement;
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});

  const result = highlight.prepare({...request('op-click-1'), kind: 'click', target: f.target});

  assert.deepEqual(result, {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');
  assert.ok(host);
  assert.equal(host.getAttribute('data-hermes-automation-overlay'), '');
  assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.equal(host.style.position, 'fixed');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(host.shadowRoot, null, 'the visual tree must stay in a closed shadow root');
  const shadow = f.roots[0];
  assert.ok(shadow);
  const frame = shadow.querySelector('[data-role="target"]');
  assert.equal(frame.style.left, '12px');
  assert.equal(frame.style.top, '18px');
  assert.equal(shadow.querySelector('[data-role="status"]').textContent, '准备点击');
  assert.equal(frame.style.pointerEvents, 'none');
  assert.equal(f.document.activeElement, activeBefore);
});

test('input and select highlights use fixed Chinese labels and never expose field values', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  for (const [markup, kind, label] of [
    ['<input id="target" value="do-not-show-this-secret">', 'input', '正在输入'],
    ['<select id="target"><option selected value="private-choice">Private choice</option></select>', 'select', '正在选择'],
  ]) {
    const f = fixture(markup);
    t.after(() => {f.dom.window.close();});
    const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
    assert.deepEqual(highlight.prepare({...request(`op-${kind}-1`), kind, target: f.target}), {ok: true});
    const shadow = f.roots[0];
    assert.equal(shadow.querySelector('[data-role="status"]').textContent, label);
    assert.doesNotMatch(shadow.textContent, /do-not-show-this-secret|private-choice|Private choice/);
  }
});

test('semantic extraction excludes the highlight host while retaining ordinary page targets', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<button id="target">Ordinary target</button>');
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-semantic-exclusion'), kind: 'click', target: f.target}), {ok: true});
  const semantics = createPageSemantics({document: f.document, taskId: 'semantic-task', documentId: 'semantic-document', leaseId: 'semantic-lease'});

  const snapshot = semantics.snapshot({mode: 'interactive'});
  const names = snapshot.items.map(item => item.name);

  assert.ok(names.includes('Ordinary target'));
  assert.equal(names.includes('准备点击'), false);
  assert.equal(f.document.querySelector('[data-hermes-automation-overlay]').hasAttribute('aria-hidden'), true);
  semantics.revoke();
});

test('scroll and resize refresh fixed target bounds without changing page styles', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const bodyStyle = f.document.body.getAttribute('style');
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-scroll-1'), kind: 'click', target: f.target}), {ok: true});
  const frame = f.roots[0].querySelector('[data-role="target"]');
  f.setRect({left: 88, top: 41, width: 65, height: 27});
  f.window.dispatchEvent(new f.window.Event('scroll'));
  await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  assert.equal(frame.style.left, '88px');
  assert.equal(frame.style.top, '41px');
  f.setRect({left: 101, top: 52, width: 70, height: 29});
  f.window.dispatchEvent(new f.window.Event('resize'));
  await new Promise(resolve => f.window.requestAnimationFrame(resolve));
  assert.equal(frame.style.left, '101px');
  assert.equal(frame.style.width, '70px');
  assert.equal(f.document.body.getAttribute('style'), bodyStyle);
});

test('drag highlights both source and destination endpoints', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<button id="target">Start</button><button id="drop">Drop</button>');
  t.after(() => {f.dom.window.close();});
  const destination = f.document.querySelector('#drop');
  destination.getBoundingClientRect = () => ({left: 140, top: 65, width: 40, height: 30, right: 180, bottom: 95, x: 140, y: 65});
  destination.getClientRects = () => [destination.getBoundingClientRect()];
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});

  const result = highlight.prepare({...request('op-drag-1'), kind: 'drag', from: f.target, to: destination});

  assert.deepEqual(result, {ok: true});
  const shadow = f.roots[0];
  assert.equal(shadow.querySelector('[data-role="status"]').textContent, '正在拖动');
  assert.equal(shadow.querySelector('[data-role="drag-start"]').style.left, '12px');
  assert.equal(shadow.querySelector('[data-role="drag-end"]').style.left, '140px');
});

test('detaching the target cancels and removes the highlight without an action replay', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-detach-1'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');

  f.target.remove();
  await new Promise(resolve => f.window.requestAnimationFrame(resolve));

  assert.equal(f.document.querySelector('[data-hermes-interaction-highlight]'), null);
  assert.equal(host.isConnected, false);
});

test('an existing automation overlay prevents a second simultaneous highlight host', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<div data-hermes-automation-overlay></div><button id="target">Run</button>');
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});

  const result = highlight.prepare({...request('op-conflict'), kind: 'click', target: f.target});

  assert.deepEqual(result, {ok: false, code: 'OVERLAY_CONFLICT'});
  assert.equal(f.document.querySelector('[data-hermes-interaction-highlight]'), null);
});

test('a stale highlight host from another isolated execution context prevents duplicate hosts', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<div data-hermes-automation-overlay data-hermes-interaction-highlight></div><button id="target">Run</button>');
  t.after(() => {f.dom.window.close();});
  const existing = f.document.querySelector('[data-hermes-interaction-highlight]');
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});

  const result = highlight.prepare({...request('op-duplicate'), kind: 'click', target: f.target});

  assert.deepEqual(result, {ok: false, code: 'OVERLAY_CONFLICT'});
  assert.equal(f.document.querySelectorAll('[data-hermes-interaction-highlight]').length, 1);
  assert.equal(existing.isConnected, true, 'a different context’s host is not ours to remove');
});

test('update rebinds the active operation to fresh target geometry', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<button id="target">First</button><button id="other">Second</button>');
  t.after(() => {f.dom.window.close();});
  const other = f.document.querySelector('#other');
  other.getBoundingClientRect = () => ({left: 160, top: 92, width: 34, height: 21, right: 194, bottom: 113, x: 160, y: 92});
  other.getClientRects = () => [other.getBoundingClientRect()];
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-update-1'), kind: 'click', target: f.target}), {ok: true});

  const result = highlight.update({...request('op-update-1'), target: other});

  assert.deepEqual(result, {ok: true});
  assert.equal(f.roots[0].querySelector('[data-role="target"]').style.left, '160px');
});

test('clear requires the matching operation token and then removes the host', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-clear-2'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');

  assert.deepEqual(highlight.clear(request('op-clear-1')), {ok: false, code: 'STALE_OPERATION'});
  assert.equal(host.isConnected, true);
  assert.deepEqual(highlight.clear(request('op-clear-2')), {ok: true});
  assert.equal(host.isConnected, false);
});

test('complete keeps a matching operation visible briefly, then removes it', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-complete-1'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');

  assert.deepEqual(highlight.complete({...request('op-complete-1'), durationMs: 35}), {ok: true});
  assert.equal(host.isConnected, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(host.isConnected, false);
});

test('an already-queued old completion cannot remove a newer operation highlight', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture('<button id="target">First</button><input id="next" value="private">');
  t.after(() => {f.dom.window.close();});
  const next = f.document.querySelector('#next');
  next.getBoundingClientRect = () => ({left: 120, top: 76, width: 45, height: 20, right: 165, bottom: 96, x: 120, y: 76});
  next.getClientRects = () => [next.getBoundingClientRect()];
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const queued = [];
  globalThis.setTimeout = callback => {queued.push(callback); return queued.length;};
  globalThis.clearTimeout = () => {};
  try {
    assert.deepEqual(highlight.prepare({...request('op-old'), kind: 'click', target: f.target}), {ok: true});
    assert.deepEqual(highlight.complete({...request('op-old'), durationMs: 30}), {ok: true});
    assert.deepEqual(highlight.prepare({...request('op-new'), kind: 'input', target: next}), {ok: true});
    queued[0]();
    assert.deepEqual(highlight.complete({...request('op-old'), durationMs: 30}), {ok: false, code: 'STALE_OPERATION'});
    assert.equal(f.document.querySelector('[data-hermes-interaction-highlight]')?.isConnected, true);
    assert.equal(f.roots.at(-1).querySelector('[data-role="status"]').textContent, '正在输入');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('suspend hides the host during capture and scoped resume restores it', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-capture-1'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');

  const lease = highlight.suspend({...request('op-capture-1'), reason: 'screenshot'});
  assert.equal(lease.ok, true);
  assert.equal(f.window.getComputedStyle(host).display, 'none');
  assert.equal(f.window.getComputedStyle(host).pointerEvents, 'none');
  const captureSawHiddenHost = f.window.getComputedStyle(host).display === 'none';
  assert.equal(captureSawHiddenHost, true);

  assert.deepEqual(highlight.resume({...request('op-capture-1'), suspensionId: lease.suspensionId}), {ok: true});
  assert.notEqual(f.window.getComputedStyle(host).display, 'none');
});

test('screenshot suspension fails closed and removes the host if hidden state cannot be confirmed', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-capture-fail'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');
  const getComputedStyle = f.window.getComputedStyle.bind(f.window);
  f.window.getComputedStyle = element => element === host ? {display: 'block'} : getComputedStyle(element);
  let captureCalled = false;

  const lease = highlight.suspend({...request('op-capture-fail'), reason: 'screenshot'});
  if (lease.ok) captureCalled = true;

  assert.deepEqual(lease, {ok: false, code: 'HIDE_FAILED'});
  assert.equal(captureCalled, false);
  assert.equal(host.isConnected, false);
});

test('resume does not reveal a target that detached while screenshot capture was suspended', async t => {
  const {createInteractionHighlight} = await loadModule(t);
  const f = fixture();
  t.after(() => {f.dom.window.close();});
  const highlight = createInteractionHighlight({...binding, document: f.document, isCurrent: () => true});
  assert.deepEqual(highlight.prepare({...request('op-capture-detach'), kind: 'click', target: f.target}), {ok: true});
  const host = f.document.querySelector('[data-hermes-interaction-highlight]');
  const lease = highlight.suspend({...request('op-capture-detach'), reason: 'screenshot'});
  assert.equal(lease.ok, true);

  f.target.remove();
  const result = highlight.resume({...request('op-capture-detach'), suspensionId: lease.suspensionId});

  assert.deepEqual(result, {ok: false, code: 'RESTORE_FAILED'});
  assert.equal(host.isConnected, false);
});
