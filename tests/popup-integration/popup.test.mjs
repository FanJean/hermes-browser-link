import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const root = new URL('../../native-extension/', import.meta.url)
const [html, script] = await Promise.all(['popup.html', 'popup.mjs'].map(file => readFile(new URL(file, root), 'utf8')))

async function mount(initial) {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' })
  const calls = []
  let status = initial
  let changed
  dom.window.chrome = {runtime: {
    getManifest:()=>({version:'9.8.7'}),
    sendMessage: async message => {
      calls.push(message)
      if (message.type === 'popup_status') return { result: status }
      if (message.type === 'page_content_filter') {
        status = {...status, pageContentFilter: message.enabled}
        return {result: {enabled: status.pageContentFilter}}
      }
      if(message.type==='popup_action'){
        const row=status.tasks.find(t=>t.id===message.taskId);row.state=message.kind==='takeover'?'paused':message.kind==='resume'?'ready':'cancelled';
        return {result:{verified:true,state:row.state}};
      }
      if (message.type === 'browser_consent') {
        status = { ...status, browserFullConsentStatus: message.enabled ? 'enabled' : 'disabled' }
        return { result: { consentStatus: status.browserFullConsentStatus } }
      }
      return { result: { connected: true } }
    },
    onMessage: { addListener: listener => { changed = listener } }
  } }
  dom.window.setInterval = () => 1
  dom.window.eval(script)
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
  await flush()
  return { dom, document: dom.window.document, calls, flush, setStatus(value) { status = value; changed({ type: 'changed' }) } }
}

test('弹窗只展示当前页归属，不展示其他任务或诊断正文', async () => {
  const h = await mount({ connected: true, browserFullConsentStatus: 'disabled', tasks: [{ id: 'private', title: '不展示的任务' }], tabs: [], approvals: [] })
  assert.equal(h.document.querySelector('#connection-label').textContent, '已连接')
  assert.equal(h.document.querySelector('#access-toggle').getAttribute('aria-checked'), 'false')
  assert.equal(h.document.querySelector('#tasks'), null)
  assert.equal(h.document.querySelector('#diagnostics'), null)
  assert.doesNotMatch(h.document.body.textContent, /不展示的任务/)
  assert.ok(h.calls.some(call => call.type === 'popup_status'))
  assert.equal(h.calls.some(call => call.type === 'status'), false)
  h.dom.window.close()
})

test('授权开关先确认开启，关闭后读取确认状态', async () => {
  const h = await mount({ connected: true, browserFullConsentStatus: 'disabled', tasks: [], tabs: [] })
  h.document.querySelector('#access-toggle').click()
  assert.equal(h.document.querySelector('#confirm').hidden, false)
  assert.equal(h.calls.filter(call => call.type === 'browser_consent').length, 0)
  h.document.querySelector('#confirm-enable').click()
  await h.flush()
  assert.equal(h.calls.filter(call => call.type === 'browser_consent').length, 1)
  assert.equal(h.calls.find(call => call.type === 'browser_consent').enabled, true)
  assert.equal(h.document.querySelector('#access-toggle').getAttribute('aria-checked'), 'true')
  h.document.querySelector('#access-toggle').click()
  await h.flush()
  assert.equal(h.calls.filter(call => call.type === 'browser_consent').at(-1).enabled, false)
  assert.equal(h.document.querySelector('#access-toggle').getAttribute('aria-checked'), 'false')
  h.dom.window.close()
})

test('断线时禁用授权开关，连接恢复后再读取授权', async () => {
  const h = await mount({ connected: false, browserFullConsentStatus: 'unknown', tasks: [], tabs: [] })
  assert.equal(h.document.querySelector('#access-toggle').disabled, true)
  h.setStatus({ connected: true, browserFullConsentStatus: 'enabled', tasks: [], tabs: [] })
  await h.flush()
  assert.equal(h.document.querySelector('#connection-label').textContent, '已连接')
  assert.equal(h.document.querySelector('#access-toggle').disabled, false)
  assert.equal(h.document.querySelector('#access-toggle').getAttribute('aria-checked'), 'true')
  h.dom.window.close()
})

