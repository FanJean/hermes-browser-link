import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountApprovalPanel } from '../../native-extension/approval-panel.mjs';

// These are fixed production assets; loading them keeps the acceptance fixture in sync.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const html = await readFile(new URL('../../native-extension/approval-panel.html', import.meta.url), 'utf8');
// eslint-disable-next-line security/detect-non-literal-fs-filename
const css = await readFile(new URL('../../native-extension/approval-panel.css', import.meta.url), 'utf8');
const extensionUrl = 'chrome-extension://acceptance-test/approval-panel.html';
const makeView = overrides => ({
  id: 'request-1', taskTitle: '整理资料', origin: 'https://example.test',
  action: '点击页面 · #save', scope: '本次操作', expiresAt: Date.now() + 60_000,
  ...overrides,
});

function createPanel({ panelView = makeView(), decide = async message => ({ result: { requestId: message.requestId, decision: message.decision } }), width = 420 } = {}) {
  const dom = new JSDOM(html, { url: extensionUrl });
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const sent = [];
  const clickHandlers = new WeakMap();
  const originalAddEventListener = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && typeof listener === 'function') clickHandlers.set(this, listener);
    return originalAddEventListener.call(this, type, listener, options);
  };
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://acceptance-test/${path}`,
      sendMessage: async message => {
        sent.push(message);
        if (message.type === 'approval_panel_view') return { result: panelView };
        return decide(message);
      },
    },
  };
  return {
    dom, sent, chrome,
    trustedClick(button) {
      const handler = clickHandlers.get(button);
      if (!handler) throw new Error('missing production approval click listener');
      // jsdom cannot create a browser-trusted event; exercise the mounted handler past its trust gate only.
      return handler.call(button, { isTrusted: true, target: button, currentTarget: button });
    },
    close() {
      window.EventTarget.prototype.addEventListener = originalAddEventListener;
      window.close();
    },
  };
}

async function mount(h) {
  await mountApprovalPanel({ document: h.dom.window.document, chrome: h.chrome });
}

test('approval page mounts the production document, announces scope in Chinese, and focuses the primary decision', async () => {
  const h = createPanel();
  try {
    await mount(h);
    const { document } = h.dom.window;
    assert.equal(document.querySelector('#app h1')?.textContent, '等待批准');
    assert.match(document.querySelector('#app').textContent, /任务：整理资料/);
    assert.match(document.querySelector('#app').textContent, /网站：https:\/\/example\.test/);
    assert.deepEqual([...document.querySelectorAll('#app button')].map(button => button.textContent), ['批准本次', '拒绝', '稍后']);
    assert.equal(document.activeElement?.textContent, '批准本次');
    assert.ok([...document.querySelectorAll('#app button')].every(button => button.type === 'button' && button.tabIndex === 0));
  } finally {
    h.close();
  }
});

test('approval page hides decisions for expired or malformed requests', async () => {
  for (const panelView of [makeView({ expiresAt: Date.now() - 1 }), makeView({ origin: 'https://example.test/path' })]) {
    const h = createPanel({ panelView });
    try {
      await mount(h);
      assert.match(h.dom.window.document.querySelector('#app').textContent, /请求已失效或无法核实/);
      assert.equal(h.dom.window.document.querySelectorAll('#app button').length, 0);
    } finally {
      h.close();
    }
  }
});

test('first-site approval names the readable site and keeps writes separately approved',async()=>{
 // 中文注释：目标站点与当前页可能不同，面板须明确列出将获准读取的完整来源。
 const h=createPanel({panelView:makeView({action:'打开网址 · https://other.test/',readOrigin:'https://other.test',scope:'本任务此网站读取'})});
 try{
  await mount(h);
  const body=h.dom.window.document.querySelector('#app').textContent;
  assert.match(body,/任务：整理资料/);
  assert.match(body,/允许读取的网站：https:\/\/other\.test/);
  assert.match(body,/批准后将允许读取该网站页面内容/);
  assert.match(body,/写入和调试命令仍逐项询问/);
 }finally{h.close();}
 const invalid=createPanel({panelView:makeView({readOrigin:'https://other.test/path'})});
 try{await mount(invalid);assert.equal(invalid.dom.window.document.querySelectorAll('#app button').length,0);}finally{invalid.close();}
});

test('approval decision is one-shot, disables choices while pending, and confirms only matching readback', async () => {
  let resolveDecision;
  const decision = new Promise(resolve => { resolveDecision = resolve; });
  const h = createPanel({ decide: () => decision });
  try {
    await mount(h);
    const { document } = h.dom.window;
    const [approve, reject, later] = document.querySelectorAll('#app button');
    approve.click();
    assert.equal(h.sent.filter(message => message.type === 'approval_panel_decision').length, 0, 'untrusted jsdom click cannot decide');

    const pending = h.trustedClick(approve);
    assert.equal(approve.disabled, true);
    assert.equal(reject.disabled, true);
    assert.equal(later.disabled, true);
    assert.equal(document.querySelector('[role="status"]').textContent, '正在核实决定…');
    assert.deepEqual(h.sent.at(-1), { type: 'approval_panel_decision', requestId: 'request-1', decision: 'approve' });
    resolveDecision({ result: { requestId: 'request-1', decision: 'approve' } });
    await pending;
    assert.equal(document.querySelector('[role="status"]').textContent, '决定已发送；请查看任务状态。');
    await h.trustedClick(reject);
    assert.equal(h.sent.filter(message => message.type === 'approval_panel_decision').length, 1);
  } finally {
    h.close();
  }
});

test('approval panel has a narrow-screen, wrapping single-column document structure', async () => {
  const h = createPanel({ width: 320 });
  try {
    await mount(h);
    const { document, innerWidth } = h.dom.window;
    const app = document.querySelector('#app');
    const style = h.dom.window.getComputedStyle(app);
    assert.equal(innerWidth, 320);
    assert.equal(style.maxWidth, '420px');
    assert.equal(style.boxSizing, 'border-box');
    assert.equal(style.display, 'flex');
    assert.equal(style.flexDirection, 'column');
    const copyStyle = h.dom.window.getComputedStyle(document.querySelector('#app p'));
    assert.match(copyStyle.overflowWrap, /anywhere/);
  } finally {
    h.close();
  }
});

test('a sensitive field asks the person to fill it and never shows the model value', async () => {
  const h = createPanel({ panelView: makeView({ kind: 'manual_input', fieldKind: 'password', action: '请亲自填写密码' }) });
  try {
    await mount(h);
    const { document } = h.dom.window;
    assert.equal(document.querySelector('#app h1')?.textContent, '请你亲自填写密码');
    assert.match(document.querySelector('#app').textContent, /不会代填/);
    assert.deepEqual([...document.querySelectorAll('#app button')].map(button => button.textContent), ['我已填写', '不填写', '稍后']);
    await h.trustedClick(document.querySelector('#app button'));
    assert.deepEqual(h.sent.at(-1), { type: 'approval_panel_decision', requestId: 'request-1', decision: 'approve' });
  } finally {
    h.close();
  }
});

test('an unknown field kind is refused rather than shown', async () => {
  const h = createPanel({ panelView: makeView({ kind: 'manual_input', fieldKind: 'bogus' }) });
  try {
    await mount(h);
    assert.match(h.dom.window.document.querySelector('#app').textContent, /请求已失效或无法核实/);
    assert.equal(h.dom.window.document.querySelector('#app button'), null);
  } finally {
    h.close();
  }
});
