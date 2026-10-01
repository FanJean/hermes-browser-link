import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Executor} from '../../native-extension/core.mjs';
import {workspaceFixture} from '../native-extension/workspace-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const BRIDGE_DIR = resolve(REPO_ROOT, 'native-bridge');
const DAEMON_WORKER = resolve(HERE, 'daemon-worker.py');
const ORIGIN = 'https://example.com';
const START_URL = `${ORIGIN}/start`;
const OWNER = 'recovery-owner';
// Persistence is stubbed, but diagnostics still land here; keep them out of the repository.
// 中文注释：每个合成 daemon 独占私有数据，避免前一个用例的账本污染。

class DaemonHarness {
  constructor(executor) {
    this.executor = executor;
    this.home=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'recovery-home-'));
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.child = spawn(process.env.HERMES_TEST_PYTHON || 'python3', [DAEMON_WORKER], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRIDGE_DIR,
        PYTHONDONTWRITEBYTECODE: '1',
        BRIDGE_TEST_HOME: this.home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.lines = createInterface({input: this.child.stdout});
    this.lines.on('line', line => this.#receive(line));
    this.child.once('error', error => this.#fail(error));
    this.child.once('exit', (code, signal) => {
      const detail = `daemon harness exited (${code ?? signal}): ${this.stderr}`;
      this.#fail(Error(detail));
    });
  }

  #fail(error) {
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.#fail(Error(`invalid synthetic daemon JSON: ${line}`)); return; }
    if (message.type === 'ready') {
      this.resolveReady();
      return;
    }
    if (message.type === 'protocol_error') {
      this.#fail(Error(`synthetic daemon protocol error: ${message.message}`));
      return;
    }
    if (message.type === 'extension_call') {
      void this.#handleExtensionCall(message);
      return;
    }
    if (message.type === 'result') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    this.#fail(Error(`unexpected synthetic daemon message: ${line}`));
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #handleExtensionCall(message) {
    let response;
    try {
      let result;
      switch (message.method) {
        case 'browser.execute':
          result = await this.executor.execute(message.params);
          break;
        case 'browser.release':
          result = await this.executor.release(message.params);
          break;
        case 'browser.cleanup_status':
          result = await this.executor.cleanupStatus(message.params);
          break;
        case 'browser.cleanup_retry':
          result = await this.executor.cleanupRetry(message.params);
          break;
        default:
          throw Object.assign(Error(`unsupported test extension method: ${message.method}`), {code: 'unsupported_method'});
      }
      response = {result};
    } catch (error) {
      response = {
        error: {
          code: error?.code || 'execution_denied',
          message: String(error?.message || 'synthetic extension failure'),
          data: {outcomeUnknown: error?.code === 'workspace_unknown', retryable: false},
        },
      };
    }
    this.#send({type: 'extension_response', id: message.id, ...response});
  }

  async #request(type, method, params) {
    await this.ready;
    const id = `test:${++this.sequence}`;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, {resolve: resolveResponse, reject: rejectResponse});
    });
    this.#send({type, id, method, params});
    return response;
  }

  client(method, params) { return this.#request('client', method, params); }
  extension(method, params) { return this.#request('extension', method, params); }

  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await once(this.child, 'exit');
    this.lines.close();rmSync(this.home,{recursive:true,force:true});
  }
}

async function makeScenario(t) {
  const fixture = workspaceFixture();
  let daemon;
  const extensionEvents = [];
  const executor = new Executor(fixture.api, event => {
    if (daemon) extensionEvents.push(daemon.extension('extension.tab_event', event));
  });
  daemon = new DaemonHarness(executor);
  await daemon.ready;
  t.after(() => daemon.close());
  return {fixture, executor, daemon, extensionEvents};
}

async function requireResult(response, label) {
  assert.equal(response.error, undefined, `${label}: ${JSON.stringify(response.error)}`);
  assert.ok(Object.hasOwn(response, 'result'), `${label}: missing result envelope`);
  return response.result;
}

async function createTask(harness, owner = OWNER, title = 'synthetic workspace recovery') {
  return requireResult(await harness.client('shared.create', {
    owner,
    title,
    instanceId: 'synthetic-instance',
    allowedOrigins: [ORIGIN],
  }), 'shared.create');
}

async function approveExistingTab(harness, executor, task, tabIds = [1]) {
  const approval = await requireResult(await harness.extension('extension.approve', {
    taskId: task.id,
    tabIds,
    allowedOrigins: [ORIGIN],
  }), 'extension.approve');
  await executor.approve(approval);
  const mode = await requireResult(await harness.extension('extension.mode', {
    taskId: task.id,
    mode: 'full',
    generation: task.generation,
    modeGeneration: approval.modeGeneration,
  }), 'extension.mode');
  executor.setMode(mode);
  return mode;
}

