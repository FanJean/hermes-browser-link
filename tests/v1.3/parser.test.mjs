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

// 中文注释：字段候选复用组合树扫描，但仍受记录、解析根、可见性及隐私边界限制。
test('组合树 schema 读取 Shadow 字段，普通 DOM 和非组合模式保持原行为',()=>{
 const f=fixture('<main><article id="record"></article><article id="other"><h2>其他记录</h2></article></main>');
 try{
  const record=f.dom.window.document.querySelector('#record'),shadow=record.attachShadow({mode:'open'});
  shadow.innerHTML='<h2>Shadow</h2><h2 hidden>隐藏</h2><h2 data-private>私密</h2>';
  const schema={record:'article',fields:{title:{selector:'h2',required:true}}};
  let result=f.parser.parse({composed:true,root:'#record',sections:[],schema});
  assert.equal(result.records[0].fields.title,'Shadow');assert.equal(result.records[0].states.title.status,'ok');assert.equal(result.records[0].valid,true);
  assert.equal(result.records[0].sources.title.targetPath[0].kind,'shadow');
  assert.equal(f.parser.parse({composed:false,sections:[],schema}).records[0].states.title.status,'missing');
  record.innerHTML='<h2>Light</h2>';
  result=f.parser.parse({composed:false,sections:[],schema});assert.equal(result.records[0].fields.title,'Light');
  result=f.parser.parse({composed:true,sections:[],schema});assert.equal(result.records[0].states.title.status,'ambiguous');assert.equal(result.records[0].valid,false);
  assert.equal(result.records[1].fields.title,'其他记录');
  record.querySelector('h2').remove();shadow.querySelector('h2').remove();
  assert.equal(f.parser.parse({composed:true,sections:[],schema}).records[0].states.title.status,'missing');
 }finally{f.close();}
});

test('组合树 schema 包含同源 iframe 字段，排除其他记录中的 iframe',()=>{
 const f=fixture('<article id="record"><iframe></iframe></article><article id="other"><iframe></iframe></article>');
 try{
  const frames=[...f.dom.window.document.querySelectorAll('iframe')];
  for(const [index,frame] of frames.entries()){
   frame.contentWindow.HTMLElement.prototype.getClientRects=()=>[{}];
   frame.contentDocument.body.innerHTML=`<h2>Frame ${index}</h2>`;
  }
  const schema={record:'article',fields:{title:{selector:'h2',required:true}}};
  const result=f.parser.parse({composed:true,sections:[],schema});
  assert.deepEqual(result.records.map(r=>r.fields.title),['Frame 0','Frame 1']);
  assert.equal(result.records[0].sources.title.targetPath[0].kind,'frame');
  assert.equal(f.parser.parse({composed:false,sections:[],schema}).records[0].states.title.status,'missing');
  frames[0].setAttribute('data-private','');
  assert.equal(f.parser.parse({composed:true,sections:[],schema}).records[0].states.title.status,'missing');
 }finally{f.close();}
});

// 中文注释：iframe 扫描不包含 html，祖先关系不能依赖扫描节点数量。
function frameBody(frame,html){
 frame.contentWindow.HTMLElement.prototype.getClientRects=()=>[{}];
 frame.contentDocument.body.innerHTML=html;
 return frame.contentDocument.body;
}
const frameSchema={record:'article',fields:{title:{selector:'h2',required:true}}};
for(const extra of ['', '<span></span>'])test(`最小选定根 iframe 字段不受无关 span 影响：${extra?'有 span':'无 span'}`,()=>{
 const f=fixture('<article id="record"><iframe></iframe></article>');
 try{
  frameBody(f.dom.window.document.querySelector('iframe'),`<h2>Frame title</h2>${extra}`);
  const r=f.parser.parse({root:'#record',composed:true,sections:[],schema:frameSchema});
  assert.equal(r.coverage.scanned,extra?5:4);assert.equal(r.status,'complete');
  assert.equal(r.records[0].states.title.status,'ok');assert.equal(r.records[0].fields.title,'Frame title');assert.equal(r.records[0].valid,true);
  assert.deepEqual(r.records[0].sources.title.targetPath.map(p=>p.kind),['frame']);
  assert.equal(f.parser.parse({root:'#record',composed:false,sections:[],schema:frameSchema}).records[0].states.title.status,'missing');
 }finally{f.close();}
});

