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

// 中文注释：图标按钮复用可访问名称规则，隐藏与私密图标不能提供名称。
test('图片 alt、SVG title 和 tooltip 可命名图标按钮并保留脱敏',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<button id="image"><img alt="下载报告"></button><button id="svg"><svg><title>展开菜单</title></svg></button><button title="账户 alice@example.com"></button><button><img alt="PRIVATE_ICON" data-private></button>';
  f.dom.window.SVGElement.prototype.getClientRects=()=>[{}];
  const page=f.semantics.snapshot();
  assert.equal(page.items.find(item=>item.name==='下载报告').nameSource,'descendant');
  assert.equal(page.items.find(item=>item.name==='展开菜单').nameSource,'descendant');
  assert.equal(page.items.find(item=>item.name==='账户 [email]').nameSource,'title');
  assert(!JSON.stringify(page).includes('PRIVATE_ICON'));
  assert.equal(f.semantics.resolve(token(page,page.items.find(item=>item.name==='下载报告'))).id,'image');
 }finally{f.close();}
});

// 中文注释：display:contents 没有盒子，不能因此丢掉可见文字或 Shadow 宿主内的控件。
test('display contents 的文字和 Shadow 子控件仍可解析',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<button><span style="display:contents">保存内容</span></button><div id="contents" style="display:contents"></div>';
  const host=f.document.querySelector('#contents');
  host.attachShadow({mode:'open'}).innerHTML='<button>Shadow 操作</button>';
  const rects=f.dom.window.HTMLElement.prototype.getClientRects;
  f.dom.window.HTMLElement.prototype.getClientRects=function(){return this.style.display==='contents'?[]:rects.call(this);};
  const page=f.semantics.snapshot({composed:true});
  assert.deepEqual(page.items.map(item=>item.name),['保存内容','Shadow 操作']);
  host.setAttribute('data-private','');
  assert(!JSON.stringify(f.semantics.snapshot({composed:true})).includes('Shadow 操作'));
 }finally{f.close();}
});

// 中文注释：插槽标签进入控件名称，容器上下文用于区分同名动作，引用仍指向真实节点。
test('slot 命名和记录上下文保留同名按钮的独立引用',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<main aria-label="镜像版本"><article><h2>版本 A</h2><button aria-expanded="false">更多</button></article><article><h2>版本 B</h2><button aria-expanded="true">更多</button></article><div id="host"><span slot="label">保存</span></div></main>';
  f.document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button><slot name="label"></slot></button>';
  const page=f.semantics.snapshot({composed:true,budget:8000});
  const more=page.items.filter(i=>i.name==='更多');assert.equal(more.length,2);assert.notEqual(more[0].ref,more[1].ref);
  assert.deepEqual(more.map(i=>i.context.at(-1).name),['版本 A','版本 B']);assert.deepEqual(more.map(i=>i.expanded),[false,true]);
  assert(page.items.some(i=>i.name==='保存'));assert.equal(f.semantics.resolve(token(page,more[1])),f.document.querySelectorAll('article button')[1]);
 }finally{f.close();}
});

// 中文注释：AX 名称只可写回当前快照节点，隐私子内容和状态变化不能被 AX 缓存绕过。
test('局部 AX 补充脱敏且拒绝私密标签，DOM 变化使其失效',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<button id="ax"></button><button id="private" aria-labelledby="secret"></button><span id="secret" data-private>PRIVATE_CANARY</span>';
  let page=f.semantics.snapshot();const ax=page.items.find(i=>!i.name&&f.semantics.resolve(token(page,i)).id==='ax'),privateItem=page.items.find(i=>f.semantics.resolve(token(page,i)).id==='private');
  assert.equal(f.semantics.accessibilityNode(token(page,privateItem)),null);
  f.semantics.applyAccessibility({...page.binding,snapshotId:page.snapshotId},[{ref:ax.ref,name:'打开 alice@example.com',states:{expanded:false}}]);
  page=f.semantics.snapshot();assert(page.items.some(i=>i.name==='打开 [email]'&&i.nameSource==='accessibility'));
  f.document.querySelector('#ax').textContent='更新名称';assert(!f.semantics.snapshot().items.some(i=>i.nameSource==='accessibility'));
 }finally{f.close();}
});

// 中文注释：同一个 DOM 按钮被虚拟行复用时，旧引用不能操作另一个行索引。
test('虚拟行回收改变逻辑索引时拒绝旧引用',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<div role="grid" aria-rowcount="1000"><div role="row" aria-rowindex="51"><button>删除</button></div></div>';
  const page=f.semantics.snapshot(),old=token(page,page.items[0]);assert.equal(page.items[0].context.at(-1).index,51);
  f.document.querySelector('[role=row]').setAttribute('aria-rowindex','52');
  assert.throws(()=>f.semantics.resolve(old),/REF_TARGET_MISSING/);
  assert.equal(f.semantics.snapshot().items[0].context.at(-1).index,52);
 }finally{f.close();}
});

// 中文注释：私密插槽不能通过 light DOM 扫描泄露其分配节点。
test('私密 slot 同时排除分配的控件和文字',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<div id="host"><button slot="label">PRIVATE_SLOT_CANARY</button></div>';
  f.document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<slot name="label" data-private></slot>';
  assert(!JSON.stringify(f.semantics.snapshot({composed:true})).includes('PRIVATE_SLOT_CANARY'));
 }finally{f.close();}
});

// 中文注释：选定根外不提供上下文，后续读取其他根也不能破坏原快照中的有效引用。
test('上下文限定在 root，旧快照在新 root 读取后仍可解析',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<main aria-label="OUTSIDE"><section id="a" aria-label="A"><button>保存 A</button></section><section id="b" aria-label="B"><button>保存 B</button></section></main>';
  const page=f.semantics.snapshot({root:'#a'});assert.deepEqual(page.items[0].context.map(c=>c.name),['A']);
  f.semantics.snapshot({root:'#b'});assert.equal(f.semantics.resolve(token(page,page.items[0])).textContent,'保存 A');assert.equal(f.semantics.relocation(),false);
 }finally{f.close();}
});

// 中文注释：隐藏 iframe 不在语义输出范围内，不应使严格定位器误认为已读取的可见控件不完整。
test('隐藏不可读 iframe 不计语义覆盖缺口',()=>{
 const f=setup();try{
  f.document.body.innerHTML='<button>发送</button><iframe style="display:none" sandbox></iframe>';
  Object.defineProperty(f.document.querySelector('iframe'),'contentDocument',{get:()=>null});
  let page=f.semantics.snapshot({composed:true});assert.equal(page.coverage.skippedFrames,0);assert.equal(page.coverage.complete,true);assert.equal(page.items[0].name,'发送');
  f.document.querySelector('iframe').style.display='block';page=f.semantics.snapshot({composed:true});assert.equal(page.coverage.skippedFrames,1);assert.equal(page.coverage.complete,false);
 }finally{f.close();}
});
