// Package-first Native Messaging -> installed host/daemon/plugin -> real browser E2E.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { CdpClient, waitFor, fetchJson } from '../native-v2/cdp-client.mjs';
import {buildCurrentPackageArchive} from './current-package.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const python = process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');
const hermesSource = process.env.HERMES_SOURCE || path.join(process.env.HOME, '.hermes/hermes-agent');
const helper = path.join(import.meta.dirname, 'real-helper.py');
const choices = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};
const requested = process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'all';
const concurrent = process.argv.includes('--concurrent');
const packageArgument=process.argv.find(value=>value.startsWith('--package='))?.slice(10);
const runId = (process.argv.find(value => value.startsWith('--run-id='))?.slice(9)
  || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9_-]/g, '-');
const scratch = path.resolve(process.env.HOME, '.hermes/cache/scratch');
// 中文注释：未指定发布包时临时构建当前源码，运行后清理测试用 ZIP。
const packageScratch=packageArgument?null:await mkdtemp(path.join(scratch,'nb-current-package-'));
let packagePath;
try{packagePath=packageArgument?path.resolve(packageArgument):await buildCurrentPackageArchive(root,packageScratch,python);}
catch(error){if(packageScratch)await rm(packageScratch,{recursive:true,force:true});throw error;}
const evidenceDir = path.join(import.meta.dirname, 'evidence');
const browsers = requested === 'all' ? Object.keys(choices) : [requested];
for (const browser of browsers) if (!choices[browser]) throw Error('Use --browser=chrome|edge|all');
if (concurrent) assert.equal(browsers.length, 2, 'concurrent mode requires both browsers');

const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<h1>Real bridge fixture</h1><input id="draft"><input id="password" type="password"><input id="otp" autocomplete="one-time-code"><button id="button" onclick="document.title=\'clicked\'">Click</button>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const diagnostics = new WeakMap();
const reports = [];

