// 中文注释：手动验收脚本。real-session 使用临时配置加载源码扩展；本文件不进入离线测试清单。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {openRealSession,openTask} from '../native-v2/real-session.mjs';

const fixture=await readFile(new URL('./fixture.html',import.meta.url),'utf8');
const server=createServer((request,response)=>{
 response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 // 中文注释：跨源负例也由本地 fixture 提供，禁止浏览器向外网发起页面请求。
 response.end(request.url==='/frame'?'<button aria-label="框架按钮">框架按钮</button>':fixture.replace('https://cross-origin.example.test/',`http://cross.localhost:${server.address().port}/frame`));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let session;
try{
 session=await openRealSession({browser:process.argv.includes('--edge')?'edge':'chrome',label:'complex-ui'});
 await session.enableFullAccess();
 const tab=await openTask(session,{owner:'complex-ui',origins:[origin],url:origin+'/',title:'复杂界面'});
 const run=async(action,params={})=>{const result=await tab.run(action,params);assert.equal(result?.error,undefined,JSON.stringify(result));return result;};
 const ref=async(name,roles)=>{
  const page=await run('semantic_snapshot',{options:{mode:'interactive',query:name,roles,budget:5000,composed:true}});
  const item=page.items.find(value=>value.name===name);assert.ok(item,name);
  return {binding:page.binding,snapshot_id:page.snapshotId,ref:item.ref};
 };
 await tab.read(`document.querySelector('#inner').src='/frame'`);
 // 中文注释：等待本地同源框架加载，避免拿导航中的旧框架做快照。
 await tab.read(`new Promise(resolve=>{const f=document.querySelector('#inner');if(f.contentDocument?.querySelector('button'))resolve(true);else f.addEventListener('load',()=>resolve(true),{once:true})})`);
 await tab.read(`(()=>{const outer=document.querySelector('#component').attachShadow({mode:'open'});outer.innerHTML='<button aria-label="影子按钮">影子按钮</button><input aria-label="影子输入">';outer.querySelector('button').onclick=e=>e.target.setAttribute('aria-pressed','true');return true})()`);
 await tab.read(`(()=>{const combo=document.querySelector('#combo'),option=document.querySelector('#options [role=option]');combo.onclick=()=>combo.setAttribute('aria-expanded','true');option.onclick=()=>option.setAttribute('aria-selected','true');return true})()`);
 // 中文注释：夹具点击产生可见状态，回归点击交付与效果观察。
 await tab.read(`document.querySelector('#pointer').onclick=e=>e.currentTarget.textContent='已点击';document.querySelector('#save').onclick=e=>e.currentTarget.setAttribute('aria-pressed','true')`);
 const shadow=await ref('影子按钮',['button']);await run('ref_click',shadow);
 await run('ref_fill',{...await ref('影子输入',['textbox']),text:'测试'});
 const frame=await run('frame_catalog');assert.ok(frame.frames?.length);
 await run('ref_click',await ref('框架按钮',['button']));
 await run('ref_click',await ref('推断点击',['button']));
 await run('ref_select_option',{...await ref('地区',['combobox']),by:'value',values:['cn']});
 await run('ref_fill',{...await ref('受控输入',['textbox']),text:'受控内容'});
 await run('ref_fill',{...await ref('正文',['textbox']),text:'富文本内容'});
 const table=await run('semantic_snapshot',{options:{mode:'table',budget:5000}});assert.ok(table.items.some(item=>item.cells?.includes('示例')));
 await run('ref_click',await ref('更多信息',['button']));
 const canvas=await run('semantic_snapshot',{options:{mode:'interactive',budget:5000}});assert.equal(canvas.coverage.unsupportedCanvas,1);
 const save=await ref('保存',['button']);
 await tab.read(`document.querySelector('#save').outerHTML='<button id="save">保存</button>'`);
 const relocated=await run('ref_click',save);assert.equal(relocated.relocated,true);
 // 中文注释：固定遮罩覆盖按钮时只检查拒绝回执，不触发关闭按钮。
 await tab.read(`(()=>{const mask=document.createElement('div');mask.id='acceptance-mask';mask.setAttribute('role','dialog');mask.setAttribute('aria-label','验收遮挡层');mask.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.1)';const close=document.createElement('button');close.textContent='关闭遮挡层';close.onclick=()=>mask.remove();mask.append(close);document.body.append(mask);return true})()`);
 const covered=await tab.run('ref_click',await ref('保存',['button']));
 assert.equal(covered.code,'target_occluded',JSON.stringify(covered));
 assert.equal(covered.obstruction?.role,'dialog');
 assert.equal(covered.obstruction?.closeButton?.role,'button');
 console.log('复杂界面真实浏览器验收通过');
}finally{
 await session?.close?.();
 await new Promise(resolve=>server.close(resolve));
}
