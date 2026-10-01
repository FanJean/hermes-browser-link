// Real Chrome/Edge temporary-profile acceptance for shared native v2.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient, waitFor, fetchJson} from './cdp-client.mjs';

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
const packageMode=process.argv.includes('--package');
const requested = process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'all';
const directExtension = process.argv.find(value => value.startsWith('--extension-path='))?.slice('--extension-path='.length);
if(packageMode&&directExtension)throw Error('--package and --extension-path cannot be combined');
const browsers = requested === 'all' ? Object.keys(choices) : [requested];
for (const browser of browsers) if (!choices[browser]) throw Error('Use --browser=chrome|edge|all');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const page = `<!doctype html><meta charset="utf-8"><title>native-v2-fixture</title>
<style>
body{font-family:sans-serif;margin:20px}button,input,.box{margin:8px;padding:12px}.box{width:120px;height:50px;border:2px solid #333;display:inline-block}.target{background:#def}
</style>
<button id="confirm" aria-label="Confirm">Confirm</button>
<button id="pointer-check" aria-label="Pointer Check">Pointer Check</button>
<input id="check" type="checkbox" aria-label="Check">
<select id="choice" aria-label="Choice"><option value="a">甲</option><option value="b">乙</option></select>
<button id="custom" style="display:block" role="combobox" aria-controls="custom-list" aria-expanded="false">Custom Select</button><div id="custom-list" role="listbox" hidden></div>
<div id="open-shadow-host"></div><iframe id="same-frame" src="/child"></iframe><iframe id="cross-frame" src="http://frame.test:__PORT__/cross-child"></iframe>
<input id="draft" aria-label="Draft">
<input id="upload-input" type="file" multiple aria-label="Upload File">
<input id="password" type="password" aria-label="Password">
<div id="source" class="box" draggable="true">HTML5 Source</div><div id="target" class="box target">HTML5 Target</div>
<div id="pointer-source" class="box">Pointer Source</div><div id="pointer-target" class="box target">Pointer Target</div>
<p><a id="dl-report" href="/download/report.csv">Download Report</a> <a id="dl-broken" href="/download/broken">Broken Download</a>
<a id="dl-slow" href="/download/slow.bin">Slow Download</a> <a id="dl-gated" href="/download/gated.csv">Gated Download</a>
<button id="dl-blob">Download Blob</button></p>
<p style="margin-top:600px"><button id="harness-button" onclick="document.body.dataset.harnessClicks=String(Number(document.body.dataset.harnessClicks||0)+1)">Harness Button</button>
<input id="harness-input" aria-label="Harness Input"></p>
<img id="fixture-image" src="/pixel.png" alt="Fixture Pixel">
<script>
document.getElementById('dl-blob').addEventListener('click',()=>{
 const a=document.createElement('a');a.download='blob-report.txt';
 a.href=URL.createObjectURL(new Blob(['blob-download-evidence'],{type:'text/plain'}));document.body.append(a);a.click();
});
const confirmButton=document.getElementById('confirm');
const draftField=document.getElementById('draft');
const sourceBox=document.getElementById('source');
const targetBox=document.getElementById('target');
const pointerSource=document.getElementById('pointer-source');
const pointerTarget=document.getElementById('pointer-target');
document.getElementById('open-shadow-host').attachShadow({mode:'open'}).innerHTML='<button>Open Shadow</button>';
document.getElementById('open-shadow-host').shadowRoot.querySelector('button').onclick=e=>{document.body.dataset.shadowClicked='yes';document.body.dataset.shadowPointerTrusted=String(e.isTrusted)};
confirmButton.addEventListener('click',()=>document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1));
document.getElementById('pointer-check').addEventListener('click',event=>{
 document.body.dataset.pointerClicks=String(Number(document.body.dataset.pointerClicks||0)+1);
 document.body.dataset.pointerTrusted=String(event.isTrusted);
});
document.getElementById('custom').onclick=()=>{
 const control=document.getElementById('custom'),list=document.getElementById('custom-list');
 control.setAttribute('aria-expanded','true');list.hidden=false;
 setTimeout(()=>{list.innerHTML='<div role="option" data-value="b">Beta</div>';
  list.querySelector('[role="option"]').onclick=e=>{e.currentTarget.setAttribute('aria-selected','true');control.dataset.selected='b';list.hidden=true;};
 },100);
};
draftField.addEventListener('change',()=>document.body.dataset.draft=draftField.value);
document.getElementById('upload-input').addEventListener('change',async event=>{
 for(const file of event.currentTarget.files)await fetch('/upload?name='+encodeURIComponent(file.name),{method:'POST',body:file});
 document.body.dataset.uploaded=String(event.currentTarget.files.length);
});
let dragging=false;
const begin=()=>{dragging=true};
const finish=e=>{if(dragging)document.body.dataset.pointerDrop=e.isTrusted?'trusted':'untrusted';dragging=false};
pointerSource.addEventListener('pointerdown',begin);pointerSource.addEventListener('mousedown',begin);
pointerTarget.addEventListener('pointerup',finish);pointerTarget.addEventListener('mouseup',finish);
sourceBox.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','fixture'));
targetBox.addEventListener('dragover',e=>e.preventDefault());
targetBox.addEventListener('drop',e=>{e.preventDefault();document.body.dataset.html5Drop=e.isTrusted?'trusted':'synthetic'});
</script>`;
const receivedUploads=[];
const REPORT_BYTES=Buffer.from('id,value\n1,task-download\n');
const gated=[];
const server = createServer((req, res) => {
  // 中文注释：下载路由全部是合成数据；gated 路由把并发请求同时放行，用于验证同网址并发下载不被认领。
  if(req.url==='/download/report.csv'||req.url==='/download/gated.csv'){
    const send=()=>{res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':`attachment; filename="${req.url.includes('gated')?'gated':'report'}.csv"`});res.end(REPORT_BYTES);};
    if(req.url.includes('gated'))gated.push(send);else send();
    return;
  }
  if(req.url==='/pixel.png'){
    res.writeHead(200,{'Content-Type':'image/png'});
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64'));return;
  }
  if(req.url==='/download/release'){for(const send of gated.splice(0))send();res.end('released');return;}
  if(req.url==='/download/broken'){
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':'100000','Content-Disposition':'attachment; filename="broken.bin"'});
    res.write(Buffer.alloc(1000,1));setTimeout(()=>res.destroy(),300);return;
  }
  if(req.url==='/download/slow.bin'){
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(50*1024*1024),'Content-Disposition':'attachment; filename="slow.bin"'});
    const timer=setInterval(()=>{if(!res.write(Buffer.alloc(1024,2)))return;},200);
    res.on('close',()=>clearInterval(timer));return;
  }
  if(req.url?.startsWith('/upload?')&&req.method==='POST'){
    const hash=createHash('sha256');let bytes=0;
    req.on('data',chunk=>{hash.update(chunk);bytes+=chunk.length;});
    req.on('end',()=>{receivedUploads.push({sha256:hash.digest('hex'),size:bytes,name:new URL(req.url,origin).searchParams.get('name')});res.writeHead(200);res.end('ok');});
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end((req.url==='/child'?'<!doctype html><meta charset="utf-8"><button id="frame-button">Frame Action</button><script>document.querySelector("button").onclick=e=>{document.body.dataset.clicked="yes";document.body.dataset.pointerTrusted=String(e.isTrusted)}</script>':
    req.url==='/cross-child'?'<!doctype html><meta charset="utf-8"><button id="cross-action">Cross Action</button><button id="cross-pointer">Cross Pointer</button><button id="cross-key">Cross Key</button><button id="load-deep-page">Load Deep Page</button><input id="cross-draft" aria-label="Cross Draft"><input id="cross-check" type="checkbox" aria-label="Cross Check"><select id="cross-choice" aria-label="Cross Choice"><option value="a">甲</option><option value="b">乙</option></select><p id="cross-status">Idle</p><p id="cross-output">Unset</p><p id="pointer-output">No Pointer</p><p id="key-output">No Key</p><iframe id="deep-frame" src="http://deep.test:__PORT__/deep-child"></iframe><script>document.querySelector("#cross-action").onclick=()=>document.querySelector("#cross-status").textContent="Clicked";document.querySelector("#cross-pointer").onclick=e=>document.querySelector("#pointer-output").textContent=e.isTrusted?"Trusted Pointer":"Synthetic Pointer";document.querySelector("#cross-key").onkeydown=e=>document.querySelector("#key-output").textContent=e.isTrusted&&e.key==="ArrowDown"?"Trusted Key":"Wrong Key";document.querySelector("#load-deep-page").onclick=()=>document.querySelector("#deep-frame").src="http://deep.test:__PORT__/deep-secret";document.querySelector("#cross-draft").onchange=e=>document.querySelector("#cross-output").textContent=e.target.value;document.querySelector("#cross-choice").onchange=e=>document.querySelector("#cross-output").textContent=e.target.value</script>':
    req.url==='/deep-child'?'<!doctype html><meta charset="utf-8"><button id="deep-action">Deep Action</button><button id="deep-pointer">Deep Pointer</button><button id="deep-key">Deep Key</button><input id="deep-draft" aria-label="Deep Draft"><input id="deep-check" type="checkbox" aria-label="Deep Check"><select id="deep-choice" aria-label="Deep Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><p id="deep-status">Idle</p><p id="deep-output">Unset</p><p id="deep-key-output">No Key</p><p id="deep-pointer-output">No Pointer</p><script>document.querySelector("#deep-action").onclick=()=>document.querySelector("#deep-status").textContent="Deep Clicked";document.querySelector("#deep-pointer").onclick=e=>document.querySelector("#deep-pointer-output").textContent=e.isTrusted?"Trusted Deep Pointer":"Synthetic Deep Pointer";document.querySelector("#deep-key").onkeydown=e=>document.querySelector("#deep-key-output").textContent=e.isTrusted&&e.key==="ArrowDown"?"Trusted Deep Key":"Wrong Key";document.querySelector("#deep-draft").onchange=e=>document.querySelector("#deep-output").textContent=e.target.value;document.querySelector("#deep-choice").onchange=e=>document.querySelector("#deep-output").textContent=e.target.value</script>':
    req.url==='/deep-secret'?'<!doctype html><meta charset="utf-8"><input type="password" value="fixture-secret">':
    req.url==='/cross-secret'?'<!doctype html><meta charset="utf-8"><input type="password" value="fixture-secret">':
    page).replaceAll('__PORT__',String(server.address().port)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const crossOrigin = `http://frame.test:${server.address().port}`;
const deepOrigin = `http://deep.test:${server.address().port}`;

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
  const packageRoot=path.join(work,'package');
  const extensionRoot = packageMode ? path.join(packageRoot,'native-extension') :
    directExtension ? path.resolve(directExtension) : path.join(work, 'dist-native');
  if(packageMode)await exec(process.execPath,[path.join(root,'scripts/package-executor.mjs'),
   '--source',root,'--output',packageRoot],{cwd:root,timeout:120000});
  else if(!directExtension)await exec(process.execPath,[path.join(root,'native-extension/build.mjs'),extensionRoot],{cwd:root});
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
  // 中文注释：临时 profile 的默认下载目录指向本次 scratch，测试不写入用户真实的“下载”文件夹。
  const downloadsDir=path.join(work,'downloads');
  await mkdir(path.join(profile,'Default'),{recursive:true});await mkdir(downloadsDir,{recursive:true});
  await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadsDir,prompt_for_download:false,directory_upgrade:true}}));
  // 中文注释：无 key 的 unpacked 扩展 ID 由规范化路径摘要确定；先登记 Native host 再启动浏览器，消除首次连接竞态。
  // 中文注释：1.4.0 起扩展 ID 由 manifest key 固定；无 key 时才按加载路径推算。
  const manifestKey = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).key;
  const expectedExtensionId = [...(manifestKey ? sha256(Buffer.from(manifestKey, 'base64')) : sha256(path.resolve(extensionRoot))).slice(0,32)]
    .map(digit=>String.fromCharCode(97+Number.parseInt(digit,16))).join('');
  let staged;
  try{
    const origins=JSON.stringify([`chrome-extension://${expectedExtensionId}/`]);
    // 中文注释：包模式只通过包内安装器落地到隔离 HOME，后续 helper 都读取安装后的插件。
    staged = packageMode?await helperCall('stage_package',work,packageRoot,origins):
      await helperCall('stage',work,origins);
    const manifestSource = staged.manifests[browser === 'chrome' ? 0 : 1];
    const profileManifest = path.join(profile, 'NativeMessagingHosts/com.hermes.browser_link.json');
    await mkdir(path.dirname(profileManifest), {recursive: true});
    await copyFile(manifestSource, profileManifest);
  }catch(error){await rm(work,{recursive:true,force:true});throw error;}
  const temp = path.join(work, 'tmp');
  await mkdir(temp, {recursive: true});
  const scratchHome = path.join(work, 'h');
  const browserEnv = {
    HOME: process.env.HOME, HERMES_HOME: path.join(scratchHome, '.hermes'), TMPDIR: temp,
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG || 'en_US.UTF-8',
  };
  const proc = spawn(choices[browser], [
    '--headless=new', '--use-mock-keychain', '--password-store=basic', '--disable-background-networking', '--disable-sync', '--no-proxy-server',
    '--site-per-process', '--host-resolver-rules=MAP frame.test 127.0.0.1,MAP deep.test 127.0.0.1',
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: work, env: browserEnv});
  let cdp;
  let ui;
  let logs = '',report,cleanupError;
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
    assert.equal(extensionId,expectedExtensionId,'unpacked extension ID changed after host registration');

    await cdp.call('Target.createTarget', {url: `chrome-extension://${extensionId}/popup.html`});
    const popupTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(item => item.url === `chrome-extension://${extensionId}/popup.html`));
    ui = new CdpClient(popupTarget.webSocketDebuggerUrl);
    await ui.connect();
    const activateExtensionTab=async(client,targetId)=>{
      // 中文注释：无头浏览器只向当前窗口的前台扩展页投递指针事件；每次点击前恢复窗口与目标焦点。
      await client.evaluate('chrome.tabs.getCurrent().then(tab=>chrome.windows.update(tab.windowId,{focused:true}).then(()=>chrome.tabs.update(tab.id,{active:true}))).then(()=>true)');
      await cdp.call('Target.activateTarget',{targetId});
      await client.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    };
    const click = async selector => {
      try{
        await activateExtensionTab(ui,popupTarget.id);
        const point = await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await ui.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
        await ui.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
      }catch(error){throw Error(`popup click ${selector}: ${error.message}`,{cause:error});}
    };
    await waitFor(() => ui.evaluate(`document.querySelector('#connection-label')!==null`));
    if (!await ui.evaluate(`document.querySelector('#connection-label').textContent==='已连接'`)) await click('#connect');
    await waitFor(() => ui.evaluate(`document.querySelector('#connection-label').textContent==='已连接'`), 35000);
    // 中文注释：临时 profile 初次授权状态未配置；先置为明确关闭，再用真实界面完成开启。
    await ui.evaluate(`chrome.storage.local.set({browserFullConsent:{version:1,enabled:false}})`);
    await waitFor(()=>ui.evaluate(`document.querySelector('#access-toggle').disabled===false`));
    // 中文注释：低频授权在简洁界面的折叠区，先展开再按真实坐标操作。
    await click('.settings > summary');
    await waitFor(()=>ui.evaluate(`document.querySelector('.settings').open===true`));
    await click('#access-toggle');await click('#confirm-enable');
    await waitFor(()=>ui.evaluate(`document.querySelector('#access-toggle').getAttribute('aria-checked')==='true'`));

    const rpc = (session, suffix, args = {}) => helperCall('rpc', work, session, suffix, JSON.stringify(args));
    const instances = await waitFor(async () => {
      const found = await rpc('session-a', 'browsers');
      return Array.isArray(found) && found.some(item => item.browser === browser) ? found : null;
    }, 30000);
    const instance = instances.find(item => item.browser === browser);
    const userTabId=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin+'/user')},active:false}).then(tab=>tab.id)`);
    const task = await rpc('session-a', 'create', {title: `Native v2 ${browser}`, instance_id: instance.instanceId, allowed_origins: [origin,crossOrigin,deepOrigin]});
    await waitFor(async () => {const current=await rpc('session-a','get',{task_id:task.id});return current.state==='ready'&&current.activeMode==='full';});
    assert.ok((await rpc('session-b', 'get', {task_id: task.id})).error, 'foreign owner must be denied');
    const opened=await rpc('session-a','run',{task_id:task.id,request_id:`${browser}-open-work-tab`,action:'new_tab',url:origin+'/fixture'});
    const tabId=opened.tabId;assert.ok(Number.isInteger(tabId),JSON.stringify(opened));
    // 中文注释：高亮验收要求工作页可见；任务只操作自己创建并持有的工作页。
    await ui.evaluate(`chrome.tabs.update(${tabId},{active:true})`);

    let sequence = 0;
    const run = (action, extra = {}) => rpc('session-a', 'run', {
      task_id: task.id, request_id: `${browser}-native-v2-${++sequence}`,
      action, tab_id: tabId, ...extra,
    });
    const runWithReadback = async (action, extra = {}) => {
      const args = {task_id: task.id, request_id: `${browser}-native-v2-${++sequence}`, action, tab_id: tabId, ...extra};
      const result = await rpc('session-a', 'run', args);
      assert.notEqual(result.status,'approval_required','browser-level consent should have granted task full access');
      assert.deepEqual(await rpc('session-a', 'run', args), result, 'same request ID must read the result without replay');
      return result;
    };
    const readPage = expression => ui.evaluate(`chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',{expression:${JSON.stringify(expression)},returnByValue:true}).then(r=>r.result.value)`);

    // 中文注释：接管入口已移到页面遮罩，通过真实指针点击闭合影子树中的按钮。
    const clickOverlay=async action=>ui.evaluate(`(async()=>{
      const target={tabId:${tabId}},tree=await chrome.debugger.sendCommand(target,'DOM.getDocument',{depth:-1,pierce:true});
      const find=node=>{const attrs=node.attributes||[];if(attrs.some((name,i)=>name==='data-action'&&attrs[i+1]===${JSON.stringify(action)}))return node;
        for(const child of [...node.children||[],...node.shadowRoots||[]]){const found=find(child);if(found)return found;}};
      const node=find(tree.root);if(!node)throw Error('遮罩按钮不存在');
      const {model}=await chrome.debugger.sendCommand(target,'DOM.getBoxModel',{nodeId:node.nodeId});
      const x=(model.content[0]+model.content[4])/2,y=(model.content[1]+model.content[5])/2;
      for(const type of ['mousePressed','mouseReleased'])await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
    })()`);
    await clickOverlay('takeover');
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).state==='paused');
    await clickOverlay('resume');
    await waitFor(async()=>(await rpc('session-a','get',{task_id:task.id})).state==='ready');

    // 中文注释：V1.3 经过真实 Hermes→daemon→扩展链路验证解析与参数化函数。
    const parsedV13=await run('page.parse',{options:{sections:['forms'],budget:12000}});
    assert.equal(parsedV13.schemaVersion,1,JSON.stringify(parsedV13));
    assert.ok(parsedV13.forms.some(field=>field.label==='Draft'),JSON.stringify(parsedV13));
    const v13Script=await helperCall('script',work,'session-a',task.id,
      "assert evaluate('(x)=>x', {'text': '中文参数'}) == {'text': '中文参数'}\n"+
      "assert wait_for('#confirm', timeout=5)['satisfied']\n"+
      "result=extract({'record':'#confirm','fields':{'label':{'selector':':scope','required':True}}})\n"+
      "assert result['records'][0]['fields']['label']=='Confirm'\n"+
      "with expect_response(timeout=5) as receipt:\n    evaluate('()=>fetch(\"/pixel.png\").then(r=>r.status)')\n"+
      "assert receipt.result['status']==200\n"+
      "with expect_navigation(timeout=5) as navigation:\n    evaluate('()=>history.pushState({}, \"\", \"#v13\")')\n"+
      "assert navigation.result['same_document']\nevaluate('()=>history.replaceState({}, \"\", location.pathname)')\nprint('V13_SCRIPT_OK')");
    assert.equal(v13Script.exit_code,0,JSON.stringify(v13Script));
    assert.ok(v13Script.stdout.includes('V13_SCRIPT_OK'),JSON.stringify(v13Script));

    const semantic = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Confirm', roles: ['button'], viewport: true, budget: 1600}});
    assert.equal(semantic.version, 2, JSON.stringify(semantic));
    assert.equal(semantic.items.length, 1);
    const buttonToken = {binding: semantic.binding, snapshot_id: semantic.snapshotId, ref: semantic.items[0].ref};
    const clickResult = await runWithReadback('ref_click', buttonToken);
    assert.equal(clickResult.clicked, true, JSON.stringify(clickResult));
    assert.equal(await readPage('document.body.dataset.clicks'), '1');

    const draft = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Draft', roles: ['textbox'], budget: 1600}});
    const filledDraft=await runWithReadback('ref_fill', {binding: draft.binding, snapshot_id: draft.snapshotId, ref: draft.items[0].ref, text: 'native-v2'});
    assert.equal(filledDraft.filled,true,JSON.stringify(filledDraft));
    assert.equal(await readPage('document.querySelector("#draft").value'), 'native-v2');

    const uploadBytes=[Buffer.from('person-selected-first'),Buffer.from('person-selected-second')];
    const uploadStart=receivedUploads.length;
    const registered=[];
    for(const [index,bytes] of uploadBytes.entries())registered.push(await helperCall('artifact',work,'session-a',task.id,origin,
      `selected-${index}.txt`,bytes.toString('base64')));
    const visibleArtifacts=await rpc('session-a','artifacts',{task_id:task.id});
    assert.deepEqual(new Set(visibleArtifacts.map(item=>item.id)),new Set(registered.map(item=>item.id)));
    assert.ok(visibleArtifacts.every(item=>!Object.hasOwn(item,'path')));
    // 中文注释：多文件选择可能立即触发网站上传，服务器收到的真实摘要才算网站接收证据。
    const chosen=await runWithReadback('files.upload',{selector:'#upload-input',artifact_ids:registered.map(item=>item.id)});
    assert.equal(chosen.selectedCount,2,JSON.stringify(chosen));
    assert.equal(chosen.websiteState,'unverified');
    try{await waitFor(async()=>receivedUploads.length===uploadStart+2);}catch(error){
      // 中文注释：网页选择成功但服务器未收件时保留页面侧状态，便于区分事件与网络故障。
      error.message+=` uploadState=${JSON.stringify({received:receivedUploads.length,
        files:await readPage('document.querySelector("#upload-input").files.length').catch(()=>null),
        pageStatus:await readPage('document.body.dataset.uploaded').catch(()=>null)})}`;
      throw error;
    }
    assert.deepEqual(receivedUploads.slice(uploadStart,uploadStart+2).map(item=>item.sha256),uploadBytes.map(sha256));
    const replacement=Buffer.from('person-selected-replacement');
    const replacementRecord=await helperCall('artifact',work,'session-a',task.id,origin,'replacement.txt',replacement.toString('base64'));
    const replaced=await runWithReadback('files.upload',{selector:'#upload-input',artifact_ids:[replacementRecord.id]});
    assert.equal(replaced.selectedCount,1);
    await waitFor(async()=>receivedUploads.length===uploadStart+3);
    assert.equal(receivedUploads[uploadStart+2].sha256,sha256(replacement));
    assert.equal(await readPage('document.querySelector("#upload-input").files.length'),1);
    // 中文注释：对话给出的绝对路径直接上传，并以测试站点实际收到的摘要验收。
    const pathBytes=Buffer.from('conversation-local-path-upload');
    const localPath=path.join(work,'conversation-upload.txt');
    await writeFile(localPath,pathBytes);
    const pathSelected=await runWithReadback('files.upload',{selector:'#upload-input',paths:[localPath]});
    assert.equal(pathSelected.selectedCount,1,JSON.stringify(pathSelected));
    await waitFor(async()=>receivedUploads.length===uploadStart+4);
    assert.equal(receivedUploads[uploadStart+3].sha256,sha256(pathBytes));
    assert.equal(receivedUploads[uploadStart+3].name,'conversation-upload.txt');

    // 中文注释：A01 下载——链接、重名、blob、中断、取消与同网址并发用户下载。
    const dl=(extra={})=>rpc('session-a','downloads',{task_id:task.id,...extra});
    const namedRef=async(name,role='link')=>{
      const snap=await run('semantic_snapshot',{options:{mode:'interactive',query:name,roles:[role],budget:1600}});
      assert.equal(snap.items?.length,1,JSON.stringify(snap));
      return {binding:snap.binding,snapshot_id:snap.snapshotId,ref:snap.items[0].ref};
    };
    // 中文注释：同页多次下载需要真实用户手势，否则浏览器拦截“自动多次下载”；这里使用可信指针点击。
    const clickNamed=async(name,role='link')=>{const clicked=await run('ref_click',{...await namedRef(name,role),clickMode:'pointer'});assert.equal(clicked.clicked,true,JSON.stringify(clicked));return clicked;};
    const waitDownload=async predicate=>{
      try{return await waitFor(async()=>(await dl()).downloads?.find(predicate)||null,30000);}
      catch(error){error.message+=` downloads=${JSON.stringify(await dl())} files=${JSON.stringify(await readdir(downloadsDir,{recursive:true}))}`;throw error;}
    };
    await clickNamed('Download Report');
    const firstDownload=await waitDownload(row=>row.state==='complete'&&row.filename==='report.csv');
    await clickNamed('Download Report');
    const secondDownload=await waitDownload(row=>row.state==='complete'&&row.id!==firstDownload.id);
    assert.notEqual(secondDownload.filename,firstDownload.filename,'same-name download must not overwrite');
    for(const row of [firstDownload,secondDownload]){
      const claimedRow=await dl({action:'claim',download_id:row.id});
      assert.equal(claimedRow.sha256,sha256(REPORT_BYTES),JSON.stringify(claimedRow));
      assert.equal(sha256(await readFile(claimedRow.localPath)),sha256(REPORT_BYTES));
      assert.ok(claimedRow.localPath.startsWith(path.join(work,'h','.hermes')),'claimed file lives in the private store');
    }
    await clickNamed('Download Blob','button');
    const blobDownload=await waitDownload(row=>row.state==='complete'&&row.filename==='blob-report.txt');
    const blobClaim=await dl({action:'claim',download_id:blobDownload.id});
    assert.equal(sha256(await readFile(blobClaim.localPath)),sha256(Buffer.from('blob-download-evidence')));
    await clickNamed('Broken Download');
    const broken=await waitDownload(row=>row.filename==='broken.bin'&&row.state!=='in_progress');
    assert.equal(broken.state,'interrupted',JSON.stringify(broken));
    const brokenClaim=await dl({action:'claim',download_id:broken.id});
    assert.equal(brokenClaim.bridgeCode,'download_not_complete',JSON.stringify(brokenClaim));
    await clickNamed('Slow Download');
    const slow=await waitDownload(row=>row.filename==='slow.bin'&&row.state==='in_progress');
    const cancelledDownload=await dl({action:'cancel',download_id:slow.id});
    assert.equal(cancelledDownload.state,'cancelled',JSON.stringify(cancelledDownload));
    const beforeUser=await dl();
    const gatedRef=await namedRef('Gated Download');
    // 中文注释：用户下载请求被服务器挂起，不能等待其 Promise；只发起后立即返回。
    await ui.evaluate(`void chrome.downloads.download({url:${JSON.stringify(origin+'/download/gated.csv')}});true`);
    // 中文注释：点击在服务器放行前不会返回；先发起点击，待两个请求都挂起后同时放行，再读取点击回执。
    const gatedClick=run('ref_click',{...gatedRef,clickMode:'pointer'});
    await waitFor(async()=>gated.length===2,10000);
    await fetch(origin+'/download/release');
    assert.equal((await gatedClick).clicked,true);
    await waitFor(async()=>(await readdir(downloadsDir)).filter(name=>name.startsWith('gated')).length===2,20000);
    const afterUser=await dl();
    assert.equal(afterUser.downloads.length,beforeUser.downloads.length,'concurrent same-URL download must not be claimed');
    assert.ok(afterUser.unattributed>beforeUser.unattributed,JSON.stringify(afterUser));
    const check = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Check', roles: ['checkbox'], budget: 1600}});
    const checked = await runWithReadback('ref_set_checked', {binding: check.binding, snapshot_id: check.snapshotId, ref: check.items[0].ref, checked: true});
    assert.equal(checked.verified, true);assert.equal(await readPage('document.querySelector("#check").checked'), true);
    const choice = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Choice', roles: ['combobox'], budget: 1600}});
    const selected = await runWithReadback('ref_select_option', {binding: choice.binding, snapshot_id: choice.snapshotId, ref: choice.items[0].ref, by: 'value', values: ['b']});
    assert.equal(selected.verified, true);assert.equal(await readPage('document.querySelector("#choice").value'), 'b');
    const custom=await run('semantic_snapshot',{options:{mode:'interactive',query:'Custom Select',roles:['combobox'],budget:1600}});
    const customChoice=await runWithReadback('ref_select_option',{binding:custom.binding,snapshot_id:custom.snapshotId,ref:custom.items[0].ref,
      by:'value',values:['b']});
    assert.equal(customChoice.verified,true,JSON.stringify(customChoice));
    assert.equal(await readPage('document.querySelector("#custom").dataset.selected'),'b');
    const pointer = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Pointer Check', roles: ['button'], budget: 1600}});
    const pointerClick = await runWithReadback('ref_click', {binding: pointer.binding, snapshot_id: pointer.snapshotId, ref: pointer.items[0].ref, clickMode: 'pointer'});
    assert.equal(pointerClick.delivery, 'confirmed');assert.equal(await readPage('document.body.dataset.pointerClicks'), '1');
    assert.equal(await readPage('document.body.dataset.pointerTrusted'), 'true');

    await waitFor(()=>readPage('document.querySelector("#same-frame")?.contentDocument?.readyState==="complete"'));
    const shadow = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Open Shadow', composed: true, budget: 2500}});
    assert.equal(shadow.items.length,1);assert.ok(shadow.items[0].targetPath.some(step=>step.kind==='shadow'));
    assert.equal((await runWithReadback('ref_click', {binding: shadow.binding, snapshot_id: shadow.snapshotId, ref: shadow.items[0].ref})).clicked,true);
    assert.equal(await readPage('document.body.dataset.shadowClicked'),'yes');
    const shadowPointer=await run('semantic_snapshot',{options:{mode:'interactive',query:'Open Shadow',composed:true,budget:2500}});
    assert.equal((await runWithReadback('ref_click',{binding:shadowPointer.binding,snapshot_id:shadowPointer.snapshotId,
      ref:shadowPointer.items[0].ref,clickMode:'pointer'})).delivery,'confirmed');
    assert.equal(await readPage('document.body.dataset.shadowPointerTrusted'),'true');
    const frame = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Frame Action', composed: true, budget: 2500}});
    assert.equal(frame.items.length,1);assert.ok(frame.items[0].targetPath.some(step=>step.kind==='frame'));
    assert.equal((await runWithReadback('ref_click', {binding: frame.binding, snapshot_id: frame.snapshotId, ref: frame.items[0].ref})).clicked,true);
    assert.equal(await readPage('document.querySelector("#same-frame").contentDocument.body.dataset.clicked'),'yes');
    const framePointer=await run('semantic_snapshot',{options:{mode:'interactive',query:'Frame Action',composed:true,budget:2500}});
    assert.equal((await runWithReadback('ref_click',{binding:framePointer.binding,snapshot_id:framePointer.snapshotId,
      ref:framePointer.items[0].ref,clickMode:'pointer'})).delivery,'confirmed');
    assert.equal(await readPage('document.querySelector("#same-frame").contentDocument.body.dataset.pointerTrusted'),'true');
    const catalog = await run('frame_catalog');
    const crossFrame = catalog.frames.find(item=>item.origin===crossOrigin);
    assert.equal(crossFrame?.access,'ready',JSON.stringify(catalog));
    assert.equal(crossFrame.kind,'out_of_process');
    const deepFrame=catalog.frames.find(item=>item.origin===deepOrigin);
    assert.equal(deepFrame?.access,'ready',JSON.stringify(catalog));
    assert.equal(deepFrame.parentFrameToken,crossFrame.frameToken);
    const deepSnapshot=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Action',budget:1600}});
    assert.equal(deepSnapshot.items[0].name,'Deep Action');
    const remote = await run('semantic_snapshot', {options: {frameToken: crossFrame.frameToken, mode: 'interactive', query: 'Cross Action', budget: 1600}});
    assert.equal(remote.items.length,1);assert.equal(remote.frameToken,crossFrame.frameToken);
    assert.ok(remote.items[0].targetPath.some(step=>step.frameToken===crossFrame.frameToken));
    const childWrite={binding:remote.binding,snapshot_id:remote.snapshotId,ref:remote.items[0].ref,frame_token:crossFrame.frameToken};
    const deepClicked=await run('ref_click',{binding:deepSnapshot.binding,snapshot_id:deepSnapshot.snapshotId,ref:deepSnapshot.items[0].ref,
      frame_token:deepFrame.frameToken});
    assert.equal(deepClicked.clicked,true,JSON.stringify(deepClicked));
    const deepEffect=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'content',query:'Deep Clicked',budget:1600}});
    assert.ok(deepEffect.items.some(item=>item.name==='Deep Clicked'));
    const deepDraft=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Draft',budget:1600}});
    assert.equal((await run('ref_fill',{binding:deepDraft.binding,snapshot_id:deepDraft.snapshotId,ref:deepDraft.items[0].ref,
      frame_token:deepFrame.frameToken,text:'nested-text'})).filled,true);
    const deepDraftEffect=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'content',query:'nested-text',budget:1600}});
    assert.ok(deepDraftEffect.items.some(item=>item.name==='nested-text'));
    const deepCheck=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Check',budget:1600}});
    assert.equal((await run('ref_set_checked',{binding:deepCheck.binding,snapshot_id:deepCheck.snapshotId,ref:deepCheck.items[0].ref,
      frame_token:deepFrame.frameToken,checked:true})).verified,true);
    const deepCheckEffect=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Check',budget:1600}});
    assert.equal(deepCheckEffect.items[0].checked,true);
    const deepChoice=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Choice',budget:1600}});
    assert.equal((await run('ref_select_option',{binding:deepChoice.binding,snapshot_id:deepChoice.snapshotId,ref:deepChoice.items[0].ref,
      frame_token:deepFrame.frameToken,by:'value',values:['b']})).verified,true);
    const deepKey=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Key',budget:1600}});
    assert.equal((await run('ref_press',{binding:deepKey.binding,snapshot_id:deepKey.snapshotId,ref:deepKey.items[0].ref,
      frame_token:deepFrame.frameToken,key:'ArrowDown'})).delivery,'cdp-key-events');
    const deepKeyEffect=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'content',query:'Trusted Deep Key',budget:1600}});
    assert.ok(deepKeyEffect.items.some(item=>item.name==='Trusted Deep Key'));
    const deepPointer=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',query:'Deep Pointer',budget:1600}});
    assert.equal((await run('ref_click',{binding:deepPointer.binding,snapshot_id:deepPointer.snapshotId,ref:deepPointer.items[0].ref,
      frame_token:deepFrame.frameToken,clickMode:'pointer'})).delivery,'confirmed');
    const deepPointerEffect=await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'content',query:'Trusted Deep Pointer',budget:1600}});
    assert.ok(deepPointerEffect.items.some(item=>item.name==='Trusted Deep Pointer'));
    assert.equal((await run('ref_click',childWrite)).clicked,true);
    const effect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'content',query:'Clicked',budget:1600}});
    assert.ok(effect.items.some(item=>item.name==='Clicked'),'child page effect must be read back');
    const crossDraft=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Draft',budget:1600}});
    assert.equal((await run('ref_fill',{binding:crossDraft.binding,snapshot_id:crossDraft.snapshotId,ref:crossDraft.items[0].ref,
      frame_token:crossFrame.frameToken,text:'frame-text'})).filled,true);
    const draftEffect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'content',query:'frame-text',budget:1600}});
    assert.ok(draftEffect.items.some(item=>item.name==='frame-text'));
    const crossCheck=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Check',budget:1600}});
    const checkedChild=await run('ref_set_checked',{binding:crossCheck.binding,snapshot_id:crossCheck.snapshotId,ref:crossCheck.items[0].ref,
      frame_token:crossFrame.frameToken,checked:true});
    assert.equal(checkedChild.verified,true);
    const checkEffect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Check',budget:1600}});
    assert.equal(checkEffect.items[0].checked,true);
    const crossChoice=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Choice',budget:1600}});
    const chosenChild=await run('ref_select_option',{binding:crossChoice.binding,snapshot_id:crossChoice.snapshotId,ref:crossChoice.items[0].ref,
      frame_token:crossFrame.frameToken,by:'value',values:['b']});
    assert.equal(chosenChild.verified,true);
    const choiceEffect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'content',query:'b',budget:1600}});
    assert.ok(choiceEffect.items.some(item=>item.name==='b'));
    const pointerChild=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Pointer',budget:1600}});
    const pressedChild=await run('ref_click',{binding:pointerChild.binding,snapshot_id:pointerChild.snapshotId,ref:pointerChild.items[0].ref,
      frame_token:crossFrame.frameToken,clickMode:'pointer'});
    assert.equal(pressedChild.delivery,'confirmed');
    const pointerEffect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'content',query:'Trusted Pointer',budget:1600}});
    assert.ok(pointerEffect.items.some(item=>item.name==='Trusted Pointer'));
    // 中文注释：在首层 OOPIF 的真实 CDP session 中验收受限按键与网页回读。
    const keyTarget=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Cross Key',budget:1600}});
    const keyResult=await run('ref_press',{binding:keyTarget.binding,snapshot_id:keyTarget.snapshotId,ref:keyTarget.items[0].ref,
      frame_token:crossFrame.frameToken,key:'ArrowDown'});
    assert.equal(keyResult.delivery,'cdp-key-events',JSON.stringify(keyResult));
    const keyEffect=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'content',query:'Trusted Key',budget:1600}});
    assert.ok(keyEffect.items.some(item=>item.name==='Trusted Key'));

    const shot = await run('screenshot');
    assert.ok(typeof shot.data === 'string' && shot.data.length > 100, 'ordinary screenshot bytes');
    const loadDeep=await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',query:'Load Deep Page',budget:1600}});
    const deepLoadClick=await run('ref_click',{binding:loadDeep.binding,snapshot_id:loadDeep.snapshotId,ref:loadDeep.items[0].ref,
      frame_token:crossFrame.frameToken});
    assert.equal(deepLoadClick.clicked,true,JSON.stringify(deepLoadClick));
    await waitFor(async()=>{
      const next=await run('frame_catalog');
      const child=next.frames.find(item=>item.origin===deepOrigin);
      return child?.access==='ready'&&child.documentId!==deepFrame.documentId;
    });
    assert.ok((await run('screenshot')).error,'nested cross-origin password value must block screenshot');
    await readPage(`document.querySelector('#cross-frame').src=${JSON.stringify(crossOrigin+'/cross-secret')}`);
    await waitFor(async()=>{
      const next=await run('frame_catalog');
      const child=next.frames.find(item=>item.origin===crossOrigin);
      return child?.access==='ready'&&child.documentId!==crossFrame.documentId;
    });
    assert.ok((await run('semantic_snapshot',{options:{frameToken:crossFrame.frameToken,mode:'interactive',budget:1600}})).error,
      'old cross-origin frame token cannot survive navigation');
    assert.ok((await run('semantic_snapshot',{options:{frameToken:deepFrame.frameToken,mode:'interactive',budget:1600}})).error,
      'old nested frame token cannot survive parent navigation');
    assert.ok((await run('screenshot')).error,'cross-origin password value must block screenshot');
    // 中文注释：只检查仍未公开的动作；已接入的交互动作通过上面的正向用例验证。
    const deferredActions = [
      'files.download.start', 'files.download.status',
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
    assert.ok((await runWithReadback('ref_click', buttonToken)).error, 'mutated snapshot ref must not replay');
    assert.equal(await readPage('document.body.dataset.clicks'), '1', 'stale reference cannot repeat the click');

    // 中文注释：官方工具对应的原生只读动作：图片、控制台（首次读取后收集）与 JS 对话框处理。
    const images=await run('images');
    assert.ok(images.images.some(image=>image.alt==='Fixture Pixel'&&image.width===1),JSON.stringify(images));
    // 中文注释：开启 Log 域会回放浏览器已有的日志条目；首次读取时清空，之后只看新输出。
    assert.ok(Array.isArray((await run('console',{clear:true})).messages));
    await readPage('console.warn("console-probe-1")');
    const consoleRead=await waitFor(async()=>{const reply=await run('console',{clear:true});return reply.messages?.some(row=>row.text==='console-probe-1')?reply:null;});
    assert.equal(consoleRead.messages.find(row=>row.text==='console-probe-1').type,'warning');
    await readPage('setTimeout(()=>{document.body.dataset.confirmed=String(confirm("Proceed?"))},0)');
    const blocked=await waitFor(async()=>{const reply=await run('semantic_snapshot',{options:{mode:'interactive',budget:1600}});return reply.bridgeCode==='dialog_open'?reply:null;});
    assert.equal(blocked.outcome_unknown,false);
    const handledDialog=await run('dialog',{accept:true});
    assert.equal(handledDialog.dialog.message,'Proceed?',JSON.stringify(handledDialog));
    assert.equal(await readPage('document.body.dataset.confirmed'),'true');
    assert.equal((await run('dialog',{accept:false})).bridgeCode,'no_dialog');
    // 中文注释：全部访问直接执行 JS、原始 CDP 和主上下文脚本。
    assert.equal((await run('js.evaluate',{expression:'1'})).value,1);
    assert.equal((await rpc('session-a','get',{task_id:task.id})).activeMode,'full');
    const isolated=await run('js.evaluate',{expression:'document.querySelector("#confirm").textContent'});
    assert.equal(isolated.value,'Confirm',JSON.stringify(isolated));assert.equal(isolated.world,'isolated');
    await readPage('window.__pageSecret="main-world-value"');
    assert.equal((await run('js.evaluate',{expression:'typeof window.__pageSecret'})).value,'undefined','isolated world does not see page globals');
    assert.equal((await run('js.evaluate',{expression:'window.__pageSecret',world:'main'})).value,'main-world-value');
    const nodeResult=await run('js.evaluate',{expression:'document.body'});
    assert.equal(nodeResult.serializable,false);assert.equal(nodeResult.subtype,'node');
    const cyclic=await run('js.evaluate',{expression:'(()=>{const a={};a.self=a;return a})()'});
    assert.equal(cyclic.serializable,false,JSON.stringify(cyclic));
    assert.equal((await run('js.evaluate',{expression:'(()=>{throw new Error("boom")})()'})).ok,false);
    assert.deepEqual((await run('js.evaluate',{expression:'new Promise(r=>setTimeout(()=>r({n:3}),50))'})).value,{n:3});
    const hung=await run('js.evaluate',{expression:'new Promise(()=>{})',timeout_ms:500});
    assert.equal(hung.bridgeCode,'js_timeout',JSON.stringify(hung));assert.equal(hung.outcome_unknown,true);
    // 中文注释：旧 CDP 黑名单已移除；在合成页面检查凭据读取命令确实派发。
    const cookieCommand=await run('cdp.send',{method:'Network.getAllCookies'});
    assert.equal(cookieCommand.bridgeCode,undefined,JSON.stringify(cookieCommand));
    assert.ok((await run('cdp.send',{method:'Page.navigate',cdp_params:{url:'https://example.com/'}})).error,'navigation outside approved origins denied');
    assert.equal((await run('cdp.send',{method:'DOM.getDocument',cdp_params:{depth:1}})).root.nodeName,'#document');
    assert.equal((await run('cdp.send',{method:'DOM.getDocument',cdp_params:{depth:1},timeout_ms:5000})).root.nodeName,'#document');
    // 中文注释：原始 Target 列表按浏览器结果返回；显式 target_id 与 frame_token 仍逐次核对任务归属。
    const rawTargets=await run('cdp.send',{method:'Target.getTargets'});
    assert.notEqual(rawTargets.bridgeCode,'cdp_method_denied',JSON.stringify(rawTargets));
    const ownPage=await ui.evaluate(`chrome.debugger.getTargets().then(rows=>rows.find(item=>item.type==='page'&&item.tabId===${tabId}))`);
    assert.ok(ownPage?.id||ownPage?.targetId,JSON.stringify(ownPage));
    assert.equal((await run('cdp.send',{method:'DOM.getDocument',target_id:ownPage.id||ownPage.targetId,cdp_params:{depth:1}})).root.nodeName,'#document');
    const foreignTarget=await run('cdp.send',{method:'DOM.getDocument',target_id:'foreign-target'});
    assert.equal(foreignTarget.bridgeCode,'target_not_owned',JSON.stringify(foreignTarget));
    const cdpFrames=await run('frame_catalog');
    const currentCross=cdpFrames.frames.find(item=>item.origin===crossOrigin&&item.access==='ready');
    assert.ok(currentCross?.frameToken,JSON.stringify(cdpFrames));
    assert.equal((await run('cdp.send',{method:'DOM.getDocument',frame_token:currentCross.frameToken,
      cdp_params:{depth:1}})).root.nodeName,'#document');
    await run('cdp.send',{method:'Runtime.enable'});
    // 中文注释：前面的网络/导航矩阵已有大量事件，先显式消费旧缓冲再观察本次日志。
    await run('cdp.events',{max:500});
    await run('js.evaluate',{expression:'console.log("hermes-console-probe")',world:'main'});
    const drained=await waitFor(async()=>{const reply=await run('cdp.events',{max:200});return reply.events?.some(e=>e.method==='Runtime.consoleAPICalled')?reply:null;});
    assert.ok(drained.events.every(e=>!JSON.stringify(e.params).match(/"(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)"\s*:/i)));
    // 中文注释：单独的临时任务先核实官方 about:blank 创建，避免与后续 CLI 批处理混淆结果。
    const blankTask=await rpc('blank-session','create',{title:`Blank probe ${browser}`,instance_id:instance.instanceId,allowed_origins:[origin]});
    await waitFor(async()=>{const current=await rpc('blank-session','get',{task_id:blankTask.id});return current.state==='ready'&&current.activeMode==='full';});
    try{
      const blankProbe=await helperCall('official_blank_probe',work,'blank-session',blankTask.id);
      assert.ok(Number.isInteger(blankProbe.tabId),JSON.stringify(blankProbe));
    }finally{await rpc('blank-session','close',{task_id:blankTask.id});}
    // 中文注释：真实 Browser Use CLI 经 browser_exec 适配器连接任务网关，逐项验证 harness helper。
    const uploadBefore=receivedUploads.length;
    const harnessScript=`import json, os, pathlib
out = {}
out['tabs'] = [t['url'] for t in list_tabs()]
out['info'] = page_info()
point = js("(()=>{const e=document.querySelector('#harness-button');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
before = js("Number(document.body.dataset.harnessClicks||0)")
click_at_xy(point['x'], point['y'])
out['clickDelta'] = js("Number(document.body.dataset.harnessClicks||0)") - before
fill_input('#harness-input', 'typed-by-harness')
out['typed'] = js("document.querySelector('#harness-input').value")
shot = capture_screenshot(os.path.join(os.environ['BH_AGENT_WORKSPACE'], 'harness-shot.png'))
out['shotBytes'] = os.path.getsize(shot)
upload = pathlib.Path(os.environ['BH_AGENT_WORKSPACE']) / 'harness-upload.txt'
upload.write_text('uploaded-by-harness')
upload_file('#upload-input', str(upload))
out['uploadFiles'] = js("document.querySelector('#upload-input').files.length")
for probe, call in (('cookies', lambda: cdp('Network.getAllCookies')), ('offsite', lambda: goto_url('https://example.com/')),
                    ('privateFile', lambda: upload_file('#upload-input', '/etc/hosts'))):
    try:
        call(); out[probe] = 'allowed'
    except Exception:
        out[probe] = 'denied'
frame = iframe_target('frame.test')
out['framePath'] = js("location.pathname", target_id=frame) if frame else None
tid = new_tab(${JSON.stringify(origin+'/fixture')})
wait_for_load()
out['newTabUrl'] = page_info()['url']
close_tab(tid)
out['afterClose'] = len(list_tabs())
print('RESULT=' + json.dumps(out))`;
    await ui.evaluate(`chrome.tabs.update(${tabId},{active:true}).then(()=>true)`);
    const execResult=await helperCall('browser_exec',work,'session-a',task.id,harnessScript,`acceptance-${browser}`);
    try{
      if(execResult.success!==true){
        const current=await rpc('session-a','get',{task_id:task.id}).catch(()=>({state:'readback_unavailable'}));
        assert.fail(JSON.stringify({execResult,task:{state:current.state,generation:current.generation,
          cleanupState:current.cleanupState,cleanupReason:current.cleanupReason,tabIds:current.tabIds,officialBlankTabs:current.officialBlankTabs}}));
      }
      const harness=JSON.parse(execResult.output.split('RESULT=').at(-1));
      assert.deepEqual(harness.tabs.map(url=>new URL(url).origin),[origin],'harness only sees the task page');
      assert.equal(harness.clickDelta,1,JSON.stringify(harness));assert.equal(harness.typed,'typed-by-harness');
      assert.ok(harness.shotBytes>1000);assert.equal(harness.uploadFiles,1);
      assert.deepEqual([harness.cookies,harness.offsite,harness.privateFile],['allowed','denied','allowed']);
      assert.equal(harness.framePath,'/cross-secret','iframe_target reaches the approved cross-origin frame session');
      assert.equal(new URL(harness.newTabUrl).origin,origin);assert.equal(harness.afterClose,1);
      await waitFor(async()=>receivedUploads.slice(uploadBefore).some(item=>item.sha256===sha256(Buffer.from('uploaded-by-harness'))));
    }finally{if(execResult.harness)await helperCall('harness_stop',work,execResult.harness).catch(()=>{});}
    // 中文注释：另建未触达 JS/CDP 的临时任务页验收合成 Vault 密码。
    const vaultTask=await rpc('vault-session','create',{title:`Vault fixture ${browser}`,instance_id:instance.instanceId,allowed_origins:[origin]});
    await waitFor(async()=>{const current=await rpc('vault-session','get',{task_id:vaultTask.id});return current.state==='ready'&&current.activeMode==='full';});
    const vaultOpened=await rpc('vault-session','run',{task_id:vaultTask.id,request_id:`${browser}-vault-tab`,action:'new_tab',url:origin+'/fixture'});
    const vaultTabId=vaultOpened.tabId;assert.ok(Number.isInteger(vaultTabId),JSON.stringify(vaultOpened));
    await ui.evaluate(`chrome.tabs.update(${vaultTabId},{active:true})`);
    const vaultItem=await helperCall('vault_seed',work,origin);
    assert.ok(vaultItem.handle.startsWith('vault_'));
    const vaultResult=await helperCall('vault',work,'vault-session',vaultTask.id,String(vaultTabId),vaultItem.handle);
    assert.equal(vaultResult.success,true,JSON.stringify(vaultResult));
    assert.equal(vaultResult.filled_fields,1);
    assert.ok(!JSON.stringify(vaultResult).includes('synthetic-vault-password-2026'));
    const vaultPageValue=await ui.evaluate(`chrome.debugger.sendCommand({tabId:${vaultTabId}},'Runtime.evaluate',{expression:'document.querySelector("#password").value',returnByValue:true}).then(r=>r.result.value)`);
    assert.equal(vaultPageValue,'synthetic-vault-password-2026');
    const vaultClosed=await rpc('vault-session','close',{task_id:vaultTask.id});
    assert.equal(vaultClosed.state,'closed');
    await click('#access-toggle');
    await waitFor(async()=>((await rpc('session-a','get',{task_id:task.id})).activeMode==='smart'));
    assert.equal((await rpc('session-a','get',{task_id:task.id})).activeMode,'smart');
    assert.equal((await run('js.evaluate',{expression:'1'})).status,'approval_required');
    const childDenied=await run('ref_click',childWrite);
    assert.equal(childDenied.status,'approval_required');

    const password = await run('semantic_snapshot', {options: {mode: 'interactive', query: 'Password', roles: ['textbox'], budget: 1600}});
    const sensitive = await run('ref_fill', {binding: password.binding, snapshot_id: password.snapshotId, ref: password.items[0].ref, text: 'fixture'});
    assert.equal(sensitive.status, 'user_input_required', 'sensitive ref fill must request human input');
    // 中文注释：语义按键也必须先识别密码字段，不得把 Enter 派发给敏感输入框。
    const sensitiveKey=await run('ref_press',{binding:password.binding,snapshot_id:password.snapshotId,ref:password.items[0].ref,key:'Enter'});
    assert.equal(sensitiveKey.status,'user_input_required','sensitive ref press must request human input');
    assert.equal(await readPage('document.querySelector("#password").value'), '', 'agent did not fill the sensitive field');


    const closed = await rpc('session-a', 'close', {task_id: task.id});
    assert.equal(closed.state, 'closed');
    const remaining=await waitFor(async()=>{
      const ids=await ui.evaluate('chrome.tabs.query({}).then(t=>t.map(x=>x.id))');
      return ids.includes(userTabId)&&!ids.includes(tabId)?ids:null;
    });
    assert.ok(remaining.includes(userTabId),'user tab retained');
    const installed = await helperCall('inspect', work);
    // 中文注释：包模式必须来自包内已安装插件；源码模式可来自隔离 host-bin 或临时安装的插件副本。
    if(packageMode)assert.equal(installed.daemonPath,path.join(staged.plugin,'native_bridge/daemon.py'));
    else assert.ok([path.join(staged.hermesHome,'plugin-data/browser-link-native/host-bin/daemon.py'),
      path.join(staged.hermesHome,'plugins/browser-link/native_bridge/daemon.py')].includes(installed.daemonPath),installed.daemonPath);
    if(packageMode)assert.equal(installed.pluginPath, staged.plugin);
    else assert.ok([staged.plugin,path.join(staged.hermesHome,'plugins/browser-link')].includes(installed.pluginPath),installed.pluginPath);

    report = {
      timestamp: new Date().toISOString(), browser, browserVersion: version.Browser,
      extensionId, instanceId: instance.instanceId, tabId,
      directExtensionPath: directExtension ? extensionRoot : null,
      packageFirst:packageMode,
      transport:packageMode?
       'verified current package -> scratch install -> real Chrome/Edge Native Messaging -> installed daemon/plugin -> real Hermes pre_tool_call dispatcher':
       'real temporary-profile Chrome/Edge Native Messaging -> staged host/daemon -> UDS -> temporary source-staged plugin -> real Hermes pre_tool_call dispatcher',
      sourceHashes: buildDeps.dependencies,
      staged: installed,
      passed: [
        'Hermes trusted hook owner lease', 'browser-level consent and task-owned tab',
        'task/tab/generation/origin checks',
        'semantic snapshot exact ref click/fill', 'stale ref denied', 'sensitive ref fill/press routed to human input',
        'native checkbox/select and asynchronous custom combobox state readback',
        'semantic pointer click trusted and dispatched once',
        'open Shadow and same-origin iframe target paths with click readback',
        'cross-origin OOPIF frame catalog and scoped snapshot',
        'cross-origin OOPIF DOM click/fill/check/select/pointer/key after trusted task full-access approval',
        'nested OOPIF click/fill/check/select/key/pointer readback, parent navigation invalidates tokens, nested secret screenshot blocked',
        'smart-mode child write requests approval, old child token rejected, child secret blocks screenshot',
        'task-scoped single and multiple file selection plus local-path upload with real website hashes',
        'task downloads: link, same-name uniquify, blob, interrupted refusal, cancel, private claim with matching SHA-256',
        'concurrent same-URL user download left unclaimed and counted as unattributed',
        'native images/console/dialog reads for official tools; open JS dialog fails other actions fast',
        'JS directly runs in full mode; smart mode requests approval after mode change',
        'isolated vs main-world JS, node/cyclic values as descriptions, exceptions, async values, bounded timeout',
        'raw CDP valid methods dispatched, off-origin navigation denied, events scrubbed',
        'raw Target.getTargets, owned target_id, frame token routing, bounded CDP timeout and foreign target rejection',
        'browser_exec via real Browser Use CLI on the task gateway: list_tabs/page_info/click_at_xy/fill_input/capture_screenshot/upload_file/iframe js/new_tab/close_tab, off-site navigation denied and local regular file allowed',
        'official about:blank creation and later task-owned close preserve the task connection',
        'registered Hermes browser_vault_list/fill from temporary encrypted Vault through trusted hook and private socket with page readback',
        'ordinary screenshot bytes', 'unlisted download and cookie run actions denied',
        'deferred actions have no fixture DOM effects', 'sensitive screenshot denied',
        'foreign owner denied', 'user tab retained and task-owned tab closed', 'staged dependency hashes verified',
        'V1.3 page parser and parameterized evaluate/conditional wait/response observation through real script lane',
        'V1.3 popup takeover and return controls confirmed by daemon',
        ...(packageMode?['package hashes verified before isolated installation; browser uses installed files']:[]),
      ],
      notClaimed: [...(packageMode?[]:['package-first acceptance']), 'nested OOPIF scale and transform edge cases', 'coordinate interaction and drag/drop', 'downloads initiated inside cross-process child frames', 'masked Vault save/unlock prompt and external password managers', 'credential export beyond current same-origin page request checks'],
    };
  } catch (error) {
    console.error('popup:', await ui?.evaluate('document.body.innerText').catch(() => ''));
    console.error('native status:', await ui?.evaluate(`chrome.runtime.sendMessage({type:'status'}).then(reply=>({connected:reply?.result?.connected,lastError:reply?.result?.lastError}))`).catch(() => null));
    console.error(logs.split('\n').filter(line => /native|Traceback|Error|denied/.test(line)).join('\n'));
    throw error;
  } finally {
    cleanupError=await helperCall('cleanup',work).then(()=>null,error=>error);
    ui?.close();
    cdp?.close();
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    // 中文注释：默认销毁临时配置；显式调试开关只保留文件，仍会停止测试 daemon 与浏览器。
    if(process.env.KEEP_NATIVE_V2_SCRATCH==='1')console.error('retained fixture:',work);
    else await rm(work, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
  if(cleanupError)throw cleanupError;
  // 中文注释：仅在业务链路和隔离清理都完成后写入通过证据。
  await mkdir(evidenceDir,{recursive:true});
  const evidence=path.join(evidenceDir,`native-v2-${browser}${packageMode?'-package':''}.json`);
  await writeFile(evidence,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,evidence}));
  return report;
}

try {
  for (const browser of browsers) await run(browser);
} finally {
  // 中文注释：中断下载的长连接不得使验收进程在报告成功后无限等待退出。
  server.closeAllConnections();
  server.close();
}
