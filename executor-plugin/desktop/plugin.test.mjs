// 中文注释：保留浏览器授权入口的在途去重和状态读回回归。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { load, content } from './test-harness.mjs'

test('SDK contribution remains opt-in and uses the original route identity', async () => {
  const h = await load()
  assert.equal(h.context.plugin.id, 'browser-link')
  assert.equal(h.context.plugin.defaultEnabled, false)
  assert.deepEqual(h.registrations.map(row => row.area), ['routes', 'nav', 'palette'])
  assert.equal(h.registrations[0].data.path, '/browser-link')
})

function browserRow(nodes, instanceId) {
  const start = nodes.findIndex(node => node.props?.['data-browser-id'] === instanceId)
  assert.notEqual(start, -1, `browser row ${instanceId} exists`)
  const end = nodes.findIndex((node, index) => index > start && node.props?.['data-browser-id'] !== undefined)
  return nodes.slice(start, end === -1 ? undefined : end)
}

function rowButton(row, label) {
  return row.find(node => node.type === 'button' && node.props.children === label)
}

test('browser rows keep consent actions without an expanding help block', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'closed', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true },
    { instanceId: 'open', browser: 'edge', connected: true, consentStatus: 'enabled', accessRequestSupported: true },
    { instanceId: 'unknown', browser: 'chrome', connected: true, consentStatus: 'unknown', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } })
  const nodes = h.render('BrowserWork', {})
  assert.equal(rowButton(browserRow(nodes, 'closed'), '切换模式')?.props.disabled, false)
  assert.equal(rowButton(browserRow(nodes, 'open'), '切换模式')?.props.disabled, false)
  assert.equal(rowButton(browserRow(nodes, 'unknown'), '查看模式')?.props.disabled, false)
  assert.doesNotMatch(content(nodes), /按钮只会请求扩展打开授权确认页面|授权会持续用于后续工作页/)
})

test('主要链接由桌面按钮显式设置并读回',async()=>{
  const h=await load({browsers:{data:[
    {instanceId:'edge-1',browser:'edge',connected:true,consentStatus:'enabled',primary:false},
    {instanceId:'chrome-1',browser:'chrome',connected:true,consentStatus:'enabled',primary:true}
  ],dataUpdatedAt:Date.now()}},async()=>({instanceId:'edge-1',browser:'edge'}))
  const nodes=h.render('BrowserWork',{})
  assert.match(content(nodes),/主要链接/)
  assert.equal(rowButton(browserRow(nodes,'chrome-1'),'设为主要链接'),undefined)
  await rowButton(browserRow(nodes,'edge-1'),'设为主要链接').props.onClick()
  assert.equal(h.calls[0][0],'/shared/browsers/edge-1/primary')
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][1])),{method:'POST',body:{}})
})

test('access request opens only the extension confirmation flow once and waits for list polling', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'profile/one', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => ({ requestId: 'open-request', status: 'confirmation_requested' }))
  const nodes = h.render('BrowserWork', {})
  const enable = rowButton(browserRow(nodes, 'profile/one'), '切换模式')
  // Two clicks while the first call is in flight coalesce into one request.
  await Promise.all([enable.props.onClick(), enable.props.onClick()])
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], '/shared/browsers/profile%2Fone/access-request')
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][1])), { method: 'POST', body: {} })
  const refreshedNodes = h.render('BrowserWork', {})
  const refreshedView = content(refreshedNodes)
  assert.match(refreshedView, /确认页已打开/)
  assert.doesNotMatch(refreshedView, /全部访问.*成功/)
  // Rendering and polling never resend; only a new explicit click does.
  h.render('BrowserWork', {})
  assert.equal(h.calls.length, 1)
  const again = rowButton(browserRow(refreshedNodes, 'profile/one'), '确认页已打开')
  assert.equal(again.props.disabled, false)
  await again.props.onClick()
  assert.equal(h.calls.length, 2)
})

test('legacy, disconnected, stale, and malformed browser identities cannot write access requests', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'legacy', browser: 'chrome', connected: true },
    { instanceId: 'offline', browser: 'edge', connected: false, consentStatus: 'disabled', accessRequestSupported: true },
    { instanceId: 42, browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } })
  const nodes = h.render('BrowserWork', {})
  const legacy = browserRow(nodes, 'legacy')
  assert.equal(rowButton(legacy, '查看模式'), undefined)
  assert.match(content(nodes), /请在浏览器扩展弹窗中查看权限模式/)
  assert.equal(rowButton(browserRow(nodes, 'offline'), '切换模式')?.props.disabled, true)
  assert.equal(rowButton(browserRow(nodes, 42), '切换模式')?.props.disabled, true)
  await rowButton(browserRow(nodes, 'offline'), '切换模式')?.props.onClick()
  assert.equal(h.calls.length, 0)

  const stale = await load({ browsers: { data: [
    { instanceId: 'stale', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() - 16000 } })
  const staleNodes = stale.render('BrowserWork', {})
  assert.match(content(staleNodes), /本地桥接不可用/)
  assert.equal(staleNodes.some(node => node.props?.['data-browser-id'] === 'stale'), false)
  assert.equal(stale.calls.length, 0)
})