// 中文注释：嵌套 frame 的字段只能归属其记录，解析根、frame 和字段的隐私及隐藏边界均生效。
test('最小嵌套 iframe 字段与记录、根、可见性和隐私边界',()=>{
 const f=fixture('<article id="record"><iframe></iframe></article><article id="other"><iframe></iframe></article>');
 try{
  const record=f.dom.window.document.querySelector('#record'),outer=record.querySelector('iframe');
  const body=frameBody(outer,'<iframe></iframe>'),inner=body.querySelector('iframe');
  const title=frameBody(inner,'<h2>Nested title</h2>').querySelector('h2');
  frameBody(f.dom.window.document.querySelector('#other iframe'),'<h2>Other title</h2>');
  const options={root:'#record',composed:true,sections:[],schema:frameSchema};
  const r=f.parser.parse(options);
  assert.equal(r.coverage.scanned,6);assert.equal(r.status,'complete');assert.equal(r.records.length,1);
  assert.equal(r.records[0].fields.title,'Nested title');assert.equal(r.records[0].valid,true);
  assert.deepEqual(r.records[0].sources.title.targetPath.map(p=>p.kind),['frame','frame']);
  assert.deepEqual(f.parser.parse({composed:true,sections:[],schema:frameSchema}).records.map(r=>r.fields.title),['Nested title','Other title']);
  assert.equal(f.parser.parse({...options,composed:false}).records[0].states.title.status,'missing');
  for(const node of [outer,inner,title])for(const attribute of ['hidden','data-private']){
   node.setAttribute(attribute,'');
   const excluded=f.parser.parse(options);assert.equal(excluded.records[0].states.title.status,'missing');assert.equal(excluded.records[0].valid,false);
   assert(!JSON.stringify(excluded).includes('Nested title'));assert(!JSON.stringify(excluded).includes('Other title'));
   node.removeAttribute(attribute);
  }
  for(const attribute of ['hidden','data-private']){
   record.setAttribute(attribute,'');assert.deepEqual(f.parser.parse(options).records,[]);record.removeAttribute(attribute);
  }
  title.remove();const absent=f.parser.parse(options);assert.equal(absent.records[0].states.title.status,'missing');assert.equal(absent.records[0].valid,false);
 }finally{f.close();}
});

// 中文注释：组合框也使用同一祖先关系，最小 iframe 选项仍须保留来源边界及过滤规则。
test('最小选定组合框读取 iframe 选项，非组合及隐藏私密选项排除',()=>{
 const f=fixture('<div id="combo" role="combobox" aria-label="地区"><iframe></iframe></div><div role="option">Other option</div>');
 try{
  const frame=f.dom.window.document.querySelector('iframe');
  const option=frameBody(frame,'<div role="option" aria-selected="true">Frame option</div>').firstElementChild;
  const options={root:'#combo',composed:true,sections:['forms']};
  const r=f.parser.parse(options);assert.equal(r.coverage.scanned,4);assert.equal(r.status,'complete');
  assert.deepEqual(r.forms[0].options,[{text:'Frame option',selected:true}]);
  assert.deepEqual(f.parser.parse({...options,composed:false}).forms[0].options,[]);
  for(const node of [frame,option])for(const attribute of ['hidden','data-private']){
   node.setAttribute(attribute,'');assert.deepEqual(f.parser.parse(options).forms[0].options,[]);node.removeAttribute(attribute);
  }
 }finally{f.close();}
});

test('组合框选项包含 Shadow 子树，排除其他控件和隐藏或私密选项',()=>{
 const f=fixture('<div role="combobox" id="combo" aria-label="地区"></div><div role="option">其他控件</div>');
 try{
  const shadow=f.dom.window.document.querySelector('#combo').attachShadow({mode:'open'});
  shadow.innerHTML='<div role="option" aria-selected="true">公开选项</div><div role="option" hidden>隐藏选项</div><div role="option" data-private>私密选项</div>';
  assert.deepEqual(f.parser.parse({composed:true,sections:['forms']}).forms[0].options,[{text:'公开选项',selected:true}]);
  assert.deepEqual(f.parser.parse({composed:false,sections:['forms']}).forms[0].options,[]);
 }finally{f.close();}
});

