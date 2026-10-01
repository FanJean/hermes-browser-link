// 中文注释：手动验收只用临时 Chrome/Edge profile 与合成本地站；本任务不执行此脚本。
// node tests/v1.4.4/real-round1f.mjs [--edge]
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';

const exec=promisify(execFile),timers=new Set();
const server=createServer((req,res)=>{
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
 if(req.url==='/loading'){
  // 中文注释：首段只有 head，15 秒后才完成正文；开页 8 秒截止时必须说明 loading。
  res.write('<!doctype html><html><head><title>Loading fixture</title>');
  const timer=setTimeout(()=>{timers.delete(timer);res.end('</head><body><main><h1>Ready</h1></main></body></html>');},15000);timers.add(timer);
 }else res.end('<!doctype html><html><head><title>Wait fixture</title></head><body><main id="results"><h1>Wait fixture</h1></main></body></html>');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://www.bench.localhost:${server.address().port}`,other=`http://tools.localhost:${server.address().port}`;
const rows=[];let session;
const check=async(label,fn)=>{try{rows.push({label,ok:true,detail:await fn()});}catch(error){rows.push({label,ok:false,error:String(error.message).slice(0,500)});}};
const python=process.env.HERMES_PYTHON||path.join(process.env.HOME,'.hermes/hermes-agent/venv/bin/python');
async function call(action,payload,owner='round1f'){
 const {stdout}=await exec(python,[path.join(import.meta.dirname,'real-round1f-helper.py'),session.work,owner,action,JSON.stringify(payload)],{timeout:120000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 return JSON.parse(stdout.trim());
}
async function script(taskId,code){const value=await call('script',[taskId,'# 中文注释：显式导入标准库；每次脚本独立执行。\nimport json,time\n'+code]);assert.equal(value.result.exit_code,0,value.result.stderr);return {value:JSON.parse(value.result.stdout.trim()),counts:value.action_counts};}
const arm=`evaluate('()=>{document.querySelector("#hit")?.remove();setTimeout(()=>{const p=document.createElement("p");p.id="hit";p.textContent="ready";document.querySelector("main").append(p)},2000);return true}', None)\n`;
// 中文注释：旧算法仅作为只读基线回放，同条件、同间隔；不复制旧写入或页面数据。
const baseline=(timeout)=>`start=time.monotonic()\nwhile True:\n    page=extract({'record':'#hit','fields':{'text':{'selector':':scope','type':'text'}}},budget=12000)\n    satisfied=page['coverage']['complete'] and bool(page['records'])\n    if satisfied or time.monotonic()-start>=${timeout}:\n        break\n    time.sleep(min(0.25,max(0,${timeout}-(time.monotonic()-start))))\nprint(json.dumps({'satisfied':satisfied,'elapsed':time.monotonic()-start}))`;
try{
 session=await openRealSession({browser:process.argv.includes('--edge')?'edge':'chrome',label:'round1f'});
 await session.enableFullAccess();
 const tab=await openTask(session,{owner:'round1f',origins:[origin],url:`${origin}/wait`,title:'1f 本地夹具'});
 await check('缺 tab_id 返回 missing_fields',async()=>{
  const result=await session.rpc('round1f','run',{task_id:tab.task.id,action:'semantic_snapshot'});
  assert.equal(result.code,'missing_fields');assert.deepEqual(result.fields,['tab_id']);return result;
 });
 await check('轻量等待命中，完整 parse 减少至少 70%，p50 命中延迟不退步',async()=>{
  const old=[],now=[];let oldParses=0,newParses=0;
  for(let i=0;i<5;i++){
   const before=await script(tab.task.id,arm+baseline(4));assert.equal(before.value.satisfied,true);old.push(before.value.elapsed);oldParses+=before.counts['page.parse']||0;
   const after=await script(tab.task.id,arm+`start=time.monotonic()\nr=wait_for('#hit',timeout=4)\nprint(json.dumps({'satisfied':r['satisfied'],'elapsed':time.monotonic()-start}))`);
   assert.equal(after.value.satisfied,true);now.push(after.value.elapsed);newParses+=after.counts['page.parse']||0;
  }
  const median=values=>[...values].sort((a,b)=>a-b)[2];
  const reduction=1-newParses/oldParses;assert.ok(reduction>=.70);assert.ok(median(now)<=median(old),JSON.stringify({old,now}));
  return {oldParses,newParses,reduction,oldP50:median(old),newP50:median(now)};
 });
 await check('轻量等待超时，解析一次，条件 false 后不重等',async()=>{
  const after=await script(tab.task.id,`r=wait_for('#never',timeout=2)\nprint(json.dumps(r))`);
  assert.equal(after.value.satisfied,false);assert.equal(after.value.timed_out,true);assert.equal(after.value.reason,'deadline_reached');assert.equal(after.counts['page.parse'],1);assert.ok(after.counts['page.observe']>=4);return after;
 });
 await check('loading 中 open 固定缺失原因与原页读取提示',async()=>{
  const {result}=await call('open',{url:`${origin}/loading`,instance_id:(await session.instance()).instanceId,new_task:true,read_intent:'content'},'round1f-loading');
  assert.equal(result.ready,'loading');assert.equal(result.summary_missing.reason,'page_loading');assert.match(result.read_hint,/原 tab/);return {ready:result.ready,missing:result.summary_missing};
 });
 await check('跨站 goto_url 拒绝带当前 origin，无路径查询，不扩大授权',async()=>{
  const value=await script(tab.task.id,`try:\n    goto_url(${JSON.stringify(other+'/private?q=synthetic')})\nexcept BrowserError as error:\n    print(json.dumps({'code':error.code,'origin':error.current_origin}))`);
  assert.equal(value.value.code,'origin_denied');assert.equal(value.value.origin,origin);return value.value;
 });
 await check('工作页离开来源时只返回脱敏 origin',async()=>{
  await session.ui.evaluate(`chrome.tabs.update(${tab.tabId},{url:${JSON.stringify(other+'/outside?q=synthetic')}})`);
  await new Promise(resolve=>setTimeout(resolve,500));
  const result=await tab.run('semantic_snapshot');assert.equal(result.bridgeCode,'tab_out_of_scope');assert.equal(result.currentOrigin,other,JSON.stringify(result));assert.doesNotMatch(JSON.stringify(result),/outside|synthetic/);return result;
 });
}finally{
 await session?.close();for(const timer of timers)clearTimeout(timer);server.closeAllConnections();server.close();
}
for(const row of rows)console.log(JSON.stringify(row));
process.exitCode=rows.every(row=>row.ok)?0:1;
