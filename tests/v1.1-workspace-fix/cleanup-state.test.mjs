import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthority, createWorkspaces} from '../../browser-workspaces/index.mjs';

function fixture() {
  let nextTabId = 2;
  let nextGroupId = 10;
  let stored;
  const groupInfo = new Map();
  const tabs = new Map([[1, {id: 1, windowId: 1, groupId: -1, active: true}]]);
  const calls = {remove: []};
  const api = {
    tabs: {
      async query() { return [...tabs.values()].map(tab => ({...tab})); },
      async create(params) {
        const tab = {id: nextTabId++, groupId: -1, ...params};
        tabs.set(tab.id, tab);
        return {...tab};
      },
      async get(id) {
        if (!tabs.has(id)) throw Error(`No tab with id: ${id}.`);
        return {...tabs.get(id)};
      },
      async group(params) {
        const groupId = params.groupId ?? nextGroupId++;
        for (const id of [params.tabIds].flat()) tabs.get(id).groupId = groupId;
        return groupId;
      },
      async remove(id) {
        calls.remove.push(id);
        tabs.delete(id);
      },
    },
    tabGroups: {async update(id,p) {groupInfo.set(id,{id,windowId:1,...p});},async get(id) {return {...groupInfo.get(id)};}},
    storage: {local: {
      async get(key) { return {[key]: stored}; },
      async set(value) { stored = structuredClone(Object.values(value)[0]); },
    }},
  };
  const authority = createAuthority('synthetic-cleanup-instance');
  const capability = authority.issue({owner: 'owner', task: 'task', generation: 1, windowId: 1});
  const manager = createWorkspaces({chrome: api, authority});
  return {
    api, authority, capability, calls, manager, tabs,
    restart() { return createWorkspaces({chrome: api, authority}); },
  };
}

async function ownedTab(f) {
  return f.manager.open(f.capability, {requestId: 'owned-page', url: 'https://example.test/start'});
}

test('failed removal stays failed across restart and read-only reconciliation without retry', async () => {
  const f = fixture();
  const created = await ownedTab(f);
  f.api.tabs.remove = async id => {
    f.calls.remove.push(id);
    throw Error('synthetic removal failure');
  };

  await assert.rejects(f.manager.cleanup(f.capability), /synthetic removal failure/);
  const firstRead = await f.manager.status(f.capability);
  assert.equal(firstRead.cleanupState, 'failed');
  assert.deepEqual(firstRead.remainingTabIds, []);
  assert.deepEqual(firstRead.preservedTabIds, [created.tabId]);
  assert.equal(firstRead.preservedCount, 1);
  assert.equal(f.tabs.has(created.tabId), true);
  assert.equal(f.tabs.has(1), true, 'the original user tab survives');

  const restarted = f.restart();
  await restarted.reconcile();
  const afterRestart = await restarted.status(f.capability);
  const repeatedRead = await restarted.status(f.capability);
  assert.equal(afterRestart.cleanupState, 'failed');
  assert.equal(repeatedRead.cleanupState, 'failed');
  assert.deepEqual(f.calls.remove, [created.tabId], 'read-only reconciliation never retries deletion');
  assert.equal(f.tabs.has(created.tabId), true);
  assert.equal(f.tabs.has(1), true);
});

test('a lost remove response is success only after an explicit missing-tab readback', async () => {
  const f = fixture();
  const created = await ownedTab(f);
  f.api.tabs.remove = async id => {
    f.calls.remove.push(id);
    f.tabs.delete(id); // Browser side effect completed, then its response was lost.
    throw Error('synthetic remove response lost');
  };

  const result = await f.manager.cleanup(f.capability);
  assert.equal(result.cleanupState, 'succeeded');
  assert.deepEqual(result.remainingTabIds, []);
  assert.deepEqual(result.unknownTabIds, []);
  assert.equal(f.tabs.has(created.tabId), false);
  assert.equal(f.tabs.has(1), true, 'the original user tab survives');
  assert.deepEqual(f.calls.remove, [created.tabId], 'the uncertain removal is not replayed');
});

test('an unavailable ownership readback is unknown and never authorizes deletion', async () => {
  const f = fixture();
  const created = await ownedTab(f);
  f.api.tabs.get = async () => { throw Error('synthetic tabs.get unavailable'); };

  const result = await f.manager.cleanup(f.capability);
  assert.equal(result.cleanupState, 'unknown');
  assert.ok(result.unknownTabIds.includes(created.tabId));
  assert.deepEqual(f.calls.remove, [], 'unknown ownership is not deletion authority');
  assert.equal(f.tabs.has(created.tabId), true);
  assert.equal(f.tabs.has(1), true, 'the original user tab survives');
});

test('a not-found error for a different tab ID is not evidence that this page disappeared', async () => {
  const f = fixture();
  const created = await ownedTab(f);
  f.api.tabs.get = async () => { throw Error('No tab with id: 999.'); };

  const result = await f.manager.cleanup(f.capability);
  assert.equal(result.cleanupState, 'unknown');
  assert.ok(result.unknownTabIds.includes(created.tabId));
  assert.deepEqual(f.calls.remove, []);
  assert.equal(f.tabs.has(created.tabId), true);
  assert.equal(f.tabs.has(1), true, 'the original user tab survives');
});

test('a workspace tab moved by the user is preserved rather than deleted', async () => {
  const f = fixture();
  const created = await ownedTab(f);
  f.tabs.get(created.tabId).groupId = 999;

  const result = await f.manager.cleanup(f.capability);
  assert.ok(result.preservedTabIds.includes(created.tabId));
  assert.deepEqual(f.calls.remove, []);
  assert.equal(f.tabs.has(created.tabId), true);
  assert.equal(f.tabs.has(1), true, 'the original user tab survives');
});
