// Real Chrome/Edge temporary-profile acceptance for shared native v2.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient, waitFor, fetchJson} from '../native-v2/cdp-client.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const python = process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');
const helper = path.join(import.meta.dirname, 'real-helper.py');
const scratch = path.resolve(process.env.HOME, '.hermes/cache/scratch');
const evidenceDir = path.join(import.meta.dirname, 'evidence');
const choices = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};
if (process.argv.some(value => value.startsWith('--package'))) throw Error('Source-staged runner cannot validate --package; use a package-first gate');
const requested = process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'all';
const browsers = requested === 'all' ? Object.keys(choices) : [requested];
for (const browser of browsers) if (!choices[browser]) throw Error('Use --browser=chrome|edge|all');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const page = `<!doctype html><meta charset="utf-8"><title>native-v2-fixture</title>
<style>
body{font-family:sans-serif;margin:20px}button,input,.box{margin:8px;padding:12px}.box{width:120px;height:50px;border:2px solid #333;display:inline-block}.target{background:#def}
</style>
<button id="confirm" aria-label="Confirm">Confirm</button>
<input id="draft" aria-label="Draft">
<input id="password" type="password" aria-label="Password">
<div id="source" class="box" draggable="true">HTML5 Source</div><div id="target" class="box target">HTML5 Target</div>
<div id="pointer-source" class="box">Pointer Source</div><div id="pointer-target" class="box target">Pointer Target</div>
<script>
const confirmButton=document.getElementById('confirm');
const draftField=document.getElementById('draft');
const sourceBox=document.getElementById('source');
const targetBox=document.getElementById('target');
const pointerSource=document.getElementById('pointer-source');
const pointerTarget=document.getElementById('pointer-target');
confirmButton.addEventListener('click',()=>document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1));
draftField.addEventListener('change',()=>document.body.dataset.draft=draftField.value);
let dragging=false;
const begin=()=>{dragging=true};
const finish=e=>{if(dragging)document.body.dataset.pointerDrop=e.isTrusted?'trusted':'untrusted';dragging=false};
pointerSource.addEventListener('pointerdown',begin);pointerSource.addEventListener('mousedown',begin);
pointerTarget.addEventListener('pointerup',finish);pointerTarget.addEventListener('mouseup',finish);
sourceBox.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','fixture'));
targetBox.addEventListener('dragover',e=>e.preventDefault());
targetBox.addEventListener('drop',e=>{e.preventDefault();document.body.dataset.html5Drop=e.isTrusted?'trusted':'synthetic'});
</script>`;
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function helperCall(...args) {
  const {stdout} = await exec(python, [helper, ...args], {
    cwd: root,
    env: {...process.env, HERMES_SOURCE: process.env.HERMES_SOURCE || path.join(process.env.HOME, '.hermes/hermes-agent')},
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
}

async function run(browser) {
  const work = await mkdtemp(path.join(scratch, `n${browser[0]}-`));
  const extensionRoot = path.join(work, 'dist-native');
  await exec(process.execPath, [path.join(root, 'native-extension/build.mjs'), extensionRoot], {cwd: root});
  const buildDeps = JSON.parse(await readFile(path.join(extensionRoot, 'BUILD-DEPS.json'), 'utf8'));
  const canonical = {
    'vendor/page-semantics.mjs': path.join(root, 'page-semantics/index.js'),
    'vendor/browser-interactions.mjs': path.join(root, 'browser-interactions/index.mjs'),
  };
  for (const [relative, source] of Object.entries(canonical)) {
    assert.equal(buildDeps.dependencies[relative].sha256, sha256(await readFile(source)));
    assert.equal(sha256(await readFile(path.join(extensionRoot, relative))), sha256(await readFile(source)));
  }

  const profile = path.join(work, 'profile');
  await mkdir(profile, {recursive: true});
  const temp = path.join(work, 'tmp');
  await mkdir(temp, {recursive: true});
  const scratchHome = path.join(work, 'h');
  const browserEnv = {
    HOME: process.env.HOME, HERMES_HOME: path.join(scratchHome, '.hermes'), TMPDIR: temp,
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG || 'en_US.UTF-8',
  };
  const proc = spawn(choices[browser], [
    '--headless=new', '--use-mock-keychain', '--password-store=basic', '--disable-background-networking', '--disable-sync', '--no-proxy-server',
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: work, env: browserEnv});
  let cdp;
  let ui;
  let logs = '';
  proc.stderr.on('data', chunk => { logs += String(chunk); });
  try {
    const port = await waitFor(async () => {
      try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch { return null; }
    }, 30000);
    const base = `http://127.0.0.1:${port}`;
    const version = await fetchJson(`${base}/json/version`);
    cdp = new CdpClient(version.webSocketDebuggerUrl);
    await cdp.connect();
    const {id: extensionId} = await cdp.call('Extensions.loadUnpacked', {path: extensionRoot});
    const staged = await helperCall('stage', work, JSON.stringify([`chrome-extension://${extensionId}/`]));
    const manifestSource = staged.manifests[browser === 'chrome' ? 0 : 1];
    const profileManifest = path.join(profile, 'NativeMessagingHosts/com.hermes.browser_link.json');
    await mkdir(path.dirname(profileManifest), {recursive: true});
    await copyFile(manifestSource, profileManifest);

    await cdp.call('Target.createTarget', {url: `chrome-extension://${extensionId}/popup.html`});
    const popupTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.url === `chrome-extension://${extensionId}/popup.html`));
    ui = new CdpClient(popupTarget.webSocketDebuggerUrl);
    await ui.connect();
    const click = async selector => {
      const point = await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});const r=(e.scrollIntoView({block:'center'}),e.getBoundingClientRect());return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await ui.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
      await ui.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
    };
    const connectAction = '#primary [data-action="connect"]';
    const rowFor = task => `[data-task-id="${task.id}"]`;
    const detailAction = action => `#detail [data-action="${action}"]`;
    const closeDetails = async () => {
      if (!await ui.evaluate(`!document.querySelector('#modal').hidden`)) return;
      await click(detailAction('close'));
      await waitFor(() => ui.evaluate(`document.querySelector('#modal').hidden`));
    };
    const openDetails = async task => {
      await closeDetails();
      const row = rowFor(task);
      await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${row} [data-action="details"]`)}))`));
      await click(`${row} [data-action="details"]`);
      await waitFor(() => ui.evaluate(`!document.querySelector('#modal').hidden && document.querySelector('#detail-title')?.textContent===${JSON.stringify(task.title)}`));
    };
    const approveInPopup = async (task, tabId) => {
      await openDetails(task);
      const checkbox = `#detail input[data-tab-id="${tabId}"]`;
      await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(checkbox)}))`));
      await click(checkbox);
      await click(detailAction('approve'));
    };

    await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(connectAction)})) || document.querySelector('#connection').dataset.state==='connected'`));
    // Extension autoconnect may race the temporary native-host manifest write.
    const hostReady = await ui.evaluate(`new Promise(resolve=>{
      const port=chrome.runtime.connectNative('com.hermes.browser_link');
      const timer=setTimeout(()=>{port.disconnect();resolve('no response')},3000);
      port.onMessage.addListener(message=>{clearTimeout(timer);port.disconnect();resolve(message?.result?.connected===true?'connected':'unexpected response')});
      port.onDisconnect.addListener(()=>{clearTimeout(timer);resolve(chrome.runtime.lastError?.message||'disconnected')});
      port.postMessage({id:'probe',method:'extension.hello',params:{instanceId:crypto.randomUUID(),browser:${JSON.stringify(browser)},version:'1.0.0'}});
    })`);
    assert.equal(hostReady, 'connected', `native host setup: ${hostReady}`);
    if (!await ui.evaluate(`document.querySelector('#connection').dataset.state==='connected'`)) {
      await waitFor(() => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${connectAction}:not(:disabled)`)}))`));
      await click(connectAction);
    }
    await waitFor(() => ui.evaluate(`document.querySelector('#connection').dataset.state==='connected'`), 35000);

    const rpc = (session, suffix, args = {}) => helperCall('rpc', work, session, suffix, JSON.stringify(args));
    const instances = await waitFor(async () => {
      const found = await rpc('session-a', 'browsers');
      return Array.isArray(found) && found.some(item => item.browser === browser) ? found : null;
    }, 30000);
    const instance = instances.find(item => item.browser === browser);
    const task = await rpc('session-a', 'create', {title: `Native v2 ${browser}`, instance_id: instance.instanceId, allowed_origins: [origin]});
    assert.equal(task.state, 'pending_approval', JSON.stringify(task));
    const tabId = await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin + '/fixture')},active:false}).then(tab=>tab.id)`);
    await approveInPopup(task, tabId);
    await waitFor(async () => (await rpc('session-a', 'get', {task_id: task.id})).state === 'ready');
    assert.ok((await rpc('session-b', 'get', {task_id: task.id})).error, 'foreign owner must be denied');

    assert.ok((await rpc('session-a','run',{task_id:task.id,request_id:'smart-sensitive',action:'fill',tab_id:tabId,selector:'#password',text:'fixture'})).error,'sensitive fields must be denied before asking for approval');
    const smartArgs={task_id:task.id,request_id:'smart-once',action:'click',tab_id:tabId,selector:'#confirm'};
    assert.equal((await rpc('session-a','run',smartArgs)).status,'approval_required');
    assert.equal((await rpc('session-a','run',smartArgs)).status,'approval_required');
    const other=await rpc('session-b','create',{title:'并发独立任务',instance_id:instance.instanceId,allowed_origins:[origin]});
    const otherTab=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin+'/other')},active:false}).then(t=>t.id)`);
    await approveInPopup(other, otherTab);
    await waitFor(async()=>(await rpc('session-b','get',{task_id:other.id})).state==='ready');
    assert.ok((await rpc('session-b','run',{task_id:other.id,request_id:'other-read',action:'snapshot',tab_id:otherTab})).elements,'pending approval must not block another owner');
    await openDetails(task);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('allow-action'))}))`));
    await click(detailAction('allow-action'));
    await waitFor(async()=>(await rpc('session-a','run',smartArgs)).ok===true);
    const readEarly=expression=>ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true}).then(r=>r.result.value)`);
    assert.equal(await readEarly('document.body.dataset.clicks'),'1');
    assert.equal((await rpc('session-a','run',smartArgs)).ok,true);
    assert.equal(await readEarly('document.body.dataset.clicks'),'1','result lookup never replays');
    await readEarly('document.body.dataset.clicks="0"');
    assert.ok((await rpc('session-a','run',{...smartArgs,request_id:'owner-check',tab_id:otherTab})).error);
    assert.ok((await rpc('session-a','run',{...smartArgs,request_id:'origin-check',action:'navigate',selector:undefined,url:'https://example.com'})).error);
    await openDetails(task);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('full'))}))`),10000);
    await click(detailAction('full'));
    assert.equal((await rpc('session-a','get',{task_id:task.id})).activeMode,'smart','first click is not a grant');
    await click(detailAction('confirm-full'));
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).activeMode==='full');
    const otherRisk={task_id:other.id,request_id:'other-risk',action:'click',tab_id:otherTab,selector:'#confirm'};
    assert.equal((await rpc('session-b','run',otherRisk)).status,'approval_required','full grant stays within first task');
    await openDetails(other);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('deny-action'))}))`));
    await click(detailAction('deny-action'));
    assert.ok((await rpc('session-b','run',otherRisk)).error);
    await rpc('session-b','close',{task_id:other.id});
    const workflow=await rpc('session-c','create',{title:'真实浏览器连续操作',instance_id:instance.instanceId,allowed_origins:[origin]});
    const workflowTab=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin+'/workflow')},active:false}).then(t=>t.id)`);
    await openDetails(workflow);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`#detail input[data-tab-id="${workflowTab}"]`)}))`));
    await click(`#detail input[data-tab-id="${workflowTab}"]`);
    await click('#detail [data-mode-choice="full"]');
    assert.equal(await ui.evaluate(`document.querySelector('#detail [data-mode-choice="full"]')?.checked`),true);
    await click(detailAction('approve'));
    await waitFor(async()=>(await rpc('session-c','get',{task_id:workflow.id})).state==='ready');
    assert.equal((await rpc('session-c','get',{task_id:workflow.id})).activeMode,'smart','range approval does not enable full access');
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('confirm-full'))}))`));
    await click(detailAction('confirm-full'));
    await waitFor(async()=>(await rpc('session-c','get',{task_id:workflow.id})).activeMode==='full');
    let step=0;
    const workflowRun=(action,extra={})=>rpc('session-c','run',{task_id:workflow.id,request_id:`workflow-${browser}-${++step}`,action,tab_id:workflowTab,...extra});
    assert.equal((await workflowRun('fill',{selector:'#draft',text:'连续工作'})).ok,true);
    assert.equal((await workflowRun('click',{selector:'#confirm'})).ok,true);
    assert.equal((await workflowRun('click',{selector:'#confirm'})).ok,true);
    const workflowRead=expression=>ui.evaluate(`chrome.debugger.sendCommand({tabId:${workflowTab}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true}).then(r=>r.result.value)`);
    assert.equal(await workflowRead('document.querySelector("#draft").value'),'连续工作');
    assert.equal(await workflowRead('document.body.dataset.clicks'),'2');
    await openDetails(workflow);
    await click(detailAction('smart'));
    await waitFor(async()=>(await rpc('session-c','get',{task_id:workflow.id})).activeMode==='smart');
    assert.equal((await workflowRun('click',{selector:'#confirm'})).status,'approval_required','revocation restores per-operation approval');
    await openDetails(workflow);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('deny-action'))}))`));
    await click(detailAction('deny-action'));
    await rpc('session-c','close',{task_id:workflow.id});
    await openDetails(task);
    let sequence = 0;
    const run = (action, extra = {}) => rpc('session-a', 'run', {
      task_id: task.id, request_id: `${browser}-native-v2-${++sequence}`,
      action, tab_id: tabId, ...extra,
    });
    const readPage = expression => ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true}).then(r=>r.result.value)`);

    const semantic = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Confirm', roles: ['button'], viewport: true, budget: 1600}});
    assert.equal(semantic.version, 2, JSON.stringify(semantic));
    assert.equal(semantic.items.length, 1);
    const buttonToken = {binding: semantic.binding, snapshot_id: semantic.snapshotId, ref: semantic.items[0].ref};
    assert.equal((await run('ref_click', buttonToken)).clicked, true);
    assert.equal(await readPage('document.body.dataset.clicks'), '1');
    assert.ok((await run('ref_click', buttonToken)).error, 'mutated snapshot ref must not replay');

    const draft = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Draft', roles: ['textbox'], budget: 1600}});
    assert.equal((await run('ref_fill', {binding: draft.binding, snapshot_id: draft.snapshotId, ref: draft.items[0].ref, text: 'native-v2'})).filled, true);
    assert.equal(await readPage('document.querySelector("#draft").value'), 'native-v2');

    const password = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Password', roles: ['textbox'], budget: 1600}});
    assert.ok((await run('ref_fill', {binding: password.binding, snapshot_id: password.snapshotId, ref: password.items[0].ref, text: 'fixture'})).error, 'sensitive ref fill must be denied');

    const shot = await run('screenshot');
    assert.ok(typeof shot.data === 'string' && shot.data.length > 100, 'ordinary screenshot bytes');
    // Full approval cannot widen the V1 allowlist.
    const deferredActions = [
      'interaction.capture', 'interaction.bounds', 'interaction.click',
      'interaction.drag_elements', 'interaction.drag_coordinates',
      'files.upload', 'files.download.start', 'files.download.status',
      'files.download.wait', 'files.download.cancel', 'files.download.claim',
      'artifact.register', 'advanced.evaluate', 'advanced.cdp', 'cookies.export',
    ];
    for (const action of deferredActions) {
      const denied = await run(action);
      assert.ok(denied.error, action);
      assert.equal(denied.code, 'invalid_arguments', action);
      assert.equal(denied.retryable, false, action);
    }
    assert.equal(await readPage('document.body.dataset.clicks'), '1');
    assert.equal(await readPage('document.body.dataset.html5Drop'), undefined);
    assert.equal(await readPage('document.body.dataset.pointerDrop'), undefined);

    await readPage('document.querySelector("#password").value="fixture"');
    assert.ok((await run('screenshot')).error, 'sensitive screenshot must be denied');
    await readPage('document.querySelector("#password").value=""');

    await openDetails(task);
    await click(detailAction('smart'));
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).activeMode==='smart');
    const revokedArgs={...smartArgs,request_id:'revoked-pending'};
    assert.equal((await rpc('session-a','run',revokedArgs)).status,'approval_required');
    await openDetails(task);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('deny-action'))}))`));
    assert.equal(await ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('full'))}))`),false,'full access stays unavailable while an action approval is pending');
    // The current popup intentionally hides the full-mode control while an
    // action is pending. Exercise the same popup-origin background mode route
    // here so the stale-nonce boundary remains covered without inventing a UI control.
    const pendingMode = await ui.evaluate(`chrome.runtime.sendMessage({type:'mode',taskId:${JSON.stringify(task.id)},mode:'full'})`);
    assert.equal(pendingMode.result.activeMode,'full',JSON.stringify(pendingMode));
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).activeMode==='full');
    assert.ok((await rpc('session-a','run',revokedArgs)).error,'mode changes invalidate pending nonce');
    await helperCall('cleanup',work);
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).state==='needs_sync');
    assert.equal((await rpc('session-a','get',{task_id:task.id})).activeMode,'smart');
    await closeDetails();
    await waitFor(() => ui.evaluate(`document.querySelector('#connection').dataset.state==='connected' || Boolean(document.querySelector(${JSON.stringify(`${connectAction}:not(:disabled)`)}))`), 40000);
    if(await ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${connectAction}:not(:disabled)`)}))`)) await click(connectAction);
    await waitFor(async()=>{const list=await rpc('session-a','browsers');return Array.isArray(list)&&list.some(x=>x.instanceId===instance.instanceId);},40000);
    await waitFor(()=>ui.evaluate(`document.querySelector('#connection').dataset.state==='connected'`),35000);
    const resumed=await rpc('session-a','resume',{task_id:task.id});assert.equal(resumed.state,'pending_approval');
    await approveInPopup(task, tabId);
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).state==='ready');
    assert.equal((await rpc('session-a','get',{task_id:task.id})).activeMode,'smart');
    const resumeRisk={...smartArgs,request_id:'after-reconnect'};
    assert.equal((await rpc('session-a','run',resumeRisk)).status,'approval_required');
    await openDetails(task);
    await waitFor(()=>ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(detailAction('allow-action'))}))`));
    await click(detailAction('allow-action'));
    await waitFor(async()=>(await rpc('session-a','run',resumeRisk)).ok===true);
    const uiText=await ui.evaluate('document.body.innerText');
    assert.ok(uiText.includes('智能审批'));
    await ui.evaluate('window.scrollTo(0,0)');
    const screenshot=await ui.call('Page.captureScreenshot',{format:'png'});
    await mkdir(evidenceDir,{recursive:true});await writeFile(path.join(evidenceDir,`approval-${browser}.png`),Buffer.from(screenshot.data,'base64'));
    const closed = await rpc('session-a', 'close', {task_id: task.id});
    assert.equal(closed.state, 'closed');
    assert.ok((await ui.evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id))')).includes(tabId), 'user tab retained');
    const installed = await helperCall('inspect', work);
    assert.ok(installed.daemonPath.startsWith(work+'/'));
    assert.equal(installed.pluginPath, staged.plugin);

    const report = {
      timestamp: new Date().toISOString(), browser, browserVersion: version.Browser,
      extensionId, instanceId: instance.instanceId, tabId,
      transport: 'real temporary-profile Chrome/Edge Native Messaging -> staged host/daemon -> UDS -> temporary source-staged plugin -> real Hermes pre_tool_call dispatcher',
      sourceHashes: buildDeps.dependencies,
      productionHashes: Object.fromEntries(await Promise.all(['native-extension/core.mjs','native-extension/background.mjs','native-extension/bridge.mjs','native-extension/popup.mjs','native-extension/build.mjs','native-bridge/daemon.py','executor-plugin/native_tools.py','executor-plugin/native_runtime.py'].map(async file=>[file,sha256(await readFile(path.join(root,file)))]))),
      staged: installed,
      passed: [
        'smart default and sensitive field pre-confirmation denial',
        'single-use UI confirmation and idempotent result lookup',
        'pending approval leaves independent owner task unblocked',
        'two-click full grant scoped to one task only',
        'pending task selects full mode after scope approval; three successive writes without individual prompts and verified page readback',
        'one-click revocation and stale pending nonce denied',
        'daemon restart revokes full access; fresh smart task approval and action confirmation work',
        'Hermes trusted hook owner lease', 'task/tab/generation/origin checks',
        'semantic snapshot exact ref click/fill', 'stale ref denied', 'sensitive ref fill denied',
        'ordinary screenshot bytes', 'deferred interaction, file, JS/CDP and cookie actions denied even in full mode',
        'deferred actions have no fixture DOM effects', 'sensitive screenshot denied',
        'foreign owner denied', 'user tab retained', 'staged dependency hashes verified',
      ],
      notClaimed: ['package-first acceptance', 'coordinate interaction and drag/drop', 'file transfer', 'arbitrary JavaScript', 'raw CDP model action', 'cookie export beyond separately approved API-v2'],
    };
    await mkdir(evidenceDir, {recursive: true});
    const evidence = path.join(evidenceDir, `native-v2-${browser}.json`);
    await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({...report, evidence}));
    return report;
  } catch (error) {
    console.error('popup:', await ui?.evaluate('document.body.innerText').catch(() => ''));
    console.error('popup diagnostics:', await ui?.evaluate(`({connection:document.querySelector('#connection')?.dataset.state,headline:document.querySelector('#headline')?.textContent,summary:document.querySelector('#diagnostic-text')?.textContent,output:document.querySelector('#diagnostic-output')?.textContent,outputHidden:document.querySelector('#diagnostic-output')?.hidden})`).catch(() => null));
    console.error('native status:', await ui?.evaluate(`chrome.runtime.sendMessage({type:'status'}).then(reply=>({connected:reply?.result?.connected,lastError:reply?.result?.lastError}))`).catch(() => null));
    console.error(logs.split('\n').filter(line => /native|Traceback|Error|denied/.test(line)).join('\n'));
    throw error;
  } finally {
    await helperCall('cleanup', work).catch(() => {});
    ui?.close();
    cdp?.close();
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    await rm(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}

try {
  for (const browser of browsers) await run(browser);
} finally {
  server.close();
}
