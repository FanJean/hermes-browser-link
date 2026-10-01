import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

// 中文注释：单元测试只使用仓库锁定的开发依赖；生产组件仍由 Hermes 提供 React。
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as query from '@tanstack/react-query'
const flush = () => new Promise(resolve => setTimeout(resolve, 20))

async function setup(rest, hash = '#/browser-link') {
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/${hash}` })
  const before = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const registrations = [], calls = [], notices = []
  const source = await readFile(new URL('./plugin.js', import.meta.url), 'utf8')
  const context = { URL, URLSearchParams, Date, console,
    location: dom.window.location,
    addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window),
    __sdk: { ...query, host: { navigate(path) { dom.window.location.hash = `#${path}` }, notify(n) { notices.push(n) } }, ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', PALETTE_AREA: 'palette' },
    __react: React, __jsx: jsxRuntime }
  vm.runInNewContext(source.replace(/import \{([^}]+)\} from '@hermes\/plugin-sdk'/, 'const {$1} = __sdk')
    .replace(/import \{([^}]+)\} from 'react'/, 'const {$1} = __react')
    .replace(/import \{([^}]+)\} from 'react\/jsx-runtime'/, 'const {$1} = __jsx')
    .replace('export default {', 'globalThis.plugin = {').replace('export const __testables =', 'globalThis.helpers ='), context)
  context.plugin.register({ registerMany: rows => registrations.push(...rows), rest: async (path, opts) => { calls.push([path, opts]); return rest(path, opts) } })
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const root = createRoot(document.getElementById('root'))
  await React.act(async () => { root.render(React.createElement(query.QueryClientProvider, { client }, registrations[0].render())); await flush() })
  await React.act(flush)
  return { dom, client, calls, notices,
    button: label => [...document.querySelectorAll('button')].find(b => b.textContent === label),
    async click(button) { await React.act(async () => { button.click(); await flush() }); await React.act(flush) },
    async close() { await React.act(async () => root.unmount()); client.clear(); dom.window.close(); Object.assign(globalThis, before) }
  }
}

// 中文注释：使用真实 React 和 Query 渲染，验证初始加载及授权只触发确认入口。
test('连接面板只读取浏览器列表，授权请求不会伪造授权已开启', async () => {
  const h = await setup(async (path, options) => {
    if (path === '/shared/browsers') return [{instanceId:'edge-a',browser:'edge',connected:true,consentStatus:'disabled',accessRequestSupported:true}]
    assert.equal(options.method,'POST')
    assert.equal(path,'/shared/browsers/edge-a/access-request')
    return {requestId:'r',status:'confirmation_requested'}
  }, '#/browser-link?task=old')
  try {
    assert.match(document.body.textContent,/本地桥接可用/)
    await h.click(h.button('切换模式'))
    assert.match(document.body.textContent,/确认页已打开/)
    assert.match(document.body.textContent,/智能审批/)
    assert.equal(h.calls.some(([path])=>path.includes('/tasks')),false)
    assert.equal(document.querySelector('details,select,input,table'),null)
  } finally { await h.close() }
})

test('真实渲染区分桥接不可用和空浏览器列表', async () => {
  for (const unavailable of [true,false]) {
    const h=await setup(async()=>{if(unavailable)throw Error('network');return []})
    try {
      assert.match(document.body.textContent,unavailable?/本地桥接不可用/:/暂无浏览器/)
      assert.equal(h.calls.length,1)
    } finally { await h.close() }
  }
})
