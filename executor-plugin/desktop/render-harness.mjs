import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

// 中文注释：单元测试只使用仓库锁定的开发依赖；生产组件仍由 Hermes 提供 React。
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as query from '@tanstack/react-query'
const flush = () => new Promise(resolve => setTimeout(resolve, 20))

export async function setup(rest, hash = '#/browser-link') {
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/${hash}` })
  // 中文注释：仅在 JSDOM 中模拟原生对话框的打开/关闭标记。
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
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
    async change(element, value) { await React.act(async () => { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set; setter.call(element, value); const key = Object.keys(element).find(key => key.startsWith('__reactProps')); element[key].onChange({ target: element }); await flush() }); await React.act(flush) },
    async tick() { await React.act(flush) },
    async refetch(queryKey) { await React.act(async () => { await client.refetchQueries({ queryKey }); await flush() }); await React.act(flush) },
    async click(button) { await React.act(async () => { button.click(); await flush() }); await React.act(flush) },
    async close() { await React.act(async () => root.unmount()); client.clear(); dom.window.close(); Object.assign(globalThis, before) }
  }
}
