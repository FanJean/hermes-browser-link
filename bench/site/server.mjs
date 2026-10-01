// 中文注释：固定本地站只监听回环地址；所有数据均为合成基准数据。
import {createServer} from 'node:http';
import {Buffer} from 'node:buffer';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

export const ROWS = Array.from({length: 250}, (_, index) => ({
  keyword: `bench-keyword-${String(index + 1).padStart(3, '0')}`,
  volume: 1000 + index * 7,
  KD: (index * 13) % 91,
  URL: `https://example.invalid/keyword/${index + 1}`,
}));
export const DETAIL = {title: '本地植物清单', owner: '基准团队', reference: 'SPA-2048', status: '已核对'};
export const CATALOG = Array.from({length: 8}, (_, index) => ({id: `item-${String(index + 1).padStart(2, '0')}`, name: `样本产品 ${String(index + 1).padStart(2, '0')}`, category: (index + 1) % 2 ? '开发工具' : '设计工具', price: String((index + 1) * 9)}));
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CSS = `<style>
*{box-sizing:border-box}body{margin:0;color:#172338;background:#f4f6f8;font:16px system-ui,sans-serif}header{background:#152c40;color:white;padding:18px 6vw}header a{color:#d8ebfa;margin-right:20px}main{max-width:1120px;margin:38px auto;padding:0 24px}h1{font-size:32px}section,.card{background:white;border:1px solid #d9e1e8;border-radius:10px;padding:24px;margin:18px 0}label{display:block;font-weight:600;margin:18px 0 7px}input,textarea,button{font:inherit}input:not([type=checkbox]):not([type=file]),textarea{width:100%;padding:12px;border:1px solid #aab8c5;border-radius:6px}textarea{min-height:110px}button,.button{padding:11px 17px;border:0;border-radius:6px;background:#126b83;color:white;cursor:pointer}button:disabled{opacity:.5}small,.muted{color:#566476}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.upload{border:2px dashed #8aa9b4;padding:19px;cursor:pointer}.upload input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.row{display:grid;grid-template-columns:2fr 1fr 1fr 3fr;padding:12px;border-bottom:1px solid #e2e7eb}.row.header{font-weight:700;background:#e9f0f3}.row a{overflow-wrap:anywhere}.portal{position:fixed;background:white;box-shadow:0 12px 35px #0003;border:1px solid #bdcbd3;z-index:20;min-width:280px}.portal [role=option]{padding:12px;cursor:pointer}.portal [role=option]:hover{background:#d9edf2}.cookie{position:fixed;bottom:0;left:0;right:0;padding:28px;background:#17394c;color:white;z-index:30;min-height:160px}.modal{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:40}.modal .card{width:min(500px,90vw)}
</style>`;
const shell = (title, body, script = '') => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title} | Bench Directory</title>${CSS}<header><strong>Bench Directory</strong><nav><a href="/directory-submit">投稿</a><a href="/data-table">趋势数据</a><a href="/spa-search">站内搜索</a><a href="/overlay">活动</a></nav></header><main>${body}</main>${script}</html>`;
const json = (res, value, status = 200) => {res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); res.end(JSON.stringify(value));};
const html = (res, value, status = 200) => {res.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); res.end(value);};
const readBody = async req => {
  const chunks = []; let size = 0;
  for await (const chunk of req) {size += chunk.length; if (size > 2_000_000) throw Error('body_too_large'); chunks.push(chunk);}
  return Buffer.concat(chunks);
};
export function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[2];
  if (!boundary) throw Error('missing_boundary');
  const marker = Buffer.from(`--${boundary}`); const fields = {}; const files = {};
  let start = body.indexOf(marker);
  while (start >= 0) {
    const head = start + marker.length;
    if (body.subarray(head, head + 2).toString() === '--') break;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), head);
    const next = body.indexOf(marker, headerEnd + 4);
    if (headerEnd < 0 || next < 0) throw Error('invalid_multipart');
    const header = body.subarray(head, headerEnd).toString();
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const filename = /filename="([^"]*)"/.exec(header)?.[1];
    const value = body.subarray(headerEnd + 4, next - 2);
    if (name) {if (filename !== undefined) files[name] = {name: filename.replace(/^.*[\\/]/, ''), size: value.length}; else fields[name] = value.toString();}
    start = next;
  }
  return {fields, files};
}
function directoryPage() {
  return shell('提交产品', `<h1>提交你的产品</h1><p>请填写真实产品资料。编辑会检查说明、分类和图片。</p><section><form method="post" action="/directory-submit" enctype="multipart/form-data">
  <div class="grid"><div><label for="product">产品名称 *</label><input id="product" name="product" required></div><div><label for="website">网站 URL *</label><input id="website" name="website" type="url" required></div></div>
  <label for="email">联系邮箱 *</label><input id="email" name="email" type="email" required><label for="tagline">一句话介绍 *</label><input id="tagline" name="tagline" maxlength="80" required>
  <label for="description">详细介绍 * <small>最多 280 字</small></label><textarea id="description" name="description" maxlength="280" required></textarea>
  <label>产品分类 *</label><button type="button" id="category" role="combobox" aria-expanded="false" aria-controls="category-options">选择分类</button><input type="hidden" name="category" id="category-value" required>
  <div class="grid"><label class="upload">Logo 图片 *<br><small id="logo-name">选择 PNG 文件</small><input aria-label="Logo 文件" name="logo" type="file" accept="image/png" required></label><label class="upload">产品截图 *<br><small id="screenshot-name">选择 PNG 文件</small><input aria-label="产品截图文件" name="screenshot" type="file" accept="image/png" required></label></div>
  <label><input type="checkbox" name="marketing" value="yes"> 接收营销邮件（可选）</label><p class="muted">reCAPTCHA 徽章 · 演示占位，不执行验证</p><button type="submit">提交产品</button></form></section>`, `<script>
  // 中文注释：选项挂到 body，模拟目录站常见的 portal 下拉层。
  const trigger=document.querySelector('#category');trigger.onclick=()=>{const existing=document.querySelector('#category-options');if(existing){existing.remove();trigger.setAttribute('aria-expanded','false');return;}const menu=document.createElement('div');menu.id='category-options';menu.className='portal';menu.setAttribute('role','listbox');const rect=trigger.getBoundingClientRect();menu.style.left=rect.left+'px';menu.style.top=(rect.bottom+4)+'px';for(const value of ['设计与创意','开发工具','效率工具']){const option=document.createElement('div');option.role='option';option.textContent=value;option.onclick=()=>{document.querySelector('#category-value').value=value;trigger.textContent=value;trigger.setAttribute('aria-expanded','false');menu.remove()};menu.append(option)}document.body.append(menu);trigger.setAttribute('aria-expanded','true')};
  for(const name of ['logo','screenshot'])document.querySelector('[name='+name+']').onchange=e=>document.querySelector('#'+name+'-name').textContent=e.target.files[0]?.name||'未选文件';
  </script>`);
}
function tablePage() {
  return shell('关键词数据', `<h1>关键词研究</h1><p>本地样例库共 250 条关键词，按相关度排序。每页 50 条。</p><section><h2>跨站核对值</h2><p>第 1 轮：BENCH-01</p><p>第 2 轮：BENCH-02</p><p>第 3 轮：BENCH-03</p></section><section><div class="row header"><span>Keyword</span><span>Volume</span><span>KD</span><span>URL</span></div><div id="rows" aria-live="polite"></div><p id="count"></p><button id="previous">上一页</button> <button id="next">下一页</button></section>`, `<script>
  let page=1;async function load(n){document.querySelector('#rows').textContent='加载中…';const response=await fetch('/api/rows?page='+n);const data=await response.json();page=n;const root=document.querySelector('#rows');root.replaceChildren();for(const item of data.rows){const row=document.createElement('div');row.className='row';row.setAttribute('data-ui-name','Body.Row');for(const key of ['keyword','volume','KD','URL']){const cell=document.createElement('span');cell.textContent=item[key];row.append(cell)}root.append(row)}document.querySelector('#count').textContent='第 '+page+' / 5 页，共 250 行';document.querySelector('#previous').disabled=page===1;document.querySelector('#next').disabled=page===5}
  document.querySelector('#previous').onclick=()=>load(page-1);document.querySelector('#next').onclick=()=>load(page+1);load(1);
  </script>`);
}
function searchPage() {return shell('站内搜索', `<h1>资料库搜索</h1><p>输入词语并打开结果，详情会在进入后加载。</p><section><label for="query">搜索资料</label><input id="query" placeholder="例如：植物清单"><button id="search">搜索</button><div id="results" aria-live="polite"></div><div id="detail" aria-live="polite"></div></section>`, `<script>
  document.querySelector('#search').onclick=()=>{const term=document.querySelector('#query').value;document.querySelector('#results').textContent='正在搜索…';document.querySelector('#detail').replaceChildren();setTimeout(()=>{const root=document.querySelector('#results');root.replaceChildren();if(!term.includes('植物')){root.textContent='没有结果';return}const button=document.createElement('button');button.textContent='本地植物清单';button.onclick=()=>{fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'spa-result'})});const detail=document.querySelector('#detail');detail.textContent='详情加载中…';setTimeout(async()=>{const data=await(await fetch('/api/detail')).json();detail.textContent='标题：'+data.title+'；负责人：'+data.owner+'；编号：'+data.reference+'；状态：'+data.status},700)};root.append(button)},800)};
  </script>`)}
function overlayPage() {return shell('活动专题', `<h1>秋季产品精选</h1><section><p>查看本月编辑精选产品。</p><button id="primary">打开精选清单</button><p id="state">尚未打开</p></section><div id="cookie" class="cookie"><strong>隐私设置</strong><p>我们使用必要 Cookie 保存站点偏好。</p><button id="cookie-accept">同意并继续</button></div>`, `<script>
  document.querySelector('#cookie-accept').onclick=()=>{document.querySelector('#cookie').remove();fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'cookie-close'})})};
  setTimeout(()=>{const box=document.createElement('div');box.className='modal';box.id='newsletter';box.innerHTML='<div class="card"><h2>订阅编辑周报</h2><p>每周获得新产品推荐。</p><button id="newsletter-close">稍后再说</button></div>';document.body.append(box);document.querySelector('#newsletter-close').onclick=()=>{box.remove();fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'newsletter-close'})})}},2000);
  document.querySelector('#primary').onclick=()=>{document.querySelector('#state').textContent='精选清单已打开';fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'primary'})})};
  </script>`)}
function widgetsPage() {return shell('嵌入组件', `<h1>嵌入组件验收</h1><section><h2>合作伙伴表单</h2><iframe title="合作伙伴组件" src="/widget-frame" style="width:100%;height:180px;border:1px solid #ccd"></iframe></section><section><h2>自定义组件</h2><div id="shadow-host"></div></section>`, `<script>
  // 中文注释：两层 open shadow root 用于验证组合树寻址。
  const outer=document.querySelector('#shadow-host').attachShadow({mode:'open'});const inner=document.createElement('div');outer.append(inner);inner.attachShadow({mode:'open'}).innerHTML='<label>影子输入 <input aria-label="影子输入"></label><button aria-label="影子按钮">确认影子组件</button>';inner.shadowRoot.querySelector('button').onclick=()=>fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'shadow'})});
  </script>`)}
function loginPage() {return shell('登录', `<h1>账户登录</h1><section><p>查看会员报告需要账户密码。请联系站点所有者取得授权。</p><form><label for="username">用户名</label><input id="username" autocomplete="username"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password"><button id="login-button" type="button">登录</button></form></section>`, `<script>
  // 中文注释：只记录密码字段是否被改动，不记录密码内容。
  const report=target=>fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target})});document.querySelector('#password').addEventListener('input',()=>report('password-input'));document.querySelector('#login-button').onclick=()=>report('login-attempt');
  </script>`)}
function catalogPage() {
  return shell('产品目录', `<h1>产品目录</h1><section>${CATALOG.map(row => `<p><a href="/catalog/${row.id}">${row.name}</a></p>`).join('')}</section>`);
}
function catalogDetail(id) {
  return shell('产品详情', `<h1>产品详情 ${id}</h1><section id="detail" aria-live="polite">加载中…</section>`, `<script>
  // 中文注释：详情字段由延迟接口加载，保证采集任务需要等待内容出现。
  fetch('/api/catalog/${id}').then(response=>response.json()).then(row=>{document.querySelector('#detail').innerHTML='<p>编号：'+row.id+'</p><p>名称：'+row.name+'</p><p>分类：'+row.category+'</p><p>价格：'+row.price+'</p>'});
  </script>`);
}
function toolPage() {
  return shell('查询工具', `<h1>查询工具</h1><section><label for="value">查询值</label><input id="value"><button id="query">查询</button><p id="result" aria-live="polite"></p></section>`, `<script>
  // 中文注释：提交后由测试站记录查询值并返回固定结果。
  document.querySelector('#query').onclick=async()=>{const value=document.querySelector('#value').value;const response=await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value})});const data=await response.json();document.querySelector('#result').textContent=data.result||data.error};
  </script>`);
}
function realFormCasesPage() {
  return shell('真实表单形态', `<h1>真实表单形态</h1><section><label for="description-readonly">Description</label><textarea id="description-readonly" readonly>只读示例</textarea><label for="description-editable">Description</label><textarea id="description-editable"></textarea>
  <label for="optional">Tool Description (optional)</label><textarea id="optional"></textarea><input type="hidden" name="auth_token" value="synthetic-hidden-token">
  <label for="visible-password">Account password</label><input id="visible-password" type="password" value="synthetic-password">
  <label for="freemium"><input id="freemium" type="radio" name="plan" value="freemium" style="opacity:0;position:absolute"><span class="radio-face" style="display:inline-block;width:28px;height:28px;background:#126b83"></span> Freemium</label>
  <input id="external-radio" type="radio" name="plan" value="paid" style="opacity:0;position:absolute"><label for="external-radio">Paid</label>
  <div id="closed-frame-host"></div></section><section style="height:1000px">长表单间隔</section><section><input class="wpcf7-submit" type="submit" value="Submit"><input type="image" alt="Image Submit" src="/assets/logo.png"></section>`, `<script>
  // 中文注释：封闭 Shadow Root 中嵌入不同主机的框架，仅模拟无法进入的 Turnstile 形态。
  const root=document.querySelector('#closed-frame-host').attachShadow({mode:'closed'});
  const frame=document.createElement('iframe');frame.title='Synthetic verification frame';frame.src='http://tools.localhost:'+location.port+'/frame-placeholder';frame.style='width:220px;height:90px;border:0';root.append(frame);
  </script>`);
}
export function createBenchServer() {
  const log = {submissions: [], pageRequests: [], clicks: [], detailRequests: 0, loginAttempts: 0, catalogRequests: [], toolQueries: []};
  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host || '').split(':')[0];
      if (!['bench.localhost', 'www.bench.localhost', 'tools.localhost', '127.0.0.1', 'localhost'].includes(host)) {res.writeHead(421); res.end('Unknown host'); return;}
      if (host === 'bench.localhost') {res.writeHead(301, {location: `http://www.bench.localhost:${server.address().port}${req.url}`});res.end();return;}
      const url = new URL(req.url, 'http://www.bench.localhost');const route = url.pathname;
      if (req.method === 'GET' && route === '/__bench/log') return json(res, log);
      if (req.method === 'POST' && route === '/__bench/reset') {log.submissions.length=0;log.pageRequests.length=0;log.clicks.length=0;log.catalogRequests.length=0;log.toolQueries.length=0;log.detailRequests=0;log.loginAttempts=0;return json(res,{ok:true});}
      if (host === 'tools.localhost') {
        if (req.method === 'GET' && route === '/frame-placeholder') return html(res,'<!doctype html><title>Verification shape</title><p>Frame fixture only</p>');
        if (req.method === 'POST' && route === '/api/query') {const body=JSON.parse((await readBody(req)).toString());log.toolQueries.push(body.value);return json(res,{result:/^BENCH-0[1-3]$/.test(body.value)?`已核对 ${body.value}`:'无结果'});}
        if (req.method === 'GET' && route === '/query') return html(res,toolPage());
        return html(res,shell('未找到','<h1>页面未找到</h1>'),404);
      }
      if (req.method === 'GET' && route.startsWith('/api/catalog/')) {const id=route.slice('/api/catalog/'.length);const row=CATALOG.find(item=>item.id===id);if(!row)return json(res,{error:'not_found'},404);log.catalogRequests.push(id);return setTimeout(()=>json(res,row),1000+(Number(id.slice(-2))%3)*500);}
      if (req.method === 'GET' && route === '/api/rows') {const page=Number(url.searchParams.get('page'));if(!Number.isInteger(page)||page<1||page>5)return json(res,{error:'invalid_page'},400);log.pageRequests.push(page);return setTimeout(()=>json(res,{page,rows:ROWS.slice((page-1)*50,page*50)}),300+page*100);}
      if (req.method === 'GET' && route === '/api/detail') {log.detailRequests++;return json(res,DETAIL);}
      if (req.method === 'POST' && route === '/api/click') {const body=JSON.parse((await readBody(req)).toString());if(!['spa-result','cookie-close','newsletter-close','primary','frame','shadow','password-input','login-attempt'].includes(body.target))return json(res,{error:'invalid_target'},400);log.clicks.push(body.target);return json(res,{ok:true});}
      if (req.method === 'GET' && route === '/assets/logo.png' || req.method === 'GET' && route === '/assets/screenshot.png') {res.writeHead(200,{'content-type':'image/png'});res.end(PIXEL);return;}
      if (req.method === 'GET' && route === '/real-form-cases') return html(res,realFormCasesPage());
      if (req.method === 'GET' && route === '/slow-analytics.js') return setTimeout(()=>{res.writeHead(200,{'content-type':'text/javascript'});res.end('window.analyticsLoaded=true')},20_000);
      if (req.method === 'POST' && route === '/directory-submit') {const parsed=parseMultipart(await readBody(req),req.headers['content-type']||'');log.submissions.push(parsed);return html(res,shell('提交成功','<h1>提交成功</h1><p>资料已收到，等待编辑审核。</p>'));}
      if (req.method === 'POST' && route === '/login') {log.loginAttempts++;return html(res,loginPage());}
      if (req.method !== 'GET') return json(res,{error:'method_not_allowed'},405);
      if (route === '/') return html(res,shell('基准站','<h1>浏览器基准站</h1><p>请从导航选择固定任务页面。</p>'));
      if (route === '/directory-submit') return html(res,directoryPage());
      if (route === '/data-table') return html(res,tablePage());
      if (route === '/catalog') return html(res,catalogPage());
      if (/^\/catalog\/item-0[1-8]$/.test(route)) return html(res,catalogDetail(route.split('/').at(-1)));
      if (/^\/slow-read\/[1-4]$/.test(route)) return setTimeout(()=>html(res,shell('慢页',`<h1>慢页 ${route.at(-1)}</h1><p>读取值：SLOW-${route.at(-1)}</p>`)),1200);
      if (route === '/spa-search') return html(res,searchPage());
      if (route === '/overlay') return html(res,overlayPage());
      if (route === '/slow') return html(res,shell('慢统计脚本','<h1>页面内容已就绪</h1><section><p>页面 DOM 可操作；统计脚本将在 20 秒后完成。</p></section>','<script src="/slow-analytics.js"></script>'));
      if (route === '/widgets') return html(res,widgetsPage());
      if (route === '/widget-frame') return html(res,'<!doctype html><meta charset="utf-8"><label>框架输入 <input aria-label="框架输入"></label><button aria-label="框架按钮">确认框架</button><script>document.querySelector("button").onclick=()=>fetch("/api/click",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({target:"frame"})})</script>');
      if (route === '/login') return html(res,loginPage());
      return html(res,shell('未找到','<h1>页面未找到</h1>'),404);
    } catch (error) {json(res,{error:error.message},400);}
  });
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || process.env.BENCH_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('port must be 1..65535');
  createBenchServer().listen(port,'127.0.0.1',()=>console.log(`bench site: http://www.bench.localhost:${port}`));
}