async function helperCall(...args) {
  const { stdout, stderr } = await exec(python, [helper, ...args], {
    cwd: root,
    env: { ...process.env, HERMES_SOURCE: hermesSource },
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = stdout.trim().split('\n').filter(Boolean).at(-1) || '{}';
  const result = JSON.parse(output);
  for (const line of stderr.trim().split('\n').filter(Boolean)) {
    try {
      const diagnostic = JSON.parse(line);
      if (diagnostic.exception && result && typeof result === 'object') diagnostics.set(result, diagnostic);
      else console.error(line);
    } catch {
      console.error(line);
    }
  }
  return result;
}

class PackageInstall {
  constructor(work, expectedBrowsers) {
    this.work = work;
    this.expectedBrowsers = expectedBrowsers;
    this.extensions = new Map();
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.installPromise = null;
  }

  async prepare() {
    await mkdir(this.work, { recursive: true });
    this.prepared = await helperCall('prepare', this.work, packagePath);
    assert.equal(this.prepared.manifestExact, true);
    assert.ok(this.prepared.hashedFiles > 0);
    return this.prepared;
  }

  async registerExtension(browser, extensionId) {
    this.extensions.set(browser, extensionId);
    if (this.extensions.size === this.expectedBrowsers.length) this.resolveReady();
    await this.ready;
    if (!this.installPromise) {
      const origins = [...new Set([...this.extensions.values()].map(id => `chrome-extension://${id}/`))];
      this.installPromise = helperCall('install', this.work, JSON.stringify(origins));
    }
    this.installed = await this.installPromise;
    assert.equal(this.installed.sourceIndependent, true);
    assert.equal(this.installed.status, 'installed_disabled');
    return this.installed;
  }

  rpc(session, method, args = {}) {
    return helperCall('rpc', this.work, session, method, JSON.stringify(args));
  }

  inspect() {
    return helperCall('inspect', this.work);
  }

  async cleanup() {
    await helperCall('cleanup', this.work).catch(error => console.error(error));
    await rm(this.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function runBrowser(browser, install) {
  const profile = path.join(install.work, `profile-${browser}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn(choices[browser], [
    '--headless=new', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking',
    '--no-proxy-server',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: install.work });
  let cdp;
  let ui;
  let logs = '';
  proc.stderr.on('data', buffer => { logs += String(buffer); });
  try {
    const port = await waitFor(async () => {
      try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch { return null; }
    }, 30000);
    const base = `http://127.0.0.1:${port}`;
    cdp = new CdpClient((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl);
    await cdp.connect();
    const { id: extensionId } = await cdp.call('Extensions.loadUnpacked', { path: install.prepared.extensionRoot });
    const installed = await install.registerExtension(browser, extensionId);
    const manifestSource = installed.manifests[browser === 'chrome' ? 'Google/Chrome' : 'Microsoft Edge'];
    const profileManifest = path.join(profile, 'NativeMessagingHosts/com.hermes.browser_link.json');
    await mkdir(path.dirname(profileManifest), { recursive: true });
    await copyFile(manifestSource, profileManifest);

    await cdp.call('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
    const target = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.url === `chrome-extension://${extensionId}/popup.html`));
    ui = new CdpClient(target.webSocketDebuggerUrl);
    await ui.connect();
    const click = async selector => {
      const position = await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing UI: '+${JSON.stringify(selector)});e.scrollIntoView();const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    };
    await waitFor(() => ui.evaluate(`document.querySelector('#connect')!==null`));
    if (await ui.evaluate(`!document.querySelector('#connect').hidden`)) await click('#connect');
    await waitFor(() => ui.evaluate(`document.querySelector('#connection').textContent.includes('已连接')`), 35000);

    const rpc = (session, method, args = {}) => install.rpc(`${browser}-${session}`, method, args);
    if (concurrent) {
      await waitFor(async () => {
        const found = await rpc('session-a', 'browsers');
        return Array.isArray(found) && found.filter(item => item.connected).length === 2;
      }, 30000);
    }
    const instances = await rpc('session-a', 'browsers');
    const instance = instances.find(item => item.browser === browser && item.connected);
    assert.ok(instance, JSON.stringify(instances));
    const runtime = await install.inspect();
    assert.equal(runtime.pluginPath, installed.installedPlugin);
    assert.ok(runtime.daemonPath.startsWith(installed.installedPlugin + path.sep));
    assert.ok(runtime.hostPath.startsWith(installed.installedPlugin + path.sep));
    assert.equal(runtime.extensionPath, installed.extensionRoot);

    const a = await rpc('session-a', 'create', { title: '真实会话 A', instance_id: instance.instanceId, allowed_origins: [origin] });
    const b = await rpc('session-b', 'create', { title: '真实会话 B', instance_id: instance.instanceId, allowed_origins: [origin] });
    assert.equal(a.state, 'pending_approval', JSON.stringify(a));
    assert.equal(b.state, 'pending_approval', JSON.stringify(b));
    const tabs = await ui.evaluate(`Promise.all([chrome.tabs.create({url:${JSON.stringify(origin + '/a')},active:false}),chrome.tabs.create({url:${JSON.stringify(origin + '/b')},active:false})]).then(t=>t.map(x=>x.id))`);

    const approve = async (task, tabId, verifySelectionPersistence = false) => {
      const row = `[data-task-id="${task.id}"]`;
      const checkbox = `${row} input[value="${tabId}"]`;
      await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(checkbox)}))`));
      if (!await ui.evaluate(`document.querySelector(${JSON.stringify(checkbox)}).checked`)) await click(checkbox);
      if (verifySelectionPersistence) {
        await new Promise(resolve => setTimeout(resolve, 5200));
        assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(checkbox)}).checked`), true);
      }
      await click(`${row} [data-action="approve"]`);
      await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${row} [data-action="stop"]`)}))`));
    };
    await approve(a, tabs[0], true);
    await approve(b, tabs[1]);

    const assertLeases = async label => {
      for (const [index, task] of [a, b].entries()) {
        const actual = await rpc(index ? 'session-b' : 'session-a', 'get', { task_id: task.id });
        assert.equal(actual.state, 'ready', `${label}: ${JSON.stringify(actual)}`);
        assert.deepEqual(actual.tabIds, [tabs[index]], `${label}: selected tab lease mismatch`);
        assert.equal(actual.generation, task.generation, `${label}: generation changed`);
      }
    };
    await assertLeases('after UI approval');

    let sequence = 0;
    const action = (session, task, actionName, tabId, args = {}) => rpc(session, 'run', {
      task_id: task.id,
      request_id: `${runId}-${browser}-${++sequence}`,
      action: actionName,
      ...(tabId === undefined ? {} : { tab_id: tabId }),
      ...args,
    });
    const denied = (result, code, message) => {
      assert.ok(result.error, JSON.stringify(result));
      const diagnostic = diagnostics.get(result);
      assert.equal(diagnostic?.code, code, JSON.stringify(diagnostic || result));
      if (message) assert.match(diagnostic.message, message);
    };

    denied(await rpc('session-b', 'get', { task_id: a.id }), 'forbidden');
    denied(await action('session-a', a, 'snapshot', tabs[1]), 'foreign_tab');
    denied(await action('session-a', a, 'fill', tabs[0], { selector: '#password', text: 'fixture-nonsecret' }), 'execution_denied', /sensitive target blocked/);
    denied(await action('session-a', a, 'press', tabs[0], { selector: '#otp', key: 'Enter' }), 'execution_denied', /sensitive target blocked/);
    denied(await action('session-a', a, 'navigate', tabs[0], { url: 'https://example.com/' }), 'origin_denied');
    await assertLeases('after policy denials');

    const fills = await Promise.all([
      action('session-a', a, 'fill', tabs[0], { selector: '#draft', text: 'alpha' }),
      action('session-b', b, 'fill', tabs[1], { selector: '#draft', text: 'beta' }),
    ]);
    for (const result of fills) assert.equal(result.ok, true, JSON.stringify(result));
    for (const [index, value] of ['alpha', 'beta'].entries()) {
      const actual = await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabs[index]}},'Runtime.evaluate',{expression:'document.querySelector("#draft").value',returnByValue:true})`);
      assert.equal(actual.result.value, value);
    }
    assert.equal((await action('session-b', b, 'press', tabs[1], { selector: '#button', key: 'Enter' })).ok, true);
    assert.equal((await ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabs[1]}},'Runtime.evaluate',{expression:'document.title',returnByValue:true})`)).result.value, 'clicked');
    assert.ok((await action('session-b', b, 'screenshot', tabs[1])).data, 'real screenshot');
    const fresh = await action('session-a', a, 'new_tab', undefined, { url: origin + '/agent' });
    assert.ok(Number.isInteger(fresh.tabId), JSON.stringify(fresh));

    const domClick = async selector => ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing UI: '+${JSON.stringify(selector)});e.click();return true})()`);
    await domClick(`[data-task-id="${a.id}"] [data-action="stop"]`);
    await waitFor(async () => (await rpc('session-a', 'get', { task_id: a.id })).state === 'cancelled');
    assert.ok((await action('session-a', a, 'snapshot', tabs[0])).error);
    assert.ok(!(await action('session-b', b, 'snapshot', tabs[1])).error);
    const closed = await rpc('session-a', 'close', { task_id: a.id });
    assert.equal(closed.state, 'closed', JSON.stringify(closed));
    const remaining = await ui.evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id))');
    assert.ok(remaining.includes(tabs[0]));
    assert.ok(remaining.includes(tabs[1]));
    assert.ok(!remaining.includes(fresh.tabId));

    if (!concurrent) {
      await helperCall('cleanup', install.work);
      await waitFor(() => ui.evaluate(`!document.querySelector('#connect').hidden`), 15000);
      await click('#connect');
      await waitFor(() => ui.evaluate(`document.querySelector('#connection').textContent.includes('已连接')`), 20000);
      const stale = await rpc('session-b', 'get', { task_id: b.id });
      assert.equal(stale.state, 'needs_sync', JSON.stringify(stale));
      assert.ok((await action('session-b', b, 'snapshot', tabs[1])).error);
      const resumed = await rpc('session-b', 'resume', { task_id: b.id });
      assert.equal(resumed.state, 'pending_approval', JSON.stringify(resumed));
      assert.equal(resumed.generation, b.generation + 1);
      await approve(resumed, tabs[1]);
      const reauthorized = await rpc('session-b', 'get', { task_id: b.id });
      assert.equal(reauthorized.state, 'ready', JSON.stringify(reauthorized));
      assert.equal(reauthorized.generation, b.generation + 1);
      assert.deepEqual(reauthorized.tabIds, [tabs[1]]);
      assert.ok(!(await action('session-b', reauthorized, 'snapshot', tabs[1])).error);
      assert.equal((await rpc('session-b', 'close', { task_id: b.id })).state, 'closed');
    } else {
      assert.equal((await rpc('session-b', 'close', { task_id: b.id })).state, 'closed');
    }

    const report = {
      runId,
      browser,
      extensionId,
      instanceId: instance.instanceId,
      approvedTabIds: tabs,
      concurrent,
      package: {
        archive: install.prepared.archive,
        archiveSha256: install.prepared.archiveSha256,
        hashedFiles: install.prepared.hashedFiles,
        manifestExact: install.prepared.manifestExact,
        extractedRoot: install.prepared.packageRoot,
        installedPlugin: installed.installedPlugin,
        installedHost: runtime.hostPath,
        installedDaemon: runtime.daemonPath,
        installedLauncher: runtime.launcher,
        extractedExtension: runtime.extensionPath,
      },
      transport: 'REAL Chrome/Edge Native Messaging + ZIP-installed host.py + ZIP-installed UDS daemon.py + ZIP-installed Hermes plugin bounded pre_tool_call owner lease',
      passed: [
        'candidate zip exact file/hash verification',
        'extension loaded from extracted zip',
        'host daemon and plugin executed from isolated installation',
        'two sessions same profile distinct UI-approved tabs',
        'UI selection survives refresh',
        'foreign owner denied',
        'foreign tab denied',
        'password/OTP/origin blocked',
        'parallel fill with value readback',
        'trusted Enter',
        'real screenshot',
        'cancel A leaves B usable',
        'user tabs retained',
        'agent tabs cleaned',
        ...(concurrent ? ['both browser instances connected to same installed daemon'] : ['daemon restart revokes authority', 'resume requires and completes fresh UI approval']),
      ],
      diagnostics: {
        priorChromeFillBridgeError: 'Previously observed once outside this run; not reproduced here and root cause remains unconfirmed.',
      },
      notCovered: concurrent
        ? ['restart and fresh reauthorization covered by separate serial package runs', 'production personal profile activation']
        : ['simultaneous Chrome+Edge same integer tabId collision', 'production personal profile activation'],
    };
    reports.push(report);
    await mkdir(evidenceDir, { recursive: true });
    const evidence = path.join(evidenceDir, `real-bridge-package-${runId}-${concurrent ? 'concurrent-' : ''}${browser}.json`);
    await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, evidence }));
  } catch (error) {
    console.error('UI:', await ui?.evaluate('document.body.innerText').catch(() => ''));
    console.error(logs.split('\n').filter(line => /native|Traceback|Error|denied/.test(line)).join('\n'));
    throw error;
  } finally {
    ui?.close();
    cdp?.close();
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 700));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  }
}

