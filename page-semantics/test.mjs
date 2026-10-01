import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const dir = await mkdtemp(join(process.env.TMPDIR || process.cwd(), 'semantics-chrome-'));
const chrome=spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--use-mock-keychain','--password-store=basic','--headless=new',`--user-data-dir=${dir}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let ws; const results=[];
try {
 let port; for(let i=0;i<100;i++){try{port=(await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.ok(port,'isolated Chrome started');
 const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
 async function cdp(method,params={}){const id=++seq;const p=new Promise(r=>pending.set(id,r));ws.send(JSON.stringify({id,method,params}));const m=await p;if(m.error)throw Error(JSON.stringify(m.error));return m.result;}
 async function run(name,expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(`${name}: ${r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)}`);assert.equal(r.result.value?.ok,true,name+': '+JSON.stringify(r.result.value));results.push({name,...r.result.value});console.log('PASS',name);}
 const source=await readFile(new URL('./index.js',import.meta.url),'utf8').catch(()=> '');
 const moduleURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
 const imported=await cdp('Runtime.evaluate',{expression:`import(${JSON.stringify(moduleURL)}).then(m=>{globalThis.createPageSemantics=m.createPageSemantics;})`,awaitPromise:true});
 if(imported.exceptionDetails)throw Error('Browser ESM import failed: '+JSON.stringify(imported.exceptionDetails));
 await run('stable refs reject obsolete snapshot and replacement',`(()=>{
 const check=(v,m)=>{if(!v)throw Error(m)};
 check(typeof createPageSemantics==='function','missing createPageSemantics export');
 document.body.innerHTML='<button id="a">Save</button><button id="b">Save</button>';
 globalThis.s=createPageSemantics({document,taskId:'task',documentId:'doc',leaseId:'lease'});
 const a=s.snapshot();check(a.items.length===2,'duplicate names must not merge');
 const token=(snap,item)=>({...snap.binding,snapshotId:snap.snapshotId,ref:item.ref});
 check(s.resolve(token(a,a.items[1])).id==='b','exact second button');
 const b=s.snapshot();check(a.items[0].ref===b.items[0].ref,'stable node ref');
 let rejected=false;try{s.resolve(token(a,a.items[0]))}catch{rejected=true}check(rejected,'old snapshot rejected');
 document.getElementById('a').outerHTML='<button id="c">Save</button>';
 const c=s.snapshot();check(c.items[0].ref!==a.items[0].ref,'never reuse deleted node ref');
 for(const key of ['taskId','documentId','leaseId']){let bad=false;try{s.resolve({...token(c,c.items[0]),[key]:'wrong'})}catch{bad=true}check(bad,key+' binding');}
 globalThis.check=check;globalThis.token=token;
 return {ok:true};})()`);
 await run('modes filters redaction coverage budget and real click',`(()=>{
 document.body.innerHTML='<main id="scope"><h1>Report</h1><p>Contact alice@example.com token=TOPSECRET</p><button id="target">Buy</button><input type="password" value="HIDDENSECRET"><button hidden>Hidden</button><table><tr><th>Item</th><th>Cost</th></tr><tr><td>Book</td><td>20</td></tr></table></main><button style="position:absolute;top:9000px">Outside</button>';
 document.querySelector('#target').onclick=()=>document.querySelector('#target').dataset.clicked='yes';
 const a=s.snapshot({mode:'interactive',root:'#scope',query:'Buy',roles:['button'],viewport:true});check(a.items.length===1,'combined filters');s.resolve(token(a,a.items[0])).click();check(document.querySelector('#target').dataset.clicked==='yes','real click target');
 const c=s.snapshot({mode:'content'});check(c.items.some(x=>x.role==='heading'),'content heading');check(!JSON.stringify(c).includes('alice@example.com')&&!JSON.stringify(c).includes('TOPSECRET'),'content redaction');
 const t=s.snapshot({mode:'table'});check(t.items.some(x=>x.cells?.join('|')==='Book|20'),'structured table row');
 document.querySelector('#scope').insertAdjacentHTML('beforeend',Array.from({length:200},(_,i)=>'<button data-noise="'+('noise'.repeat(100))+'">Action '+i+'</button>').join(''));
 const raw=document.documentElement.outerHTML.length;const small=s.snapshot({budget:700});const encoded=JSON.stringify(small);check(small.budget.kind==='estimated','not exact token claim');check(small.coverage.omitted>0&&small.coverage.complete===false,'explicit omission');check(Math.ceil(encoded.length/4)<=700,'whole response budget');check(encoded.length<raw/3,'measured savings');
 return {ok:true,rawHTMLChars:raw,snapshotChars:encoded.length,savedPercent:Number(((1-encoded.length/raw)*100).toFixed(2)),budgetKind:small.budget.kind};})()`);
 await run('incremental parameter binding resync and bounded pagination',`(()=>{
 document.body.innerHTML=Array.from({length:45},(_,i)=>'<button id="p'+i+'">Page '+i+'</button>').join('');
 const p=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',maxItems:7});
 const a=p.snapshot({budget:900});check(a.nextCursor,'cursor exists');
 const refs=new Set(a.items.map(x=>x.ref));let page=a, pages=1;
 while(page.nextCursor){page=p.snapshot({budget:900,cursor:page.nextCursor});for(const i of page.items){check(!refs.has(i.ref),'no duplicate pages');refs.add(i.ref);}pages++;check(pages<10,'finite pagination');}
 check(refs.size===45,'every node reached');check(p.stats().activeRefs<=7&&p.stats().baselineItems<=7&&p.stats().cursors<=1,'bounded retained state');
 let base=p.snapshot({query:'Page 0',budget:900});document.getElementById('p0').textContent='Page 0 changed';
 let delta=p.snapshot({query:'Page 0',budget:900,baselineId:base.snapshotId});check(delta.kind==='delta'&&delta.items.length===1&&delta.items[0].name==='Page 0 changed','changed delta');
 let unchanged=p.snapshot({query:'Page 0',budget:900,baselineId:delta.snapshotId});check(unchanged.kind==='delta'&&unchanged.items.length===0,'empty delta');
 let mismatch=p.snapshot({query:'Page 1',budget:900,baselineId:unchanged.snapshotId});check(mismatch.kind==='full'&&mismatch.resync.reason==='parameters_changed','parameter mismatch resync');
 let evicted=p.snapshot({baselineId:base.snapshotId});check(evicted.resync.reason==='baseline_unavailable','evicted baseline resync');
 const cur=p.snapshot({budget:900});document.body.append(document.createElement('button'));const stale=p.snapshot({budget:900,cursor:cur.nextCursor});check(stale.resync.reason==='cursor_invalidated','mutated paging resync');
 const fresh=p.snapshot();document.getElementById('p0').textContent='Changed again';let rejected=false;try{p.resolve(token(fresh,fresh.items[0]))}catch{rejected=true}check(rejected,'mutation rejects action before replacement snapshot');
 p.revoke();let revoked=false;try{p.snapshot()}catch{revoked=true}check(revoked,'revoked lease');
 return {ok:true,pages,uniqueNodes:refs.size};})()`);
 await run('edge safety omission and full parameter invalidation',`(()=>{
 document.body.innerHTML='<div id="one"><button>One</button></div><div id="two"><button>Two</button></div><div role="heading">Not interactive</div><p>'+('x'.repeat(900))+'</p><button data-private aria-label="PRIVATE">Private</button>';
 const p=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',maxText:20});
 const a=p.snapshot();check(!a.items.some(i=>i.role==='heading'),'noninteractive ARIA excluded');check(!JSON.stringify(a).includes('PRIVATE'),'private attr suppressed');
 // 中文注释：显式缩小预算以保证跨页；默认预算可容纳全部片段，不应被误判为必须分页。
 const content=p.snapshot({mode:'content',budget:700});check(content.nextCursor && content.items.some(x=>x.fragment?.field==='name')&&!content.coverage.complete,'text continuation explicit');
 for(const change of [{root:'#two'},{mode:'content'},{roles:['button']},{viewport:true},{budget:800}]){const base=p.snapshot({root:'#one'});const next=p.snapshot({root:'#one',...change,baselineId:base.snapshotId});check(next.resync?.reason==='parameters_changed','fingerprint '+JSON.stringify(change));}
 const expired=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',expiresAt:Date.now()-1});let no=false;try{expired.snapshot()}catch{no=true}check(no,'expired lease');expired.revoke();
 const limited=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',maxScan:2});const cut=limited.snapshot();check(!cut.coverage.traversalComplete&&!cut.coverage.complete,'scan cap explicit');limited.revoke();
 p.revoke();return {ok:true};})()`);
 await run('retargeting property changes delta removals and caller isolation',`(()=>{
 document.body.innerHTML='<input id="check" type="checkbox"><button id="keep">Keep</button><button id="remove">Remove</button>';
 const p=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l'});
 let a=p.snapshot();document.getElementById('check').checked=true;let rejected=false;try{p.resolve(token(a,a.items[0]))}catch{rejected=true}check(rejected,'property-only semantic change rejected');
 a=p.snapshot();const old=a.items.find(x=>x.name==='Remove').ref;document.getElementById('remove').remove();document.getElementById('keep').insertAdjacentHTML('afterend','<button>Added</button>');
 const delta=p.snapshot({baselineId:a.snapshotId});check(delta.kind==='delta'&&delta.removed.includes(old)&&delta.items.some(x=>x.name==='Added'),'delta add/remove');
 const fresh=p.snapshot();const ref=fresh.items[1].ref;fresh.items[1].name='caller mutation';const next=p.snapshot({baselineId:fresh.snapshotId});check(next.kind==='delta'&&next.items.length===0,'caller cannot mutate cached baseline');check(p.resolve({...next.binding,snapshotId:next.snapshotId,ref}).id==='keep','unchanged delta ref renewed');
 const other=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l'});const theirs=other.snapshot();let cross=false;try{other.resolve({...theirs.binding,snapshotId:theirs.snapshotId,ref})}catch{cross=true}check(cross,'cross-instance ref rejected');
 other.revoke();p.revoke();return {ok:true};})()`);
 await run('complex multilingual privacy table bounds and budget matrix',`(()=>{
 document.body.innerHTML='<main><h1>订单报告</h1><label for="email">Email alice@example.com</label><input id="email" value="PRIVATE_INPUT"><textarea>PRIVATE_TEXTAREA</textarea><p>Visible <span style="display:none">PRIVATE_CSS_HIDDEN</span>正文 token=SENSITIVE_KEY</p><button aria-label="确认 alice@example.com">确认</button><table><tr>'+Array.from({length:50},(_,i)=>'<td>单元 '+i+'</td>').join('')+'</tr></table><div id="shadow"></div><iframe src="about:blank"></iframe></main>';
 document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow excluded</button>';
 const p=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',maxText:30});
 const c=p.snapshot({mode:'content'});check(!JSON.stringify(c).includes('PRIVATE_CSS_HIDDEN'),'CSS-hidden text excluded');
 const t=p.snapshot({mode:'table',budget:3000});check(t.items[0].omittedCells===10&&t.items[0].fragment?.field==='name','table row continuation and cell cap explicit');
 for(const mode of ['interactive','content','table'])for(const budget of [512,600,700,900,3000]){const a=p.snapshot({mode,budget});check(Math.ceil(JSON.stringify(a).length/4)<=budget,'budget matrix');check(!/PRIVATE_INPUT|PRIVATE_TEXTAREA|alice@example.com|SENSITIVE_KEY/.test(JSON.stringify(a)),'redacted before output');check(a.coverage.scope.includes('no iframe/shadow'),'scope caveat');}
 p.revoke();return {ok:true,budgetCases:15};})()`);
 await run('document replacement invalidates prior document binding',`(()=>{
 const frame=document.querySelector('iframe');const fd=frame.contentDocument;fd.body.innerHTML='<button>Frame</button>';
 const p=createPageSemantics({document:fd,taskId:'t',documentId:'frame-document',leaseId:'l'});const a=p.snapshot();
 fd.open();fd.write('<html><body><button>Replacement</button></body></html>');fd.close();
 let rejected=false;try{p.resolve(token(a,a.items[0]))}catch{rejected=true}check(rejected,'replacement document action rejected');
 rejected=false;try{p.snapshot()}catch{rejected=true}check(rejected,'new document requires new instance');p.revoke();return {ok:true};})()`);
 await run('invalid expiry rejected at construction',`(()=>{
 let rejected=false;try{createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l',expiresAt:NaN})}catch{rejected=true}check(rejected,'NaN must not bypass expiry');return {ok:true};})()`);
 // TEST_SLICES
 const version=await cdp('Browser.getVersion');
 await writeFile(new URL('./evidence.json',import.meta.url),JSON.stringify({status:'passed',executedAt:new Date().toISOString(),browser:version.product,node:process.version,sourceSHA256:createHash('sha256').update(source).digest('hex'),testSHA256:createHash('sha256').update(await readFile(new URL('./test.mjs',import.meta.url))).digest('hex'),isolatedProfile:true,personalProfileRead:false,moduleLoading:'real browser ESM import',measurement:'UTF-16 JSON/string length; synthetic noisy fixture; budgeted snapshot is partial, not lossless; not measured model tokens',tests:results},null,2));
 console.log(JSON.stringify({browser:version.product,passed:results.length}));
} finally {if(ws)ws.close();chrome.kill('SIGTERM');await new Promise(r=>chrome.once('exit',r));await rm(dir,{recursive:true,force:true});}
