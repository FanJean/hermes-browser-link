// Synthetic native peer: production Bridge + Executor over the real daemon UDS.
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {Bridge,BrowserConsent} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';
import {workspaceFixture} from '../native-extension/workspace-fixture.mjs';

const home = process.argv[2];
if (!home) throw new Error('expected isolated daemon HOME');
const socketPath = `${home}/plugin-data/browser-link-native/bridge.sock`;
const tokenPath = `${home}/plugin-data/browser-link-native/token`;
const token = (await import('node:fs/promises')).readFile(tokenPath, 'utf8').then(value => value.trim());
const authToken = await token;
const instances = [
  {instanceId: 'chrome-synthetic', browser: 'chrome'},
  {instanceId: 'edge-synthetic', browser: 'edge'},
];

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
class EventList {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}
class NativePort {
  constructor(socket) {
    this.socket = socket;
    this.onMessage = new EventList();
    this.onDisconnect = new EventList();
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try { this.onMessage.emit(JSON.parse(line)); }
        catch (error) { emit({type: 'peer_error', message: String(error?.message || error)}); }
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => this.onDisconnect.emit());
  }
  postMessage(message) { this.socket.write(`${JSON.stringify(message)}\n`); }
}

function makeSyntheticApi(instanceId, browser) {
  // 中文注释：复用现有工作区浏览器边界，建页、分组和清理仍调用生产管理器。
  const workspace=workspaceFixture(),tabs=workspace.tabs;
  tabs.clear();
  for(const [id,tab] of [71, 72].map((id, index) => [id, {
    id,
    url: `https://example.test/${browser}/${index + 1}`,
    title: `Synthetic ${browser} tab ${id}`,
    status: 'complete',
    windowId: 7,
    groupId: -1,
  }]))tabs.set(id,tab);
  const gets = Object.create(null);
  const updates = Object.create(null);
  const gates = new Map();
  const api = {
    ...workspace.api,
    tabs: {
      ...workspace.api.tabs,
      async get(id) {
        gets[id] = (gets[id] || 0) + 1;
        const gate = gates.get(id);
        if (gate && !gate.entered) {
          gate.entered = true;
          emit({type: 'get_entered', instanceId, tabId: id});
        }
        if (gate) await gate.promise;
        const tab = tabs.get(id);
        if (!tab) throw new Error('synthetic tab unavailable');
        return structuredClone(tab);
      },
      async update(id, change) {
        updates[id] = (updates[id] || 0) + 1;
        const tab = tabs.get(id);
        if (!tab) throw new Error('synthetic tab unavailable');
        Object.assign(tab, change, {status: 'complete'});
        return structuredClone(tab);
      },
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() { throw new Error('unexpected CDP call in concurrency fixture'); },
    },
  };
  return {
    api,
    tabs,
    gets,
    updates,
    gates,
    pauseGet(tabId) {
      if (gates.has(tabId)) throw new Error('get gate already exists');
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gates.set(tabId, {promise, release, entered: false});
    },
    resumeGet(tabId) {
      const gate = gates.get(tabId);
      if (!gate) throw new Error('get gate missing');
      gates.delete(tabId);
      gate.release();
    },
    stats() {
      return {
        gets: {...gets},
        updates: {...updates},
        tabs: Object.fromEntries([...tabs].map(([id, tab]) => [id, structuredClone(tab)])),
      };
    },
    resetCounts() {
      for (const key of Object.keys(gets)) delete gets[key];
      for (const key of Object.keys(updates)) delete updates[key];
    },
  };
}

const sessions = new Map();
function makeSession({instanceId, browser}) {
  const fixture = makeSyntheticApi(instanceId, browser);
  const session = {
    instanceId,
    browser,
    fixture,
    executor: new Executor(fixture.api),
    bridge: null,
    port: null,
    disconnecting: Promise.resolve(),
  };
  return session;
}

