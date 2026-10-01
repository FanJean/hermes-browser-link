// 中文注释：缺失 connected 字段不能等同离线。
import assert from 'node:assert/strict';
import test from 'node:test';
import {mountDesktop} from '../v1.1-ui-acceptance/desktop-dom.mjs';
test('未知连接状态单独显示且不启用授权入口',async()=>{
 const h=await mountDesktop({queries:{browsers:{data:[{instanceId:'edge-1',browser:'edge',accessRequestSupported:true}]}}});
 try{assert.match(h.root.textContent,/连接待确认/);assert.doesNotMatch(h.root.textContent,/未连接/);assert.equal(h.root.querySelector('[data-browser-row] button').disabled,true);}finally{h.unmount();}
});
