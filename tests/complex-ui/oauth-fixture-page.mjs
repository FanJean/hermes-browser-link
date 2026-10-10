// 中文注释：本地 OAuth 页面共享给完整链路和离线 DOM 回归；没有真实账号、密码或外部请求。
const attribute=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
export function oauthSourcePage({origin,loginOrigin,manualOrigin,flow}){
 const link=(site,pathname)=>`${site}${pathname}?flow=${encodeURIComponent(flow)}&source=${encodeURIComponent(origin)}`;
 const button=(name,site,features)=>`<button onclick="${attribute(`window.open(${JSON.stringify(link(site,'/oauth-provider'))},${JSON.stringify(features?'oauth-'+flow+'-'+name:'_blank')}${features?','+JSON.stringify(features):''})`)}">${name}</button>`;
 return `<!doctype html><html lang="zh"><title>只开窗登录验收</title><style>button{display:block;margin:24px;padding:16px}</style><main>
 ${button('只开授权小窗',loginOrigin,'popup,width=430,height=560')}
 ${button('只开同窗授权标签',loginOrigin,'')}
 ${button('只开非白名单小窗',manualOrigin,'popup,width=430,height=560')}
 </main><script>
 window.oauthClickCount=0;
 document.addEventListener('click',event=>{if(event.target.localName==='button')window.oauthClickCount++;});
 addEventListener('message',event=>{
  if(${JSON.stringify([loginOrigin,manualOrigin])}.includes(event.origin)&&event.data?.type==='fixture-oauth-complete'&&event.data.flow===${JSON.stringify(flow)})location.href=${JSON.stringify(origin+'/oauth-done?flow='+encodeURIComponent(flow))};
 });
 </script></html>`;
}
export function oauthProviderPage(){
 return `<!doctype html><html lang="zh"><title>本地模拟身份提供方</title><button id="complete">完成本地授权</button><script>
 const flow=new URLSearchParams(location.search).get('flow'),source=new URLSearchParams(location.search).get('source');
 document.querySelector('#complete').onclick=()=>fetch('/oauth-complete?flow='+encodeURIComponent(flow)).then(response=>{
  if(!response.ok)throw Error('fixture authorization failed');
  opener.postMessage({type:'fixture-oauth-complete',flow},source);window.close();
 });
 </script></html>`;
}
export const OAUTH_DONE_MARKER='OAUTH_CONTINUITY_NEW_DOCUMENT';
export const oauthDonePage=`<!doctype html><html lang="zh"><title>本地授权完成</title><main><p>${OAUTH_DONE_MARKER}</p></main></html>`;
