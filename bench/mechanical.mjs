// 中文注释：真实浏览器基准只在人工调用时运行；导入不会启动浏览器。
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {createHash} from 'node:crypto';
import {openRealSession, openTask, helperCall, root} from '../tests/native-v2/real-session.mjs';
import {createBenchServer, ROWS} from './site/server.mjs';
import {summarize} from './mechanical-metrics.mjs';
import {measureSample,isolatedSample} from './mechanical-runner.mjs';

const STAGES = ['queue_wait','settle_wait','overlay','target_settle','highlight','dispatch','post_check'];
const arg = name => {const index=process.argv.indexOf(name);return index < 0 ? null : process.argv[index+1];};
const browser=arg('--browser')||'chrome', reps=Number(arg('--reps')||5), label=arg('--label')||'baseline', port=Number(arg('--port')||8765), cursor=arg('--cursor')||'on';
if (!['chrome','edge'].includes(browser) || !['on','off'].includes(cursor) || !Number.isInteger(reps) || reps<1 || !Number.isInteger(port) || port<1 || port>65535 || !/^[\w.-]+$/.test(label)) throw Error('usage: node bench/mechanical.mjs --browser chrome|edge --reps N --label name [--port 8765] [--cursor on|off]');
const origin=`http://www.bench.localhost:${port}`, apex=`http://bench.localhost:${port}`;
const samples={};
function record(name, durationMs, success, code=null, extra={}) {(samples[name]??=[]).push({durationMs:Math.round(durationMs*100)/100,success,code,...extra});}
// 中文注释：测量结果统一保留具体错误字段，汇总只统计成功项耗时。
function recordSample(name,sample){const {durationMs,success,code,...extra}=sample;record(name,durationMs,success,code,extra);}
async function measure(name,work,verify){const result=await measureSample(work,verify);recordSample(name,result.sample);return result.value;}

