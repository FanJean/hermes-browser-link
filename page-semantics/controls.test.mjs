import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from './index.js';

function fixture(html) {
  const dom = new JSDOM(html);
  // 中文注释：合成布局仅用于语义契约，不能作为真实浏览器可点击验收。
  dom.window.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const semantics = createPageSemantics({document: dom.window.document, taskId: 'task', documentId: 'doc', leaseId: 'lease'});
  return {document: dom.window.document, semantics, close() {semantics.revoke(); dom.window.close();}};
}

test('无标签输入框使用占位提示，标签优先且不返回已填写值', () => {
  const f = fixture('<input placeholder="搜索订单" value="PRIVATE_VALUE"><label>姓名<input placeholder="忽略提示" value="OTHER_PRIVATE"></label>');
  try {
    const page = f.semantics.snapshot();
    assert.equal(page.items[0].name, '搜索订单');
    assert.equal(page.items[0].nameSource, 'placeholder');
    assert.equal(page.items[1].name, '姓名');
    assert.equal(page.items[1].nameSource, undefined);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  } finally {f.close();}
});

test('状态解析支持禁用 fieldset、ARIA 三态、展开和忙碌，同文档状态变更可重定位', () => {
  const f = fixture('<fieldset disabled><button>保存</button></fieldset><div role="checkbox" aria-checked="mixed">范围</div><button aria-expanded="false" aria-busy="true">更多</button>');
  try {
    const page = f.semantics.snapshot();
    assert.equal(page.items[0].disabled, true);
    assert.equal(page.items[1].checked, 'mixed');
    assert.equal(page.items[2].expanded, false);
    assert.equal(page.items[2].busy, true);
    f.document.querySelector('[aria-expanded]').setAttribute('aria-expanded', 'true');
    assert.equal(f.semantics.resolve({...page.binding, snapshotId: page.snapshotId, ref: page.items[2].ref}).textContent,'更多');
    assert.equal(f.semantics.relocation(),true);
  } finally {f.close();}
});

test('占位提示中的标记秘密仍脱敏', () => {
  const f = fixture('<input placeholder="token=PRIVATE_TOKEN">');
  try {assert.doesNotMatch(JSON.stringify(f.semantics.snapshot()), /PRIVATE_TOKEN/);}
  finally {f.close();}
});