// 中文注释：读取失败必须显示未知，不能把失败读取当成已断开或继续开放控制。
test('状态读取失败时显示未知并禁用页面控制', async () => {
  const h=await mount({connected:true,browserFullConsentStatus:'enabled',page:{tabId:7,taskId:'t',title:'测试页',origin:'https://example.test'},tasks:[{id:'t',generation:1,title:'测试任务',state:'ready'}]})
  assert.equal(h.document.querySelector('#page-task').hidden,false)
  h.dom.window.chrome.runtime.sendMessage=async()=>{throw Error('unavailable')}
  h.setStatus({})
  await h.flush()
  assert.equal(h.document.querySelector('#connection-label').textContent,'状态待确认')
  assert.equal(h.document.querySelector('#access-toggle').disabled,true)
  assert.equal(h.document.querySelector('#page-task').hidden,true)
  h.dom.window.close()
})

// 中文注释：过滤开关独立于连接与授权，开关后均以持久化读回状态展示。
test('过滤开关默认关闭，断线仍可切换且恢复时同步保存状态', async () => {
  const h=await mount({connected:false,browserFullConsentStatus:'disabled',tasks:[]})
  const button=h.document.querySelector('#filter-toggle')
  assert.equal(button.disabled,false)
  assert.equal(button.getAttribute('aria-checked'),'false')
  button.click()
  await h.flush()
  assert.equal(button.getAttribute('aria-checked'),'true')
  assert.match(h.document.querySelector('#filter-detail').textContent,/已开启/)
  assert.equal(h.calls.filter(call=>call.type==='browser_consent').length,0)
  h.setStatus({connected:true,pageContentFilter:true,tasks:[]})
  await h.flush()
  assert.equal(button.getAttribute('aria-checked'),'true')
  button.click()
  await h.flush()
  assert.equal(button.getAttribute('aria-checked'),'false')
  h.dom.window.close()
})

test('过滤设置保存失败时显示未确认，不显示为已开启', async () => {
  const h=await mount({connected:true,pageContentFilter:false,tasks:[]})
  h.dom.window.chrome.runtime.sendMessage=async()=>{throw Error('storage failed')}
  h.document.querySelector('#filter-toggle').click()
  await h.flush()
  assert.equal(h.document.querySelector('#filter-toggle').getAttribute('aria-checked'),'false')
  assert.equal(h.document.querySelector('#filter-toggle').disabled,true)
  assert.match(h.document.querySelector('#error').textContent,/无法核实过滤设置/)
  h.dom.window.close()
})

// 中文注释：新弹窗只保留当前页一行任务状态，模拟鼠标和过滤设置直接展示。
test('浏览器访问常驻，模拟鼠标和文字过滤常驻且无任务时隐藏任务区',async()=>{
 const h=await mount({connected:true,browserFullConsentStatus:'enabled',tasks:[]});
 try{
  assert.equal(h.document.querySelector('#access-toggle').closest('details'),null);
  assert.equal(h.document.querySelector('#filter-toggle').closest('details'),null);
  assert.equal(h.document.querySelector('#page-task').hidden,true);
  assert.equal(h.document.querySelector('#task-list,#verify-control'),null);
 }finally{h.dom.window.close();}
});
test('当前任务停止失败后不自动重发，切页也不会误停其他任务',async()=>{
 const current={connected:true,browserFullConsentStatus:'enabled',page:{tabId:7,taskId:'t'},tasks:[{id:'t',generation:1,state:'running'}]};
 const h=await mount(current);
 try{
  const base=h.dom.window.chrome.runtime.sendMessage;
  h.dom.window.chrome.runtime.sendMessage=async message=>{if(message.type==='popup_action'){h.calls.push(message);throw Error('断线');}return base(message);};
  h.document.querySelector('#stop-task').click();await h.flush();
  assert.equal(h.document.querySelector('#stop-task').disabled,true);
  h.setStatus(current);await h.flush();
  assert.equal(h.calls.filter(row=>row.type==='popup_action').length,1);
  h.setStatus({...current,page:null});await h.flush();assert.equal(h.document.querySelector('#page-task').hidden,true);
 }finally{h.dom.window.close();}
});

