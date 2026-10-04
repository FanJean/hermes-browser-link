import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';

const html=readFileSync(new URL('./fixture.html',import.meta.url),'utf8');
function setup(options={}){
 const dom=new JSDOM(html,{url:'https://fixture.example.test/',pretendToBeVisual:true});
 const {document}=dom.window;
 // 中文注释：离线 DOM 没有排版引擎，仅模拟可见矩形；真实命中由独立浏览器脚本验收。
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
 const semantics=createPageSemantics({document,taskId:'task',documentId:'loader',leaseId:'lease',...options});
 return {dom,document,semantics,close(){semantics.revoke();dom.window.close();}};
}
const token=(page,item)=>({...page.binding,snapshotId:page.snapshotId,ref:item.ref});

// 中文注释：旧引用的唯一性只在原文档及原 Shadow 树内成立，不能接替到其他作用域。
test('引用重定位隔离两个同源 iframe，保留原 frame 内唯一替换并拒绝歧义',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<iframe></iframe><iframe></iframe>';
  const frames=[...f.document.querySelectorAll('iframe')];
  for(const frame of frames){frame.contentWindow.HTMLElement.prototype.getClientRects=()=>[{}];frame.contentDocument.body.innerHTML='<button id="save">Save</button>';}
  const page=f.semantics.snapshot({composed:true}),old=token(page,page.items[0]);
  assert.equal(f.semantics.resolve(old),frames[0].contentDocument.querySelector('button'));
  frames[0].contentDocument.querySelector('button').remove();
  assert.throws(()=>f.semantics.resolve(old),/REF_TARGET_MISSING/);
  frames[0].contentDocument.body.innerHTML='<button id="save">Save</button>';
  assert.equal(f.semantics.resolve(old),frames[0].contentDocument.querySelector('button'));
  assert.equal(f.semantics.relocation(),true);
  frames[0].contentDocument.body.innerHTML='<button id="save">Save</button><button id="save">Save</button>';
  assert.throws(()=>f.semantics.resolve(old),/REF_TARGET_AMBIGUOUS/);
 }finally{f.close();}
});

test('引用禁止 light 到 shadow、shadow 到 shadow 重定位，原 Shadow 树内替换有效',()=>{
 for(const origin of ['light','shadow']){
  const f=setup();try{
   f.document.body.innerHTML='<div><button id="save">Save</button></div><div></div>';
   const [host,other]=f.document.querySelectorAll('div'),foreign=other.attachShadow({mode:'open'});
   const root=origin==='light'?host:host.attachShadow({mode:'open'});
   if(origin==='shadow'){host.querySelector('button').remove();root.innerHTML='<button id="save">Save</button>';}
   const page=f.semantics.snapshot({composed:true}),old=token(page,page.items.find(i=>i.name==='Save'));
   root.querySelector('button').remove();foreign.innerHTML='<button id="save">Save</button>';
   assert.throws(()=>f.semantics.resolve(old),/REF_TARGET_MISSING/);
   root.innerHTML='<button id="save">Save</button>';
   assert.equal(f.semantics.resolve(old),root.querySelector('button'));
  }finally{f.close();}
 }
});

test('引用拒绝 frame 文档替换、移除、重挂及 Shadow 宿主重挂或替换',()=>{
 for(const change of ['document','remove-frame','reparent-frame','reparent-shadow','replace-shadow','move-target']){
  const f=setup();try{
   f.document.body.innerHTML='<section><iframe></iframe><div></div></section><aside></aside>';
   const frame=f.document.querySelector('iframe'),host=f.document.querySelector('div'),aside=f.document.querySelector('aside');
   frame.contentWindow.HTMLElement.prototype.getClientRects=()=>[{}];
   const root=change.includes('shadow')?host.attachShadow({mode:'open'}):frame.contentDocument.body;
   root.innerHTML='<button id="save">Save</button>';
   const page=f.semantics.snapshot({composed:true}),old=token(page,page.items.find(i=>i.name==='Save'));
   if(change==='document')frame.contentDocument.replaceChild(frame.contentDocument.createElement('html'),frame.contentDocument.documentElement);
   if(change==='remove-frame')frame.remove();
   if(change==='reparent-frame')aside.append(frame);
   if(change==='reparent-shadow')aside.append(host);
   if(change==='replace-shadow'){const replacement=f.document.createElement('div');replacement.attachShadow({mode:'open'}).innerHTML='<button id="save">Save</button>';host.replaceWith(replacement);}
   if(change==='move-target')aside.append(root.querySelector('button'));
   assert.throws(()=>f.semantics.resolve(old),/DOCUMENT_REPLACED|STALE_REF/,change);
  }finally{f.close();}
 }
});

