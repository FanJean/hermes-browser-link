// 中文注释：仅本地 fixture 与临时 profile；窗口遮挡和最小化只操作本次 CDP 创建的窗口。
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {CdpClient,fetchJson,waitFor} from '../native-v2/cdp-client.mjs';
import {browserPaths} from '../native-v2/real-session.mjs';

export const fixture=`<!doctype html><meta charset="utf-8"><title>Input fixture</title>
<style>body{padding:40px}button,input,[contenteditable]{display:block;margin:16px;width:220px;min-height:35px}</style>
<button id="pointer">Pointer down</button><button id="trusted">Trusted click</button>
<form id="form"><button id="submit">Submit form</button></form>
<form id="keys"><input id="enter" aria-label="Enter submit"></form>
<div contenteditable="true" id="editable" aria-label="Editable"></div><output id="result"></output>
<script>
// 中文注释：根节点委托 pointerdown，模拟 React onPointerDown 的事件入口。
window.hits={pointer:0,trusted:0,submit:0,enter:0,editable:0};
const hit=k=>{hits[k]++;document.querySelector('#result').textContent=JSON.stringify(hits)};
document.addEventListener('pointerdown',e=>{if(e.target.id==='pointer')hit('pointer')});
document.querySelector('#trusted').onclick=e=>{if(e.isTrusted)hit('trusted')};
document.querySelector('#form').onsubmit=e=>{e.preventDefault();hit('submit')};
document.querySelector('#keys').onsubmit=e=>{e.preventDefault();hit('enter')};
document.querySelector('#editable').oninput=()=>hit('editable');
</script>`;

export async function runExperiment(){
 const browser=process.argv.includes('--edge')?'edge':'chrome',headed=process.argv.includes('--headed');
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`,work=await mkdtemp('/private/tmp/bl160-input-');
 const proc=spawn(browserPaths[browser],[...(headed?[]:['--headless=new']),`--user-data-dir=${work}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--use-mock-keychain','--password-store=basic','about:blank'],{detached:true,stdio:'ignore'});
 let root,page;const rows=[];
 try{
  const port=await waitFor(async()=>{try{return (await readFile(`${work}/DevToolsActivePort`,'utf8')).split('\n')[0]}catch{return null}});
  const base=`http://127.0.0.1:${port}`;root=new CdpClient((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl);await root.connect();
  const {targetId}=await root.call('Target.createTarget',{url,newWindow:true});
  const target=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(t=>t.id===targetId));
  page=new CdpClient(target.webSocketDebuggerUrl);await page.connect();await waitFor(()=>page.evaluate('Boolean(window.hits)'));
  const {windowId}=await root.call('Browser.getWindowForTarget',{targetId});
  await root.call('Browser.setWindowBounds',{windowId,bounds:{left:80,top:80,width:720,height:650}});
  const other=await root.call('Target.createTarget',{url:'about:blank'});
  if((await root.call('Browser.getWindowForTarget',{targetId:other.targetId})).windowId!==windowId)throw Error('background fixture must share the target window');
  const cover=await root.call('Target.createTarget',{url:'about:blank',newWindow:true});
  const coverWindow=(await root.call('Browser.getWindowForTarget',{targetId:cover.targetId})).windowId;
  for(const state of ['background-tab','unfocused-window','occluded-window','minimized-window']){
   await root.call('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
   await root.call('Browser.setWindowBounds',{windowId:coverWindow,bounds:{windowState:'normal'}});
   await root.call('Browser.setWindowBounds',{windowId:coverWindow,bounds:state==='occluded-window'?{left:50,top:40,width:900,height:800}:{left:820,top:80,width:480,height:650}});
   await root.call('Target.activateTarget',{targetId});
   if(state==='background-tab')await root.call('Target.activateTarget',{targetId:other.targetId});
   else await root.call('Target.activateTarget',{targetId:cover.targetId});
   if(state==='minimized-window')await root.call('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
   await new Promise(r=>setTimeout(r,700));
   const visibility=await page.evaluate('document.visibilityState');
   for(const kind of ['pointer','trusted','submit','enter','editable'])for(const trial of [1,2,3])for(const mode of ['synthetic','cdp']){
    await page.evaluate(`Object.keys(hits).forEach(k=>hits[k]=0);document.querySelector('#editable').textContent='';document.querySelector('#enter').value=''`);
    const id={submit:'submit',enter:'enter',editable:'editable'}[kind]||kind;
    if(mode==='synthetic'){
     await page.evaluate(`(()=>{const e=document.getElementById('${id}');if('${kind}'==='enter'){e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));e.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));}else if('${kind}'==='editable'){e.focus();e.textContent='sample';e.dispatchEvent(new InputEvent('input',{bubbles:true}));}else e.click()})()`);
    }else if(kind==='enter'||kind==='editable'){
     await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
     await page.evaluate(`document.getElementById('${id}').focus()`);
     if(kind==='editable')await page.call('Input.insertText',{text:'sample'});
     else{await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})}
     await page.call('Emulation.setFocusEmulationEnabled',{enabled:false});
    }else{
     const point=await page.evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
     await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
     await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    await new Promise(r=>setTimeout(r,120));
    rows.push({browser,headed,state,visibility,kind,mode,trial,hits:await page.evaluate(`hits.${kind}`)});
   }
  }
  console.log(JSON.stringify({browser,headed,version:(await fetchJson(`${base}/json/version`)).Browser,rows},null,2));
 }finally{page?.close();root?.close();try{process.kill(-proc.pid,'SIGTERM')}catch{}await new Promise(r=>setTimeout(r,800));try{process.kill(-proc.pid,'SIGKILL')}catch{}await rm(work,{recursive:true,force:true});server.close()}
 return rows;
}
if(process.argv[1]===import.meta.filename)await runExperiment();
