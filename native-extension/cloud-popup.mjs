// 中文注释：云端界面只读取当前扩展后台，所有授权动作都要求真实本机点击。
const cloudElement=id=>document.getElementById(id);
let cloudState=null,cloudBusy=false,cloudCopiedCode=null;
const cloudDialog=cloudElement('cloud-dialog');
async function cloudCall(message){const response=await chrome.runtime.sendMessage(message);if(!response||response.error||!response.result)throw Error('云端操作未确认，请检查连接状态。');return response.result;}
function cloudRender(){
 const state=cloudState||{},paired=state.paired===true,online=state.online===true;
 const labels={unavailable:'未连接',unpaired:'未配对',pending_pairing:'等待配对',connecting:'连接中',active:online?'已在线':'本地服务断开',offline:'离线',expired:'连接码已过期',revoked:'配对已撤销'};
 cloudElement('cloud-status').textContent=labels[state.state]||'检查中';cloudElement('cloud-status').dataset.online=String(online);
 cloudElement('cloud-detail').textContent=state.error||(paired?(online?'已配对且在线 · 云端任务页可直接读取和操作。':'已配对但未在线 · 恢复连接后才能访问云端任务页。'):'未配对 · 点击生成连接码，在网页端确认配对。');
 cloudElement('cloud-connect').textContent=cloudBusy?'正在处理…':paired?'管理云端连接':'云端连接';cloudElement('cloud-connect').disabled=cloudBusy;
 cloudElement('cloud-dialog-state').textContent=paired?(online?'浏览器已在线，配对完成。':'浏览器已配对，正在恢复连接。'):state.error||'请在网页端核对浏览器。确认配对即允许云端直接读取、点击和填写云端任务页；已有个人标签页不授权。';
 cloudElement('cloud-code-panel').hidden=paired;cloudElement('cloud-code').textContent=state.code||'正在生成';
 const seconds=Math.max(0,Math.ceil(((state.expiresAt||0)-Date.now())/1000));
 cloudElement('cloud-code-expiry').textContent=paired?'':state.code?(seconds>0?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} 后过期`:'连接码已过期，请重新生成。'):'连接码暂不可用。';
 cloudElement('cloud-copy-code').disabled=cloudBusy||!state.code||seconds===0;
 cloudElement('cloud-copy-code').textContent=state.code&&cloudCopiedCode===state.code?'已复制':'复制连接码';
 cloudElement('cloud-open-web').disabled=cloudBusy||!state.site;cloudElement('cloud-regenerate').disabled=cloudBusy;
 cloudElement('cloud-regenerate').textContent=paired?'重新配对':'重新生成连接码';cloudElement('cloud-disconnect').hidden=!paired;cloudElement('cloud-disconnect').disabled=cloudBusy;
}
async function cloudAct(message){if(cloudBusy)return;cloudBusy=true;cloudElement('cloud-error').hidden=true;cloudRender();try{cloudState=await cloudCall(message);}catch(error){cloudElement('cloud-error').textContent=error.message;cloudElement('cloud-error').hidden=false;}finally{cloudBusy=false;cloudRender();}}
cloudElement('cloud-connect').addEventListener('click',event=>{if(!event.isTrusted)return;cloudDialog.showModal();if(!cloudState?.paired)void cloudAct({type:'cloud_connect'});else cloudRender();});
cloudElement('cloud-dialog-close').addEventListener('click',()=>cloudDialog.close());
cloudElement('cloud-open-web').addEventListener('click',event=>{if(event.isTrusted)void cloudCall({type:'cloud_open_web'}).catch(error=>{cloudElement('cloud-error').textContent=error.message;cloudElement('cloud-error').hidden=false;});});
cloudElement('cloud-copy-code').addEventListener('click',async event=>{if(!event.isTrusted||!cloudState?.code)return;const code=cloudState.code;try{await navigator.clipboard.writeText(code);cloudCopiedCode=code;cloudRender();}catch{cloudElement('cloud-error').textContent='无法复制，请选中连接码复制。';cloudElement('cloud-error').hidden=false;}});
cloudElement('cloud-regenerate').addEventListener('click',event=>{if(event.isTrusted)void cloudAct({type:'cloud_connect',replace:cloudState?.paired===true});});
cloudElement('cloud-disconnect').addEventListener('click',event=>{if(event.isTrusted)void cloudAct({type:'cloud_disconnect'});});

// 中文注释：只订阅现有弹窗快照；云端界面不另发本地状态请求。
window.addEventListener('browser-link-status',event=>{if(cloudBusy)return;cloudState=event.detail||{state:'unavailable',online:false,paired:false};cloudRender();});
cloudRender();setInterval(cloudRender,1000);