async function promptSize() {
  // 中文注释：动态导入注册表获取实际工具 schema；系统片段以插件技能原文计量。
  const code=`import importlib.util,json\ndef load(name,path):\n s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m\np='executor-plugin/'\nschemas=load('native',p+'native_tools.py').TOOL_SCHEMAS.copy()\no=load('open',p+'open_tool.py');schemas[o.TOOL_NAME]=o.SCHEMA;schemas['browser_shared_use_tab']=o.USE_TAB_SCHEMA\ns=load('script',p+'script_lane/tool.py');schemas[s.TOOL_NAME]=s.SCHEMA\nschemas.update(load('site',p+'site_tools/tools.py').SCHEMAS)\nschemas.update(load('reference',p+'reference.py').SCHEMAS)\nguide=load('plugin',p+'__init__.py')\nprint(json.dumps({'schemas':schemas,'system_prompt':guide._PROMPT},ensure_ascii=False,separators=(',',':')))\n`;
  const result=spawnSync('python3',['-c',code],{cwd:root,encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr);
  const registered=JSON.parse(result.stdout.trim());
  const schema=JSON.stringify(registered.schemas);
  const files=['use-my-browser','batch-scrape','troubleshoot'].map(name=>path.join(root,'executor-plugin/skills',name,'SKILL.md'));
  const skills=await Promise.all(files.map(file=>readFile(file,'utf8')));
  const parts={systemPromptFragments:{count:1,characters:registered.system_prompt.length,estimatedTokens:Math.ceil(registered.system_prompt.length/4)},toolSchemasAndDescriptions:schema.length,registeredToolCount:Object.keys(registered.schemas).length,skillFiles:skills.map((s,i)=>({file:path.relative(root,files[i]),characters:s.length,estimatedTokens:Math.ceil(s.length/4)}))};
  const skillCharacters=skills.reduce((n,s)=>n+s.length,0);
  return {...parts,skillCharacters,totalCharacters:registered.system_prompt.length+skillCharacters+schema.length,estimatedTokens:Math.ceil((registered.system_prompt.length+skillCharacters+schema.length)/4)};
}
async function diagnosticStages(session, action, since) {
  try {
    // 中文注释：弹窗消息协议外包一层 result；只读取本次动作之后的新事件。
    const response=await session.ui.evaluate(`chrome.runtime.sendMessage({type:'diagnostics_export'})`);
    const bundle=response?.result||response;
    const events=bundle?.events||bundle?.items||[];
    const matches=events.filter(event=>event.action===action && event.timestamp>=since && STAGES.includes(event.stage));
    return Object.fromEntries(STAGES.map(stage=>[stage,matches.filter(event=>event.stage===stage).at(-1)?.duration_ms??'未拿到']));
  } catch {return Object.fromEntries(STAGES.map(stage=>[stage,'未拿到']));}
}
async function target(task, name, roles) {return task.ref(name,roles,{composed:true});}
async function run() {
  const server=createBenchServer();await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  let session;const started=new Date().toISOString();const openings=[];
  try {
    const begin=performance.now();session=await openRealSession({browser,label:'bench'});record('browser_launch',performance.now()-begin,true);
    await session.enableFullAccess();
    // 中文注释：基准开始前持久化光标开关，动作测量不包含设置时间。
    const cursorSetting=await session.ui.evaluate(`chrome.runtime.sendMessage({type:'visual_cursor',enabled:${cursor==='on'}})`);
    if((cursorSetting?.result||cursorSetting)?.enabled!==(cursor==='on'))throw Error('cursor setting unconfirmed');
    for(let rep=0;rep<reps;rep++) {
      let task;
      const fresh=name=>openTask(session,{owner:`bench-${rep}-${name}`,origins:[origin,apex],
        url:`${origin}/${name==='script_table_250'?'data-table':['iframe_click','shadow_click'].includes(name)?'widgets':'directory-submit'}`,title:`基准 ${rep+1} ${name}`});
      const close=handle=>session.rpc(handle.owner,'close',{task_id:handle.task.id});
      const first=performance.now(),openedSince=new Date().toISOString();
      // 中文注释：每个测量项独立建任务；准备与收尾不计入动作耗时，失败也继续下一项。
      try{
        const opened=await fresh('open');record(rep===0?'cold_open':'warm_open',performance.now()-first,true);
        openings.push({rep,kind:rep===0?'cold_open':'warm_open',stages:await diagnosticStages(session,'new_tab',openedSince),timeline:'shared.get 未公开 operationTimeline'});
        await close(opened).catch(()=>{});
      }catch(error){record(rep===0?'cold_open':'warm_open',performance.now()-first,false,error.bridgeCode||error.code||error.name,{bridgeCode:error.bridgeCode??null,_diagnostic:{code:error._diagnostic?.code??null}});}
      const isolated=async(name,work,verify,prepare=async()=>{})=>{
        const result=await isolatedSample({create:()=>fresh(name),prepare:async value=>{task=value;await prepare();},work,verify,close});
        recordSample(name,result.sample);return result.value;
      };
      await isolated('navigate',()=>task.run('navigate',{url:`${origin}/directory-submit`}),value=>value?.url?.includes('/directory-submit'));
      // 中文注释：同站新页分别走原任务导航和完整新任务开页，保留每轮样本。
      await isolated('same_site_navigate',()=>task.run('navigate',{url:`${origin}/catalog`}),value=>value?.url?.includes('/catalog'));
      let newTask;
      await measure('same_site_new_task',async()=>{newTask=await openTask(session,{owner:`bench-new-${rep}`,origins:[origin],url:`${origin}/catalog`,title:`同站新任务 ${rep+1}`});return newTask;},value=>value?.tabId>0);
      if(newTask)await close(newTask).catch(()=>{});
      // 中文注释：四个慢页均由同一任务读取；并行批次在所有结果返回后结束计时。
      await isolated('four_pages_sequential',async()=>{
        const values=[];
        for(let page=1;page<=4;page++){
          const result=await task.run('navigate',{url:`${origin}/slow-read/${page}`});
          if(result?.error)return result;
          values.push(result?.url?.includes(`/slow-read/${page}`) && await task.read('document.body.innerText'));
        }
        return values;
      },values=>values?.every((value,index)=>value?.includes(`SLOW-${index+1}`)));
      await isolated('four_pages_parallel',async()=>{
        const batch=await Promise.allSettled([1,2,3,4].map(page=>task.run('new_tab',{url:`${origin}/slow-read/${page}`})));
        const failed=batch.find(row=>row.status==='rejected');if(failed)throw failed.reason;
        const tabs=batch.map(row=>row.value);
        const denied=tabs.find(row=>row?.error);if(denied)return denied;
        return Promise.all(tabs.map((tab,index)=>session.readPage(tab.tabId,'document.body.innerText').then(text=>({text,page:index+1}))));
      },values=>values?.every(value=>value.text?.includes(`SLOW-${value.page}`)));
      await isolated('semantic_snapshot',()=>task.run('semantic_snapshot',{options:{mode:'interactive',budget:5000}}),value=>Array.isArray(value?.items));
      // 中文注释：同轮比较普通截图与含敏感字段、跨源框架遮罩的截图耗时。
      await isolated('screenshot_plain',()=>task.run('screenshot'),value=>typeof value?.data==='string'&&value.data.length>0);
      await isolated('screenshot_masked',()=>task.run('screenshot'),value=>typeof value?.data==='string'&&value.masked?.length>0,
        async()=>{await task.run('navigate',{url:`${origin}/real-form-cases`});});
      let ref;
      await isolated('ref_fill',()=>task.act('ref_fill',ref,{text:'基准产品'}),value=>value?.filled===true,
        async()=>{ref=await target(task,'产品名称',['textbox']);});
      await isolated('ref_click',()=>task.act('ref_click',ref),value=>!value?.error,
        async()=>{ref=await target(task,'选择分类',['combobox']);});
      await isolated('custom_dropdown',()=>task.act('ref_click',ref),async()=>await task.read('document.querySelector("#category-value").value')==='设计与创意',
        async()=>{await task.act('ref_click',await target(task,'选择分类',['combobox']));ref=await target(task,'设计与创意',['option']);});
      await isolated('file_upload',()=>task.run('files.upload',{selector:'input[name="logo"]',paths:[path.join(root,'bench/site/assets/logo.png')]}),async()=>await task.read('document.querySelector("[name=logo]").files.length')===1);
      await isolated('navigate_table',()=>task.run('navigate',{url:`${origin}/data-table`}),value=>value?.url?.includes('/data-table'));
      // 中文注释：脚本通道一次翻五页并返回标准化行，校验完整 250 行。
      const selector='[data-ui-name="Body.Row"]';
      const script=`import json,hashlib\nrows=[]\nfor page in range(1,6):\n    wait_for(${JSON.stringify(selector)}, timeout=8)\n    rows += evaluate(${JSON.stringify(`()=>Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(r=>Array.from(r.children).map(c=>c.textContent))`)})\n    if page<5:\n        click('#next')\nprint(json.dumps({'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()},ensure_ascii=False))`;
      await isolated('script_table_250',()=>helperCall('script',session.work,task.owner,task.task.id,script),value=>{if(value?.exit_code!==0)return false;const lines=value.stdout.trim().split('\n');const result=JSON.parse(lines.at(-1));const expected=ROWS.map(row=>[row.keyword,String(row.volume),String(row.KD),row.URL]);return result.count===250&&result.sha256===createHash('sha256').update(JSON.stringify(expected)).digest('hex');});
      // 中文注释：脚本启动后由可信扩展入口接管，等待一秒再恢复；结果必须来自同一子进程继续执行。
      await isolated('takeover_resume',async()=>{
        const running=helperCall('script',session.work,task.owner,task.task.id,
          "import time\ntime.sleep(0.3)\npage=semantic_snapshot(mode='interactive',budget=3000)\nprint('RESUMED:'+str(len(page['items'])))");
        await new Promise(resolve=>setTimeout(resolve,100));
        const control=kind=>session.ui.evaluate(`chrome.runtime.sendMessage({type:'popup_action',taskId:${JSON.stringify(task.task.id)},generation:${task.task.generation},tabId:${task.tabId},kind:${JSON.stringify(kind)}})`);
        const paused=await control('takeover');if((paused?.result||paused)?.verified!==true)throw Error('takeover not verified');
        await new Promise(resolve=>setTimeout(resolve,1000));
        const resumed=await control('resume');if((resumed?.result||resumed)?.verified!==true)throw Error('resume not verified');
        return running;
      },value=>value?.exit_code===0&&value?.stdout?.includes('RESUMED:'));
      const slowSince=new Date().toISOString();await isolated('slow_open',()=>task.run('navigate',{url:`${origin}/slow`}),value=>value?.ready!==undefined);
      openings.push({rep,kind:'slow_open',stages:await diagnosticStages(session,'navigate',slowSince),timeline:'shared.get 未公开 operationTimeline'});
      const apexSince=new Date().toISOString();await isolated('apex_to_www',()=>task.run('navigate',{url:`${apex}/widgets`}),value=>value?.url?.startsWith(origin));
      openings.push({rep,kind:'apex_to_www',stages:await diagnosticStages(session,'navigate',apexSince),timeline:'shared.get 未公开 operationTimeline'});
      await isolated('iframe_click',()=>task.act('ref_click',ref),value=>!value?.error,
        async()=>{ref=await target(task,'框架按钮',['button']);});
      await isolated('shadow_click',()=>task.act('ref_click',ref),value=>!value?.error,
        async()=>{ref=await target(task,'影子按钮',['button']);});
    }
  } finally {await session?.close?.();await new Promise(resolve=>server.close(resolve));}
  const output={kind:'mechanical',version:1,label,browser,cursor,reps,started,finished:new Date().toISOString(),metrics:summarize(samples),openings,promptOccupancy:await promptSize()};
  await mkdir(path.join(root,'bench/results'),{recursive:true});const stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');const base=path.join(root,'bench/results',`${label}-${stamp}`);
  await writeFile(base+'.json',JSON.stringify(output,null,2)+'\n');
  const lines=[`# 机械基准：${label}`,'',`浏览器：${browser}；轮数：${reps}`,'','| 指标 | 成功/次数 | p50 ms | p90 ms | max ms | 错误码 |','|---|---:|---:|---:|---:|---|'];
  for(const [name,m] of Object.entries(output.metrics))lines.push(`| ${name} | ${m.successes}/${m.attempts} | ${m.p50Ms??'未拿到'} | ${m.p90Ms??'未拿到'} | ${m.maxMs??'未拿到'} | ${JSON.stringify(m.errorCodes)} |`);
  lines.push('',`提示词字符：${output.promptOccupancy.totalCharacters}；粗估 token：${output.promptOccupancy.estimatedTokens}`,'','开页阶段详情见同名 JSON；缺失阶段标“未拿到”。');await writeFile(base+'.md',lines.join('\n')+'\n');console.log(base+'.json');
}
await run();