async function approveWorkspaceOnly(harness, executor, task) {
  const approval = await requireResult(await harness.extension('extension.approve', {
    taskId: task.id,
    tabIds: [],
    allowedOrigins: [ORIGIN],
    generation: task.generation,
    workspaceOnly: true,
  }), 'workspace-only extension.approve');
  await executor.approve(approval);
  const mode = await requireResult(await harness.extension('extension.mode', {
    taskId: task.id,
    mode: 'full',
    generation: task.generation,
    modeGeneration: approval.modeGeneration,
  }), 'workspace-only extension.mode');
  executor.setMode(mode);
  return mode;
}

async function newTaskTab(harness, task, owner, requestId, url = START_URL) {
  return requireResult(await harness.client('shared.run', {
    owner,
    taskId: task.id,
    requestId,
    action: 'new_tab',
    url,
  }), 'shared.run new_tab');
}

test('cross-origin redirect freezes the tab but keeps the task, lease and group; returning resumes in the same group', async t => {
  const {fixture, executor, daemon, extensionEvents} = await makeScenario(t);
  const task = await createTask(daemon);
  await approveExistingTab(daemon, executor, task);

  const first = await newTaskTab(daemon, task, OWNER, 'generation-one-tab');
  assert.equal(first.groupId, 20);
  assert.equal(fixture.tabs.get(first.tabId).groupId, first.groupId);

  // Model a committed redirect (or the user switching the work tab to another
  // site), then run the production Executor tab-event path into the real daemon.
  const oldPage = fixture.tabs.get(first.tabId);
  oldPage.url = 'https://redirect.example.net/final';
  await executor.tabEvent(first.tabId, 'navigated', oldPage.url);
  const redirectEvent = (await Promise.all(extensionEvents.splice(0))).at(-1);
  assert.equal(redirectEvent.error, undefined);

  const frozen = await requireResult(await daemon.client('shared.get', {
    owner: OWNER,
    taskId: task.id,
  }), 'shared.get after redirect');
  assert.equal(frozen.state, 'ready', 'leaving the approved site must not abandon the task');
  assert.ok(frozen.tabIds.includes(first.tabId));
  assert.deepEqual(frozen.outOfScopeTabIds, [first.tabId]);
  assert.equal(JSON.stringify(frozen).includes('redirect.example.net'), false, 'foreign URL is never reported');

  const offSiteRead = await daemon.client('shared.run', {
    owner: OWNER,
    taskId: task.id,
    requestId: 'off-site-page-read',
    action: 'snapshot',
    tabId: first.tabId,
  });
  // This scenario's synthetic bridge maps every failure to execution_denied;
  // the production bridge maps TAB_OUT_OF_SCOPE to tab_out_of_scope.
  assert.equal(offSiteRead.error.message, 'TAB_OUT_OF_SCOPE');
  assert.equal(offSiteRead.error.data.outcomeUnknown, false);

  // Back on the approved site the same tab is usable again, and new work tabs
  // join the existing group instead of a fresh one.
  oldPage.url = START_URL;
  await executor.tabEvent(first.tabId, 'navigated', oldPage.url);
  await Promise.all(extensionEvents.splice(0));
  const second = await newTaskTab(daemon, task, OWNER, 'same-group-tab', START_URL);
  assert.notEqual(second.tabId, first.tabId);
  assert.equal(second.groupId, first.groupId);

  // Same URL in a different task must remain a separate page/group and lease.
  const peerOwner = 'peer-owner';
  const peerTask = await createTask(daemon, peerOwner, 'peer task same URL');
  await approveWorkspaceOnly(daemon, executor, peerTask);
  const peerPage = await newTaskTab(daemon, peerTask, peerOwner, 'peer-same-url', START_URL);
  assert.equal(fixture.tabs.get(peerPage.tabId).url, START_URL);
  assert.notEqual(peerPage.tabId, second.tabId);
  assert.notEqual(peerPage.groupId, second.groupId);
  const crossTaskRead = await daemon.client('shared.run', {
    owner: OWNER,
    taskId: task.id,
    requestId: 'cannot-read-peer-page',
    action: 'snapshot',
    tabId: peerPage.tabId,
  });
  assert.equal(crossTaskRead.error.code, 'foreign_tab');

  const closed = await requireResult(await daemon.client('shared.close', {
    owner: OWNER,
    taskId: task.id,
  }), 'shared.close recovered task');
  assert.equal(closed.state, 'closed');
  assert.deepEqual([...fixture.removed].sort((a, b) => a - b), [first.tabId, second.tabId]);
  assert.equal(fixture.tabs.has(peerPage.tabId), true, 'peer task page survives closing this task');
  assert.equal(fixture.tabs.has(1), true, 'original approved user tab is never deleted');
  assert.equal(fixture.tabs.has(9), true, 'unapproved user tab is never deleted');

  const recorded = await requireResult(await daemon.client('shared.get', {
    owner: OWNER,
    taskId: task.id,
  }), 'shared.get group records');
  assert.deepEqual(recorded.workTabs.map(tab => tab.groupId), [first.groupId, first.groupId]);
});

