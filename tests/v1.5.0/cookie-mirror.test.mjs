// 中文注释：只用合成 Cookie，覆盖私有分块与浏览器 API 的离线实现。
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {CookieMirror,siteOf,groupSites,splitCookies,setDetails,CHUNK_LIMIT,validSite,cookieUrl} from '../../native-extension/cookie-mirror.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';
import {createApprovalNotifier} from '../../native-extension/approval-notifier.mjs';
import {readFile} from 'node:fs/promises';
const SECRET=['SECRET','COOKIE','VALUE','xyz'].join('_');
const id='a'.repeat(32),now=1000000;
const cookie=(more={})=>({name:'login',value:SECRET,domain:'a.example.com',hostOnly:true,path:'/',secure:true,httpOnly:true,sameSite:'lax',session:true,storeId:'0',...more});
function api(cookies=[],{fail=()=>false,missing=()=>false}={}){
 const written=[],removed=[],reads=[];
 return {written,removed,reads,extension:{inIncognitoContext:false},cookies:{getAll:async options=>{reads.push(options);return [...cookies,...written.filter(c=>!missing(c))];},set:async details=>{if(fail(details))throw Error(SECRET);const c=cookie({...details,domain:details.domain||new URL(details.url).hostname});written.push(c);return c;},remove:async details=>{removed.push(details);return {url:details.url,name:details.name};}}};
}
const params=more=>({transferId:id,expiresAt:now+60000,sites:['example.com'],options:{},source:{browser:'chrome',instanceId:'s'},target:{browser:'edge',instanceId:'t'},...more});
test('站点分组：子域、多段后缀、IP、localhost 和过期过滤',()=>{
 assert.equal(siteOf('.a.example.co.uk'),'example.co.uk');assert.equal(siteOf('.a.example.com.cn'),'example.com.cn');assert.equal(siteOf('.a.example.com'),'example.com');assert.equal(siteOf('127.0.0.1'),'127.0.0.1');assert.equal(siteOf('localhost'),'localhost');assert.equal(siteOf('[::1]'),'[::1]');assert.ok(validSite('[::1]'));assert.equal(cookieUrl(cookie({domain:'[::1]'})),'https://[::1]/');
 const rows=groupSites([cookie(),cookie({domain:'.example.com',session:false,httpOnly:false}),cookie({domain:'gone.test',expirationDate:now/1000-1}),cookie({domain:'.shop.co.uk'})],now);
 assert.deepEqual(rows,[{site:'example.com',count:2,httpOnly:true,session:true},{site:'shop.co.uk',count:1,httpOnly:true,session:true}]);
});
test('分块用序列化 UTF-8 字节限制并完整重组，含 Unicode 和信封空间',()=>{
 const cookies=Array.from({length:180},(_,n)=>cookie({name:String(n),value:'汉字😀'.repeat(400)}));const chunks=splitCookies(cookies);assert.ok(chunks.length>1);
 for(const [index,chunk] of chunks.entries())assert.ok(Buffer.byteLength(JSON.stringify({id:'srv:'+id,method:'browser.cookie_mirror.stage',params:{transferId:id,index,cookies:chunk}}))<=CHUNK_LIMIT);
 assert.deepEqual(chunks.flat(),cookies);assert.throws(()=>splitCookies([cookie({value:'x'.repeat(CHUNK_LIMIT)})]),/CAPACITY/);
});
test('写入保留 host-only、sameSite、expires、分区与前缀，默认不持久化会话',()=>{
 const local=cookie({domain:'127.0.0.1',partitionKey:{topLevelSite:'http://127.0.0.1',hasCrossSiteAncestor:false}});assert.equal(setDetails(local).url,'http://127.0.0.1/');assert.equal(setDetails(local).secure,true);assert.equal(setDetails({...local,domain:'example.com'}).url,'https://example.com/');
 assert.equal(setDetails(cookie()).domain,undefined);assert.equal(setDetails(cookie()).expirationDate,undefined);
 assert.equal(setDetails(cookie(),{persistDays:7},now).expirationDate,now/1000+7*86400);
 const c=cookie({domain:'.example.com',hostOnly:false,session:false,expirationDate:9000,path:'/app',partitionKey:{topLevelSite:'https://example.com',hasCrossSiteAncestor:true}}),d=setDetails(c);
 assert.equal(d.domain,c.domain);assert.equal(d.expirationDate,9000);assert.deepEqual(d.partitionKey,c.partitionKey);assert.equal(d.url,'https://example.com/app');assert.equal(d.sameSite,'lax');assert.equal(d.storeId,undefined);
 assert.throws(()=>setDetails(cookie({name:'__Host-login',domain:'.example.com',hostOnly:false})),/PREFIX/);assert.throws(()=>setDetails(cookie({name:'__Secure-login',secure:false})),/PREFIX/);
});
test('全部访问也必须确认；单块取走删除，不重放；不包含未选择站点',async()=>{
 const chrome=api([cookie(),cookie({domain:'other.test'}),cookie({expirationDate:now/1000-1})]);chrome.browserFullConsent=true;
 const mirror=new CookieMirror(chrome,{now:()=>now});const metadata=await mirror.prepare(params());assert.equal(metadata.count,1);assert.ok(!JSON.stringify(metadata).includes(SECRET));
 assert.throws(()=>mirror.take({transferId:id,index:0}),/DENIED/);assert.equal(mirror.approvals('s',1)[0].kind,'cookie_mirror');mirror.approve(id);
 assert.equal(mirror.take({transferId:id,index:0}).cookies.length,1);assert.equal(mirror.get(id).chunks.length,0);assert.throws(()=>mirror.take({transferId:id,index:0}),/DENIED/);mirror.disconnect();assert.equal(mirror.transfers.size,0);assert.deepEqual(chrome.reads[0],{partitionKey:{}});
});
test('单条失败继续，回读分别报告匹配和缺失，失败异常不出结果',async()=>{
 const chrome=api([],{fail:d=>d.name==='bad',missing:c=>c.name==='missing'}),mirror=new CookieMirror(chrome,{now:()=>now});
 mirror.begin(params({chunks:1,options:{clearTarget:false}}));mirror.stage({transferId:id,index:0,cookies:[cookie(),cookie({name:'bad',partitionKey:{topLevelSite:'https://example.com'}}),cookie({name:'missing'})]});
 const result=await mirror.finish({transferId:id});assert.deepEqual([result.success,result.failed,result.matched,result.missing],[2,1,1,1]);assert.deepEqual(result.sites[0].reasons,{partition_write_failed:1});assert.ok(!JSON.stringify(result).includes(SECRET));assert.equal(mirror.transfers.size,0);
});
test('默认关闭清除；显式清除只匹配选中站点和分区',async()=>{
 const old=[cookie(),cookie({domain:'other.test'}),cookie({name:'p',partitionKey:{topLevelSite:'https://example.com'}})];
 for(const clearTarget of [false,true]){const chrome=api(old),mirror=new CookieMirror(chrome,{now:()=>now});mirror.begin(params({chunks:1,options:{clearTarget}}));mirror.stage({transferId:id,index:0,cookies:[cookie()]});await mirror.finish({transferId:id});assert.equal(chrome.removed.length,clearTarget?2:0);if(clearTarget)assert.deepEqual(chrome.removed[1].partitionKey,old[2].partitionKey);}
});
test('TTL 到期和断连销毁两端载荷，块序号冲突拒绝',async()=>{
 let clock=now;const mirror=new CookieMirror(api([cookie()]),{now:()=>clock});await mirror.prepare(params());clock+=60000;assert.throws(()=>mirror.get(id),/EXPIRED/);assert.equal(mirror.transfers.size,0);
 mirror.begin(params({transferId:'b'.repeat(32),expiresAt:clock+60000,chunks:1}));assert.throws(()=>mirror.stage({transferId:'b'.repeat(32),index:1,cookies:[cookie()]}),/DENIED/);mirror.disconnect();assert.equal(mirror.transfers.size,0);
});
test('私有 Bridge 不进入账本、指纹、重放缓存；固定错误不回传值',async()=>{
 let receiver;const sent=[];const port={onMessage:{addListener:fn=>receiver=fn},postMessage:m=>sent.push(m)};
 const mirror=new CookieMirror(api(),{now:()=>now});mirror.begin(params({chunks:1}));
 const bridge=new Bridge(port,{tasks:new Map()},()=>{},{onCookieMirror:(action,p)=>mirror.handle(action,p),onCookieDisconnect:()=>mirror.disconnect()});
 const message={id:'srv:'+id,method:'browser.cookie_mirror.stage',sequence:1,params:{transferId:id,index:0,cookies:[cookie()]}};
 receiver(message);await new Promise(setImmediate);assert.deepEqual(sent.at(-1).result,{accepted:true});assert.equal(bridge.seen.size,0);assert.equal(bridge.privateSeen.size,1);assert.ok(!JSON.stringify(bridge.ledger).includes(SECRET));
 receiver(message);await new Promise(setImmediate);assert.equal(sent.at(-1).error.code,'cookie_mirror_denied');assert.ok(!JSON.stringify(sent).includes(SECRET));bridge.close();assert.equal(mirror.transfers.size,0);
});
test('复用确认面板显示源、目标、完整站点和数量；native 消息不能批准',async()=>{
 const source=new CookieMirror(api([cookie()]),{now:()=>now});await source.prepare(params());
 const chrome={runtime:{id:'extension',getURL:p=>`chrome-extension://extension/${p}`},tabs:{},windows:{get:async()=>({id:1,type:'normal',left:0,top:0,width:800,height:600}),update:async()=>({id:1,focused:true}),create:async()=>({id:2,focused:true,tabs:[{id:3}]}),remove:async()=>{}},action:{}};
 const notifier=createApprovalNotifier({chrome,instanceId:'s',now:()=>now});await notifier.sync(source.approvals('s',1));const sender={id:'extension',url:chrome.runtime.getURL('approval-panel.html'),tab:{id:3,windowId:2}};
 const view=notifier.viewFor(sender);assert.equal(view.count,1);assert.equal(view.source.browser,'chrome');assert.equal(view.target.browser,'edge');assert.ok(!JSON.stringify(view).includes(SECRET));
 await assert.rejects(notifier.decide({sender:{id:'extension',url:chrome.runtime.getURL('popup.html')},requestId:id,decision:'approve',verify:async()=>true,dispatch:async()=>source.approve(id)}),/untrusted/);
 assert.throws(()=>source.take({transferId:id,index:0}),/DENIED/);await notifier.dispose();source.disconnect();
});
test('源确认路由与隐私模块在注入声明之外；key 和新增权限用途受打包契约保护',async()=>{
 const [bg,manifest,build]=await Promise.all(['background.mjs','manifest.json','build.mjs'].map(f=>readFile(new URL('../../native-extension/'+f,import.meta.url),'utf8')));
 assert.match(bg,/if\(r.kind==='cookie_mirror'\)/);assert.match(bg,/cookieMirror.approve\(r.id\)/);assert.match(bg,/isUiSender/);const m=JSON.parse(manifest);const extensionId=[...createHash('sha256').update(Buffer.from(m.key,'base64')).digest('hex').slice(0,32)].map(n=>String.fromCharCode(97+parseInt(n,16))).join('');assert.equal(extensionId,'dhioigkigkkhceflkkkmoljhdaefjohb');assert.equal(m.version,'1.7.1');assert.ok(m.permissions.includes('cookies'));assert.deepEqual(m.host_permissions,['<all_urls>']);assert.match(build,/'cookie-mirror.mjs': path.join\(source, 'cookie-mirror.mjs'\)/);
});

