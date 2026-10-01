// 中文注释：任务范围的有界网络证据；与原始 CDP 事件队列分离，读取不会消费等待器事件。
const LIMIT=128, BODY_LIMIT=65536;
const sensitive=/(?:cookie|authorization|password|passwd|secret|token|csrf|session|credential|otp|api.?key)/i;
const fail=code=>Object.assign(Error(code),{preDispatch:true});
export function publicUrl(raw){try{const u=new URL(raw);return `${u.origin}${u.pathname}`;}catch{return '';}}
export function cleanJson(value,depth=0,state={truncated:false}){
 if(depth>16){state.truncated=true;return '[TRUNCATED]';}
 if(Array.isArray(value))return value.map(v=>cleanJson(v,depth+1,state));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':cleanJson(v,depth+1,state)]));
 if(typeof value==='string')return value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
 return value;
}
function bodyCapture(raw){
 // 中文注释：非 JSON 与过大的正文不返回；不把任意文本正则过滤当作通用 DLP。
 if(typeof raw!=='string'||raw.length>BODY_LIMIT)return {text:'',withheld:true,reason:'body_limit'};
 try{const state={truncated:false};const text=JSON.stringify(cleanJson(JSON.parse(raw),0,state));return {text,withheld:false,structureTruncated:state.truncated};}
 catch{return {text:'',withheld:true,reason:'non_json'};}
}
export class NetworkEvidence{
 constructor(executor){this.executor=executor;}
 async inspect(t,p,guard){
  const resources=this.executor.pageRuntime.assert(t,p);
  const o=p.options;
  if(!o||typeof o!=='object'||Array.isArray(o))throw fail('INVALID_NETWORK_OPTIONS');
  const operations={start:['operation'],stop:['operation'],list:['operation','captureId','afterSequence','limit','filter'],detail:['operation','captureId','seq','part','start','maxChars']};
  const keys=Object.hasOwn(operations,o.operation)?operations[o.operation]:null;
  if(!keys||Object.keys(o).some(k=>!keys.includes(k)))throw fail('INVALID_NETWORK_OPTIONS');
  resources.network??=new Map();
  if(o.operation==='stop'){resources.network.delete(p.tabId);return {stopped:true};}
  if(o.operation==='start'){
   // 中文注释：先安装捕获状态，再开启域；不关闭共享 Network 域，以免破坏其他观察器。
   const state={captureId:crypto.randomUUID(),cursor:0,next:0,entries:new Map(),dropped:0};
   resources.network.set(p.tabId,state);
   try{await this.executor.api.debugger.sendCommand({tabId:p.tabId},'Network.enable',{maxTotalBufferSize:1024*1024,maxResourceBufferSize:BODY_LIMIT,maxPostDataSize:BODY_LIMIT});guard();}
   catch(e){resources.network.delete(p.tabId);throw e;}
   return {captureId:state.captureId,cursor:0};
  }
  const state=resources.network.get(p.tabId);
  if(!state||o.captureId!==state.captureId)throw fail('NETWORK_CAPTURE_STALE');
  if(o.operation==='list'){
   const after=o.afterSequence??0,limit=o.limit??20;
   if(!Number.isInteger(after)||after<0||after>state.cursor||!Number.isInteger(limit)||limit<1||limit>100||o.filter!==undefined&&(typeof o.filter!=='string'||o.filter.length>500))throw fail('INVALID_NETWORK_OPTIONS');
   const rows=[...state.entries.values()].filter(e=>e.updatedSequence>after&&(!o.filter||e.url.includes(o.filter))).sort((a,b)=>a.updatedSequence-b.updatedSequence);
   const selected=rows.slice(0,limit);
   return {captureId:state.captureId,cursor:rows.length>limit?selected.at(-1).updatedSequence:state.cursor,hasMore:rows.length>limit,dropped:state.dropped,entries:selected.map(e=>this.summary(e))};
  }
  if(!Number.isInteger(o.seq)||o.seq<1||!['request','response'].includes(o.part??'response')||!Number.isInteger(o.start??0)||(o.start??0)<0||!Number.isInteger(o.maxChars??8000)||(o.maxChars??8000)<200||(o.maxChars??8000)>20000)throw fail('INVALID_NETWORK_OPTIONS');
  const entry=[...state.entries.values()].find(e=>e.seq===o.seq);
  if(!entry)throw fail('NETWORK_ENTRY_UNAVAILABLE');
  const part=o.part??'response';
  if(part==='response'&&!entry.response){
   if(!entry.completed)return {...this.summary(entry),body:{part,withheld:true,reason:'pending'}};
   let raw;
   try{
    raw=await this.executor.api.debugger.sendCommand({tabId:p.tabId},'Network.getResponseBody',{requestId:entry.requestId});
   }catch{entry.response={text:'',withheld:true,reason:'body_unavailable'};}
   // 中文注释：仅把浏览器正文不可用转为缺失；撤权、代次或捕获变化必须向调用者明确报错。
   guard();
   if(resources.network.get(p.tabId)!==state)throw fail('NETWORK_CAPTURE_STALE');
   if(state.entries.get(entry.requestId)!==entry)throw fail('NETWORK_ENTRY_UNAVAILABLE');
   if(raw)entry.response=raw.base64Encoded?{text:'',withheld:true,reason:'binary'}:bodyCapture(raw.body);
  }
  const body=entry[part]??{text:'',withheld:true,reason:'not_captured'};
  const start=o.start??0,max=o.maxChars??8000;
  if(start>body.text.length)throw fail('INVALID_NETWORK_OPTIONS');
  const end=Math.min(start+max,body.text.length);
  return {...this.summary(entry),captureId:state.captureId,body:{...body,part,text:body.text.slice(start,end),start,totalChars:body.text.length,nextStart:end<body.text.length?end:null,filtered:true}};
 }
 summary(e){return {seq:e.seq,updatedSequence:e.updatedSequence,url:e.url,method:e.method,status:e.status??null,contentType:e.contentType??null,completed:e.completed,failed:e.failed??false};}
 observe(t,source,method,p){
  // 中文注释：第一版仅观察主标签的已授权来源，不合并子 frame session 的请求 ID。
  if(source.sessionId)return;
  const state=t.execution?.network?.get(source.tabId);if(!state)return;
  const raw=p.request?.url??p.response?.url;
  if(raw){try{this.executor.allowed(t,raw);}catch{state.entries.delete(p.requestId);return;}}
  if(method==='Network.requestWillBeSent'){
   if(!raw||!/^https?:/.test(raw))return;
   if(state.entries.has(p.requestId))state.entries.delete(p.requestId);
   if(state.entries.size>=LIMIT){state.entries.delete(state.entries.keys().next().value);state.dropped++;}
   state.entries.set(p.requestId,{seq:++state.next,updatedSequence:++state.cursor,requestId:p.requestId,url:publicUrl(raw),method:p.request.method,completed:false,request:p.request.postData===undefined?{text:'',withheld:true,reason:'not_captured'}:bodyCapture(p.request.postData)});
  }else{
   const entry=state.entries.get(p.requestId);if(!entry)return;
   if(method==='Network.responseReceived'){entry.status=p.response.status;entry.contentType=String(p.response.mimeType??'').slice(0,100);}
   else if(method==='Network.loadingFinished')entry.completed=true;
   else if(method==='Network.loadingFailed'){entry.completed=true;entry.failed=true;}
   else return;
   entry.updatedSequence=++state.cursor;
  }
 }
}
