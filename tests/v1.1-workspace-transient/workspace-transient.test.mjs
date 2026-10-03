import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
import {workspaceFixture} from '../native-extension/workspace-fixture.mjs';

function task(id = 'transient-readback-task') {
  return {
    // 中文注释：现有归属不确定性夹具固定 current 模式。
    id,workWindowMode:'current',
    instanceId: 'fixture-browser-instance',
    approvalScope: 'fixture-transient-owner',
    generation: 1,
  };
}

async function openThroughProductionAdapter(fixture, workspaces, requestId) {
  const current = task();
  const capability = await workspaces.install(current, [{id: 1, windowId: 7}]);
  await assert.rejects(workspaces.open(capability, {
    requestId,
    url: 'https://example.com/transient-readback',
  }));
  const created = [...fixture.tabs.keys()].find(id => id !== 1 && id !== 9);
  assert.ok(Number.isInteger(created), 'tabs.create side effect remains in the fixture');
  return {capability, created};
}

test('transient post-create tabs.get failure never reports cleanup success', async () => {
  const fixture = workspaceFixture();
  const workspaces = new NativeWorkspaces(fixture.api, 'fixture-browser-instance');
  const originalGet = fixture.api.tabs.get;
  let failCreatedRead = true;
  fixture.api.tabs.get = async id => {
    if (failCreatedRead && id !== 1 && id !== 9) {
      failCreatedRead = false;
      throw Error('synthetic temporary tabs.get failure');
    }
    return originalGet(id);
  };

  const {capability, created} = await openThroughProductionAdapter(fixture, workspaces, 'transient-create-read');
  await assert.rejects(workspaces.open(capability, {
    requestId: 'transient-create-read',
    url: 'https://example.com/transient-readback',
  }));
  assert.equal(fixture.creates.length, 1, 'an uncertain request ID never creates a second page');
  const result = await workspaces.cleanup(capability, {closeTabs: true});

  assert.notEqual(result.cleanupState, 'succeeded', 'the live page was never verified gone');
  assert.equal(result.cleanupState, 'unknown');
  assert.deepEqual(result.unknownTabIds, [created]);
  assert.deepEqual(fixture.removed, [], 'a transient lookup failure never authorizes deletion');
  assert.equal(fixture.tabs.has(created), true, 'the uncertain page remains recoverable');
  assert.equal(fixture.tabs.has(1), true, 'the original user tab survives');
  assert.equal(fixture.tabs.has(9), true, 'the unrelated user tab survives');
});

test('a tabs.get not-found error naming another tab stays unknown after creation', async () => {
  const fixture = workspaceFixture();
  const workspaces = new NativeWorkspaces(fixture.api, 'fixture-browser-instance');
  const originalGet = fixture.api.tabs.get;
  let failCreatedRead = true;
  fixture.api.tabs.get = async id => {
    if (failCreatedRead && id !== 1 && id !== 9) {
      failCreatedRead = false;
      throw Error(`No tab with id: ${id + 1000}.`);
    }
    return originalGet(id);
  };

  const {capability, created} = await openThroughProductionAdapter(fixture, workspaces, 'mismatched-not-found-read');
  const result = await workspaces.cleanup(capability, {closeTabs: true});

  assert.equal(result.cleanupState, 'unknown');
  assert.deepEqual(result.unknownTabIds, [created]);
  assert.deepEqual(fixture.removed, [], 'a different tab ID cannot authorize deletion');
  assert.equal(fixture.tabs.has(created), true);
  assert.equal(fixture.tabs.has(1), true, 'the original user tab survives');
  assert.equal(fixture.tabs.has(9), true, 'the unrelated user tab survives');
});

