// 中文注释：连接内单调序号是防重放水位；结果淘汰后不重新执行旧请求。
export class RequestLedger {
 constructor({maxBytes=4*1024*1024,maxEntries=256,maxInflight=128}={}) {
  this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.maxInflight=maxInflight;
  this.highest=0;this.bytes=0;this.inflight=0;this.entries=new Map();
 }
 async run(message,execute) {
  const sequence=message.sequence;
  const error=code=>({id:message.id,error:{code,message:'Browser request result unavailable; do not replay writes.',data:{outcomeUnknown:true,retryable:false}}});
  if(!Number.isSafeInteger(sequence)||sequence<1)return error('invalid_sequence');
  const prior=this.entries.get(sequence);
  const serialized=JSON.stringify({id:message.id,method:message.method,params:message.params});
  const digest=crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized)).then(bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join(''));
  if(prior)return await prior.digest===await digest?prior.promise:error('request_conflict');
  if(sequence<=this.highest)return error('request_outcome_unavailable');
  this.highest=sequence;
  // 中文注释：清理控制不受普通执行的在途额度阻塞。
  const control=['browser.release','browser.cleanup_status','browser.cleanup_retry','browser.download_cancel'].includes(message.method);
  if(this.inflight>=this.maxInflight&&!control)return error('too_many_pending');
  this.inflight++;
  const entry={digest,bytes:0,done:false,promise:null};
  this.entries.set(sequence,entry);
  entry.promise=Promise.resolve().then(execute).catch(()=>error('execution_failed')).then(result=>{
   this.inflight--;entry.done=true;
   entry.bytes=new TextEncoder().encode(JSON.stringify(result)).byteLength;
   this.bytes+=entry.bytes;this.trim();return result;
  });
  return entry.promise;
 }
 trim(){
  for(const [id,entry] of this.entries){
   if(this.bytes<=this.maxBytes&&this.entries.size<=this.maxEntries)break;
   if(!entry.done)continue;
   this.entries.delete(id);this.bytes-=entry.bytes;
  }
 }
}
