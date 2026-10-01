import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor,fileUploadVisualTarget} from '../../native-extension/core.mjs';

test('隐藏文件输入优先高亮关联标签，无标签时可视化降级',()=>{
 // 中文注释：只测试高亮目标选择；来源、文件路径和实际派发由原执行链校验。
 const dom=new JSDOM('<label class="upload">Logo<input id="logo" type="file" style="display:none"></label><input id="shot" type="file" style="display:none"><input id="shown" type="file">',
  {url:'https://example.test/',pretendToBeVisual:true});
 try{
  const doc=dom.window.document,label=doc.querySelector('label'),logo=doc.querySelector('#logo');
  label.getClientRects=()=>[{width:120,height:50}];
  label.getBoundingClientRect=()=>({left:10,top:10,right:130,bottom:60,width:120,height:50});
  assert.equal(fileUploadVisualTarget(logo),label);
  assert.equal(fileUploadVisualTarget(doc.querySelector('#shot')),null);
  const shown=doc.querySelector('#shown');shown.getClientRects=()=>[{width:80,height:20}];
  shown.getBoundingClientRect=()=>({left:20,top:80,right:100,bottom:100,width:80,height:20});
  assert.equal(fileUploadVisualTarget(shown),shown);
 }finally{dom.window.close();}
});

test('文件上传缺少可见高亮目标时仍能派发并保留回读',async()=>{
 // 中文注释：仅上传动作允许高亮视觉降级，准备失败不等于文件输入授权失败。
 const executor=Object.create(Executor.prototype),task={id:'task',generation:1,interactionOperations:new Set()};
 executor.observers={pending:()=>false};executor.api={debugger:{}};
 executor.checkedFrameTree=async()=>({frame:{loaderId:'loader'}});
 executor.overlayCall=async()=>true;
 executor.timed=async(_request,_stage,work)=>work();
 executor.interactionCleanupCall=async()=>({ok:true});
 const result=await executor.withInteractionHighlight({t:task,p:{tabId:7,action:'files.upload'},entry:{documentId:'loader'},
  guard:()=>{},prepare:async()=>({ok:false,code:'INVALID_TARGET'}),verify:async()=>{throw Error('unexpected verify');},
  dispatch:async()=>({selectedCount:1,selectedFiles:['logo.png'],selectionState:'applied'}),visualOnly:true});
 assert.deepEqual(result.selectedFiles,['logo.png']);
 assert.equal(result.selectedCount,1);
});
