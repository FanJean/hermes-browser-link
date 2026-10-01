// Source-first V1 acceptance: real Chrome + Edge -> one native daemon -> Hermes hook.
// Run only in an authorized disposable browser environment; this runner launches browsers.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {access, copyFile, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient, waitFor, fetchJson} from './cdp-client.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const helper = path.join(import.meta.dirname, 'real-helper.py');
const python = process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');
const hermesSource = process.env.HERMES_SOURCE || path.join(process.env.HOME, '.hermes/hermes-agent');
const scratch = path.resolve(process.env.HOME, '.hermes/cache/scratch');
const binaries = {
  chrome: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: process.env.EDGE_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};
assert.equal(process.argv.length, 2, 'No package or browser flags: this is a source-first dual-browser gate');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = createServer((_req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end('<!doctype html><title>Concurrent native V1 fixture</title><input id="draft" aria-label="Draft"><p id="marker">synthetic-only</p>');
});
const children = [];
let work;
let report;
let failure;

async function helperCall(...args) {
  const {stdout} = await exec(python, [helper, ...args], {
    cwd: root, env: {...process.env, HERMES_SOURCE: hermesSource},
    timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
}
const rpc = (session, method, args = {}) => helperCall('rpc', work, session, method, JSON.stringify(args));

async function openBrowser(browser) {
  const profile = path.join(work, `profile-${browser}`);
  const tmp = path.join(work, `tmp-${browser}`);
  const home = path.join(work, `home-${browser}`);
  await Promise.all([mkdir(profile, {recursive: true}), mkdir(tmp, {recursive: true}), mkdir(home, {recursive: true})]);
  const proc = spawn(binaries[browser], [
    '--headless=new', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', '--disable-sync', '--no-proxy-server',
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], {
    cwd: work, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: {HOME: home, HERMES_HOME: path.join(home, '.hermes'), TMPDIR: tmp,
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG || 'en_US.UTF-8'},
  });
  const state = {browser, profile, proc, cdp: null, ui: null, logs: ''};
  children.push(state);
  proc.stderr.on('data', data => { state.logs += String(data); });
  const port = await waitFor(async () => {
    if (proc.exitCode !== null) throw Error(`${browser} exited before CDP: ${state.logs}`);
    try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 30000);
  state.base = `http://127.0.0.1:${port}`;
  const version = await fetchJson(`${state.base}/json/version`);
  state.version = version.Browser;
  state.cdp = new CdpClient(version.webSocketDebuggerUrl);
  await state.cdp.connect();
  const {id} = await state.cdp.call('Extensions.loadUnpacked', {path: path.join(work, 'dist-native')});
  assert.ok(id, `${browser}: extension did not load`);
  state.extensionId = id;
  return state;
}

async function click(ui, selector) {
  const point = await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await ui.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
  await ui.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
}

async function connectBrowser(state, manifest) {
  const dest = path.join(state.profile, 'NativeMessagingHosts/com.hermes.browser_link.json');
  await mkdir(path.dirname(dest), {recursive: true});
  await copyFile(manifest, dest);
  const url = `chrome-extension://${state.extensionId}/popup.html`;
  await state.cdp.call('Target.createTarget', {url});
  const target = await waitFor(async () => (await fetchJson(`${state.base}/json/list`)).find(x => x.url === url), 30000);
  state.ui = new CdpClient(target.webSocketDebuggerUrl);
  await state.ui.connect();
  await waitFor(() => state.ui.evaluate(`document.querySelector('#primary')!==null`));
  // Check the actual native host, not a stubbed extension status. The probe disconnects.
  const probe = await state.ui.evaluate(`new Promise(resolve=>{
    const p=chrome.runtime.connectNative('com.hermes.browser_link');
    const timer=setTimeout(()=>{p.disconnect();resolve('timeout')},3000);
    p.onMessage.addListener(m=>{clearTimeout(timer);p.disconnect();resolve(m?.result?.connected===true?'connected':'unexpected response')});
    p.onDisconnect.addListener(()=>{clearTimeout(timer);resolve(chrome.runtime.lastError?.message||'disconnected')});
    p.postMessage({id:'probe',method:'extension.hello',params:{instanceId:crypto.randomUUID(),browser:${JSON.stringify(state.browser)},version:'1.0.0'}});
  })`);
  assert.equal(probe, 'connected', `${state.browser} native host: ${probe}`);
  if (!await state.ui.evaluate(`document.querySelector('#connection').textContent.includes('已连接')`)) {
    await waitFor(() => state.ui.evaluate(`Boolean(document.querySelector('#primary [data-action="connect"]'))`));
    await click(state.ui, '#primary [data-action="connect"]');
  }
  await waitFor(() => state.ui.evaluate(`document.querySelector('#connection').textContent.includes('已连接')`), 35000);
}

async function approveTask(state, task, tabId) {
  const row = `[data-task-id="${task.id}"] [data-action="details"]`;
  await waitFor(() => state.ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(row)}))`), 30000);
  await click(state.ui, row);
  const checkbox = `#detail input[data-tab-id="${tabId}"]`;
  await waitFor(() => state.ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(checkbox)}))`), 30000);
  await click(state.ui, checkbox);
  await click(state.ui, '#detail [data-action="approve"]');
  const ready = await waitFor(async () => {
    const result = await rpc(state.owner, 'get', {task_id: task.id});
    return result.state === 'ready' ? result : null;
  }, 30000);
  assert.deepEqual(ready.tabIds, [tabId], `${state.browser}: selected lease`);
  assert.equal(ready.generation, task.generation);
}

async function approveWrite(state) {
  // The task-approval modal remains open; do not try to click through its overlay.
  await waitFor(() => state.ui.evaluate(`Boolean(document.querySelector('#detail [data-action="allow-action"]'))`), 30000);
  await click(state.ui, '#detail [data-action="allow-action"]');
}

async function settledValues(promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

async function pageValue(state, expression) {
  const result = await state.ui.evaluate(`chrome.debugger.sendCommand({tabId:${state.tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true}).then(r=>r.result.value)`);
  return result;
}

async function stopOwnedBrowser(state) {
  state.ui?.close();
  state.cdp?.close();
  const child = state.proc;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

try {
  await Promise.all([access(binaries.chrome), access(binaries.edge), access(python), mkdir(scratch, {recursive: true})]);
  work = await mkdtemp(path.join(scratch, 'nc-'));
  const socket = path.join(work, 'h/.hermes/plugin-data/browser-link-native/bridge.sock');
  assert.ok(Buffer.byteLength(socket) < 104, `macOS AF_UNIX socket path too long: ${socket}`);
  const extensionRoot = path.join(work, 'dist-native');
  await exec(process.execPath, [path.join(root, 'native-extension/build.mjs'), extensionRoot], {cwd: root});
  const deps = JSON.parse(await readFile(path.join(extensionRoot, 'BUILD-DEPS.json'), 'utf8'));
  for (const [relative, source] of Object.entries({
    'vendor/page-semantics.mjs': path.join(root, 'page-semantics/index.js'),
    'vendor/browser-interactions.mjs': path.join(root, 'browser-interactions/index.mjs'),
  })) {
    const expected = hash(await readFile(source));
    assert.equal(deps.dependencies[relative].sha256, expected);
    assert.equal(hash(await readFile(path.join(extensionRoot, relative))), expected);
  }
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;

  const states = await settledValues([openBrowser('chrome'), openBrowser('edge')]);
  const origins = [...new Set(states.map(s => `chrome-extension://${s.extensionId}/`))];
  const staged = await helperCall('stage', work, JSON.stringify(origins));
  assert.equal(staged.plugin, path.join(work, 'plugin/browser-link'));
  await settledValues(states.map(s => connectBrowser(s, staged.manifests[s.browser === 'chrome' ? 0 : 1])));
  const both = await waitFor(async () => {
    const found = await rpc('acceptance-discovery', 'browsers');
    return Array.isArray(found) && states.every(s => found.some(x => x.browser === s.browser && x.connected)) ? found : null;
  }, 30000);
  const instanceIds = states.map(s => both.find(x => x.browser === s.browser && x.connected).instanceId);
  assert.equal(new Set(instanceIds).size, 2, 'distinct connected instances required');
  const daemon = await helperCall('inspect', work);
  assert.equal(daemon.pluginPath, staged.plugin);
  assert.ok(daemon.daemonPath.includes('/host-bin/daemon.py'));

  await settledValues(states.map(async (s, i) => {
    s.owner = `source-concurrent-${s.browser}-${process.pid}`;
    s.instanceId = instanceIds[i];
    s.tabId = await s.ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin + '/' + s.browser)},active:false}).then(tab=>tab.id)`);
    s.task = await rpc(s.owner, 'create', {
      title: `V1 concurrent ${s.browser}`, instance_id: s.instanceId, allowed_origins: [origin],
    });
    assert.equal(s.task.state, 'pending_approval', JSON.stringify(s.task));
    await approveTask(s, s.task, s.tabId);
  }));
  const [chrome, edge] = states;
  assert.notEqual(chrome.task.id, edge.task.id);
  for (const [mine, other] of [[chrome, edge], [edge, chrome]]) {
    assert.ok((await rpc(other.owner, 'get', {task_id: mine.task.id})).error, 'foreign owner denied');
    assert.ok((await rpc(other.owner, 'run', {
      task_id: mine.task.id, request_id: `wrong-owner-${mine.browser}-${process.pid}`,
      action: 'snapshot', tab_id: mine.tabId,
    })).error, 'foreign owner cannot run');
  }
  if (chrome.tabId !== edge.tabId) {
    assert.ok((await rpc(chrome.owner, 'run', {
      task_id: chrome.task.id, request_id: `foreign-tab-${process.pid}`,
      action: 'snapshot', tab_id: edge.tabId,
    })).error, 'foreign instance tab must be denied');
  }
  assert.ok((await rpc(chrome.owner, 'run', {
    task_id: chrome.task.id, request_id: `foreign-origin-${process.pid}`,
    action: 'navigate', tab_id: chrome.tabId, url: `http://localhost:${fixture.address().port}/outside`,
  })).error, 'unapproved origin must be denied');

  const run = (s, action, requestId, extra = {}) => rpc(s.owner, 'run', {
    task_id: s.task.id, request_id: requestId, action, tab_id: s.tabId, ...extra,
  });
  const reads = await Promise.all(states.map(s => run(s, 'snapshot', `parallel-read-${s.browser}-${process.pid}`)));
  for (const result of reads) assert.ok(!result.error, `parallel read: ${JSON.stringify(result)}`);

  const writes = states.map(s => ({
    state: s, id: `parallel-write-${s.browser}-${process.pid}`,
    args: {selector: '#draft', text: `written-${s.browser}`},
  }));
  const pending = await Promise.all(writes.map(w => run(w.state, 'fill', w.id, w.args)));
  for (const result of pending) assert.equal(result.status, 'approval_required', JSON.stringify(result));
  await settledValues(states.map(approveWrite));
  const completed = await Promise.all(writes.map(w => waitFor(async () => {
    const result = await run(w.state, 'fill', w.id, w.args);
    return result.status === 'approval_required' ? null : result;
  }, 30000)));
  for (const result of completed) assert.ok(result.ok === true || result.filled === true, JSON.stringify(result));
  const values = await Promise.all(states.map(s => pageValue(s, 'document.querySelector("#draft").value')));
  assert.deepEqual(values, ['written-chrome', 'written-edge']);
  for (const [w, result] of writes.map((w, i) => [w, completed[i]])) {
    assert.deepEqual(await run(w.state, 'fill', w.id, w.args), result, 'same request ID reads result without replay');
  }
  assert.deepEqual(await Promise.all(states.map(s => pageValue(s, 'document.querySelector("#draft").value'))), values);

  const cancelled = await rpc(chrome.owner, 'cancel', {task_id: chrome.task.id});
  assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
  assert.ok((await run(chrome, 'snapshot', `after-cancel-${process.pid}`)).error);
  assert.ok(!(await run(edge, 'snapshot', `edge-after-cancel-${process.pid}`)).error);
  const closed = await rpc(chrome.owner, 'close', {task_id: chrome.task.id});
  assert.equal(closed.state, 'closed', JSON.stringify(closed));
  assert.ok(!(await run(edge, 'snapshot', `edge-after-close-${process.pid}`)).error);
  assert.equal(await pageValue(edge, 'document.querySelector("#draft").value'), 'written-edge');
  assert.equal((await rpc(edge.owner, 'close', {task_id: edge.task.id})).state, 'closed');
  for (const s of states) {
    assert.ok((await s.ui.evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id))')).includes(s.tabId),
      `${s.browser}: user-created fixture tab retained`);
  }
  const sameDaemon = await helperCall('inspect', work);
  assert.equal(sameDaemon.daemonPid, daemon.daemonPid, 'one staged daemon for both browsers');
  report = {passed: true, sourceFirst: true, nativeMessaging: true,
    hermesHook: true, daemonPid: daemon.daemonPid, browsers: states.map(s => ({
      browser: s.browser, version: s.version, extensionId: s.extensionId,
      instanceId: s.instanceId, tabId: s.tabId, taskId: s.task.id,
    })), parallelReads: true, parallelApprovedWrites: true,
    ownerAndOriginIsolation: true, cancelAndCloseIsolation: true};
} catch (error) {
  for (const s of children) {
    console.error(`${s.browser} popup:`, await s.ui?.evaluate('document.body.innerText').catch(() => '') || '');
    console.error(`${s.browser} browser logs:`, s.logs.split('\n').filter(x => /native|Traceback|Error|denied/.test(x)).join('\n'));
  }
  failure = error;
} finally {
  const stopped = await Promise.allSettled(children.map(stopOwnedBrowser));
  const failed = stopped.find(result => result.status === 'rejected');
  if (failed) failure ??= failed.reason;
  else if (work) {
    // Never erase the daemon's owned PID evidence when safe termination fails.
    try {
      await helperCall('cleanup', work);
      await rm(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    } catch (error) {
      failure ??= error;
    }
  }
  if (fixture.listening) fixture.close();
}
if (failure) throw failure;
console.log(JSON.stringify(report));