// 中文注释：隐式表头关联按完整列区间相交计算，保留多级表头、显式覆盖及行跨度隔离。
test('colspan 单元关联所有覆盖列的表头，普通列保持 A/B 对应',()=>{
 const f=fixture('<table><tr><th id="a">A</th><th id="b">B</th></tr><tr><td>one</td><td>two</td></tr><tr><td colspan="2">both</td></tr></table>');
 try{
  const r=f.parser.parse({sections:['tables']}),[a,b]=r.tables[0].cells.map(c=>c.sourceRef);
  assert.deepEqual(r.tables[1].cells.map(c=>c.headerRefs),[[a],[b]]);
  assert.deepEqual(r.tables[2].cells[0].headerRefs,[a,b]);assert.equal(r.tables[2].cells[0].colSpan,2);
 }finally{f.close();}
});

test('colspan 关联多层列组，显式 headers 覆盖且行表头只在 rowSpan 内生效',()=>{
 const f=fixture('<table><tr><th scope="col" rowspan="2">行</th><th id="group" scope="colgroup" colspan="2">组</th></tr><tr><th id="a" scope="col">A</th><th id="b" scope="col">B</th></tr><tr><th id="r1" scope="row" rowspan="2">R1</th><td colspan="2">both</td></tr><tr><td colspan="2" headers="b r1">explicit</td></tr><tr><th scope="row">R2</th><td colspan="2">next</td></tr></table>');
 try{
  const r=f.parser.parse({sections:['tables']}),group=r.tables[0].cells[1].sourceRef,[a,b]=r.tables[1].cells.map(c=>c.sourceRef),row1=r.tables[2].cells[0].sourceRef,row2=r.tables[4].cells[0].sourceRef;
  assert.deepEqual(r.tables[2].cells[1].headerRefs,[group,a,b,row1]);
  assert.deepEqual(r.tables[3].cells[0].headerRefs,[b,row1]);
  assert.deepEqual(r.tables[4].cells[1].headerRefs,[group,a,b,row2]);
 }finally{f.close();}
});

// 中文注释：真实组件库的行和列允许包装层，但嵌套表格、隐藏及私密列必须隔离。
test('包装层中的 ARIA treegrid 单元格保留表头关联及嵌套表格归属',()=>{
 const f=fixture('<div role="treegrid"><div role="row"><div><span role="columnheader">名称</span><span role="columnheader">数量</span></div></div><div role="row"><div><span role="gridcell">设备</span><span role="gridcell">2</span><span role="gridcell" hidden>隐藏</span><span role="gridcell" data-private>私密</span></div><div role="grid"><div role="row"><span role="gridcell">子表</span></div></div></div></div>');
 try{
  const result=f.parser.parse({sections:['tables']});
  assert.deepEqual(result.tables.map(row=>row.cells.map(cell=>cell.text)),[['名称','数量'],['设备','2'],['子表']]);
  assert.deepEqual(result.tables[1].cells.map(cell=>cell.headerRefs),result.tables[0].cells.map(cell=>[cell.sourceRef]));
  const snapshot=f.semantics.snapshot({mode:'table'});
  assert.deepEqual(snapshot.items.map(row=>row.cells),[['名称','数量'],['设备','2'],['子表']]);
  const limited=f.parser.parse({sections:['tables'],maxScan:3});
  assert.equal(limited.coverage.traversalComplete,false);assert.deepEqual(limited.tables[0].cells,[]);
 }finally{f.close();}
});

