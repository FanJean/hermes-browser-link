// 中文注释：弹窗显示连接、浏览器访问、当前页任务和 Cookie 镜像入口。
const $ = selector => document.querySelector(selector)
let connected = false
let known = false
let statusData = null
let refreshing = false
let uncertainControl = null
let consentStatus = 'unknown'
let busy = false
let confirming = false
let revision = 0
// 中文注释：过滤偏好可在本地桥断线时设置，与浏览器访问授权分开。
let filterEnabled = false
let filterKnown = false
let cursorEnabled = true

async function call(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response || response.error || !Object.hasOwn(response, 'result')) throw Error('状态未确认')
  return response.result
}

function render() {
  const title = $('#connection-label')
  title.textContent = !known ? '状态待确认' : connected ? '已连接' : busy ? '正在处理…' : '未连接'
  title.dataset.state = known && connected ? 'connected' : 'disconnected'
  $('#connection-detail').textContent = connected ? '' : '请确认本机服务已启动。'
  $('#connect').hidden = connected || busy
  $('#connection-card').hidden = known && connected
  const access = $('#access-toggle')
  access.setAttribute('aria-checked', String(consentStatus === 'enabled'))
  access.disabled = busy || !connected || !known
  $('#access-detail').textContent = consentStatus === 'enabled' ? '全部访问 · 工具直接执行' : consentStatus === 'disabled' ? '智能审批 · 首次读网站确认，写入逐项确认' : '模式待确认'
  $('#confirm').hidden = !confirming
  $('#confirm-enable').disabled = busy
  $('#confirm-cancel').disabled = busy
  $('#filter-toggle').setAttribute('aria-checked', String(filterEnabled))
  $('#filter-toggle').disabled = busy || !filterKnown
  $('#filter-detail').textContent = !filterKnown ? '设置状态待确认' : filterEnabled ? '已开启 · 对后续文本返回生效' : '已关闭 · 返回原始文本'
  $('#cursor-toggle').setAttribute('aria-checked', String(cursorEnabled))
  $('#cursor-toggle').disabled = busy || !known
  renderWork()
  $('#cookie-pending').disabled = !known || !connected
}

async function refresh() {
  if (busy || refreshing) return
  refreshing = true
  const token = ++revision
  try {
    const result = await call({ type: 'popup_status' })
    if (token !== revision) return
    known = true
    statusData = result
    connected = result.connected === true
    filterEnabled = result.pageContentFilter === true
    filterKnown = true
    cursorEnabled = result.visualCursorEnabled !== false
    consentStatus = result.browserFullConsentStatus || 'unknown'
    if(uncertainControl){
      const task=statusData.tasks?.find(t=>t.id===uncertainControl.taskId)
      if(!task||['cancelled','closed'].includes(task.state)||task.generation!==uncertainControl.generation||uncertainControl.kind==='takeover'&&task.state==='paused'||uncertainControl.kind==='resume'&&['paused','ready','running'].includes(task.state))uncertainControl=null
    }
    $('#error').hidden = !uncertainControl
  } catch {
    if (token !== revision) return
    known = false
    filterKnown = false
    consentStatus = 'unknown'
    $('#error').textContent = '连接状态暂时无法读取。'
    $('#error').hidden = false
  } finally { refreshing = false }
  render()
}

// 中文注释：保存后以后台持久化读回结果为准，失败时不显示为已生效。
async function setContentFilter() {
  if (busy || !filterKnown) return
  const enabled = !filterEnabled
  busy = true
  ++revision
  render()
  try {
    const result = await call({type: 'page_content_filter', enabled})
    if (result.enabled !== enabled) throw Error('过滤状态未确认')
    filterEnabled = enabled
    $('#error').hidden = true
  } catch {
    filterKnown = false
    $('#error').textContent = '无法核实过滤设置，请稍后重试。'
    $('#error').hidden = false
  } finally {
    busy = false
    render()
  }
}
$('#filter-toggle').addEventListener('click', () => void setContentFilter())
$('#cursor-toggle').addEventListener('click', async () => {
  if (busy || !known) return
  busy = true; render()
  try { cursorEnabled = (await call({type:'visual_cursor',enabled:!cursorEnabled})).enabled }
  catch { $('#error').textContent='模拟鼠标设置未确认'; $('#error').hidden=false }
  finally { busy = false; render() }
})
async function setConsent(enabled) {
  if (busy || !connected) return
  busy = true
  confirming = false
  ++revision
  render()
  try {
    await call({ type: 'browser_consent', enabled })
    const result = await call({ type: 'popup_status' })
    const expected = enabled ? 'enabled' : 'disabled'
    if (result.browserFullConsentStatus !== expected) throw Error('授权状态未确认')
    connected = result.connected === true
    statusData = result
    known = true
    consentStatus = expected
    $('#error').hidden = true
  } catch {
    consentStatus = 'unknown'
    $('#error').textContent = '无法核实浏览器模式，请检查连接。'
    $('#error').hidden = false
  } finally {
    busy = false
    render()
  }
}

