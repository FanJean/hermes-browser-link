// 中文注释：复用真实 React 与 Query 的离线渲染夹具。
import assert from 'node:assert/strict'
import test from 'node:test'
import { setup } from './render-harness.mjs'

// 中文注释：真实渲染不得重新提供逐项审批或切换模式入口，授权只来自浏览器读回。
test('连接授权后直接执行任务，桌面不再发起模式确认', async () => {
  const h = await setup(async path => {
    assert.equal(path, '/shared/browsers')
    return [{instanceId:'edge-a',browser:'edge',connected:true,consentStatus:'enabled',accessRequestSupported:true,primary:true}]
  }, '#/browser-link?task=old')
  try {
    assert.match(document.body.textContent,/本地桥接可用/)
    assert.match(document.body.textContent,/已授权 · 任务直接执行/)
    assert.doesNotMatch(document.body.textContent,/智能审批|切换模式|查看模式|确认页已打开/)
    assert.equal(document.querySelector('button'),null)
    assert.equal(h.calls.some(([path])=>path.includes('/tasks')),false)
    assert.equal(document.querySelector('details,select,input,table'),null)
  } finally { await h.close() }
})

test('离线或未知授权不会显示任务已授权', async () => {
  const h = await setup(async () => [
    {instanceId:'offline',browser:'edge',connected:false,consentStatus:'enabled',primary:true},
    {instanceId:'unknown',browser:'chrome',connected:true,consentStatus:'unknown',primary:true},
    {instanceId:'disabled',browser:'chrome',connected:true,consentStatus:'disabled',primary:true}
  ])
  try {
    assert.doesNotMatch(document.body.textContent,/已授权|任务直接执行|智能审批|切换模式|查看模式/)
    assert.match(document.body.textContent,/授权待确认/)
    assert.match(document.body.textContent,/请在扩展中连接并授权/)
    assert.equal(h.calls.length,1)
  } finally { await h.close() }
})

test('真实渲染区分桥接不可用和空浏览器列表', async () => {
  for (const unavailable of [true,false]) {
    const h=await setup(async()=>{if(unavailable)throw Error('network');return []})
    try {
      assert.match(document.body.textContent,unavailable?/本地桥接不可用/:/暂无浏览器/)
      assert.equal(h.calls.length,1)
    } finally { await h.close() }
  }
})

// 中文注释：主要链接操作保留在桌面页，POST 后读取实际主要实例再更新显示。
test('桌面页设为主要链接发送受保护路由并读回，断连实例禁用',async()=>{
 let primary=false;
 const h=await setup(async(path,options)=>{
  if(path==='/shared/browsers')return [{instanceId:'connected',browser:'chrome',connected:true,primary},{instanceId:'offline',browser:'edge',connected:false}];
  assert.equal(path,'/shared/browsers/connected/primary');assert.equal(options.method,'POST');primary=true;return {instanceId:'connected'};
 });
 try{
  const rows=[...document.querySelectorAll('[data-browser-row]')];
  assert.equal(rows[1].querySelector('button').disabled,true);
  await h.click(rows[0].querySelector('button'));
  assert.match(rows[0].textContent,/主要链接/);assert.equal(rows[0].querySelector('button'),null);
  assert.equal(h.calls.filter(([path])=>path.endsWith('/primary')).length,1);
  assert.ok(h.calls.filter(([path])=>path==='/shared/browsers').length>=2);
 }finally{await h.close()}
});
