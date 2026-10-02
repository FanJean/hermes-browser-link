// 中文注释：手动运行；只启动临时 Chrome/Edge profiles，不读取个人 Cookie。
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {openRealSession} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
import {createCookieFixture} from './fixture-site.mjs';
const server=createCookieFixture();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let source,target;
const uiCall=(session,message)=>session.ui.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)}).then(r=>r.result)`);
const open=async(session,url)=>{
 await session.ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(url)}}).then(()=>true)`);
 return waitFor(()=>session.readUrl(url,`document.readyState==='complete'`));
};
try{
 source=await openRealSession({browser:'chrome',label:'cookie150s',headed:process.argv.includes('--headed')});
 target=await openRealSession({browser:process.argv.includes('--same-browser')?'chrome':'edge',label:'cookie150t',headed:process.argv.includes('--headed'),sharedWith:source});
 await source.enableFullAccess();
 await open(target,`${origin}/protected`);
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 await open(source,`${origin}/login`);
 const site='127.0.0.1',sourceId=(await source.instance()).instanceId,targetId=(await target.instance()).instanceId;
 assert.notEqual(sourceId,targetId);
 const rows=await source.rpc('cookie150','cookie_mirror',{action:'list_sites',source:sourceId});
 assert.equal(rows.sites.find(r=>r.site===site)?.count,3,'夹具必须包含普通、httpOnly 会话和分区 Cookie；检查浏览器回环 Secure 支持');
 // 中文注释：先覆盖 Hermes 请求与拒绝；全访问不能直接派发 Cookie。
 const denied=await source.rpc('cookie150','cookie_mirror',{action:'request_mirror',source:sourceId,target:targetId,sites:[site]});
 await source.approvePanel('reject','将复制登录态到目标浏览器');
 await waitFor(async()=> (await source.rpc('cookie150','cookie_mirror',{action:'status',transfer_id:denied.transferId})).status==='denied');
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 // 中文注释：主入口使用真实点击发起，第二次真实点击发生在独立扩展确认面板。
 // 中文注释：拒绝面板关闭后弹窗会重新同步连接状态，等读取按钮可用再真实点击，避免点到禁用按钮。
 await waitFor(()=>source.ui.evaluate(`document.querySelector('#cookie-load').disabled===false`));
 await source.clickPopup('#cookie-load');
 await waitFor(()=>source.ui.evaluate(`Boolean(document.querySelector('input[data-site="${site}"]'))`));
 await source.clickPopup(`input[data-site="${site}"]`);
 await source.ui.evaluate(`document.querySelector('#cookie-target').value=${JSON.stringify(targetId)}`);
 // 中文注释：弹窗每 1.5 秒刷新目标列表，按钮可能短暂禁用；等可用再点，并确认已发起新请求。
 await waitFor(()=>source.ui.evaluate(`document.querySelector('#cookie-copy').disabled===false`));
 await source.clickPopup('#cookie-copy');
 await waitFor(()=>source.ui.evaluate(`!document.querySelector('#cookie-status').textContent.startsWith('用户拒绝')`));
 // 中文注释：面板需要先把源窗口切到前台；两个浏览器抢焦点时会退回角标。此时按产品的补救入口「打开待确认面板」再批准。
 let fallbackUsed=false;
 try{await source.approvePanel('approve','Cookie 镜像');}
 catch{fallbackUsed=true;await source.clickPopup('#cookie-pending');await source.approvePanel('approve','Cookie 镜像');}
 await waitFor(()=>source.ui.evaluate(`document.querySelector('#cookie-status').textContent.startsWith('复制完成')`),30000);
 const summary=await source.ui.evaluate(`document.querySelector('#cookie-results').textContent`);
 assert.match(summary,/成功 3 \/ 失败 0/);assert.match(summary,/回读匹配 3 \/ 缺失 0/);
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
 console.log(JSON.stringify({ok:true,panelFallback:fallbackUsed,leakScan:'clean',scannedFiles:scanned.length,daemonFiles:scanned.filter(file=>file.includes('browser-link-native')).map(file=>path.basename(file)).slice(0,12),source:'chrome',target:target.browser,site,count:3,success:3,failed:0,matched:3,missing:0,authenticated:true,partitioned:true}));
}finally{
 await target?.close();await source?.close();await new Promise(resolve=>server.close(resolve));
}