test('transient post-group tabs.get failure remains unknown and is never deleted', async () => {
  const fixture = workspaceFixture();
  const workspaces = new NativeWorkspaces(fixture.api, 'fixture-browser-instance');
  const capability = await workspaces.install(task(), [{id: 1, windowId: 7}]);
  const originalGet = fixture.api.tabs.get;
  const reads = new Map();
  fixture.api.tabs.get = async id => {
    if (id !== 1 && id !== 9) {
      const count = reads.get(id) || 0;
      reads.set(id, count + 1);
      if (count === 1) throw Error('synthetic temporary grouped tabs.get failure');
    }
    return originalGet(id);
  };

  await assert.rejects(workspaces.open(capability, {
    requestId: 'transient-group-read',
    url: 'https://example.com/transient-group-read',
  }));
  const created = [...fixture.tabs.keys()].find(id => id !== 1 && id !== 9);
  assert.ok(Number.isInteger(created));
  const result = await workspaces.cleanup(capability, {closeTabs: true});

  assert.equal(result.cleanupState, 'unknown');
  assert.deepEqual(result.unknownTabIds, [created]);
  assert.deepEqual(fixture.removed, [], 'uncertain grouped ownership is not deletion authority');
  assert.equal(fixture.tabs.has(created), true, 'the grouped page remains recoverable');
  assert.equal(fixture.tabs.has(1), true, 'the original user tab survives');
  assert.equal(fixture.tabs.has(9), true, 'the unrelated user tab survives');
});

test('restart reconciliation preserves transient uncertainty until exact absence is verified', async () => {
  const fixture = workspaceFixture();
  const workspaces = new NativeWorkspaces(fixture.api, 'fixture-browser-instance');
  const capability = await workspaces.install(task(), [{id: 1, windowId: 7}]);
  const originalGet = fixture.api.tabs.get;
  const originalCreate = fixture.api.tabs.create;
  let created;
  let readAvailable = false;
  fixture.api.tabs.create = async params => {
    const tab = await originalCreate(params);
    created = tab.id;
    return tab;
  };
  fixture.api.tabs.get = async id => {
    if (id === created && !readAvailable) throw Error('synthetic temporary tabs.get failure');
    if (id === created && !fixture.tabs.has(id)) throw Error(`No tab with id: ${id}.`);
    return originalGet(id);
  };

  await assert.rejects(workspaces.open(capability, {
    requestId: 'transient-persisted-read',
    url: 'https://example.com/transient-persisted-read',
  }));
  assert.ok(Number.isInteger(created));
  const initial = await workspaces.cleanup(capability, {closeTabs: true});
  assert.equal(initial.cleanupState, 'unknown');
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.tabs.has(created), true);

  const restarted = new NativeWorkspaces(fixture.api, 'fixture-browser-instance');
  const recovered = await restarted.status();
  const recoveredTask = recovered.find(entry => entry.taskId === 'transient-readback-task');
  assert.equal(recoveredTask.state, 'unknown');
  assert.equal(recoveredTask.unknown, 1);
  assert.ok(recoveredTask.tabs.some(tab => tab.tabId === created && tab.state === 'unknown'));
  assert.deepEqual(fixture.removed, [], 'restart reconciliation does not replay deletion');
  assert.equal(fixture.creates.length, 1, 'restart reconciliation does not replay creation');
  assert.equal(fixture.tabs.has(created), true, 'the uncertain page remains available for recovery');

  readAvailable = true;
  fixture.tabs.delete(created);
  await restarted.status();
  const journal = fixture.data['hermes.backgroundWorkspaces.v1'];
  const record = journal.tasks.flatMap(([, storedTask]) => storedTask.requests).find(([, request]) => request.tabId === created)?.[1];
  // 中文注释：已确认结束的任务会从持久化日志压缩掉，不再保留 released 墓碑。
  assert.equal(record, undefined);
  assert.equal((await restarted.status()).some(row=>row.taskId==='transient-readback-task'),false);
  assert.deepEqual(fixture.removed, [], 'verified absence is read back, not deleted again');
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.tabs.has(1), true, 'the original user tab survives');
  assert.equal(fixture.tabs.has(9), true, 'the unrelated user tab survives');
});
