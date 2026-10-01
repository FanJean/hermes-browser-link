// 中文注释：下载归属的纯离线测试；合成调试事件与下载 API，不启动浏览器。
import assert from 'node:assert/strict';
import test from 'node:test';
import {DownloadTracker,safeDownloadName,MAX_DOWNLOAD_BYTES} from '../../native-extension/downloads.mjs';

function fixture(){
 let now=1000;const timers=[];const reports=[];const cancelled=[];const items=new Map();
 const tasks=new Map([['task-a',{id:'task-a',generation:2,revoked:false,downloadKey:'0123456789abcdef'}],
  ['task-b',{id:'task-b',generation:1,revoked:false,downloadKey:'fedcba9876543210'}]]);
 const executor={tasks,leases:new Map([[11,'task-a'],[22,'task-b']]),
  api:{downloads:{search:async({id,state})=>id!==undefined?(items.has(id)?[items.get(id)]:[]):[...items.values()].filter(item=>!state||item.state===state),
   cancel:async id=>{cancelled.push(id);items.get(id).state='interrupted';}}},
  check(t,p){if(!t||t.revoked||t.generation!==p.generation)throw Error('stale generation');}};
 const tracker=new DownloadTracker(executor,{report:async payload=>{reports.push(payload);},now:()=>now,
  setTimer:(fn,ms)=>{timers.push({fn,at:now+ms});return timers.length;}});
 const advance=async ms=>{now+=ms;for(const timer of timers.splice(0)){if(timer.at<=now)await timer.fn();else timers.push(timer);}await new Promise(resolve=>setImmediate(resolve));};
 return {tracker,executor,reports,cancelled,items,advance,tick:ms=>{now+=ms;}};
}
const begin=(f,tabId,url)=>f.tracker.observeCdp({tabId},'Page.downloadWillBegin',{url,guid:'g-'+tabId,suggestedFilename:'report.csv'});

test('unique task-tab download is redirected into the task staging folder',async()=>{
 const f=fixture();begin(f,11,'https://site.test/report');
 f.tracker.created({id:5,url:'https://site.test/report'});
 const suggestions=[];
 assert.equal(f.tracker.determine({id:5,url:'https://site.test/report',filename:'../../etc/report.csv'},value=>suggestions.push(value)),true);
 await f.advance(300);
 assert.deepEqual(suggestions,[{filename:'hermes-tasks/0123456789abcdef/report.csv',conflictAction:'uniquify'}]);
 assert.equal(f.reports[0].event,'attributed');assert.equal(f.reports[0].taskId,'task-a');assert.equal(f.reports[0].downloadRef,5);
});

test('user download of the same URL inside the window is never claimed',async()=>{
 const f=fixture();
 f.tracker.created({id:7,url:'https://site.test/report'});
 f.tick(50);begin(f,11,'https://site.test/report');f.tracker.created({id:8,url:'https://site.test/report'});
 const first=[],second=[];
 f.tracker.determine({id:7,url:'https://site.test/report',filename:'a.csv'},value=>first.push(value));
 f.tracker.determine({id:8,url:'https://site.test/report',filename:'b.csv'},value=>second.push(value));
 await f.advance(300);
 assert.deepEqual(first,[undefined]);assert.deepEqual(second,[undefined]);
 assert.equal(f.reports.length,1);assert.equal(f.reports[0].event,'ambiguous');
});

test('concurrent task downloads of one URL are ambiguous and stay in the default folder',async()=>{
 const f=fixture();begin(f,11,'https://site.test/x');begin(f,22,'https://site.test/x');
 f.tracker.created({id:1,url:'https://site.test/x'});
 const seen=[];f.tracker.determine({id:1,url:'https://site.test/x',filename:'x'},value=>seen.push(value));
 await f.advance(300);
 assert.deepEqual(seen,[undefined]);
 assert.deepEqual(f.reports.map(row=>[row.event,row.taskId]).sort(),[['ambiguous','task-a'],['ambiguous','task-b']]);
});