try {
  if (concurrent) {
    const install = new PackageInstall(await mkdtemp(path.join(scratch, 'nb-x-')), browsers);
    try {
      await install.prepare();
      const results = await Promise.allSettled(browsers.map(browser => runBrowser(browser, install)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      assert.equal(reports.length, 2);
      const collision = reports[0].approvedTabIds.filter(id => reports[1].approvedTabIds.includes(id));
      const summary = {
        runId,
        passed: true,
        package: reports[0].package,
        instances: reports.map(report => ({ browser: report.browser, instanceId: report.instanceId, tabIds: report.approvedTabIds })),
        sameIntegerTabIds: collision,
        tabIdCollisionObserved: collision.length > 0,
        collisionCoverage: collision.length ? 'real-browser' : 'protocol-level test only; real browsers generated distinct IDs',
        sharedInstalledDaemon: true,
        sessions: 4,
      };
      const evidence = path.join(evidenceDir, `real-bridge-package-${runId}-cross-browser.json`);
      await writeFile(evidence, JSON.stringify(summary, null, 2) + '\n');
      console.log(JSON.stringify({ ...summary, evidence }));
    } finally {
      await install.cleanup();
    }
  } else {
    for (const browser of browsers) {
      const install = new PackageInstall(await mkdtemp(path.join(scratch, `nb-${browser[0]}-`)), [browser]);
      try {
        await install.prepare();
        await runBrowser(browser, install);
      } finally {
        await install.cleanup();
      }
    }
  }
} finally {
  fixture.close();
  if(packageScratch)await rm(packageScratch,{recursive:true,force:true});
}
