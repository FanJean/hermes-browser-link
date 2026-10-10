// 中文注释：只配置临时扩展实例；保留原 background/daemon、遮罩和人工审批链路。
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export async function oauthFixtureMode({bridge,executor,message}){
 if(!['smart','full'].includes(message.mode))throw Error('invalid fixture mode');
 const task=(await bridge.request('extension.tasks')).find(task=>task.id===message.taskId);
 const local=executor.tasks.get(message.taskId);
 if(!task||task.state!=='ready'||!local||local.revoked||local.generation!==task.generation||local.policy.modeGeneration!==task.modeGeneration)throw Error('fixture task scope changed');
 let current=task;
 if(task.activeMode!==message.mode){
  current=await bridge.request('extension.mode',{taskId:task.id,generation:task.generation,modeGeneration:task.modeGeneration,mode:message.mode});
  executor.setMode(current);
 }
 if(local.policy.activeMode!==current.activeMode||local.policy.modeGeneration!==current.modeGeneration)throw Error('fixture mode readback mismatch');
 return {taskId:current.id,generation:current.generation,activeMode:current.activeMode,modeGeneration:current.modeGeneration};
}

export async function configureOAuthFixture(extensionRoot,providers){
 if(!Array.isArray(providers)||!providers.length||!providers.every(row=>{
  const url=new URL(row.origin);
  return ['http:','https:'].includes(url.protocol)&&row.origin===url.origin&&!url.username&&!url.password&&
   (['localhost','127.0.0.1'].includes(url.hostname)||url.hostname.endsWith('.localhost'));
 }))throw Error('OAuth fixture providers must be local origins');
 if(!providers.every(row=>Array.isArray(row.paths)&&row.paths.length&&row.paths.every(value=>typeof value==='string'&&value.startsWith('/'))))throw Error('OAuth fixture needs exact authorization paths');
 const file=path.join(extensionRoot,'background.mjs'),source=await readFile(file,'utf8');
 const constructor='onPopupAdopt:async p=>',route=' await consentLoaded;\n';
 if(source.split(constructor).length!==2||source.split(route).length!==2)throw Error('fixture background anchors changed');
 const receipt="await current.request('extension.popup_adopted',p);";
 if(source.split(receipt).length!==2)throw Error('fixture adoption receipt anchor changed');
 const configured=source.replace('const executor=new Executor(', 'const oauthFixtureReceipts=[];\nconst executor=new Executor(')
  .replace(constructor,`oauthProviders:${JSON.stringify(providers)},${constructor}`)
  .replace(receipt,`await current.request('extension.popup_adopted',p).then(result=>{oauthFixtureReceipts.push({at:Date.now(),taskId:p.taskId,tabId:p.popupScope.candidate.tabId,result});},error=>{oauthFixtureReceipts.push({at:Date.now(),taskId:p.taskId,tabId:p.popupScope.candidate.tabId,error:{message:error.message,code:error.code}});throw error;}).finally(()=>{if(oauthFixtureReceipts.length>128)oauthFixtureReceipts.shift();});`)
  .replace(route,`${route} if(m.type==='oauth_fixture_mode')return (${oauthFixtureMode.toString()})({bridge,executor,message:m});\n if(m.type==='oauth_fixture_diagnostics')return (${oauthFixtureDiagnostics.toString()})({api:chrome,executor,receipts:oauthFixtureReceipts,taskId:m.taskId,connected});\n`);
 await writeFile(file,configured);
 // 中文注释：临时配置后重算构建身份，不能以未修改前的哈希标记测试扩展。
 const entries=[];
 async function visit(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name);
   if(entry.isDirectory())await visit(file);
   else if(entry.isFile()){
    const relative=path.relative(extensionRoot,file).split(path.sep).join('/');
    if(!['BUILD-DEPS.json','build-id.mjs'].includes(relative))entries.push(`${relative}\0${createHash('sha256').update(await readFile(file)).digest('hex')}`);
   }
  }
 }
 await visit(extensionRoot);
 const buildId=createHash('sha256').update(entries.sort().join('\n')).digest('hex');
 const manifestFile=path.join(extensionRoot,'BUILD-DEPS.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 manifest.buildId=buildId;await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 await writeFile(path.join(extensionRoot,'build-id.mjs'),`// 中文注释：临时 OAuth 验收配置的构建身份。\nexport const BUILD_ID='${buildId}';\n`);
 return {buildId,providers};
}

export async function oauthFixtureDiagnostics({api,executor,receipts,taskId,connected}){
 const task=executor.tasks.get(taskId);
 const rows=[...(task?.popupDiscoveries?.values()||[])];
 const ids=new Set([...(task?.tabIds||[]),...rows.map(row=>row.tabId)]);
 const tabs=await Promise.all([...ids].map(async id=>{
  try{const tab=await api.tabs.get(id);return {tabId:id,url:tab.url,pendingUrl:tab.pendingUrl,status:tab.status};}
  catch(error){return {tabId:id,error:error.message};}
 }));
 return {at:Date.now(),connected,tabs,receipts:receipts.filter(row=>row.taskId===taskId),
  candidates:rows.map(row=>({candidateRef:row.candidateRef,tabId:row.tabId,candidate:row.candidate,adoption:row.adoption,automaticBlocked:row.automaticBlocked,working:!!row.autoWork}))};
}

export async function oauthReturnReadDiagnostics({receipt,request,readTask,readTab}){
 const diagnostic={request,receipt:structuredClone(receipt),bindingDocumentId:receipt.binding?.documentId,
  itemsSummary:{count:receipt.items?.length,firstItems:receipt.items?.slice(0,8).map(({ref,role,name})=>({ref,role,name}))}};
 try{
  const task=await readTask(),operation=task.currentOperation;
  diagnostic.operation=operation;
  // 中文注释：只用本次请求哈希关联实际执行标签；旧快照或预期 returnedTo 不能充当执行证据。
  if(operation?.requestIdHash!==createHash('sha256').update(request.requestId).digest('hex'))throw Error('return read operation has not been persisted');
  const tab=await readTab(operation.tabId);
  diagnostic.actualRead={tabId:operation.tabId,url:tab.url,pendingUrl:tab.pendingUrl,status:tab.status};
 }catch(error){diagnostic.actualReadError=error.message;}
 return diagnostic;
}
