// 中文注释：生产 PageRuntime 注册持久脚本后，模拟用户跳到未授权来源，直接检查新文档副作用。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PageRuntime} from '../../native-extension/page-runtime.mjs';
import {openPageBrowser} from '../v1.1-overlay/browser-fixture.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
const servers=[];
async function site(){const s=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><p>合成来源</p>');});servers.push(s);await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${s.address().port}`;}
const browser=process.argv.includes('--edge')?'edge':'chrome';let session;
try{
 const allowed=await site(),outside=await site();session=await openPageBrowser(allowed+'/',{browser});const {client}=session;
 const task={id:'origin-test',generation:1,policy:{activeMode:'full',modeGeneration:1}};let registrations=0;
 const executor={tasks:new Map([[task.id,task]]),leases:new Map([[7,task.id]]),allowed(_task,url){if(new URL(url).origin!==allowed)throw Error('origin denied');},api:{tabs:{get:async()=>({url:await client.evaluate('location.href')})},debugger:{sendCommand:async(_target,method,params)=>{if(method==='Page.addScriptToEvaluateOnNewDocument')registrations++;return client.call(method,params);}}}};
 await client.call('Page.enable');
 const runtime=new PageRuntime(executor);let denied=false;
 try{await runtime.send(task,{tabId:7,method:'Page.addScriptToEvaluateOnNewDocument',params:{source:'globalThis.__hermesAuditPersisted=1'}},()=>{});}
 catch(error){assert.equal(error.message,'CDP_METHOD_DENIED');denied=true;}
 await client.call('Page.navigate',{url:outside+'/'});await waitFor(()=>client.evaluate(`location.origin===${JSON.stringify(outside)}&&document.readyState==='complete'`));
 const executed=await client.evaluate('globalThis.__hermesAuditPersisted===1');
 console.log(JSON.stringify({browser,version:session.version.Browser,registrations,denied,executedOutside:executed}));
 assert.equal(executed,false,'持久脚本不能在任务范围外执行');
}finally{await session?.close();for(const s of servers)await new Promise(resolve=>s.close(resolve));}
