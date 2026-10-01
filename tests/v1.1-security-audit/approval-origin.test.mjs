import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalNotifier } from '../../native-extension/approval-notifier.mjs';

function setup() {
  const now = Date.now();
  const calls = { verify: 0, dispatch: 0, removed: [] };
  const chrome = {
    runtime: {
      id: 'synthetic-extension-id',
      getURL: path => `chrome-extension://synthetic-extension-id/${path}`,
    },
    tabs: {
      get: async id => ({ id, windowId: 50, url: 'https://fixture.test/work' }),
    },
    windows: {
      get: async id => ({ id, type: 'normal', left: 0, top: 0, width: 1000, height: 800 }),
      update: async id => ({ id, focused: true }),
      create: async () => ({ id: 60, focused: true, tabs: [{ id: 61 }] }),
      remove: async id => calls.removed.push(id),
    },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
  };
  const notifier = createApprovalNotifier({ chrome, instanceId: 'browser-A', now: () => now });
  const request = {
    id: 'task-A:nonce-A', instanceId: 'browser-A', taskId: 'task-A', generation: 4,
    modeGeneration: 7, nonce: 'nonce-A', tabId: 71, windowId: 50,
    origin: 'https://fixture.test', action: '点击页面 · #save', scope: '本次操作',
    expiresAt: now + 60_000, digest: 'digest-A', taskTitle: 'synthetic task', mode: 'smart',
  };
  const sender = {
    id: 'synthetic-extension-id',
    url: 'chrome-extension://synthetic-extension-id/approval-panel.html',
    tab: { id: 61, windowId: 60 },
  };
  const verify = async current => {
    calls.verify += 1;
    return current.generation === request.generation
      && current.modeGeneration === request.modeGeneration
      && current.nonce === request.nonce
      && current.digest === request.digest;
  };
  const dispatch = async () => { calls.dispatch += 1; };
  return { notifier, request, sender, verify, dispatch, calls };
}

test('forged panel origins, tab IDs, and window IDs cannot submit an approval decision', async () => {
  const h = setup();
  await h.notifier.sync([h.request]);
  const impostors = [
    { ...h.sender, id: 'attacker-extension' },
    { ...h.sender, url: 'chrome-extension://synthetic-extension-id/popup.html' },
    { ...h.sender, tab: { id: 62, windowId: 60 } },
    { ...h.sender, tab: { id: 61, windowId: 99 } },
  ];
  for (const sender of impostors) {
    await assert.rejects(h.notifier.decide({
      sender, requestId: h.request.id, decision: 'approve', verify: h.verify, dispatch: h.dispatch,
    }), /untrusted panel sender/);
  }
  assert.equal(h.calls.verify, 0);
  assert.equal(h.calls.dispatch, 0);
  assert.deepEqual(h.notifier.status(), { kind: 'waiting', pendingCount: 1, panelOpen: true });
  await h.notifier.dispose();
});

test('a trusted panel cannot approve a stale generation/digest; exact live scope is one-shot', async () => {
  const h = setup();
  await h.notifier.sync([h.request]);
  const live = { ...h.request, generation: 5 };
  const staleVerify = async current => {
    h.calls.verify += 1;
    return current.generation === live.generation;
  };
  await assert.rejects(h.notifier.decide({
    sender: h.sender, requestId: h.request.id, decision: 'approve',
    verify: staleVerify, dispatch: h.dispatch,
  }), /stale approval scope/);
  assert.equal(h.calls.dispatch, 0);

  await h.notifier.decide({
    sender: h.sender, requestId: h.request.id, decision: 'approve',
    verify: h.verify, dispatch: h.dispatch,
  });
  assert.equal(h.calls.dispatch, 1);
  await assert.rejects(h.notifier.decide({
    sender: h.sender, requestId: h.request.id, decision: 'approve',
    verify: h.verify, dispatch: h.dispatch,
  }), /untrusted panel sender|stale approval/);
  assert.equal(h.calls.dispatch, 1);
  await h.notifier.dispose();
});
