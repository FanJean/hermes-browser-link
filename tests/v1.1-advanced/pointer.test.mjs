import test from 'node:test';
import assert from 'node:assert/strict';
import {Interactions,createChromeDebuggerAdapter} from '../../browser-interactions/index.mjs';

const scope={taskId:'owned',generation:3};
const state=()=>({documentId:'document',token:'token',url:'https://example.test/',
 viewport:{width:800,height:600},dpr:2,scroll:{x:0,y:0},visual:{scale:1,x:0,y:0}});

test('语义目标指针点击只派发一次按下和释放',async()=>{
 const sent=[],checks=[],adapter={evaluate:async()=>state(),verifyHit:async(_point,options)=>checks.push(options),send:async(_method,event)=>sent.push(event.type)};
 const interaction=new Interactions(adapter,scope);
 const result=await interaction.clickBoundTarget(scope,{readTarget:async()=>({x:100,y:80})});
 assert.equal(result.kind,'pointer-click');
 assert.deepEqual(sent,['mouseMoved','mousePressed','mouseReleased']);
 assert.deepEqual(checks,[{allowOpenShadow:true,allowClosedShadow:true},{allowOpenShadow:true,allowClosedShadow:true}]);
});

test('跨进程指针适配器固定任务标签页和子会话',async()=>{
 const calls=[],listeners=new Set();
 const debuggerAPI={sendCommand:async(target,method)=>{calls.push({target,method});return {};},
  onDetach:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}};
 const adapter=createChromeDebuggerAdapter(debuggerAPI,{tabId:7,sessionId:'child-session'});
 await adapter.send('Page.enable');
 assert.deepEqual(calls[0].target,{tabId:7,sessionId:'child-session'});
 adapter.close();assert.equal(listeners.size,0);
});

test('悬停后目标移动或任务变更时不派发按下',async()=>{
 let reads=0;const sent=[];
 const adapter={evaluate:async()=>state(),verifyHit:async()=>{},send:async(_method,event)=>sent.push(event.type)};
 const interaction=new Interactions(adapter,scope);
 await assert.rejects(interaction.clickBoundTarget(scope,{readTarget:async()=>({x:100+10*reads++,y:80})}),{code:'NODE_MOVED'});
 assert.deepEqual(sent,['mouseMoved']);
 await assert.rejects(interaction.clickBoundTarget({...scope,taskId:'foreign'},{readTarget:async()=>({x:100,y:80})}),{code:'SCOPE_MISMATCH'});
 assert.deepEqual(sent,['mouseMoved']);
});

test('悬停引发页面滚动时不派发按下',async()=>{
 const sent=[];let current=state();
 const adapter={evaluate:async()=>current,verifyHit:async()=>{},send:async(_method,event)=>{
  sent.push(event.type);if(event.type==='mouseMoved')current={...state(),scroll:{x:0,y:20}};
 }};
 const interaction=new Interactions(adapter,scope);
 await assert.rejects(interaction.clickBoundTarget(scope,{readTarget:async()=>({x:100,y:80})}),{code:'TARGET_CHANGED'});
 assert.deepEqual(sent,['mouseMoved']);
});
