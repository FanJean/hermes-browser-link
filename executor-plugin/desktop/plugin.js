import { host, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, useQuery } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
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

// 中文注释：桌面只渲染固定的元数据；即便响应混入 Cookie 或异常文本也不进入 HTML。
const COOKIE_ACTIVE = ['preparing', 'approval_required', 'executing']
const COOKIE_FAILURES = { transfer_failed: '传输失败', disconnected: '浏览器已断开', expired: '已过期', unavailable: '状态查询失败，请在扩展核实，不要重复发起', prefix_constraint: 'Cookie 前缀约束', partition_write_failed: '分区写入失败', write_failed: '写入失败' }
const cookieCount = n => { if (!Number.isInteger(n) || n < 0 || n > 1000000) throw Error('invalid cookie count'); return n }
const cookieSite = site => typeof site === 'string' && site.length <= 253 && /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:]{2,45}\]$/.test(site)
const cookieTargets = (rows, source) => rows.filter(row => row.connected === true && row.instanceId !== source && typeof row.instanceId === 'string' && row.features?.includes('cookie_mirror_v1'))
function cookieInventory(value) {
  if (!Array.isArray(value?.sites) || value.sites.length > 4096 || value.sites.some(row => !cookieSite(row?.site))) throw Error('invalid cookie inventory')
  return value.sites.map(row => ({ site: row.site, count: cookieCount(row.count), httpOnly: row.httpOnly === true, session: row.session === true }))
}
function cookieTransfer(value) {
  if (!/^[a-f0-9]{32}$/.test(value?.transferId) || ![...COOKIE_ACTIVE, 'completed', 'denied', 'failed'].includes(value?.status) || !Number.isFinite(value.expiresAt)) throw Error('invalid cookie transfer')
  return { transferId: value.transferId, status: value.status, expiresAt: value.expiresAt,
    reason: ['transfer_failed', 'disconnected', 'expired'].includes(value.reason) ? value.reason : 'transfer_failed',
    ...Object.fromEntries(['success', 'failed', 'matched', 'missing'].filter(key => value.status === 'completed' || value[key] !== undefined).map(key => [key, cookieCount(value[key])])),
    sites: (Array.isArray(value.sites) ? value.sites : []).filter(row => cookieSite(row?.site)).map(row => ({ site: row.site,
      reasons: Object.entries(row.reasons || {}).filter(([key]) => ['expired', 'prefix_constraint', 'partition_write_failed', 'write_failed'].includes(key)).map(([key, n]) => `${COOKIE_FAILURES[key]} ${cookieCount(n)}`) })) }
}
function cookieStatusText(value) {
  if (!value) return ''
  if (value.status === 'completed') return `完成：成功 ${value.success} / 失败 ${value.failed}，回读匹配 ${value.matched} / 缺失 ${value.missing}`
  if (value.status === 'failed') return `失败：${COOKIE_FAILURES[value.reason] || COOKIE_FAILURES.transfer_failed}`
  return ({ preparing: '正在准备，等待扩展确认', approval_required: '等待扩展确认', executing: '复制中', denied: '用户拒绝', expired: '已过期，请重新选择后发起' })[value.status] || '状态待确认'
}