test('an unknown access-request response is not retried and stays explicitly uncertain', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'uncertain', browser: 'edge', connected: true, consentStatus: 'unknown', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => { throw new Error('network timeout') })
  const nodes = h.render('BrowserWork', {})
  const inspect = rowButton(browserRow(nodes, 'uncertain'), '查看模式')
  await Promise.all([inspect.props.onClick(), inspect.props.onClick()])
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], '/shared/browsers/uncertain/access-request')
  const refreshedNodes = h.render('BrowserWork', {})
  const refreshedView = content(refreshedNodes)
  assert.match(refreshedView, /状态待确认/)
  h.render('BrowserWork', {})
  assert.equal(h.calls.length, 1, 'an uncertain result is never resent automatically')
  // A later explicit click is a new request; the bridge still answers
  // `unknown` for the uncertain prompt until its window ends.
  await rowButton(browserRow(refreshedNodes, 'uncertain'), '状态待确认').props.onClick()
  assert.equal(h.calls.length, 2)
})

test('unknown access-request status never claims the confirmation page opened', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'unknown-status', browser: 'edge', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => ({ requestId: 'unknown-request', status: 'unknown' }))
  const nodes = h.render('BrowserWork', {})
  await rowButton(browserRow(nodes, 'unknown-status'), '切换模式').props.onClick()
  const view = content(h.render('BrowserWork', {}))
  assert.match(view, /状态待确认/)
  assert.doesNotMatch(view, /授权确认页已打开|请在浏览器中确认/)
  assert.equal(h.calls.length, 1, 'an unknown status is not resent automatically')
})

test('already-requested status does not claim that the confirmation page is still open', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'already', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => ({ requestId: 'prior-request', status: 'already_requested' }))
  const nodes = h.render('BrowserWork', {})
  await rowButton(browserRow(nodes, 'already'), '切换模式').props.onClick()
  const view = content(h.render('BrowserWork', {}))
  assert.match(view, /查看确认页/)
  assert.doesNotMatch(view, /授权确认页已打开|请在浏览器中确认/)
})

test('expired access-request status says the current call did not open a new page', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'expired', browser: 'edge', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => ({ requestId: 'expired-request', status: 'expired' }))
  const nodes = h.render('BrowserWork', {})
  await rowButton(browserRow(nodes, 'expired'), '切换模式').props.onClick()
  const view = content(h.render('BrowserWork', {}))
  assert.match(view, /重新请求/)
  assert.doesNotMatch(view, /授权确认页已打开|请在浏览器中确认/)
  assert.equal(h.calls.length, 1, 'expiry is not followed by an automatic request')
  const retry = rowButton(browserRow(h.render('BrowserWork', {}), 'expired'), '重新请求')
  assert.equal(retry.props.disabled, false)
  await retry.props.onClick()
  assert.equal(h.calls.length, 2)
})

test('confirmation_requested with an empty requestId is treated as a malformed response', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'bad-id', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() } }, async () => ({ requestId: '', status: 'confirmation_requested' }))
  const nodes = h.render('BrowserWork', {})
  await rowButton(browserRow(nodes, 'bad-id'), '切换模式').props.onClick()
  const view = content(h.render('BrowserWork', {}))
  assert.match(view, /状态待确认/)
  assert.doesNotMatch(view, /授权确认页已打开|请在浏览器中确认/)
})

test('access action stays disabled while a request is in flight even if polling changes consent state', async () => {
  let resolveRequest
  const browsers = { data: [
    { instanceId: 'pending', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true }
  ], dataUpdatedAt: Date.now() }
  const h = await load({ browsers }, () => new Promise(resolve => { resolveRequest = resolve }))
  const before = h.render('BrowserWork', {})
  const pendingRequest = rowButton(browserRow(before, 'pending'), '切换模式').props.onClick()
  browsers.data[0].consentStatus = 'enabled'
  browsers.dataUpdatedAt = Date.now()
  const during = h.render('BrowserWork', {})
  assert.equal(rowButton(browserRow(during, 'pending'), '切换模式')?.props.disabled, true)
  resolveRequest({})
  await pendingRequest
})
