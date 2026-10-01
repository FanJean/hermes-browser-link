// 中文注释：自然语言任务验收用的本机合成站点。页面把实际发生的业务事件回报给服务器，
// 验收以服务器记录为准，不以模型自述为准。只监听 127.0.0.1，另用 localhost 作为跨源 frame。
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

const port = Number(process.argv.find(value => value.startsWith('--port='))?.slice(7) || 18765);
const eventsFile = process.argv.find(value => value.startsWith('--events='))?.slice(9);
const events = [];
const record = async event => {
  events.push({at: new Date().toISOString(), ...event});
  if (eventsFile) await writeFile(eventsFile, JSON.stringify(events, null, 2) + '\n');
};
// 中文注释：页面实例与事件序号用于分辨一次点击被重复投递，还是同一页实际触发了两次处理函数。
const report = `const pageRun=crypto.randomUUID();let eventSequence=0;const report=(type,data={})=>fetch('http://127.0.0.1:${port}/event',{method:'POST',body:JSON.stringify({type,pageRun,eventSequence:++eventSequence,...data})});`;
const shell = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;margin:24px;max-width:760px}button,select,input{margin:6px;padding:8px}</style>${body}`;
const REPORT_BYTES = Buffer.from('区域,销售额\n华东,1200\n华南,980\n');

const pages = {
  '/shop': shell('合成商店', `<h1>结算</h1>
<label>配送方式 <select id="ship"><option value="std">标准</option><option value="fast">加急</option><option value="pickup">自提</option></select></label>
<label><input type="checkbox" id="terms"> 同意条款</label>
<p>请在下方确认框中提交订单。</p>
<iframe id="confirm-frame" src="http://localhost:${port}/confirm" style="width:420px;height:120px;border:1px solid #999"></iframe>
<p id="order">尚未下单</p>
<script>${report}
window.addEventListener('message',e=>{
 if(e.origin!=='http://localhost:${port}'||e.data?.type!=='confirm')return;
 const ship=document.getElementById('ship').value,terms=document.getElementById('terms').checked;
 if(!terms){document.getElementById('order').textContent='请先同意条款';report('order_rejected',{ship,terms});return;}
 const id='HX-'+(ship==='fast'?'7731':'1002');document.getElementById('order').textContent='订单号 '+id;
 report('order_confirmed',{ship,terms,id,trusted:e.data.trusted});
});
</script>`),
  '/confirm': shell('确认', `<button id="go">确认订单</button><script>document.getElementById('go').onclick=e=>parent.postMessage({type:'confirm',trusted:e.isTrusted},'*')</script>`),
  '/files': shell('文件中心', `<h1>文件中心</h1>
<label>上传附件 <input type="file" id="upload" aria-label="上传附件"></label><p id="upload-status">未上传</p>
<p><a id="report" href="/download/sales.csv">下载销售报表</a></p>
<script>${report}
document.getElementById('upload').onchange=async e=>{const file=e.target.files[0];if(!file)return;
 const buf=await file.arrayBuffer();await fetch('/upload?name='+encodeURIComponent(file.name),{method:'POST',body:buf});
 document.getElementById('upload-status').textContent='已上传 '+file.name+' ('+buf.byteLength+' 字节)';};
</script>`),
  '/pointer': shell('指针', `<h1>签到</h1><div id="pad" style="position:relative;height:80px"><button id="start">开始签到</button></div><p id="state">未签到</p>
<div id="host"></div>
<script>${report}
let down=false;const start=document.getElementById('start');
start.addEventListener('pointerdown',()=>{down=true});
start.addEventListener('pointerup',e=>{if(down&&e.isTrusted){document.getElementById('state').textContent='签到成功';report('pointer_checkin',{trusted:true})}down=false});
const root=document.getElementById('host').attachShadow({mode:'closed'});root.innerHTML='<button>领取积分</button>';
root.querySelector('button').onclick=e=>{document.getElementById('state').textContent+='，积分已领取';report('closed_shadow_click',{trusted:e.isTrusted})};
</script>`),
  '/data': shell('数据', `<h1>内部数据</h1><p>页面不展示总额。</p><script>window.__orderTotal=4321.5;</script>`),
  '/resume': shell('中断续跑', `<h1>两步任务</h1><button id="first">完成第一步</button><button id="second" disabled>完成第二步</button><p id="state">未开始</p>
<script>${report}
let firstCount=0,secondCount=0;
document.getElementById('first').onclick=()=>{firstCount++;report('resume_step1',{count:firstCount});document.getElementById('state').textContent='第一步已完成';
 setTimeout(()=>{document.getElementById('second').disabled=false},20000)};
document.getElementById('second').onclick=()=>{secondCount++;report('resume_step2',{count:secondCount});document.getElementById('state').textContent='两步均已完成'};
</script>`),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === 'POST' && url.pathname === '/event') {
    let body = ''; for await (const chunk of req) body += chunk;
    try { await record({source: 'page', ...JSON.parse(body)}); } catch { await record({source: 'page', type: 'invalid_event'}); }
    res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('ok');
  }
  if (req.method === 'POST' && url.pathname === '/upload') {
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of req) { hash.update(chunk); size += chunk.length; }
    await record({source: 'server', type: 'upload_received', name: url.searchParams.get('name'), size, sha256: hash.digest('hex')});
    return res.end('ok');
  }
  if (url.pathname === '/download/sales.csv') {
    await record({source: 'server', type: 'download_served', sha256: createHash('sha256').update(REPORT_BYTES).digest('hex')});
    res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sales.csv"'});
    return res.end(REPORT_BYTES);
  }
  const page = pages[url.pathname];
  if (!page) { res.writeHead(404); return res.end('not found'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page);
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({listening: `http://127.0.0.1:${port}`, crossOrigin: `http://localhost:${port}`})));
