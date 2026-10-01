// 中文注释：A02/A03/A06 真实 Chrome/Edge 矩阵验收；逐项记录通过、失败或显式限制，全部达到预期才写证据。
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

const counter = (id, event, extra = '') => `document.getElementById('${id}').addEventListener('${event}',e=>{${extra}document.body.dataset['${id.replaceAll('-', '')}']=String(Number(document.body.dataset['${id.replaceAll('-', '')}']||0)+1)});`;
const matrixPage = `<!doctype html><meta charset="utf-8"><title>matrix</title>
<style>
body{font-family:sans-serif;margin:0;padding:100px 20px 20px}button{margin:6px;padding:8px}
#fixed-header{position:fixed;top:0;left:0;right:0;height:90px;background:#eee;z-index:10}
#nested-scroll{height:120px;overflow:auto;border:1px solid #999;width:320px}#nested-inner{height:900px;position:relative}
#nested-inner button{position:absolute;top:820px}
#virtual{height:160px;overflow:auto;border:1px solid #999;width:320px;position:relative}
#cover-wrap{position:relative;display:inline-block}#cover{position:absolute;inset:0;background:rgba(0,0,0,.2)}
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(160px)}}
.spinning{animation:slide .5s linear infinite alternate}
#scaled-frame{transform:scale(.8);transform-origin:0 0;width:300px;height:120px;border:0}
#rotated-frame{transform:rotate(4deg);width:300px;height:120px;border:0}
#zoomed{zoom:1.5}
</style>
<div id="fixed-header">Header<button id="header-action" style="position:absolute;top:24px;right:60px">Header Action</button></div>
<button id="top-target">Top Target</button>
<button id="visible-button">Visible Button</button>
<div id="nested-scroll"><div id="nested-inner"><button id="deep-scroll">Deep Scroll Button</button></div></div>
<span id="cover-wrap"><button id="covered">Covered Button</button><span id="cover"></span></span>
<button id="pointer-only">Pointer Only</button><button id="trusted-only">Trusted Only</button>
<div><button id="settle">Settling Button</button></div><div><button id="spin" class="spinning">Spinning Button</button></div>
<div role="checkbox" id="mixed" aria-checked="mixed" tabindex="0" aria-label="Mixed Check">Mixed</div>
<div role="switch" id="switch" aria-checked="false" tabindex="0" aria-label="Dark Switch">Switch</div>
<input type="checkbox" id="disabled-check" aria-label="Disabled Check" disabled>
<label><input type="radio" name="size" value="s" id="radio-s" aria-label="Small Size" checked>S</label>
<label><input type="radio" name="size" value="l" id="radio-l" aria-label="Large Size">L</label>
<select id="multi" multiple aria-label="Multi Pick"><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option><option value="d" disabled>丁</option></select>
<select id="dup" aria-label="Dup Label"><option value="1">Same</option><option value="2">Same</option></select>
<button id="lb" role="combobox" aria-controls="lb-list" aria-expanded="false">Custom Pick</button>
<div id="lb-list" role="listbox" hidden><div role="option" data-value="x">X</div><div role="option" data-value="y" aria-disabled="true">Y</div><div role="option" data-value="z">Zed</div><div role="option" data-value="z">Zed Twin</div></div>
<div id="virtual" aria-label="Virtual List"><div id="virtual-pad"></div></div>
<slot-host id="slot-host"><button id="slotted">Slotted Button</button></slot-host>
<div id="nested-shadow-host"></div><div id="closed-host"></div>
<iframe id="same-a" src="/same?n=a" style="height:60px"></iframe><iframe id="same-b" src="/same?n=b" style="height:60px"></iframe>
<iframe id="dyn-frame" src="/dyn" style="height:60px"></iframe>
<iframe id="scaled-frame" src="/scaled"></iframe>
<iframe id="rotated-frame" src="/rotated"></iframe>
<iframe id="cross-scaled" src="http://frame.test:__PORT__/cross-scaled" style="transform:scale(.8);transform-origin:0 0;width:300px;height:120px;border:0"></iframe>
<div id="zoomed"><button id="zoom-button">Zoomed Button</button></div>
<script>
${counter('top-target', 'click')}${counter('visible-button', 'click')}${counter('deep-scroll', 'click', 'document.body.dataset.deepTrusted=String(e.isTrusted);')}
${counter('covered', 'click')}${counter('header-action', 'click', 'document.body.dataset.headerTrusted=String(e.isTrusted);')}${counter('settle', 'click')}${counter('spin', 'click')}${counter('zoom-button', 'click', 'document.body.dataset.zoomTrusted=String(e.isTrusted);')}
let armed=false;document.getElementById('pointer-only').addEventListener('pointerdown',()=>{armed=true});
document.getElementById('pointer-only').addEventListener('pointerup',()=>{if(armed)document.body.dataset.pointeronly=String(Number(document.body.dataset.pointeronly||0)+1);armed=false});
document.getElementById('trusted-only').addEventListener('click',e=>{if(e.isTrusted)document.body.dataset.trustedonly=String(Number(document.body.dataset.trustedonly||0)+1)});
document.getElementById('multi').onchange=e=>{document.body.dataset.multiChanges=String(Number(document.body.dataset.multiChanges||0)+1);document.body.dataset.multiTrusted=String(e.isTrusted)};
for(const id of ['mixed','switch'])document.getElementById(id).addEventListener('click',e=>{const el=e.currentTarget;el.setAttribute('aria-checked',el.getAttribute('aria-checked')==='true'?'false':'true');document.body.dataset[id+'Clicks']=String(Number(document.body.dataset[id+'Clicks']||0)+1)});
document.getElementById('lb').onclick=()=>{const c=document.getElementById('lb'),l=document.getElementById('lb-list');c.setAttribute('aria-expanded','true');l.hidden=false};
for(const o of document.querySelectorAll('#lb-list [role=option]'))o.onclick=e=>{for(const x of document.querySelectorAll('#lb-list [role=option]'))x.removeAttribute('aria-selected');e.currentTarget.setAttribute('aria-selected','true');document.getElementById('lb').dataset.selected=e.currentTarget.dataset.value};
// 中文注释：虚拟列表只挂载可见的少量行，未挂载的行不能被语义快照“找到”。
const rows=2000,rowH=24,v=document.getElementById('virtual'),pad=document.getElementById('virtual-pad');pad.style.height=rows*rowH+'px';
const renderRows=()=>{for(const x of v.querySelectorAll('button'))x.remove();const first=Math.floor(v.scrollTop/rowH);for(let i=first;i<Math.min(rows,first+8);i++){const b=document.createElement('button');b.textContent='Row '+i;b.style.cssText='position:absolute;left:0;margin:0;height:22px;top:'+(i*rowH)+'px';b.onclick=()=>{document.body.dataset.rowClicked=b.textContent};v.append(b)}};
v.addEventListener('scroll',renderRows);renderRows();
customElements.define('slot-host',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<div style="border:1px solid #333;padding:4px"><slot></slot></div>'}});
${counter('slotted', 'click')}
const outer=document.getElementById('nested-shadow-host').attachShadow({mode:'open'});outer.innerHTML='<div id="inner-host"></div>';
const inner=outer.getElementById('inner-host').attachShadow({mode:'open'});inner.innerHTML='<button>Inner Shadow Button</button>';
inner.querySelector('button').onclick=e=>{document.body.dataset.innerShadow=String(Number(document.body.dataset.innerShadow||0)+1);document.body.dataset.innerTrusted=String(e.isTrusted)};
const closed=document.getElementById('closed-host').attachShadow({mode:'closed'});closed.innerHTML='<button>Closed Shadow Button</button><input aria-label="Closed Field">';
closed.querySelector('button').onclick=e=>{document.body.dataset.closedShadow=String(Number(document.body.dataset.closedShadow||0)+1);document.body.dataset.closedTrusted=String(e.isTrusted)};
closed.querySelector('input').onchange=e=>{document.body.dataset.closedField=e.target.value};
</script>`;
const framePage = (label, body = '') => `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:8px}</style><button id="b">${label}</button><p id="s"></p>${body}<script>document.getElementById('b').addEventListener('click',e=>{document.body.dataset.count=String(Number(document.body.dataset.count||0)+1);document.body.dataset.trusted=String(e.isTrusted);document.getElementById('s').textContent='Count '+document.body.dataset.count+' '+(e.isTrusted?'Trusted':'Synthetic')})</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const port = String(server.address().port);
  if (url.pathname === '/same') return res.end(framePage('Same Name'));
  if (url.pathname === '/dyn') return res.end(framePage('Dynamic Frame Button'));
  if (url.pathname === '/scaled') return res.end(framePage('Scaled Frame Button'));
  if (url.pathname === '/rotated') return res.end(framePage('Rotated Frame Button'));
  if (url.pathname === '/cross-scaled') return res.end(framePage('Cross Scaled Button'));
  res.end(matrixPage.replaceAll('__PORT__', port));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const crossOrigin = `http://frame.test:${server.address().port}`;

