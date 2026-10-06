// 中文注释：此标识由 core 的生产声明序列化器注入，缺少注入时直接失败。
/* global classifySensitiveField */
// 中文注释：规则仅由受信弹窗写入；采用可验证的 CSS 子集，拒绝伪类、转义和属性表达式。
export function validateShieldRules(rules){
 if(!rules||typeof rules!=='object'||Array.isArray(rules)||JSON.stringify(rules).length>16384||Object.keys(rules).length>32)throw Error('CONTENT_SHIELD_INVALID_RULES');
 const identifier='[a-zA-Z_][a-zA-Z0-9_-]*';
 const compound=`(?:(?:${identifier}|\\*)(?:[.#]${identifier})*|(?:[.#]${identifier})+)`;
 const selector=new RegExp(`^${compound}(?:\\s*(?:[>+~]\\s*|\\s+)${compound})*$`);
 const output={};
 for(const [site,rows] of Object.entries(rules)){
  let url;try{url=new URL(site);}catch{throw Error('CONTENT_SHIELD_INVALID_RULES');}
  if(!['http:','https:'].includes(url.protocol)||url.origin!==site||!Array.isArray(rows)||rows.length>20)throw Error('CONTENT_SHIELD_INVALID_RULES');
  if(rows.some(row=>typeof row!=='string'||!row.length||row.length>512||row!==row.trim()||!selector.test(row)||/[>+~]\s*$/.test(row)))throw Error('CONTENT_SHIELD_INVALID_RULES');
  output[site]=[...new Set(rows)];
 }
 return output;
}

