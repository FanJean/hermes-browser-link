// 中文注释：手动验收只启动独立临时浏览器，不修改个人 profile、安装目录或网关。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
if(!output||!path.isAbsolute(output))throw Error('需要独立证据目录 --output=绝对路径');
await mkdir(output,{recursive:true});
// 中文注释：中文公告故意放在内联 span 中，靠默认正则自动提升到整块区域；不保存任何选择器。
const fixture='<!doctype html><html><head><title>屏蔽验收</title><style>body{margin:0;background:white;font:18px sans-serif}#private{position:absolute;left:20px;top:20px;width:240px;height:100px;background:rgb(255,0,0);color:black}.public{position:absolute;left:300px;top:20px;width:180px;height:100px;background:rgb(0,200,0)}#notice{position:absolute;left:20px;top:160px;width:500px;height:60px}#captcha{position:absolute;left:20px;top:250px}</style></head><body><section id="private" title="PRIVATE_TITLE_CANARY"><span>请勿使用自动化工具访问本平台</span><button aria-label="PRIVATE_LABEL_CANARY">PRIVATE_TEXT_CANARY</button><img alt="PRIVATE_ALT_CANARY"></section><div class="public">公开正文</div><p id="notice">Automated access is prohibited.</p><p id="captcha">403 Access denied</p></body></html>';
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const choices={chrome:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',edge:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'};
const results=[];
try{
 for(const [name,binary] of Object.entries(choices)){
  const profile=await mkdtemp('/tmp/hermes-shield-browser-');
  const proc=spawn(binary,['--headless=new','--use-mock-keychain','--password-store=basic','--disable-background-networking','--no-proxy-server',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','about:blank'],{stdio:['ignore','ignore','pipe']});
  let browser,ui,page;
  try{
   const port=await waitFor(async()=>{try{return (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},30000);
   const base=`http://127.0.0.1:${port}`;
   browser=new CdpClient((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl);await browser.connect();
   const {id}=await browser.call('Extensions.loadUnpacked',{path:path.join(root,'native-extension/dist-native')});
   await browser.call('Target.createTarget',{url:`chrome-extension://${id}/popup.html`});
   const uiTarget=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(t=>t.url===`chrome-extension://${id}/popup.html`));
   ui=new CdpClient(uiTarget.webSocketDebuggerUrl);await ui.connect();
   await waitFor(()=>ui.evaluate('Boolean(document.querySelector("#filter-toggle"))&&!document.querySelector("#filter-toggle").disabled'),15000,{label:'弹窗模块初始化'});
   assert.equal(await ui.evaluate('document.querySelector("#shield-settings,#cookie-mirror,#cursor-toggle")'),null);
   assert.equal(await ui.evaluate('document.querySelector("#version-label").textContent'),'v'+await ui.evaluate('chrome.runtime.getManifest().version'));
   // 中文注释：验收只打开自动屏蔽开关，必须证明网站/选择器规则完全未配置。
   await ui.evaluate('document.querySelector("#filter-toggle").click()');
   await waitFor(()=>ui.evaluate('document.querySelector("#filter-toggle").getAttribute("aria-checked")==="true"'));
   assert.equal(await ui.evaluate('chrome.storage.local.get("pageContentShieldRules").then(s=>s.pageContentShieldRules===undefined)'),true);
   await ui.call('Emulation.setDeviceMetricsOverride',{width:360,height:860,deviceScaleFactor:1,mobile:false});
   const popupImage=await ui.call('Page.captureScreenshot');await writeFile(path.join(output,`${name}-popup.png`),Buffer.from(popupImage.data,'base64'));
   const tab=await ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(origin)},active:false}).then(t=>t.id)`);
   const pageTarget=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(t=>t.url===origin+'/'));
   page=new CdpClient(pageTarget.webSocketDebuggerUrl);await page.connect();await waitFor(()=>page.evaluate('Boolean(document.querySelector("#private"))'));
   // 中文注释：只激活临时浏览器里的测试页，验证前台实际光标动画，不切换个人浏览器页面。
   await browser.call('Target.activateTarget',{targetId:pageTarget.id});
   // 中文注释：固定视口并在批准完成后记录 DOM、布局、焦点，验证屏蔽本身没有修改页面。
   await page.call('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:2,mobile:false});
   await ui.evaluate(`(async()=>{const {Executor}=await import('./core.mjs');const {Bridge}=await import('./bridge.mjs');
    window.testExecutor=new Executor({tabs:chrome.tabs,debugger:chrome.debugger},()=>{},{onContentShield:async()=>{const s=await chrome.storage.local.get(['pageContentFilter','pageContentShieldRules']);return {enabled:s.pageContentFilter===true,rules:s.pageContentShieldRules||{}};}});
    await testExecutor.approve({id:'pixel-test',generation:1,instanceId:'test',approvalScope:'owner',allowedOrigins:[${JSON.stringify(origin)}],tabIds:[${tab}]});
    testExecutor.setMode({id:'pixel-test',generation:1,instanceId:'test',approvalScope:'owner',allowedOrigins:[${JSON.stringify(origin)}],tabIds:[${tab}],modeGeneration:2,activeMode:'full'});
    let reply;window.testBridge=new Bridge({onMessage:{addListener(){}},postMessage:m=>reply(m)},testExecutor,()=>{},{onContentFilter:async()=>true});
    let sequence=0;window.readProtected=async(action,extra={})=>new Promise(resolve=>{reply=resolve;testBridge.receive({id:'request-'+(++sequence),method:'browser.execute',params:{taskId:'pixel-test',generation:1,tabId:${tab},action,modeGeneration:2,allowedOrigins:[${JSON.stringify(origin)}],...extra}});});
   })()`);
   const pageState=()=>page.evaluate(`JSON.stringify({dom:document.body.innerHTML,focus:document.activeElement.tagName,rect:document.querySelector('#private').getBoundingClientRect().toJSON()})`);
   const before=await pageState();
   const read=await ui.evaluate(`readProtected('page.observe',{options:{selector:'body'}})`);assert.ok(read.result,JSON.stringify(read));
   assert.doesNotMatch(JSON.stringify(read),/PRIVATE_(?:TEXT|TITLE|LABEL|ALT)_CANARY|Automated access is prohibited|请勿使用自动化工具/);
   assert.match(JSON.stringify(read),/公开正文|403 Access denied/);assert.equal(read.result.contentFilter.siteAutomationRestricted,true);
   // 中文注释：扩展 attach 会重置外部 CDP 的模拟设置，DPR 用实际执行器连接设置并读回。
   await ui.evaluate(`testExecutor.api.debugger.sendCommand({tabId:${tab}},'Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:2,mobile:false})`);
   assert.equal(await page.evaluate('devicePixelRatio'),2);
   // 中文注释：复用 Executor 注入的真实闭合 Shadow 浮层，通过 CDP 只读取合成页面的光标 CSS。
   await page.call('DOM.enable');await page.call('CSS.enable');
   const cursorTree=await page.call('DOM.getDocument',{depth:-1,pierce:true});
   const findCursor=node=>{
    const attrs=node.attributes||[];for(let i=0;i<attrs.length;i+=2)if(attrs[i]==='data-role'&&attrs[i+1]==='virtual-cursor')return node;
    for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=findCursor(child);if(found)return found;}
   };
   const cursorNode=findCursor(cursorTree.root);assert.ok(cursorNode,'任务期间应有真实可视鼠标');
   const cursorCss=async()=>Object.fromEntries((await page.call('CSS.getComputedStyleForNode',{nodeId:cursorNode.nodeId})).computedStyle.map(row=>[row.name,row.value]));
   const cursorX=css=>{const matrix=/^matrix\(([^)]+)\)$/u.exec(css.transform);assert.ok(matrix,css.transform);return Number(matrix[1].split(',')[4]);};
   const showTarget=async(token,x,y)=>ui.evaluate(`(async()=>{const entry=testExecutor.tasks.get('pixel-test').overlays.get(${tab});return (await testExecutor.api.debugger.sendCommand({tabId:${tab}},'Runtime.callFunctionOn',{executionContextId:entry.contextId,functionDeclaration:'function(){const s=globalThis.__hermesAutomationOverlay;return s.overlay.interactionSurface.update({taskId:s.taskId,generation:s.generation,documentId:s.documentId,operationToken:${JSON.stringify(token)},kind:"input",point:{x:${x},y:${y}},rects:[{left:${x-10},top:${y-10},width:20,height:20}]});}',returnByValue:true})).result.value;})()`);
   const cursorState=async(state,token)=>ui.evaluate(`(async()=>{const entry=testExecutor.tasks.get('pixel-test').overlays.get(${tab});return (await testExecutor.api.debugger.sendCommand({tabId:${tab}},'Runtime.callFunctionOn',{executionContextId:entry.contextId,functionDeclaration:'function(){const s=globalThis.__hermesAutomationOverlay;${token?`s.overlay.interactionSurface.clear({taskId:s.taskId,generation:s.generation,documentId:s.documentId,operationToken:${JSON.stringify(token)}});`:''}s.overlay.update({state:${JSON.stringify(state)}});return true;}',returnByValue:true})).result.value;})()`);
   assert.equal((await cursorCss()).display,'block');
   await showTarget('cursor-first',140,70);await waitFor(async()=>Math.abs(cursorX(await cursorCss())-140)<1);
   await cursorState('waiting','cursor-first');assert.equal((await cursorCss()).display,'block');
   await showTarget('cursor-next',390,70);
   await page.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
   const moving=cursorX(await cursorCss());assert.ok(moving>140&&moving<390,`应有中间移动位置：${moving}`);
   await waitFor(async()=>Math.abs(cursorX(await cursorCss())-390)<1);
   await cursorState('waiting','cursor-next');assert.equal((await cursorCss()).display,'block');
   await cursorState('paused');assert.equal((await cursorCss()).display,'none');
   await cursorState('waiting');assert.equal((await cursorCss()).display,'block');
   await writeFile(path.join(output,`${name}-task-cursor.png`),Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
   await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.equal((await cursorCss())['transition-duration'],'0s');
   await page.call('Emulation.setEmulatedMedia',{features:[]});
   // 中文注释：实际 PNG 由生产 OffscreenCanvas 解码，逐像素检查 alpha 和遮罩边界，DPR=2。
   for(const action of ['screenshot','interaction.capture']){
    const reply=await ui.evaluate(`readProtected(${JSON.stringify(action)})`);assert.ok(reply.result,JSON.stringify(reply));
    const image=action==='screenshot'?reply.result.data:reply.result.image.data;
    await writeFile(path.join(output,`${name}-${action}.png`),Buffer.from(image,'base64'));
    const pixels=await ui.evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(image)}),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const c=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);const area=ctx.getImageData(40,40,480,200).data;let fullyMasked=true;for(let i=0;i<area.length;i+=4)if(area[i]!==32||area[i+1]!==33||area[i+2]!==36||area[i+3]!==255){fullyMasked=false;break;}return {width:bitmap.width,height:bitmap.height,fullyMasked,private:Array.from(ctx.getImageData(100,100,1,1).data),public:Array.from(ctx.getImageData(700,100,1,1).data),edge:Array.from(ctx.getImageData(40,40,1,1).data)};})()`);
    assert.equal(pixels.fullyMasked,true);assert.deepEqual(pixels.private,[32,33,36,255]);assert.deepEqual(pixels.edge,[32,33,36,255]);assert.deepEqual(pixels.public,[0,200,0,255]);assert.equal(pixels.width,1600);assert.equal(pixels.height,1200);
   }
   assert.equal(await pageState(),before,'屏蔽不能改变 DOM、布局或焦点');
   await ui.evaluate('document.querySelector("#filter-toggle").click()');await waitFor(()=>ui.evaluate('document.querySelector("#filter-toggle").getAttribute("aria-checked")==="false"'));
   const raw=await ui.evaluate(`readProtected('screenshot')`);assert.ok(raw.result);assert.equal(raw.result.masked,undefined);
   // 中文注释：拒绝边界也通过真实 CDP 验证；未经支持的框架不能静默跳过。
   await ui.evaluate('document.querySelector("#filter-toggle").click()');await waitFor(()=>ui.evaluate('document.querySelector("#filter-toggle").getAttribute("aria-checked")==="true"'));
   await page.evaluate('document.body.style.filter="blur(8px)"');
   const refused=await ui.evaluate(`readProtected('screenshot')`);assert.equal(refused.error?.code,'content_shield_render_unsupported');assert.equal(refused.result,undefined);
   // 中文注释：复杂解析回归复用本脚本的生产 Executor/Bridge 和临时浏览器，保持保护开关打开。
   await page.evaluate(`(()=>{
    document.body.style.filter='';
    const host=document.createElement('div');host.id='closed-component';document.body.append(host);
    host.attachShadow({mode:'closed'}).innerHTML='<section style="position:absolute;left:20px;top:350px;width:240px;height:60px;background:red"><span>禁止自动化操作</span><button aria-label="CLOSED_PRIVATE_CANARY">CLOSED_PRIVATE_CANARY</button></section><button aria-label="封闭公开按钮">封闭公开按钮</button>';
    document.body.insertAdjacentHTML('beforeend','<main id="complex"><button title="图标按钮"><img alt="下载报告"></button><button><svg width="20" height="20"><title>展开菜单</title></svg></button><button><span style="display:contents">保存内容</span></button><div role="combobox" aria-label="地区" aria-controls="portal"></div><div id="portal" role="listbox"><div role="option">中国</div></div><div role="treegrid"><div role="row"><div><span role="columnheader">名称</span><span role="columnheader">数量</span></div></div><div role="row"><div><span role="gridcell">设备</span><span role="gridcell">2</span></div></div></div><article><h2>记录标题</h2><div><h2>嵌套标题</h2></div></article></main>');
    return true;
   })()`);
   // 中文注释：同源 iframe 中的封闭组件也由 CDP 交给父隔离世界，文本屏蔽与来源路径同时验证。
   await page.evaluate(`(()=>{
    const frame=document.createElement('iframe');frame.id='same-origin-frame';document.body.append(frame);
    const host=frame.contentDocument.createElement('div');frame.contentDocument.body.append(host);
    host.attachShadow({mode:'closed'}).innerHTML='<button aria-label="框架封闭按钮">框架封闭按钮</button><p>禁止自动化操作</p>';
    return true;
   })()`);
   // 中文注释：第二轮能力验收覆盖跨 inline 脱敏、原生选项隐私、slot 名称及虚拟坐标。
   await page.evaluate(`(()=>{
    document.querySelector('#complex').insertAdjacentHTML('beforeend','<p><span>to</span><b>ken=</b><span>ROUND2_SECRET_CANARY</span></p><select aria-label="规格"><option>公开选项</option><option data-private>ROUND2_PRIVATE_CANARY</option><optgroup hidden><option>ROUND2_HIDDEN_CANARY</option></optgroup></select><div id="slots"><span slot="label">插槽保存</span></div><div id="virtual-grid" role="grid" aria-rowcount="1000" aria-colcount="10"><div role="row" aria-rowindex="51"><span role="gridcell" aria-colindex="4">虚拟单元</span><button aria-expanded="false">更多</button></div></div><section id="ax-scope"><button id="generated-name"></button></section>');
    document.querySelector('#slots').attachShadow({mode:'open'}).innerHTML='<button><slot name="label"></slot></button>';
    const style=document.createElement('style');style.textContent='#generated-name::before{content:"生成名称按钮"}';document.head.append(style);
    return true;
   })()`);
   const round2=await ui.evaluate(`readProtected('page.parse',{options:{root:'#complex',sections:['blocks','forms'],budget:10000}})`);
   assert.ok(round2.result,JSON.stringify(round2));assert.doesNotMatch(JSON.stringify(round2),/ROUND2_(SECRET|PRIVATE|HIDDEN)_CANARY/);
   assert.deepEqual(round2.result.forms.find(field=>field.label==='规格').options,[{text:'公开选项',selected:true}]);
   const virtual=await ui.evaluate(`readProtected('page.parse',{options:{root:'#virtual-grid',sections:['tables']}})`);
   assert.ok(virtual.result,JSON.stringify(virtual));assert.equal(virtual.result.tables[0].row,50);assert.equal(virtual.result.tables[0].cells[0].column,3);assert.equal(virtual.result.tables[0].declaredRows,1000);
   // 中文注释：真实树数据交给 Python 官方适配器验收，操作别名必须仍指向原节点。
   await page.evaluate(`document.querySelector('#complex').insertAdjacentHTML('beforeend','<section id="tree-scope" aria-label="版本列表"><article><h2>版本 A</h2><button aria-expanded="false">更多</button></article><article><h2>版本 B</h2><button aria-expanded="true">更多</button></article></section>')`);
   const tree=await ui.evaluate(`readProtected('semantic_snapshot',{options:{root:'#tree-scope',budget:5000}})`);
   assert.ok(tree.result,JSON.stringify(tree));assert.deepEqual(tree.result.items.map(item=>item.context.at(-1).name),['版本 A','版本 B']);
   await writeFile(path.join(output,`${name}-tree-snapshot.json`),JSON.stringify(tree.result,null,2));
   // 中文注释：用树中第二条记录的原引用实际点击，验证不会误操作同名的第一条记录。
   await page.evaluate(`document.querySelectorAll('#tree-scope button').forEach(button=>button.onclick=()=>button.parentElement.setAttribute('data-clicked','true'))`);
   const clicked=await ui.evaluate(`readProtected('ref_click',{binding:${JSON.stringify(tree.result.binding)},snapshotId:${JSON.stringify(tree.result.snapshotId)},ref:${JSON.stringify(tree.result.items[1].ref)}})`);
   assert.ok(clicked.result,JSON.stringify(clicked));assert.equal(clicked.result.clicked,true);
   assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('#tree-scope article'),record=>record.getAttribute('data-clicked'))`),[null,'true']);
   await page.evaluate('scrollTo(0,0)');

   const axRead=await ui.evaluate(`readProtected('semantic_snapshot',{options:{root:'#ax-scope',query:'生成名称按钮',accessibility:true,budget:5000}})`);
   assert.ok(axRead.result,JSON.stringify(axRead));assert.equal(axRead.result.items[0].name,'生成名称按钮');assert.equal(axRead.result.items[0].nameSource,'accessibility');assert.equal(axRead.result.coverage.axEnriched,1);
   await writeFile(path.join(output,`${name}-semantic-tree.json`),JSON.stringify(axRead.result,null,2));
   // 中文注释：复现真实 Agent 的 display:none opaque sandbox iframe；读取、填入临时测试控件与截图均不受其阻断。
   await page.evaluate(`document.querySelector('#complex').insertAdjacentHTML('beforeend','<input id="hidden-frame-input" aria-label="隐藏框架测试输入"><iframe id="hidden-sandbox" sandbox style="display:none"></iframe>')`);
   const hiddenRead=await ui.evaluate(`readProtected('semantic_snapshot',{options:{root:'#complex',composed:true,query:'隐藏框架测试输入',budget:5000}})`);
   assert.ok(hiddenRead.result,JSON.stringify(hiddenRead));assert.equal(hiddenRead.result.coverage.complete,true);
   const hiddenFilled=await ui.evaluate(`readProtected('ref_fill',{binding:${JSON.stringify(hiddenRead.result.binding)},snapshotId:${JSON.stringify(hiddenRead.result.snapshotId)},ref:${JSON.stringify(hiddenRead.result.items[0].ref)},text:'fixture-only'})`);
   assert.ok(hiddenFilled.result,JSON.stringify(hiddenFilled));assert.equal(hiddenFilled.result.verified,true);
   assert.equal(await page.evaluate(`document.querySelector('#hidden-frame-input').value`),'fixture-only');
   // 中文注释：填写会按原有规则滚动，截图像素断言前恢复合成夹具的固定视口。
   await page.evaluate('scrollTo(0,0)');
   const closedBefore=await pageState();
   const closedRead=await ui.evaluate(`readProtected('semantic_snapshot',{options:{composed:true,budget:10000}})`);
   assert.ok(closedRead.result,JSON.stringify(closedRead));assert.doesNotMatch(JSON.stringify(closedRead),/CLOSED_PRIVATE_CANARY|禁止自动化操作/);
   for(const label of ['封闭公开按钮','框架封闭按钮','下载报告','展开菜单','保存内容','插槽保存'])assert(closedRead.result.items.some(item=>item.name===label),label);
   const frameItem=closedRead.result.items.find(item=>item.name==='框架封闭按钮');assert.deepEqual(frameItem.targetPath.map(part=>part.kind),['frame','shadow']);
   const complex=await ui.evaluate(`readProtected('page.parse',{options:{root:'#complex',sections:['tables','forms'],budget:10000}})`);
   assert.ok(complex.result,JSON.stringify(complex));assert.deepEqual(complex.result.tables.slice(0,2).map(row=>row.cells.map(cell=>cell.text)),[['名称','数量'],['设备','2']]);
   assert.deepEqual(complex.result.forms.find(field=>field.label==='地区').options,[{text:'中国',selected:false}]);
   const scoped=await ui.evaluate(`readProtected('page.parse',{options:{root:'#complex',sections:[],schema:{record:'article',fields:{title:{selector:':scope > h2',required:true}}}}})`);
   assert.ok(scoped.result,JSON.stringify(scoped));assert.equal(scoped.result.records[0].fields.title,'记录标题');
   const closedCapture=await ui.evaluate(`readProtected('screenshot')`);assert.ok(closedCapture.result,JSON.stringify(closedCapture));
   await writeFile(path.join(output,`${name}-closed-shadow.png`),Buffer.from(closedCapture.result.data,'base64'));
   const closedPixel=await ui.evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(closedCapture.result.data)}),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);return Array.from(ctx.getImageData(80,740,1,1).data);})()`);
   assert.deepEqual(closedPixel,[32,33,36,255]);assert.equal(await pageState(),closedBefore);
   // 中文注释：第三方 iframe 使用本地不同主机名构造；只有该框架不可读，不影响父页面解析。
   await page.evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='opaque-frame';frame.src=${JSON.stringify(origin.replace('127.0.0.1','localhost'))};document.body.append(frame);return new Promise(resolve=>frame.addEventListener('load',()=>resolve(true),{once:true}));})()`);
   const partial=await ui.evaluate(`readProtected('semantic_snapshot',{options:{composed:true,budget:10000}})`);
   assert.ok(partial.result,JSON.stringify(partial));assert.equal(partial.result.coverage.complete,false);assert.equal(partial.result.contentFilter.unreadFrames,1);
   assert(partial.result.items.some(item=>item.name==='封闭公开按钮'));
   const parsedPartial=await ui.evaluate(`readProtected('page.parse',{options:{composed:true,sections:['forms'],budget:10000}})`);
   assert.ok(parsedPartial.result,JSON.stringify(parsedPartial));assert.equal(parsedPartial.result.status,'partial');assert(parsedPartial.result.warnings.includes('unread_frames'));
   // 中文注释：显式缩小解析根避开第三方框架时，局部结果应恢复完整覆盖。
   const narrowRead=await ui.evaluate(`readProtected('semantic_snapshot',{options:{root:'#complex',composed:true,budget:10000}})`);
   assert.ok(narrowRead.result,JSON.stringify(narrowRead));assert.equal(narrowRead.result.coverage.complete,true);assert.equal(narrowRead.result.contentFilter.unreadFrames,undefined);
   const opaqueCapture=await ui.evaluate(`readProtected('screenshot')`);assert.equal(opaqueCapture.error?.code,'content_shield_uninspectable');assert.equal(opaqueCapture.result,undefined);
   results.push({browser:name,passed:true,noManualRules:true,popupSimplified:true,manifestVersionShown:true,persistentCursor:true,intermediateCursorX:moving,cursorPauseResume:true,reducedMotion:true,textRedacted:true,pngPixelChecks:2,dpr:2,domLayoutFocusUnchanged:true,disabledRestoresScreenshot:true,ancestorFilterRefused:true,closedShadowRead:true,sameOriginFrameClosedShadow:true,inlinePrivacy:true,nativeOptionPrivacy:true,slotName:true,virtualGridIndices:true,scopedAccessibility:true,sameNameReferenceClick:true,hiddenSandboxReadFillCapture:true,closedShadowTextRedacted:true,closedShadowPixelMasked:true,opaqueFramePartialRead:true,opaqueFrameCaptureRefused:true,wrappedAriaTable:true,portalOptions:true,scopedSchema:true,iconNames:true,displayContents:true});
  }finally{
   // 中文注释：浏览器主进程退出后子进程可能仍在收尾，只对本次临时 profile 有界重试清理。
   ui?.close();page?.close();browser?.close();proc.kill('SIGTERM');await new Promise(resolve=>proc.exitCode!==null?resolve():proc.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
 }
}finally{server.close();}
await writeFile(path.join(output,'result.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
