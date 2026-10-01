// 中文注释：A05 真实 Chrome/Edge 中断与恢复验收：敏感字段人工等待、Python 退出后协作续跑、响应丢失、daemon/浏览器重启、竞争恢复与撤销。
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

let slowHits = 0;
const page = `<!doctype html><meta charset="utf-8"><title>ledger</title>
<button id="ledger">Ledger Button</button><input id="field" aria-label="Ledger Field"><input id="password" type="password" aria-label="Password"><p id="status">Idle</p>
<script>
document.getElementById('ledger').onclick=()=>{document.body.dataset.count=String(Number(document.body.dataset.count||0)+1);document.getElementById('status').textContent='Clicked '+document.body.dataset.count};
document.getElementById('field').onchange=e=>{document.body.dataset.field=e.target.value};
</script>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 中文注释：慢页面让导航在 daemon 被终止时仍处于在途状态；服务器计数证明是否被重放。
  if (req.url.startsWith('/slow')) { slowHits++; setTimeout(() => res.end('<!doctype html><title>slow</title><p>Slow Loaded</p>'), 2500); return; }
  res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function run(browser) {
  const session = await openRealSession({browser, packageMode, label: 'rc'});
  const results = [];
  const record = async (id, requirement, fn) => {
    if (only && !id.startsWith(only)) return;
    try { const detail = await fn(); results.push({id, requirement, status: 'passed', ...(detail ? {detail} : {})}); }
    catch (error) { results.push({id, requirement, status: 'failed', error: String(error.message).slice(-1500)}); }
  };
  const script = (owner, taskId, code, checkpoint = null) =>
    helperCall('script', session.work, owner, taskId, code, checkpoint ? JSON.stringify(checkpoint) : '');
  const parse = reply => {
    const line = String(reply.stdout || '').split('\n').filter(row => row.startsWith('RESULT=')).at(-1);
    assert.ok(line, JSON.stringify(reply).slice(-1400));
    return JSON.parse(line.slice(7));
  };
  const killDaemon = async () => {
    const pid = JSON.parse((await helperCall('kill_daemon', session.work)).stdout).pid;
    await waitFor(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, 10000);
    return pid;
  };
  const resumeReady = async (owner, taskId) => {
    // 中文注释：daemon 或浏览器重启后先等扩展重新连上，再由 Hermes 显式请求恢复。
    await session.instance();
    const resumed = await session.rpc(owner, 'resume', {task_id: taskId});
    assert.ok(!resumed.error, JSON.stringify(resumed));
    return waitFor(async () => { const current = await session.rpc(owner, 'get', {task_id: taskId}); return current.state === 'ready' ? current : null; }, 30000);
  };
  try {
    await session.enableFullAccess();

    await record('A05-R1-manual-input-wait', '脚本在同一 Python 栈内等待敏感字段人工填写，用户完成或拒绝后继续', async () => {
      for (const decision of ['approve', 'reject']) {
        const t = await openTask(session, {owner: `r1-${decision}`, origins: [origin], url: origin + '/', title: `R1 ${decision} ${browser}`});
        await waitFor(() => t.read(`document.readyState==='complete'`));
        const running = script(t.owner, t.task.id, `import json
try:
    fill_element('Password', 'must-not-be-typed')
    waited = 'no-wait'
except UserInputRequired:
    try:
        receipt = wait_pending(120)
        waited = 'filled-after-wait' if receipt.get('filledBy') == 'user' else 'unexpected-receipt'
    except BrowserError as exc:
        waited = 'rejected:' + str(getattr(exc, 'code', ''))
