// 中文注释：只读结构解析复用语义模块的可见性、脱敏与文档身份；来源引用不能用于动作。
export function createPageParser(context) {
 const {doc,binding,visible,read,describe,source,scan,revision}=context;
 const sections=['regions','blocks','tables','forms','collections'];
 let continuation=null;
 const fail=()=>{throw Error('INVALID_PARSE_OPTIONS');};
 const limited=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
 const cleanURL=value=>{try{const url=new URL(value,doc.baseURI);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.origin+url.pathname:null;}catch{return null;}};
 const parent=node=>node.parentElement||node.getRootNode()?.host||node.ownerDocument.defaultView?.frameElement||null;
 const nearest=(node,predicate)=>{for(let n=parent(node);n;n=parent(n))if(predicate(n))return n;return null;};
 const matches=(node,selector)=>{try{return node.matches(selector);}catch{fail();}};
 const tableSelector='table,[role="table"],[role="grid"],[role="treegrid"]';
 function parse(options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options))fail();
  const allowed=['root','sections','composed','budget','cursor','maxScan','schema','frameToken'];
  if(Object.keys(options).some(k=>!allowed.includes(k)))fail();
  const {root=null,composed=false,budget=12000,maxScan=20000,schema=null}=options;
  if(typeof composed!=='boolean'||!limited(budget,512,60000)||!limited(maxScan,1,100000))fail();
  const selected=options.sections??sections;
  if(!Array.isArray(selected)||selected.some(s=>!sections.includes(s))||selected.length>5)fail();
  if(root!==null&&(typeof root!=='string'||!root||root.length>512))fail();
  const scope=root?doc.querySelector(root):doc.body;
  if(!scope||!scope.isConnected)throw Error('INVALID_ROOT');
  const epoch=revision();
  const fingerprint=JSON.stringify({root,composed,budget,maxScan,selected,schema});
  let offset=0;
  if(options.cursor){
   if(!continuation||continuation.token!==options.cursor||continuation.epoch!==epoch||continuation.fingerprint!==fingerprint)throw Error('PARSE_CURSOR_STALE');
   offset=continuation.offset;
  }
  const parseId=crypto.randomUUID(),coverage={scanned:0,skippedFrames:0,traversalComplete:true,scope:composed?'reachable composed DOM':'light DOM',complete:false,totalRecords:null};
  const warnings=new Set(),nodes=[];
  for(const node of scan(scope,composed,coverage)){
   if(coverage.scanned>=maxScan){coverage.traversalComplete=false;warnings.add('scan_limit');break;}
   coverage.scanned++;if(visible(node,false))nodes.push(node);
  }
  // 中文注释：按真实祖先链回溯至解析根；frame 的 html 未被扫描，不能用扫描数限深。重复节点拒绝解析，避免循环或误报缺失。
  const contains=(container,node)=>{
   if(!composed)return container.contains(node);
   const seen=new Set();
   for(let current=node;current;current=parent(current)){
    if(seen.has(current))throw Error('INVALID_DOM_ANCESTRY');
    seen.add(current);
    if(current===container)return true;
    if(current===scope)break;
   }
   return false;
  };
  if(coverage.skippedFrames)warnings.add('unread_frames');
  const entries=[];
  const safe=node=>{const value=read(node);if(value.truncated)warnings.add('text_truncated');return value;};
  const evidence=node=>({...source(node),parseId});
  const name=node=>safe(node).text;
  const add=(section,value)=>{if(selected.includes(section))entries.push({section,value});};
  const nodeSet=new Set(nodes);
  const regionNodes=new Set(nodes.filter(n=>matches(n,'main,nav,aside,header,footer,section,article,dialog,[role="dialog"],[role="main"],[role="navigation"],[role="complementary"],[role="region"]')));
  for(const node of selected.includes('regions')?regionNodes:[]){
   const ancestor=nearest(node,n=>regionNodes.has(n));
   add('regions',{...evidence(node),kind:node.getAttribute('role')||node.localName,name:describe(node).name,parentRef:ancestor?source(ancestor).sourceRef:null,method:'semantic',excludedFromContent:matches(node,'nav,header,footer,[role="navigation"]')&&node!==scope});
  }
  // 中文注释：块只取最内层正文单元，避免父子容器全文重复。
  const blockSelector='h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,div,span,a[href],img';
  const blockNodes=new Set(nodes.filter(n=>matches(n,blockSelector)&&!nearest(n,a=>matches(a,tableSelector+',form'))));
  for(const node of selected.includes('blocks')?blockNodes:[]){
   const ownText=n=>[...n.childNodes].some(child=>child.nodeType===3&&child.textContent.trim());
   // 中文注释：段落、列表项与标题中的 inline 文字先整体脱敏，不能把秘密标签和值拆成独立块。
   const inlineGroup=n=>n.children.length>0&&[...n.children].every(child=>matches(child,'span,a,strong,em,b,i,code,br'));
   if(nearest(node,n=>blockNodes.has(n)&&(ownText(n)||inlineGroup(n))))continue;
   if([...node.children].some(child=>blockNodes.has(child))&&!matches(node,'pre,blockquote')&&!ownText(node)&&!inlineGroup(node))continue;
   const navigation=nearest(node,n=>matches(n,'nav,header,footer,[role="navigation"]'));
   if(navigation&&navigation!==scope)continue;
   if(nearest(node,n=>matches(n,'pre,blockquote')))continue;
   const value=matches(node,'img')?context.attribute(node,'alt'):safe(node);
   const text=value.text??value.name??'';
   if(!text&&!matches(node,'img'))continue;
   const region=nearest(node,n=>regionNodes.has(n));
   add('blocks',{...evidence(node),kind:node.localName,text,regionRef:region?source(region).sourceRef:null,
    ...(/^h[1-6]$/.test(node.localName)?{level:Number(node.localName[1])}:{}),
    ...(matches(node,'a[href]')?{href:cleanURL(node.href)}:{}),...(value.truncated?{truncated:true}:{})});
  }
  // 中文注释：每一行作为一个可分页片段，保留跨度来源，不把合并单元格复制为业务记录。
  for(const table of selected.includes('tables')?nodes.filter(n=>matches(n,tableSelector)):[]){
   const rows=nodes.filter(n=>matches(n,'tr,[role="row"]')&&nearest(n,a=>matches(a,tableSelector))===table);
   const occupied=new Map(),headers=[],rowHeaders=[];
   // 中文注释：声明总量与实际加载范围分别返回，ARIA 索引不改写为 DOM 顺序。
   const declaredRows=Number(table.getAttribute('aria-rowcount')),declaredColumns=Number(table.getAttribute('aria-colcount'));
   const declaredIndex=(node,key)=>{const raw=node.getAttribute(key);if(raw===null)return null;const index=Number(raw);if(!Number.isSafeInteger(index)||index<1){warnings.add('invalid_grid_index');return null;}return index-1;};
   if(table.hasAttribute('aria-rowcount'))warnings.add('declared_row_count_unverified');
   if(table.hasAttribute('aria-colcount'))warnings.add('declared_column_count_unverified');
   for(let r=0;r<rows.length;r++){
    const row=rows[r],cells=[],rowIndex=declaredIndex(row,'aria-rowindex')??r;let column=declaredIndex(row,'aria-colindex')??0;
    // 中文注释：复用语义快照的单元格归属，包装 div 不丢列；扫描范围外的单元格不进入结果。
    const children=context.cells(row).filter(n=>nodeSet.has(n));
    if(children.length>40)warnings.add('column_limit');
    for(const cell of children.slice(0,40)){
     const columnIndex=declaredIndex(cell,'aria-colindex');if(columnIndex!==null){if(columnIndex<column)warnings.add('invalid_grid_index');column=columnIndex;}
     while((occupied.get(column)||0)>rowIndex)column++;
     const rawRow=Number(cell.getAttribute('rowspan')??cell.getAttribute('aria-rowspan')??1),rawCol=Number(cell.getAttribute('colspan')??cell.getAttribute('aria-colspan')??1);
     if(!Number.isInteger(rawRow)||!Number.isInteger(rawCol)||rawRow<0||rawCol<1||rawRow>100||rawCol>40)warnings.add('unsupported_span');
     const rowSpan=rawRow===0?Math.min(100,rows.slice(r).filter(n=>n.parentElement===row.parentElement).length):Number.isInteger(rawRow)?Math.min(100,Math.max(1,rawRow)):1;
     const colSpan=Number.isInteger(rawCol)?Math.min(40,Math.max(1,rawCol)):1;
     if(column+colSpan>100){warnings.add('column_limit');break;}
     const value=safe(cell),header=cell.localName==='th'||['columnheader','rowheader'].includes(cell.getAttribute('role'));
     const scope=cell.getAttribute('scope'),headerRole=header?(scope==='row'||scope==='rowgroup'||cell.getAttribute('role')==='rowheader'||!scope&&column===0&&children.some(n=>n.localName==='td')?'row':'column'):null;
     const explicit=(cell.getAttribute('headers')||'').split(/\s+/).filter(Boolean).slice(0,40);
     const explicitNodes=explicit.map(id=>cell.getRootNode().getElementById?.(id));
     if(explicitNodes.some(n=>!n||!visible(n,false)||nearest(n,a=>matches(a,tableSelector))!==table))warnings.add('unresolved_header');
     const related=explicit.length?explicitNodes.filter(n=>n&&visible(n,false)&&nearest(n,a=>matches(a,tableSelector))===table).map(n=>source(n).sourceRef)
      // 中文注释：数据单元和列表头的半开区间相交即关联，不能只检查数据起始列。
      :[...headers.filter(h=>h.column<column+colSpan&&h.column+h.colSpan>column),...rowHeaders.filter(h=>h.row<=rowIndex&&h.row+h.rowSpan>rowIndex)].map(h=>h.sourceRef);
     const entry={...evidence(cell),text:value.text,row:rowIndex,column,rowSpan,colSpan,header,headerRole,headerRefs:related};
     cells.push(entry);if(headerRole==='column')headers.push(entry);if(headerRole==='row')rowHeaders.push(entry);
     for(let c=column;c<column+colSpan;c++)occupied.set(c,rowIndex+rowSpan);
     column+=colSpan;
    }
    add('tables',{tableRef:source(table).sourceRef,...evidence(row),row:rowIndex,domRow:r,cells,observedRows:rows.length,
     ...(Number.isSafeInteger(declaredRows)&&declaredRows>0?{declaredRows}:{}),...(Number.isSafeInteger(declaredColumns)&&declaredColumns>0?{declaredColumns}:{})});
   }
  }
  for(const node of selected.includes('forms')?nodes.filter(n=>matches(n,`input,select,textarea,button,[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="checkbox"],[role="radio"],[role="switch"],${context.editable}`)):[]){
   const field=describe(node),form=nearest(node,n=>matches(n,'form,[role="form"]'));
   const errorIds=(node.getAttribute('aria-errormessage')||'').split(/\s+/).slice(0,10);
   const errors=errorIds.map(id=>node.getRootNode().getElementById?.(id)).filter(n=>n&&visible(n,false));
   const group=nearest(node,n=>matches(n,'fieldset,[role="group"]'));
   const legend=group?.querySelector('legend');
   const related=(node.getAttribute('aria-describedby')||'').split(/\s+/).slice(0,10).map(id=>node.getRootNode().getElementById?.(id)).filter(n=>n&&visible(n,false));
   // 中文注释：portal 下拉选项通过显式 ARIA 关系关联；不能扩展选定根或跨到其他控件。
   const listRoots=[node];
   for(const id of ((node.getAttribute('aria-controls')||'')+' '+(node.getAttribute('aria-owns')||'')).split(/\s+/).filter(Boolean).slice(0,100)){
    const list=node.getRootNode().getElementById?.(id);
    if(list&&nodeSet.has(list))listRoots.push(list);
    else if(list&&visible(list,false))warnings.add('options_outside_scope');
   }
   const optionNodes=node.localName==='select'?[...node.options].filter(context.optionVisible):nodes.filter(n=>matches(n,'[role="option"]')&&listRoots.some(list=>contains(list,n)));
   if(optionNodes.length>100)warnings.add('option_limit');
   const options=optionNodes.slice(0,100).map(n=>({text:context.option(n).text,selected:n.selected===true||n.getAttribute('aria-selected')==='true'}));
   add('forms',{...evidence(node),formRef:form?source(form).sourceRef:null,groupRef:group?source(group).sourceRef:null,groupLabel:legend?name(legend):group?context.attribute(group,'aria-label').text:'',label:field.name,role:field.role,validationMessage:errors.map(name).join(' '),
    state:{...Object.fromEntries(['disabled','required','readonly','checked','selected','expanded','busy'].filter(k=>Object.hasOwn(field,k)).map(k=>[k,field[k]])),invalid:node.getAttribute('aria-invalid')==='true'},description:related.map(name).join(' '),options});
  }
  // 中文注释：记录边界取明确列表项/文章或带重复子结构的容器，并标记推断来源。
  const recordNodes=nodes.filter(n=>matches(n,'li,article,[role="listitem"]')||n.parentElement&&['div','section'].includes(n.localName)&&n.parentElement.children.length>=2&&n.querySelector('h1,h2,h3,h4,a[href]')&&[...n.parentElement.children].filter(c=>c.localName===n.localName&&c.className===n.className).length>=2);
  for(const node of selected.includes('collections')?recordNodes.slice(0,1000):[])add('collections',{...evidence(node),containerRef:parent(node)?source(parent(node)).sourceRef:null,text:name(node),classification:'unclassified',method:matches(node,'li,article,[role="listitem"]')?'semantic':'inferred'});
  if(recordNodes.length>1000)warnings.add('record_limit');
  if(schema){
   if(typeof schema!=='object'||Array.isArray(schema)||Object.keys(schema).some(k=>!['record','fields'].includes(k))||typeof schema.record!=='string'||!schema.record||schema.record.length>512||!schema.fields||typeof schema.fields!=='object'||Array.isArray(schema.fields)||Object.keys(schema.fields).length>40)fail();
   const records=nodes.filter(n=>matches(n,schema.record));
   coverage.observedRecords=records.length;
   for(const record of records.slice(0,1000)){
    const fields={},sources={},states={};
    for(const [key,rule] of Object.entries(schema.fields)){
     if(!/^[A-Za-z_][\w-]{0,63}$/.test(key)||!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(k=>!['selector','type','attribute','required'].includes(k))||typeof rule.selector!=='string'||rule.selector.length>512||!['text','number','url'].includes(rule.type||'text')||!['href','src','alt','title','datetime',undefined].includes(rule.attribute)||('required' in rule&&typeof rule.required!=='boolean'))fail();
     // 中文注释：带 :scope 的字段选择器由记录节点解释，不能把每个候选节点当作自身作用域。
     let scoped=null;
     if(rule.selector.includes(':scope')&&rule.selector!==':scope'){
      try{scoped=new Set(record.querySelectorAll(rule.selector));}catch{fail();}
     }
     const candidates=rule.selector===':scope'?[record]:nodes.filter(n=>contains(record,n)&&(scoped?scoped.has(n):matches(n,rule.selector)));
     let status=candidates.length===0?'missing':candidates.length>1?'ambiguous':'ok',value=null,raw=null;
     if(candidates.length===1){
      const node=candidates[0];sources[key]=evidence(node);
      if(matches(node,`input,textarea,select,${context.editable}`))status='unsupported';
      else{
       const readValue=rule.attribute?context.attribute(node,rule.attribute):safe(node);raw=readValue.text;
       if(readValue.truncated){status='truncated';warnings.add('text_truncated');}
       else if(raw.includes('[redacted]'))status='redacted';
       else if(!raw.trim())status='empty';
       else if(rule.type==='number'){if(/^-?\d+(?:\.\d+)?$/.test(raw.trim())&&Number.isFinite(Number(raw)))value=Number(raw);else status='invalid_format';}
       else if(rule.type==='url'){value=cleanURL(raw);if(value===null)status='invalid_format';}
       else value=raw;
      }
     }
     fields[key]=value;states[key]={status,required:rule.required===true,raw};
    }
    entries.push({section:'records',value:{...evidence(record),fields,sources,states,valid:Object.values(states).every(s=>!s.required||s.status==='ok')}});
   }
   if(records.length>1000)warnings.add('record_limit');
  }
  if(revision()!==epoch)throw Error('DOCUMENT_CHANGED');
  const result={schemaVersion:1,parseId,binding,regions:[],blocks:[],tables:[],forms:[],collections:[],records:[],coverage,warnings:[...warnings],nextCursor:null};
  let index=offset;
  for(;index<entries.length;index++){
   const {section,value}=entries[index];result[section].push(value);
   if(JSON.stringify(result).length>budget*4-800){result[section].pop();break;}
  }
  coverage.returned=index-offset;coverage.matched=entries.length;coverage.offset=offset;
  coverage.complete=coverage.traversalComplete&&coverage.skippedFrames===0&&warnings.size===0&&offset===0&&index===entries.length;
  if(index<entries.length){
   if(index===offset){result.warnings.push('entry_exceeds_budget');continuation=null;}
   else{continuation={token:crypto.randomUUID(),epoch,fingerprint,offset:index};result.nextCursor=continuation.token;}
  }else continuation=null;
  result.status=coverage.complete?'complete':'partial';
  if(JSON.stringify(result).length>budget*4)throw Error('BUDGET_TOO_SMALL');
  return result;
 }
 return {parse};
}