const COOKIE_FIELD_CLASS = 'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-3 py-2 text-sm text-(--ui-text-primary) focus-visible:outline-2 focus-visible:outline-(--ui-accent)'
// 中文注释：主背景是半透明控件填充色；原生弹窗改用不透明 elevated 表面，并显式覆盖宿主的 margin 重置。
const COOKIE_DIALOG_STYLE = { position: 'fixed', inset: 0, margin: 'auto', width: 'min(32rem, calc(100vw - 2rem))', height: 'fit-content', maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', boxSizing: 'border-box', padding: '1.5rem', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '0.75rem', backgroundColor: 'var(--ui-bg-elevated)', color: 'var(--ui-text-primary)', boxShadow: 'var(--shadow-md)' }
const COOKIE_DIALOG_CONTENT_STYLE = { ...BROWSER_WORK_SECTION_STYLE, gap: '1rem' }

function CookieMirrorPanel({ browser, rows, fresh }) {
  const [sites, setSites] = useState(null), [search, setSearch] = useState(''), [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState([]), [dialogSites, setDialogSites] = useState(null)
  const [target, setTarget] = useState(''), [clearTarget, setClearTarget] = useState(false)
  const [persist, setPersist] = useState(false), [days, setDays] = useState('7')
  const [transfer, setTransfer] = useState(null), [error, setError] = useState(''), [sending, setSending] = useState(false)
  const dialog = useRef(null), inFlight = useRef(false)
  const targets = cookieTargets(rows, browser.instanceId)
  const status = useQuery({ queryKey: [ID, 'cookie-mirror', transfer?.transferId || null], initialData: transfer || undefined,
    // 中文注释：只按在途状态轮询；焦点或网络恢复不能改写已完成结果或重查未知结果。
    enabled: !!transfer, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: query => COOKIE_ACTIVE.includes(query.state.data?.status) ? 1000 : false,
    queryFn: async () => {
      // 中文注释：到期仅停止查询并显示过期；不重发、不延长 daemon 的 60 秒内存期限。
      if (Date.now() >= transfer.expiresAt * 1000) return { status: 'expired' }
      try { return cookieTransfer(await api(`/shared/cookie-mirror/${transfer.transferId}`)) }
      catch { return { status: Date.now() >= transfer.expiresAt * 1000 ? 'expired' : 'failed', reason: 'unavailable' } }
    } })
  const current = status.data || transfer
  const busy = sending || COOKIE_ACTIVE.includes(current?.status)
  const available = fresh && browser.connected === true
  // 中文注释：原生对话框负责焦点限制、Esc 和关闭后焦点返回，不创建另一套模态组件。
  useEffect(() => { if (dialogSites) dialog.current.showModal(); else if (dialog.current?.open) dialog.current.close() }, [dialogSites])
  const loadSites = async () => {
    if (!available || loading) return
    setLoading(true); setError('')
    try { setSites(cookieInventory(await api(`/shared/browsers/${encodeURIComponent(browser.instanceId)}/cookie-sites`))); setSelection([]) }
    catch { setError('站点读取失败，请检查源扩展连接后重新读取。') }
    finally { setLoading(false) }
  }
  const choose = chosen => {
    setDialogSites(chosen); setTarget(''); setClearTarget(false); setPersist(false); setDays('7'); setError('')
  }
  const send = async () => {
    if (inFlight.current || busy || !available || !targets.some(row => row.instanceId === target) || !dialogSites?.length || persist && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365)) return
    inFlight.current = true; setSending(true); setError('')
    try {
      const result = cookieTransfer(await api('/shared/cookie-mirror', { method: 'POST', body: {
        source: browser.instanceId, target, sites: dialogSites, options: { clearTarget, ...(persist ? { persistDays: Number(days) } : {}) } } }))
      setTransfer(result); setDialogSites(null)
    } catch { setError('镜像请求结果未确认，请在源扩展核实，不要重复发起。'); setDialogSites(null) }
    finally { inFlight.current = false; setSending(false) }
  }
  const filtered = (sites || []).filter(row => row.site.includes(search.trim().toLowerCase()))
  return jsxs('section', { 'aria-label': 'Cookie 镜像', style: { gridColumn: '1 / -1', minWidth: 0 }, children: [
    // 中文注释：遮罩只作用于本镜像弹窗，原生 top layer 继续负责背景输入隔离、焦点和 Esc。
    jsx('style', { children: '.hermes-cookie-dialog::backdrop{background:rgb(0 0 0 / .45)}' }),
    button(loading ? '正在读取…' : '读取 Cookie 站点', loadSites, { disabled: !available || loading || busy }),
    error ? jsx('p', { role: 'alert', className: 'mt-2 text-sm text-(--ui-text-danger)', children: error }) : null,
    sites ? jsxs('div', { className: 'mt-3 flex flex-col gap-3', children: [
      jsx('input', { type: 'search', 'aria-label': '搜索 Cookie 站点', placeholder: '搜索网站', value: search, onChange: e => setSearch(e.target.value), className: COOKIE_FIELD_CLASS }),
      button(`镜像已选站点（${selection.length}）`, () => choose(selection), { disabled: !available || busy || !selection.length }),
      !filtered.length ? jsx('p', { className: 'text-sm text-(--ui-text-secondary)', children: sites.length ? '没有匹配的站点。' : '该浏览器没有 Cookie 站点。' }) : null,
      jsx('ul', { className: 'm-0 max-h-72 list-none overflow-auto p-0', children: filtered.map(row => jsxs('li', { className: 'flex flex-wrap items-center gap-3 border-b border-(--ui-stroke-secondary) py-2', children: [
        jsxs('label', { className: 'flex min-w-0 flex-1 items-center gap-2 text-sm text-(--ui-text-primary)', children: [
          jsx('input', { type: 'checkbox', checked: selection.includes(row.site), disabled: busy, 'aria-label': `选择 ${row.site}`, onChange: e => setSelection(chosen => e.target.checked ? [...chosen, row.site] : chosen.filter(site => site !== row.site)) }),
          jsx('span', { className: 'break-all', children: row.site }) ] }),
        jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: `${row.count} 个 Cookie${row.httpOnly ? ' · httpOnly' : ''}${row.session ? ' · 会话' : ''}` }),
        button('镜像', () => choose([row.site]), { disabled: !available || busy }) ] }, row.site)) }) ] }) : null,
    current ? jsxs('div', { className: 'mt-3 text-sm text-(--ui-text-secondary)', role: 'status', 'aria-live': 'polite', children: [
      jsx('p', { children: cookieStatusText(current) }),
      ['preparing', 'approval_required'].includes(current.status) ? jsx('p', { children: '必须在源浏览器扩展里批准。浏览器在后台时可点击系统通知打开面板；也可切到源浏览器，将已有确认窗口切到前台。' }) : null,
      ...(current.sites || []).filter(row => row.reasons.length).map(row => jsx('p', { children: `${row.site}：${row.reasons.join(' / ')}` }, row.site)) ] }) : null,
    jsx('dialog', { ref: dialog, onCancel: () => setDialogSites(null), 'aria-label': '镜像 Cookie 到其他浏览器', className: 'hermes-cookie-dialog', style: COOKIE_DIALOG_STYLE, children: jsxs('div', { style: COOKIE_DIALOG_CONTENT_STYLE, children: [
      jsx('h2', { className: 'm-0 text-lg font-semibold', children: '镜像 Cookie' }),
      jsx('p', { className: 'text-sm', children: '批准后会把该站点登录态复制到目标浏览器。必须在源浏览器扩展里批准，全部访问也不能跳过确认。' }),
      jsx('p', { className: 'break-all text-sm', children: (dialogSites || []).join('、') }),
      jsxs('label', { className: 'flex flex-col gap-2 text-sm', children: ['目标浏览器 / 配置', jsx('select', { value: target, onChange: e => setTarget(e.target.value), className: COOKIE_FIELD_CLASS, style: { width: '100%', minWidth: 0, boxSizing: 'border-box' }, children: [
        jsx('option', { value: '', children: '请选择目标浏览器' }, 'empty'),
        ...targets.map(row => jsx('option', { value: row.instanceId, children: `${browserLabel(row.browser)} · ${row.instanceId}` }, row.instanceId)) ] })] }),
      !targets.length ? jsx('p', { children: '没有其他已连接且支持 Cookie 镜像的浏览器，请连接目标扩展。' }) : null,
      jsxs('label', { className: 'mt-4 flex items-center gap-2 text-sm', children: [jsx('input', { type: 'checkbox', checked: clearTarget, onChange: e => setClearTarget(e.target.checked) }), '导入前清除目标这些站点的旧 Cookie'] }),
      jsxs('label', { className: 'mt-3 flex items-center gap-2 text-sm', children: [jsx('input', { type: 'checkbox', checked: persist, onChange: e => setPersist(e.target.checked) }), '会话 Cookie 持久保存'] }),
      // 中文注释：天数只有三位，限制输入宽度，避免窄窗口里被原生输入的默认宽度撑开。
      persist ? jsxs('label', { className: 'mt-2 flex items-center gap-2 text-sm', children: [jsx('input', { type: 'number', min: 1, max: 365, value: days, 'aria-label': '持久保存天数', onChange: e => setDays(e.target.value), className: COOKIE_FIELD_CLASS, style: { width: '6rem', minWidth: 0, boxSizing: 'border-box' } }), '天（1–365）'] }) : null,
      jsxs('div', { className: 'mt-6 flex justify-end gap-2', children: [button('取消', () => setDialogSites(null), { disabled: sending }), button(sending ? '请求中…' : '镜像', send, { disabled: !available || busy || !targets.some(row => row.instanceId === target) || persist && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365) })] }) ] }) })
  ] })
}