// 中文注释：下拉弹层通过 ARIA 关系归属到控件，选定根不能隐式读取外部弹层。
test('portal 组合框读取受控选项，排除其他列表与隐藏私密选项',()=>{
 const f=fixture('<div id="combo" role="combobox" aria-label="地区" aria-controls="choices" aria-owns="choices"></div><div id="choices" role="listbox"><div role="option" aria-selected="true">中国</div><div role="option">英国</div><div role="option" hidden>隐藏</div><div role="option" data-private>私密</div></div><div role="listbox"><div role="option">无关选项</div></div>');
 try{
  const r=f.parser.parse({sections:['forms']});
  assert.deepEqual(r.forms.find(field=>field.label==='地区').options,[{text:'中国',selected:true},{text:'英国',selected:false}]);
  const narrow=f.parser.parse({root:'#combo',sections:['forms']});
  assert.deepEqual(narrow.forms[0].options,[]);assert(narrow.warnings.includes('options_outside_scope'));assert.equal(narrow.status,'partial');
 }finally{f.close();}
});

// 中文注释：相对字段选择器必须以当前记录为根，同名字段不能从另一个记录借用。
test('schema 的 :scope 子选择器按每条记录解释',()=>{
 const f=fixture('<article><h2>第一条</h2><section><h2>嵌套标题</h2></section></article><article><h2>第二条</h2></article>');
 try{
  const result=f.parser.parse({sections:[],schema:{record:'article',fields:{title:{selector:':scope > h2',required:true}}}});
  assert.deepEqual(result.records.map(record=>record.fields.title),['第一条','第二条']);
  assert(result.records.every(record=>record.valid));
 }finally{f.close();}
});

// 中文注释：脱敏单位必须覆盖整个 inline 段落，选项文字也必须遵守祖先隐私边界。
test('跨节点秘密先整体脱敏，隐藏 optgroup 与私密 option 均排除',()=>{
 const f=fixture('<main><p><span>to</span><b>ken=</b><span>INLINE_SECRET_CANARY</span></p><select aria-label="规格"><option>公开</option><option data-private>PRIVATE_OPTION_CANARY</option><optgroup hidden><option>HIDDEN_OPTION_CANARY</option></optgroup><optgroup style="display:none"><option>CSS_OPTION_CANARY</option></optgroup></select></main>');
 try{const r=f.parser.parse();assert(r.blocks.some(b=>b.text==='token=[redacted]'));assert(!JSON.stringify(r).includes('_CANARY'));assert.deepEqual(r.forms[0].options,[{text:'公开',selected:true}]);}finally{f.close();}
});

// 中文注释：虚拟表格索引保留业务坐标，声明总量不能误当已读取的记录数。
test('虚拟表格保留真实 ARIA 行列索引和声明总量',()=>{
 const f=fixture('<div role="grid" aria-rowcount="1000" aria-colcount="10"><div role="row" aria-rowindex="51"><span role="gridcell" aria-colindex="4">A</span><span role="gridcell" aria-colindex="7">B</span></div></div>');
 try{const r=f.parser.parse({sections:['tables']});assert.equal(r.tables[0].row,50);assert.equal(r.tables[0].domRow,0);assert.equal(r.tables[0].declaredRows,1000);assert.equal(r.tables[0].observedRows,1);assert.deepEqual(r.tables[0].cells.map(c=>c.column),[3,6]);assert.equal(r.status,'partial');}finally{f.close();}
});

// 中文注释：结构化表单和动作快照复用编辑属性选择器，不能一处能填写另一处漏掉。
test('结构化表单识别空属性和纯文本编辑区',()=>{
 const f=fixture('<form><div contenteditable aria-label="正文"></div><div contenteditable="plaintext-only" aria-label="备注"></div><div contenteditable="false">只读</div></form>');
 try{const page=f.parser.parse({sections:['forms']});assert.deepEqual(page.forms.map(item=>[item.label,item.role]),[['正文','textbox'],['备注','textbox']]);}finally{f.close();}
});

