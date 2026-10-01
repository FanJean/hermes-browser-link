import { createInterface } from 'node:readline';
import { webcrypto } from 'node:crypto';
import { Executor } from '../../native-extension/core.mjs';

globalThis.crypto ??= webcrypto;
const task = JSON.parse(process.argv[2]);
const trace = [];
let loaderId = 'loader-initial';
const tab = {
  id: 41,
  url: 'https://example.test/',
  status: 'complete',
  windowId: 1,
  groupId: 1,
};
const clone = value => structuredClone(value);
const api = {
  tabs: {
    get: async id => {
      if (id !== tab.id) throw new Error('tab not found');
      return clone(tab);
    },
    update: async (id, changes) => {
      if (id !== tab.id) throw new Error('tab not found');
      Object.assign(tab, changes, {status: 'complete'});
      loaderId += '-next';
      trace.push({kind: 'tabs.update', id, url: tab.url});
      return clone(tab);
    },
  },
  debugger: {
    attach: async target => { trace.push({kind: 'debugger.attach', target}); },
    detach: async target => { trace.push({kind: 'debugger.detach', target}); },
    sendCommand: async (target, method, params) => {
      trace.push({kind: 'debugger.command', target, method});
      if (method === 'Page.getFrameTree') {
        return {frameTree: {frame: {
          id: 'frame-41', url: tab.url, loaderId,
        }}};
      }
      if (method === 'Page.createIsolatedWorld') {
        return {executionContextId: 41};
      }
      if (method === 'Runtime.callFunctionOn') {
        const [operation, payload] = params.arguments.map(item => item.value);
        if (operation !== 'semantic_snapshot') throw new Error('unsupported synthetic page operation');
        return {result: {value: {
          version: 2,
          binding: payload.binding,
          snapshotId: 'synthetic-snapshot-' + loaderId,
          items: [{ref: 'fake-chrome-node-1', role: 'button', name: 'Save'}],
          coverage: {complete: true, returned: 1},
        }}};
      }
      throw new Error('unsupported fake Chrome command: ' + method);
    },
  },
};

const executor = new Executor(api);
const generation = task.generation;
const modeGeneration = task.modeGeneration;
const approvalTask = {
  ...task,
  activeMode: 'smart',
  modeGeneration: modeGeneration - 1,
};
await executor.approve(approvalTask);
executor.setMode({...task, activeMode: 'full', modeGeneration});
process.stdout.write(JSON.stringify({ready: true}) + '\n');

const input = createInterface({input: process.stdin, crlfDelay: Infinity});
let pending = Promise.resolve();
input.on('line', line => {
  pending = pending.then(async () => {
    const request = JSON.parse(line);
    if (request.stop === true) {
      input.close();
      return;
    }
    try {
      const result = await executor.execute(request.params);
      process.stdout.write(JSON.stringify({id: request.id, result, trace: trace.splice(0)}) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({
        id: request.id,
        error: {message: String(error?.message || 'fake Chrome executor error'), code: String(error?.code || '')},
        trace: trace.splice(0),
      }) + '\n');
    }
  });
});
