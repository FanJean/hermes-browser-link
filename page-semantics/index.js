/** Browser ESM; does not execute actions or bypass the host's approval gate. */
export function createPageSemantics({document: doc = globalThis.document, taskId, documentId, leaseId, expiresAt = Infinity, maxScan = 20000, maxItems = 200, maxText = 400, shadowRootOf = node => node.shadowRoot} = {}) {
  for (const v of [taskId, documentId, leaseId]) if (typeof v !== 'string' || !v || v.length > 128) throw new Error('BINDING_REQUIRED');
  if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) throw new Error('INVALID_EXPIRY');
  for (const v of [maxScan,maxItems,maxText]) if (!Number.isSafeInteger(v) || v < 1) throw new Error('INVALID_LIMIT');
  maxScan=Math.min(maxScan,100000); maxItems=Math.min(maxItems,1000); maxText=Math.min(maxText,2000);
  const binding=Object.freeze({taskId,documentId,leaseId});
  const instance=Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
  const documentIds=new WeakMap([[doc,documentId]]);let childDocumentSequence=0;
  const identityFor=other=>{if(!documentIds.has(other))documentIds.set(other,`${instance}:document:${++childDocumentSequence}`);return documentIds.get(other);};
  const refs=new WeakMap(); let sequence=0n,generation=0n,currentId;
  let active=new Map(), baseline=null, cursorState=null, epoch=0, revoked=false, frameDocuments=new Map();
  const savedSnapshots=new Map();
  // 中文注释：无障碍补充只保存在真实节点上，任何 DOM epoch 变化都会使其失效。
  const accessibilityNames=new WeakMap();
  // 中文注释：样式和上下文缓存只活在一次同步解析内，下一次读或动作必定重新计算。
  let styles=new WeakMap(),contextNames=new WeakMap();
  const computed=node=>{if(!styles.has(node))styles.set(node,node.ownerDocument.defaultView.getComputedStyle(node));return styles.get(node);};
  const documentRoot=doc.documentElement;
  const isOverlay=node=>{
    for(let n=node;n;n=n.parentNode || n.host){if(n.nodeType===1 && n.hasAttribute?.('data-hermes-automation-overlay'))return true;}
    return false;
  };
  const realMutation=record=>{
    if(isOverlay(record.target))return false;
    if(record.type!=='childList')return true;
    const nodes=[...record.addedNodes,...record.removedNodes];
    return nodes.length===0 || nodes.some(node=>!isOverlay(node));
  };
  const changed=records=>{if(records.some(realMutation))epoch++;};
  const observer=new doc.defaultView.MutationObserver(changed);
  observer.observe(doc,{subtree:true,childList:true,attributes:true,characterData:true});
  function sync(){
    styles=new WeakMap();contextNames=new WeakMap();
    changed(observer.takeRecords());
    if(revoked)throw new Error('LEASE_REVOKED');if(Date.now()>=expiresAt)throw new Error('LEASE_EXPIRED');if(doc.documentElement!==documentRoot)throw new Error('DOCUMENT_REPLACED');
    for(const [frame,state] of frameDocuments){
      let current;try{current=frame.contentDocument;}catch{current=null;}
      if(!frame.isConnected || current!==state.document || current?.documentElement!==state.root)epoch++;
    }
  }
  function revoke(){revoked=true;active.clear();savedSnapshots.clear();frameDocuments.clear();baseline=null;cursorState=null;observer.disconnect();}
  function stats(){return {activeRefs:active.size,baselineItems:baseline?.items.length||0,cursors:cursorState?1:0,maxItems,maxScan,maxText};}
  // 中文注释：复用合法 HTML 编辑属性形式，空值和纯文本模式与 true 使用相同解析链路。
  const editable='[contenteditable="true" i],[contenteditable=""],[contenteditable="plaintext-only" i]';
  const checkRoles=new Set(['checkbox','radio','switch','menuitemcheckbox','menuitemradio']);
  const interactiveRoles=new Set([...checkRoles,...'button link textbox searchbox combobox listbox option menuitem slider spinbutton tab treeitem'.split(' ')]);
  // 中文注释：按 WAI-ARIA 1.2 采用首个有效非抽象角色，未知 token 不覆盖原生语义。
  const ariaRoles=new Set([...interactiveRoles,...'alert alertdialog application article banner blockquote caption cell code columnheader complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion list listitem log main marquee math menu menubar meter navigation none note paragraph presentation progressbar radiogroup region row rowgroup rowheader scrollbar search separator status strong subscript suggestion superscript table tablist tabpanel term time timer toolbar tooltip tree treegrid'.split(' ')]);
  const selectors={interactive:`button,a[href],input,select,textarea,summary,${editable},[role],[tabindex],div,span`,content:'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,[role=heading]',table:'tr,[role=row],[data-ui-name="Body.Row"]'};
  function ref(node){if(!refs.has(node))refs.set(node,`${instance}:e${++sequence}`);return refs.get(node);}
  function quotedValueEnd(text,start,quote){
    for(let i=start+1;i<text.length;i++){
      if(text[i]==='\\'){i++;continue;}
      if(text[i]===quote)return i;
    }
    return -1;
  }
  // A quoted value is structured only when its closing quote is followed by a separator.
  function quoteHasBoundary(text,end){return end===text.length || /[\s|,;)}\]]/.test(text[end]);}
  // Unquoted values are ambiguous; only a balanced quoted value can expose following text.
  function sensitiveMarkers(text){
    const markers=new Set();
    const label=/\b(password|passwd|token|secret|api[-_ ]?key)\s*[:=]/gi;
    for(const match of text.matchAll(label))markers.add(`${match[1]}=[redacted]`);
    if(/\bBearer\s+/i.test(text))markers.add('Bearer [redacted]');
    if(/\[email\]/i.test(text))markers.add('[email]');
    if(/\[number\]/i.test(text))markers.add('[number]');
    return [...markers].join(' ');
  }
  function redactLabeledValues(text){
    const label=/\b(password|passwd|token|secret|api[-_ ]?key)\s*[:=]\s*/gi;
    let out='',cursor=0,match;
    while((match=label.exec(text))){
      if(match.index<cursor)continue;
      out+=text.slice(cursor,match.index);
      const start=label.lastIndex,quote=text[start];
      if(quote==='"' || quote==="'"){
        const end=quotedValueEnd(text,start,quote);
        out+=`${match[1]}=[redacted]`;
        if(end<0 || !quoteHasBoundary(text,end+1)){
          cursor=text.length;label.lastIndex=cursor;break;
        }
        cursor=end+1;label.lastIndex=cursor;
      }else{
        out+=`${match[1]}=[redacted]`;
        const markers=sensitiveMarkers(text.slice(start));if(markers)out+=` ${markers}`;
        cursor=text.length;label.lastIndex=cursor;break;
      }
    }
    return out+text.slice(cursor);
  }
  function redactBearerValues(text){
    const bearer=/\bBearer\s+/gi;
    let out='',cursor=0,match;
    while((match=bearer.exec(text))){
      if(match.index<cursor)continue;
      out+=text.slice(cursor,match.index);
      const start=bearer.lastIndex,quote=text[start];
      out+='Bearer [redacted]';
      if(quote==='"' || quote==="'"){
        const end=quotedValueEnd(text,start,quote);
        if(end<0 || !quoteHasBoundary(text,end+1)){
          cursor=text.length;bearer.lastIndex=cursor;break;
        }
        cursor=end+1;bearer.lastIndex=cursor;
      }else{
        const markers=sensitiveMarkers(text.slice(start));if(markers)out+=` ${markers}`;
        cursor=text.length;bearer.lastIndex=cursor;break;
      }
    }
    return out+text.slice(cursor);
  }
  // Scrub the same nonprinting C0/C1 ranges before credential parsing.
  function stripNonprintingControls(text){
    let out='',start=0;
    for(let index=0;index<text.length;index++){
      const code=text.charCodeAt(index);
      if(code<=0x08 || (code>=0x0b&&code<=0x0c) || (code>=0x0e&&code<=0x1f) || (code>=0x7f&&code<=0x9f)){
        out+=text.slice(start,index);start=index+1;
      }
    }
    return out+text.slice(start);
  }
  function redact(text){
    const safe=stripNonprintingControls(String(text)).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]').replace(/\b(?:\d[ -]?){13,19}\b/g,'[number]');
    return redactBearerValues(redactLabeledValues(safe)).replace(/\s+/g,' ').trim();
  }
  let truncated=false;
  const maxFullText=16384;
  function bounded(value,limit){
    const raw=String(value);
    if(raw.length<=limit)return redact(raw);
    truncated=true;
    // Never expose the unfinished final token: a secret may cross the read cap.
    return redact(raw.slice(0,limit).replace(/\S+$/u,''));
  }
  function clip(value){const safe=redact(value);if(safe.length>maxText)truncated=true;const end=maxText<safe.length && /[\uD800-\uDBFF]/.test(safe[maxText-1])?maxText-1:maxText;return safe.slice(0,end);}
  // 中文注释：slot 按分配节点读取；原有 inline 文本连续拼接，跨块才加分隔，整体脱敏后截断。
  function* textNodes(root,skipControls=false){
    const stack=[root],seen=new Set();let scanned=0;
    while(stack.length){
      const node=stack.pop();if(seen.has(node))continue;seen.add(node);
      if(++scanned>maxScan){truncated=true;break;}
      if(node.nodeType===3){yield node;continue;}
      // 中文注释：推断点击行的名称不汇总独立子控件，悬停工具按钮出现时仍指向同一业务目标。
      if(skipControls&&node!==root&&node.nodeType===1&&(node.matches(`button,a[href],input,select,textarea,summary,${editable},[tabindex]`)||interactiveRoles.has(role(node))))continue;
      if(node.nodeType===1&&node.matches('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"],[inert],[data-private]'))continue;
      const assigned=node.localName==='slot'?node.assignedNodes({flatten:true}):[];
      const children=assigned.length?assigned:node.childNodes;
      for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
    }
  }
  function readText(node, full=false, limit=maxFullText,skipControls=false){
    let out='',previousBlock=null,consumed=0;
    const shared=typeof limit==='object',cap=full?(shared?limit.remaining:limit):maxText*8;
    for(const n of textNodes(node,skipControls)){
      const p=n.parentElement;if(!p||isOverlay(p)||!visible(p,false))continue;
      let block=p;
      while(block.parentElement&&!/^(block|flex|grid|table|list-item|flow-root)/.test(computed(block).display))block=block.parentElement;
      const separator=out&&previousBlock!==block?' ':'';previousBlock=block;
      const available=Math.max(0,cap-out.length-separator.length);
      out+=separator+n.substringData(0,available);
      consumed+=separator.length+Math.min(n.length,available);
      if(n.length>available){truncated=true;out=out.replace(/\S+$/u,'');break;}
    }
    if(shared)limit.remaining=Math.max(0,limit.remaining-consumed);
    return full?redact(out):clip(out);
  }
  // 中文注释：option 无布局矩形，检查它及 optgroup 的样式和隐私标记，避免读取隐藏组选项。
  function optionVisible(node){
    for(let n=node;n;n=n.parentElement){
      if(n.matches('[hidden],[aria-hidden="true"],[inert],[data-private]'))return false;
      const style=n.ownerDocument.defaultView.getComputedStyle(n);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
      if(n.localName==='select')break;
    }
    return true;
  }
  function text(node){return readText(node);}
  // 中文注释：只暴露控件状态，不返回输入值；同一逻辑用于正文和交互快照。
  function controlState(node,value){
    if(disabled(node))value.disabled=true;
    if('checked' in node && checkRoles.has(value.role))value.checked=node.indeterminate?'mixed':node.checked;
    else if(checkRoles.has(value.role)){
      const checked=node.getAttribute('aria-checked');
      if(['true','false','mixed'].includes(checked))value.checked=checked==='mixed'?'mixed':checked==='true';
    }
    for(const key of ['expanded','selected','busy']){
      const state=node.getAttribute(`aria-${key}`);
      if(state==='true'||state==='false')value[key]=state==='true';
    }
    if(node.readOnly || node.getAttribute('aria-readonly')==='true')value.readonly=true;
    if(node.required || node.getAttribute('aria-required')==='true')value.required=true;
  }
  function fullItem(node){
    truncated=false;
    const value={ref:ref(node),role:role(node)};
    let remaining=maxFullText;
    const quota={remaining:maxFullText};
    const take=raw=>{const value=bounded(raw,quota.remaining);quota.remaining=Math.max(0,quota.remaining-String(raw).length);return value;};
    let name=node.getAttribute('aria-label');
    if(name)name=take(name);
    if(!name && node.getAttribute('aria-labelledby')){
      const ids=node.getAttribute('aria-labelledby');
      if(ids.length>4096)truncated=true;
      name='';
      for(const id of ids.slice(0,4096).split(/\s+/)){
        if(!quota.remaining || name.length>=remaining){truncated=true;break;}
        const el=node.getRootNode().getElementById?.(id);
        if(el)name+=`${readText(el,true,quota)} `;
      }
      name=bounded(name,remaining);
    }
    if(!name && node.labels?.length){name='';for(const el of node.labels){if(!quota.remaining || name.length>=remaining){truncated=true;break;}name+=`${readText(el,true,quota)} `;}name=bounded(name,remaining);}
    value.name=name||readText(node,true,quota);
    remaining=Math.max(0,remaining-value.name.length);
    const cells=value.role==='row'?rowCells(node):[];
    if(value.role==='row')value.cells=cells.slice(0,40).map(n=>{const s=bounded(readText(n,true,quota),remaining);remaining=Math.max(0,remaining-s.length);return s;});
    controlState(node,value);
    if(value.role==='row' && cells.length>40){value.omittedCells=cells.length-40;truncated=true;}
    if(truncated)value.truncated=true;
    return value;
  }
  function fragments(value){
    const fields=[{field:'name',text:value.name},...(value.cells||[]).map((text,index)=>({field:'cells',index,text}))];
    if(fields.every(f=>f.text.length<=maxText))return null;
    const parts=[];
    for(const f of fields){
      let start=0;
      do {
        let end=Math.min(start+maxText,f.text.length);
        if(end<f.text.length && /[\uD800-\uDBFF]/.test(f.text[end-1]))end--;
        if(end===start)end=Math.min(start+2,f.text.length);
        parts.push({...f,start,end,total:f.text.length});start=end;
      } while(start<f.text.length);
    }
    return parts;
  }
  function fragmentItem(value,part,index){
    const {field,start,end,total}=part;
    const item={ref:value.ref,role:value.role,name:'',fragment:{field,...(field==='cells'?{index:part.index}:{}),start,end,total,part:index}};
    if(field==='name')item.name=part.text.slice(start,end);
    else item.cellText=part.text.slice(start,end);
    if(value.omittedCells)item.omittedCells=value.omittedCells;
    if(value.truncated)item.truncated=true;
    return item;
  }
  // A fragment is a distinct delta entry, but every fragment retains its node ref.
  function itemKey(value){const f=value.fragment;return f?JSON.stringify([value.ref,f.field,f.index??null,f.start]):value.ref;}
  // 中文注释：链接/按钮内部的子元素不重复推断；cursor 会继承，只认从父元素起新设的 pointer。
  const interactiveAncestor=`a[href],button,summary,label,select,textarea,input,[role],[onclick],${editable}`;
  function inferredClick(node){
    if(!['div','span'].includes(node.localName)||node.parentElement?.closest(interactiveAncestor))return false;
    if(typeof node.onclick==='function'||node.hasAttribute('onclick'))return true;
    const view=node.ownerDocument.defaultView;
    return view.getComputedStyle(node).cursor==='pointer'&&(!node.parentElement||view.getComputedStyle(node.parentElement).cursor!=='pointer');
  }
  function role(node){
    const explicit=(node.getAttribute('role')||'').split(/\s+/).find(token=>ariaRoles.has(token));
    // 中文注释：可聚焦元素的 none/presentation 不取消自身原生控件语义。
    if(explicit&&!(['none','presentation'].includes(explicit)&&(node.tabIndex>=0||node.hasAttribute('tabindex'))))return explicit;
    const tag=node.localName;
    if(tag==='input'){const type=node.type;return ['checkbox','radio','range','number'].includes(type)?({range:'slider',number:'spinbutton'}[type]||type):['submit','reset','button','image'].includes(type)?'button':'textbox';}
    if(tag==='select' && (node.multiple || node.size>1))return 'listbox';
    return ({button:'button',a:'link',select:'combobox',textarea:'textbox',summary:'button',tr:'row',li:'listitem'})[tag] || (node.getAttribute('data-ui-name')==='Body.Row'?'row':inferredClick(node)?'button':/^h[1-6]$/.test(tag)?'heading':node.isContentEditable||node.matches(editable)?'textbox':'text');
  }
  function disabled(node){
    if(node.disabled||node.matches(':disabled'))return true;
    // 中文注释：ARIA 禁用约束沿组合祖先链传播，原生 fieldset 的 legend 例外交给 :disabled。
    for(let current=node;current;current=current.assignedSlot||current.parentElement||current.getRootNode().host||current.ownerDocument.defaultView?.frameElement){
      if(current.getAttribute('aria-disabled')==='true')return true;
    }
    return false;
  }
  function interaction(node){
    const result={role:role(node),actions:[],editable:Boolean(node.isContentEditable||node.matches(editable)),disabled:disabled(node),readonly:Boolean(node.readOnly||node.getAttribute('aria-readonly')==='true')};
    if(result.disabled||!node.isConnected||node.matches('input[type="password"],input[type="file"],input[type="hidden"]'))return result;
    result.actions.push('click','press');
    const textInput=node.localName==='input'&&!['checkbox','radio','range','button','submit','reset','image','color'].includes(node.type);
    if(!result.readonly&&(textInput||node.localName==='textarea'||result.editable))result.actions.push('fill');
    if(!result.readonly&&(node.localName==='input'&&['checkbox','radio'].includes(node.type)||checkRoles.has(result.role)&&['true','false','mixed'].includes(node.getAttribute('aria-checked'))))result.actions.push('set_checked');
    if(!result.readonly&&(node.localName==='select'||['combobox','listbox'].includes(result.role)))result.actions.push('select_option');
    return result;
  }
  // 中文注释：组件库常在行与单元格之间加入包装层；按最近行归属读取，排除嵌套表格。
  function rowCells(row){
    if(row.getAttribute('data-ui-name')==='Body.Row')return Array.from(row.children);
    const cells=[],walker=row.ownerDocument.createTreeWalker(row,1,{acceptNode:node=>
      node.matches('tr,[role=row],table,[role=table],[role=grid],[role=treegrid]')?2:1});
    let node,scanned=0;
    while((node=walker.nextNode())&&scanned++<maxScan){
      if(node.matches('th,td,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')&&visible(node,false))cells.push(node);
    }
    return cells;
  }
  function visible(node,viewport){
    if(isOverlay(node))return false;
    // 中文注释：插槽隐私和隐藏状态同样约束被分配的 light DOM 节点，包括宿主提供的封闭根。
    const shadow=node.parentElement&&shadowRootOf(node.parentElement);
    const assigned=node.assignedSlot||(shadow&&Array.from(shadow.querySelectorAll('slot')).find(slot=>slot.assignedNodes().includes(node)));
    if(assigned&&!visible(assigned,false))return false;
    let ancestor=node;
    while(ancestor){
      for(let element=ancestor;element;element=element.parentElement){
        if(element.matches('[hidden],[aria-hidden="true"],[inert],[data-private]'))return false;
        const style=computed(element);
        if(style.display==='none'||(element===ancestor && (style.visibility==='hidden'||style.visibility==='collapse')))return false;
      }
      // 中文注释：display:contents 没有自身矩形，但其正文和子控件仍参与布局。
      if(!ancestor.getClientRects().length&&computed(ancestor).display!=='contents')return false;
      const root=ancestor.getRootNode();
      ancestor=root.host || (ancestor.ownerDocument!==doc ? ancestor.ownerDocument.defaultView?.frameElement : null);
    }
    if(!viewport)return true;
    let current=node;
    while(current){
      const view=current.ownerDocument.defaultView,r=current.getBoundingClientRect();
      if(!(r.bottom>0&&r.right>0&&r.top<view.innerHeight&&r.left<view.innerWidth))return false;
      current=current.ownerDocument===doc?null:view.frameElement;
    }
    return true;
  }
  function* composedElements(scope,coverage){
    const stack=[scope];
    while(stack.length){
      const node=stack.pop();if(isOverlay(node))continue;yield node;
      for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);
      if(node.localName==='iframe' || node.localName==='frame'){
        // 中文注释：隐藏/私密框架不在语义范围内，不能因不可读取而误报可见页面缺口。
        if(!visible(node,false))continue;
        let child;try{child=node.contentDocument;}catch{child=null;}
        if(child?.body && child.documentElement){
          frameDocuments.set(node,{document:child,root:child.documentElement});
          observer.observe(child,{subtree:true,childList:true,attributes:true,characterData:true});
          stack.push(child.body);
        }else coverage.skippedFrames++;
      }
      // 中文注释：封闭 Shadow Root 只能由宿主经浏览器调试接口显式提供，普通 DOM 读不到。
      const shadow=shadowRootOf(node);
      if(shadow){
        observer.observe(shadow,{subtree:true,childList:true,attributes:true,characterData:true});
        for(let i=shadow.children.length-1;i>=0;i--)stack.push(shadow.children[i]);
      }
    }
  }
  function item(node,scope=doc.body){truncated=false;const r=role(node),inferred=inferredClick(node)&&!node.hasAttribute('role');let name=node.getAttribute('aria-label');
    if(!name && node.getAttribute('aria-labelledby'))name=node.getAttribute('aria-labelledby').split(/\s+/).map(id=>{const el=node.getRootNode().getElementById?.(id);return el?text(el):'';}).join(' ');
    if(!name && node.labels?.length)name=Array.from(node.labels).map(text).join(' ');
    // 中文注释：无标签输入框可按占位提示定位，明确来源且仍经过脱敏/预算检查。
    // 中文注释：按钮型 input 没有文本节点；按 HTML-AAM 使用 value 或图片 alt 命名。
    if(!name&&node.localName==='input'){
      if(node.type==='image')name=node.getAttribute('alt')||'';
      else if(['submit','reset','button'].includes(node.type))name=node.getAttribute('value')||({submit:'Submit',reset:'Reset'}[node.type]||'');
    }
    let content=name||(inferred?readText(node,false,maxFullText,true):text(node)),source=null;
    // 中文注释：只有符号的按钮优先采用已有 tooltip；业务正文和显式 ARIA 名称保持原优先级。
    if(!name&&r==='button'&&node.getAttribute('title')&&content&&!/[\p{L}\p{N}]/u.test(content)){content=node.getAttribute('title');source='title';}
    // 中文注释：图标按钮的名称可来自图片 alt、SVG title 或 tooltip，仍使用既有脱敏和截断。
    if(!content){
      const icons=node.querySelectorAll('img[alt],svg title');
      content=Array.from(icons).slice(0,100).filter(icon=>visible(icon.localName==='title'?icon.parentElement:icon,false)&&!icon.closest('[hidden],[aria-hidden="true"],[data-private]')).map(icon=>icon.localName==='img'?clip(icon.getAttribute('alt')||''):bounded(icon.textContent||'',1024)).join(' ');
      if(content)source='descendant';
    }
    if(!content&&node.getAttribute('title')){content=node.getAttribute('title');source='title';}
    // 中文注释：单控件包装的可见邻文由原文本读取过滤私密/隐藏内容；多个控件不猜名称。
    if(!content&&r==='button'){
      const parent=node.parentElement;
      if(parent?.matches('span,div,label')&&parent.querySelectorAll('button,a,input,select,textarea,[role]').length===1){
        content=readText(parent,true,80,true);if(content)source='nearby';
      }
    }
    const placeholder=!content && node.matches('input,textarea')?node.getAttribute('placeholder'):null;
    const result={ref:ref(node),role:r,name:clip(content||placeholder||'')};
    const ax=accessibilityNames.get(node);
    if(ax?.epoch===epoch){const currentState={role:r};controlState(node,currentState);if(ax.signature===JSON.stringify(currentState)){result.name=clip(ax.name);result.nameSource='accessibility';if(ax.role)result.role=ax.role;Object.assign(result,ax.states);}}
    // 中文注释：上下文只保留有语义的区域和记录，不给容器创建可操作引用。
    const context=[];
    for(let parent=node===scope?null:node.assignedSlot||node.parentElement||node.getRootNode().host;parent&&context.length<6;parent=parent.parentElement||parent.getRootNode().host){
      if(!parent.matches('main,nav,section,article,li,fieldset,dialog,[role=region],[role=dialog],[role=row],[role=listitem],[role=group],[role=listbox],[role=tablist],[role=menu]')){if(parent===scope)break;continue;}
      if(!contextNames.has(parent)){
        // 中文注释：区域只采用自己的直接标题，避免拿内部另一条记录的标题命名整个区域。
        const heading=Array.from(parent.children).find(child=>child.matches('legend,h1,h2,h3,h4,h5,h6'));
        const label=parent.getAttribute('aria-label')|| (heading&&visible(heading,false)?text(heading):parent.matches('li,article,[role=row],[role=listitem]')?text(parent):'');
        const rowIndex=Number(parent.getAttribute('aria-rowindex')||parent.getAttribute('aria-posinset'));
        contextNames.set(parent,{ref:ref(parent),role:parent.getAttribute('role')||parent.localName,name:clip(label).slice(0,120),...(Number.isSafeInteger(rowIndex)&&rowIndex>0?{index:rowIndex}:{})});
      }
      const entry=contextNames.get(parent);
      if(entry.name||parent.localName!=='section'||parent===scope)context.unshift(entry);
      if(parent===scope)break;
    }
    if(context.length){result.context=context;result.parentRef=context.at(-1).ref;}
    // 中文注释：组合树目标记录 frame 与开放 Shadow 的交错路径，子文档身份随重建而变化。
    const path=[];let current=node;
    while(current){
      const root=current.getRootNode();
      if(root.host){path.unshift({kind:'shadow',...(root.mode==='closed'?{mode:'closed'}:{}),hostRef:ref(root.host)});current=root.host;continue;}
      if(current.ownerDocument!==doc){
        const frame=current.ownerDocument.defaultView?.frameElement;
        if(!frame)break;
        path.unshift({kind:'frame',frameRef:ref(frame),documentId:identityFor(current.ownerDocument)});
        current=frame;continue;
      }
      break;
    }
    if(path.length)result.targetPath=path;
    if(placeholder)result.nameSource='placeholder';
    else if(source&&result.nameSource!=='accessibility')result.nameSource=source;
    const cells=r==='row'?rowCells(node):[];
    if(r==='row')result.cells=cells.slice(0,40).map(text);
    if(inferred)result.inferred=true;
    controlState(node,result);
    // 中文注释：动作清单与宿主的预审和派发资格共用同一描述，只表达能力，不授予权限。
    result.actions=interaction(node).actions;
    if(r==='row' && cells.length>40){result.omittedCells=cells.length-40;truncated=true;}
    if(truncated)result.truncated=true;
    return result;
  }
  // 中文注释：引用只使用非敏感的结构和标签重定位；同名目标不作猜测。
  function stableKey(node,value){
    const attrs=['id','name','type','data-testid','data-ui-name','aria-rowindex','aria-colindex','aria-posinset'].map(key=>node.getAttribute(key)||'');
    const ancestors=[];let parent=node.parentElement||node.getRootNode().host;
    while(parent&&ancestors.length<4){ancestors.push([parent.localName,parent.getAttribute('role')||'',parent.id||'',parent.getAttribute('aria-rowindex')||parent.getAttribute('aria-posinset')||'']);parent=parent.parentElement||parent.getRootNode().host;}
    // 中文注释：虚拟记录索引来自语义祖先，不能因组件包装层超过四层而漏掉身份变化。
    const positions=value.context?.filter(entry=>entry.index!==undefined).map(entry=>[entry.role,entry.index])||[];
    return JSON.stringify([node.localName,value.role,value.name,attrs,ancestors,positions]);
  }
  // 中文注释：保存真实文档、Shadow 树及边界节点身份，路径名称相同不能替代原作用域。
  function targetScope(node){
    const scope=[];
    for(let root=node.getRootNode();root;){
      const owner=root.ownerDocument||root,boundary=root.host||(owner!==doc?owner.defaultView?.frameElement:null);
      scope.push(root,owner.documentElement);
      if(!boundary)break;
      // 中文注释：平铺身份序列同时保存边界父节点、连通性及其当前树，供逐项严格比较。
      scope.push(boundary,boundary.parentNode,boundary.isConnected,root.host?shadowRootOf(boundary):boundary.contentDocument);
      root=boundary.getRootNode();
    }
    return scope;
  }
  let lastRelocated=false;
  function relocation(){return lastRelocated;}
  // 中文注释：隐藏、私密子内容和外部标签不能通过浏览器计算名称重新进入输出。
  function accessibilityNode(token){
    const node=resolve(token);
    // 中文注释：AX 响应可能附带 value，带值控件不进入 AX 查询，继续使用已有 DOM 名称和状态。
    if(node.matches('input,textarea,select,[contenteditable],[role=textbox],[role=combobox],[role=listbox],[role=slider],[role=spinbutton]'))return null;
    if(node.querySelector('[data-private],[hidden],[aria-hidden="true"],input,textarea,select'))return null;
    // 中文注释：AX 计算名称会展开 slot，分配节点的隐私检查不能只靠 Shadow 内的 querySelector。
    for(const slot of node.querySelectorAll('slot'))for(const assigned of slot.assignedNodes({flatten:true})){
      const element=assigned.nodeType===1?assigned:assigned.parentElement;
      if(!element||!visible(element,false)||element.matches('input,textarea,select,[contenteditable]')||element.querySelector('[data-private],[hidden],[aria-hidden="true"],input,textarea,select'))return null;
    }
    for(const id of (node.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean)){
      const label=node.getRootNode().getElementById?.(id);
      if(!label||!visible(label,false)||label.querySelector('[data-private],[hidden],[aria-hidden="true"]'))return null;
    }
    return node;
  }
  function applyAccessibility(token,values){
    sync();if(!Array.isArray(values)||values.length>16)throw Error('INVALID_OPTIONS');
    for(const value of values){
      if(typeof value.name!=='string'||value.name.length>2000)throw Error('INVALID_OPTIONS');
      if(value.role&&!['button','link','tab','treeitem','menuitem','menuitemcheckbox','menuitemradio','checkbox','radio','switch'].includes(value.role))throw Error('INVALID_OPTIONS');
      if(value.states&&Object.entries(value.states).some(([key,state])=>!['expanded','selected','checked','disabled','readonly','required','busy'].includes(key)||typeof state!=='boolean'&&!(key==='checked'&&state==='mixed')))throw Error('INVALID_OPTIONS');
      const node=accessibilityNode({...token,ref:value.ref});
      if(node){const signature={role:role(node)};controlState(node,signature);accessibilityNames.set(node,{name:redact(value.name),role:value.role,states:value.states||{},signature:JSON.stringify(signature),epoch});}
    }
  }
  function snapshot(options={}){
    sync();
    if('accessibility' in options&&typeof options.accessibility!=='boolean')throw Error('INVALID_OPTIONS');
    const {mode='interactive',root=null,query='',roles=[],viewport=false,budget=3000,cursor=null,baselineId=null,composed=false}=options;
    if(!selectors[mode] || typeof query!=='string' || query.length>2000 || !Array.isArray(roles) || roles.length>100 || roles.some(r=>typeof r!=='string'||r.length>100) || typeof viewport!=='boolean' || typeof composed!=='boolean' || !Number.isSafeInteger(budget) || budget<512)throw new Error('INVALID_OPTIONS');
    const scope=typeof root==='string'?doc.querySelector(root):root||doc.body;
    if(!scope || scope.ownerDocument!==doc || !scope.isConnected || scope.nodeType!==1)throw new Error('INVALID_ROOT');
    const view=doc.defaultView;
    const fingerprint=JSON.stringify({mode,root:ref(scope),query:redact(query).toLocaleLowerCase(),roles:[...new Set(roles)].sort(),viewport,geometry:viewport?[view.scrollX,view.scrollY,view.innerWidth,view.innerHeight]:null,budget,...(composed?{composed:true}:{})});
    let offset=0,fragmentOffset=0,resync=null,seenKeys=null;
    if(cursor){
      if(cursor!==cursorState?.id || cursorState.fingerprint!==fingerprint || cursorState.epoch!==epoch&&cursorState.fragmentOffset>0)resync={reason:'cursor_invalidated'};
      else if(cursorState.epoch!==epoch||cursorState.seenMode){
        // 中文注释：虚拟列表滚动重挂载节点后按已返回的非敏感结构键去重。
        seenKeys=new Set(cursorState.seen);offset=0;
      }else {offset=cursorState.offset;fragmentOffset=cursorState.fragmentOffset;}
    }
    const key=`${fingerprint}:${offset}:${fragmentOffset}`;
    if(baselineId && !resync){if(baseline?.id!==baselineId)resync={reason:'baseline_unavailable'};else if(baseline.key!==key)resync={reason:'parameters_changed'};}
    currentId=`${instance}:s${++generation}`;active=new Map();cursorState=null;
    // 中文注释：标题沿用语义快照的脱敏与网页内容过滤，再进入打开回执摘要。
    const output={version:2,title:clip(doc.title||''),binding,snapshotId:currentId,kind:'full',mode,items:[],nextCursor:null,resync,coverage:{scanned:0,matched:0,returned:0,omitted:0,filtered:0,truncated:0,offset,complete:true,traversalComplete:true,scope:composed?'light-dom + open-shadow + accessible same-origin-frame; closed-shadow/cross-origin-frame excluded':'light-dom; no iframe/shadow traversal',unsupportedCanvas:0,...(composed?{skippedFrames:0}:{})},budget:{kind:'estimated',method:'ceil(JSON.stringify(response).length/4)',limit:budget}};
    observer.disconnect();observer.observe(doc,{subtree:true,childList:true,attributes:true,characterData:true});
    frameDocuments=new Map();
    const candidates=[];let pendingFragment=false;const walker=doc.createTreeWalker(scope,1);
    const nodes=composed?composedElements(scope,output.coverage):(function*(){let node=scope;do{yield node;}while((node=walker.nextNode()));})();
    for(const node of nodes){
      if(isOverlay(node))continue;
      if(output.coverage.scanned>=maxScan){output.coverage.traversalComplete=false;break;}
      output.coverage.scanned++;
      if(node.localName==='canvas'&&visible(node,false))output.coverage.unsupportedCanvas++;
      if(!node.matches(selectors[mode]))continue;
      if(mode==='interactive' && !node.matches(`button,a[href],input,select,textarea,summary,${editable},[tabindex]`) && !interactiveRoles.has(role(node)))continue;
      if(!visible(node,viewport) || (mode==='interactive' && node.matches('input[type="hidden"]'))){output.coverage.filtered++;continue;}
      const value=mode==='interactive'?item(node,scope):fullItem(node,mode);
      if((roles.length && !roles.includes(value.role)) || (query && !value.name.toLocaleLowerCase().includes(redact(query).toLocaleLowerCase()))){output.coverage.filtered++;continue;}
      if(seenKeys?.has(stableKey(node,value)))continue;
      output.coverage.matched++;if(value.truncated)output.coverage.truncated++;
      if(output.coverage.matched<=offset || pendingFragment || candidates.length>=maxItems)continue;
      const parts=mode==='interactive'?null:fragments(value);
      if(parts){
        const index=output.coverage.matched===offset+1?fragmentOffset:0;
        if(index>=parts.length){output.coverage.traversalComplete=false;continue;}
        for(let i=index;i<parts.length && candidates.length<maxItems;i++){
          const nextFragment=i+1<parts.length?i+1:0;
          candidates.push({node,value:fragmentItem(value,parts[i],i),nextOffset:nextFragment?output.coverage.matched-1:output.coverage.matched,nextFragment});
          if(nextFragment)pendingFragment=true;
          else pendingFragment=false;
        }
      } else candidates.push({node,value,nextOffset:output.coverage.matched,nextFragment:0});
    }
    output.items=candidates.map(c=>c.value);
    const cursorId=`${currentId}:page`;
    function update(){
      output.coverage.returned=output.items.length;
      const last=candidates[output.items.length-1];
      const nextOffset=last?.nextOffset??offset,nextFragment=last?.nextFragment??fragmentOffset;
      output.coverage.omitted=output.coverage.matched-new Set(output.items.map(i=>i.ref)).size;
      output.coverage.complete=output.coverage.traversalComplete&&(!composed || output.coverage.skippedFrames===0)&&offset===0&&fragmentOffset===0&&nextFragment===0&&output.coverage.omitted===0&&output.coverage.truncated===0;
      output.nextCursor=last&&(nextOffset<output.coverage.matched || nextFragment)?cursorId:null;
      return {nextOffset,nextFragment};
    }
    update();while(Math.ceil(JSON.stringify(output).length/4)>budget && output.items.length){output.items.pop();update();}
    if(Math.ceil(JSON.stringify(output).length/4)>budget)throw new Error('BUDGET_TOO_SMALL');
    const materialized=output.items;
    if(baselineId && !resync){
      const previous=new Map(baseline.items.map(i=>[itemKey(i),JSON.stringify(i)]));const now=new Set(materialized.map(itemKey));
      const delta={...output,kind:'delta',baselineId,items:materialized.filter(i=>previous.get(itemKey(i))!==JSON.stringify(i)),removed:baseline.items.filter(i=>!now.has(itemKey(i))).map(itemKey),order:materialized.map(itemKey)};
      if(Math.ceil(JSON.stringify(delta).length/4)<=budget)Object.assign(output,delta);
      else {output.resync={reason:'delta_budget'};while(Math.ceil(JSON.stringify(output).length/4)>budget && output.items.length){output.items.pop();update();}}
    }
    const records=new Map();
    for(const c of candidates.slice(0,materialized.length)){
      active.set(c.value.ref,c.node);
      records.set(c.value.ref,{node:c.node,value:c.value,key:stableKey(c.node,c.value),scope:targetScope(c.node)});
    }
    savedSnapshots.set(currentId,{records,mode,epoch,root:scope});
    while(savedSnapshots.size>5)savedSnapshots.delete(savedSnapshots.keys().next().value);
    if(output.nextCursor){const last=candidates[materialized.length-1];cursorState={id:output.nextCursor,fingerprint,epoch,offset:last.nextOffset,fragmentOffset:last.nextFragment,
      seenMode:!!seenKeys,seen:[...(seenKeys||[]),...candidates.slice(0,materialized.length).map(c=>stableKey(c.node,c.value))].slice(-1000)};}
    baseline={id:currentId,key,items:JSON.parse(JSON.stringify(materialized))};
    return output;
  }
  function resolve(token){
    sync();
    if(!token || Object.keys(binding).some(k=>token[k]!==binding[k]))throw new Error('BINDING_MISMATCH');
    const savedSnapshot=savedSnapshots.get(token.snapshotId),record=savedSnapshot?.records.get(token.ref);
    if(!record)throw new Error('STALE_REF');
    let node=record.node;lastRelocated=record.relocated===true;
    const root=record.scope[0],owner=root.ownerDocument||root,currentScope=targetScope(root);
    if(owner.documentElement!==record.scope[1])throw new Error('DOCUMENT_REPLACED');
    if(currentScope.length!==record.scope.length||currentScope.some((part,i)=>part!==record.scope[i])||node.isConnected&&node.getRootNode()!==root)throw new Error('STALE_REF');
    // 中文注释：重定位不能越过调用者选定的根；根被替换时旧引用失效。
    const within=node=>{for(let n=node;n;n=n.parentElement||n.getRootNode().host||n.ownerDocument.defaultView?.frameElement)if(n===savedSnapshot.root)return true;return false;};
    if(!savedSnapshot.root.isConnected)throw new Error('STALE_REF');
    const saved=record.value;
    let current;
    if(node.isConnected && saved?.fragment){
      const value=fullItem(node),part=fragments(value)?.[saved.fragment.part];
      current=part?fragmentItem(value,part,saved.fragment.part):null;
    } else if(node.isConnected)current=savedSnapshot.mode==='interactive'?item(node,savedSnapshot.root):fullItem(node);
    // 中文注释：同一真实控件沿用结构身份，周边进度文本不作废引用；AX 和正文片段仍严格比较。
    const identity=value=>JSON.stringify({...value,context:value.context?.map(({name:_name,...entry})=>entry)});
    if(node.isConnected&&within(node)&&visible(node,false)&&(JSON.stringify(current)===JSON.stringify(saved)||savedSnapshot.mode==='interactive'&&saved.nameSource!=='accessibility'&&stableKey(node,current)===record.key&&identity(current)===identity(saved)))return node;
    // 中文注释：只遍历原作用域的普通子树，不进入其他 frame 或 Shadow 树。
    const matches=[],candidates=[],scope=root===doc?savedSnapshot.root:root.host?root:owner.body;
    const walker=owner.createTreeWalker(scope,1);
    let scanned=0;
    for(let candidate=scope;candidate;candidate=walker.nextNode()){
      if(++scanned>maxScan)throw new Error('STALE_REF');
      if(matches.length>5)break;
      if(!within(candidate)||!candidate.matches?.(selectors[savedSnapshot.mode])||!visible(candidate,false))continue;
      const description=savedSnapshot.mode==='interactive'?item(candidate,savedSnapshot.root):fullItem(candidate);
      if(description.role===saved.role&&candidates.length<5)candidates.push({role:description.role,name:description.name.slice(0,80)});
      if(stableKey(candidate,description)===record.key)matches.push(candidate);
    }
    if(matches.length!==1){
      const code=matches.length?'REF_TARGET_AMBIGUOUS':'REF_TARGET_MISSING';
      // 中文注释：错误仅含经过快照脱敏的角色和名称，不含属性值或输入框当前值。
      throw new Error(`${code}|${encodeURIComponent(JSON.stringify(candidates))}`);
    }
    node=matches[0];record.node=node;record.relocated=true;lastRelocated=true;
    return node;
  }
  // 中文注释：解析器仅复用受限读取，不向模型暴露节点或可执行引用。
  const parsingContext=()=>({doc,binding,visible,editable,describe:item,cells:rowCells,optionVisible,
    revision:()=>{sync();return epoch;},
    read:node=>{truncated=false;const value=readText(node,true,4096);return {text:value.trim(),truncated};},
    option:node=>{truncated=false;return {text:bounded(node.label||node.textContent||'',1024),truncated};},
    attribute:(node,key)=>{truncated=false;return {text:bounded(node.getAttribute(key)||'',1024),truncated};},
    source:node=>({sourceRef:ref(node),documentId:identityFor(node.ownerDocument),targetPath:item(node).targetPath||[]}),
    scan:function*(scope,composed,coverage){if(composed)yield* composedElements(scope,coverage);else{const walker=doc.createTreeWalker(scope,1);yield scope;let n;while((n=walker.nextNode()))yield n;}}
  });
  return {snapshot,resolve,relocation,revoke,stats,parsingContext,accessibilityNode,applyAccessibility,interaction};
}
