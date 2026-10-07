import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from './index.js';

function fixture(){
 const dom=new JSDOM('<main><div id="row" style="cursor:pointer"><span>原会话 batch1</span><button style="display:none" title="置顶">☆</button><button style="display:none" title="改名">✎</button><button style="display:none" title="删除">×</button></div></main>',{pretendToBeVisual:true});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:240,height:38}];
 const document=dom.window.document,semantics=createPageSemantics({document,taskId:'task',documentId:'doc',leaseId:'lease'});
 return {document,semantics,row:document.querySelector('#row'),close(){semantics.revoke();dom.window.close();}};
}

test('悬停显示独立操作按钮不改变推断点击行的名称和引用',()=>{
 const f=fixture();try{
  const first=f.semantics.snapshot({query:'原会话 batch1'}),row=first.items.find(item=>item.inferred);
  assert.equal(row.name,'原会话 batch1');
  for(const button of f.row.querySelectorAll('button'))button.style.display='block';
  assert.equal(f.semantics.resolve({...first.binding,snapshotId:first.snapshotId,ref:row.ref}),f.row);
  const after=f.semantics.snapshot();
  assert.equal(after.items.find(item=>item.ref===row.ref).name,row.name);
  assert.deepEqual(after.items.filter(item=>item.ref!==row.ref).map(item=>item.name),['置顶','改名','删除']);
 }finally{f.close();}
});

test('行内业务文字变化仍使旧引用失效，不能借名称修复点击其他会话',()=>{
 const f=fixture();try{
  const first=f.semantics.snapshot(),row=first.items.find(item=>item.inferred);
  f.row.querySelector('span').textContent='另一个会话 batch2';
  assert.throws(()=>f.semantics.resolve({...first.binding,snapshotId:first.snapshotId,ref:row.ref}),/REF_TARGET_MISSING/);
 }finally{f.close();}
});

test('正文读取仍包含独立控件文字，不因为交互命名裁剪正文',()=>{
 const f=fixture();try{
  for(const button of f.row.querySelectorAll('button'))button.style.display='block';
  f.row.innerHTML='<p>原会话 batch1 <button>业务详情</button></p>';
  const page=f.semantics.snapshot({mode:'content'});
  assert.ok(page.items.some(item=>item.name.includes('业务详情')));
 }finally{f.close();}
});

test('显式 ARIA 名称仍优先，嵌套操作按钮独立定位',()=>{
 const f=fixture();try{
  f.row.setAttribute('aria-label','已命名的会话');
  for(const button of f.row.querySelectorAll('button'))button.style.display='block';
  const page=f.semantics.snapshot(),row=page.items.find(item=>item.inferred);
  assert.equal(row.name,'已命名的会话');
  assert.equal(page.items.filter(item=>item.name==='删除').length,1);
 }finally{f.close();}
});

// 中文注释：Array.map 的第二参是索引，不能被误当作裁剪独立控件的开关。
test('表格各列中的链接文字保持完整，不受 map 回调索引影响',()=>{
 const f=fixture();try{
  f.document.body.insertAdjacentHTML('beforeend','<table><tr><td>第一列</td><td><a href="/">第二列链接</a></td></tr></table>');
  const row=f.semantics.parsingContext().describe(f.document.querySelector('tr'));
  assert.deepEqual(row.cells,['第一列','第二列链接']);
 }finally{f.close();}
});

test('图标按钮采用 title，单控件包装的邻近文本经过脱敏且不跨兄弟控件',()=>{
 const f=fixture();try{
  f.document.body.innerHTML='<button title="设置">⚙</button><span>下载报告 <button><svg></svg></button></span><span>共享名称 <button></button><button></button></span><span data-private>PRIVATE_TOKEN <button></button></span>';
  const buttons=f.semantics.snapshot().items.filter(item=>item.role==='button');
  assert.equal(buttons[0].name,'设置');assert.equal(buttons[1].name,'下载报告');
  assert.equal(buttons[2].name,'');assert.equal(buttons[3].name,'');
  assert.doesNotMatch(JSON.stringify(buttons),/PRIVATE_TOKEN/);
 }finally{f.close();}
});
