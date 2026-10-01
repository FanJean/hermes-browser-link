import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';
import {inspectPage,Executor,semanticWorldDeclaration,maskCapturePng} from '../../native-extension/core.mjs';

function page(markup){
 const dom=new JSDOM(markup,{url:'https://fixture.test/',pretendToBeVisual:true});
 const {document}=dom.window;
 dom.window.HTMLElement.prototype.getClientRects=function(){return this.style.display==='none'?[]:[this.getBoundingClientRect()];};
 dom.window.HTMLElement.prototype.getBoundingClientRect=function(){
  const top=this.id==='submit-below'?1200:10;
  return {left:10,top,right:130,bottom:top+30,width:120,height:30};
 };
 return {dom,document};
}

test('首屏外的 CF7 submit 和图片按钮按 HTML-AAM 命名',()=>{
 const {dom,document}=page('<input type="submit" id="submit-below" value="Submit"><input type="image" alt="Image Submit"><input type="reset"><button>Submit</button>');
 const semantics=createPageSemantics({document,taskId:'t',documentId:'d',leaseId:'l'});
 try{
  const rows=semantics.snapshot({mode:'interactive',budget:5000}).items;
  assert.equal(rows.filter(row=>row.name==='Submit'&&row.role==='button').length,2);
  assert.ok(rows.some(row=>row.name==='Image Submit'&&row.role==='button'));
  assert.ok(rows.some(row=>row.name==='Reset'&&row.role==='button'));
 }finally{semantics.revoke();dom.window.close();}
});

test('隐藏 token 不拦截截图，可见密码框只返回固定名称和矩形',()=>{
 const {dom,document}=page('<input type="hidden" name="auth_token" value="synthetic-token"><input id="password" type="password" value="synthetic-secret"><input id="offscreen" type="password" value="offscreen-secret">');
 const saved={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,
  innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
 try{
  document.querySelector('#offscreen').getBoundingClientRect=()=>({left:2000,top:10,right:2100,bottom:40,width:100,height:30});
  globalThis.document=document;globalThis.location=dom.window.location;
  globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);globalThis.innerWidth=800;globalThis.innerHeight=600;
  const result=inspectPage(['https://fixture.test']);
  assert.equal(result.hasSensitiveValue,true);
  assert.deepEqual(result.rects,[{x:10,y:10,width:120,height:30,kind:'sensitive_field',role:'input',name:'敏感字段'}]);
  assert.doesNotMatch(JSON.stringify(result),/synthetic|offscreen-secret/);
 }finally{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  dom.window.close();
 }
});

test('封闭 Shadow Root 内跨源框架按后端节点矩形进入遮罩清单',async()=>{
 const calls=[];
 const api={tabs:{get:async()=>({id:7,url:'https://fixture.test/'})},debugger:{
  onEvent:{addListener(){},removeListener(){}},attach:async()=>{},detach:async()=>{},
  sendCommand:async(_target,method,params={})=>{
   calls.push(method);
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'doc',url:'https://fixture.test/'},childFrames:[{frame:{id:'child',loaderId:'child-doc',url:'https://cross.test/'}}]}};
   if(method==='DOM.getDocument')return {root:{nodeName:'HTML',children:[{nodeName:'DIV',shadowRoots:[{nodeName:'#shadow-root',shadowRootType:'closed',children:[{nodeName:'IFRAME',frameId:'child',backendNodeId:9}]}]}]}};
   if(method==='DOM.getBoxModel')return {model:{border:[40,50,260,50,260,140,40,140]}};
   if(method==='Page.createIsolatedWorld')return {executionContextId:17};
   if(method==='Runtime.callFunctionOn')return {result:{value:{hasSensitiveValue:false,rects:[]}}};
   return {};
  },
 }};
 const executor=new Executor(api),task={id:'mask-task',generation:1,instanceId:'chrome',approvalScope:'owner',allowedOrigins:['https://fixture.test'],tabIds:[7]};
 await executor.approve(task);
 const masks=await executor.assertSafeCapture({tabId:7},executor.tasks.get(task.id),()=>{});
 assert.deepEqual(masks,[{x:40,y:50,width:220,height:90,kind:'uninspectable_frame',role:'iframe',name:'不可检查的框架'}]);
 assert.ok(calls.includes('DOM.getBoxModel'));
});

test('透明单选框改用关联 label 命中；弹窗遮挡仍拒绝',()=>{
 const {dom,document}=page('<label id="wrap"><input id="radio" type="radio" name="plan" style="opacity:0"><span id="face">Freemium</span></label><input id="separate" type="checkbox" style="opacity:0"><label id="separate-label" for="separate">Paid</label><div id="modal"></div>');
 const saved={document:globalThis.document,window:globalThis.window,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight,
  __hermesNativeSemanticsV2:globalThis.__hermesNativeSemanticsV2};
 try{
  globalThis.document=document;globalThis.window=dom.window;globalThis.innerWidth=800;globalThis.innerHeight=600;
  let popup=false,face=document.querySelector('#face');
  document.elementFromPoint=()=>popup?document.querySelector('#modal'):face;
  const world=vm.runInThisContext(`(${semanticWorldDeclaration})`);
  const binding={taskId:'t',documentId:'d',leaseId:'l'};
  const shot=world('semantic_snapshot',{binding,options:{mode:'interactive',budget:5000}});
  for(const id of ['radio','separate']){
   face=id==='radio'?document.querySelector('#face'):document.querySelector('#separate-label');
   const item=shot.items.find(row=>document.querySelector(`#${id}`).labels[0].textContent.trim()===row.name);
   assert.ok(item,id);
   const point=world('pointer_target',{binding,snapshotId:shot.snapshotId,ref:item.ref,checked:true});
   assert.equal(point.x,70);
  }
  popup=true;
  face=document.querySelector('#face');
  const radio=shot.items.find(row=>row.name==='Freemium');
  assert.throws(()=>world('pointer_target',{binding,snapshotId:shot.snapshotId,ref:radio.ref,checked:true}),/TARGET_OCCLUDED/);
 }finally{
  globalThis.__hermesNativeSemanticsV2?.semantics?.revoke();
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  dom.window.close();
 }
});

test('截图遮罩按 CSS 矩形覆盖像素，区域内不保留原像素',async()=>{
 // 中文注释：离线画布模拟只核对像素坐标与覆盖；真实 PNG 编码留给浏览器验收。
 const saved={createImageBitmap:globalThis.createImageBitmap,OffscreenCanvas:globalThis.OffscreenCanvas};
 const original=new Uint8Array(4*4*4).fill(255);
 try{
  globalThis.createImageBitmap=async()=>({width:4,height:4,pixels:original});
  globalThis.OffscreenCanvas=class{
   constructor(){this.pixels=new Uint8Array(original.length);}
   getContext(){return {drawImage:bitmap=>this.pixels.set(bitmap.pixels),set fillStyle(_value){},fillRect:(x,y,w,h)=>{
    for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){
     const offset=(row*4+col)*4;this.pixels.set([32,33,36,255],offset);
    }
   }};}
   async convertToBlob(){return new Blob([this.pixels],{type:'image/png'});}
  };
  const result=await maskCapturePng(Buffer.from(original).toString('base64'),[{x:1,y:1,width:2,height:2}],{width:4,height:4});
  const pixels=Buffer.from(result,'base64');
  for(let row=0;row<4;row++)for(let col=0;col<4;col++){
   const offset=(row*4+col)*4;
   assert.deepEqual([...pixels.subarray(offset,offset+4)],row>=1&&row<3&&col>=1&&col<3?[32,33,36,255]:[255,255,255,255]);
  }
 }finally{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
 }
});