// 中文注释：两个入口共享状态读回，继续不会创建任务或重发旧动作。
test('弹窗接管变为继续，外部遮罩接管也同步显示继续',async()=>{
 const initial={connected:true,browserFullConsentStatus:'enabled',page:{taskId:'t',tabId:7},tasks:[{id:'t',generation:1,state:'ready'}]};
 const h=await mount(initial);try{
  h.document.querySelector('#takeover').click();await h.flush();assert.equal(h.document.querySelector('#takeover').textContent,'继续');
  assert.equal(h.calls.filter(row=>row.type==='popup_action').at(-1).kind,'takeover');
  h.document.querySelector('#takeover').click();await h.flush();assert.equal(h.document.querySelector('#takeover').textContent,'接管');
  h.setStatus({...initial,tasks:[{id:'t',generation:1,state:'paused'}]});await h.flush();assert.equal(h.document.querySelector('#takeover').textContent,'继续');
 }finally{h.dom.window.close();}
});

// 中文注释：两个就绪任务的按钮文案相同，验收必须能区分弹窗当前渲染的是哪个任务页。
test('切换同文案任务页时同步更新渲染的任务身份',async()=>{
 const first={connected:true,browserFullConsentStatus:'enabled',page:{taskId:'a',tabId:7},tasks:[{id:'a',generation:1,state:'ready'}]};
 const h=await mount(first);try{
  const section=h.document.querySelector('#page-task');
  assert.equal(section.dataset.taskId,'a');assert.equal(section.dataset.tabId,'7');
  h.setStatus({...first,page:{taskId:'b',tabId:8},tasks:[{id:'b',generation:1,state:'ready'}]});await h.flush();
  assert.equal(h.document.querySelector('#takeover').textContent,'接管');
  assert.equal(section.dataset.taskId,'b');assert.equal(section.dataset.tabId,'8');
  // 中文注释：旧等待条件在任务乙也会成立；任务身份条件必须阻止对任务甲的误点击。
  assert.equal(!section.hidden&&h.document.querySelector('#takeover').textContent==='接管',true);
  assert.equal(section.dataset.taskId==='a'&&section.dataset.tabId==='7',false);
  h.setStatus({...first,page:null,tasks:[]});await h.flush();
  assert.equal(section.dataset.taskId,'');assert.equal(section.dataset.tabId,'');
 }finally{h.dom.window.close();}
});

// 中文注释：恢复失败后读回仍为 paused，用户必须能再次显式继续；暂停结果未知时仍可停止任务。
test('继续结果未知但已读回暂停时，继续按钮不能永久禁用',async()=>{
 const h=await mount({connected:true,browserFullConsentStatus:'enabled',page:{tabId:7,taskId:'t'},tasks:[{id:'t',generation:1,state:'paused'}]});
 try{
  const send=h.dom.window.chrome.runtime.sendMessage;
  h.dom.window.chrome.runtime.sendMessage=async message=>{if(message.type==='popup_action'){h.calls.push(message);return {result:{state:'unknown'}};}return send(message);};
  h.document.querySelector('#takeover').click();await h.flush();
  assert.equal(h.document.querySelector('#takeover').textContent,'继续');assert.equal(h.document.querySelector('#takeover').disabled,false);
  assert.equal(h.calls.filter(row=>row.type==='popup_action').length,1,'状态轮询不能自动重试');
  h.document.querySelector('#takeover').click();await h.flush();assert.equal(h.calls.filter(row=>row.type==='popup_action').length,2);
 }finally{h.dom.window.close();}
});
test('接管结果未知不阻止用户显式停止任务',async()=>{
 const h=await mount({connected:true,browserFullConsentStatus:'enabled',page:{tabId:7,taskId:'t'},tasks:[{id:'t',generation:1,state:'ready'}]});
 try{
  const send=h.dom.window.chrome.runtime.sendMessage;
  h.dom.window.chrome.runtime.sendMessage=async message=>{if(message.type==='popup_action'){h.calls.push(message);return {result:{state:'unknown'}};}return send(message);};
  h.document.querySelector('#takeover').click();await h.flush();
  assert.equal(h.document.querySelector('#stop-task').disabled,false);
  h.document.querySelector('#stop-task').click();await h.flush();assert.equal(h.calls.filter(row=>row.type==='popup_action').at(-1).kind,'stop');
 }finally{h.dom.window.close();}
});

