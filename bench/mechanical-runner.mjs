import assert from 'node:assert/strict';

// 中文注释：保留协议码与诊断码；准备失败和动作失败使用同一份样本结构。
export function failureSample(error, durationMs=0, phase='action') {
 return {durationMs,success:false,code:error.bridgeCode||error.code||error.name||'unknown',phase,
  bridgeCode:error.bridgeCode??null,_diagnostic:{code:error._diagnostic?.code??null}};
}

export async function measureSample(work,verify=()=>true) {
 const start=performance.now();
 try{
  const value=await work();
  if(value?.error)throw Object.assign(Error(value.error),{code:value.code,bridgeCode:value.bridgeCode,_diagnostic:value._diagnostic});
  assert.ok(await verify(value),'measurement verification failed');
  return {value,sample:{durationMs:performance.now()-start,success:true,code:null,ready:value?.ready??null}};
 }catch(error){return {value:null,sample:failureSample(error,performance.now()-start)};}
}

// 中文注释：每项先建独立任务，收尾放在计时之外；一项失败不能阻断下一项。
export async function isolatedSample({create,prepare=async()=>{},work,verify,close}) {
 let task;
 try{
  task=await create();await prepare(task);
  return await measureSample(()=>work(task),verify);
 }catch(error){return {value:null,sample:failureSample(error,0,'prepare')};}
 finally{if(task)await close(task).catch(()=>{});}
}
