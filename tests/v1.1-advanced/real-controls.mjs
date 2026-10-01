// 中文注释：在临时 Chrome/Edge 配置中执行生产页面函数；不触碰个人配置或假称整链验收。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {semanticWorldDeclaration} from '../../native-extension/core.mjs';
import {Interactions,createCDPAdapter} from '../../browser-interactions/index.mjs';

const browsers={
 chrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 edge:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function run(name,binary){
 const profile=await mkdtemp(path.join(process.env.TMPDIR||'/tmp',`hermes-controls-${name}-`));
 const child=spawn(binary,['--use-mock-keychain','--password-store=basic','--headless=new',
  '--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
  '--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{detached:true,stdio:'ignore',env:{...process.env,HOME:process.env.HOME}});
 let socket;const pending=new Map();let nextId=0;
 try{
  let port;
  for(let n=0;n<150;n++){
   try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await wait(100);}
  }
  assert.ok(port,`${name} 未启动`);
  const base=`http://127.0.0.1:${port}`;
  const targets=await (await fetch(base+'/json/list')).json();
  const target=targets.find(item=>item.type==='page');assert.ok(target,`${name} 无页面`);
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{
   const message=JSON.parse(event.data),resolve=pending.get(message.id);
   if(resolve){pending.delete(message.id);resolve(message);}
  });
  async function cdp(method,params={}){
   const id=++nextId;
   const reply=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP 超时：${method}`));},10000);
    pending.set(id,message=>{clearTimeout(timer);resolve(message);});
   });
   socket.send(JSON.stringify({id,method,params}));
   const message=await reply;if(message.error)throw Error(JSON.stringify(message.error));
   return message.result;
  }
  async function evaluate(expression){
   const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
   if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'页面执行失败');
   return result.result.value;
  }
  const call=(op,p)=>evaluate(`(${semanticWorldDeclaration})(${JSON.stringify(op)},${JSON.stringify(p)})`);
  const binding={taskId:'temporary-test',documentId:'document-1',leaseId:'lease-1'};
  await evaluate(`(()=>{
   document.body.innerHTML='<label><input id="check" type="checkbox">确认</label><button id="tri" role="checkbox" aria-checked="mixed">三态</button><select id="choice" multiple aria-label="Native Choice"><option value="a">甲</option><option value="b">乙</option></select><button id="custom" role="combobox" aria-controls="custom-menu" aria-expanded="false">Custom Select</button><div id="custom-menu" role="listbox" hidden></div><button id="pointer">指针</button><label style="position:absolute;top:1800px"><input id="distant" type="checkbox">远处</label>';
   document.body.style.minHeight='2200px';
   document.querySelector('#tri').onclick=()=>document.querySelector('#tri').setAttribute('aria-checked','true');
   document.querySelector('#pointer').onclick=event=>{globalThis.pointerResult={trusted:event.isTrusted,count:(globalThis.pointerResult?.count||0)+1};};
   document.querySelector('#custom').onclick=()=>{
    const control=document.querySelector('#custom'),menu=document.querySelector('#custom-menu');
    control.setAttribute('aria-expanded','true');menu.hidden=false;
    setTimeout(()=>{menu.innerHTML='<div role="option" data-value="b">Beta</div>';
     menu.querySelector('[role="option"]').onclick=event=>{event.currentTarget.setAttribute('aria-selected','true');control.dataset.selected='b';menu.hidden=true;};
    },100);
   };
   globalThis.__hermesAutomationOverlay={highlight:{prepare:()=>({ok:true}),verify:()=>({ok:true})}};
   return true;
  })()`);
  const snapshot=()=>call('semantic_snapshot',{binding,options:{mode:'interactive'}});
  const find=(snap,role)=>{const item=snap.items.find(value=>value.role===role);assert.ok(item,`找不到 ${role}`);return {binding,snapshotId:snap.snapshotId,ref:item.ref};};
  let snap=await snapshot();
  const checkbox=find(snap,'checkbox');
  const first=await call('ref_set_checked',{...checkbox,checked:true});
  assert.equal(first.checked,true);assert.equal(first.changed,true);assert.equal(first.verified,true);
  assert.equal(await evaluate(`document.querySelector('#check').checked`),true);
  snap=await snapshot();
  const same=await call('ref_set_checked',{...find(snap,'checkbox'),checked:true});
  assert.equal(same.changed,false);
  snap=await snapshot();
  const tri=snap.items.find(item=>item.name==='三态');assert.ok(tri);
  const mixed=await call('ref_set_checked',{binding,snapshotId:snap.snapshotId,ref:tri.ref,checked:true});
  assert.equal(mixed.verified,true);
  snap=await snapshot();
  // 中文注释：多选原生 select 的角色是 listbox，不能误选旁边的自定义 combobox。
  const select=snap.items.find(item=>item.role==='listbox'&&item.name==='Native Choice');assert.ok(select,'找不到原生 select');
  const chosen=await call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:select.ref,by:'value',values:['a','b']});
  assert.equal(chosen.verified,true);assert.equal(chosen.selectedCount,2);
  assert.deepEqual(await evaluate(`[...document.querySelector('#choice').selectedOptions].map(x=>x.value)`),['a','b']);
  snap=await snapshot();
  const custom=snap.items.find(item=>item.name==='Custom Select');assert.ok(custom);
  const customResult=await call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:custom.ref,by:'value',values:['b']});
  assert.equal(customResult.verified,true);assert.equal(await evaluate(`document.querySelector('#custom').dataset.selected`),'b');
  const setCustomFixture=markup=>evaluate(`(()=>{const control=document.querySelector('#custom'),menu=document.querySelector('#custom-menu');control.setAttribute('aria-expanded','false');menu.hidden=true;control.onclick=()=>{control.setAttribute('aria-expanded','true');menu.hidden=false;menu.innerHTML=${JSON.stringify(markup)};};return true;})()`);
  await setCustomFixture('<div role="option">Gamma</div><div role="option">Gamma</div>');
  snap=await snapshot();
  const duplicate=snap.items.find(item=>item.name==='Custom Select');
  await assert.rejects(call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:duplicate.ref,by:'label',values:['Gamma']}),/SELECT_OPTION_AMBIGUOUS/);
  await setCustomFixture('<div role="option" data-value="c" aria-disabled="true">Closed</div>');
  snap=await snapshot();
  const disabled=snap.items.find(item=>item.name==='Custom Select');
  await assert.rejects(call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:disabled.ref,by:'value',values:['c']}),/SELECT_OPTION_DISABLED/);
  await setCustomFixture('');
  snap=await snapshot();
  const missing=snap.items.find(item=>item.name==='Custom Select');
  await assert.rejects(call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:missing.ref,by:'label',values:['Missing']}),/SELECT_OPTION_MISSING/);
  assert.equal(await evaluate(`document.querySelector('#custom').dataset.selected`),'b');
  snap=await snapshot();
  const pointer=snap.items.find(item=>item.name==='指针');assert.ok(pointer);
  const pointerRef={binding,snapshotId:snap.snapshotId,ref:pointer.ref};
  const interactions=new Interactions(createCDPAdapter((method,params)=>cdp(method,params)),{taskId:binding.taskId,generation:1});
  const pointerResult=await interactions.clickBoundTarget({taskId:binding.taskId,generation:1},{readTarget:()=>call('pointer_target',pointerRef)});
  assert.equal(pointerResult.kind,'pointer-click');
  assert.deepEqual(await evaluate('globalThis.pointerResult'),{trusted:true,count:1});
  snap=await snapshot();
  const distant=snap.items.find(item=>item.name==='远处');assert.ok(distant);
  const distantRef={binding,snapshotId:snap.snapshotId,ref:distant.ref};
  const beforeScroll=await evaluate('scrollY');
  // 中文注释：沿用执行器的显式滚入顺序，prepare 只负责高亮，不能假设其自动滚动。
  await call('reveal_ref',distantRef);
  const prepared=await call('prepare_ref_set_checked',{...distantRef,highlightBinding:{operationToken:'test-scroll'}});
  assert.equal(prepared.ok,true);assert.ok((await evaluate('scrollY'))>beforeScroll);
  const distantResult=await call('ref_set_checked',{...distantRef,checked:true});
  assert.equal(distantResult.verified,true);
  await evaluate(`window.scrollTo(0,0);document.querySelector('#choice').insertAdjacentHTML('beforeend','<option value="c">甲</option>')`);
  snap=await snapshot();
  const updated=snap.items.find(item=>item.role==='listbox'&&item.name==='Native Choice');assert.ok(updated);
  await assert.rejects(call('ref_select_option',{binding,snapshotId:snap.snapshotId,ref:updated.ref,by:'label',values:['甲']}),/SELECT_OPTION_AMBIGUOUS/);
  assert.deepEqual(await evaluate(`[...document.querySelector('#choice').selectedOptions].map(x=>x.value)`),['a','b']);
  await evaluate(`(()=>{
   const host=document.createElement('div');host.id='open-host';document.body.append(host);
   host.attachShadow({mode:'open'}).innerHTML='<button id="open-action">Open Shadow</button>';
   host.shadowRoot.querySelector('button').onclick=()=>document.body.dataset.shadowClicked='yes';
   const frame=document.createElement('iframe');frame.id='same-frame';document.body.append(frame);
   frame.contentDocument.body.innerHTML='<button id="frame-action">Frame Action</button>';
   frame.contentDocument.querySelector('button').onclick=()=>frame.contentDocument.body.dataset.clicked='yes';
   return true;
  })()`);
  snap=await call('semantic_snapshot',{binding,options:{mode:'interactive',composed:true,budget:5000}});
  const shadow=snap.items.find(item=>item.name==='Open Shadow');assert.ok(shadow?.targetPath?.some(step=>step.kind==='shadow'));
  const shadowClicked=await call('ref_click',{binding,snapshotId:snap.snapshotId,ref:shadow.ref});
  assert.equal(shadowClicked.clicked,true);assert.equal(await evaluate(`document.body.dataset.shadowClicked`),'yes');
  snap=await call('semantic_snapshot',{binding,options:{mode:'interactive',composed:true,budget:5000}});
  const frame=snap.items.find(item=>item.name==='Frame Action');assert.ok(frame?.targetPath?.some(step=>step.kind==='frame'));
  const frameClicked=await call('ref_click',{binding,snapshotId:snap.snapshotId,ref:frame.ref});
  assert.equal(frameClicked.clicked,true);assert.equal(await evaluate(`document.querySelector('#same-frame').contentDocument.body.dataset.clicked`),'yes');
  // 中文注释：closed Shadow 原型只检查调试协议的可见性和节点绑定，不推断扩展已具备该能力。
  await evaluate(`(()=>{const host=document.createElement('div');host.id='closed-host';document.body.append(host);host.attachShadow({mode:'closed'}).innerHTML='<button id="closed-target">Closed</button>';return true;})()`);
  let closedShadow={observable:false,bindable:false};
  try{
   await cdp('DOM.enable');
   const {root}=await cdp('DOM.getDocument',{depth:-1,pierce:true});
   const walk=node=>[node,...(node.children||[]).flatMap(walk),...(node.shadowRoots||[]).flatMap(walk),...(node.contentDocument?[...walk(node.contentDocument)]:[])];
   const nodes=walk(root),closed=nodes.find(node=>node.nodeType===11&&node.shadowRootType==='closed');
   closedShadow.observable=Boolean(closed);
   const button=closed&&walk(closed).find(node=>node.nodeName==='BUTTON');
   if(button?.backendNodeId){
    const {object}=await cdp('DOM.resolveNode',{backendNodeId:button.backendNodeId});
    try{
     const response=await cdp('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){return this.tagName}',returnByValue:true});
     closedShadow.bindable=response.result.value==='BUTTON';
    }finally{await cdp('Runtime.releaseObject',{objectId:object.objectId});}
   }
  }catch{closedShadow={observable:false,bindable:false,reason:'cdp_probe_failed'};}
  const version=await cdp('Browser.getVersion');
  return {browser:name,version:version.product,passed:14,sourceSha256:createHash('sha256').update(semanticWorldDeclaration).digest('hex'),
   closedShadow,scope:'生产页面函数与真实 DOM；临时配置；closed Shadow 为直接 CDP 原型；不含扩展、daemon、Hermes 公开调用链'};
 }finally{
  socket?.close();for(const resolve of pending.values())resolve({error:{message:'closed'}});
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  await wait(300);
  try{process.kill(-child.pid,'SIGKILL');}catch{}
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}

const report={executedAt:new Date().toISOString(),runs:[]};
for(const [name,binary] of Object.entries(browsers))report.runs.push(await run(name,binary));
await mkdir(new URL('./evidence/',import.meta.url),{recursive:true});
await writeFile(new URL('./evidence/real-controls.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
