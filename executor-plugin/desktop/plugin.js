import { host, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, useQuery } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'browser-link'
const ROOT = '/browser-link'
const POLL_MS = 3000
let pluginCtx = null
const browserAccessRequestGate = new Map()

function api(path, options) {
  if (!pluginCtx || typeof pluginCtx.rest !== 'function') {
    throw new Error('浏览器任务服务未连接。请在插件设置中启用后端。')
  }
  return pluginCtx.rest(path, options)
}

async function collection(path) {
  const result = await api(path)
  if (!Array.isArray(result) || result.some(item => !item || typeof item !== 'object')) throw new Error('返回的数据格式不正确，请刷新重试。')
  return result
}

function browserLabel(browser) {
  return ({ edge: 'Microsoft Edge', chrome: 'Chrome' })[browser] || '未知浏览器'
}

function browserConsentStatus(browser) {
  return ['enabled', 'disabled', 'unknown'].includes(browser?.consentStatus) ? browser.consentStatus : 'unknown'
}

function accessRequestState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'requestId') ||
      !Object.prototype.hasOwnProperty.call(value, 'status') || typeof value.requestId !== 'string' ||
      value.requestId.length === 0 || value.requestId.length > 128) return 'invalid'
  // 中文注释：桥接确认扩展已打开确认页后才显示此状态。
  if (value.status === 'confirmation_requested') return 'awaiting'
  if (value.status === 'already_requested') return 'already_requested'
  if (value.status === 'expired') return 'expired'
  if (value.status === 'unknown') return 'unknown'
  return 'invalid'
}

function button(label, onClick, options = {}) {
  return jsx('button', {
    type: 'button',
    disabled: !!options.disabled,
    onClick,
    className: 'inline-flex items-center justify-center rounded-md border border-(--ui-stroke-secondary) px-3 py-1.5 text-xs font-medium text-(--ui-text-primary) outline-none transition-colors hover:bg-(--chrome-action-hover) focus-visible:ring-2 focus-visible:ring-(--ui-accent) disabled:cursor-not-allowed disabled:opacity-50',
    children: label
  })
}

function queryUnavailable(query) {
  return !!query.error || query.fetchStatus === 'paused' || (typeof query.dataUpdatedAt === 'number' && query.dataUpdatedAt > 0 && Date.now() - query.dataUpdatedAt > POLL_MS * 5)
}

function browserListFresh(query) {
  return Array.isArray(query.data) && Number.isFinite(query.dataUpdatedAt) && query.dataUpdatedAt > 0 && !queryUnavailable(query)
}

const BROWSER_WORK_PAGE_STYLE = { display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '48rem' }
const BROWSER_WORK_SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '0.625rem' }
const BROWSER_WORK_HEADING_STYLE = { margin: 0, color: 'var(--ui-text-primary)', fontSize: '0.875rem', fontWeight: 600 }
const BROWSER_ROW_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: '0.5rem 1rem', minWidth: 0, padding: '0.875rem 0', borderBottom: '1px solid var(--ui-stroke-secondary)' }

