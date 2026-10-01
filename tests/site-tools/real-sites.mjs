// 中文注释：使用现有隔离启动器验证真实 Chrome/Edge、打包产物、Python helper 与网站工具完整链路。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CdpClient,waitFor} from '../native-v2/cdp-client.mjs';
import {openRealSession,openTask,helperCall,root} from '../native-v2/real-session.mjs';
const exec=promisify(execFile),hits=[];
const server=createServer((req,res)=>{
 // 中文注释：未授权子框架只包含本机合成数据，用于原始 CDP 范围反例。
 if(req.url==='/framed'){res.setHeader('Content-Type','text/html');res.end(`<iframe src="${outsideOrigin}/"></iframe>`);return;}
 if(req.url==='/'||req.url==='/next'){res.setHeader('Set-Cookie','fixture_login=present; HttpOnly; SameSite=Strict; Path=/');res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Tools fixture</title><h1>工具测试</h1>');return;}
 hits.push(req.url);
 if(req.url==='/redirect'){res.writeHead(302,{Location:'/escaped'});res.end();return;}
 res.setHeader('Content-Type','application/json');
 if(req.url==='/unauthorized'){res.writeHead(401);res.end('{}');return;}
 res.end(JSON.stringify({rows:req.url==='/empty'?[]:[{id:1,title:'中文测试',token:'PRIVATE'}],authenticated:req.headers.cookie?.includes('fixture_login=present')===true,padding:req.url==='/large'?'x'.repeat(140000):'x'.repeat(600)}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
// 中文注释：未授权来源只包含本地合成文本，用来证明旧网关不能越过任务范围。
const outside=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<p>OUTSIDE_TASK_FIXTURE</p>');});
await new Promise(r=>outside.listen(0,'127.0.0.1',r));
const outsideOrigin=`http://127.0.0.1:${outside.address().port}`;
const requested=process.argv.find(v=>v.startsWith('--browser='))?.split('=')[1]??'all';
const browsers=requested==='all'?['chrome','edge']:[requested];
try{for(const browser of browsers){
 const session=await openRealSession({browser,packageMode:true,label:'st'});
 let gateway,freshGateway;
 try{
  await session.enableFullAccess();
  const task=await openTask(session,{origins:[origin],url:origin+'/',title:'网站工具验收'});
  const script=async code=>{
   const receipt=await helperCall('script',session.work,task.owner,task.task.id,code);
   assert.equal(receipt.exit_code,0,JSON.stringify(receipt));assert.equal(receipt.stdout_truncated,false);assert.equal(receipt.execution_complete,true,JSON.stringify(receipt));return JSON.parse(receipt.stdout);
  };
  const capture=await script('import json\nprint(json.dumps(network_start()))');
  const navigated=await script(`import json\ngoto_url(${JSON.stringify(origin+'/next')})\nprint(json.dumps(network_list(${JSON.stringify(capture.captureId)})))`);
  assert.equal(navigated.captureId,capture.captureId);assert.ok(navigated.entries.some(e=>e.url===origin+'/next'),JSON.stringify(navigated));
  const read=await script("import json\nprint(json.dumps(page_request('/api', fields=['rows','authenticated'])))");
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.data.authenticated,true);assert.equal(read.data.rows[0].token,'[REDACTED]');
  const list=await script(`import json,time\ntime.sleep(0.15)\nprint(json.dumps(network_list(${JSON.stringify(capture.captureId)})))`);
  const entry=list.entries.find(e=>e.url===origin+'/api');assert.ok(entry,JSON.stringify(list));assert.equal(entry.completed,true);
  const detail=await script(`import json\nprint(json.dumps(network_detail(${JSON.stringify(capture.captureId)},${entry.seq},max_chars=200)))`);
  assert.equal(detail.body.withheld,false,JSON.stringify(detail));assert.equal(detail.body.nextStart,200);assert.ok(!detail.body.text.includes('PRIVATE'));
  const rest=await script(`import json\nprint(json.dumps(network_detail(${JSON.stringify(capture.captureId)},${entry.seq},start=200)))`);assert.equal(rest.body.nextStart,null);
  const observed=await script(`import json\nwith expect_response(${JSON.stringify(origin+'/api')}) as observation:\n    page_request('/api',fields=['rows'])\n    network_list(${JSON.stringify(capture.captureId)})\nprint(json.dumps(observation.result))`);
  assert.equal(observed.status,200);
  for(const [url,code] of [['/redirect','fetch_failed'],['/large','response_too_large'],['/unauthorized','http_error'],['https://example.com/','origin_denied']]){
   const result=await script(`import json\nprint(json.dumps(page_request(${JSON.stringify(url)},fields=['rows'])))`);assert.equal(result.code,code,JSON.stringify(result));
  }
  assert.ok(!hits.includes('/escaped'));
  const invoke=async(name,args)=>JSON.parse((await exec(process.env.HERMES_PYTHON||'python3',[path.join(root,'tests/site-tools/real-helper.py'),session.work,task.owner,task.task.id,name,JSON.stringify(args)],{cwd:root,timeout:60000,maxBuffer:1024*1024})).stdout);
  const definition={site:'fixture',name:'rows',description:'按路径读取列表',origins:[origin],access:'read',args_schema:{type:'object',properties:{path:{type:'string'}},required:['path']},result_schema:{type:'object',properties:{rows:{type:'array',items:{type:'object',properties:{id:{type:'integer'},title:{type:'string'},token:{type:'string'}}},maxItems:10}},required:['rows']},code:"def run(args):\n    # 中文注释：复用页面读取，返回业务值。\n    return page_request(args['path'], fields=['rows'])['data']"};
  const draft=await invoke('browser_site_manage',{action:'define',definition});assert.equal(draft.ok,true,JSON.stringify(draft));
  const trial=await invoke('browser_site_manage',{action:'try',draft_id:draft.draft_id,args:{path:'/api'},checks:[{path:'rows',min_items:1}]});assert.equal(trial.verification?.passed,true,JSON.stringify(trial));
  const empty=await invoke('browser_site_manage',{action:'try',draft_id:draft.draft_id,args:{path:'/empty'},checks:[{path:'rows',equals:[]}]});assert.equal(empty.verification?.passed,true,JSON.stringify(empty));
  assert.equal((await invoke('browser_site_manage',{action:'activate',draft_id:draft.draft_id})).ok,true);
  assert.equal((await invoke('browser_site_search',{query:'列表'})).tools.length,1);
  assert.equal((await invoke('browser_site_run',{site:'fixture',name:'rows',args:{path:'/api'}})).result.rows[0].title,'中文测试');
  const refs=await invoke('browser_shared_reference',{instance_id:task.instance.instanceId});assert.ok(refs.helpers.some(h=>h.name==='network_start'),JSON.stringify(refs));
  await script('import json\nprint(json.dumps(network_stop()))');
  // 中文注释：真实浏览器中结果序列化超时必须释放执行器；原表达式只能执行一次。
  const serialization=await task.run('js.evaluate',{world:'main',timeout_ms:100,expression:'globalThis.auditSerializationCount=(globalThis.auditSerializationCount||0)+1;({toJSON(){while(true){}}})'});
  assert.equal(serialization.bridgeCode,'js_timeout',JSON.stringify(serialization));
  assert.equal(serialization.outcome_unknown,true,JSON.stringify(serialization));
  const once=await task.run('js.evaluate',{world:'main',expression:'globalThis.auditSerializationCount'});
  assert.equal(once.value,1,JSON.stringify(once));
  const persistent=await task.run('cdp.send',{method:'Page.addScriptToEvaluateOnNewDocument',cdp_params:{source:'globalThis.auditPersistent=true'}});
  assert.equal(typeof persistent.identifier,'string',JSON.stringify(persistent));
  const foreignTarget=await task.run('cdp.send',{method:'Runtime.evaluate',target_id:'foreign-target',cdp_params:{expression:'1'}});
  assert.equal(foreignTarget.bridgeCode,'target_not_owned',JSON.stringify(foreignTarget));
  await task.run('navigate',{url:origin+'/framed'});
  await waitFor(()=>session.readPage(task.tabId,'document.querySelector("iframe")?.contentWindow!==null'));
  const childScope=await task.run('cdp.send',{method:'Runtime.evaluate',cdp_params:{expression:'document.body.innerText',returnByValue:true}});
  assert.ok(childScope.result,JSON.stringify(childScope));
  await task.run('navigate',{url:origin+'/'});
  const gatewayInfo=await invoke('fixture_gateway',{});
  gateway=new CdpClient(gatewayInfo.wsUrl);await gateway.connect();
  const targets=await gateway.call('Target.getTargets');const target=targets.targetInfos.find(t=>t.type==='page');assert.ok(target);
  const attached=await gateway.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  assert.equal((await gateway.call('Runtime.evaluate',{expression:'document.title',returnByValue:true},attached.sessionId)).result.value,'Tools fixture');
  await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(outsideOrigin+'/')}}).then(()=>true)`);
  await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.url===${JSON.stringify(outsideOrigin+'/')}&&t.status==='complete')`));
  const blocked=await task.run('snapshot');assert.equal(blocked.bridgeCode,'tab_out_of_scope',JSON.stringify(blocked));
  await assert.rejects(async()=>gateway.call('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true},attached.sessionId));
  // 中文注释：导航回允许网站后，旧会话仍不可用；重新建立的网关正常工作。
  await session.ui.evaluate(`chrome.tabs.update(${task.tabId},{url:${JSON.stringify(origin+'/')}}).then(()=>true)`);
  await waitFor(()=>session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.url===${JSON.stringify(origin+'/')}&&t.status==='complete')`));
  await assert.rejects(async()=>gateway.call('Runtime.evaluate',{expression:'1',returnByValue:true},attached.sessionId));
  freshGateway=new CdpClient((await invoke('fixture_gateway',{})).wsUrl);await freshGateway.connect();
  const freshTargets=await freshGateway.call('Target.getTargets');const current=freshTargets.targetInfos.find(t=>t.type==='page');assert.ok(current);
  const freshSession=await freshGateway.call('Target.attachToTarget',{targetId:current.targetId,flatten:true});
  assert.equal((await freshGateway.call('Runtime.evaluate',{expression:'document.title',returnByValue:true},freshSession.sessionId)).result.value,'Tools fixture');
  await session.rpc(task.owner,'cancel',{task_id:task.task.id});
  const denied=await invoke('browser_site_run',{site:'fixture',name:'rows',args:{path:'/api'}});assert.equal(denied.ok,false);assert.equal(denied.code,'binding_missing');
  const report={browser,version:session.version.Browser,at:new Date().toISOString(),package:true,passed:['HttpOnly登录态读取','同源导航保留网络捕获','离站废弃旧CDP网关','返回授权网站后新网关可用','摘要和详情跨脚本调用','正文分页与字段过滤','网络查询不消费响应等待事件','跨源和重定向拒绝','超大响应和401','草稿真实试运行','空结果验证','启用搜索和重复调用','在线能力文档','取消后拒绝执行','序列化超时释放且不重放','持久脚本注册允许且外部目标仍核实任务归属','第三方子框架不阻断原始CDP']};
  await mkdir(path.join(import.meta.dirname,'evidence'),{recursive:true});await writeFile(path.join(import.meta.dirname,`evidence/${browser}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){console.error('测试弹窗:',await session.ui.evaluate('document.body.innerText'));throw error;}finally{gateway?.close();freshGateway?.close();await session.close();}
}}finally{server.close();outside.close();}
