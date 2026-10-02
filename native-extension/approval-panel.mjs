// This page is extension-owned. Its messages are *requests*, not approval
// authority: background must authenticate sender + live host scope/gesture.
const PAGE='approval-panel.html';
const text=(doc,tag,value)=>{const node=doc.createElement(tag);node.textContent=value;return node;};
const FIELD={password:'密码',payment:'支付信息',otp:'验证码',sensitive:'敏感信息'};
function safeView(v){
 if(!v||typeof v.id!=='string'||!v.id||v.id.length>128||
  (v.kind!==undefined&&v.kind!=='cookie_mirror'&&!(v.kind==='manual_input'&&Object.hasOwn(FIELD,v.fieldKind)))||
  // 中文注释：调试命令说明可包含方法名、持久注入提示与其他子框架来源。
  !['taskTitle','action','scope'].every(k=>typeof v[k]==='string'&&v[k].length>0&&v[k].length<=(k==='action'?512:256))||
  !Number.isFinite(v.expiresAt)||v.expiresAt<=Date.now())return false;
 try{const url=new URL(v.origin),read=v.readOrigin===undefined?null:new URL(v.readOrigin);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.origin===v.origin
  &&(!read||['http:','https:'].includes(read.protocol)&&!read.username&&!read.password&&read.origin===v.readOrigin);}catch{return false;}
}

export async function mountApprovalPanel({document:doc=globalThis.document,chrome=globalThis.chrome}={}){
 if(doc.location.href!==chrome.runtime.getURL(PAGE))throw Error('untrusted extension origin');
 const root=doc.getElementById('app');if(!root)throw Error('missing panel root');
 root.replaceChildren(text(doc,'h1','正在读取批准请求…'));
 let response;
 try{response=await chrome.runtime.sendMessage({type:'approval_panel_view'});}catch{}
 const view=response?.result;
 if(!safeView(view)){root.replaceChildren(text(doc,'p','请求已失效或无法核实，请在扩展中查看。'));return;}
 // 中文注释：面板只展示数量和来源，Cookie 值永不进入 UI 消息。
 if(view.kind==='cookie_mirror'){
  if(!Array.isArray(view.sites)||!view.sites.length||!Number.isInteger(view.count)||!view.source||!view.target){root.replaceChildren(text(doc,'p','镜像请求无效'));return;}
  const label=b=>`${b.browser} · ${b.instanceId.slice(0,8)}`;
  const status=text(doc,'p','将复制登录态到目标浏览器。即使全部访问，也需要本次确认。');
  root.replaceChildren(text(doc,'h1','确认 Cookie 镜像'),text(doc,'p',`源浏览器：${label(view.source)}`),text(doc,'p',`目标浏览器：${label(view.target)}`),status,
   ...view.sites.map(row=>text(doc,'p',`${row.site}：${row.count} 个 Cookie`)),text(doc,'p',`共 ${view.count} 个 Cookie；仅默认 store，不处理隐身窗口。`),
   text(doc,'p',view.options.clearTarget?'导入前清除目标站点旧 Cookie':'保留目标站点其他 Cookie'),
   text(doc,'p',view.options.persistDays?`会话 Cookie 保存 ${view.options.persistDays} 天`:'保留会话 Cookie；目标浏览器重启后可能丢失。'),
   text(doc,'p',`确认有效期至：${new Date(view.expiresAt).toLocaleTimeString('zh-CN')}`));
  mountDecisions(doc,chrome,root,view,status,[['确认复制登录态','approve'],['拒绝','reject'],['稍后','later']]);return;
 }
 const manual=view.kind==='manual_input';
 if(manual){
  const heading=text(doc,'h1',`请你亲自填写${FIELD[view.fieldKind]}`);
  const status=text(doc,'p','为保护你的信息，Hermes 不会代填这个字段，也看不到你填写的内容。');status.setAttribute?.('role','status');
  root.replaceChildren(heading,text(doc,'p',`任务：${view.taskTitle}`),text(doc,'p',`网站：${view.origin}`),
   text(doc,'p','请切到该网页，在对应输入框中填写，然后回到这里点“我已填写”。'),status);
  mountDecisions(doc,chrome,root,view,status,[['我已填写','approve'],['不填写','reject'],['稍后','later']]);
  return;
 }
 const heading=text(doc,'h1','等待批准');const status=text(doc,'p','请选择是否允许这一次操作。');status.setAttribute?.('role','status');
 root.replaceChildren(heading,text(doc,'p',`任务：${view.taskTitle}`),text(doc,'p',`网站：${view.origin}`),text(doc,'p',`动作：${view.action}`),
  ...(view.readOrigin?[text(doc,'p',`允许读取的网站：${view.readOrigin}`),text(doc,'p','批准后将允许读取该网站页面内容；写入和调试命令仍逐项询问。')]:[]),
  text(doc,'p',`范围：${view.scope}`),text(doc,'p',`有效期至：${new Date(view.expiresAt).toLocaleString('zh-CN')}`),status);
 mountDecisions(doc,chrome,root,view,status,[['批准本次','approve'],['拒绝','reject'],['稍后','later']]);
}

function mountDecisions(doc,chrome,root,view,status,choices){
 const actions=[];let busy=false;
 for(const [label,decision] of choices){
  const button=text(doc,'button',label);button.type='button';button.dataset.decision=decision;
  if(decision==='approve')button.className='primary';
  button.addEventListener('click',async event=>{
   if(!event.isTrusted||busy||!button.isConnected&&'isConnected' in button)return;
   busy=true;for(const b of actions)b.disabled=true;status.textContent='正在核实决定…';
   try{
    const reply=await chrome.runtime.sendMessage({type:'approval_panel_decision',requestId:view.id,decision});
    if(reply?.error||reply?.result?.requestId!==view.id||reply.result.decision!==decision)throw Error('unverified');
    status.textContent=decision==='later'?'已稍后处理；任务仍在等待。':'决定已发送；请查看任务状态。';
   }catch{status.textContent='结果待核查，请在扩展中查看，不要重复操作。';}
  });
  actions.push(button);root.append(button);
 }
 actions[0].focus();
}
if(typeof document!=='undefined'&&typeof chrome!=='undefined')void mountApprovalPanel().catch(()=>{});