function BrowserWork() {
  const browsers = useQuery({ queryKey: [ID, 'browsers'], queryFn: () => collection('/shared/browsers'), retry: false, refetchInterval: POLL_MS })
  const [accessAttempts, setAccessAttempts] = useState({})
  const [primaryPending, setPrimaryPending] = useState(null)
  const [primaryError, setPrimaryError] = useState(false)
  const rows = Array.isArray(browsers.data) ? browsers.data : []
  const browsersFresh = browserListFresh(browsers)
  // 中文注释：状态未刷新成功时不把旧数据计入在线或离线数量。
  const online = browsersFresh ? rows.filter(browser => browser.connected === true) : []
  const offline = browsersFresh ? rows.filter(browser => browser.connected === false) : []
  const unknown = browsersFresh ? rows.filter(browser => browser.connected !== true && browser.connected !== false) : []
  const setAttempt = (instanceId, attempt) => {
    browserAccessRequestGate.set(instanceId, attempt)
    setAccessAttempts(current => ({ ...current, [instanceId]: attempt }))
  }
  const requestBrowserAccess = async browser => {
    const instanceId = browser.instanceId
    const consentStatus = browserConsentStatus(browser)
    if (!browsersFresh || browser.connected !== true || browser.accessRequestSupported !== true || typeof instanceId !== 'string' || !instanceId) return
    // 中文注释：重复点击只发送一次在途请求，授权结果仍以浏览器读回为准。
    if (browserAccessRequestGate.get(instanceId)?.state === 'pending') return
    setAttempt(instanceId, { consentStatus, state: 'pending' })
    try {
      const result = await api(`/shared/browsers/${encodeURIComponent(instanceId)}/access-request`, { method: 'POST', body: {} })
      setAttempt(instanceId, { consentStatus, state: accessRequestState(result) })
    } catch (_) {
      setAttempt(instanceId, { consentStatus, state: 'unknown' })
    }
  }
  const setPrimary = async browser => {
    if (!browsersFresh || browser.connected !== true || primaryPending) return
    setPrimaryPending(browser.instanceId)
    try {
      // 中文注释：写入由桌面受保护路由完成，按钮状态以守护进程读回为准。
      await api(`/shared/browsers/${encodeURIComponent(browser.instanceId)}/primary`, { method: 'POST', body: {} })
      await browsers.refetch()
      setPrimaryError(false)
    } catch { setPrimaryError(true) }
    finally { setPrimaryPending(null) }
  }
  const browserRow = browser => {
    const consentStatus = browserConsentStatus(browser)
    // 中文注释：桌面面板直接显示每个浏览器当前的两档权限模式。
    const consent = ({ enabled: '全部访问', disabled: '智能审批 · 首次读取网站需确认', unknown: '模式待确认' })[consentStatus]
    const actionLabel = ({ enabled: '切换模式', disabled: '切换模式', unknown: '查看模式' })[consentStatus]
    const attempt = accessAttempts[browser.instanceId] || browserAccessRequestGate.get(browser.instanceId)
    const disabled = !browsersFresh || browser.connected !== true || browser.accessRequestSupported !== true || attempt?.state === 'pending' || typeof browser.instanceId !== 'string' || !browser.instanceId
    // 中文注释：请求反馈留在按钮内，避免管理访问后插入整段提示撑乱列表。
    const compactAction = attempt?.consentStatus === consentStatus
      ? ({ pending: '请求中…', awaiting: '确认页已打开', already_requested: '查看确认页', unknown: '状态待确认', expired: '重新请求', invalid: '状态待确认' })[attempt.state] || actionLabel
      : actionLabel
    return jsxs('div', { 'data-browser-row':'', 'data-browser-id':browser.instanceId, style:BROWSER_ROW_STYLE, children:[
      jsxs('div',{className:'min-w-0',children:[
        jsx('strong',{className:'text-sm text-(--ui-text-primary)',children:browserLabel(browser.browser)}),
        jsx('p',{className:'mt-1 text-xs text-(--ui-text-secondary)',children:`${browser.connected===true?'已连接':browser.connected===false?'未连接':'连接待确认'} · ${consent}${browser.primary===true?' · 主要链接':''}`})
      ]}),
      jsxs('div',{style:{display:'flex',gap:'0.5rem'},children:[
        browser.accessRequestSupported===true?button(compactAction,()=>requestBrowserAccess(browser),{disabled}):null,
        browser.primary===true?null:button(primaryPending===browser.instanceId?'设置中…':'设为主要链接',()=>setPrimary(browser),
          {disabled:!browsersFresh||browser.connected!==true||!!primaryPending})
      ]})
    ]},browser.instanceId)
  }

  // 中文注释：成功读取浏览器列表即可确认桥接可用；旧缓存不能证明当前仍然在线。
  const loading=browsers.data===undefined&&!browsers.error&&browsers.fetchStatus!=='paused'
  return jsxs('main', { 'data-browser-work-page': '', style: BROWSER_WORK_PAGE_STYLE, children: [
    jsx('h1', { className: 'text-xl font-semibold text-(--ui-text-primary)', children: '浏览器连接' }),
    jsx('p', { role: loading?'status':browsersFresh?'status':'alert', className: 'text-sm text-(--ui-text-secondary)', children: loading?'正在读取浏览器连接…':browsersFresh?'本地桥接可用':'本地桥接不可用，请启动桥接服务并在浏览器扩展中连接 Hermes。' }),
    !loading&&!browsersFresh?button(browsers.isFetching?'正在刷新…':'刷新',()=>browsers.refetch(),{disabled:browsers.isFetching||browsers.fetchStatus==='paused'}):null,
    primaryError?jsx('p',{role:'alert',className:'text-xs text-(--ui-text-danger)',children:'主要链接设置未确认，请刷新后重试。'}):null,
    browsersFresh&&!rows.length?jsx('p', { className: 'text-sm text-(--ui-text-secondary)', children: '暂无浏览器，请打开浏览器扩展并连接 Hermes。' }):null,
    ...[['在线浏览器',online],['离线浏览器',offline],['状态待确认的浏览器',unknown]].filter(([,items])=>items.length).map(([label,items])=>jsxs('section', { 'aria-label':label,style:BROWSER_WORK_SECTION_STYLE,children:[jsx('h2',{style:BROWSER_WORK_HEADING_STYLE,children:label}),...items.map(browserRow)] },label)),
    rows.some(row=>row.accessRequestSupported!==true)?jsx('p',{className:'text-xs text-(--ui-text-tertiary)',children:'请在浏览器扩展弹窗中查看权限模式。'}):null
  ] })
}

// 中文注释：旧任务链接也只展示连接面板，不再请求任务详情。
function Page() { return jsx(BrowserWork, {}) }

export default {
  id: ID,
  name: '浏览器连接',
  defaultEnabled: false,
  register(ctx) {
    pluginCtx = ctx
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROOT }, render: () => jsx(Page, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 68, data: { path: ROOT, label: '浏览器连接', codicon: 'browser' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'browser-link.open', label: '打开浏览器连接', keywords: ['浏览器', '连接', 'browser'], run: () => host.navigate(ROOT) } }
    ])
  }
}