test('过期的任务下载开始事件不能认领稍后同网址的用户下载',async()=>{
 // 中文注释：旧 CDP 开始事件可能没有对应下载项；网址相同不足以证明新下载归属。
 const f=fixture();begin(f,11,'https://site.test/stale');f.tick(5000);
 const seen=[];
 f.tracker.determine({id:15,url:'https://site.test/stale',filename:'user.txt'},value=>seen.push(value));
 await f.advance(300);
 assert.deepEqual(seen,[undefined]);
 assert.equal(f.tracker.attributed.size,0);
 assert.deepEqual(f.reports.map(row=>row.event),['ambiguous']);
 assert.deepEqual(f.cancelled,[]);
});

test('without an active task the browser default is applied synchronously',()=>{
 const f=fixture();for(const t of f.executor.tasks.values())t.revoked=true;
 const seen=[];assert.equal(f.tracker.determine({id:3,url:'https://site.test/y'},value=>seen.push(value)),false);
 assert.deepEqual(seen,[undefined]);
});

test('events from foreign tabs or after revocation are ignored',async()=>{
 const f=fixture();begin(f,99,'https://site.test/z');
 f.tracker.created({id:4,url:'https://site.test/z'});
 const seen=[];f.tracker.determine({id:4,url:'https://site.test/z'},value=>seen.push(value));
 await f.advance(300);assert.deepEqual(seen,[undefined]);
 begin(f,11,'https://site.test/w');f.executor.tasks.get('task-a').revoked=true;f.executor.tasks.get('task-b').revoked=false;
 f.tracker.created({id:6,url:'https://site.test/w'});
 const later=[];f.tracker.determine({id:6,url:'https://site.test/w'},value=>later.push(value));
 await f.advance(300);assert.deepEqual(later,[undefined]);
});

test('completion, oversize cancellation and task-scoped cancel',async()=>{
 const f=fixture();begin(f,11,'blob:https://site.test/1234');
 f.tracker.created({id:9,url:'blob:https://site.test/1234'});
 f.tracker.determine({id:9,url:'blob:https://site.test/1234',filename:'blob.txt'},()=>{});
 await f.advance(300);
 f.items.set(9,{id:9,state:'complete',filename:'/Users/x/Downloads/hermes-tasks/0123456789abcdef/blob.txt',bytesReceived:4,totalBytes:4,fileSize:4,danger:'safe',exists:true});
 await f.tracker.changed({id:9,state:{current:'complete'}});
 const done=f.reports.at(-1);assert.equal(done.event,'complete');assert.equal(done.fileSize,4);
 await assert.rejects(f.tracker.cancel({taskId:'task-b',generation:1,downloadRef:9}),/DOWNLOAD_NOT_OWNED/);
 begin(f,11,'https://site.test/big');f.tracker.created({id:10,url:'https://site.test/big'});
 f.tracker.determine({id:10,url:'https://site.test/big',filename:'big.bin',totalBytes:MAX_DOWNLOAD_BYTES+1},()=>{});
 f.items.set(10,{id:10,state:'in_progress'});
 await f.advance(300);
 assert.deepEqual(f.cancelled,[10]);assert.equal(f.reports.at(-1).event,'rejected_size');
});

test('file names lose path semantics',()=>{
 assert.equal(safeDownloadName('..\\..\\secret'),'secret');
 assert.equal(safeDownloadName('../.hidden'),'hidden');
 assert.equal(safeDownloadName(''),'download');
 assert.equal(safeDownloadName('a<b>:c.txt'),'a_b__c.txt');
});
// 中文注释：撤权后不再跟踪或轮询任务下载，已结束记录也不能无限累积。
test('下载跟踪回收撤销任务和过多的已结束记录',async()=>{
 const f=fixture();
 for(let id=0;id<600;id++)f.tracker.attributed.set(id,{taskId:'task-a',generation:2,state:'complete'});
 f.tracker.prune();assert.ok(f.tracker.attributed.size<=512);
 f.tracker.attributed.set(999,{taskId:'task-b',generation:1,state:'in_progress'});
 f.tracker.schedulePoll();f.executor.tasks.get('task-b').revoked=true;
 await f.advance(1000);
 assert.equal(f.tracker.attributed.has(999),false);assert.equal(f.tracker.pollTimer,null);
 assert.deepEqual(f.cancelled,[]);
});
