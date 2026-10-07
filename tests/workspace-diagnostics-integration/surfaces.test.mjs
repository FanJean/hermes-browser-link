import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
test('offline popup status and local-only diagnostics export retain envelope',async()=>{
 let listener,receiveCloud;const noop={addListener(){}};const data={};
 // 中文注释：云端 hello 在内存中回执，避免离线本地连接测试遗留重连定时器。
 const cloudPort={onMessage:{addListener:f=>receiveCloud=f},onDisconnect:noop,postMessage:m=>queueMicrotask(()=>receiveCloud({id:m.id,result:{state:'unavailable',online:false,paired:false,fullAccess:false}}))};
 globalThis.chrome={notifications:{onClicked:noop},storage:{local:{get:async k=>({[k]:data[k]}),set:async x=>Object.assign(data,x)},session:{get:async k=>({[k]:data[k]}),set:async x=>Object.assign(data,x)}},runtime:{sendMessage:async()=>{},getManifest:()=>({version:packageVersion}),id:'test',onMessage:{addListener:f=>listener=f},connectNative(name){if(name==='com.hermes.browser_link.cloud')return cloudPort;throw Error('offline');}},alarms:{create(){},onAlarm:noop},tabs:{onCreated:noop,onRemoved:noop,onUpdated:noop},debugger:{onDetach:noop}};
 await import('../../native-extension/background.mjs');await new Promise(r=>setTimeout(r,5));
 const sender={id:'test',url:'chrome-extension://test/popup.html'};
 const rpc=m=>new Promise(resolve=>listener(m,sender,resolve));
 const status=(await rpc({type:'status'})).result;assert.deepEqual(status.workspaces,[]);assert.equal(status.diagnostics.available,true);
 assert.equal((await rpc({type:'popup_status'})).result.version,packageVersion);
 const exported=(await rpc({type:'diagnostics_export'})).result;assert.equal(exported.bundle_format,'browser.diagnostics.buffer/v1');
 assert.equal(listener({type:'diagnostics_export'},{id:'other'},()=>assert.fail()),false);
 delete globalThis.chrome;
});
test('build includes workspace and diagnostics dependencies and imports offline',async()=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR||tmpdir(),'native-wd-'));
 try{execFileSync(process.execPath,['native-extension/build.mjs',root],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
 const deps=JSON.parse(await readFile(path.join(root,'BUILD-DEPS.json'),'utf8'));
 assert.ok(deps.dependencies['vendor/browser-workspaces.mjs']);assert.ok(deps.dependencies['vendor/browser-diagnostics.mjs']);
 await import(path.join(root,'core.mjs'));const m=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));assert.ok(m.permissions.includes('tabGroups'));
 }finally{await rm(root,{recursive:true,force:true});}
});
