// 中文注释：弹窗显示连接、浏览器访问、当前页任务和 Cookie 镜像元信息。
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
  const browsers = Array.isArray(statusData?.browsers) ? statusData.browsers : []
  $('#browser-list').replaceChildren(...browsers.map(row => {
    const item = document.createElement('p')
    item.textContent = `${row.browser === 'edge' ? 'Edge' : 'Chrome'} ${String(row.instanceId||'').slice(0,8)} · ${row.connected===false?'未连接':row.instanceId === statusData.instanceId ? '当前浏览器' : '已连接'}${row.primary ? ' · 主要链接' : ''}`
    return item
  }))
  $('#browser-links').hidden = !connected
  $('#set-primary').hidden = !connected || browsers.some(row => row.instanceId === statusData.instanceId && row.primary)
  $('#set-primary').disabled = busy
  renderWork()
  renderCookieTargets()
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
    // 中文注释：确认窗口会关闭工具栏弹窗；重开时仅按后台编号查询，不重新发起镜像。
    if(result.cookieMirrorTransfer&&result.cookieMirrorTransfer!==cookieObservedId){cookieObservedId=result.cookieMirrorTransfer;cookieTransfer=result.cookieMirrorTransfer;cookieBusy=true;}
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
  void pollCookieMirror()
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
$('#set-primary').addEventListener('click', async () => {
  if (busy || !connected) return
  busy = true; render()
  try { await call({type:'set_primary'}) }
  catch { $('#error').textContent='主要链接设置未确认'; $('#error').hidden=false }
  finally { busy = false; await refresh() }
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

// 中文注释：页面只接收站点计数；Cookie 值始终留在后台私有通路。
let cookieSites=[],cookieSelected=new Set(),cookieTransfer=null,cookieBusy=false,cookiePolling=false,cookieObservedId=null;
function renderCookieTargets(){
 const old=$('#cookie-target').value;
 const targets=(statusData?.browsers||[]).filter(row=>row.connected!==false&&row.instanceId!==statusData.instanceId);
 $('#cookie-target').replaceChildren(...targets.map(row=>{const option=document.createElement('option');option.value=row.instanceId;option.textContent=`${row.browser==='edge'?'Edge':'Chrome'} · ${row.instanceId.slice(0,8)}`;return option;}));
 if(targets.some(row=>row.instanceId===old))$('#cookie-target').value=old;
 $('#cookie-load').disabled=!connected||cookieBusy;
 $('#cookie-copy').disabled=!connected||cookieBusy||!cookieSelected.size||!targets.length;
 $('#cookie-pending').disabled=!connected;
}
function renderCookieSites(){
 const query=$('#cookie-search').value.toLowerCase();
 $('#cookie-sites').replaceChildren(...cookieSites.filter(row=>row.site.includes(query)).map(row=>{
  const label=document.createElement('label'),box=document.createElement('input'),span=document.createElement('span');box.type='checkbox';box.checked=cookieSelected.has(row.site);box.dataset.site=row.site;
  box.addEventListener('change',()=>{if(box.checked)cookieSelected.add(row.site);else cookieSelected.delete(row.site);renderCookieTargets();});
  span.textContent=`${row.site} · ${row.count}${row.httpOnly?' · httpOnly':''}${row.session?' · 会话':''}`;label.append(box,span);return label;
 }));renderCookieTargets();
}
$('#cookie-load').addEventListener('click',async()=>{
 cookieBusy=true;renderCookieTargets();
 try{const result=await call({type:'cookie_mirror_sites'});cookieSites=result.sites;cookieSelected=new Set();renderCookieSites();$('#cookie-status').textContent=`${cookieSites.length} 个站点；选择要复制的站点。`;}
 catch{$('#cookie-status').textContent='站点列表读取失败，请核实扩展权限和连接。';}
 finally{cookieBusy=false;renderCookieTargets();}
});
$('#cookie-search').addEventListener('input',renderCookieSites);
$('#cookie-all').addEventListener('click',()=>{cookieSelected=new Set(cookieSites.map(row=>row.site));renderCookieSites();});
$('#cookie-none').addEventListener('click',()=>{cookieSelected.clear();renderCookieSites();});
$('#cookie-pending').addEventListener('click',async()=>{try{const r=await call({type:'cookie_mirror_pending'});$('#cookie-status').textContent=r.opened?'已打开确认面板。':'没有待确认的 Cookie 镜像。';}catch{$('#cookie-status').textContent='无法打开确认面板。';}});
$('#cookie-copy').addEventListener('click',async event=>{
 if(!event.isTrusted||cookieBusy||!cookieSelected.size)return;
 const options={clearTarget:$('#cookie-clear').checked};
 if($('#cookie-persist').checked){options.persistDays=Number($('#cookie-days').value);if(!Number.isInteger(options.persistDays)||options.persistDays<1||options.persistDays>365){$('#cookie-status').textContent='保存天数须为 1–365 的整数。';return;}}
 cookieBusy=true;renderCookieTargets();$('#cookie-results').replaceChildren();
 try{const result=await call({type:'cookie_mirror_request',target:$('#cookie-target').value,sites:[...cookieSelected],options});cookieTransfer=result.transferId;cookieObservedId=result.transferId;$('#cookie-status').textContent='等待源浏览器扩展确认；60 秒内有效。';void pollCookieMirror();}
 catch{cookieBusy=false;renderCookieTargets();$('#cookie-status').textContent='镜像未确认，请核实连接和站点。';}
});
async function pollCookieMirror(){
 if(!cookieTransfer||cookiePolling)return;cookiePolling=true;
 try{
  const result=await call({type:'cookie_mirror_status',transferId:cookieTransfer});
  const labels={preparing:'正在准备确认…',approval_required:'请在源浏览器扩展确认面板批准。',executing:'正在复制…',completed:'复制完成，请在目标浏览器访问站点核实登录。',denied:'用户拒绝了镜像。',failed:'镜像失败，可能已有部分写入；请核实目标浏览器。'};
  $('#cookie-status').textContent=labels[result.status]||'状态未确认。';
  if(['completed','denied','failed'].includes(result.status)){
   $('#cookie-results').replaceChildren(...(result.sites||[]).map(row=>{const p=document.createElement('p');p.textContent=`${row.site}：成功 ${row.success||0} / 失败 ${row.failed||0}；回读匹配 ${row.matched||0} / 缺失 ${row.missing||0}${row.clearFailed?`；清除失败 ${row.clearFailed}`:''}${row.reasons&&Object.keys(row.reasons).length?`；原因 ${Object.entries(row.reasons).map(([key,n])=>`${key} ${n}`).join('、')}`:''}`;return p;}));cookieTransfer=null;cookieBusy=false;renderCookieTargets();
  }
 }catch{$('#cookie-status').textContent='镜像结果无法确认或已过期，请核实目标浏览器，不会重放。';cookieTransfer=null;cookieBusy=false;renderCookieTargets();}
 finally{cookiePolling=false;}
}
