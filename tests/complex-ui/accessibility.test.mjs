// 中文注释：局部 AX 测试复用实际隔离世界函数，CDP mock 只提供节点句柄和浏览器计算名称。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor} from '../../native-extension/core.mjs';
function fixture(html,query){
 const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window,objects=new Map(),nodes=new Map(),calls=[];
 w.HTMLElement.prototype.getClientRects=()=>[{}];let sequence=0;
 const e=new Executor({tabs:{},debugger:{sendCommand:async(_target,method,p={})=>{
  calls.push([method,p]);
  if(method==='Page.createIsolatedWorld')return {executionContextId:17};
  if(method==='Runtime.callFunctionOn'){
   const value=await w.eval(`(${p.functionDeclaration})`)(...(p.arguments||[]).map(a=>a.value));
   if(p.returnByValue===false&&value){const objectId=`node-${++sequence}`;objects.set(objectId,value);nodes.set(sequence,value);return {result:{objectId}};}
   return {result:{value}};
  }
  if(method==='DOM.describeNode')return {node:{backendNodeId:Number(p.objectId.slice(5))}};
  if(method==='Accessibility.getPartialAXTree')return query?query(p,nodes.get(p.backendNodeId)):{nodes:[{backendDOMNodeId:p.backendNodeId,ignored:false,name:{type:'computedString',value:'控件 '+p.backendNodeId},properties:[{name:'expanded',value:{value:false}}]}]};
  if(method==='Runtime.releaseObject')objects.delete(p.objectId);
  return {};
 }}});
 const binding={taskId:'t',documentId:'d',leaseId:'l'};
 return {e,w,calls,objects,binding,close(){w.__hermesNativeSemanticsV2?.semantics.revoke();dom.window.close();}};
}
test('AX 局部查询最多 16 个，句柄全部释放且原 DOM 引用仍可解析',async()=>{
 const f=fixture('<section id="scope">'+Array.from({length:18},()=>'<button></button>').join('')+'</section>');
 try{
  const page=await f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',accessibility:true,budget:20000}},()=>{},17);
  assert.equal(page.coverage.axEnriched,16);assert.equal(page.coverage.axOmitted,2);assert.equal(page.coverage.complete,false);assert.equal(f.objects.size,0);
  assert.equal(f.calls.filter(([m])=>m==='Accessibility.getPartialAXTree').length,16);
  assert.equal(f.calls.filter(([m])=>m==='Accessibility.disable').length,1);
  const node=await f.e.callSemanticWorld({tabId:7},'main','rect_ref',{binding:page.binding,snapshotId:page.snapshotId,ref:page.items[0].ref},()=>{},17);
  assert.ok(node);assert.equal(page.items[0].expanded,false);assert.equal(page.items[0].nameSource,'accessibility');
 }finally{f.close();}
});
test('AX 结果只接受对应 backend 节点，不泄露私密标签并过滤秘密',async()=>{
 const f=fixture('<section id="scope"><button></button><button aria-labelledby="private"></button><span id="private" data-private>PRIVATE_CANARY</span></section>',p=>({nodes:[{backendDOMNodeId:999,name:{type:'computedString',value:'OTHER_CANARY'}},{backendDOMNodeId:p.backendNodeId,name:{type:'computedString',value:'token=AX_SECRET_CANARY'}}]}));
 try{
  const page=await f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',accessibility:true,budget:6000}},()=>{},17);
  assert.equal(page.coverage.axEnriched,1);assert.equal(page.coverage.axOmitted,1);assert(!JSON.stringify(page).includes('_CANARY'));assert(page.items.some(i=>i.name==='token=[redacted]'));
 }finally{f.close();}
});
test('AX 查询期间目标变化拒绝绑定，并关闭 AX 与释放句柄',async()=>{
 const f=fixture('<section id="scope"><button></button></section>',(p,node)=>{node.textContent='已替换语义';return {nodes:[{backendDOMNodeId:p.backendNodeId,name:{type:'computedString',value:'旧名称'}}]};});
 try{
  await assert.rejects(f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',accessibility:true}},()=>{},17),/REF_TARGET_MISSING/);
  assert.equal(f.objects.size,0);assert(f.calls.some(([m])=>m==='Accessibility.disable'));
 }finally{f.close();}
});
for(const options of [{accessibility:true},{root:'#scope',accessibility:true,cursor:'old'},{root:'#scope',accessibility:true,mode:'table'}])test('AX 禁止无根、游标和非交互模式',async()=>{
 const f=fixture('<section id="scope"><button></button></section>');
 try{await assert.rejects(f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options},()=>{},17),/INVALID_OPTIONS/);assert.equal(f.calls.length,0);}finally{f.close();}
});

