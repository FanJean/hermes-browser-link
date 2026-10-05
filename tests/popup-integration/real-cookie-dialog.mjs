// 中文注释：只启动临时 Chromium 与合成 Hermes 页面，复用生产组件和宿主 CSS，不读取或复制真实 Cookie。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {CdpClient,waitFor,fetchJson} from '../native-v2/cdp-client.mjs';
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const output=option('output'),cssFile=option('host-css'),esbuildFile=option('esbuild');
if(![output,cssFile,esbuildFile].every(value=>value&&path.isAbsolute(value)))throw Error('需要绝对路径 --output、--host-css 和 --esbuild');
const root=path.resolve(import.meta.dirname,'../..');await mkdir(output,{recursive:true});
const esbuild=await import(pathToFileURL(esbuildFile));
const bootstrap=`import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import plugin from './executor-plugin/desktop/plugin.js';
 const source='a'.repeat(32),target='b'.repeat(32);const browsers=[{instanceId:source,browser:'chrome',connected:true,consentStatus:'enabled',features:['cookie_mirror_v1']},{instanceId:target,browser:'edge',connected:true,consentStatus:'enabled',features:['cookie_mirror_v1']}];
 window.previewPosts=0;let route;plugin.register({registerMany:rows=>{route=rows.find(row=>row.area==='routes');},rest:async(path,options)=>{if(options?.method==='POST'){window.previewPosts++;throw Error('测试不发起镜像');}if(path==='/shared/browsers')return browsers;if(path.endsWith('/cookie-sites'))return {sites:[{site:'example.test',count:3,httpOnly:true,session:true,value:'PRIVATE_COOKIE_CANARY'}]};throw Error('未知测试路由');}});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},route.render()));`;
