// 中文注释：复用真实 React 与 Query 的离线渲染夹具。
import assert from 'node:assert/strict'
import test from 'node:test'
import { setup } from './render-harness.mjs'

// 中文注释：使用真实 React 和 Query 渲染，验证初始加载及授权只触发确认入口。
test('连接面板只读取浏览器列表，授权请求不会伪造授权已开启', async () => {
  const h = await setup(async (path, options) => {
    if (path === '/shared/browsers') return [{instanceId:'edge-a',browser:'edge',connected:true,consentStatus:'disabled',accessRequestSupported:true}]
    assert.equal(options.method,'POST')
    assert.equal(path,'/shared/browsers/edge-a/access-request')
    return {requestId:'r',status:'confirmation_requested'}
  }, '#/browser-link?task=old')
  try {
    assert.match(document.body.textContent,/本地桥接可用/)
    await h.click(h.button('切换模式'))
    assert.match(document.body.textContent,/确认页已打开/)
    assert.match(document.body.textContent,/智能审批/)
    assert.equal(h.calls.some(([path])=>path.includes('/tasks')),false)
    assert.equal(document.querySelector('details,select,input,table'),null)
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