// 中文注释：登录控件按浮层分组，sourceRef 仍然只作来源；操作需新语义快照。
test('登录模态层和无 role 的固定浮层都关联账号、密码与提交按钮',()=>{
 const controls='<input type="email" autocomplete="username" aria-label="账号"><input type="password" aria-label="密码" value="PRIVATE_PASSWORD"><button>登录</button>';
 const f=fixture(`<main><button>登录</button></main><div role="dialog" aria-modal="true" aria-label="谷歌登录">${controls}</div><div style="position:fixed;z-index:1000" aria-label="置顶登录">${controls}</div>`);
 try{
  const page=f.parser.parse({sections:['regions','forms']});
  const surfaces=page.regions.filter(region=>region.surfaceKind);
  assert.deepEqual(surfaces.map(region=>region.surfaceKind),['modal','floating']);
  for(const region of surfaces){
   const fields=page.forms.filter(field=>field.surfaceRef===region.sourceRef);
   assert.deepEqual(fields.map(field=>field.fieldKind||field.role),['account','password','button']);
   assert.ok(fields[0].actions.includes('fill'));assert.deepEqual(fields[1].actions,[]);
   assert.equal(fields[1].inputRequired,'vault_or_user');assert.ok(fields[2].actions.includes('click'));
  }
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE_PASSWORD/);
  const shot=f.semantics.snapshot({root:'[role="dialog"]'});
  assert.equal(shot.items.length,3);assert.equal(shot.items[0].context.at(-1).surfaceKind,'modal');
 }finally{f.close();}
});

test('Shadow 登录浮层解析自定义提交按钮且排除隐藏或私密的重复表单',()=>{
 const f=fixture('<div id="host"></div><div role="dialog" hidden><input aria-label="隐藏账号"></div><div role="dialog" data-private><input aria-label="私密账号"></div>');
 try{
  // 中文注释：固定本地测试 HTML，不包含网页或用户提供的字符串。
  f.dom.window.document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<div role="alertdialog" aria-modal="true"><input autocomplete="username" aria-label="账号"><div role="button" tabindex="0">继续</div></div>';
  const page=f.parser.parse({composed:true,sections:['regions','forms']});
  assert.deepEqual(page.forms.map(field=>field.label),['账号','继续']);
  assert.equal(page.regions[0].surfaceKind,'modal');
  assert.ok(page.forms[1].actions.includes('click'));assert.equal(page.forms[1].surfaceRef,page.regions[0].sourceRef);
  assert.equal(page.forms[0].targetPath[0].kind,'shadow');
 }finally{f.close();}
});

test('无名固定 section 的 iframe 登录字段保留外层浮层上下文，局部根不越界',()=>{
 const f=fixture('<section style="position:fixed"><iframe></iframe></section>');
 try{
  const inner=f.dom.window.document.querySelector('iframe').contentDocument;
  inner.defaultView.HTMLElement.prototype.getClientRects=()=>[{width:100,height:30}];
  // 中文注释：固定测试 HTML，仅补 iframe 的独立布局夹具。
  inner.body.innerHTML='<input autocomplete="username" aria-label="账号"><button>下一步</button>';
  const page=f.parser.parse({composed:true,sections:['regions','forms']});
  assert.equal(page.forms.length,2);
  const shot=f.semantics.snapshot({composed:true});assert.equal(shot.items.length,2);
  for(const field of shot.items){
   assert.equal(field.context?.at(-1).surfaceKind,'floating');
   assert.equal(field.context.at(-1).ref,page.forms[0].surfaceRef);
  }
  const semantics=createPageSemantics({document:inner,taskId:'inner',documentId:'inner',leaseId:'inner'});
  try{assert.ok(semantics.snapshot().items.every(field=>!field.context));}finally{semantics.revoke();}
 }finally{f.close();}
});

test('自定义登录按钮和 dialog 采用首个有效角色，不把后续 button 误认成按钮',()=>{
 const f=fixture('<div role="future dialog"><input autocomplete="username" aria-label="账号"><div role="future button unknown" tabindex="0">继续</div><div role="checkbox button" aria-checked="false">不是按钮</div><div role="none button">不展示</div></div>');
 try{
  const page=f.parser.parse({sections:['regions','forms']});
  assert.equal(page.regions[0].surfaceKind,'dialog');
  assert.deepEqual(page.forms.map(field=>field.label),['账号','继续']);
  assert.equal(page.forms[1].role,'button');assert.ok(page.forms[1].actions.includes('click'));
 }finally{f.close();}
});