async function run(browser) {
  const session = await openRealSession({browser, packageMode, hostRules: 'MAP frame.test 127.0.0.1', label: 'mx'});
  const results = [];
  const record = async (id, requirement, fn) => {
    if (only && !id.startsWith(only)) return;
    try { const detail = await fn(); results.push({id, requirement, status: 'passed', ...(detail ? {detail} : {})}); }
    catch (error) { results.push({id, requirement, status: 'failed', error: String(error.message).slice(0, 600)}); }
  };
  try {
    await session.enableFullAccess();
    const t = await openTask(session, {origins: [origin, crossOrigin], url: origin + '/matrix', title: `Matrix ${browser}`});
    await waitFor(() => t.read(`document.readyState==='complete'&&[...document.querySelectorAll('iframe')].every(f=>!f.contentDocument||f.contentDocument.readyState==='complete'&&f.contentDocument.URL!=='about:blank')`));
    const count = key => t.read(`Number(document.body.dataset['${key}']||0)`);
    const scrollState = () => t.read(`JSON.stringify([scrollY,document.getElementById('nested-scroll').scrollTop])`);
    const clicked = (reply, mode = 'dom') => {
      if (mode === 'pointer') assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply));
      else assert.equal(reply.clicked, true, JSON.stringify(reply));
      return reply;
    };
    const denied = (reply, codes) => {
      const text = JSON.stringify(reply);
      assert.ok(reply.error || reply.bridgeCode, 'expected rejection: ' + text);
      assert.ok(codes.some(code => text.toLowerCase().includes(code.toLowerCase())), `expected one of ${codes}: ${text}`);
      assert.equal(reply.outcome_unknown ?? false, false, text);
      return reply.bridgeCode || reply.code;
    };

    // ---------- A03 滚入视口 ----------
    await record('A03-viewport-no-scroll', '已在视口且可操作时不滚动', async () => {
      const before = await scrollState();
      assert.equal((await t.act('ref_click', await t.ref('Visible Button', ['button']))).clicked, true);
      assert.equal(await count('visiblebutton'), 1); assert.equal(await scrollState(), before);
    });
    await record('A03-nested-container', '嵌套滚动容器内目标按最近距离滚入并点击', async () => {
      const before = JSON.parse(await scrollState());
      const reply = await t.act('ref_click', await t.ref('Deep Scroll Button', ['button']));
      assert.equal(reply.clicked, true, JSON.stringify(reply));
      const after = JSON.parse(await scrollState());
      assert.ok(after[1] > 600, 'container scrolled'); assert.equal(after[0], before[0], 'page did not jump');
      assert.equal(await count('deepscroll'), 1);
    });
    await record('A03-fixed-header', '固定页头遮住最近滚动位置时重新定位，不误点页头', async () => {
      await t.read(`window.scrollTo(0,400)`);
      const reply = await t.act('ref_click', await t.ref('Top Target', ['button']));
      assert.equal(reply.clicked, true, JSON.stringify(reply)); assert.equal(await count('toptarget'), 1);
      await t.read(`window.scrollTo(0,0)`);
    });
    await record('A03-occluded', '持续遮挡返回原因，不点击', async () => {
      denied(await t.act('ref_click', await t.ref('Covered Button', ['button'])), ['target_occluded']);
      assert.equal(await count('covered'), 0);
    });
    await record('A03-virtual-list', '虚拟列表未挂载项不假装定位；有上限的容器滚动后找到', async () => {
      const missing = await t.run('semantic_snapshot', {options: {mode: 'interactive', query: 'Row 900', roles: ['button'], budget: 3000}});
      assert.equal(missing.items.filter(item => item.name === 'Row 900').length, 0, 'unmounted row must not be returned');
      const list = await t.ref('Row 0', ['button']);
      let found = null, steps = 0;
      for (; steps < 200 && !found; steps++) {
        const scrolled = await t.act('scroll', list, {direction: 'down'});
        assert.equal(scrolled.scrolled, true, JSON.stringify(scrolled));
        const snap = await t.run('semantic_snapshot', {options: {mode: 'interactive', query: 'Row 900', roles: ['button'], budget: 3000}});
        const hit = snap.items.find(item => item.name === 'Row 900');
        if (hit) found = {binding: snap.binding, snapshot_id: snap.snapshotId, ref: hit.ref};
        else {
          const any = snap.items.length ? snap : await t.run('semantic_snapshot', {options: {mode: 'interactive', query: 'Row', roles: ['button'], budget: 3000}});
          const row = any.items.find(item => /^Row \d+$/.test(item.name));
          Object.assign(list, {binding: any.binding, snapshot_id: any.snapshotId, ref: row.ref});
        }
      }
      assert.ok(found, 'row found within bounded scroll steps');
      // 中文注释：虚拟列表滚入时会重建行节点，旧引用必须如实失效；重新读取后再点一次。
      let reply = await t.run('ref_click', found);
      if (reply.bridgeCode === 'stale_reference') {
        assert.equal(await t.read('document.body.dataset.rowClicked'), undefined);
        reply = await t.act('ref_click', await t.ref('Row 900', ['button']));
      }
      clicked(reply);
      assert.equal(await t.read('document.body.dataset.rowClicked'), 'Row 900');
      return {scrollSteps: steps};
    });

    // ---------- A03 状态控件 ----------
    await record('A03-aria-mixed', 'ARIA 三态 mixed 显式报告，set_checked(true) 回读', async () => {
      const target = await t.ref('Mixed Check', ['checkbox']);
      assert.equal(target.item.checked, 'mixed');
      const reply = await t.act('ref_set_checked', target, {checked: true});
      assert.equal(reply.verified, true, JSON.stringify(reply));
      assert.equal(await t.read(`document.getElementById('mixed').getAttribute('aria-checked')`), 'true');
      const again = await t.act('ref_set_checked', await t.ref('Mixed Check', ['checkbox']), {checked: true});
      assert.equal(again.changed, false); assert.equal(await count('mixedClicks'), 1);
    });
    await record('A03-aria-switch', 'ARIA switch 目标状态操作', async () => {
      const reply = await t.act('ref_set_checked', await t.ref('Dark Switch', ['switch']), {checked: true});
      assert.equal(reply.verified, true, JSON.stringify(reply));
      assert.equal(await t.read(`document.getElementById('switch').getAttribute('aria-checked')`), 'true');
    });
    await record('A03-radio', '单选框选中目标；不通过点击取消单选', async () => {
      const reply = await t.act('ref_set_checked', await t.ref('Large Size', ['radio']), {checked: true});
      assert.equal(reply.verified, true, JSON.stringify(reply));
      assert.equal(await t.read(`document.getElementById('radio-l').checked&&!document.getElementById('radio-s').checked`), true);
      denied(await t.act('ref_set_checked', await t.ref('Large Size', ['radio']), {checked: false}), ['RADIO_CANNOT_UNCHECK']);
      assert.equal(await t.read(`document.getElementById('radio-l').checked`), true);
    });
    await record('A03-disabled-checkbox', '禁用复选框拒绝且不改变状态', async () => {
      const snap = await t.run('semantic_snapshot', {options: {mode: 'interactive', query: 'Disabled Check', budget: 3000}});
      const item = snap.items.find(row => row.name === 'Disabled Check');
      if (!item) return {note: 'disabled control omitted from interactive snapshot'};
      denied(await t.run('ref_set_checked', {binding: snap.binding, snapshot_id: snap.snapshotId, ref: item.ref, checked: true}), ['target_unavailable']);
      assert.equal(await t.read(`document.getElementById('disabled-check').checked`), false);
    });
    await record('A03-native-multi', '原生多选支持中文标签、value、index 与最终状态回读', async () => {
      const multi = await t.ref('Multi Pick', ['listbox']);
      // 中文注释：原生 select 的 change 由状态驱动方式派发；缺失和禁用项在写入前拒绝。
      const chinese = await t.act('ref_select_option', multi, {by: 'label', values: ['甲', '丙']});
      assert.equal(chinese.kind, 'native-select');assert.equal(chinese.verified, true, JSON.stringify(chinese));
      assert.deepEqual(chinese.selectedOptions,[{value:'a',label:'甲',index:0},{value:'c',label:'丙',index:2}]);
      assert.equal(await t.read(`document.body.dataset.multiTrusted`),'false');
      const valued = await t.act('ref_select_option', await t.ref('Multi Pick', ['listbox']), {by: 'value', values: ['b']});
      assert.deepEqual(valued.selectedOptions,[{value:'b',label:'乙',index:1}]);
      const indexed = await t.act('ref_select_option', await t.ref('Multi Pick', ['listbox']), {by: 'index', values: [0,2]});
      assert.equal(indexed.selectedCount,2);assert.equal(await t.read(`[...document.getElementById('multi').selectedOptions].map(o=>o.value).join()`),'a,c');
      denied(await t.act('ref_select_option', await t.ref('Multi Pick', ['listbox']), {by: 'value', values: ['missing']}), ['select_option_missing']);
      denied(await t.act('ref_select_option', await t.ref('Multi Pick', ['listbox']), {by: 'value', values: ['d']}), ['select_option_disabled']);
      assert.equal(await t.read(`document.body.dataset.multiChanges`),'3');
      assert.equal(await t.read(`[...document.getElementById('multi').selectedOptions].map(o=>o.value).join()`), 'a,c', 'no partial change');
    });
    await record('A03-native-duplicate-label', '重复标签歧义拒绝', async () => {
      denied(await t.act('ref_select_option', await t.ref('Dup Label', ['combobox']), {by: 'label', values: ['Same']}), ['SELECT_OPTION_AMBIGUOUS']);
    });
    await record('A03-custom-listbox', '自定义 listbox：禁用、重复、缺失与正常选择回读', async () => {
      denied(await t.act('ref_select_option', await t.ref('Custom Pick', ['combobox']), {by: 'value', values: ['y']}), ['SELECT_OPTION_DISABLED']);
      denied(await t.act('ref_select_option', await t.ref('Custom Pick', ['combobox']), {by: 'value', values: ['z']}), ['SELECT_OPTION_AMBIGUOUS']);
      denied(await t.act('ref_select_option', await t.ref('Custom Pick', ['combobox']), {by: 'value', values: ['nope']}), ['SELECT_OPTION_MISSING']);
      const reply = await t.act('ref_select_option', await t.ref('Custom Pick', ['combobox']), {by: 'value', values: ['x']});
      assert.equal(reply.verified, true, JSON.stringify(reply));assert.equal(reply.kind,'trusted-input');
      assert.equal(await t.read(`document.getElementById('lb').dataset.selected`), 'x');
    });

    // ---------- A06 语义指针 ----------
    await record('A06-pointer-only', '默认引用点击派发可信 pointer 事件', async () => {
      clicked(await t.act('ref_click', await t.ref('Pointer Only', ['button'])));
      assert.equal(await count('pointeronly'), 1, 'default reference click produces pointer events');
      const reply = await t.act('ref_click', await t.ref('Pointer Only', ['button']), {clickMode: 'pointer'});
      assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply)); assert.equal(await count('pointeronly'), 2);
    });
    await record('A06-trusted-only', '检查 isTrusted 的控件：默认引用点击可信', async () => {
      clicked(await t.act('ref_click', await t.ref('Trusted Only', ['button'])));
      assert.equal(await count('trustedonly'), 1);
      clicked(await t.act('ref_click', await t.ref('Trusted Only', ['button']), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('trustedonly'), 2);
    });
    await record('A06-settling-animation', '动画中的目标等待位置稳定后只点击一次', async () => {
      const target = await t.ref('Settling Button', ['button']);
      // 中文注释：用 Web Animations 启动动画，不改 DOM 属性，引用保持有效。
      await t.read(`document.getElementById('settle').animate([{transform:'translateX(0)'},{transform:'translateX(160px)'}],{duration:1600,easing:'ease-out',fill:'forwards'}),true`);
      const reply = await t.act('ref_click', target, {clickMode: 'pointer'});
      assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply)); assert.equal(await count('settle'), 1);
    });
    await record('A06-continuous-animation', '持续移动的目标拒绝，不误点', async () => {
      denied(await t.act('ref_click', await t.ref('Spinning Button', ['button']), {clickMode: 'pointer'}), ['target_unstable']);
      assert.equal(await count('spin'), 0);
    });
    await record('A06-occluded', '遮挡目标的指针点击被拒绝', async () => {
      denied(await t.act('ref_click', await t.ref('Covered Button', ['button']), {clickMode: 'pointer'}), ['target_occluded']);
      assert.equal(await count('covered'), 0);
    });
    await record('A06-nested-scroll', '嵌套滚动容器中的可信指针点击', async () => {
      await t.read(`document.getElementById('nested-scroll').scrollTop=0`);
      const reply = await t.act('ref_click', await t.ref('Deep Scroll Button', ['button']), {clickMode: 'pointer'});
      assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply));
      assert.equal(await count('deepscroll'), 2); assert.equal(await t.read('document.body.dataset.deepTrusted'), 'true');
    });
    await record('A06-under-status-bar', '位于插件状态栏下方的页面目标：派发时状态栏放行，DOM 与指针点击都落在目标上', async () => {
      clicked(await t.act('ref_click', await t.ref('Header Action', ['button'])));
      clicked(await t.act('ref_click', await t.ref('Header Action', ['button']), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('headeraction'), 2); assert.equal(await t.read('document.body.dataset.headerTrusted'), 'true');
    });
    await record('A06-css-zoom', 'CSS zoom 区域内指针点击落点正确', async () => {
      clicked(await t.act('ref_click', await t.ref('Zoomed Button', ['button']), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('zoombutton'), 1); assert.equal(await t.read('document.body.dataset.zoomTrusted'), 'true');
    });
    await record('A06-browser-zoom', '浏览器页面缩放 125% 下指针与 DOM 点击', async () => {
      await session.ui.evaluate(`chrome.tabs.setZoom(${t.tabId},1.25).then(()=>true)`);
      try {
        clicked(await t.act('ref_click', await t.ref('Zoomed Button', ['button']), {clickMode: 'pointer'}), 'pointer');
        assert.equal(await count('zoombutton'), 2);
        clicked(await t.act('ref_click', await t.ref('Visible Button', ['button']), {clickMode: 'pointer'}), 'pointer');
        assert.equal(await count('visiblebutton'), 2);
      } finally { await session.ui.evaluate(`chrome.tabs.setZoom(${t.tabId},1).then(()=>true)`); }
    });

    // ---------- A02 frame / Shadow ----------
    await record('A02-slot', 'slot 分配内容的发现与点击', async () => {
      const target = await t.ref('Slotted Button', ['button'], {composed: true});
      clicked(await t.act('ref_click', target)); assert.equal(await count('slotted'), 1);
      clicked(await t.act('ref_click', await t.ref('Slotted Button', ['button'], {composed: true}), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('slotted'), 2);
    });
    await record('A02-nested-shadow', '嵌套开放 Shadow Root 的 DOM 与指针点击', async () => {
      const target = await t.ref('Inner Shadow Button', ['button'], {composed: true});
      assert.equal(target.item.targetPath.filter(step => step.kind === 'shadow').length, 2, JSON.stringify(target.item.targetPath));
      clicked(await t.act('ref_click', target));
      clicked(await t.act('ref_click', await t.ref('Inner Shadow Button', ['button'], {composed: true}), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('innerShadow'), 2); assert.equal(await t.read('document.body.dataset.innerTrusted'), 'true');
    });
    await record('A02-closed-shadow', '封闭 Shadow Root 经浏览器调试接口发现、点击、填写与回读', async () => {
      const target = await t.ref('Closed Shadow Button', ['button'], {composed: true});
      assert.ok(target.item.targetPath.some(step => step.kind === 'shadow' && step.mode === 'closed'), JSON.stringify(target.item.targetPath));
      clicked(await t.act('ref_click', target));
      clicked(await t.act('ref_click', await t.ref('Closed Shadow Button', ['button'], {composed: true}), {clickMode: 'pointer'}), 'pointer');
      assert.equal(await count('closedShadow'), 2); assert.equal(await t.read('document.body.dataset.closedTrusted'), 'true');
      assert.equal((await t.act('ref_fill', await t.ref('Closed Field', ['textbox'], {composed: true}), {text: 'closed-text'})).filled, true);
      assert.equal(await t.read('document.body.dataset.closedField'), 'closed-text');
    });
    await record('A02-same-name-frames', '两个 frame 中同名目标各自有独立路径，只点击指定一个', async () => {
      const snap = await t.run('semantic_snapshot', {options: {mode: 'interactive', query: 'Same Name', roles: ['button'], composed: true, budget: 3000}});
      assert.equal(snap.items.length, 2, JSON.stringify(snap.items));
      assert.notDeepEqual(snap.items[0].targetPath, snap.items[1].targetPath);
      assert.equal((await t.run('ref_click', {binding: snap.binding, snapshot_id: snap.snapshotId, ref: snap.items[1].ref})).clicked, true);
      assert.equal(await t.read(`[document.getElementById('same-a'),document.getElementById('same-b')].map(f=>f.contentDocument.body.dataset.count||'0').join()`), '0,1');
    });
    await record('A02-dynamic-frame', 'frame 被替换后旧引用失效，新快照可操作', async () => {
      const stale = await t.ref('Dynamic Frame Button', ['button'], {composed: true});
      await t.read(`(()=>{const old=document.getElementById('dyn-frame'),n=document.createElement('iframe');n.id='dyn-frame';n.src='/dyn?v=2';n.style.height='60px';old.replaceWith(n);return new Promise(r=>n.onload=()=>r(true))})()`);
      const reply = await t.act('ref_click', stale);
      assert.ok(reply.error, 'stale frame ref denied: ' + JSON.stringify(reply));
      assert.equal(await t.read(`document.getElementById('dyn-frame').contentDocument.body.dataset.count||'0'`), '0');
      assert.equal((await t.act('ref_click', await t.ref('Dynamic Frame Button', ['button'], {composed: true}))).clicked, true);
      assert.equal(await t.read(`document.getElementById('dyn-frame').contentDocument.body.dataset.count`), '1');
    });
    await record('A02-scaled-frame', '缩放 (scale) 同源 frame 内 DOM 与指针点击', async () => {
      clicked(await t.act('ref_click', await t.ref('Scaled Frame Button', ['button'], {composed: true})));
      const reply = await t.act('ref_click', await t.ref('Scaled Frame Button', ['button'], {composed: true}), {clickMode: 'pointer'});
      assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply));
      assert.equal(await t.read(`document.getElementById('scaled-frame').contentDocument.body.dataset.count`), '2');
      assert.equal(await t.read(`document.getElementById('scaled-frame').contentDocument.body.dataset.trusted`), 'true');
    });
    await record('A02-rotated-frame', '旋转 frame 显式拒绝（坐标映射限制），不点击', async () => {
      denied(await t.act('ref_click', await t.ref('Rotated Frame Button', ['button'], {composed: true}), {clickMode: 'pointer'}), ['UNSUPPORTED_FRAME_TRANSFORM']);
      assert.equal(await t.read(`document.getElementById('rotated-frame').contentDocument.body.dataset.count||'0'`), '0');
      return {limitation: 'rotate/skew transforms on frames are rejected; scale/translate are supported'};
    });
    await record('A02-cross-scaled-frame', '缩放的跨进程 frame 内 DOM 与指针点击', async () => {
      const catalog = await t.run('frame_catalog');
      const frame = catalog.frames.find(item => item.origin === crossOrigin);
      assert.equal(frame?.access, 'ready', JSON.stringify(catalog));
      const snapshot = async () => {
        const snap = await t.run('semantic_snapshot', {options: {frameToken: frame.frameToken, mode: 'interactive', query: 'Cross Scaled Button', budget: 1600}});
        return {binding: snap.binding, snapshot_id: snap.snapshotId, ref: snap.items[0].ref, frame_token: frame.frameToken};
      };
      clicked(await t.run('ref_click', await snapshot()));
      const reply = await t.run('ref_click', {...await snapshot(), clickMode: 'pointer'});
      assert.equal(reply.delivery, 'confirmed', JSON.stringify(reply));
      const effect = await t.run('semantic_snapshot', {options: {frameToken: frame.frameToken, mode: 'content', query: 'Count', budget: 1600}});
      assert.ok(effect.items.some(item => item.name === 'Count 2 Trusted'), JSON.stringify(effect.items.map(item => item.name)));
    });
    // ---------- A04 官方 browser_vision(annotate=true) ----------
    await record('A04-vision-annotate', '截图上绘制 [N] 编号框且与语义引用对应；截图前后目标移动则拒绝', async () => {
      await t.read('window.scrollTo(0,0)');
      const snap = await t.run('semantic_snapshot', {options: {mode: 'interactive', viewport: true, budget: 3000}});
      const labels = snap.items.slice(0, 20).map((item, index) => ({label: index + 1, ref: item.ref}));
      const reply = await helperCall('shared_run', session.work, 'session-a', JSON.stringify({taskId: t.task.id, requestId: t.nextId(), action: 'screenshot', tabId: t.tabId,
        annotate: {binding: snap.binding, snapshotId: snap.snapshotId, labels}}));
      assert.ok(typeof reply.data === 'string' && Array.isArray(reply.annotations) && reply.annotations.length > 0, JSON.stringify(reply).slice(0, 400));
      const visible = reply.annotations.find(row => labels.find(label => label.label === row.label && snap.items[row.label - 1].name === 'Visible Button'));
      assert.ok(visible, 'Visible Button annotated');
      // 中文注释：在扩展页解码 PNG，编号框左上边界像素应为标注色。
      const border = await session.ui.evaluate(`(async()=>{const img=await createImageBitmap(await (await fetch('data:image/png;base64,${reply.data}')).blob());
        const c=new OffscreenCanvas(img.width,img.height),x=c.getContext('2d');x.drawImage(img,0,0);
        const vw=${JSON.stringify(await t.read('innerWidth'))},s=img.width/vw;
        return [...x.getImageData(Math.round((${visible.x}+${visible.width}/2)*s),Math.round(${visible.y}*s),1,1).data]})()`);
      assert.ok(border[0] > 180 && border[1] < 80, 'label border drawn: ' + JSON.stringify(border));
      const unknown = await helperCall('shared_run', session.work, 'session-a', JSON.stringify({taskId: t.task.id, requestId: t.nextId(), action: 'screenshot', tabId: t.tabId,
        annotate: {binding: snap.binding, snapshotId: snap.snapshotId, labels: [{label: 1, ref: 'x', extra: 1}]}}));
      assert.equal(unknown.errorCode, 'invalid_params', JSON.stringify(unknown));
      return {annotated: reply.annotations.length};
    });
    await t.run('semantic_snapshot', {options: {mode: 'interactive', budget: 800}});
    await session.rpc('session-a', 'close', {task_id: t.task.id});
  } finally {
    // 中文注释：清理失败同样计为未通过，但先保留已得到的逐项结果。
    await session.close().catch(error => results.push({id: 'cleanup', requirement: '临时 profile、daemon 与浏览器全部清理', status: 'failed', error: String(error.message).slice(0, 600)}));
  }
  const failed = results.filter(row => row.status !== 'passed');
  const report = {timestamp: new Date().toISOString(), browser, browserVersion: session.version?.Browser, packageFirst: packageMode,
    denominator: results.length, passed: results.length - failed.length, results};
  console.log(JSON.stringify(report, null, 1));
  if (!only && !failed.length) {
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(path.join(evidenceDir, `matrix-${browser}${packageMode ? '-package' : ''}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  return failed.length;
}

let failures = 0;
try { for (const browser of browsers) failures += await run(browser); }
finally { server.closeAllConnections(); server.close(); }
if (failures) { console.error(`matrix failures: ${failures}`); process.exitCode = 1; }
