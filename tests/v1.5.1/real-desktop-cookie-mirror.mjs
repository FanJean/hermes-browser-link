// 中文注释：手动运行；只启动临时 Chrome/Edge profiles，不读取个人 Cookie。
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openRealSession} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
import {createCookieFixture} from '../v1.5.0/fixture-site.mjs';
const server=createCookieFixture();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let source,target;
// 中文注释：请求走真实 FastAPI 路由，绑定隔离 home；不运行或安装 Hermes 桌面宿主。
const exec=promisify(execFile);
const desktop=async(method,route,body=null)=>{
 const {stdout}=await exec(process.env.HERMES_PYTHON||'python3',[path.join(import.meta.dirname,'desktop-api.py'),source.staged.hermesHome,method,route,JSON.stringify(body)],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30000});
 const response=JSON.parse(stdout.trim());
 assert.equal(server.fixtureSecrets.some(secret=>stdout.includes(secret)),false,'桌面 API 响应泄漏 Cookie 值');
 assert.equal(response.status,200,'桌面 API 请求失败（不输出原始响应）');
 return response.body;
};
const open=async(session,url)=>{
 await session.ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(url)}}).then(()=>true)`);
 return waitFor(()=>session.readUrl(url,`document.readyState==='complete'`));
};
// 中文注释：后台发起也必须自动建窗，找不到面板时直接报告失败。
const decide=(decision,text)=>source.approvePanel(decision,text);
try{
 source=await openRealSession({browser:'chrome',label:'cookie151s',headed:process.argv.includes('--headed')});
 target=await openRealSession({browser:process.argv.includes('--same-browser')?'chrome':'edge',label:'cookie151t',headed:process.argv.includes('--headed'),sharedWith:source});
 await source.enableFullAccess();
 await open(target,`${origin}/protected`);
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 await open(source,`${origin}/login`);
 const site='127.0.0.1',sourceId=(await source.instance()).instanceId,targetId=(await target.instance()).instanceId;
 assert.notEqual(sourceId,targetId);
 const rows=await desktop('GET',`/shared/browsers/${sourceId}/cookie-sites`);
 assert.equal(rows.sites.find(r=>r.site===site)?.count,3,'夹具必须包含普通、httpOnly 会话和分区 Cookie；检查浏览器回环 Secure 支持');
 assert.equal(rows.sites.find(r=>r.site===site).httpOnly,true);
 assert.equal(rows.sites.find(r=>r.site===site).session,true);
 // 中文注释：先覆盖桌面请求与拒绝；全访问不能直接派发 Cookie。
 await source.background();
 const denied=await desktop('POST','/shared/cookie-mirror',{source:sourceId,target:targetId,sites:[site],options:{}});
 await decide('reject','将复制登录态到目标浏览器');
 await waitFor(async()=> (await desktop('GET',`/shared/cookie-mirror/${denied.transferId}`)).status==='denied');
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 // 中文注释：桌面发起只进入等待状态，必须保留源扩展的独立真实批准。
 await source.background();
 const requested=await desktop('POST','/shared/cookie-mirror',{source:sourceId,target:targetId,sites:[site],options:{}});
 assert.ok(['preparing','approval_required'].includes(requested.status));
 // 中文注释：后台面板可被找到；用户主动打开后才进行可信点击批准。
 await decide('approve','Cookie 镜像');
 let completed;
 await waitFor(async()=>{completed=await desktop('GET',`/shared/cookie-mirror/${requested.transferId}`);return completed.status==='completed';},30000);
 assert.deepEqual([completed.success,completed.failed,completed.matched,completed.missing],[3,0,3,0]);
 // 中文注释：只读取夹具布尔状态，不查询或打印目标 Cookie 值。
 const verified=await target.readUrl('/protected',`fetch('/protected').then(r=>r.text()).then(html=>{const d=new DOMParser().parseFromString(html,'text/html');return {authenticated:d.querySelector('#auth').dataset.authenticated==='true',partitioned:d.querySelector('#auth').dataset.partitioned==='true'};})`);
 assert.deepEqual(verified,{authenticated:true,partitioned:true});
 // 中文注释：泄漏扫描——临时环境里除浏览器 profile 自身的 Cookie 库外，任何文件和会话日志都不得出现夹具 Cookie 值。
 const secrets=server.fixtureSecrets;assert.equal(secrets.length,3);
 const leaks=[],scanned=[];
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);
  if(entry.isDirectory()){if(entry.name==='profile'&&dir.split(path.sep).length)continue;await walk(full);continue;}
  if(!entry.isFile())continue;scanned.push(full);let text;try{text=(await readFile(full)).toString('latin1');}catch{continue;}
  if(secrets.some(secret=>text.includes(secret)))leaks.push(path.relative(dir,full)||entry.name);}};
 // 中文注释：自检模式往守护进程目录写入一个夹具值，必须被扫描抓到（验证扫描本身有效）。
 if(process.env.COOKIE_LEAK_SELFTEST==='1'){const daemonDir=(await readdir(source.work,{recursive:true})).find(p=>p.endsWith('browser-link-native'));assert.ok(daemonDir,'未找到守护进程目录');await writeFile(path.join(source.work,daemonDir,'selftest-leak.txt'),secrets[0]);}
 for(const session of new Set([source,target]))await walk(session.work);
 for(const session of new Set([source,target]))if(secrets.some(secret=>String(session.logs||'').includes(secret)))leaks.push('session.logs');
 // 中文注释：反向对照——守护进程数据目录必须在扫描范围内，否则"干净"没有意义。
 assert.ok(scanned.some(file=>file.includes('browser-link-native')),'泄漏扫描未覆盖守护进程数据目录');
 assert.deepEqual(leaks,[],'Cookie 值出现在临时环境文件或日志中（仅列文件名，不打印值）');
 console.log(JSON.stringify({ok:true,panelFallback:false,entry:'desktop-api',leakScan:'clean',scannedFiles:scanned.length,daemonFiles:scanned.filter(file=>file.includes('browser-link-native')).map(file=>path.basename(file)).slice(0,12),source:'chrome',target:target.browser,site,count:3,success:3,failed:0,matched:3,missing:0,authenticated:true,partitioned:true}));
}finally{
 await target?.close();await source?.close();await new Promise(resolve=>server.close(resolve));
}