function BrowserWork() {
  const browsers = useQuery({ queryKey: [ID, 'browsers'], queryFn: () => collection('/shared/browsers'), retry: false, refetchInterval: POLL_MS })
  const [accessAttempts, setAccessAttempts] = useState({})
  const [primaryPending, setPrimaryPending] = useState(null)
  const [primaryError, setPrimaryError] = useState(false)
  const [cookiePanels, setCookiePanels] = useState({})
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
      ]}),
      // 中文注释：入口单独占一行，避免在窄窗口挤压已有模式和主要链接按钮。
      browser.connected===true&&browser.features?.includes('cookie_mirror_v1')?jsx('div',{style:{gridColumn:'1 / -1'},children:button(cookiePanels[browser.instanceId]?'收起 Cookie 镜像':'Cookie 镜像',()=>setCookiePanels(current=>({...current,[browser.instanceId]:!current[browser.instanceId]})))}):null,
      // 中文注释：收起只隐藏面板，保留同一请求的查询和结果，避免误发第二次镜像。
      cookiePanels[browser.instanceId]!==undefined?jsx('div',{hidden:!cookiePanels[browser.instanceId],style:{gridColumn:'1 / -1'},children:jsx(CookieMirrorPanel,{browser,rows,fresh:browsersFresh})}):null
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