// 中文注释：只控制已确认的当前页；任务切换后不会复用旧的停止请求。
function renderWork(){
 const page=known&&connected?statusData?.page:null;
 const task=page?statusData.tasks?.find(t=>t.id===page.taskId&&!['closed','cancelled'].includes(t.state)):null;
 // 中文注释：记录本次渲染对应的任务和页面，供弹窗状态验收确认控制按钮没有指向旧页面。
 $('#page-task').dataset.taskId=task?.id||'';$('#page-task').dataset.tabId=task?String(page.tabId):'';
 $('#page-task').hidden=!task;
 $('#operation').textContent=task?.state==='pausing'?'正在暂停任务…':task?.state==='paused'?'任务已暂停':task?.pendingInteraction?(task.pendingInteraction.kind==='manual_input'?'等待人工输入':'等待确认'):task?.state==='running'?'任务运行中':'任务已就绪';
 // 中文注释：读回 paused 后允许用户显式继续；其他控制结果未知也不能封死停止入口。
 const uncertain=!!uncertainControl&&uncertainControl.taskId===task?.id&&uncertainControl.generation===task?.generation;
 $('#stop-task').disabled=busy||!task||uncertain&&uncertainControl.kind==='stop';$('#takeover').disabled=busy||!task||task.state==='pausing'||uncertain;$('#takeover').textContent=task?.state==='paused'?'继续':'接管';
}
async function controlTask(kind){
 const page=statusData?.page,task=statusData?.tasks?.find(t=>t.id===page?.taskId);
 if(!known||!connected||busy||!page||!task||kind!=='stop'&&task.state==='pausing'||uncertainControl?.kind===kind&&uncertainControl.taskId===task.id&&uncertainControl.generation===task.generation)return;
 busy=true;++revision;render();
 try{
  const result=await call({type:'popup_action',taskId:task.id,generation:task.generation,tabId:page.tabId,kind});
  if(result.verified!==true)throw Error('任务控制结果未确认');
  uncertainControl=null;
 }catch{
  uncertainControl={kind,taskId:task.id,generation:task.generation};$('#error').hidden=false;$('#error').textContent='操作结果尚未确认，正在读取状态，不会重复发送。';
 }finally{busy=false;await refresh();}
}
$('#stop-task').addEventListener('click',()=>void controlTask('stop'));
// 中文注释：接管/继续走后台任务控制，不能只切换页面样式。
$('#takeover').addEventListener('click',()=>{const task=statusData?.tasks?.find(t=>t.id===statusData?.page?.taskId);void controlTask(task?.state==='paused'?'resume':'takeover');});

$('#access-toggle').addEventListener('click', () => {
  if (busy || !connected) return
  if (consentStatus === 'enabled') void setConsent(false)
  else { confirming = true; render() }
})
$('#confirm-cancel').addEventListener('click', () => { confirming = false; render() })
$('#confirm-enable').addEventListener('click', () => void setConsent(true))
$('#connect').addEventListener('click', async () => {
  if (busy) return
  busy = true
  render()
  try { await call({ type: 'connect' }) } catch { /* 中文注释：连接结果以下一次状态读取为准。 */ }
  busy = false
  await refresh()
})
chrome.runtime.onMessage.addListener(message => { if (message?.type === 'changed') void refresh() })
void refresh()
setInterval(refresh, 1500)

// 中文注释：待确认按钮只打开现有请求；无请求或打开失败时复用弹窗提示区。
$('#cookie-pending').addEventListener('click', async () => {
  if (!known || !connected) return
  try {
    const result = await call({type: 'cookie_mirror_pending'})
    $('#error').hidden = result.opened === true
    if (!result.opened) $('#error').textContent = '没有待确认的 Cookie 镜像。'
  } catch {
    $('#error').textContent = '无法打开确认面板，请检查源浏览器连接。'
    $('#error').hidden = false
  }
})