// 中文注释：页面探测不写 DOM；同源子框架整块遮罩，结构读取报告未知框架，其余入口拒绝。
export function collectShield(options,writeTarget=null){
 const {selectors=[],directiveSources=[],restrictionSources,blockerSource='',forCapture=false,allowOpaqueFrames=false,allowHiddenFrames=false,readRoot=null}=options;
 // 中文注释：局部操作范围只能来自宿主解析的真实顶层节点；截图不能借用该范围放行不可读像素。
 if(writeTarget&&(forCapture||!(writeTarget instanceof document.defaultView.Element)||!writeTarget.isConnected||writeTarget.ownerDocument!==document))throw Error('CONTENT_SHIELD_UNINSPECTABLE');
 const contains=(parent,child)=>{
  for(let node=child;node;node=node.parentElement||node.getRootNode().host||node.ownerDocument.defaultView?.frameElement)if(node===parent)return true;
  return false;
 };
 const unrelatedFrame=(element,frameCover)=>{
  if(!writeTarget||contains(writeTarget,element)||contains(element,writeTarget))return false;
  // 中文注释：同源嵌套框架的内部坐标属于子视口，沿用现有最外层宿主框架的覆盖矩形。
  const a=writeTarget.getBoundingClientRect(),b=frameCover||element.getBoundingClientRect();
  if(![a.x,a.y,a.width,a.height,b.x,b.y,b.width,b.height].every(Number.isFinite))throw Error('CONTENT_SHIELD_UNINSPECTABLE');
  return !(a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height);
 };
 // 中文注释：保护仍扫描全页，覆盖率缺口只计选定解析根内的不可读框架。
 const readScope=readRoot?document.querySelector(readRoot):document.body;
 const inReadScope=element=>{
  for(let node=element;node;node=node.parentElement||node.getRootNode().host||node.ownerDocument.defaultView?.frameElement)if(node===readScope)return true;
  return false;
 };
 // 中文注释：封闭 Shadow Root 仅使用宿主通过 CDP 写入隔离世界的节点映射。
 const shadowRootOf=element=>element.shadowRoot||globalThis.__hermesClosedShadowRoots?.get(element);
 const directives=directiveSources.map(source=>new RegExp(source,'iu'));
 const restrictions=restrictionSources.map(source=>new RegExp(source,'iu'));
 const restricted=value=>restrictions.some(rule=>rule.test(value));
 // 中文注释：分类器由生产注入声明提供；敏感控件正文（textarea/option）也不能作为值词表读取。
 const sensitive=node=>['INPUT','TEXTAREA','SELECT'].includes(node.tagName)&&classifySensitiveField(node)!==null;
 // 中文注释：脚本、样式和模板不作为可见公告；每轮探测缓存正文，避免反复读取整棵子树。
 const excluded=new Set(['HEAD','SCRIPT','STYLE','NOSCRIPT','TEMPLATE']),textCache=new WeakMap();
 const safeText=node=>{
  if(textCache.has(node))return textCache.get(node);
  const text=node.nodeType===3?node.textContent:excluded.has(node.tagName)||sensitive(node)?'':[...node.childNodes].map(safeText).join('');
  textCache.set(node,text);return text;
 };
 const semanticAttributes=new Set(['id','class','name','title','aria-label','placeholder','aria-labelledby','aria-describedby']);
 const proseAttributes=['aria-label','alt','title','placeholder'];
 const blocker=new RegExp(blockerSource||'captcha|验证码|人机验证|access denied|拒绝访问|登录|login|sign in|rate limit|限流|\\b(?:401|403|429)\\b','iu');
 const tokens=new Set(),rects=[];let siteAutomationRestricted=false,count=0,skippedFrames=0;
 const matches=value=>directives.some(rule=>rule.test(value));
 const add=(value,prose=true)=>{
  if(typeof value!=='string'||!value.trim())return;
  // 中文注释：同一字段中的真实阻塞句段保留，其他指定句段仍要屏蔽。
  if(prose&&blocker.test(value)){
   // 中文注释：仅明确独立的阻塞提示可保留；混有未知内容时无法保证脱敏，直接拒绝输出。
   const standalone=/^(?:captcha|验证码|人机验证|请完成人机验证|请(?:输入|填写)验证码|(?:请|需要|必须)?登录(?:后继续)?|(?:please\s+|you\s+(?:must|need\s+to)\s+)?(?:log|sign)\s*in(?:\s+to\s+continue)?|verify\s+(?:that\s+)?you\s+are\s+human|(?:401|403|429)(?:\s+(?:access\s+denied|unauthorized|too\s+many\s+requests))?|access\s+denied|permission\s+denied|unauthorized|rate\s+limit(?:ed)?|too\s+many\s+requests|拒绝访问|权限不足|访问被拒|限流(?:，?请稍后再试)?|请求过于频繁)$/iu;
   for(const part of value.split(/[。！？.!?;；\n]+/u)){
    if(!part.trim())continue;
    if(blocker.test(part)){if(!standalone.test(part.trim()))throw Error('CONTENT_SHIELD_BLOCKER_OVERLAP');}
    else add(part);
   }
   return;
  }
  if(tokens.size>10000||value.length>60000)throw Error('CONTENT_SHIELD_UNAVAILABLE');
  tokens.add(value);tokens.add(value.trim());
  // 中文注释：汇总字段可能折叠空白，按文本片段补充匹配；不在日志或回执中输出词表。
  tokens.add(value.replace(/\s+/gu,' ').trim());
  for(const word of value.split(/\s+/u))if(word)tokens.add(word);
 };
 const cover=(node,frameCover)=>{
  const rect=frameCover||node.getBoundingClientRect();
  if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))throw Error('CONTENT_SHIELD_UNAVAILABLE');
  if(rect.width>0&&rect.height>0)rects.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,kind:'content_shield',role:'region',name:'已屏蔽区域'});
  // 中文注释：隐藏节点无需像素遮罩；可见溢出文本需覆盖子孙盒与文字 Range。
  if(!frameCover)for(const child of node.childNodes||[])if(child.nodeType===3&&child.textContent.trim()){
   const range=node.ownerDocument.createRange();range.selectNodeContents(child);
   if(typeof range.getBoundingClientRect==='function'){
    const r=range.getBoundingClientRect();if(r.width>0&&r.height>0)rects.push({x:r.x,y:r.y,width:r.width,height:r.height,kind:'content_shield',role:'region',name:'已屏蔽区域'});
   }
  }
 };
 const walk=(root,inherited=false,frameCover=null)=>{
  // 中文注释：页面标题属于文本出口但不在截图视口内，只脱敏文字，不扩大截图区域。
  if(root.nodeType===9){siteAutomationRestricted ||= restricted(root.title);if(matches(root.title)&&!blocker.test(root.title))add(root.title);}
  const selected=new Set(selectors.flatMap(selector=>[...root.querySelectorAll(selector)]));
  // 中文注释：先按 CSS 块边界归并内联文字，再匹配正则；相邻段落不能拼成一条公告。
  const groups=new Map(),automatic=new Set(),fragments=new Set(),styles=new WeakMap();
  const styleOf=element=>{
   if(!styles.has(element))styles.set(element,element.ownerDocument.defaultView.getComputedStyle(element));
   return styles.get(element);
  };
  const isBlock=element=>/^(?:block|flow-root|flex|grid|table(?:-cell|-caption)?|list-item)(?:\s|$)/u.test(styleOf(element).display);
  const structural=new Set(['HTML','BODY','MAIN','NAV','HEADER','FOOTER','ARTICLE']);
  let indexed=0;
  const index=(element,parentBlock=null)=>{
   if(++indexed>30000)throw Error('CONTENT_SHIELD_UNAVAILABLE');
   if(excluded.has(element.tagName)||element.matches('[data-hermes-automation-overlay],[data-hermes-interaction-highlight]'))return;
   const block=!parentBlock||isBlock(element)?element:parentBlock;
   if(!groups.has(block))groups.set(block,{nodes:[],members:[],attributes:[],hasSubBlocks:false});
   if(parentBlock&&block!==parentBlock)groups.get(parentBlock).hasSubBlocks=true;
   const group=groups.get(block);group.members.push(element);
   for(const name of proseAttributes){
    const value=element.getAttribute(name);
    if(value){siteAutomationRestricted ||= restricted(value);if(matches(value)&&!blocker.test(value)){add(value);group.attributes.push(element);}}
   }
   // 中文注释：敏感控件的正文和 option 均不进入自动匹配，继续沿用原有值读取门禁。
   if(sensitive(element))return;
   for(const child of element.childNodes){
    if(child.nodeType===3)group.nodes.push(child);
    else if(child.nodeType===1)index(child,block);
   }
  };
  if(root.nodeType===9)index(root.documentElement);else for(const child of root.children)index(child);
  for(const [block,group] of groups){
   const text=group.nodes.map(node=>node.textContent).join('');
   siteAutomationRestricted ||= restricted(text);
   const textMatch=matches(text)&&!blocker.test(text);
   if(!textMatch&&!group.attributes.length)continue;
   if(!structural.has(block.tagName)&&!group.hasSubBlocks)automatic.add(block);
   else{
    // 中文注释：页面骨架或含其他独立块的容器只遮住本段文字及内联元素，不遮整个页面。
    if(textMatch){for(const node of group.nodes)fragments.add(node);for(const member of group.members)if(member!==block)automatic.add(member);}
    for(const element of group.attributes)if(element!==block)automatic.add(element);
   }
  }
  const visit=(element,hidden)=>{
   if(++count>30000)throw Error('CONTENT_SHIELD_UNAVAILABLE');
   if(excluded.has(element.tagName)||element.matches('[data-hermes-automation-overlay],[data-hermes-interaction-highlight]'))return;
   const sensitiveField=sensitive(element);
   const textNodes=sensitiveField?[]:[...element.childNodes].filter(node=>node.nodeType===3),texts=textNodes.map(node=>node.textContent);
   // 中文注释：敏感控件只读取已有语义出口的名称属性；value 属性、正文和 value getter 不进入词表。
   const attributes=[...element.attributes].filter(attribute=>!sensitiveField||semanticAttributes.has(attribute.name));
   const combined=safeText(element);
   const designated=hidden||selected.has(element)||automatic.has(element);
   let mask=designated&&!blocker.test(combined);
   if(automatic.has(element)&&!blocker.test(combined))add(combined);
   // 中文注释：URL/id/class 等属性不是实际阻塞提示，不能因含 login/403 而免于指定区域脱敏。
   const values=[...texts.map(value=>({value,prose:true})),...attributes.map(attribute=>({value:attribute.value,prose:['aria-label','alt','title','placeholder'].includes(attribute.name)})),
    ...(!sensitiveField&&['INPUT','TEXTAREA','SELECT'].includes(element.tagName)?[{value:element.value,prose:false}]:[])];
   for(const {value,prose} of values){
    if(designated){add(value,prose);mask ||= !prose||!blocker.test(value);}
   }
   const textFragments=textNodes.filter(node=>fragments.has(node)&&node.textContent.trim());
   for(const node of textFragments)add(node.textContent);
   if(designated){
    // 中文注释：可访问名称还可能来自外部 label 和 ARIA 引用，必须加入输出脱敏词表。
    for(const key of ['aria-labelledby','aria-describedby'])for(const id of (element.getAttribute(key)||'').split(/\s+/u)){
     const label=element.ownerDocument.getElementById(id);if(label)add(safeText(label));
    }
    for(const label of element.labels||[])add(safeText(label));
   }
   if(mask&&forCapture&&designated&&blocker.test(combined))throw Error('CONTENT_SHIELD_BLOCKER_OVERLAP');
   if((mask||textFragments.length)&&forCapture){
    // 中文注释：文字阴影、滤镜及生成内容可能超出 DOM 盒；无法确认遮罩时拒绝截图。
    const view=element.ownerDocument.defaultView,style=view.getComputedStyle(element);
    if(['filter','textShadow'].some(key=>style[key]&&style[key]!=='none'))throw Error('CONTENT_SHIELD_RENDER_UNSUPPORTED');
    // 中文注释：祖先的滤镜也会扩散子元素像素，不能只检查命中元素自身。
    for(let parent=element.parentElement||element.getRootNode().host||view.frameElement;parent;parent=parent.parentElement||parent.getRootNode().host||parent.ownerDocument.defaultView.frameElement){
     const filter=parent.ownerDocument.defaultView.getComputedStyle(parent).filter;
     if(filter&&filter!=='none')throw Error('CONTENT_SHIELD_RENDER_UNSUPPORTED');
    }
    for(const pseudo of ['::before','::after']){
     const content=view.getComputedStyle(element,pseudo).content;
     if(content&&content!=='none'&&content!=='normal')throw Error('CONTENT_SHIELD_RENDER_UNSUPPORTED');
    }
   }
   // 中文注释：敏感控件只覆盖元素盒，不读 textarea 内文或 select 子项的文字 Range。
   if(mask&&!blocker.test(combined))cover(element,sensitiveField?(frameCover||element.getBoundingClientRect()):frameCover);
   for(const node of textFragments){
    if(frameCover){cover(element,frameCover);continue;}
    const range=element.ownerDocument.createRange();range.selectNodeContents(node);
    // 中文注释：文字块没有可靠 Range 几何时拒绝图片，不能用整页盒代替。
    if(typeof range.getClientRects!=='function'){if(forCapture)throw Error('CONTENT_SHIELD_UNAVAILABLE');continue;}
    for(const rect of range.getClientRects()){
     if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))throw Error('CONTENT_SHIELD_UNAVAILABLE');
     if(rect.width>0&&rect.height>0)rects.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,kind:'content_shield',role:'region',name:'已屏蔽区域'});
    }
   }
   if(sensitiveField)return;
   // 中文注释：跨 inline 节点命中的默认公告也覆盖子孙盒，避免脱离父盒的文字漏出截图。
   const descendantsHidden=designated;
   const shadow=shadowRootOf(element);
   if(shadow)walk(shadow,descendantsHidden,frameCover);
   if(['IFRAME','FRAME'].includes(element.tagName)){
    // 中文注释：只有 CSS display:none 的明确渲染缺口可跳过；零尺寸或 visibility 不作为免责依据。
    let unrendered=false;
    for(let parent=element;parent;parent=parent.parentElement||parent.getRootNode().host||parent.ownerDocument.defaultView?.frameElement){
     if(parent.ownerDocument.defaultView.getComputedStyle(parent).display==='none'){unrendered=true;break;}
    }
    let doc;try{doc=element.contentDocument;}catch{doc=null;}
    // 中文注释：隐藏 sandbox iframe 不进入固定 DOM/截图输出；任意 JS 输出仍拒绝不可检查区域。
    if(allowHiddenFrames&&unrendered){/* 中文注释：不计入当前可见页面的覆盖缺口。 */}
    else if(!doc?.documentElement){
     if(forCapture||!allowOpaqueFrames&&!unrelatedFrame(element,frameCover))throw Error('CONTENT_SHIELD_UNINSPECTABLE');
     if(inReadScope(element))skippedFrames++;
    }else{
     const r=frameCover||element.getBoundingClientRect();
     walk(doc,descendantsHidden,r);
    }
   }
   for(const child of element.children)visit(child,descendantsHidden);
  };
  if(root.nodeType===9)visit(root.documentElement,inherited);else for(const child of root.children)visit(child,inherited);
 };
 walk(document);
 const v=window.visualViewport;
 if(v&&(v.scale!==1||v.offsetLeft||v.offsetTop))throw Error('CONTENT_SHIELD_UNSUPPORTED_VIEWPORT');
 return {tokens:[...tokens].sort((a,b)=>b.length-a.length),rects,siteAutomationRestricted,skippedFrames,writeTargetVerified:writeTarget!==null,
  state:{url:location.href,width:window.innerWidth,height:window.innerHeight,scrollX:window.scrollX,scrollY:window.scrollY,dpr:window.devicePixelRatio,scale:v?.scale||1}};
}

