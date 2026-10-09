// 中文注释：连接面板只展示读回授权，保留主要链接与失联保护回归。
import assert from 'node:assert/strict'
import test from 'node:test'
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

test('连接面板不提供模式切换或操作授权按钮', async () => {
  const h = await load({ browsers: { data: [
    { instanceId: 'closed', browser: 'chrome', connected: true, consentStatus: 'disabled', accessRequestSupported: true },
    { instanceId: 'open', browser: 'edge', connected: true, consentStatus: 'enabled', accessRequestSupported: true },
    { instanceId: 'unknown', browser: 'chrome', connected: true, consentStatus: 'unknown', accessRequestSupported: true },
    { instanceId: 'offline', browser: 'edge', connected: false, consentStatus: 'enabled' }
  ], dataUpdatedAt: Date.now() } })
  const nodes = h.render('BrowserWork', {})
  assert.match(content(browserRow(nodes, 'open')), /已授权 · 任务直接执行/)
  assert.match(content(browserRow(nodes, 'closed')), /请在扩展中连接并授权/)
  for (const id of ['unknown', 'offline']) {
    assert.match(content(browserRow(nodes, id)), /授权待确认/)
    assert.doesNotMatch(content(browserRow(nodes, id)), /已授权|任务直接执行/)
  }
  assert.doesNotMatch(content(nodes), /智能审批|切换模式|查看模式|确认页已打开/)
  assert.equal(h.calls.length, 0)
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

test('旧缓存不能证明连接或授权，刷新失败不派发任何写入', async () => {
  for (const state of [{ dataUpdatedAt: Date.now() - 16000 }, { error: Error('offline') }, { fetchStatus: 'paused' }]) {
    const h = await load({ browsers: { data: [
      { instanceId: 'stale', browser: 'chrome', connected: true, consentStatus: 'enabled' }
    ], dataUpdatedAt: Date.now(), ...state } })
    const nodes = h.render('BrowserWork', {})
    assert.match(content(nodes), /本地桥接不可用/)
    assert.doesNotMatch(content(nodes), /已授权|任务直接执行/)
    assert.equal(nodes.some(node => node.props?.['data-browser-id'] === 'stale'), false)
    assert.equal(h.calls.length, 0)
  }
})