const built=await esbuild.build({stdin:{contents:bootstrap,resolveDir:root,sourcefile:'cookie-dialog-preview.js'},bundle:true,write:false,format:'esm',plugins:[{name:'hermes-preview-sdk',setup(build){build.onResolve({filter:/^@hermes\/plugin-sdk$/},()=>({path:'sdk',namespace:'preview'}));build.onLoad({filter:/.*/,namespace:'preview'},()=>({contents:"export {useQuery} from '@tanstack/react-query';export const host={navigate(){},notify(){}};export const ROUTES_AREA='routes',SIDEBAR_NAV_AREA='nav',PALETTE_AREA='palette';",resolveDir:root,loader:'js'}));}}]});
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><style>:root{--ui-bg-elevated:#fff;--ui-bg-primary:rgba(37,99,235,.12);--ui-bg-input:#fff;--ui-text-primary:#171717;--ui-text-secondary:#666;--ui-stroke-secondary:#d4d4d4;--ui-accent:#1f754b;--shadow-md:0 12px 35px #0003}body{margin:0;font:14px system-ui;background:#f8fafc;color:var(--ui-text-primary)}.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}nav{padding:24px;background:#e2e8f0}#root{padding:40px}@media(max-width:600px){.shell{grid-template-columns:80px minmax(0,1fr)}nav{padding:12px}#root{padding:16px}}</style></head><body><div class="shell"><nav>HERMES<br><br>会话<br>设置<br>浏览器连接</nav><main id="root"></main></div><script type="module" src="/app.js"></script></body></html>`;
const hostCss=await readFile(cssFile);const script=built.outputFiles[0].contents;
const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}const data=req.url==='/app.js'?script:req.url==='/host.css'?hostCss:html;res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/host.css'?'text/css':'text/html; charset=utf-8');res.end(data);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp('/tmp/hermes-cookie-dialog-');
const proc=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--use-mock-keychain','--password-store=basic','--disable-background-networking',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let browser,page;const checks=[];
try{
 const port=await waitFor(async()=>{try{return (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},30000);
 const base=`http://127.0.0.1:${port}`;browser=new CdpClient((await fetchJson(`${base}/json/version`)).webSocketDebuggerUrl);await browser.connect();
 const {targetId}=await browser.call('Target.createTarget',{url:`http://127.0.0.1:${server.address().port}/#/browser-link`});
 const target=await waitFor(async()=>(await fetchJson(`${base}/json/list`)).find(row=>row.id===targetId));page=new CdpClient(target.webSocketDebuggerUrl);await page.connect();await browser.call('Target.activateTarget',{targetId});
 await page.call('Runtime.enable');
 const clickText=async text=>page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(row=>row.textContent===${JSON.stringify(text)}&&!row.disabled);if(!b)throw Error('缺少按钮');b.click();})()`);
 await waitFor(()=>page.evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="Cookie 镜像")'));
 await clickText('Cookie 镜像');await waitFor(()=>page.evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="读取 Cookie 站点")'));await clickText('读取 Cookie 站点');
 await waitFor(()=>page.evaluate('Boolean(document.querySelector("li button"))'));
 // 中文注释：比较真实宿主 CSS 下的几何与不透明度；截图在断言前保留，以便复现失败。
 for(const [name,width,height,dark] of [['desktop',1100,760,false],['narrow',360,640,false],['short',800,320,false],['dark',1100,760,true]]){
  await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await page.evaluate(`(()=>{document.documentElement.style.colorScheme=${JSON.stringify(dark?'dark':'light')};document.documentElement.style.setProperty('--ui-bg-elevated',${JSON.stringify(dark?'#20252b':'#fff')});document.documentElement.style.setProperty('--ui-text-primary',${JSON.stringify(dark?'#f1f5f9':'#171717')});const button=document.querySelector('li button');button.focus();button.click();})()`);
  await waitFor(()=>page.evaluate('Boolean(document.querySelector("dialog[open]"))'));
  // 中文注释：窄窗口同时展开持久化选项，验证输入和标签不把弹窗撑出横向滚动。
  if(name==='narrow')await page.evaluate('document.querySelectorAll("dialog input[type=checkbox]")[1].click()');
  const geometry=await page.evaluate(`(()=>{const d=document.querySelector('dialog[open]'),r=d.getBoundingClientRect(),s=getComputedStyle(d),c=document.createElement('canvas'),ctx=c.getContext('2d');ctx.fillStyle=s.backgroundColor;ctx.fillRect(0,0,1,1);return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,alpha:ctx.getImageData(0,0,1,1).data[3],scrollWidth:d.scrollWidth,clientWidth:d.clientWidth,selectWidth:d.querySelector('select').getBoundingClientRect().width,modal:d.matches(':modal'),leak:document.body.innerHTML.includes('PRIVATE_COOKIE_CANARY')};})()`);
  await writeFile(path.join(output,`${name}.png`),Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
  checks.push({name,...geometry});await writeFile(path.join(output,'geometry.json'),JSON.stringify(checks,null,2));
  assert.equal(geometry.alpha,255,'弹窗背景必须不透明');assert.equal(geometry.modal,true);assert.equal(geometry.leak,false);
  assert.ok(Math.abs(geometry.x+geometry.width/2-width/2)<=1,'水平居中');assert.ok(Math.abs(geometry.y+geometry.height/2-height/2)<=1,'垂直居中');
  assert.ok(geometry.x>=15&&geometry.y>=15&&geometry.width<=width-30&&geometry.height<=height-30,'留出窗口边界');assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,'不横向溢出');
  if(name==='narrow'){
   await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
   await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
  }else await clickText('取消');
  await waitFor(()=>page.evaluate('!document.querySelector("dialog").open'));
  assert.equal(await page.evaluate('document.activeElement===document.querySelector("li button")'),true,'关闭后焦点返回原镜像按钮');
 }
 assert.equal(await page.evaluate('window.previewPosts'),0);console.log(JSON.stringify({passed:true,checks:checks.length,realCookieRequests:0}));
}finally{page?.close();browser?.close();proc.kill('SIGTERM');await new Promise(resolve=>proc.exitCode!==null?resolve():proc.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});server.close();}