test('单页应用重渲染仅唯一目标可重定位，重复目标拒绝猜测',()=>{
 const f=setup();try{
  const page=f.semantics.snapshot({query:'保存'}),item=page.items[0];
  f.document.querySelector('#save').outerHTML='<button id="save">保存</button>';
  assert.equal(f.semantics.resolve(token(page,item)).id,'save');assert.equal(f.semantics.relocation(),true);
  f.document.querySelector('#save').remove();
  assert.throws(()=>f.semantics.resolve(token(page,item)),/REF_TARGET_MISSING/);
 }finally{f.close();}
});

test('虚拟列表滚动替换节点后游标保持有效且不重复旧条目',()=>{
 const f=setup({maxItems:1});try{
  const list=f.document.querySelector('#virtual [role=listbox]');
  list.innerHTML='<div role="option">项目一</div><div role="option">项目二</div>';
  const first=f.semantics.snapshot({root:'#virtual',roles:['option']});assert.ok(first.nextCursor);
  list.innerHTML='<div role="option">项目一</div><div role="option">项目三</div>';
  const next=f.semantics.snapshot({root:'#virtual',roles:['option'],cursor:first.nextCursor});
  assert.equal(next.resync,null);assert.equal(next.items[0].name,'项目三');
 }finally{f.close();}
});

test('嵌套开放 Shadow DOM 和同源 iframe 可读取并解析引用',()=>{
 const f=setup();try{
  const host=f.document.querySelector('#component'),outer=host.attachShadow({mode:'open'});
  const inner=f.document.createElement('span');outer.append(inner);
  const root=inner.attachShadow({mode:'open'});root.innerHTML='<button>深层操作</button><input aria-label="深层输入">';
  const frame=f.document.querySelector('#inner');frame.contentDocument.body.innerHTML='<iframe title="二层"></iframe>';
  frame.contentDocument.defaultView.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
  frame.contentDocument.querySelector('iframe').contentDocument.defaultView.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
  frame.contentDocument.querySelector('iframe').contentDocument.body.innerHTML='<button>框架操作</button>';
  const page=f.semantics.snapshot({composed:true,budget:8000});
  for(const name of ['深层操作','深层输入','框架操作']){
   const item=page.items.find(row=>row.name===name);assert.ok(item,name);assert.ok(item.targetPath.length);assert.ok(f.semantics.resolve(token(page,item)));
  }
 }finally{f.close();}
});

test('推断点击、portal 组合框、富文本和两类数据行可读取目标',()=>{
 const f=setup();try{
  const page=f.semantics.snapshot({budget:8000});
  const pointer=page.items.find(item=>item.name==='推断点击');assert.equal(pointer.role,'button');assert.equal(pointer.inferred,true);
  assert.equal(page.items.filter(item=>item.inferred&&item.name==='继承指针').length,1,'继承指针的子元素不应重复推断');
  assert.equal(page.items.some(item=>item.inferred&&item.name==='链接内文字'),false,'链接内部元素不应推断为按钮');
  for(const name of ['地区','受控输入','正文'])assert.ok(page.items.some(item=>item.name===name),name);
  const table=f.semantics.snapshot({mode:'table',budget:8000});
  assert.ok(table.items.some(item=>item.cells?.includes('名称')));
  assert.ok(table.items.some(item=>item.cells?.includes('示例')));
 }finally{f.close();}
});

test('滚动后可重新读取新列表项；折叠按钮有可操作引用；canvas 明确标为不支持',()=>{
 const f=setup();try{
  const first=f.semantics.snapshot({query:'项目一',roles:['option']});assert.equal(first.items.length,1);
  f.document.querySelector('#virtual [role=listbox]').innerHTML='<div role="option">项目二</div>';
  const second=f.semantics.snapshot({query:'项目二',roles:['option']});assert.equal(second.items.length,1);
  assert.ok(f.semantics.resolve(token(second,second.items[0])));
  const summary=f.semantics.snapshot({query:'更多信息'});assert.equal(summary.items[0].role,'button');
  assert.equal(summary.coverage.unsupportedCanvas,1);
 }finally{f.close();}
});