// 中文注释：删除弹窗专用通路后，原生 Cookie API 和源扩展确认仍保留。
test('Cookie 镜像只在 Hermes 插件页显示，后台保留原生复制与确认通路',async()=>{
 const [html,script,css,bg,desktop]=await Promise.all([
  'native-extension/popup.html','native-extension/popup.mjs','native-extension/popup.css',
  'native-extension/background.mjs','executor-plugin/desktop/plugin.js',
 ].map(file=>readFile(new URL('../../'+file,import.meta.url),'utf8')));
 assert.doesNotMatch(html,/id="cookie-(?:mirror|desktop|pending)"|href="hermes:\/\/open\/browser-link"/);
 assert.match(desktop,/const ROOT = '\/browser-link'/);
 assert.match(desktop,/Cookie 镜像/);
 assert.doesNotMatch(script,/cookie_mirror_pending/);assert.match(bg,/cookie_mirror_pending/);
 for(const source of [html,script,css])assert.doesNotMatch(source,/cookie-(?:load|search|all|none|sites|target|clear|persist|days|copy|status|results)\b/);
 for(const source of [script,bg])assert.doesNotMatch(source,/cookie_mirror_(?:sites|request|status)|cookieMirrorLast|cookieMirrorTransfer|pollCookieMirror|renderCookieTargets/);
 assert.doesNotMatch(bg,/extension\.browser_list/);
 assert.match(bg,/onCookieMirror:\(method,p\)=>cookieMirror.handle\(method,p\)/);
 assert.match(bg,/extension\.cookie_mirror\.decide/);
 assert.match(bg,/extension\.cookie_mirror\.status/);
});
