import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from './index.js';

function fixture(html){
 const dom=new JSDOM(html,{pretendToBeVisual:true});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:30}];
 const document=dom.window.document,semantics=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l'});
 return {document,semantics,close(){semantics.revoke();dom.window.close();}};
}
test('角色采用首个有效非抽象 ARIA token，未知角色不覆盖原生角色',()=>{
 const f=fixture('<button role="future command button">保存</button><input role="future" aria-label="字段"><div role="future menuitemcheckbox" aria-checked="mixed">显示列</div>');
 try{
  const items=f.semantics.snapshot().items;
  assert.deepEqual(items.map(item=>item.role),['button','textbox','menuitemcheckbox']);
  assert.equal(items[2].checked,'mixed');assert.ok(items[2].actions.includes('set_checked'));
 }finally{f.close();}
});
test('控件的固定动作清单区分编辑、勾选、选择与普通按钮，不读取值',()=>{
 const f=fixture('<button>保存</button><input aria-label="姓名" value="PRIVATE_INPUT"><input type="checkbox" aria-label="启用"><select aria-label="地区"><option>中国</option></select><div contenteditable="plaintext-only" aria-label="正文">PRIVATE_EDITOR</div><div role="textbox" aria-label="展示字段">PRIVATE_DISPLAY</div>');
 try{
  const items=f.semantics.snapshot().items;
  assert.deepEqual(items[0].actions,['click','press']);
  assert.deepEqual(items[1].actions,['click','press','fill']);
  assert.deepEqual(items[2].actions,['click','press','set_checked']);
  assert.deepEqual(items[3].actions,['click','press','select_option']);
  assert.ok(items[4].actions.includes('fill'));assert.ok(!items[5].actions.includes('fill'));
  assert.doesNotMatch(JSON.stringify(items),/PRIVATE/);
 }finally{f.close();}
});
test('禁用状态继承 ARIA 祖先，原生 fieldset 保留首个 legend 例外',()=>{
 const f=fixture('<div aria-disabled="true"><button>祖先禁用</button></div><fieldset disabled><legend><button>图例</button></legend><input aria-label="字段"></fieldset>');
 try{
  const items=f.semantics.snapshot().items;
  assert.equal(items[0].disabled,true);assert.deepEqual(items[0].actions,[]);
  assert.equal(items[1].disabled,undefined);assert.ok(items[1].actions.includes('click'));
  assert.equal(items[2].disabled,true);assert.deepEqual(items[2].actions,[]);
 }finally{f.close();}
});
test('只读和受限制输入不声明填写能力，角色本身不赋予编辑能力',()=>{
 const f=fixture('<input readonly aria-label="只读"><div contenteditable aria-readonly="true" aria-label="只读正文"></div><input type="password" aria-label="密码" value="PRIVATE_SECRET"><input type="file" aria-label="文件"><input type="range" aria-label="范围">');
 try{
  const items=f.semantics.snapshot().items;
  for(const item of items)assert.ok(!item.actions.includes('fill'));
  assert.equal(items[1].readonly,true);assert.deepEqual(items[2].actions,[]);assert.deepEqual(items[3].actions,[]);
  assert.doesNotMatch(JSON.stringify(items),/PRIVATE_SECRET/);
 }finally{f.close();}
});
test('动作清单改变参与增量快照，重新解析反映当前能力',()=>{
 const f=fixture('<input aria-label="姓名">');try{
  const first=f.semantics.snapshot(),field=f.document.querySelector('input');
  field.setAttribute('aria-readonly','true');
  const next=f.semantics.snapshot({baselineId:first.snapshotId});
  assert.equal(next.kind,'delta');assert.equal(next.items.length,1);assert.ok(!next.items[0].actions.includes('fill'));
  field.removeAttribute('aria-readonly');assert.ok(f.semantics.snapshot().items[0].actions.includes('fill'));
 }finally{f.close();}
});