// 中文注释：宿主已冻结但仍在等待在途动作时，不能把页面交出状态显示为已完成。
test('暂停进行中显示等待且只允许停止',async()=>{
 const h=await mount({connected:true,page:{tabId:7,taskId:'t'},tasks:[{id:'t',generation:1,state:'pausing'}]});
 try{assert.match(h.document.querySelector('#operation').textContent,/正在暂停/);assert.equal(h.document.querySelector('#takeover').disabled,true);assert.equal(h.document.querySelector('#stop-task').disabled,false);}finally{h.dom.window.close();}
});

// 中文注释：弹窗只保留桌面深链和待确认入口，重开不再读取或重发复制。
// 中文注释：删除的入口不再隐藏在 DOM 或设置折叠区，自动屏蔽仍可单独操作。
test('弹窗仅保留权限和自动屏蔽，Cookie 与模拟鼠标和额外区域均移除',async()=>{
 const h=await mount({connected:true,browserFullConsentStatus:'disabled',tasks:[]});
 assert.equal(h.document.querySelector('#cookie-mirror,#cookie-pending,#cookie-desktop,#cursor-toggle,#cursor-label,#shield-settings,#shield-origin,#shield-selectors,#shield-save'),null);
 assert.equal(h.document.querySelector('#filter-toggle').closest('details'),null);
 h.document.querySelector('#filter-toggle').click();await h.flush();
 assert.equal(h.document.querySelector('#filter-toggle').getAttribute('aria-checked'),'true');
 assert.equal(h.calls.some(call=>call.type==='visual_cursor'||call.type==='cookie_mirror_pending'||call.type.startsWith('page_content_shield')),false);h.dom.window.close();
});
// 中文注释：版本直接来自当前扩展，在后台断开或给出不同版本时也不会变成宿主版本。
test('右上角版本使用当前 manifest，后台断线仍显示版本',async()=>{
 const h=await mount({connected:false,version:'0.0.1',tasks:[]});
 assert.equal(h.document.querySelector('#version-label').textContent,'v9.8.7');
 assert.ok(h.document.querySelector('.header-meta #version-label'));
 h.setStatus({connected:true,version:'0.0.2',tasks:[]});await h.flush();
 assert.equal(h.document.querySelector('#version-label').textContent,'v9.8.7');h.dom.window.close();
});
// 中文注释：自动流程只需点击已有开关，没有网站或选择器表单。
test('自动屏蔽开关无需填写 origin 或选择器',async()=>{
 const h=await mount({connected:false,tasks:[]});
 assert.match(h.document.querySelector('#filter-label').textContent,/自动屏蔽/);
 assert.match(h.document.querySelector('#filter-help').textContent,/无须配置网站或选择器/);
 assert.equal(h.document.querySelector('#shield-settings'),null);
 h.document.querySelector('#filter-toggle').click();await h.flush();
 assert.equal(h.document.querySelector('#filter-toggle').getAttribute('aria-checked'),'true');
 assert.match(h.document.querySelector('#filter-detail').textContent,/自动识别/);
 assert.equal(h.calls.some(call=>call.type.startsWith('page_content_shield')),false);h.dom.window.close();
});
