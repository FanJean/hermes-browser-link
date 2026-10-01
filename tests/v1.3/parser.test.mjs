import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';
import {createPageParser} from '../../page-semantics/parser.mjs';
// 中文注释：使用真实 DOM 结构验证解析来源与合并单元格，布局由 fixture 提供。
function fixture(html){
 const dom=new JSDOM(html,{url:'https://example.test/'});
 dom.window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
 const semantics=createPageSemantics({document:dom.window.document,taskId:'t',documentId:'d',leaseId:'l'});
 return {dom,semantics,parser:createPageParser(semantics.parsingContext()),close(){semantics.revoke();dom.window.close();}};
}
test('parses structured regions, div content, spans and controls without input values',()=>{
 const f=fixture('<main><h1>产品</h1><div>可见正文</div><table><tr><th colspan="2">规格</th></tr><tr><th>名称</th><th>价格</th></tr><tr><td>鼠标</td><td>99</td></tr></table><form><label>密码<input type="password" value="SUPERSECRET"></label></form></main>');
 try{const result=f.parser.parse();assert.equal(result.regions[0].kind,'main');assert(result.blocks.some(b=>b.text==='可见正文'));assert.equal(result.tables[0].cells[0].colSpan,2);assert.equal(result.tables[2].cells[1].headerRefs.length,2);assert(!JSON.stringify(result).includes('SUPERSECRET'));assert.equal(result.forms.length,1);}finally{f.close();}
});
test('extracts with field evidence and does not coerce ambiguous currency',()=>{
 const f=fixture('<ul><li><h2>鼠标</h2><span class="price">￥99,00</span></li><li><h2>键盘</h2><span class="price">123</span></li></ul>');
 try{const r=f.parser.parse({sections:[],schema:{record:'li',fields:{title:{selector:'h2',required:true},price:{selector:'.price',type:'number'},missing:{selector:'.none',required:true}}}});assert.equal(r.records.length,2);assert.equal(r.records[0].states.price.status,'invalid_format');assert.equal(r.records[1].fields.price,123);assert.equal(r.records[0].valid,false);assert(r.records[0].sources.title.sourceRef);assert.throws(()=>f.semantics.resolve({...r.binding,snapshotId:r.parseId,ref:r.records[0].sourceRef}));}finally{f.close();}
});
test('page cursor rejects document change and budget never asserts completeness',()=>{
 const f=fixture('<main>'+Array.from({length:40},(_,i)=>`<p>段落 ${i} ${'内容 '.repeat(10)}</p>`).join('')+'</main>');
 try{const a=f.parser.parse({sections:['blocks'],budget:700});assert(a.nextCursor);assert.equal(a.status,'partial');const b=f.parser.parse({sections:['blocks'],budget:700,cursor:a.nextCursor});assert(b.coverage.offset>0);f.dom.window.document.querySelector('p').textContent='变化';assert.throws(()=>f.parser.parse({sections:['blocks'],budget:700,cursor:b.nextCursor}),/PARSE_CURSOR_STALE/);}finally{f.close();}
});
test('hidden and private content never becomes extracted evidence',()=>{
 const f=fixture('<main><p hidden>HIDDEN</p><p data-private>PRIVATE</p><p>token="SECRET"</p></main>');
 try{const r=f.parser.parse();const s=JSON.stringify(r);assert(!s.includes('HIDDEN'));assert(!s.includes('PRIVATE'));assert(!s.includes('SECRET'));assert(s.includes('[redacted]'));}finally{f.close();}
});

// 中文注释：正文分块不能漏掉混合文本，也不能把分散在 inline 标签中的秘密拼回输出。
test('mixed div text and inline secrets are read as one redacted block',()=>{
 const f=fixture('<main><div>你好 <span>世界</span></div><div><span>token=</span><span>VERYSECRET</span></div><select aria-label="规格"><option value="private-id">公开选项</option></select></main>');
 try{const r=f.parser.parse();assert(r.blocks.some(b=>b.text.includes('你好')&&b.text.includes('世界')));assert(!JSON.stringify(r).includes('VERYSECRET'));assert(r.forms[0].options.some(o=>o.text==='公开选项'));assert(!JSON.stringify(r).includes('private-id'));}finally{f.close();}
});

// 中文注释：显式 headers 优先于几何推断，行表头不能污染后续行。
test('explicit header ids and row headers preserve exact table relationships',()=>{
 const f=fixture('<table><tr><th id="name">Name</th><th id="price">Price</th></tr><tr><th id="a" scope="row">A</th><td headers="price a">12</td></tr><tr><th id="b" scope="row">B</th><td>24</td></tr></table>');
 try{const r=f.parser.parse({sections:['tables']});const price=r.tables[0].cells[1].sourceRef,a=r.tables[1].cells[0].sourceRef,b=r.tables[2].cells[0].sourceRef;assert.deepEqual(r.tables[1].cells[1].headerRefs,[price,a]);assert.deepEqual(r.tables[2].cells[1].headerRefs,[price,b]);assert.equal(r.tables[1].cells[0].headerRole,'row');}finally{f.close();}
});

// 中文注释：表单保留分组及显式错误关系，但不读取输入值。
test('form groups and validation messages remain associated without values',()=>{
 const f=fixture('<form><fieldset><legend>账户资料</legend><label>名称<input value="PRIVATE_VALUE" required aria-invalid="true" aria-errormessage="validation"></label><p id="validation">名称需要至少两个字</p></fieldset></form>');
 try{const r=f.parser.parse({sections:['forms']});assert.equal(r.forms[0].groupLabel,'账户资料');assert.equal(r.forms[0].validationMessage,'名称需要至少两个字');assert.equal(r.forms[0].state.invalid,true);assert(r.forms[0].groupRef);assert(!JSON.stringify(r).includes('PRIVATE_VALUE'));}finally{f.close();}
});