async function connectSession(session) {
  if (session.bridge) throw new Error('peer already connected');
  const socket = createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const port = new NativePort(socket);
  session.port = port;
  socket.write(`${JSON.stringify({role: 'extension', token: authToken, origin: 'chrome-extension://synthetic/'})}\n`);
  const bridge = new Bridge(port, session.executor,()=>{
    // 中文注释：与后台相同，收到任务变更后只为已开启访问的新任务安装授权。
    // 中文注释：两档模式都会自动安装新任务，智能审批只延后高风险动作。
    if(session.consent)void session.consent.synchronize(bridge).catch(error=>emit({type:'peer_error',message:String(error)}));
  },{onConsentStatus:async()=>session.consent?.enabled?'enabled':'disabled'});
  session.bridge = bridge;
  port.onDisconnect.addListener(() => {
    if (session.bridge !== bridge) return;
    session.bridge = null;
    bridge.close();
    session.disconnecting = session.executor.disconnect().catch(error => {
      emit({type: 'peer_error', instanceId: session.instanceId, message: String(error?.message || error)});
    }).then(() => emit({type: 'peer_disconnected', instanceId: session.instanceId}));
  });
  const result = await bridge.request('extension.hello', {
    instanceId: session.instanceId,
    browser: session.browser,
    version: 'synthetic-test',
    capabilities:{consentStatus:true},
  });
  if (result?.connected !== true) throw new Error('daemon did not accept synthetic extension');
  return result;
}

for (const config of instances) sessions.set(config.instanceId, makeSession(config));
await Promise.all([...sessions.values()].map(connectSession));
emit({type: 'ready', instances: instances.map(item => item.instanceId)});

function sessionFor(value) {
  const session = sessions.get(value);
  if (!session) throw new Error(`unknown synthetic instance: ${value}`);
  return session;
}
async function handle(command) {
  const session = command.instanceId ? sessionFor(command.instanceId) : null;
  switch (command.command) {
    // 中文注释：通过生产授权控制器和真实 daemon 协议验收撤权，不在夹具里模拟终态。
    case 'consent': {
      session.consent ||= new BrowserConsent({set:async()=>{}},session.executor);
      await session.consent.setEnabled(command.enabled,session.bridge);
      await session.consent.synchronize(session.bridge);
      return {enabled:session.consent.enabled};
    }
    case 'approve': {
      if (!session?.bridge) throw new Error('synthetic extension disconnected');
      const result = await session.bridge.request('extension.approve', {
        taskId: command.taskId,
        tabIds: [command.tabId],
        allowedOrigins: ['https://example.test'],
      });
      return result;
    }
    case 'mode': {
      if (!session?.bridge) throw new Error('synthetic extension disconnected');
      const local = session.executor.tasks.get(command.taskId);
      if (!local) throw new Error('synthetic task not locally approved');
      const result = await session.bridge.request('extension.mode', {
        taskId: command.taskId,
        generation: command.generation,
        modeGeneration: local.policy.modeGeneration,
        mode: command.mode || 'full',
      });
      if (result.activeMode === 'full') session.executor.setMode(result);
      return result;
    }
    case 'pause_get':
      session.fixture.pauseGet(command.tabId);
      return {paused: true};
    case 'resume_get':
      session.fixture.resumeGet(command.tabId);
      return {resumed: true};
    case 'reset_counts':
      session.fixture.resetCounts();
      return {reset: true};
    case 'stats': {
      const executorTasks = [...session.executor.tasks.values()].map(task => ({
        id: task.id,
        generation: task.generation,
        revoked: task.revoked,
        leasedTabIds: [...task.tabIds],
      }));
      return {...session.fixture.stats(), executorTasks, connected: Boolean(session.bridge)};
    }
    case 'disconnect': {
      if (!session?.bridge || !session.port) throw new Error('synthetic extension already disconnected');
      const closed = new Promise(resolve => session.port.socket.once('close', resolve));
      session.port.socket.destroy();
      await closed;
      await session.disconnecting;
      return {disconnected: true};
    }
    case 'reconnect':
      return await connectSession(session);
    default:
      throw new Error(`unknown peer command: ${command.command}`);
  }
}

const readline = createInterface({input: process.stdin, crlfDelay: Infinity});
readline.on('line', line => {
  let command;
  try { command = JSON.parse(line); }
  catch (error) { emit({type: 'peer_error', message: String(error?.message || error)}); return; }
  void handle(command).then(
    result => emit({type: 'response', id: command.id, result}),
    error => emit({type: 'response', id: command.id, error: String(error?.message || error)}),
  );
});