// 中文注释：带值控件不触发 AX 查询，避免浏览器返回的 AX value 将输入内容带入宿主结果。
test('带值控件和私密子节点不会触发 AX 数据读取',async()=>{
 const f=fixture('<section id="scope"><input value="INPUT_CANARY"><textarea>TEXTAREA_CANARY</textarea><div role="textbox"></div><button><span data-private>PRIVATE_CANARY</span></button></section>');
 try{
  const page=await f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',accessibility:true,budget:6000}},()=>{},17);
  assert.equal(page.coverage.axEnriched,0);assert(!f.calls.some(([m])=>m==='Accessibility.getPartialAXTree'));assert(!JSON.stringify(page).includes('_CANARY'));
 }finally{f.close();}
});

// 中文注释：浏览器的固定角色可纠正原生控件的无效 ARIA 角色，仍使用原 DOM 引用。
test('AX 角色校准仅采用固定角色，支持最终 role 过滤',async()=>{
 const f=fixture('<section id="scope"><button role="invalid-role"></button></section>',p=>({nodes:[{backendDOMNodeId:p.backendNodeId,name:{type:'computedString',value:'浏览器按钮'},role:{value:'button'}}]}));
 try{const page=await f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',accessibility:true,roles:['button'],query:'浏览器按钮'}},()=>{},17);assert.equal(page.items.length,1);assert.equal(page.items[0].role,'button');}finally{f.close();}
});


// 中文注释：实现更新后撤销旧隔离世界中的实例，不能沿用不支持新契约的旧引用。
test('升级实现版本后重新创建实例并撤销旧引用',async()=>{
 const f=fixture('<section id="scope"><button>保存</button></section>');
 try{
  const call=()=>f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope'}},()=>{},17);
  const first=await call(),old=f.w.__hermesNativeSemanticsV2.semantics;
  f.w.__hermesNativeSemanticsV2.version=4;
  const next=await call();assert.notEqual(next.items[0].ref,first.items[0].ref);assert.throws(()=>old.snapshot(),/LEASE_REVOKED/);
  assert.equal(f.w.__hermesNativeSemanticsV2.version,8);assert.ok(next.items[0].actions.includes('click'));
 }finally{f.close();}
});

// 中文注释：私密分配节点不是 Shadow 控件的 DOM 子孙，仍必须在查询 AX 之前排除。
test('slot 分配的私密文本不会通过 AX 名称重新泄露',async()=>{
 const f=fixture('<section id="scope"><div id="host"><span slot="label" data-private>SLOT_PRIVATE_CANARY</span></div></section>');
 try{
  f.w.document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button><slot name="label"></slot></button>';
  const page=await f.e.callSemanticWorld({tabId:7},'main','semantic_snapshot',{binding:f.binding,options:{root:'#scope',composed:true,accessibility:true,budget:6000}},()=>{},17);
  assert.equal(page.coverage.axEnriched,0);assert(!f.calls.some(([m])=>m==='Accessibility.getPartialAXTree'));assert(!JSON.stringify(page).includes('_CANARY'));
 }finally{f.close();}
});
