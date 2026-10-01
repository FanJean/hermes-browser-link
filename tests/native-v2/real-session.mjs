// 中文注释：真实 Chrome/Edge 临时 profile 验收的公共启动流程；矩阵脚本复用它，不接触个人浏览器配置。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {realpathSync} from 'node:fs';
import {CdpClient, waitFor, fetchJson} from './cdp-client.mjs';

const exec = promisify(execFile);
export const root = path.resolve(import.meta.dirname, '../..');
const python = process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');
const helper = path.join(import.meta.dirname, 'real-helper.py');
// 中文注释：macOS 默认 TMPDIR 过长，会让 bridge.sock 超出 AF_UNIX 路径上限；隔离验收固定使用短临时根目录。
// 必须解析 /tmp 符号链接，浏览器按真实路径计算解包扩展 ID，主机注册必须使用同一 ID。
const scratch = realpathSync(process.platform === 'darwin' ? '/tmp' : tmpdir());
export const browserPaths = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function helperCall(...args) {
  const {stdout} = await exec(python, [helper, ...args], {
    cwd: root,
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', HERMES_SOURCE: process.env.HERMES_SOURCE || path.join(process.env.HOME, '.hermes/hermes-agent')},
    timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
}

// 中文注释：启动一个临时 profile 浏览器并完成扩展连接与完整访问授权；restart() 用同一 profile 重启浏览器。
export async function openRealSession({browser, packageMode = false, hostRules = '', label = 'm', headed = false, idleCloseSeconds, taskIdleTimeoutSeconds}) {
  const work = await mkdtemp(path.join(scratch, `${label}${browser[0]}-`));
  const packageRoot = path.join(work, 'package');
  const extensionRoot = packageMode ? path.join(packageRoot, 'native-extension') : path.join(work, 'dist-native');
  if (packageMode) await exec(process.execPath, [path.join(root, 'scripts/package-executor.mjs'), '--source', root, '--output', packageRoot], {cwd: root, timeout: 120000});
  else await exec(process.execPath, [path.join(root, 'native-extension/build.mjs'), extensionRoot], {cwd: root});
  const profile = path.join(work, 'profile');
  const downloadsDir = path.join(work, 'downloads');
  await mkdir(path.join(profile, 'Default'), {recursive: true}); await mkdir(downloadsDir, {recursive: true});
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({download: {default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true}}));
  // 中文注释：1.4.0 起扩展 ID 由 manifest key 固定；无 key 时才按加载路径推算。
  const manifestKey = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).key;
  const expectedExtensionId = [...(manifestKey ? createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest('hex') : sha256(path.resolve(extensionRoot))).slice(0, 32)]
    .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
  let staged;
  try {
    const origins = JSON.stringify([`chrome-extension://${expectedExtensionId}/`]);
    staged = packageMode ? await helperCall('stage_package', work, packageRoot, origins) : await helperCall('stage', work, origins);
    const profileManifest = path.join(profile, 'NativeMessagingHosts/com.hermes.browser_link.json');
    await mkdir(path.dirname(profileManifest), {recursive: true});
    await copyFile(staged.manifests[browser === 'chrome' ? 0 : 1], profileManifest);
  } catch (error) { await rm(work, {recursive: true, force: true}); throw error; }
  const temp = path.join(work, 'tmp');
  await mkdir(temp, {recursive: true});
  // 中文注释：浏览器必须继承真实 HOME（见 tests/v1-launch-safety），只把 HERMES_HOME/TMPDIR 指到临时目录。
  const browserEnv = {
    HOME: process.env.HOME, HERMES_HOME: path.join(work, 'h', '.hermes'), TMPDIR: temp,
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG || 'en_US.UTF-8',
  };
  // 中文注释：生命周期验收仅在本次临时 profile 的 host/daemon 中缩短计时，不修改用户 .env。
  if(idleCloseSeconds!==undefined)browserEnv.HERMES_BROWSER_IDLE_CLOSE_SECONDS=String(idleCloseSeconds);
  if(taskIdleTimeoutSeconds!==undefined)browserEnv.HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS=String(taskIdleTimeoutSeconds);
  const session = {work, profile, downloadsDir, staged, browser, extensionId: expectedExtensionId, logs: ''};
  let proc, cdp, ui, popupTarget, base;

  const activateExtensionTab = async (client, targetId) => {
    await client.evaluate('chrome.tabs.getCurrent().then(tab=>chrome.windows.update(tab.windowId,{focused:true}).then(()=>chrome.tabs.update(tab.id,{active:true}))).then(()=>true)');
    await cdp.call('Target.activateTarget', {targetId});
    await client.call('Emulation.setFocusEmulationEnabled', {enabled: true});
  };
  const trustedClick = async (client, targetId, selector) => {
    await activateExtensionTab(client, targetId);
    const point = await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await client.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await client.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
  };
  session.trustedClick = trustedClick;

  async function launch() {
    proc = spawn(browserPaths[browser], [
      // 中文注释：有界面验收显式跳过 headless，仍使用本次临时 profile 和随机调试端口。
      ...(headed ? [] : ['--headless=new']), '--use-mock-keychain', '--password-store=basic', '--disable-background-networking', '--disable-sync', '--no-proxy-server',
      '--site-per-process', ...(hostRules ? [`--host-resolver-rules=${hostRules}`] : []),
      `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], {stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: work, env: browserEnv});
    proc.stderr.on('data', chunk => { session.logs += String(chunk); });
    await rm(path.join(profile, 'DevToolsActivePort'), {force: true}).catch(() => {});
    const port = await waitFor(async () => {
      try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return null; }
    }, 30000);
    base = `http://127.0.0.1:${port}`;
    session.version = await fetchJson(`${base}/json/version`);
    cdp = new CdpClient(session.version.webSocketDebuggerUrl); await cdp.connect();
    const {id} = await cdp.call('Extensions.loadUnpacked', {path: extensionRoot});
    assert.equal(id, expectedExtensionId, 'unpacked extension ID changed after host registration');
    await cdp.call('Target.createTarget', {url: `chrome-extension://${id}/popup.html`});
    popupTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.url === `chrome-extension://${id}/popup.html`));
    ui = new CdpClient(popupTarget.webSocketDebuggerUrl); await ui.connect();
    session.ui = ui; session.cdp = cdp; session.base = base;
    await waitFor(() => ui.evaluate(`document.querySelector('#connection-label')!==null`));
    if (!await ui.evaluate(`document.querySelector('#connection-label').textContent==='已连接'`)) await trustedClick(ui, popupTarget.id, '#connect');
    await waitFor(() => ui.evaluate(`document.querySelector('#connection-label').textContent==='已连接'`), 35000);
  }
  async function stopBrowser() {
    ui?.close(); cdp?.close();
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 800));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  session.clickPopup = selector => trustedClick(ui, popupTarget.id, selector);
  session.enableFullAccess = async () => {
    await ui.evaluate(`chrome.storage.local.set({browserFullConsent:{version:1,enabled:false}})`);
    await waitFor(() => ui.evaluate(`document.querySelector('#access-toggle').disabled===false`));
    // 中文注释：授权控件位于折叠设置内，先通过真实点击展开，不能点击隐藏按钮。
    if (!await ui.evaluate(`document.querySelector('details.settings').open`)) await session.clickPopup('details.settings > summary');
    await session.clickPopup('#access-toggle'); await session.clickPopup('#confirm-enable');
    await waitFor(() => ui.evaluate(`document.querySelector('#access-toggle').getAttribute('aria-checked')==='true'`));
  };
  session.rpc = (owner, suffix, args = {}) => helperCall('rpc', work, owner, suffix, JSON.stringify(args));
  session.instance = async () => {
    const found = await waitFor(async () => {
      const rows = await session.rpc('session-a', 'browsers');
      return Array.isArray(rows) && rows.some(item => item.browser === browser && item.connected !== false) ? rows : null;
    }, 30000);
    return found.find(item => item.browser === browser);
  };
  // 中文注释：页面回读通过扩展自身的 chrome.debugger 进行，只用于测试断言，不经过被测动作链路。
  session.readPage = (tabId, expression) => ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true,awaitPromise:true}).then(r=>r.result.value)`);
  // 中文注释：按网址找到页面自己的调试端点只读回读，不依赖扩展当前是否附加到该标签页。
  session.readUrl = async (urlPart, expression) => {
    const target = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.type === 'page' && (typeof urlPart === 'function' ? urlPart(item.url) : item.url.includes(urlPart))), 15000);
    const client = new CdpClient(target.webSocketDebuggerUrl); await client.connect();
    try { return await client.evaluate(expression); } finally { client.close(); }
  };
  session.approvePanel = async (decision = 'approve', textIncludes = null) => {
    const panelTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.url === `chrome-extension://${expectedExtensionId}/approval-panel.html`), 20000);
    const panel = new CdpClient(panelTarget.webSocketDebuggerUrl); await panel.connect();
    try {
      await waitFor(() => panel.evaluate(`Boolean(document.querySelector('button[data-decision="${decision}"]'))`));
      if (textIncludes){const body=await panel.evaluate('document.body.innerText');assert.ok(body.includes(textIncludes),JSON.stringify({expected:textIncludes,body}));}
      await activateExtensionTab(panel, panelTarget.id);
      const point = await panel.evaluate(`(()=>{const e=document.querySelector('button[data-decision="${decision}"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await panel.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
      await panel.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
      // 中文注释：等待本次审批窗口关闭，避免紧接着的新请求误命中上一个弹窗。
      await waitFor(async()=>!(await fetchJson(`${base}/json/list`)).some(item=>item.id===panelTarget.id),10000);
    } finally { panel.close(); }
  };
  session.restartBrowser = async () => { await stopBrowser(); await launch(); };
  session.killBrowser = stopBrowser;
  session.launch = launch;
  session.close = async () => {
    const cleanupError = await helperCall('cleanup', work).then(() => null, error => error);
    await stopBrowser();
    if (process.env.KEEP_NATIVE_V2_SCRATCH === '1') console.error('retained fixture:', work);
    else await rm(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    if (cleanupError) throw cleanupError;
  };
  try { await launch(); } catch (error) { await session.close().catch(() => {}); throw error; }
  return session;
}

// 中文注释：为一个会话创建任务与任务自有工作页，返回按任务绑定的 run/readback 帮助函数。
// 中文注释：创建与引用准备阶段也传递公共工具的原始错误码，供机械基准记录。
function requireBridgeResult(value){
  if(value?.error)throw Object.assign(Error(value.error),{code:value.code,bridgeCode:value.bridgeCode,_diagnostic:value._diagnostic});
  return value;
}

export async function openTask(session, {owner = 'session-a', origins, url, title = 'matrix'}) {
  const instance = await session.instance();
  const task = requireBridgeResult(await session.rpc(owner, 'create', {title, instance_id: instance.instanceId, allowed_origins: origins}));
  await waitFor(async () => { const current = await session.rpc(owner, 'get', {task_id: task.id}); return current.state === 'ready' && current.activeMode === 'full'; }, 30000);
  const opened = await session.rpc(owner, 'run', {task_id: task.id, request_id: `open-${task.id}`, action: 'new_tab', url});
  // 中文注释：基准准备失败也保留桥接码和诊断码，避免被断言异常覆盖。
  if(!Number.isInteger(opened.tabId))throw Object.assign(Error(opened.error||'new_tab failed'),{code:opened.code,bridgeCode:opened.bridgeCode,_diagnostic:opened._diagnostic});
  await session.ui.evaluate(`chrome.tabs.update(${opened.tabId},{active:true}).then(()=>true)`);
  let sequence = 0;
  const handle = {task, owner, tabId: opened.tabId, instance};
  handle.nextId = () => `${task.id.slice(0, 8)}-${++sequence}`;
  // 中文注释：tabs/new_tab 属于任务级动作，公共协议不允许携带 tab_id；其他动作仍显式绑定当前工作页。
  handle.run = (action, extra = {}, requestId = handle.nextId()) => session.rpc(owner, 'run', {
    task_id: task.id, request_id: requestId, action,
    ...(action === 'tabs' || action === 'new_tab' ? {} : {tab_id: handle.tabId}), ...extra,
  });
  handle.read = expression => session.readPage(handle.tabId, expression);
  handle.ref = async (query, roles, extra = {}) => {
    const snap = await handle.run('semantic_snapshot', {options: {mode: 'interactive', query, ...(roles ? {roles} : {}), budget: 3000, ...extra}});
    requireBridgeResult(snap);
    assert.ok(Array.isArray(snap.items), JSON.stringify(snap));
    assert.equal(snap.items.length, 1, `${query}: ${JSON.stringify(snap.items?.map(item => item.name))}`);
    return {binding: snap.binding, snapshot_id: snap.snapshotId, ref: snap.items[0].ref, item: snap.items[0]};
  };
  handle.act = async (action, target, extra = {}) => {
    const {item: _, ...token} = target;
    return handle.run(action, {...token, ...extra});
  };
  return handle;
}
