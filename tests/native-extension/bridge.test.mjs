import test from 'node:test';import assert from 'node:assert/strict';
test('only own UI can approve; approval installed before next native command',async()=>{
 const {Bridge,isUiSender}=await import('../../native-extension/bridge.mjs');
 assert.equal(isUiSender({id:'x',url:'https://evil.test'},'x'),false);assert.equal(isUiSender({id:'x',url:'chrome-extension://x/popup.html'},'x'),true);
 const listeners=[];const sent=[];const port={postMessage:m=>sent.push(m),onMessage:{addListener:f=>listeners.push(f)}};const approved=[];const b=new Bridge(port,{approve:async t=>approved.push(t),execute:async()=>approved.length,release:async()=>({released:true})});
 const p=b.request('extension.approve',{taskId:'a',tabIds:[1],allowedOrigins:[]});listeners[0]({id:sent[0].id,result:{id:'a',generation:1,tabIds:[1],allowedOrigins:[]}});listeners[0]({id:'cmd',method:'browser.execute',params:{}});await p;await new Promise(r=>setTimeout(r,0));assert.equal(sent.at(-1).result,1);
});

test('approval response cannot widen user-selected tabs or origins',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');const listeners=[];const sent=[];let installed=false;const port={postMessage:m=>sent.push(m),onMessage:{addListener:f=>listeners.push(f)}};const b=new Bridge(port,{approve:async()=>{installed=true;}});
 const p=b.request('extension.approve',{taskId:'a',tabIds:[1],allowedOrigins:['https://example.com']});listeners[0]({id:sent[0].id,result:{id:'a',generation:1,tabIds:[1,2],allowedOrigins:['https://example.com','https://evil.test']}});await assert.rejects(p,/approval response mismatch/);assert.equal(installed,false);
});

test('closed bridge ignores queued native commands',async()=>{
 const {Bridge}=await import('../../native-extension/bridge.mjs');const listeners=[];let executions=0;const port={postMessage:()=>{},onMessage:{addListener:f=>listeners.push(f)}};const b=new Bridge(port,{execute:async()=>{executions++;}});b.close();listeners[0]({id:'late',method:'browser.execute',params:{}});await new Promise(r=>setTimeout(r,0));assert.equal(executions,0);
});

test('disconnect during approval cannot install authority after reconnect boundary',async()=>{
 const [{Bridge},{Executor}]=await Promise.all([import('../../native-extension/bridge.mjs'),import('../../native-extension/core.mjs')]);const listeners=[];const sent=[];let unblock;const executor=new Executor({tabs:{get:()=>new Promise(r=>unblock=()=>r({id:1,url:'https://example.com/'}))}});const port={postMessage:m=>sent.push(m),onMessage:{addListener:f=>listeners.push(f)}};const b=new Bridge(port,executor);
 const approval=b.request('extension.approve',{taskId:'a',tabIds:[1],allowedOrigins:['https://example.com']});listeners[0]({id:sent[0].id,result:{id:'a',generation:1,tabIds:[1],allowedOrigins:['https://example.com']}});await new Promise(r=>setTimeout(r,0));b.close();unblock();await assert.rejects(approval,/disconnected/);await b.approvalBarrier;assert.equal(executor.leases.size,0);
});
