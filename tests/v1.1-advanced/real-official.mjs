// 中文注释：A04/A01 真实验收：冻结的 Hermes 官方 browser_* 工具经真实插件注册、可信 hook 与覆盖逐项正向/异常调用，
// 以及 Vault 列表/填写/验证码/保存/解锁、来源错误、与页面脚本互斥、跨任务文件引用拒绝。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {waitFor} from '../native-v2/cdp-client.mjs';
import {openRealSession, openTask, helperCall} from '../native-v2/real-session.mjs';

const requested = process.argv.find(value => value.startsWith('--browser='))?.split('=')[1] || 'all';
const browsers = requested === 'all' ? ['chrome', 'edge'] : [requested];
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const packageMode = process.argv.includes('--package');
const evidenceDir = path.join(import.meta.dirname, 'evidence');

const officialPage = `<!doctype html><meta charset="utf-8"><title>official</title>
<button id="official">Official Button</button><input id="field" aria-label="Official Field">
<button id="dialog">Confirm Dialog</button><button id="sync-dialog">Sync Dialog</button><img src="/pixel.png" alt="Official Pixel" width="1" height="1">
<p style="margin-top:900px">Bottom Text</p>
<script>
document.getElementById('official').onclick=()=>{document.body.dataset.count=String(Number(document.body.dataset.count||0)+1)};
document.getElementById('field').oninput=e=>{document.body.dataset.field=e.target.value};
document.getElementById('dialog').onclick=()=>setTimeout(()=>{document.body.dataset.confirmed=String(confirm('Official confirm?'))},0);
document.getElementById('sync-dialog').onclick=()=>{document.body.dataset.syncConfirmed=String(confirm('Sync confirm?'))};
</script>`;
const loginPage = `<!doctype html><meta charset="utf-8"><title>login</title><form>
<input id="user" name="username" autocomplete="username" aria-label="Username">
<input id="pass" type="password" name="password" autocomplete="current-password" aria-label="Password">
<input id="code" name="otp" autocomplete="one-time-code" inputmode="numeric" aria-label="Code"></form>`;
const server = createServer((req, res) => {
  if (req.url === '/pixel.png') {
    res.writeHead(200, {'Content-Type': 'image/png'});
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url.startsWith('/login') ? loginPage : req.url.startsWith('/second') ? '<!doctype html><title>second</title><p>Second Page</p>' : officialPage);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// 中文注释：另一个本机来源，用于验证 Vault 条目来源不符时拒绝填写。
const otherOrigin = `http://localhost:${server.address().port}`;

async function run(browser) {
  const session = await openRealSession({browser, packageMode, label: 'of'});
  const results = [];
  const record = async (id, requirement, fn) => {
    if (only && !id.startsWith(only)) return;
    try { const detail = await fn(); results.push({id, requirement, status: 'passed', ...(detail ? {detail} : {})}); }
    catch (error) { results.push({id, requirement, status: 'failed', error: String(error.message).slice(-1500)}); }
  };
  const official = async (owner, taskId, calls, options = null) => {
    const reply = await helperCall('official_calls', session.work, owner, taskId, JSON.stringify(calls), options ? JSON.stringify(options) : '');
    assert.equal(reply.results?.[0]?.sessionBinding, 'ready', JSON.stringify(reply.results?.[0]).slice(0, 400));
    return reply.results.slice(1);
  };
  try {
    await session.enableFullAccess();

    await record('A04-official-tools', '官方单项工具逐项正向与异常：navigate/snapshot/click/type/press/scroll/back/get_images/console/dialog/vision(含 annotate)/cdp', async () => {
      const t = await openTask(session, {owner: 'official-session', origins: [origin], url: origin + '/', title: `Official ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const calls = [
        ['browser_navigate', {url: origin + '/official'}],
        ['browser_snapshot', {}],
        ['browser_click', {ref: '$ref:Official Button'}],
        ['browser_snapshot', {}],
        ['browser_type', {ref: '$ref:Official Field', text: 'typed-official'}],
        ['browser_press', {key: 'Tab'}],
        ['browser_scroll', {direction: 'down'}],
        ['browser_scroll', {direction: 'up'}],
        ['browser_get_images', {}],
        ['browser_console', {}],
        ['browser_vision', {question: 'What is on the page?'}],
        ['browser_vision', {question: 'Label the controls', annotate: true}],
        ['browser_snapshot', {full: true}],
        ['browser_click', {ref: '@e999'}],
        ['browser_navigate', {url: 'https://example.com/'}],
        ['browser_navigate', {url: origin + '/second'}],
        ['browser_back', {}],
        ['browser_snapshot', {}],
        ['browser_click', {ref: '$ref:Confirm Dialog'}],
        ['browser_dialog', {action: 'accept'}],
        ['browser_snapshot', {}],
        ['browser_click', {ref: '$ref:Sync Dialog'}],
        ['browser_dialog', {action: 'dismiss'}],
        ['browser_cdp', {method: 'DOM.getDocument'}],
        ['browser_console', {expression: 'document.title'}],
      ];
      const out = await official(t.owner, t.task.id, calls);
      const at = index => ({...out[index], _call: calls[index][0] + ' #' + index});
      assert.equal(at(0).success, true, JSON.stringify(at(0)));
      assert.match(at(1).snapshot, /Official Button/);
      assert.equal(at(2).success, true, JSON.stringify(at(2)));
      assert.equal(at(4).success, true, JSON.stringify(at(4)));
      assert.equal(at(5).success, true, JSON.stringify(at(5)));
      assert.equal(at(6).success, true); assert.equal(at(7).success, true);
      assert.ok(at(8).count >= 1, JSON.stringify(at(8)));
      assert.equal(at(9).success, true, JSON.stringify(at(9)));
      assert.equal(at(10).success, true, JSON.stringify(at(10)).slice(0, 300));
      const annotations = at(11).annotations || at(11).meta?.annotations;
      assert.ok(Array.isArray(annotations) && annotations.some(row => /^@e\d+$/.test(row.ref)), JSON.stringify(at(11)).slice(0, 400));
      assert.equal(at(12).code, 'unsupported_operation', JSON.stringify(at(12)));
      assert.equal(at(13).code, 'stale_reference', JSON.stringify(at(13)));
      assert.equal(at(14).success, false, JSON.stringify(at(14)));
      assert.equal(at(16).success, true, JSON.stringify(at(16)));
      assert.ok(String(at(16).url || '').endsWith('/official'), JSON.stringify(at(16)));
      assert.equal(at(18).success, true, JSON.stringify(at(18)));
      assert.equal(at(19).dialog?.message, 'Official confirm?', JSON.stringify(at(19)));
      assert.equal(at(18).dialog?.message, 'Official confirm?', JSON.stringify(at(18)));
      assert.equal(at(21).success, true, JSON.stringify(at(21)));
      assert.equal(at(21).dialog?.message, 'Sync confirm?', 'synchronous dialog reported by click');
      assert.equal(at(22).dialog?.message, 'Sync confirm?', JSON.stringify(at(22)));
      assert.equal(at(23).success, true, JSON.stringify(at(23)));
      assert.equal(at(24).success, true, JSON.stringify(at(24)));
      assert.equal(await t.read('document.body.dataset.count'), '1', 'official click dispatched once');
      assert.equal(await t.read('document.body.dataset.field'), 'typed-official');
      assert.equal(await t.read('document.body.dataset.confirmed'), 'true');
      assert.equal(await t.read('document.body.dataset.syncConfirmed'), 'false');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {calls: calls.length};
    });

    await record('A04-browser-exec-helpers', 'browser_exec 其余 harness helper 经任务 CDP 网关逐项调用：标签、输入、按键、滚动、等待、事件、录制与纯 HTTP', async () => {
      const t = await openTask(session, {owner: 'exec-session', origins: [origin], url: origin + '/official', title: `Exec ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      // 中文注释：全部访问的 browser_exec 直接打开任务网关，智能审批需先批准本次脚本。
      await t.read(`document.getElementById('field').addEventListener('keydown',e=>{document.body.dataset.keys=(document.body.dataset.keys||'')+e.key+','}),true`);
      const code = `import json, os
out = {}
def probe(name, fn):
    try:
        value = fn()
        out[name] = {'ok': True, 'value': value if isinstance(value, (str, int, float, bool, type(None))) else str(type(value).__name__)}
    except Exception as exc:
        out[name] = {'ok': False, 'error': type(exc).__name__ + ':' + str(exc)[:160]}
probe('current_tab', lambda: current_tab()['url'])
probe('switch_tab', lambda: (switch_tab(current_tab()), 'switched')[-1])
probe('ensure_real_tab', lambda: str(ensure_real_tab())[:40])
pt = js("(()=>{const r=document.querySelector('#field').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
click_at_xy(pt['x'], pt['y'])
probe('type_text', lambda: (type_text('hx'), js("document.querySelector('#field').value"))[-1])
probe('press_key', lambda: (press_key('Enter'), js("document.body.dataset.keys||''"))[-1])
probe('dispatch_key', lambda: (dispatch_key('#field', 'Tab', 'keydown'), js("document.body.dataset.keys||''"))[-1])
probe('scroll', lambda: (scroll(pt['x'], pt['y'], dy=400), wait(0.5), js("scrollY"))[-1])
probe('wait', lambda: (wait(0.2), 'waited')[-1])
probe('wait_for_element', lambda: bool(wait_for_element('#official', timeout=5)))
probe('wait_for_network_idle', lambda: (wait_for_network_idle(timeout=5), 'idle')[-1])
probe('drain_events', lambda: len(drain_events()))
probe('cdp', lambda: cdp('DOM.getDocument', depth=1)['root']['nodeName'])
probe('goto_url', lambda: (goto_url(${JSON.stringify(origin + '/second')}), wait_for_load(), page_info()['url'])[-1])
probe('http_get', lambda: http_get(${JSON.stringify(origin + '/second')})[:60])
probe('start_recording', lambda: str(start_recording('exec-check'))[-20:])
probe('recording_dir', lambda: str(recording_dir())[-20:])
probe('stop_recording', lambda: str(stop_recording())[-20:])
print('RESULT=' + json.dumps(out))`;
      const reply = await helperCall('browser_exec', session.work, t.owner, t.task.id, code, `exec-${browser}`);
      try {
        assert.equal(reply.success, true, JSON.stringify(reply).slice(0, 800));
        const out = JSON.parse(reply.output.split('RESULT=').at(-1));
        const failed = Object.entries(out).filter(([, row]) => !row.ok);
        assert.deepEqual(failed, [], JSON.stringify(out));
        assert.ok(String(out.current_tab.value).startsWith(origin));
        assert.equal(out.type_text.value, 'hx');
        assert.match(String(out.press_key.value), /Enter/);
        assert.ok(Number(out.scroll.value) > 0, JSON.stringify(out.scroll));
        assert.match(String(out.http_get.value), /Second Page/);
        assert.equal(out.cdp.value, '#document'); assert.ok(String(out.goto_url.value).endsWith('/second'), JSON.stringify(out.goto_url));
        return {helpers: Object.keys(out)};
      } finally {
        if (reply.harness) await helperCall('harness_stop', session.work, reply.harness).catch(() => {});
        await session.rpc(t.owner, 'close', {task_id: t.task.id});
      }
    });

    await record('A01-vault-matrix', 'Vault：列表、填写、验证码、保存（Hermes 遮盖输入回调位）、外部管理器解锁不可用、来源不符拒绝，普通输出无秘密', async () => {
      const t = await openTask(session, {owner: 'vault-session', origins: [origin], url: origin + '/login', title: `Vault ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const seed = {
        main: {origin, password: 'synthetic-vault-password-2026', otp_secret: 'JBSWY3DPEHPK3PXP'},
        foreign: {origin: otherOrigin, password: 'foreign-secret-2026'},
      };
      const first = await official(t.owner, t.task.id, [
        ['browser_vault_list', {}],
        ['browser_vault_fill', {handle: '$seed:main'}],
        ['browser_vault_enter_code', {handle: '$seed:main'}],
        ['browser_vault_fill', {handle: '$seed:foreign'}],
      ], {seed});
      assert.ok(first[0].items?.length >= 2, JSON.stringify(first[0]));
      assert.equal(first[1].success, true, JSON.stringify(first[1]));
      assert.equal(first[2].success, true, JSON.stringify(first[2]));
      assert.equal(first[3].success, false, JSON.stringify(first[3]));
      assert.match(JSON.stringify(first[3]), /origin_mismatch|vault_item_unavailable/);
      assert.equal(await t.read('document.getElementById("pass").value'), 'synthetic-vault-password-2026', 'foreign item never filled');
      assert.match(await t.read('document.getElementById("code").value'), /^\d{6}$/);
      const second = await official(t.owner, t.task.id, [
        ['browser_vault_list', {}],
        ['browser_vault_save_login', {label: 'Saved fixture'}],
        ['browser_vault_list', {}],
        ['browser_vault_unlock', {backend: 'bitwarden'}],
      ], {prompts: {login: {identifier: 'new-user', password: 'saved-secret-2026'}}});
      const out = [...first, ...second];
      const text = JSON.stringify(out);
      for (const secret of ['synthetic-vault-password-2026', 'foreign-secret-2026', 'saved-secret-2026'])
        assert.ok(!text.includes(secret), 'secret leaked into ordinary output');
      assert.equal(second[1].success, true, JSON.stringify(second[1]));
      assert.equal(second[2].items.length, second[0].items.length + 1, JSON.stringify(second[2]));
      assert.equal(second[3].success, false, JSON.stringify(second[3]));
      // 中文注释：已填写凭据的任务页不能执行页面脚本，拒绝发生在审批面板之前。
      const upgrade = await t.run('js.evaluate', {expression: '1'});
      assert.equal(upgrade.bridgeCode, 'credential_mode_conflict', JSON.stringify(upgrade));
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {unlockExternal: second[3].error_type || second[3].code};
    });

    await record('A01-vault-after-script', '执行过页面脚本的任务页拒绝 Vault 填写', async () => {
      const t = await openTask(session, {owner: 'adv-vault-session', origins: [origin], url: origin + '/login', title: `Adv Vault ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      // 中文注释：首次 JS 调用直接使用浏览器访问，随后核对 Vault 互斥。
      assert.equal((await t.run('js.evaluate', {expression: '1'})).value, 1);
      const out = await official(t.owner, t.task.id, [['browser_vault_fill', {handle: '$seed:main'}]],
        {seed: {main: {origin, password: 'adv-secret-2026'}}});
      assert.equal(out[0].success, false, JSON.stringify(out[0]));
      assert.ok(!JSON.stringify(out).includes('adv-secret-2026'));
      assert.equal(await t.read('document.getElementById("pass").value'), '');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {code: out[0].code || out[0].error_type};
    });

    await record('A01-cross-task-artifact', '文件登记只属于本任务，其他任务引用被拒绝且不选择文件', async () => {
      const a = await openTask(session, {owner: 'file-a', origins: [origin], url: origin + '/login', title: `File A ${browser}`});
      const b = await openTask(session, {owner: 'file-b', origins: [origin], url: origin + '/login', title: `File B ${browser}`});
      const registered = await helperCall('artifact', session.work, 'file-a', a.task.id, origin, 'a.txt', Buffer.from('task-a-only').toString('base64'));
      assert.ok(registered.id, JSON.stringify(registered));
      await b.read(`document.body.insertAdjacentHTML('beforeend','<input type=file id=up aria-label=Up>'),true`);
      const denied = await b.run('files.upload', {selector: '#up', artifact_ids: [registered.id]});
      assert.ok(denied.error, JSON.stringify(denied)); assert.equal(denied.outcome_unknown, false, JSON.stringify(denied));
      assert.equal(await b.read('document.getElementById("up").files.length'), 0);
      for (const t of [a, b]) await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {code: denied.bridgeCode};
    });
  } finally {
    await session.close().catch(error => results.push({id: 'cleanup', requirement: '临时 profile、daemon 与浏览器全部清理', status: 'failed', error: String(error.message).slice(0, 600)}));
  }
  const failed = results.filter(row => row.status !== 'passed');
  const report = {timestamp: new Date().toISOString(), browser, browserVersion: session.version?.Browser, packageFirst: packageMode,
    denominator: results.length, passed: results.length - failed.length, results,
    notClaimed: ['external password manager unlock (1Password/Bitwarden CLIs not installed: explicit unlock failure only)',
      'the human masked prompt UI itself (fixture callbacks registered in Hermes public prompt slots)',
      'payment cards and addresses (not taken over)']};
  console.log(JSON.stringify(report, null, 1));
  if (!only && !failed.length) {
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(path.join(evidenceDir, `official-${browser}${packageMode ? '-package' : ''}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  return failed.length;
}

let failures = 0;
try { for (const browser of browsers) failures += await run(browser); }
finally { server.closeAllConnections(); server.close(); }
if (failures) { console.error(`official failures: ${failures}`); process.exitCode = 1; }