// 中文注释：只保留协议标识；JS 用户对象中的同名键仍需过滤，不把原文装进审计 metadata。
export function redactShieldResult(result,inventory){
 const tokens=inventory.tokens||[],protocol=new Set(['binding','snapshotId','parseId','nextCursor','screenshotId','id','url','origin','code','status','ok','outcomeUnknown','retryable']);
 // 中文注释：固定语义角色和覆盖率是解析协议，短屏蔽词不能把 listbox 等角色破坏成不可识别值。
 const roles=new Set(['button','link','textbox','checkbox','radio','combobox','listbox','option','menuitem','menuitemcheckbox','menuitemradio','switch','slider','spinbutton','tab','treeitem','row','listitem','heading','text']);
 const clean=text=>{
  let output=text;
  // 中文注释：先替换所有完整子片段，避免块汇总的空白差异触发截断检查，把正常邻文一并清空。
  for(const token of tokens)if(token)output=output.split(token).join('[已屏蔽区域]');
  // 中文注释：完整片段处理后仍残留长文本的截断首尾时，保留原有整字段保护。
  for(const token of tokens)if(token.length>16&&(output.includes(token.slice(0,16))||output.includes(token.slice(-16))))return '[已屏蔽区域]';
  return output;
 };
 const visit=(value,userValue=false,depth=0)=>{
  if(typeof value==='string')return clean(value);
  if(Array.isArray(value))return value.map(child=>visit(child,userValue,depth+1));
  if(!value||typeof value!=='object')return value;
  const out={};let changed=false;
  for(const [key,child] of Object.entries(value)){
   const binary=inventory.image&&!userValue&&key==='data'&&typeof child==='string';
   const protectedField=!userValue&&(key==='binding'||depth===0&&(protocol.has(key)||key==='coverage')||key==='role'&&roles.has(child)||key==='nameSource'&&['placeholder','descendant','title','accessibility'].includes(child));
   const filtered=binary||protectedField?child:visit(child,userValue||['value','fields','metadata'].includes(key),depth+1);
   const nextKey=userValue||depth>0&&!protectedField?clean(key):key;
   out[nextKey]=filtered;changed ||= nextKey!==key||JSON.stringify(filtered)!==JSON.stringify(child);
  }
  // 中文注释：被屏蔽的名称不再返回可操作引用；汇总容器受影响也移除引用。
  if(changed)for(const key of ['ref','sourceRef','parentRef','targetPath'])delete out[key];
  return out;
 };
 const filtered=visit(result);
 if(!filtered||typeof filtered!=='object'||Array.isArray(filtered))return filtered;
 return {...filtered,contentFilter:{...filtered.contentFilter,enabled:true,siteAutomationRestricted:inventory.siteAutomationRestricted===true||filtered.contentFilter?.siteAutomationRestricted===true}};
}
