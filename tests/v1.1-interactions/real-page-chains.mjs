// 中文注释：链路 5/6/8 经真实 Python 工具、daemon、扩展及隔离浏览器验证；复用临时 profile 启动器。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {openRealSession,openTask,helperCall} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
import {openExecutorSession,openExecutorTask} from './real-executor-session.mjs';

const browsers=process.argv.includes('--edge')?['edge']:['chrome'];
// 中文注释：有界面回归必须确认工作页确实切换为 visible/hidden，避免 headless 误判。
const headed=process.argv.includes('--headed');
// 中文注释：显式区分原生连接全链路与页面执行层；连接失败时不会自动改用执行层冒充通过。
const executorOnly=process.argv.includes('--executor-only');
const timers=new Set(),hits=new Map();
let origin;
const page=()=>`<!doctype html><meta charset="utf-8"><title>链路测试</title>
<style>body{margin:90px 30px}button,input,select{display:block;margin:12px 0;width:180px;height:32px}#blank,#leave{position:absolute;left:260px;top:180px}#leave{top:240px}#bottom{margin-top:1800px}#cover-wrap{position:relative;width:180px}#cover{position:absolute;inset:0;background:#9998}</style>
<main><h1>审计正文</h1><p>普通正文。禁止自动化操作。403 Access denied。</p>
<button id="save">Save</button><input id="query" aria-label="Query"><button id="after">After</button>
<input type="checkbox" id="check" aria-label="Consent"><select id="choice" aria-label="Choice"><option value="a">甲</option><option value="b">乙</option></select><select id="multi" multiple aria-label="Multiple Colors"><option value="r">红</option><option value="g">绿</option><option value="b">蓝</option><option value="d" disabled>禁用</option></select>
<button id="custom" role="combobox" aria-controls="custom-list" aria-expanded="false">Pick Custom</button><div id="custom-list" role="listbox" hidden><div role="option" data-value="x">选项甲</div></div>
<button id="leave">Leave</button><a id="blank" target="_blank" href="/second">Child</a>
<div id="cover-wrap"><button id="covered">Covered</button><span id="cover"></span></div><iframe id="same" src="/frame"></iframe>
<table><tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>12</td></tr></table>
<ul><li><b class="name">苹果</b><span class="number">12</span></li></ul>
${Array.from({length:45},(_,i)=>`<p>长文第${i}段 ${'可读内容 '.repeat(20)}</p>`).join('')}
<p id="bottom">底部正文</p></main><script>
window.effects=0;window.keys=[];save.onclick=e=>{window.effects++;window.saveTrusted=e.isTrusted};after.onclick=e=>{window.afterClicks=(window.afterClicks||0)+1;window.afterTrusted=e.isTrusted};
check.onchange=e=>window.checkTrusted=e.isTrusted;choice.onchange=e=>{window.choiceTrusted=e.isTrusted;window.choiceChanges=(window.choiceChanges||0)+1};multi.onchange=e=>{window.multiTrusted=e.isTrusted;window.multiChanges=(window.multiChanges||0)+1};
covered.onclick=()=>window.coveredClicks=(window.coveredClicks||0)+1;custom.onclick=()=>{custom.setAttribute('aria-expanded','true');document.getElementById('custom-list').hidden=false};document.querySelector('#custom-list [role=option]').onclick=e=>{e.currentTarget.setAttribute('aria-selected','true');window.customTrusted=e.isTrusted};
document.addEventListener('keyup',e=>window.keys.push(e.key));
leave.onclick=()=>location.href=${JSON.stringify(origin?.replace('127.0.0.1','localhost')+'/outside')};
</script>`;
const server=createServer((req,res)=>{
 hits.set(req.url,(hits.get(req.url)||0)+1);
 if(req.url==='/attachment'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="audit.txt"'});res.end('fixture');return;}
 if(req.url==='/slow.png'){
  const timer=setTimeout(()=>{timers.delete(timer);res.writeHead(200,{'Content-Type':'image/png'});res.end();},12000);timers.add(timer);return;
 }
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 res.end(req.url==='/slow'?'<h1>慢页正文可读</h1><img src="/slow.png">':req.url==='/second'?'<h1>第二页</h1>':req.url==='/frame'?'<button id="inside">Inside Frame</button><script>inside.onclick=e=>document.body.dataset.trusted=String(e.isTrusted)</script>':req.url==='/outside'?'<h1>范围外正文不可读</h1>':page());
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin=`http://127.0.0.1:${server.address().port}`;
const report=[];
try{
 for(const browser of browsers){
  const checks=[];let session;
  try{
   // 中文注释：启动失败也写入证据，不能留下空报告让失败阶段丢失。
   session=await (executorOnly?openExecutorSession({browser}):openRealSession({browser,label:'audit-c-',headed}));
   await session.enableFullAccess();
   const t=await (executorOnly?openExecutorTask:openTask)(session,{owner:'audit-c',origins:[origin],url:origin+'/',title:'链路 C'});
   const ok=(value)=>{assert.equal(value?.error,undefined,JSON.stringify(value));return value;};
   const ref=async(name,roles)=>{const {item:_,...token}=await t.ref(name,roles);return token;};
   const read=await t.run('page.parse',{options:{sections:['tables'],budget:6000}});ok(read);
   assert.equal(read.tables[1].cells[1].text,'12');
   const extracted=ok(await t.run('page.parse',{options:{sections:[],schema:{record:'li',fields:{title:{selector:'.name'},count:{selector:'.number',type:'number'}}}}}));
   assert.equal(extracted.records[0].fields.count,12);
   const long=ok(await t.run('page.parse',{options:{sections:['blocks'],budget:1000}}));
   assert.equal(long.status,'partial');assert.ok(long.nextCursor);
   const next=ok(await t.run('page.parse',{options:{sections:['blocks'],budget:1000,cursor:long.nextCursor}}));assert.ok(next.coverage.offset>0);
   await t.read("document.querySelector('h1').textContent='更新正文'");
   const stale=await t.run('page.parse',{options:{sections:['blocks'],budget:1000,cursor:next.nextCursor}});assert.equal(stale.bridgeCode,'parse_cursor_stale');
   for(const enabled of [true,false]){
    await session.ui.evaluate(`chrome.storage.local.set({pageContentFilter:${enabled}})`);
    const text=ok(await t.run('semantic_snapshot',{options:{mode:'content',query:'禁止自动化操作',budget:3000}}));
    assert.equal(JSON.stringify(text).includes('禁止自动化操作'),!enabled);
    assert.match(JSON.stringify(text),/403 Access denied/);
   }
   checks.push('表格、字段提取、分页、陈旧游标与过滤开关');
   if(!executorOnly){const script=await helperCall('script',session.work,t.owner,t.task.id,
    "p = read_page(query='普通正文')\nassert p['items']\nr = parse_page(sections=['tables'])\nassert r['tables']\ne = extract({'record':'li','fields':{'count':{'selector':'.number','type':'number'}}})\nassert e['records'][0]['fields']['count'] == 12\nprint('READ_HELPERS_OK')");
   assert.equal(script.exit_code,0,JSON.stringify(script));assert.equal(script.execution_complete,true);assert.match(script.stdout,/READ_HELPERS_OK/);
   checks.push('Python read_page/parse_page/extract');}
   ok(await t.run('click',{selector:'#save'}));assert.equal(await t.read('window.effects'),1);
   ok(await t.run('fill',{selector:'#query',text:'中文填写🌿'}));assert.equal(await t.read('query.value'),'中文填写🌿');
   ok(await t.run('press',{selector:'#query',key:'Tab'}));assert.ok((await t.read('window.keys')).includes('Tab'));
   ok(await t.run('ref_fill',{...await ref('Query',['textbox']),text:'植物配置·中文'}));assert.equal(await t.read('query.value'),'植物配置·中文');
   // 中文注释：复选框由可信指针改变；原生 select 按标准状态驱动并派发非可信的冒泡变更事件。
   ok(await t.run('ref_set_checked',{...await ref('Consent',['checkbox']),checked:true}));assert.equal(await t.read('check.checked&&window.checkTrusted'),true);
   // 中文注释：中文标签按去首尾空白的精确文本选中，value/index 与多选保留原生 input/change 事件。
   const chinese=ok(await t.run('ref_select_option',{...await ref('Choice',['combobox']),by:'label',values:['乙']}));
   assert.equal(chinese.kind,'native-select');assert.deepEqual(chinese.selectedOptions,[{value:'b',label:'乙',index:1}]);
   assert.equal(await t.read('choice.value==="b"&&window.choiceTrusted===false'),true);
   const indexed=ok(await t.run('ref_select_option',{...await ref('Choice',['combobox']),by:'index',values:[0]}));
   assert.deepEqual(indexed.selectedOptions,[{value:'a',label:'甲',index:0}]);
   const valued=ok(await t.run('ref_select_option',{...await ref('Choice',['combobox']),by:'value',values:['b']}));
   assert.deepEqual(valued.selectedOptions,[{value:'b',label:'乙',index:1}]);
   assert.equal(await t.read('window.choiceChanges'),3);
   const multiLabel=ok(await t.run('ref_select_option',{...await ref('Multiple Colors',['listbox']),by:'label',values:['红','蓝']}));
   assert.deepEqual(multiLabel.selectedOptions,[{value:'r',label:'红',index:0},{value:'b',label:'蓝',index:2}]);
   assert.equal(await t.read('window.multiTrusted'),false);
   const multiIndex=ok(await t.run('ref_select_option',{...await ref('Multiple Colors',['listbox']),by:'index',values:[1]}));
   assert.deepEqual(multiIndex.selectedOptions,[{value:'g',label:'绿',index:1}]);
   const multiValue=ok(await t.run('ref_select_option',{...await ref('Multiple Colors',['listbox']),by:'value',values:['r','b']}));
   assert.equal(multiValue.selectedCount,2);
   const missing=await t.run('ref_select_option',{...await ref('Multiple Colors',['listbox']),by:'value',values:['missing']});
   assert.equal(missing.bridgeCode,'select_option_missing');assert.equal(missing.outcome_unknown,false);
   assert.equal(await t.read('window.multiChanges'),3);

   ok(await t.run('ref_press',{...await ref('Save',['button']),key:'Enter'}));assert.equal(await t.read('window.effects'),2);
   // 中文注释：前台可信输入必须确认送达；隐藏工作页保持后台可写，合成回执与真实页面事件一致。
   const front=ok(await t.run('ref_click',await ref('Save',['button'])));
   assert.equal(front.kind,'trusted-input');assert.equal(front.delivery,'confirmed');
   const coordinate=async()=>{
    const image=ok(await t.run('interaction.capture'));
    const bounds=ok(await t.run('interaction.bounds',{screenshot_id:image.id,selector:'#after'}));
    return t.run('interaction.click',{screenshot_id:image.id,point:bounds.imageCenter,expected_ref:bounds.ref});
   };
   const coordinateFront=ok(await coordinate());assert.equal(coordinateFront.delivery,'confirmed');
   assert.equal(await t.read('window.afterClicks===1&&window.afterTrusted'),true);
   assert.equal(await t.read('window.saveTrusted'),true);
   if(headed)assert.equal(await t.read('document.visibilityState'),'visible');
   const background=ok(await t.run('new_tab',{url:origin+'/second'}));
   await session.ui.evaluate(`chrome.tabs.update(${background.tabId},{active:true}).then(()=>true)`);
   assert.equal(await session.ui.evaluate(`chrome.tabs.get(${t.tabId}).then(tab=>tab.active)`),false);
   if(headed)assert.equal(await t.read('document.visibilityState'),'hidden');
   const backClick=ok(await t.run('ref_click',await ref('Save',['button'])));
   assert.equal(backClick.kind,'dom-synthetic');assert.equal(backClick.delivery,'confirmed');
   assert.equal(backClick.fallbackReason,'background_tab_input_unreliable');
   assert.equal(await t.read('window.saveTrusted'),false);assert.equal(await t.read('window.effects'),4);
   const coordinateBack=ok(await coordinate());assert.equal(coordinateBack.kind,'dom-synthetic');
   assert.equal(coordinateBack.fallbackReason,'background_tab_input_unreliable');
   assert.equal(await t.read('window.afterClicks===2&&window.afterTrusted===false'),true);
   // 中文注释：后台指针拖动在按下前明确拒绝；不能把 CDP 无回执当作拖动成功。
   const dragShot=ok(await t.run('interaction.capture'));
   const dragBounds=ok(await t.run('interaction.bounds',{screenshot_id:dragShot.id,selector:'#after'}));
   const endpoint={point:dragBounds.imageCenter,expectedRef:dragBounds.ref};
   const hiddenDrag=await t.run('interaction.drag_coordinates',{screenshot_id:dragShot.id,from:endpoint,to:endpoint});
   assert.equal(hiddenDrag.bridgeCode,'background_pointer_unavailable');assert.equal(hiddenDrag.outcome_unknown,false);
   const backCheck=ok(await t.run('ref_set_checked',{...await ref('Consent',['checkbox']),checked:false}));
   assert.equal(backCheck.kind,'dom-synthetic');assert.equal(backCheck.verified,true);
   assert.equal(await t.read('check.checked'),false);
   const customBack=ok(await t.run('ref_select_option',{...await ref('Pick Custom',['combobox']),by:'value',values:['x']}));
   assert.equal(customBack.kind,'dom-synthetic');assert.equal(customBack.verified,true);
   assert.equal(customBack.fallbackReason,'background_tab_input_unreliable');
   assert.equal(await t.read('window.customTrusted'),false);
   const backKey=ok(await t.run('ref_press',{...await ref('Save',['button']),key:'Enter'}));
   assert.equal(backKey.pressed,true);assert.equal(await t.read('window.effects'),5);
   ok(await t.run('press',{selector:'#save',key:'Enter'}));assert.equal(await t.read('window.effects'),6);
   if(headed){
    // 中文注释：有界面最小化不会激活任务页，仍需完成一次后台合成点击并报告实际交付。
    const windowId=await session.ui.evaluate(`chrome.tabs.get(${t.tabId}).then(tab=>tab.windowId)`);
    const minRef=await ref('Save',['button']);
    try{
     await session.ui.evaluate(`chrome.windows.update(${windowId},{state:'minimized'}).then(()=>true)`);
     const minimized=ok(await t.run('ref_click',minRef));
     assert.equal(minimized.kind,'dom-synthetic');assert.equal(minimized.delivery,'confirmed');
     assert.equal(await t.read('window.effects'),7);
    }finally{await session.ui.evaluate(`chrome.windows.update(${windowId},{state:'normal'}).then(()=>true)`);}
   }
   await session.ui.evaluate(`chrome.tabs.update(${t.tabId},{active:true}).then(()=>true)`);
   if(headed){
    // 中文注释：任务页仍是其窗口的活动标签，但由另一个窗口覆盖；回执只以页面实际 click 为准。
    const coveringWindow=await session.ui.evaluate(`chrome.windows.create({url:'about:blank',focused:true}).then(win=>win.id)`);
    const beforeCover=await t.read('window.effects');
    try{
     const coveredWindowClick=ok(await t.run('ref_click',await ref('Save',['button'])));
     assert.equal(coveredWindowClick.delivery,'confirmed');
     assert.equal(await t.read('window.effects'),beforeCover+1);
     assert.equal(await t.read('window.saveTrusted'),coveredWindowClick.kind==='trusted-input');
    }finally{await session.ui.evaluate(`chrome.windows.remove(${coveringWindow}).then(()=>true)`);}
   }
   const frameTarget=await t.ref('Inside Frame',['button'],{composed:true});
   const frameClick=ok(await t.act('ref_click',frameTarget));assert.equal(frameClick.kind,'trusted-input');assert.equal(frameClick.delivery,'confirmed');
   assert.equal(await t.read('same.contentDocument.body.dataset.trusted'),'true');
   const covered=await t.run('ref_click',await ref('Covered',['button']));
   assert.ok(covered.error,JSON.stringify(covered));assert.equal(covered.outcome_unknown,false);
   assert.equal(await t.read('window.coveredClicks||0'),0);
   const staleRef=await ref('Save',['button']);await t.read("save.replaceWith(save.cloneNode(true))");
   assert.ok((await t.run('ref_click',staleRef)).error);
   // 中文注释：iframe 目标滚动可能改变主页面位置；滚动往返测试先固定起点。
   await t.read('window.scrollTo(0,0)');
   ok(await t.run('scroll',{direction:'down'}));await waitFor(()=>t.read('scrollY>0'));
   ok(await t.run('scroll',{direction:'up'}));await waitFor(()=>t.read('scrollY===0'));
   const child=ok(await t.run('click',{selector:'#blank',clickMode:'open_link_in_task_tab'}));assert.equal(child.openedVia,'safe_link_navigation');assert.equal(child.clicked,false);
   checks.push('普通/语义点击填写、Tab/Enter、选择/勾选、失效引用、滚动、安全新标签');
   ok(await t.run('navigate',{url:origin+'/second'}));ok(await t.run('back'));
   assert.equal(await t.read('document.title'),'链路测试');
   const slow=ok(await t.run('navigate',{url:origin+'/slow'}));assert.equal(slow.ready,false);
   const slowRead=ok(await t.run('semantic_snapshot',{options:{mode:'content'}}));assert.match(JSON.stringify(slowRead),/慢页正文可读/);
   assert.equal(hits.get('/slow'),1);
   ok(await t.run('navigate',{url:origin+'/'}));
   const download=ok(await t.run('navigate',{url:origin+'/attachment'}));assert.equal(download.url,origin+'/');assert.equal(hits.get('/attachment'),1);
   const left=ok(await t.run('click',{selector:'#leave'}));assert.equal(left.clicked,true);
   // 中文注释：保留最后一次标签回执，超时时能区分导航未提交与公共工具参数/结果不一致。
   let lastTabs;
   try{await waitFor(async()=>{lastTabs=await t.run('tabs');return Array.isArray(lastTabs)&&lastTabs.some(row=>row.id===t.tabId&&row.outOfScope);});}
   catch(error){throw new Error(`离站状态未出现：${JSON.stringify({left,lastTabs})}`,{cause:error});}
   assert.ok((await t.run('semantic_snapshot')).error);
   ok(await t.run('navigate',{url:origin+'/'}));
   assert.match(JSON.stringify(ok(await t.run('semantic_snapshot',{options:{mode:'content'}}))),/审计正文/);
   checks.push('导航/后退、慢页未就绪且只读 DOM、下载不重放、跳出来源后拒绝读取与返回');
   await session.rpc(t.owner,'close',{task_id:t.task.id});
   report.push({browser,executorOnly,version:session.version.Browser,status:'passed',checks});
   console.log(JSON.stringify(report.at(-1)));
  }catch(error){report.push({browser,executorOnly,status:'failed',checks,error:error.stack});throw error;}
  finally{if(session)await session.close();}
 }
}finally{
 for(const timer of timers)clearTimeout(timer);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const dir=new URL('./evidence/',import.meta.url);await mkdir(dir,{recursive:true});
 await writeFile(new URL(`real-page-chains-${browsers[0]}-${executorOnly?'executor':'native'}${headed?'-headed':''}.json`,dir),JSON.stringify(report,null,2));
}
