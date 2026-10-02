// 中文注释：Cookie 只在扩展与一次性私有通路的内存中存在，不进入页面注入或存储。
export const CHUNK_LIMIT=256*1024;
export const TRANSFER_TTL=60000;
const MAX_BYTES=16*1024*1024;
// 中文注释：这是常见多段公共后缀的小表，不是完整 PSL；未知多段/私有后缀有聚合局限。
const SUFFIXES=new Set('co.uk org.uk me.uk ac.uk gov.uk com.cn net.cn org.cn gov.cn edu.cn co.jp ne.jp or.jp com.au net.au org.au edu.au co.nz org.nz co.kr co.in firm.in net.in org.in com.br com.mx com.tr com.sg com.hk com.tw com.my co.za com.ar com.pl com.ua com.ru'.split(' '));
export function siteOf(domain){
 const host=domain.replace(/^\./,'').toLowerCase();
 if(host.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(host))return host;
 const parts=host.split('.'),size=SUFFIXES.has(parts.slice(-2).join('.'))?3:2;
 return parts.slice(-size).join('.');
}
export const matchesSite=(cookie,site)=>{const host=cookie.domain.replace(/^\./,'').toLowerCase();return host===site||host.endsWith(`.${site}`);};
export const notExpired=(cookie,now=Date.now())=>cookie.expirationDate===undefined||cookie.expirationDate>now/1000;
export function groupSites(cookies,now=Date.now()){
 const groups=new Map();
 for(const c of cookies.filter(c=>notExpired(c,now))){const site=siteOf(c.domain);if(!groups.has(site))groups.set(site,{site,count:0,httpOnly:false,session:false});const row=groups.get(site);row.count++;row.httpOnly||=c.httpOnly;row.session||=c.session;}
 return [...groups.values()].sort((a,b)=>a.site.localeCompare(b.site));
}
export function validSite(site){return typeof site==='string'&&site.length<=253&&(/^([a-z0-9-]+\.)*[a-z0-9-]+$/.test(site)||/^\[[0-9a-f:]+\]$/.test(site));}
export function validateSelection(sites,options={}){
 if(!Array.isArray(sites)||!sites.length||sites.length>256||new Set(sites).size!==sites.length||sites.some(site=>!validSite(site)))throw Error('COOKIE_SCOPE_DENIED');
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['clearTarget','persistDays'].includes(k))||options.clearTarget!==undefined&&typeof options.clearTarget!=='boolean'||options.persistDays!==undefined&&(!Number.isInteger(options.persistDays)||options.persistDays<1||options.persistDays>365))throw Error('COOKIE_SCOPE_DENIED');
}
export function splitCookies(cookies){
 const chunks=[];let batch=[],batchBytes=2,totalBytes=0;
 // 中文注释：逐条累加精确 JSON UTF-8 长度，避免对大数组反复序列化。
 const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
 for(const cookie of cookies){
  const size=bytes(cookie);if(size+2>CHUNK_LIMIT-8192)throw Error('COOKIE_CAPACITY');
  if(batch.length&&batchBytes+size+1>CHUNK_LIMIT-8192){chunks.push(batch);totalBytes+=batchBytes;batch=[];batchBytes=2;}
  batchBytes+=size+(batch.length?1:0);batch.push(cookie);
 }
 if(batch.length)chunks.push(batch);
 if(totalBytes+(batch.length?batchBytes:0)>MAX_BYTES||chunks.length>128)throw Error('COOKIE_CAPACITY');
 return chunks;
}
export function cookieUrl(c){
 const host=c.domain.replace(/^\./,'');let scheme=c.secure?'https':'http';
 // 中文注释：回环 HTTP 的第一方分区 Cookie 必须保持分区的 scheme，避免 HTTPS URL 与 hasCrossSiteAncestor=false 冲突。
 if(c.secure&&c.partitionKey?.hasCrossSiteAncestor===false&&(/^(?:127\.\d+\.\d+\.\d+|localhost)$/.test(host)||host==='[::1]')){
  const partition=new URL(c.partitionKey.topLevelSite);
  if(partition.protocol==='http:'&&partition.hostname===host)scheme='http';
 }
 return `${scheme}://${host.includes(':')&&!host.startsWith('[')?`[${host}]`:host}${c.path}`;
}
export function setDetails(c,options={},now=Date.now()){
 const hostOnly=c.hostOnly===true||!c.domain.startsWith('.');
 if(c.name.startsWith('__Host-')&&(!c.secure||!hostOnly||c.path!=='/')||c.name.startsWith('__Secure-')&&!c.secure)throw Error('COOKIE_PREFIX');
 const details={url:cookieUrl(c),name:c.name,value:c.value,path:c.path,secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite};
 if(!hostOnly)details.domain=c.domain;
 if(c.session){if(options.persistDays)details.expirationDate=now/1000+options.persistDays*86400;}
 else if(c.expirationDate!==undefined)details.expirationDate=c.expirationDate;
 if(c.partitionKey)details.partitionKey={...c.partitionKey};
 return details;
}
const cookieIdentity=c=>JSON.stringify([c.name,c.domain,c.path,c.partitionKey?.topLevelSite??null,c.partitionKey?.hasCrossSiteAncestor??false]);
export class CookieMirror {
 constructor(chrome,{now=()=>Date.now(),onChanged=()=>{}}={}){this.chrome=chrome;this.now=now;this.onChanged=onChanged;this.transfers=new Map();this.used=new Set();}
 async read(){
  if(this.chrome.extension?.inIncognitoContext)throw Error('COOKIE_SCOPE_DENIED');
  // 中文注释：空 partitionKey 查询所有分区；不传 storeId，仅使用当前非隐身扩展的默认 store。
  return (await this.chrome.cookies.getAll({partitionKey:{}})).filter(c=>notExpired(c,this.now()));
 }
 async listSites(){const result={sites:groupSites(await this.read(),this.now())};if(result.sites.length>4096||new TextEncoder().encode(JSON.stringify(result)).length>900000)throw Error('COOKIE_CAPACITY');return result;}
 get(id){const t=this.transfers.get(id);if(!t||t.expiresAt<=this.now()){this.destroy(id);throw Error('COOKIE_EXPIRED');}return t;}
 destroy(id){const t=this.transfers.get(id);if(t){t.cancelled=true;clearTimeout(t.timer);t.chunks.length=0;if(t.current)t.current.length=0;this.transfers.delete(id);this.onChanged();}}
 disconnect(){for(const id of this.transfers.keys())this.destroy(id);this.used.clear();}
 install(p,t){
  if(typeof p.transferId!=='string'||!/^[a-f0-9]{32}$/.test(p.transferId)||this.used.has(p.transferId)||this.used.size>=4096||this.transfers.size>=4||!Number.isFinite(p.expiresAt)||p.expiresAt<=this.now()||p.expiresAt>this.now()+TRANSFER_TTL)throw Error('COOKIE_SCOPE_DENIED');
  this.used.add(p.transferId);Object.assign(t,{id:p.transferId,expiresAt:p.expiresAt,cancelled:false});
  t.timer=setTimeout(()=>this.destroy(p.transferId),p.expiresAt-this.now());t.timer.unref?.();this.transfers.set(p.transferId,t);return t;
 }
 async prepare(p){
  validateSelection(p.sites,p.options);
  const cookies=(await this.read()).filter(c=>p.sites.some(site=>matchesSite(c,site)));
  const rows=groupSites(cookies,this.now());
  if(rows.length!==p.sites.length||rows.some(row=>!p.sites.includes(row.site)))throw Error('COOKIE_SCOPE_DENIED');
  const t=this.install(p,{role:'source',chunks:splitCookies(cookies),approved:false,next:0,sites:rows,options:p.options,source:p.source,target:p.target});
  this.onChanged();return {sites:rows.map(({site,count})=>({site,count})),count:cookies.length,chunks:t.chunks.length};
 }
 approvals(instanceId,windowId){return [...this.transfers.values()].filter(t=>t.role==='source'&&!t.approved&&!t.cancelled&&t.expiresAt>this.now()).map(t=>({
  id:t.id,instanceId,taskId:t.id,generation:1,tabId:null,windowId,origin:`https://${t.sites[0].site}`,digest:t.id,
  action:'将复制登录态到目标浏览器',taskTitle:'Cookie 镜像',scope:'本次操作',expiresAt:t.expiresAt,kind:'cookie_mirror',
  source:t.source,target:t.target,sites:t.sites.map(({site,count})=>({site,count})),count:t.sites.reduce((n,row)=>n+row.count,0),options:t.options}));}
 approve(id){const t=this.get(id);if(t.role!=='source'||t.approved)throw Error('COOKIE_SCOPE_DENIED');t.approved=true;}
 take(p){const t=this.get(p.transferId);if(t.role!=='source'||!t.approved||p.index!==t.next||!t.chunks.length)throw Error('COOKIE_SCOPE_DENIED');t.next++;const cookies=t.chunks.shift();return {index:p.index,cookies};}
 begin(p){validateSelection(p.sites,p.options);if(!Number.isInteger(p.chunks)||p.chunks<1||p.chunks>128)throw Error('COOKIE_SCOPE_DENIED');this.install(p,{role:'target',chunks:[],next:0,total:p.chunks,bytes:0,sites:p.sites,options:p.options});return {ready:true};}
 stage(p){
  const t=this.get(p.transferId);const bytes=new TextEncoder().encode(JSON.stringify(p)).length;
  if(t.role!=='target'||p.index!==t.next||t.next>=t.total||!Array.isArray(p.cookies)||!p.cookies.length||bytes>CHUNK_LIMIT||t.bytes+bytes>MAX_BYTES||p.cookies.some(c=>!t.sites.some(site=>matchesSite(c,site))))throw Error('COOKIE_SCOPE_DENIED');
  t.bytes+=bytes;t.next++;t.chunks.push(p.cookies);return {accepted:true};
 }
 async finish(p){
  const t=this.get(p.transferId);if(t.role!=='target'||t.next!==t.total)throw Error('COOKIE_SCOPE_DENIED');
  const live=()=>{if(t.cancelled||t.expiresAt<=this.now())throw Error('COOKIE_EXPIRED');};
  const rows=t.sites.map(site=>({site,success:0,failed:0,matched:0,missing:0,cleared:0,clearFailed:0,reasons:{}}));
  const rowOf=c=>rows.find(row=>matchesSite(c,row.site));const written=[];
  try{
   if(t.options.clearTarget){for(const c of await this.read()){const row=rowOf(c);if(!row)continue;live();try{const removed=await this.chrome.cookies.remove({url:cookieUrl(c),name:c.name,...(c.partitionKey?{partitionKey:c.partitionKey}:{})});if(removed)row.cleared++;else row.clearFailed++;}catch{row.clearFailed++;}}}
   // 中文注释：单条写入失败只记固定类别，不把 API 异常或 Cookie 名和值回传。
   while(t.chunks.length){const chunk=t.chunks.shift();t.current=chunk;for(const c of chunk){live();const row=rowOf(c);try{
    if(!notExpired(c,this.now())){row.failed++;row.reasons.expired=(row.reasons.expired||0)+1;continue;}
    const result=await this.chrome.cookies.set(setDetails(c,t.options,this.now()));live();if(!result)throw Error('COOKIE_SET');row.success++;written.push({identity:cookieIdentity(c),row});
   }catch(error){live();row.failed++;const reason=error.message==='COOKIE_PREFIX'?'prefix_constraint':c.partitionKey?'partition_write_failed':'write_failed';row.reasons[reason]=(row.reasons[reason]||0)+1;}}}
   live();const keys=new Set((await this.read()).map(cookieIdentity));live();
   for(const w of written)w.row[keys.has(w.identity)?'matched':'missing']++;
   return {sites:rows,count:rows.reduce((n,r)=>n+r.success+r.failed,0),success:rows.reduce((n,r)=>n+r.success,0),failed:rows.reduce((n,r)=>n+r.failed,0),matched:rows.reduce((n,r)=>n+r.matched,0),missing:rows.reduce((n,r)=>n+r.missing,0)};
  }finally{this.destroy(p.transferId);}
 }
 async handle(method,p){
  if(method==='list_sites')return this.listSites();if(method==='prepare')return this.prepare(p);if(method==='take')return this.take(p);if(method==='begin')return this.begin(p);if(method==='stage')return this.stage(p);if(method==='finish')return this.finish(p);if(method==='destroy'){this.destroy(p.transferId);return {destroyed:true};}throw Error('COOKIE_SCOPE_DENIED');
 }
}
