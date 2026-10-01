// 中文注释：仅比较仓库 HEAD 与工作树的页面语义函数；不启动浏览器。
import {execFileSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {performance} from 'node:perf_hooks';
import {createPageSemantics as current} from '../../page-semantics/index.js';
const baselineSource=execFileSync('git',['show','HEAD:page-semantics/index.js'],{encoding:'utf8'});
const {createPageSemantics:baseline}=await import(`data:text/javascript,${encodeURIComponent(baselineSource)}`);
const html=`<!doctype html><body>${Array.from({length:120},(_,i)=>`<section><button>操作 ${i}</button><input aria-label="字段 ${i}"><div role="row"><span role="gridcell">${i}</span></div></section>`).join('')}</body>`;
function measure(make){
 const dom=new JSDOM(html,{url:'https://fixture.example.test/'}),{document}=dom.window;
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];
 const semantic=make({document,taskId:'bench',documentId:'document',leaseId:'lease'});
 const samples=[];
 for(let i=0;i<35;i++){const start=performance.now();semantic.snapshot({mode:'interactive',budget:12000});samples.push(performance.now()-start);}
 semantic.revoke();dom.window.close();return samples.slice(5).sort((a,b)=>a-b)[15];
}
const before=measure(baseline),after=measure(current);
console.log(JSON.stringify({baselineMedianMs:Number(before.toFixed(2)),currentMedianMs:Number(after.toFixed(2)),ratio:Number((after/before).toFixed(2))}));