test('lost group response after page creation is unknown, retained, and never replayed', async t => {
  const {fixture, executor, daemon} = await makeScenario(t);
  const task = await createTask(daemon);
  await approveExistingTab(daemon, executor, task);

  const group = fixture.api.tabs.group;
  fixture.api.tabs.group = async params => {
    await group(params); // Synthetic browser side effect completes before response loss.
    throw Error('synthetic tabs.group response lost');
  };
  const failed = await daemon.client('shared.run', {
    owner: OWNER,
    taskId: task.id,
    requestId: 'group-response-lost',
    action: 'new_tab',
    url: START_URL,
  });
  assert.equal(failed.error.code, 'workspace_unknown');
  assert.equal(fixture.tabs.has(3), true, 'created page survives uncertain grouping result');
  assert.deepEqual(fixture.removed, []);

  const taskState = await requireResult(await daemon.client('shared.get', {
    owner: OWNER,
    taskId: task.id,
  }), 'shared.get after uncertain create');
  assert.equal(taskState.state, 'needs_sync');
  assert.equal(taskState.workspaceState, 'unknown');

  const workspaceStatus = await executor.workspaces.status();
  const entry = workspaceStatus.find(item => item.taskId === task.id && item.generation === 1);
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.unknown, 1);
  assert.ok(entry.tabs.some(tab => tab.tabId === 3 && tab.state === 'unknown'));

  const resumed = await requireResult(await daemon.client('shared.resume', {
    owner: OWNER,
    taskId: task.id,
  }), 'resume after uncertain create');
  await approveWorkspaceOnly(daemon, executor, resumed);
  const replay = await daemon.client('shared.run', {
    owner: OWNER,
    taskId: task.id,
    requestId: 'group-response-lost',
    action: 'new_tab',
    url: START_URL,
  });
  assert.equal(replay.error.code, 'request_outcome_unavailable');
  assert.equal(fixture.creates.length, 1, 'unknown request ID never creates a second page');
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.tabs.has(1), true);
  assert.equal(fixture.tabs.has(9), true);
});

test('failed cleanup after successful page creation reports unknown and never removes user tabs', async t => {
  const {fixture, executor, daemon} = await makeScenario(t);
  const task = await createTask(daemon);
  await approveExistingTab(daemon, executor, task);
  const created = await newTaskTab(daemon, task, OWNER, 'page-to-clean-up');

  const attempted = [];
  fixture.api.tabs.remove = async id => {
    attempted.push(id);
    throw Error('synthetic tabs.remove failure');
  };
  const closed = await requireResult(await daemon.client('shared.close', {
    owner: OWNER,
    taskId: task.id,
  }), 'close with failed cleanup');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.cleanupState, 'unknown');
  assert.deepEqual(attempted, [created.tabId], 'only positively journaled workspace tabs may be removed');
  assert.equal(fixture.tabs.has(created.tabId), true, 'failed page cleanup remains visible');
  assert.equal(fixture.tabs.has(1), true, 'original approved user tab survives cleanup failure');
  assert.equal(fixture.tabs.has(9), true, 'unapproved user tab survives cleanup failure');
});

test('read-only cleanup reconciliation does not upgrade a failed removal to success', async t => {
  const {fixture, executor, daemon} = await makeScenario(t);
  const task = await createTask(daemon);
  await approveExistingTab(daemon, executor, task);
  const created = await newTaskTab(daemon, task, OWNER, 'failed-removal-readback');

  fixture.api.tabs.remove = async () => { throw Error('synthetic tabs.remove failure'); };
  const closed = await requireResult(await daemon.client('shared.close', {
    owner: OWNER,
    taskId: task.id,
  }), 'close before cleanup reconciliation');
  assert.equal(closed.cleanupState, 'unknown');

  const reconciled = await requireResult(await daemon.client('shared.cleanup_status', {
    owner: OWNER,
    taskId: task.id,
  }), 'read-only cleanup_status');
  assert.notEqual(reconciled.cleanupState, 'succeeded', 'a retained page after failed removal is not verified cleanup');
  assert.ok(reconciled.cleanupState === 'unknown' || reconciled.cleanupState === 'failed');
  assert.equal(reconciled.cleanupPreservedCount, 1);
  assert.equal(fixture.tabs.has(created.tabId), true);
  assert.equal(fixture.tabs.has(1), true);
  assert.equal(fixture.tabs.has(9), true);
});
