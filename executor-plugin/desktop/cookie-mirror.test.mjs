// 中文注释：真实 React/Query 离线验收，不调用浏览器、不批准扩展面板。
import assert from 'node:assert/strict'
import test from 'node:test'
import { setup } from './render-harness.mjs'
const source = 'a'.repeat(32), target = 'b'.repeat(32), transferId = 'c'.repeat(32)
const canary = ['SECRET', 'COOKIE', 'VALUE'].join('_')
const browsers = [
  { instanceId: source, browser: 'chrome', connected: true, features: ['cookie_mirror_v1'] },
  { instanceId: target, browser: 'chrome', connected: true, features: ['cookie_mirror_v1'] },
  { instanceId: 'offline', browser: 'edge', connected: false, features: ['cookie_mirror_v1'] },
  { instanceId: 'old', browser: 'edge', connected: true, features: [] }
]
const state = (status, extra = {}) => ({ transferId, status, source, target, expiresAt: Date.now() / 1000 + 60, sites: [], value: canary, ...extra })
function restWith(mirror) {
  return async (path, options) => {
    if (path === '/shared/browsers') return browsers
    if (path.endsWith('/cookie-sites')) return { value: canary, sites: [
      { site: 'example.com', count: 3, httpOnly: true, session: true, value: canary },
      { site: 'other.test', count: 1, cookies: [{ value: canary }] }
    ] }
    return mirror(path, options)
  }
}
async function openDialog(h) {
  await h.click(h.button('Cookie 镜像'))
  await h.click(h.button('读取 Cookie 站点'))
  const mirror = document.querySelector('li button')
  await h.click(mirror)
  assert.equal(document.querySelector('dialog').open, true)
  await h.change(document.querySelector('select'), target)
}
const noLeak = () => assert.equal(document.documentElement.outerHTML.includes(canary), false)

test('站点搜索、无值列表、同浏览器配置目标排除自身以及两个选项默认关闭', async () => {
  const h = await setup(restWith(async () => { throw Error(canary) }))
  try {
    await openDialog(h)
    assert.deepEqual([...document.querySelectorAll('option')].map(row => row.value), ['', target])
    assert.match(document.body.textContent, /3 个 Cookie · httpOnly · 会话/)
    assert.match(document.querySelector('dialog').textContent, /批准后会把该站点登录态复制到目标浏览器/)
    assert.ok([...document.querySelectorAll('dialog input[type=checkbox]')].every(row => !row.checked))
    await h.click(h.button('取消'))
    await h.change(document.querySelector('input[type=search]'), 'EXAMPLE')
    assert.equal(document.querySelectorAll('li').length, 1)
    await h.change(document.querySelector('input[type=search]'), 'missing')
    assert.match(document.body.textContent, /没有匹配的站点/)
    noLeak()
  } finally { await h.close() }
})

test('多选、持久天数和清除选项通过请求发送；状态只查询同一 ID，不再次发起', async () => {
  let requested = 0, polled = 0
  let phase = 'executing'
  let resolvePost
  const h = await setup(restWith(async (path, options) => {
    if (options?.method === 'POST') {
      requested++
      assert.deepEqual(JSON.parse(JSON.stringify(options.body.sites)), ['example.com', 'other.test'])
      assert.equal(options.body.source, source); assert.equal(options.body.target, target)
      assert.deepEqual(JSON.parse(JSON.stringify(options.body.options)), { clearTarget: true, persistDays: 14 })
      return new Promise(resolve => { resolvePost = resolve })
    }
    assert.equal(path, `/shared/cookie-mirror/${transferId}`)
    polled++
    return state(phase, { success: 2, failed: 1, matched: 1, missing: 1,
      sites: [{ site: 'example.com', reasons: { write_failed: 1, [canary]: canary }, value: canary }] })
  }))
  try {
    await h.click(h.button('Cookie 镜像')); await h.click(h.button('读取 Cookie 站点'))
    for (const box of document.querySelectorAll('li input')) await h.click(box)
    await h.click(h.button('镜像已选站点（2）'))
    await h.change(document.querySelector('select'), target)
    for (const box of document.querySelectorAll('dialog input[type=checkbox]')) await h.click(box)
    await h.change(document.querySelector('input[type=number]'), '0')
    assert.equal(document.querySelector('dialog button:last-child').disabled, true)
    await h.change(document.querySelector('input[type=number]'), '14')
    await h.click(document.querySelector('dialog button:last-child'))
    assert.equal(document.querySelector('dialog button:last-child').disabled, true)
    resolvePost(state('approval_required'))
    await h.tick()
    await h.refetch(['browser-link', 'cookie-mirror', transferId])
    assert.match(document.body.textContent, /复制中/)
    // 中文注释：通过 Query 的同一键刷新模拟轮询；生产轮询间隔由组件设置。
    phase = 'completed'
    await h.refetch(['browser-link', 'cookie-mirror', transferId])
    assert.match(document.body.textContent, /完成：成功 2 \/ 失败 1，回读匹配 1 \/ 缺失 1/)
    assert.match(document.body.textContent, /写入失败 1/)
    await h.click(h.button('收起 Cookie 镜像')); await h.click(h.button('Cookie 镜像'))
    assert.equal(requested, 1); assert.ok(polled >= 2)
    noLeak()
  } finally { await h.close() }
})

test('等待确认、拒绝、过期、断连和查询失败均使用固定提示且不重发', async () => {
  for (const [result, expected, error] of [
    [state('approval_required'), /等待扩展确认.*打开待确认面板/s],
    [state('denied'), /用户拒绝/],
    [state('failed', { reason: 'expired' }), /已过期/],
    [state('failed', { reason: 'disconnected' }), /浏览器已断开/],
    [state('failed', { reason: canary }), /传输失败/],
    [state('preparing', { expiresAt: Date.now() / 1000 - 1 }), /已过期/],
    [state('preparing'), /状态查询失败/, true]
  ]) {
    let posts = 0
    const h = await setup(restWith(async (_path, options) => {
      if (options?.method === 'POST') { posts++; return result }
      if (error) throw Error(canary)
      return result
    }))
    try {
      await openDialog(h); await h.click(document.querySelector('dialog button:last-child'))
      assert.match(document.body.textContent, expected)
      assert.equal(posts, 1)
      noLeak()
    } finally { await h.close() }
  }
})

test('没有目标或请求结果不确定时显示可操作提示，异常金丝雀不进入 HTML', async () => {
  for (const noTarget of [false, true]) {
    let posts = 0
    const rest = restWith(async () => { posts++; throw Error(canary) })
    const h = await setup((path, options) => path === '/shared/browsers' && noTarget ? [browsers[0]] : rest(path, options))
    try {
      await h.click(h.button('Cookie 镜像')); await h.click(h.button('读取 Cookie 站点')); await h.click(document.querySelector('li button'))
      if (noTarget) {
        assert.equal(document.querySelector('dialog button:last-child').disabled, true)
        assert.match(document.body.textContent, /没有其他已连接/)
        assert.equal(posts, 0)
      } else {
        await h.change(document.querySelector('select'), target); await h.click(document.querySelector('dialog button:last-child'))
        assert.match(document.body.textContent, /结果未确认.*不要重复发起/)
        assert.equal(posts, 1)
      }
      noLeak()
    } finally { await h.close() }
  }
})
