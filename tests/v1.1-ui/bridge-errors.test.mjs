import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../../native-extension/bridge.mjs';
const cases=[
 ['SCREENSHOT_EXPIRED','screenshot_expired'],['STALE_SCREENSHOT','stale_screenshot'],['UNKNOWN_SCREENSHOT','stale_screenshot'],
 ['CAPTURE_CHANGED','document_changed'],['NODE_MOVED','target_unstable'],['TARGET_OCCLUDED','target_occluded'],
 ['SENSITIVE_TARGET','sensitive_target'],['INVALID_NODE_REF','stale_reference']
];
function wire(action,error){let receiver;const sent=[];const port={onMessage:{addListener:f=>receiver=f},postMessage:m=>sent.push(m)};
 const executor={diagnostics:{recordSafely(){}},diagnosticConnection:'test',execute:async()=>{throw Object.assign(Error(error),{code:error});}};
 const bridge=new Bridge(port,executor);receiver({id:'req',method:'browser.execute',params:{action,taskId:'task-A'}});return new Promise(resolve=>setImmediate(()=>resolve(sent[0])));
}
for(const [error,expected] of cases)test(`interaction error ${error} keeps actionable category`,async()=>{
 const result=await wire('interaction.bounds',error);assert.equal(result.error.code,expected);
 assert.equal(result.error.data.outcomeUnknown,false,'read-only bounds never becomes unknown write');
});
test('interaction.capture and bounds are read-only; click and drag remain uncertain only if dispatched',async()=>{
 for(const action of ['interaction.capture','interaction.bounds'])assert.equal((await wire(action,'STALE_SCREENSHOT')).error.data.outcomeUnknown,false);
 for(const action of ['interaction.click','interaction.drag_coordinates','interaction.drag_elements'])assert.equal((await wire(action,'ADAPTER_DETACHED')).error.data.outcomeUnknown,true);
});
test('高亮阶段错误提供固定诊断码且不泄露异常文本',async()=>{
 // 错误码只用于定位扩展内部阶段，点击结果仍保持不确定。
 for(const [reason,expected] of [
  ['INTERACTION_HIGHLIGHT_FRAME_TIMEOUT','interaction_highlight_frame_timeout'],
  ['overlay injection failed','overlay_injection_failed'],
 ]){
  const result=await wire('click',reason);
  assert.equal(result.error.code,expected);
  assert.equal(result.error.data.outcomeUnknown,true);
  assert.doesNotMatch(result.error.message,/INTERACTION_HIGHLIGHT|overlay injection failed/);
 }
});
test('离开授权网站的工作页返回固定错误码，且属于未派发', async()=>{
 let receiver;const sent=[];const port={onMessage:{addListener:f=>receiver=f},postMessage:m=>sent.push(m)};
 const executor={diagnostics:{recordSafely(){}},diagnosticConnection:'test',execute:async()=>{throw Object.assign(Error('TAB_OUT_OF_SCOPE'),{preDispatch:true});}};
 new Bridge(port,executor);receiver({id:'req',method:'browser.execute',params:{action:'ref_click',taskId:'task-A'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent[0].error.code,'tab_out_of_scope');assert.equal(sent[0].error.data.outcomeUnknown,false);
});
test('文件上传前置拒绝给出固定原因且不标成未知写入',async()=>{
 // 中文注释：路径与页面目标错误都发生在 DOM.setFileInputFiles 派发之前。
 for(const [reason,code] of [['ARTIFACT_PATH_DENIED','artifact_path_denied'],['ARTIFACT_ORIGIN_DENIED','artifact_origin_denied'],
  ['FILE_INPUT_NOT_UNIQUE','file_input_not_unique'],['NOT_FILE_INPUT','not_file_input']]){
  const result=await wire('files.upload',reason);
  assert.equal(result.error.code,code);
  assert.equal(result.error.data.outcomeUnknown,false);
  assert.doesNotMatch(result.error.message,/ARTIFACT|FILE_INPUT/);
 }
});
// 中文注释：滚动会改变页面并触发网站监听器，派发后不能按只读错误建议重试。
test('滚动结果未知时不宣称无副作用或可重试',async()=>{
 const result=await wire('scroll','DOCUMENT_CHANGED');
 assert.equal(result.error.data.outcomeUnknown,true);assert.equal(result.error.data.retryable,false);
});
// 中文注释：截图超时返回固定原因，无图片回执且不自动重试。
test('截图超时保留固定错误码和只读未知边界',async()=>{
 const result=await wire('screenshot','SCREENSHOT_TIMEOUT');assert.equal(result.error.code,'screenshot_timeout');assert.match(result.error.message,/截图超时/);
 assert.equal(result.error.data.outcomeUnknown,false);assert.equal(result.error.data.retryable,false);
});
test('截图遮罩失败与目标缺失使用具体码且候选不含字段值',async()=>{
 // 中文注释：扩展错误只透传受限语义候选，不透传页面异常原文。
 for(const [reason,code] of [['CAPTURE_SENSITIVE_BLOCKED','capture_sensitive_blocked'],
  ['CAPTURE_FRAME_UNINSPECTABLE','capture_frame_uninspectable']]){
  const result=await wire('screenshot',reason);
  assert.equal(result.error.code,code);assert.equal(result.error.data.outcomeUnknown,false);
 }
 const result=await wire('screenshot','SCREENSHOT_TARGET_MISSING|%5B%7B%22role%22%3A%22button%22%2C%22name%22%3A%22Submit%22%2C%22value%22%3A%22SECRET%22%7D%5D');
 assert.equal(result.error.code,'element_timeout');
 assert.deepEqual(result.error.data.candidates,[{role:'button',name:'Submit'}]);
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});
test('解析类读取的页面脚本异常归为解析出错，不回传异常正文；写入动作不改分类',async()=>{
 const canary="TypeError: Cannot read properties of null (reading 'secret-page-text')";
 for(const action of ['semantic_snapshot','page.parse']){
  const result=await wire(action,canary);
  assert.equal(result.error.code,'page_script_error');
  assert.doesNotMatch(JSON.stringify(result),/secret-page-text/);
 }
 assert.equal((await wire('ref_click',canary)).error.code,'execution_denied');
 assert.equal((await wire('semantic_snapshot','document changed')).error.code,'document_changed');
});
