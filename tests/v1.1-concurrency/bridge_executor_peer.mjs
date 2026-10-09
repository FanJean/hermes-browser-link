// Synthetic native peer: production Bridge + Executor over the real daemon UDS.
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {Bridge,BrowserConsent} from '../../native-extension/bridge.mjs';
import {Executor} from '../../native-extension/core.mjs';
import {workspaceFixture} from '../native-extension/workspace-fixture.mjs';

// OAuth regression mode connects production daemon transport to real Executor/Bridge.
// Chrome APIs below are synthetic; no personal browser or installation is used.
if (process.argv[2] === '--oauth-fixture') {
  await runOAuthFixture();
  process.exit(0);
}
async function runOAuthFixture() {
  const {default: vm} = await import('node:vm');
  const fs = await import('node:fs/promises');
  const {VaultController} = await import('../../native-extension/vault.mjs');
  const tabs = new Map([[1, {id:1,url:'https://example.com/',windowId:7}]]);
  const removed = [], detached = [], cdp = [], listeners = new Set();
  let settings = {enabled:false,rules:{}}, toggleAtSend = false, deliver;
  const api = {
    tabs: {
      get:async id=>{if(!tabs.has(id))throw Error('closed');return {...tabs.get(id)};},
      query:async()=>[...tabs.values()],
      remove:async id=>{removed.push(id);tabs.delete(id);},
    },
    windows:{get:async id=>({id,type:id===7?'normal':'popup'})},
    debugger:{
      onEvent:{addListener:l=>listeners.add(l),removeListener:l=>listeners.delete(l)},
      attach:async()=>{},detach:async target=>detached.push(target.tabId),
      sendCommand:async(target,method,params)=>{
        cdp.push({tabId:target.tabId,method,params});
        if(method==='Page.getFrameTree')return {frameTree:{frame:{id:`frame-${target.tabId}`,loaderId:`doc-${target.tabId}`,url:tabs.get(target.tabId).url}}};
        if(method==='Page.createIsolatedWorld')return {executionContextId:target.tabId};
        if(method==='Runtime.callFunctionOn')return {result:{value:true}};
        if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:`preveil-${target.tabId}`};
        return {};
      },
    },
  };
  const executor = new Executor(api,()=>{},{onContentShield:async()=>settings});
  const task = {id:'task',instanceId:'instance',approvalScope:'owner',workWindowMode:'current',generation:1,state:'ready',allowedOrigins:['https://example.com'],tabIds:[1]};
  await executor.approve(task);executor.setMode({...task,modeGeneration:2,activeMode:'full'});
  await executor.withSpawnScope(executor.tasks.get('task'),1,async()=>{});
  const popup = {id:2,openerTabId:1,windowId:8,url:'https://accounts.example.test/login?synthetic=only'};
  tabs.set(2,popup);await executor.tabCreated(popup);
  const bridge = new Bridge({onMessage:{addListener(){}},postMessage:m=>deliver(m)},executor,()=>{},
    {onContentFilter:async()=>{if(toggleAtSend){toggleAtSend=false;settings={...settings,enabled:!settings.enabled};}return settings.enabled;}});
  const source = await fs.readFile(new URL('../../native-extension/background.mjs',import.meta.url),'utf8');
  const controlSource = source.slice(source.indexOf('async function performOverlayCommand('),source.indexOf('// 中文注释：下载事件只报告'));
  for await (const line of createInterface({input:process.stdin})) {
    try {
      const p=JSON.parse(line);let result;
      if(p.op==='rpc')result=await new Promise(resolve=>{deliver=resolve;bridge.receive(p.message);});
      if(p.op==='grant'){executor.approveAction(p.approval);result={granted:true};}
      if(p.op==='settings'){settings={enabled:p.enabled,rules:{}};toggleAtSend=p.toggleAtSend===true;result=settings;}
      if(p.op==='renew'){
        await executor.release({taskId:'task',generation:executor.tasks.get('task').generation,closeAgentTabs:false});
        await executor.approve({...task,generation:p.generation});
        executor.setMode({...task,generation:p.generation,modeGeneration:2,activeMode:'full'});
        result={renewed:true};
      }
      if(p.op==='state'){
        const t=executor.tasks.get('task');
        result={generation:t.generation,leases:[...executor.leases],tabs:[...t.tabIds],origins:t.allowedOrigins,
          revoked:t.revoked,overlays:[...(t.overlays?.keys()||[])],removed,detached,
          present:[...tabs.values()],overlayUninstalls:cdp.filter(c=>c.method==='Runtime.callFunctionOn'&&c.params.arguments?.[0]?.value==='remove').map(c=>c.tabId)};
      }
      if(p.op==='vault'){
        try{await new VaultController(executor).scope({taskId:'task',instanceId:'instance',generation:p.generation||1,modeGeneration:2,tabId:2});result={allowed:true};}
        catch(error){result={allowed:false,error:String(error.message)};}
      }
      if(p.op==='control'){
        const calls=[],host=structuredClone(p.host);
        const context={bridge:{request:async(method,params)=>{
          calls.push({method,params});
          if(method==='extension.pause')host.state='paused';
          if(method==='extension.stop')host.state='cancelled';
          return method==='extension.tasks'?[host]:{};
        }},connected:true,connectedInstanceId:'instance',executor,chrome:api,origin:url=>new URL(url).origin,
          takeoverBaselines:new Map(),takeoverStructure:async()=>[]};
        vm.runInNewContext(controlSource+'\nglobalThis.control=performOverlayCommand;',context);
        result={reply:await context.control({taskId:'task',generation:1,tabId:2,origin:'https://accounts.example.test',kind:p.kind}),calls};
      }
      process.stdout.write(JSON.stringify({ok:true,result})+'\n');
    } catch(error) {process.stdout.write(JSON.stringify({ok:false,error:String(error.message)})+'\n');}
  }
}

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
    // 中文注释：与后台相同，连接授权加载后为新任务安装完整的工作页访问。
    if(session.consent)void session.consent.synchronize(bridge).catch(error=>emit({type:'peer_error',message:String(error)}));
  },{onConsentStatus:async()=>session.consent?session.consent.readStatus():'disabled'});
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
    // 中文注释：只替换旧偏好的存储边界；授权与同步仍走生产控制器。
    case 'consent': {
      session.consent ||= new BrowserConsent({
        get:async()=>({browserFullConsent:{version:1,enabled:false}}),
        set:async()=>{throw new Error('connection authorization must not mutate retired preferences');},
      },session.executor);
      const status=await session.consent.load();
      await session.consent.synchronize(session.bridge);
      return {enabled:session.consent.enabled,status};
    }
    // 中文注释：仅连接生产 release → extension.stop 边界，不复制停止守卫或终态。
    // 两阶段回执让测试在真实撤权后解开浏览器 API，避免用延时猜测在途时序。
    case 'stop': {
      const release=session.executor.release({taskId:command.taskId,generation:command.generation,closeAgentTabs:true});
      session.stopping=release.then(cleanup=>session.bridge.request('extension.stop',{
        taskId:command.taskId,generation:command.generation,cleanup,
      }));
      return {revoked:session.executor.tasks.get(command.taskId)?.revoked===true};
    }
    case 'wait_stopped':
      return await session.stopping;
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
        mode: 'full',
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
