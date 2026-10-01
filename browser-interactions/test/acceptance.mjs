import {chromium} from 'playwright-core';
import {mkdtemp,rm,readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Interactions,createPlaywrightAdapter} from '../index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=path.join(root,'evidence');await mkdir(evidence,{recursive:true});
const html=await readFile(new URL('./fixture.html',import.meta.url));
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const scope={taskId:'acceptance-task',generation:7};
const report={startedAt:new Date().toISOString(),scope:'module-only; synthetic local pages; temporary profiles; no personal profiles',runs:[]};
const extensionDir=await mkdtemp(path.join(root,'.extension-'));
await copyFile(path.join(root,'index.mjs'),path.join(extensionDir,'index.mjs'));
await copyFile(new URL('./extension-worker.mjs',import.meta.url),path.join(extensionDir,'worker.mjs'));
await writeFile(path.join(extensionDir,'manifest.json'),JSON.stringify({manifest_version:3,name:'Interactions Acceptance Only',version:'1.0',permissions:['debugger','tabs'],background:{service_worker:'worker.mjs',type:'module'}}));
const browsers=[['chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],['edge','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']];
try {
 for(const [name,executablePath] of browsers) for(const adapterKind of ['playwright','chrome.debugger']) for(const dpr of [1,2]) {
  if(process.env.ONLY_ADAPTER&&adapterKind!==process.env.ONLY_ADAPTER)continue;
  const id=`${name}-${adapterKind.replace('.','-')}-dpr${dpr}`,profile=await mkdtemp(path.join(root,'.profile-'));
  const run={id,browser:name,adapter:adapterKind,dpr,profile,checks:[]};report.runs.push(run);let context;
  try {
   // 中文注释：临时浏览器统一保留 HOME，并显式使用模拟钥匙串与 basic 密码存储。
   context=await chromium.launchPersistentContext(profile,{executablePath,headless:true,viewport:{width:800,height:600},deviceScaleFactor:dpr,env:{...process.env,HOME:process.env.HOME},ignoreDefaultArgs:adapterKind==='chrome.debugger'?['--disable-extensions']:[],args:['--use-mock-keychain','--password-store=basic',...(adapterKind==='chrome.debugger'?(name==='chrome'?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`]):[])]});
   const page=context.pages()[0],url=base+'/'+id;await page.goto(url);
   const versionSession=await context.newCDPSession(page);run.version=await versionSession.send('Browser.getVersion');await versionSession.detach();
   let b,recreate;
   if(adapterKind==='playwright') {
    const a=await createPlaywrightAdapter(page);b=new Interactions(a,scope);recreate=async options=>{b=new Interactions(a,options);};
   }else {
    let worker=context.serviceWorkers()[0];
    if(!worker) {
     const session=await context.browser().newBrowserCDPSession();
     await session.send('Extensions.loadUnpacked',{path:extensionDir});
     worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
    }
    await worker.evaluate(arg=>globalThis.testCreate(arg),{url,scope,dpr});
    b=new Proxy({}, {get:(_,method)=>async arg=>{const r=await worker.evaluate(arg=>globalThis.testCall(arg),{method,arg});if(r.error){const e=Error(r.error);e.code=r.error;throw e;}return r.value;}});
    recreate=options=>worker.evaluate(options=>globalThis.testRecreate(options),options);
   }
   await page.evaluate(async()=>{scrollTo(0,500);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
   let shot=await b.capture(scope),request={...scope,screenshotId:shot.id};
   assert.equal(shot.dpr,dpr);assert.deepEqual(shot.scroll,{x:0,y:500});assert.deepEqual(shot.viewport,{width:800,height:600});assert.equal(shot.image.width,800*dpr);assert.equal(shot.image.height,600*dpr);
   run.screenshot={...shot,image:{...shot.image,data:undefined}};await writeFile(path.join(evidence,id+'-before.png'),Buffer.from(shot.image.data,'base64'));run.checks.push({name:'DPR-scroll-viewport-image-binding',ok:true});
   const capture=async()=>{shot=await b.capture(scope);request={...scope,screenshotId:shot.id};};
   const bounds=selector=>b.bounds({...request,selector});
   const reject=async(name,fn,code)=>{await assert.rejects(fn,{code});run.checks.push({name,ok:true,code});};
   let source=await bounds('#source'),target=await bounds('#drop');
   const drag=()=>b.dragCoordinates({...request,from:{point:source.imageCenter,expectedRef:source.ref},to:{point:target.imageCenter,expectedRef:target.ref}});
   await reject('cross-task',()=>b.clickCoordinates({...request,taskId:'other-task',point:source.imageCenter,expectedRef:source.ref}),'SCOPE_MISMATCH');
   await reject('generation',()=>b.clickCoordinates({...request,generation:8,point:source.imageCenter,expectedRef:source.ref}),'SCOPE_MISMATCH');
   await reject('wrong-node-at-coordinate',()=>b.clickCoordinates({...request,point:source.imageCenter,expectedRef:target.ref}),'TARGET_OCCLUDED');
   await reject('NaN-coordinate',()=>b.clickCoordinates({...request,point:{x:NaN,y:1},expectedRef:source.ref}),'INVALID_COORDINATES');
   const secret=await bounds('#secret');await reject('sensitive-password',()=>b.clickCoordinates({...request,point:secret.imageCenter,expectedRef:secret.ref}),'SENSITIVE_TARGET');
   const covered=await bounds('#covered');await reject('overlay',()=>b.clickCoordinates({...request,point:covered.imageCenter,expectedRef:covered.ref}),'TARGET_OCCLUDED');
   assert.equal((await page.evaluate(()=>results.events)).length,0);
   await drag();assert.equal(await page.evaluate(()=>results.pointer),true);run.checks.push({name:'coordinate-pointer-drag',ok:true});
   await reject('consumed-screenshot',drag,'UNKNOWN_SCREENSHOT');
   await capture();await b.dragElements({...request,source:'#source',target:'#drop',mode:'pointer'});assert.equal(await page.evaluate(()=>results.pointer),true);run.checks.push({name:'element-pointer-drag',ok:true});
   await capture();await b.dragElements({...request,source:'#htmlSource',target:'#htmlDrop',mode:'html5-synthetic'});assert.equal(await page.evaluate(()=>results.html5),true);run.checks.push({name:'element-html5-synthetic-drag',ok:true});
   await capture();await page.evaluate(()=>scrollTo(0,510));await reject('scroll-changed',()=>bounds('#source'),'STALE_SCREENSHOT');
   await page.evaluate(()=>scrollTo(0,500));await capture();await page.evaluate(()=>document.querySelector('#drop').style.borderColor='red');await reject('DOM-generation-changed',()=>bounds('#source'),'STALE_SCREENSHOT');
   await capture();await page.goto(url+'?new-document');await reject('document-navigation',()=>bounds('#source'),'STALE_SCREENSHOT');
   await page.evaluate(()=>scrollTo(0,500));await recreate({...scope,ttlMs:40});await capture();await new Promise(r=>setTimeout(r,65));await reject('expired-screenshot',()=>b.clickCoordinates({...request,point:{x:100,y:100},expectedRef:'unused'}),'SCREENSHOT_EXPIRED');
   await recreate(scope);await capture();const oldRef=await bounds('#source');await capture();await reject('old-screenshot-node-ref',()=>b.clickCoordinates({...request,point:oldRef.imageCenter,expectedRef:oldRef.ref}),'INVALID_NODE_REF');
   await b.dragElements({...request,source:'#source',target:'#drop',mode:'pointer'});await capture();await b.dragElements({...request,source:'#htmlSource',target:'#htmlDrop',mode:'html5-synthetic'});
   await page.evaluate(()=>{source.style.zIndex='10';let start;source.addEventListener('pointerdown',e=>{start={x:e.clientX,y:e.clientY};});source.addEventListener('pointermove',e=>{if(start&&e.buttons)source.style.transform=`translate(${e.clientX-start.x}px,${e.clientY-start.y}px)`;});});
   await capture();await b.dragElements({...request,source:'#source',target:'#drop',mode:'pointer'});
   const moved=await page.locator('#source').boundingBox();assert.equal(moved.x+moved.width/2,430);assert.equal(moved.y+moved.height/2,250);run.checks.push({name:'visible-element-moved-to-target',ok:true,rect:moved});
   run.events=await page.evaluate(()=>results.events);assert.ok(run.events.filter(e=>e.type.startsWith('pointer')).every(e=>e.trusted));assert.ok(run.events.filter(e=>e.type==='drop').every(e=>!e.trusted));
   run.results=await page.evaluate(()=>results);await capture();await writeFile(path.join(evidence,id+'-after.png'),Buffer.from(shot.image.data,'base64'));run.ok=true;
   console.log(id+': PASS '+run.checks.length+' checks');
  }catch(e){run.ok=false;run.error=e.stack;console.error(id+': FAIL '+e.stack);}
  finally {if(context)await context.close();await rm(profile,{recursive:true,force:true});run.profileRemoved=true;await writeFile(path.join(evidence,'acceptance.json'),JSON.stringify(report,null,2));}
 }
}finally{server.close();await rm(extensionDir,{recursive:true,force:true});}
report.finishedAt=new Date().toISOString();report.ok=report.runs.length>0&&report.runs.every(r=>r.ok);report.checkCount=report.runs.reduce((n,r)=>n+r.checks.length,0);await writeFile(path.join(evidence,'acceptance.json'),JSON.stringify(report,null,2));
if(!report.ok)process.exitCode=1;
