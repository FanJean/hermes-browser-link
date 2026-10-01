// 中文注释：临时 Chrome/Edge 经 Native Messaging 验证两档模式的关闭与弹窗停止清理。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openRealSession} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';

const browser=process.argv.includes('--edge')?'edge':'chrome';
const site=createServer((_request,response)=>{
 response.setHeader('Content-Type','text/html; charset=utf-8');
 response.end('<!doctype html><title>清理回归</title><input id="entry" aria-label="内容"><button id="save" onclick="document.body.dataset.saved=document.querySelector(\'#entry\').value">保存</button>');
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${site.address().port}`;
let session;
try{
 session=await openRealSession({browser,label:'cleanup-'});
 await session.enableFullAccess();
 const results=[];
 for(const mode of ['full','smart']){
  if(mode==='smart'){
   await session.clickPopup('#access-toggle');
   await waitFor(()=>session.ui.evaluate(`document.querySelector('#access-toggle').getAttribute('aria-checked')==='false'`));
  }
  for(const ending of ['close','cancel','stop']){
   const owner=`cleanup-${mode}-${ending}`;
   const instance=await session.instance();
   const created=await session.rpc(owner,'create',{title:`清理 ${mode} ${ending}`,instance_id:instance.instanceId,allowed_origins:[origin]});
   const task=await waitFor(async()=>{
    const value=await session.rpc(owner,'get',{task_id:created.id});
    return value.state==='ready'&&value.activeMode===mode?value:null;
   },30000);
   const run=(action,requestId,params={})=>session.rpc(owner,'run',{task_id:task.id,request_id:requestId,action,...params});
   const approved=async(action,requestId,params={})=>{
    let result=await run(action,requestId,params);
    if(result.status==='approval_required'){
     await session.approvePanel('approve');
     result=await waitFor(async()=>{
      const value=await run(action,requestId,params);
      // 中文注释：批准线程尚未完成时，同一请求编号只查询结果，不创建第二次动作。
      return value.status==='approval_required'||value.bridgeCode==='request_outcome_unavailable'?null:value;
     },15000);
    }
    assert.equal(result.error,undefined,JSON.stringify(result));
    return result;
   };
   const opened=await approved('new_tab',`${mode}-${ending}-open`,{url:origin+'/'});
   assert.ok(Number.isInteger(opened.tabId),JSON.stringify(opened));
   const tab=await session.ui.evaluate(`chrome.tabs.get(${opened.tabId})`);
   assert.ok(Number.isInteger(tab.groupId)&&tab.groupId>=0);
   await session.ui.evaluate(`chrome.tabs.update(${tab.id},{active:true}).then(()=>true)`);
   await approved('snapshot',`${mode}-${ending}-snapshot`,{tab_id:tab.id});
   await approved('fill',`${mode}-${ending}-fill`,{tab_id:tab.id,selector:'#entry',text:'已填写'});
   await approved('click',`${mode}-${ending}-click`,{tab_id:tab.id,selector:'#save'});
   assert.equal(await session.readPage(tab.id,'document.body.dataset.saved'),'已填写');
   let finished;
   if(ending==='close'||ending==='cancel'){
    finished=await session.rpc(owner,ending,{task_id:task.id});
    assert.equal(finished.state,ending==='close'?'closed':'cancelled');
   }else{
    // 中文注释：保持任务页激活，触发弹窗停止按钮的实际事件处理链。
    await session.ui.evaluate(`chrome.tabs.update(${tab.id},{active:true}).then(()=>chrome.runtime.sendMessage({type:'changed'}))`);
    await waitFor(()=>session.ui.evaluate(`(()=>{const e=document.querySelector('#page-task');return !e.hidden&&e.dataset.taskId===${JSON.stringify(task.id)}&&e.dataset.tabId===${JSON.stringify(String(tab.id))}&&!document.querySelector('#stop-task').disabled})()`),15000);
    await session.ui.evaluate(`document.querySelector('#stop-task').click()`);
    finished=await waitFor(async()=>{
     const value=await session.rpc(owner,'get',{task_id:task.id});
     return value.state==='cancelled'?value:null;
    },15000);
   }
   assert.equal(finished.cleanupState,'succeeded',JSON.stringify(finished));
   assert.equal(finished.cleanupReason,'verified_complete',JSON.stringify(finished));
   await waitFor(()=>session.ui.evaluate(`chrome.tabs.query({}).then(tabs=>!tabs.some(t=>t.id===${tab.id}))`));
   await waitFor(()=>session.ui.evaluate(`chrome.tabGroups.query({}).then(groups=>!groups.some(group=>group.id===${tab.groupId}))`));
   const status=await session.rpc(owner,'close',{task_id:task.id,cleanup_action:'status'});
   assert.equal(status.cleanupState,'succeeded',JSON.stringify(status));
   assert.equal(status.cleanupReason,'verified_complete',JSON.stringify(status));
   results.push({mode,ending,taskId:task.id,tabId:tab.id,groupId:tab.groupId,cleanupState:status.cleanupState,cleanupReason:status.cleanupReason});
  }
 }
 console.log(JSON.stringify({browser,version:session.version.Browser,results}));
}finally{
 await session?.close();
 site.closeAllConnections();
 await new Promise(resolve=>site.close(resolve));
}
