// 中文注释：仅在独立临时 profile 和本地固定页面验收，不接触个人任务或安装。
import {createServer} from 'node:http';
import {writeFile,mkdir} from 'node:fs/promises';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const reps=process.argv.includes('--reps')?Number(arg('--reps')):10;
const label=process.argv.includes('--label')?arg('--label'):'after';
const output=process.env.TABS_INTERACTION_RESULTS||'/tmp/tabs-interaction-results';
const fixtures={
 rerender:'<ul id="list"><li><button id="act">Apply</button></li></ul>',
 cookie:'<button id="act">Apply</button><aside role="dialog" aria-label="Cookie banner" id="banner" style="position:fixed;inset:0;background:#ddd;z-index:999"><button id="close">Close cookies</button></aside>',
 animation:'<button id="act">Apply</button>',
 enabled:'<button id="act">Apply</button>',
 spa:'<button id="act">Apply</button>',
 navigation:'<button id="act">Apply</button>',
 native:'<select aria-label="Region" id="select"><option value="us">US</option><option value="cn"> New   Zealand </option></select>',
 custom:'<div id="act" role="combobox" aria-label="Region" aria-controls="options" aria-expanded="false" tabindex="0">Region</div><div id="options" role="listbox" hidden><div role="option" data-value="cn" aria-selected="false" id="option"> New   Zealand </div></div>',
 iframe:'<button id="act">Apply</button><iframe sandbox src="/opaque" style="position:absolute;left:600px;top:300px;width:160px;height:100px"></iframe>',
 icon:'<button id="act"><svg width="20" height="20"><title>Settings</title><circle cx="10" cy="10" r="9"/></svg></button>',
};
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});const name=req.url.split(/[/?]/)[1];res.end(`<!doctype html><style>button,[role=combobox],[role=option]{min-width:140px;min-height:36px}body{padding:20px}</style>${name==='done'?'<p id="done">Done</p>':name==='opaque'?'<p>Unrelated frame</p>':fixtures[name]||''}<script>window.count=0;const b=document.querySelector('#act');if(b)b.onclick=()=>{window.count++;if('${name}'==='spa')history.pushState({},'', '/spa?done=1');else if('${name}'==='navigation')location.href='/done';else if('${name}'==='custom'){b.setAttribute('aria-expanded','true');document.querySelector('#options').hidden=false}else b.dataset.clicked='yes'};document.querySelector('#close')?.addEventListener('click',()=>document.querySelector('#banner').remove());document.querySelector('#option')?.addEventListener('click',e=>{e.currentTarget.setAttribute('aria-selected','true');window.count++});</script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const samples={},cleanup={};let session,tab;
try{
 session=await openRealSession({browser:'chrome',label:'tabs-test'});await session.enableFullAccess();
 tab=await openTask(session,{owner:'tabs-acceptance',origins:[origin],url:origin+'/rerender',title:'标签交互验收'});
 for(const name of Object.keys(fixtures))for(let i=0;i<reps;i++){
  const start=performance.now();let result,success=false;
  try{
   const nav=await tab.run('navigate',{url:origin+'/'+name,summary:false});if(nav.error)throw nav;
   const target=await tab.ref(name==='icon'?'Settings':['native','custom'].includes(name)?'Region':'Apply');const {item:_,...token}=target;
   if(name==='rerender')await tab.read(`document.querySelector('#list').innerHTML='<li><button id="act" onclick="window.count++">Apply</button></li>'`);
   if(name==='animation')await tab.read(`document.querySelector('#act').animate([{transform:'translateX(0)'},{transform:'translateX(250px)'}],{duration:900,fill:'forwards'});true`);
   if(name==='enabled')await tab.read(`document.querySelector('#act').disabled=true;setTimeout(()=>document.querySelector('#act').disabled=false,1400);true`);
   if(name==='cookie'){
    const blocked=await tab.run('ref_click',token);
    if(blocked.code!=='target_occluded'||blocked.outcome_unknown!==false||blocked.obstruction?.name!=='Cookie banner')throw blocked;
    const close=await tab.ref('Close cookies');result=await tab.act('ref_click',close);if(result.error)throw result;
   }
   result=await tab.run(['native','custom'].includes(name)?'ref_select_option':'ref_click',{...token,...(['native','custom'].includes(name)?{by:'label',values:['New Zealand']}:{})});
   if(result.error||result.outcome_unknown===true)throw result;
   if(name==='navigation')success=await session.readUrl('/done',`Boolean(document.querySelector('#done'))`);
   else if(name==='native')success=await tab.read(`document.querySelector('#select').value==='cn'`);
   else if(name==='custom')success=await tab.read(`document.querySelector('#option').getAttribute('aria-selected')==='true'&&window.count===2`);
   else success=await tab.read(`window.count===1${name==='spa'?"&&location.search==='?done=1'":''}`);
   if(name==='spa'||name==='navigation')success=success&&result.navigation?.kind===(name==='spa'?'same_document':'document');
  }catch(error){result=error;}
  (samples[name]??=[]).push({success:success===true,durationMs:Math.round(performance.now()-start),code:result?.bridgeCode||result?.code||(!success?'acceptance_failed':null),outcome_unknown:result?.outcome_unknown??null});
  console.log(label,name,i+1,samples[name].at(-1).success,samples[name].at(-1).code);
 }
 const missing=await session.rpc(tab.owner,'close',{task_id:tab.task.id,keep_tabs:true});
 cleanup.missingReason=missing.code==='invalid_fields'&&(await session.rpc(tab.owner,'get',{task_id:tab.task.id})).state==='ready';
 const handed=await session.rpc(tab.owner,'close',{task_id:tab.task.id,keep_tabs:true,handoff_reason:'captcha'});
 const retained=await session.ui.evaluate(`chrome.tabs.get(${tab.tabId}).then(t=>({groupId:t.groupId}),()=>null)`);
 cleanup.handoff=handed.state==='closed'&&handed.cleanupReason==='handed_to_user'&&handed.handoffReason==='captcha'&&retained?.groupId===-1;
 const ordinary=await openTask(session,{owner:'ordinary-close',origins:[origin],url:origin+'/icon',title:'普通关闭验收'});
 const closed=await session.rpc(ordinary.owner,'close',{task_id:ordinary.task.id});
 cleanup.ordinaryClose=closed.cleanupState==='succeeded'&&await session.ui.evaluate(`chrome.tabs.get(${ordinary.tabId}).then(()=>false,()=>true)`);
 console.log('cleanup',JSON.stringify(cleanup));
}finally{await session?.close();await new Promise(resolve=>server.close(resolve));await mkdir(output,{recursive:true});await writeFile(`${output}/${label}.json`,JSON.stringify({label,reps,samples,cleanup},null,2));}
if(Object.values(samples).some(rows=>rows.some(row=>!row.success))||Object.values(cleanup).some(passed=>!passed))process.exitCode=1;