print('RESULT=' + json.dumps({'waited': waited}))`);
        // 中文注释：测试通过页面调试端口模拟用户手工填写，扩展仅确认“我已填写”。
        if (decision === 'approve') await t.read(`document.getElementById('password').value='typed-by-person'`);
        await session.approvePanel(decision, '请你亲自填写密码');
        const out = parse(await running);
        if (decision === 'approve') {
          assert.equal(out.waited, 'filled-after-wait', JSON.stringify(out));
          assert.equal(await t.read('document.getElementById("password").value'), 'typed-by-person');
        } else {
          assert.ok(out.waited.startsWith('rejected'), JSON.stringify(out));
          assert.equal(await t.read('document.getElementById("password").value'), '');
        }
        await session.rpc(t.owner, 'close', {task_id: t.task.id});
      }
    });

    await record('A05-R3-python-exit', 'Python 进程退出后由 Hermes 显式检查点续跑：核实已确认步骤，不重放', async () => {
      const t = await openTask(session, {origins: [origin], url: origin + '/', title: `R3 ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const first = parse(await script(t.owner, t.task.id, `import json
click_element('Ledger Button')
print('RESULT=' + json.dumps(operation_status()))`));
      assert.equal(first.state, 'confirmed', JSON.stringify(first)); assert.equal(first.dispatched, true);
      const second = parse(await script(t.owner, t.task.id, `import json
cp = load_checkpoint()
st = operation_status(cp['requestId'])
if st['state'] == 'confirmed' and cp['step'] == 1:
    fill_element('Ledger Field', 'step-2')
print('RESULT=' + json.dumps({'checkpoint': cp, 'prior': st}))`, {requestId: first.requestId, step: 1}));
      assert.equal(second.prior.state, 'confirmed'); assert.equal(second.checkpoint.step, 1);
      assert.equal(await t.read('document.body.dataset.count'), '1', 'first step not replayed');
      assert.equal(await t.read('document.body.dataset.field'), 'step-2');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
    });

    await record('A05-response-lost-daemon', '动作已派发但 daemon 崩溃丢失响应：同一请求不重放，账本报告已派发', async () => {
      const t = await openTask(session, {owner: 'lost-session', origins: [origin], url: origin + '/', title: `Lost ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const before = slowHits, requestId = t.nextId();
      const inflight = t.run('navigate', {url: origin + '/slow'}, requestId);
      await waitFor(async () => slowHits > before, 10000);
      await killDaemon();
      const lost = await inflight;
      assert.ok(lost.error, JSON.stringify(lost)); assert.equal(lost.outcome_unknown, true, JSON.stringify(lost));
      // 中文注释：新 daemon 从持久账本恢复；任务进入需同步状态，同一请求编号不能再次派发。
      const replay = await t.run('navigate', {url: origin + '/slow'}, requestId);
      assert.ok(replay.error, JSON.stringify(replay));
      assert.equal(slowHits, before + 1, 'lost navigation is never replayed');
      const current = await waitFor(async () => { const reply = await session.rpc(t.owner, 'get', {task_id: t.task.id}); return reply.state ? reply : null; }, 45000);
      assert.equal(current.state, 'needs_sync', JSON.stringify(current));
      await resumeReady(t.owner, t.task.id);
      const status = parse(await script(t.owner, t.task.id, `import json
print('RESULT=' + json.dumps(operation_status(${JSON.stringify(requestId)})))`));
      assert.equal(status.dispatched, true, JSON.stringify(status)); assert.ok(['unknown', 'dispatched'].includes(status.state), JSON.stringify(status));
      const replayAfterResume = await t.run('navigate', {url: origin + '/slow'}, requestId);
      assert.equal(replayAfterResume.bridgeCode, 'request_outcome_unavailable', JSON.stringify(replayAfterResume));
      assert.equal(slowHits, before + 1);
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {ledgerState: status.state, ledgerGeneration: status.generation};
    });

    await record('A05-R2-same-process-reconnect', 'Python 仍存活时连接中断：reconnect 等待新代次，旧引用与在途请求不续用，只在新工作页继续', async () => {
      let stage = 'open-task';
      try {
      const t = await openTask(session, {owner: 'r2-session', origins: [origin], url: origin + '/', title: `R2 ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      stage = 'script-first-click';
      const running = script(t.owner, t.task.id, `import json, time
click_element('Ledger Button')
before = operation_status()
states = []
deadline = time.time() + 90
while time.time() < deadline:
    st = reconnect(5)
    states.append(st.get('state'))
    if st.get('state') == 'ready' and st.get('requiresReconciliation'):
        break
    time.sleep(0.5)
rec = reconcile()
tab = new_tab(${JSON.stringify(origin + '/?after=1')})
time.sleep(3)
try:
    fill_element('Ledger Field', 'after-reconnect')
except BrowserError as exc:
    print('RESULT=' + json.dumps({'fillError': getattr(exc, 'code', None), 'final': st}))
    raise SystemExit(0)
print('RESULT=' + json.dumps({'before': before, 'states': states[-3:], 'final': st, 'reconciled': rec, 'tab': tab}))`);
      await waitFor(() => t.read(`document.body.dataset.count==='1'`), 60000);
      stage = 'daemon-restart';
      await killDaemon();
      await new Promise(resolve => setTimeout(resolve, 1000));
      stage = 'needs-sync';
      await waitFor(async () => (await session.rpc(t.owner, 'get', {task_id: t.task.id})).state === 'needs_sync', 30000);
      stage = 'resume-ready';
      await resumeReady(t.owner, t.task.id);
      // 中文注释：无头浏览器只为前台页绘制高亮；脚本新建工作页后把它切到前台。
      stage = 'new-tab';
      const newTabId = await waitFor(async () => (await session.rpc(t.owner, 'get', {task_id: t.task.id})).tabIds?.find(id => id !== t.tabId), 90000);
      await session.ui.evaluate(`chrome.tabs.update(${newTabId},{active:true}).then(()=>true)`);
      stage = 'script-result';
      const out = parse(await running);
      assert.equal(out.fillError, undefined, JSON.stringify(out));
      assert.equal(out.before.state, 'confirmed'); assert.equal(out.final.state, 'ready');
      assert.equal(out.final.requiresReconciliation, true, 'new generation freezes unknown state until reconciled');
      assert.equal(await session.readUrl(url => url === origin + '/', 'document.body.dataset.count'), '1', 'click not replayed on the old page');
      const current = await session.rpc(t.owner, 'get', {task_id: t.task.id});
      const newTab = current.tabIds?.find(id => id !== t.tabId);
      assert.ok(Number.isInteger(newTab), JSON.stringify(current));
      assert.equal(await session.readUrl('/?after=1', 'document.body.dataset.field'), 'after-reconnect');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {observedStates: out.states};
      } catch (error) {
        // 中文注释：恢复链有多处等待；失败证据标明阶段，便于区分连接与页面问题。
        error.message += ` stage=${stage}`;
        throw error;
      }
    });

    await record('A05-resume-race', '两个恢复请求竞争只有一个成功；恢复后立即撤销使后续动作被拒', async () => {
      const t = await openTask(session, {owner: 'race-session', origins: [origin], url: origin + '/', title: `Race ${browser}`});
      await session.rpc(t.owner, 'cancel', {task_id: t.task.id});
      const [a, b] = await Promise.all([session.rpc(t.owner, 'resume', {task_id: t.task.id}), session.rpc(t.owner, 'resume', {task_id: t.task.id})]);
      const winners = [a, b].filter(reply => !reply.error);
      assert.equal(winners.length, 1, JSON.stringify([a, b]));
      assert.ok([a, b].some(reply => reply.error), JSON.stringify([a, b]));
      await waitFor(async () => (await session.rpc(t.owner, 'get', {task_id: t.task.id})).state === 'ready', 30000);
      const cancelled = await session.rpc(t.owner, 'cancel', {task_id: t.task.id});
      assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
      const denied = await t.run('semantic_snapshot', {options: {mode: 'interactive', budget: 800}});
      assert.ok(denied.error, 'cancelled generation cannot act: ' + JSON.stringify(denied));
      const stale = await session.rpc(t.owner, 'run', {task_id: t.task.id, request_id: t.nextId(), action: 'ref_click', tab_id: t.tabId,
        binding: {taskId: t.task.id, documentId: 'x', leaseId: 'x'}, snapshot_id: 'x', ref: 'x'});
      assert.ok(stale.error); assert.equal(stale.outcome_unknown, false, JSON.stringify(stale));
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
    });

    await record('A05-foreign-resume', '其他会话不能恢复或查询本任务', async () => {
      const t = await openTask(session, {owner: 'own-session', origins: [origin], url: origin + '/', title: `Own ${browser}`});
      await session.rpc(t.owner, 'cancel', {task_id: t.task.id});
      const foreign = await session.rpc('intruder-session', 'resume', {task_id: t.task.id});
      assert.ok(foreign.error, JSON.stringify(foreign));
      assert.equal((await session.rpc(t.owner, 'get', {task_id: t.task.id})).state, 'cancelled');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
    });

    await record('A05-browser-restart', '浏览器重启：任务需同步，旧整数 tabId 不被复用，恢复后在新代次新工作页继续', async () => {
      const t = await openTask(session, {owner: 'restart-session', origins: [origin], url: origin + '/', title: `Restart ${browser}`});
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const clicked = await t.act('ref_click', await t.ref('Ledger Button', ['button']));
      assert.equal(clicked.clicked, true, 'before restart ' + JSON.stringify(clicked));
      const generation = (await session.rpc(t.owner, 'get', {task_id: t.task.id})).generation;
      await session.restartBrowser();
      await waitFor(async () => (await session.rpc(t.owner, 'get', {task_id: t.task.id})).state === 'needs_sync', 40000);
      const oldTab = await t.run('semantic_snapshot', {options: {mode: 'interactive', budget: 800}});
      assert.ok(oldTab.error, 'old tab id refused before resume: ' + JSON.stringify(oldTab));
      const ready = await resumeReady(t.owner, t.task.id);
      assert.ok(ready.generation > generation, JSON.stringify(ready));
      assert.deepEqual(ready.tabIds, [], 'no guessed tab after restart');
      const stillOld = await t.run('semantic_snapshot', {options: {mode: 'interactive', budget: 800}});
      assert.ok(stillOld.error, 'old integer tab id not reused: ' + JSON.stringify(stillOld));
      const opened = await session.rpc(t.owner, 'run', {task_id: t.task.id, request_id: t.nextId(), action: 'new_tab', url: origin + '/'});
      assert.ok(Number.isInteger(opened.tabId), JSON.stringify(opened));
      t.tabId = opened.tabId;
      // 中文注释：重启后的新工作页需在前台，高亮确认才能完成绘制。
      await session.ui.evaluate(`chrome.tabs.update(${opened.tabId},{active:true}).then(()=>true)`);
      await waitFor(() => t.read(`document.readyState==='complete'`));
      const after = await t.act('ref_click', await t.ref('Ledger Button', ['button']));
      assert.equal(after.clicked, true, 'after restart ' + JSON.stringify(after));
      assert.equal(await t.read('document.body.dataset.count'), '1');
      await session.rpc(t.owner, 'close', {task_id: t.task.id});
      return {generationBefore: generation, generationAfter: ready.generation};
    });
  } finally {
    // 中文注释：清理失败同样计为未通过，但先保留已得到的逐项结果。
    await session.close().catch(error => results.push({id: 'cleanup', requirement: '临时 profile、daemon 与浏览器全部清理', status: 'failed', error: String(error.message).slice(0, 600)}));
  }
  const failed = results.filter(row => row.status !== 'passed');
  const report = {timestamp: new Date().toISOString(), browser, browserVersion: session.version?.Browser, packageFirst: packageMode,
    denominator: results.length, passed: results.length - failed.length, results,
    notClaimed: ['R4 arbitrary Python process-state restoration (stack, threads, sockets, external side effects) remains a research item']};
  console.log(JSON.stringify(report, null, 1));
  if (!only && !failed.length) {
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(path.join(evidenceDir, `recovery-${browser}${packageMode ? '-package' : ''}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  return failed.length;
}

let failures = 0;
try { for (const browser of browsers) failures += await run(browser); }
finally { server.closeAllConnections(); server.close(); }
if (failures) { console.error(`recovery failures: ${failures}`); process.exitCode = 1; }
