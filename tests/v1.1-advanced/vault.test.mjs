import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {inspectControls,fillControls} from '../../native-extension/vault.mjs';

test('Vault 检查只返回控件元信息，填写要求同一 nonce、来源和字段类型',()=>{
 const dom=new JSDOM('<form><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><input id="otp" autocomplete="one-time-code"></form>',{url:'https://example.test/login'});
 const names=['document','location','HTMLInputElement','InputEvent','Event','getComputedStyle'];
 const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
 for(const name of names)globalThis[name]=dom.window[name];
 try{
  // 中文注释：jsdom 不计算布局，这里只模拟两个可见的真实输入框。
  for(const element of dom.window.document.querySelectorAll('input'))element.getClientRects=()=>[{width:100,height:20}];
  const password=dom.window.document.getElementById('password');
  const otp=dom.window.document.getElementById('otp');
  const events=[];password.addEventListener('input',()=>events.push('input'));
  const inspected=inspectControls('a'.repeat(48));
  assert.equal(inspected.origin,'https://example.test');
  assert.equal(inspected.controls.length,2);
  assert.equal(JSON.stringify(inspected).includes('SyntheticSecret!'),false);
  assert.deepEqual(fillControls('b'.repeat(48),'https://example.test',
   [{index:0,token:'current-password',value:'SyntheticSecret!'}]),{refused:'inspection_stale'});
  assert.deepEqual(fillControls('a'.repeat(48),'https://other.test',
   [{index:0,token:'current-password',value:'SyntheticSecret!'}]),{refused:'origin_changed'});
  assert.deepEqual(fillControls('a'.repeat(48),'https://example.test',
   [{index:1,token:'current-password',value:'SyntheticSecret!'}]),{refused:'inspection_stale'});
  assert.equal(password.value,'');
  assert.deepEqual(fillControls('a'.repeat(48),'https://example.test',[
   {index:0,token:'current-password',value:'SyntheticSecret!'},
   {index:1,token:'one-time-code',value:'123456'},
  ]),{filled:2});
  assert.equal(password.value,'SyntheticSecret!');assert.equal(otp.value,'123456');
  assert.deepEqual(events,['input']);
  assert.deepEqual(fillControls('a'.repeat(48),'https://example.test',
   [{index:0,token:'current-password',value:'NewSecret'}]),{refused:'inspection_stale'});
 }finally{
  for(const name of names)if(previous[name]===undefined)delete globalThis[name];else globalThis[name]=previous[name];
  dom.window.close();
 }
});

test('Vault 检查后字段被禁用、只读、隐藏或改成新密码时拒绝填写',()=>{
 // 中文注释：两阶段检查之间页面可改变字段；旧 nonce 不能绕过当前可填写性。
 const dom=new JSDOM('<input id="password" type="password" autocomplete="current-password">',{url:'https://example.test/login'});
 const names=['document','location','HTMLInputElement','InputEvent','Event','getComputedStyle'];
 const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
 for(const name of names)globalThis[name]=dom.window[name];
 try{
  const input=dom.window.document.querySelector('input');input.getClientRects=()=>[{width:100,height:20}];
  for(const change of [()=>{input.disabled=true;},()=>{input.readOnly=true;},()=>{input.style.visibility='hidden';},()=>{input.autocomplete='new-password';}]){
   input.disabled=false;input.readOnly=false;input.style.visibility='';input.autocomplete='current-password';input.value='';
   inspectControls('c'.repeat(48));change();
   assert.deepEqual(fillControls('c'.repeat(48),'https://example.test',
    [{index:0,token:'current-password',value:'SyntheticSecret!'}]),{refused:'inspection_stale'});
   assert.equal(input.value,'');
  }
 }finally{
  delete globalThis.__hermesVaultSlots;
  for(const name of names)if(previous[name]===undefined)delete globalThis[name];else globalThis[name]=previous[name];
  dom.window.close();
 }
});
