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
    changed(observer.takeRecords());
    if(revoked)throw new Error('LEASE_REVOKED');if(Date.now()>=expiresAt)throw new Error('LEASE_EXPIRED');if(doc.documentElement!==documentRoot)throw new Error('DOCUMENT_REPLACED');
    for(const [frame,state] of frameDocuments){
      let current;try{current=frame.contentDocument;}catch{current=null;}
      if(!frame.isConnected || current!==state.document || current?.documentElement!==state.root)epoch++;
    }
  }
  function revoke(){revoked=true;active.clear();savedSnapshots.clear();frameDocuments.clear();baseline=null;cursorState=null;observer.disconnect();}
  function stats(){return {activeRefs:active.size,baselineItems:baseline?.items.length||0,cursors:cursorState?1:0,maxItems,maxScan,maxText};}
  const selectors={interactive:'button,a[href],input,select,textarea,summary,[contenteditable="true"],[role],[tabindex],div,span',content:'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,[role="heading"]',table:'tr,[role="row"],[data-ui-name="Body.Row"]'};
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
  function readText(node, full=false, limit=maxFullText){
    let out='';const walker=node.ownerDocument.createTreeWalker(node,4);let n,seen=0;
    while((n=walker.nextNode())){
      if(seen++>=maxScan){truncated=true;break;}
      const p=n.parentElement;if(!p || isOverlay(p) || !visible(p,false) || p.closest('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"],[data-private]'))continue;
      if(full){
        const shared=typeof limit==='object';
        const available=Math.max(0,shared?limit.remaining:limit-out.length);
        if(n.length>available){out+=n.substringData(0,available);if(shared)limit.remaining=0;truncated=true;return redact(out.replace(/\S+$/u,''));}
        out+=n.substringData(0,available);
        if(shared)limit.remaining-=n.length;
        if(shared?limit.remaining>0:out.length<limit){out+=' ';if(shared)limit.remaining--;}
      } else {const raw=n.substringData(0,maxText*8+1);if(n.length>maxText*8)truncated=true;out+=`${raw.slice(0,maxText*8)} `;if(out.length>maxText*8){truncated=true;break;}}
    }
    return full?redact(out):clip(out);
  }
  function text(node){return readText(node);}
  // 中文注释：只暴露控件状态，不返回输入值；同一逻辑用于正文和交互快照。
  function controlState(node,value){
    if(node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled')==='true')value.disabled=true;
    if('checked' in node && ['checkbox','radio','switch'].includes(value.role))value.checked=node.checked;
    else if(['checkbox','radio','switch'].includes(value.role)){
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
    if(value.role==='row')value.cells=Array.from(node.children).filter(n=>n.matches('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')||node.getAttribute('data-ui-name')==='Body.Row').slice(0,40).map(n=>{const s=bounded(readText(n,true,quota),remaining);remaining=Math.max(0,remaining-s.length);return s;});
    controlState(node,value);
    if(value.role==='row' && node.children.length>40){value.omittedCells=node.children.length-40;truncated=true;}
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
  const interactiveAncestor='a[href],button,summary,label,select,textarea,input,[role],[onclick],[contenteditable="true"]';
  function inferredClick(node){
    if(!['div','span'].includes(node.localName)||node.parentElement?.closest(interactiveAncestor))return false;
    if(typeof node.onclick==='function'||node.hasAttribute('onclick'))return true;
    const view=node.ownerDocument.defaultView;
    return view.getComputedStyle(node).cursor==='pointer'&&(!node.parentElement||view.getComputedStyle(node.parentElement).cursor!=='pointer');
  }
  function role(node){const explicit=node.getAttribute('role');if(explicit)return explicit.split(/\s+/)[0];const tag=node.localName;
    if(tag==='input'){const type=node.type;return ['checkbox','radio','range','number'].includes(type)?({range:'slider',number:'spinbutton'}[type]||type):['submit','reset','button','image'].includes(type)?'button':'textbox';}
    if(tag==='select' && (node.multiple || node.size>1))return 'listbox';
    return ({button:'button',a:'link',select:'combobox',textarea:'textbox',summary:'button',tr:'row',li:'listitem'})[tag] || (node.getAttribute('data-ui-name')==='Body.Row'?'row':inferredClick(node)?'button':/^h[1-6]$/.test(tag)?'heading':node.isContentEditable||node.getAttribute('contenteditable')==='true'?'textbox':'text');
  }
  function visible(node,viewport){
    if(isOverlay(node))return false;
    let ancestor=node;
    while(ancestor){
      for(let element=ancestor;element;element=element.parentElement){
        if(element.matches('[hidden],[aria-hidden="true"],[inert],[data-private]'))return false;
        const style=element.ownerDocument.defaultView.getComputedStyle(element);
        if(style.display==='none'||(element===ancestor && (style.visibility==='hidden'||style.visibility==='collapse')))return false;
      }
      if(!ancestor.getClientRects().length)return false;
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
  function item(node){truncated=false;const r=role(node);let name=node.getAttribute('aria-label');
    if(!name && node.getAttribute('aria-labelledby'))name=node.getAttribute('aria-labelledby').split(/\s+/).map(id=>{const el=node.getRootNode().getElementById?.(id);return el?text(el):'';}).join(' ');
    if(!name && node.labels?.length)name=Array.from(node.labels).map(text).join(' ');
    // 中文注释：无标签输入框可按占位提示定位，明确来源且仍经过脱敏/预算检查。
    // 中文注释：按钮型 input 没有文本节点；按 HTML-AAM 使用 value 或图片 alt 命名。
    if(!name&&node.localName==='input'){
      if(node.type==='image')name=node.getAttribute('alt')||'';
      else if(['submit','reset','button'].includes(node.type))name=node.getAttribute('value')||({submit:'Submit',reset:'Reset'}[node.type]||'');
    }
    const content=name||text(node);
    const placeholder=!content && node.matches('input,textarea')?node.getAttribute('placeholder'):null;
    const result={ref:ref(node),role:r,name:clip(content||placeholder||'')};
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
    if(r==='row')result.cells=Array.from(node.children).filter(n=>n.matches('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')||node.getAttribute('data-ui-name')==='Body.Row').slice(0,40).map(text);
    if(inferredClick(node)&&!node.hasAttribute('role'))result.inferred=true;
    controlState(node,result);
    if(r==='row' && node.children.length>40){result.omittedCells=node.children.length-40;truncated=true;}
    if(truncated)result.truncated=true;
    return result;
  }
  // 中文注释：引用只使用非敏感的结构和标签重定位；同名目标不作猜测。
  function stableKey(node,value){
    const attrs=['id','name','type','data-testid','data-ui-name'].map(key=>node.getAttribute(key)||'');
    const ancestors=[];let parent=node.parentElement||node.getRootNode().host;
    while(parent&&ancestors.length<4){ancestors.push([parent.localName,parent.getAttribute('role')||'',parent.id||'']);parent=parent.parentElement||parent.getRootNode().host;}
    return JSON.stringify([node.localName,value.role,value.name,attrs,ancestors]);
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
  function snapshot(options={}){
    sync();
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
      if(mode==='interactive' && !node.matches('button,a[href],input,select,textarea,summary,[contenteditable="true"],[tabindex]') && !['button','link','textbox','checkbox','radio','combobox','listbox','option','menuitem','menuitemcheckbox','menuitemradio','switch','slider','spinbutton','tab','treeitem'].includes(role(node)))continue;
      if(!visible(node,viewport) || (mode==='interactive' && node.matches('input[type="hidden"]'))){output.coverage.filtered++;continue;}
      const value=mode==='interactive'?item(node):fullItem(node,mode);
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
    savedSnapshots.set(currentId,{records,mode,epoch});
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
    const saved=record.value;
    let current;
    if(node.isConnected && saved?.fragment){
      const value=fullItem(node),part=fragments(value)?.[saved.fragment.part];
      current=part?fragmentItem(value,part,saved.fragment.part):null;
    } else if(node.isConnected)current=savedSnapshot.mode==='interactive'?item(node):fullItem(node);
    if(node.isConnected&&visible(node,false)&&JSON.stringify(current)===JSON.stringify(saved))return node;
    // 中文注释：只遍历原作用域的普通子树，不进入其他 frame 或 Shadow 树。
    const matches=[],scope=root.host?root:owner.body;
    const walker=owner.createTreeWalker(scope,1);
    for(let candidate=scope;candidate;candidate=walker.nextNode()){
      if(matches.length>5)break;
      if(!candidate.matches?.(selectors[savedSnapshot.mode])||!visible(candidate,false))continue;
      const description=savedSnapshot.mode==='interactive'?item(candidate):fullItem(candidate);
      if(stableKey(candidate,description)===record.key)matches.push(candidate);
    }
    if(matches.length!==1){
      const code=matches.length?'REF_TARGET_AMBIGUOUS':'REF_TARGET_MISSING';
      // 中文注释：错误仅含经过快照脱敏的角色和名称，不含属性值或输入框当前值。
      const candidates=matches.slice(0,5).map(candidate=>{const description=savedSnapshot.mode==='interactive'?item(candidate):fullItem(candidate);return {role:description.role,name:description.name.slice(0,80)};});
      throw new Error(`${code}|${encodeURIComponent(JSON.stringify(candidates))}`);
    }
    node=matches[0];record.node=node;record.relocated=true;lastRelocated=true;
    return node;
  }
  // 中文注释：解析器仅复用受限读取，不向模型暴露节点或可执行引用。
  const parsingContext=()=>({doc,binding,visible,describe:item,
    revision:()=>{sync();return epoch;},
    read:node=>{truncated=false;const value=readText(node,true,4096);return {text:value.trim(),truncated};},
    option:node=>{truncated=false;return {text:bounded(node.label||node.textContent||'',1024),truncated};},
    attribute:(node,key)=>{truncated=false;return {text:bounded(node.getAttribute(key)||'',1024),truncated};},
    source:node=>({sourceRef:ref(node),documentId:identityFor(node.ownerDocument),targetPath:item(node).targetPath||[]}),
    scan:function*(scope,composed,coverage){if(composed)yield* composedElements(scope,coverage);else{const walker=doc.createTreeWalker(scope,1);yield scope;let n;while((n=walker.nextNode()))yield n;}}
  });
  return {snapshot,resolve,relocation,revoke,stats,parsingContext};
}
