// 中文注释：只验收连接面板；任务数据即使存在也不读取、不渲染。
import assert from 'node:assert/strict';
import test from 'node:test';
import {mountDesktop} from './desktop-dom.mjs';
for(const [name,queries,expected] of [
 ['加载中',{},/正在读取浏览器连接/],
 ['桥接不可用',{browsers:{error:Error('network')}},/本地桥接不可用.*启动桥接服务/],
 ['无浏览器',{browsers:{data:[]}},/本地桥接可用.*暂无浏览器/],
 ['在线和离线',{browsers:{data:[{instanceId:'a',browser:'edge',connected:true,consentStatus:'enabled'},{instanceId:'b',browser:'chrome',connected:false,consentStatus:'disabled'}]}},/在线浏览器.*Microsoft Edge.*已连接.*全部访问.*离线浏览器.*Chrome.*未连接.*智能审批/]
])test(`精简面板：${name}`,async()=>{
 const h=await mountDesktop({queries,initialHash:'#/browser-link?task=old'});
 try{
  assert.match(h.root.textContent,expected);
  assert.equal(h.root.querySelector('details,select,input,table'),null);
  assert.doesNotMatch(h.root.textContent,/任务日志|操作时间线|步骤列表|任务文件|下载列表|技术详情/);
  assert.ok(h.queryOptions.every(row=>row.queryKey.at(-1)==='browsers'));
 }finally{h.unmount();}
});
test('过期缓存不能继续宣称浏览器在线',async()=>{
 const h=await mountDesktop({queries:{browsers:{data:[{instanceId:'a',browser:'edge',connected:true}],dataUpdatedAt:Date.now()-60000}}});
 try{assert.match(h.root.textContent,/本地桥接不可用/);assert.equal(h.root.querySelector('[data-browser-row]'),null);}finally{h.unmount();}
});
