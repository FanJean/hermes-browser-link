// 中文注释：1.4.2 真实浏览器验收（手动运行，不进入离线清单）：node tests/v1.4.2/real-forms.mjs [--edge]
import assert from 'node:assert/strict';
import {createBenchServer} from '../../bench/site/server.mjs';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {openRealSession,openTask,helperCall} from '../native-v2/real-session.mjs';

const server=createBenchServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,origin=`http://www.bench.localhost:${port}`;
const results=[];
const check=async(label,fn)=>{
 const started=performance.now();
 try{const detail=await fn();results.push({label,ok:true,ms:Math.round(performance.now()-started),detail});}
 catch(error){results.push({label,ok:false,error:String(error?.message||error).slice(0,400)});}
};
let session;
try{
 session=await openRealSession({browser:process.argv.includes('--edge')?'edge':'chrome',label:'forms142'});
 await session.enableFullAccess();
 const tab=await openTask(session,{owner:'forms142',origins:[origin],url:`${origin}/real-form-cases`,title:'真实表单'});
 const snap=async(query,roles)=>{
  const page=await tab.run('semantic_snapshot',{options:{mode:'interactive',...(query?{query}:{}),...(roles?{roles}:{}),budget:5000}});
  assert.equal(page?.error,undefined,JSON.stringify(page));return page;
 };
 await check('首屏外 input[type=submit] 以 button/Submit 进入快照',async()=>{
  const page=await snap('Submit',['button']);
  const names=page.items.map(item=>item.name);assert.ok(names.includes('Submit'),JSON.stringify(names));assert.ok(names.includes('Image Submit'),JSON.stringify(names));return names;
 });
 await check('同名 Description：只读项带 readonly 标记',async()=>{
  const page=await snap('Description',['textbox']);
  const rows=page.items.filter(item=>item.name==='Description').map(item=>({readonly:!!item.readonly}));
  assert.equal(rows.length,2,JSON.stringify(page.items));assert.equal(rows.filter(row=>row.readonly).length,1);return rows;
 });
 for(const [name,id] of [['Freemium','freemium'],['Paid','external-radio']]){
  await check(`自定义单选 ${name} 可选中`,async()=>{
   const page=await snap(name,['radio']);const item=page.items.find(row=>row.name===name);assert.ok(item,JSON.stringify(page.items));
   const result=await tab.run('ref_set_checked',{binding:page.binding,snapshot_id:page.snapshotId,ref:item.ref,checked:true});
   assert.equal(result?.error,undefined,JSON.stringify(result));
   assert.equal(await tab.read(`document.getElementById(${JSON.stringify(id)}).checked`),true);return result;
  });
 }
 await check('被弹层遮挡的单选仍拒绝',async()=>{
  await tab.read(`(()=>{const d=document.createElement('div');d.id='modal';d.style='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999';document.body.append(d);document.getElementById('freemium').checked=false;return true;})()`);
  const page=await snap('Freemium',['radio']);const item=page.items.find(row=>row.name==='Freemium');
  const result=await tab.run('ref_set_checked',{binding:page.binding,snapshot_id:page.snapshotId,ref:item.ref,checked:true});
  await tab.read(`document.getElementById('modal').remove()`);
  assert.equal(result?.code??result?.error,'target_occluded',JSON.stringify(result));
  assert.equal(await tab.read(`document.getElementById('freemium').checked`),false);return result.code;
 });
 const exportRoot=await realpath(await mkdtemp('/tmp/bl142-export-'));process.env.HERMES_BROWSER_EXPORT_ROOTS=exportRoot;
 const script=async code=>{const value=await helperCall('script',session.work,tab.owner,tab.task.id,code);assert.equal(value?.exit_code,0,(value.stderr||JSON.stringify(value)).slice(-400));return value.stdout.trim();};
 await check('脚本 fill_element：同名只读+可编辑选可编辑，(optional) 后缀可匹配',async()=>{
  const out=await script(`r=fill_element('Description','EDITED');print(r.get('verified'))\nr=fill_element('Tool Description','OPT');print(r.get('verified'))`);
  assert.equal(await tab.read(`document.getElementById('description-editable').value`),'EDITED');
  assert.equal(await tab.read(`document.getElementById('description-readonly').value`),'只读示例');
  assert.equal(await tab.read(`document.getElementById('optional').value`),'OPT');return out;
 });
 await check('脚本 click_element 首屏外 Submit',async()=>{
  await tab.read(`window.scrollTo(0,0);document.querySelector('.wpcf7-submit').onclick=e=>{e.preventDefault();window.__clicked=true;};true`);
  const out=await script(`print(click_element('Submit',role='button'))`);
  assert.equal(await tab.read('window.__clicked===true'),true);return out.slice(0,200);
 });
 await check('脚本截图：隐藏 token 不拦截，密码框被遮罩，存到导出根',async()=>{
  await tab.read(`document.getElementById('visible-password').scrollIntoView({block:'center'})`);
  const target=path.join(exportRoot,'masked.png');
  const out=await script(`print(screenshot(${JSON.stringify(target)}))`);
  assert.equal(out.split('\n').at(-1),target);
  const data=(await readFile(target)).toString('base64');
  const rect=await tab.read(`JSON.stringify((()=>{const r=document.getElementById('visible-password').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight};})())`);
  const pixel=await tab.read(`(async()=>{const r=${rect};const img=new Image();img.src='data:image/png;base64,${data}';await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);return Array.from(x.getImageData(Math.round(r.x*img.width/r.w),Math.round(r.y*img.height/r.h),1,1).data).slice(0,3).join(',');})()`);
  assert.equal(pixel,'32,33,36',`密码框中心像素 ${pixel}`);return {pixel,bytes:data.length};
 });
 await check('脚本截图：导出根外路径被拒绝',async()=>{
  const value=await helperCall('script',session.work,tab.owner,tab.task.id,`screenshot('/tmp/outside-root-142.png')`);
  assert.notEqual(value?.exit_code,0);assert.match(value.stderr||'',/allowed roots/);return 'denied';
 });
 await check('脚本截图对准首屏外元素（selector）',async()=>{
  await tab.read(`window.scrollTo(0,0)`);
  await script(`print(screenshot(${JSON.stringify(path.join(exportRoot,'sel.png'))},selector='.wpcf7-submit'))`);
  const y=await tab.read(`document.querySelector('.wpcf7-submit').getBoundingClientRect().top`);
  assert.ok(y>0&&y<await tab.read('innerHeight'),`selector top ${y}`);return {top:Math.round(y)};
 });
 await check('脚本截图对准首屏外元素（name）',async()=>{
  await tab.read(`window.scrollTo(0,0)`);
  await script(`print(screenshot(${JSON.stringify(path.join(exportRoot,'name.png'))},name='Image Submit'))`);
  // 中文注释：该图片按钮高于视口，只要求与视口相交。
  const r=JSON.parse(await tab.read(`JSON.stringify(document.querySelector('input[type=image]').getBoundingClientRect())`));
  assert.ok(r.bottom>0&&r.top<await tab.read('innerHeight'),`name rect ${JSON.stringify(r)}`);return {top:Math.round(r.top)};
 });
 await check('公共截图回执 masked 含两类且不含值',async()=>{
  await tab.read(`document.getElementById('closed-frame-host').scrollIntoView({block:'end'})`);
  const shot=await tab.run('screenshot');assert.equal(shot?.error,undefined,JSON.stringify(shot).slice(0,300));
  const kinds=(shot.masked||[]).map(row=>row.kind);
  assert.ok(kinds.includes('sensitive_field')&&kinds.includes('uninspectable_frame'),JSON.stringify(shot.masked));
  const text=JSON.stringify(shot.masked||null);assert.ok(!text.includes('synthetic'));
  return shot.masked;
 });
 await rm(exportRoot,{recursive:true,force:true});
}finally{
 await session?.close?.();
 server.close();
}
for(const row of results)console.log(`${row.ok?'PASS':'FAIL'} ${row.label}${row.ok?` (${row.ms}ms) ${JSON.stringify(row.detail)}`:` :: ${row.error}`}`);
process.exitCode=results.every(row=>row.ok)?0:1;
