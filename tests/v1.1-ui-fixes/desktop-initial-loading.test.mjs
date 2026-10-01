// 中文注释：首次轮询尚无时间戳时仍属于加载中，不能显示离线或空列表。
import assert from 'node:assert/strict';
import test from 'node:test';
import {mountDesktop} from '../v1.1-ui-acceptance/desktop-dom.mjs';
test('初次加载不误报桥接不可用',async()=>{
 const h=await mountDesktop();try{assert.match(h.root.querySelector('[role="status"]').textContent,/正在读取浏览器连接/);assert.doesNotMatch(h.root.textContent,/不可用|暂无浏览器/);}finally{h.unmount();}
});
