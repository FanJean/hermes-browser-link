import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('../../native-extension/popup.html', import.meta.url), 'utf8')
const css = await readFile(new URL('../../native-extension/popup.css', import.meta.url), 'utf8')

test('弹窗入口保留中文状态语义与键盘可聚焦的授权开关', () => {
  // 中文注释：检查实际生产 HTML，不使用另一份测试模板。
  const dom = new JSDOM(html)
  const document = dom.window.document
  assert.equal(document.documentElement.lang, 'zh-CN')
  assert.equal(document.querySelector('#connection-label').getAttribute('aria-live'), 'polite')
  assert.equal(document.querySelector('#access-toggle').getAttribute('role'), 'switch')
  assert.equal(document.querySelector('#access-toggle').tagName, 'BUTTON')
  assert.equal(document.querySelector('#tasks,#verify-control,#task-list'), null)
  assert.equal(document.querySelector('#access-toggle').closest('details'),null)
  // 中文注释：设置直接展示，主要链接仅在桌面页操作。
  assert.equal(document.querySelector('#filter-toggle').closest('details'),null)
  // 中文注释：常用鼠标固定启用，镜像入口只放桌面，额外区域不在浏览器弹窗显示。
  assert.equal(document.querySelector('#cursor-toggle,#cookie-mirror,#shield-settings'),null)
  assert.ok(document.querySelector('.header-meta #version-label'))
  assert.equal(document.querySelector('#browser-links,#set-primary,details.settings'),null)
  assert.equal(document.querySelector('#diagnostics'), null)
  assert.match(css, /:focus-visible/)
  dom.window.close()
})
