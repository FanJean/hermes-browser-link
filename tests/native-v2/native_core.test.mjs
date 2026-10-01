import test from 'node:test';
import assert from 'node:assert/strict';
import {openTask} from './real-session.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { trustedTask } from '../native-extension/workspace-fixture.mjs';
import { withSyntheticOverlay } from '../native-extension/overlay-fixture.mjs';

test('真实会话任务助手按公共协议区分任务动作和标签动作',async()=>{
 // 中文注释：仅替换 RPC 边界，复用真实验收助手，避免 tabs/new_tab 被错误附加 tab_id。
 const calls=[];
 const session={instance:async()=>({instanceId:'fixture'}),ui:{evaluate:async()=>true},rpc:async(owner,suffix,args)=>{
  calls.push({owner,suffix,args});
  if(suffix==='create')return {id:'fixture-task'};
  if(suffix==='get')return {state:'ready',activeMode:'full'};
  return {tabId:7};
 }};
 const task=await openTask(session,{origins:['https://example.test'],url:'https://example.test/'});
 for(const action of ['tabs','new_tab','navigate']){
  await task.run(action,action==='tabs'?{}:{url:'https://example.test/next'});
  const args=calls.at(-1).args;
  assert.equal(Object.hasOwn(args,'tab_id'),action==='navigate');
  if(action==='navigate')assert.equal(args.tab_id,7);
  assert.equal(args.task_id,'fixture-task');
 }
});

// Test-only trusted extension UI: approve exactly one payload, never full mode.
function confirmOnce(executor, command) {
  const { generation, modeGeneration = 1, allowedOrigins, ...request } = command;
  const nonce = randomUUID();
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  executor.approveAction({
    taskId: command.taskId, generation, modeGeneration, request,
    nonce, digest, expiresAt: Date.now() / 1000 + 120,
  });
  return { ...command, modeGeneration, approval: { nonce, digest } };
}

async function executeUserApproved(executor, api, command) {
  const before = api.commands.length;
  await assert.rejects(executor.execute(command), /confirmation required/);
  assert.equal(api.commands.length, before);
  const approved = confirmOnce(executor, command);
  const result = await executor.execute(approved);
  assert.equal(executor.actionGrants.size, 0);
  assert.equal(executor.tasks.get(command.taskId).policy.activeMode, 'smart');
  const after = api.commands.length;
  await assert.rejects(executor.execute(approved), /approval mismatch or consumed/);
  await assert.rejects(executor.execute(command), /confirmation required/);
  assert.equal(api.commands.length, after);
  return result;
}

const load = () => import('../../native-extension/core.mjs');
const task = () => ({
  ...trustedTask('task-v2', [7]), generation: 3,
});

function png(width, height) {
  const bytes = Buffer.alloc(44);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

function fixtureApi() {
  const commands = [];
  const detachListeners = new Set();
  const state = {
    token: 'doc-token', revision: 0, url: 'https://example.com/page', visibility:'visible',
    viewport: { width: 100, height: 80 }, dpr: 1,
    scroll: { x: 0, y: 0 }, visual: { scale: 1, x: 0, y: 0 },
  };
  const api = {
    commands,
    tabs: {
      get: async id => ({ id, url: 'https://example.com/page', windowId: 7, groupId: -1 }),
      // 中文注释：受控写动作先激活任务标签，再进行高亮和派发。
      update: async id => ({id, active: true}),
      remove: async () => {},
      goBack: async id => { api.backs = (api.backs || 0) + 1; return id; },
    },
    debugger: {
      onDetach: {
        addListener: listener => detachListeners.add(listener),
        removeListener: listener => detachListeners.delete(listener),
      },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method, params = {}) => {
        commands.push([method, params]);
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'main', loaderId: 'loader-v2', url: state.url } } };
        }
        if (method === 'DOM.getDocument') return {root:{nodeName:'HTML',children:[]}};
        if (method === 'DOM.enable' || method === 'Target.setAutoAttach') return {};
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 11 };
        if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 1, url: state.previousUrl || 'https://example.com/list' }, { id: 2, url: state.url }] };
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 100, clientHeight: 80 } };
        if (method === 'Page.captureScreenshot') return { data: png(100, 80) };
        if (method === 'Runtime.callFunctionOn') {
          // 中文注释：隔离世界安装回执与后续语义调用分别模拟。
          if (params.functionDeclaration.includes('globalThis.__hermesSemanticLibrary={')) return {result:{value:true}};
          if (params.objectId) return { result: { value: false } };
          const op = params.arguments?.[0]?.value;
          if (op === 'inspect') return { result: { value: { hasSensitiveValue: false } } };
          if (op === 'semantic_snapshot') {
            const binding = params.arguments?.[1]?.value?.binding;
            return { result: { value: {
              version: 2,
              binding,
              snapshotId: 'snapshot-v2', kind: 'full', mode: 'interactive',
              items: [{ ref: 'namespace:e1', role: 'button', name: 'Confirm' }],
              nextCursor: null, resync: null,
              coverage: { scanned: 1, matched: 1, returned: 1, omitted: 0, filtered: 0, truncated: 0, offset: 0, complete: true, traversalComplete: true, scope: 'light-dom; no iframe/shadow traversal' },
              budget: { kind: 'estimated', method: 'ceil(JSON.stringify(response).length/4)', limit: 1200 },
            } } };
          }
          // 中文注释：滚入与稳定检查读取的目标矩形；固定值表示目标静止。
          if (op === 'reveal_ref') return {result:{value:{rect:[10,10,20,10],scrolled:false}}};
          if (op === 'rect_ref') return {result:{value:[10,10,20,10]}};
          // 中文注释：受控页面回执模拟目标确实收到可信 click，避免仅凭 CDP 命令完成就报告成功。
          if (op === 'input_visibility' || op === 'arm_ref_delivery') return {result:{value:{visibility:'visible'}}};
          if (op === 'probe_ref_delivery') return {result:{value:{visibility:'visible',global:{pointerdown:1,mousedown:1,click:1},target:{trustedClick:1,click:1}}}};
          if (op === 'clear_ref_delivery') return {result:{value:{ok:true}}};
          if (op === 'assess_ref_fill') return { result: { value: { targetAssessment: 'ordinary' } } };
          // 中文注释：语义引用只读出目标坐标，点击由 CDP 鼠标事件承担。
          if (op === 'pointer_target') return { result: { value: { x: 20, y: 15 } } };
          if (op === 'ref_fill') return { result: { value: { filled: true, kind: 'dom-synthetic' } } };
          return { result: { value: { ok: true } } };
        }
        if (method === 'Runtime.evaluate') {
          const expression = params.expression || '';
          if (expression.includes(')("state"')) return { result: { value: { ...state, token: state.token } } };
          if (expression.includes(')("bounds"')) return { result: { value: { ref: 'node-ref', rect: { x: 10, y: 10, width: 20, height: 10 } } } };
          if (expression.includes(')("check"')) return { result: { value: { ok: true } } };
          // 中文注释：坐标点击只有页面目标捕获到可信 click 才算送达。
          if (expression.includes(')("probe"')) return { result: { value: {global:{pointerdown:1,mousedown:1,click:1,pointerup:1},target:{pointerdown:1,trustedClick:1}} } };
          return { result: { value: { ok: true } } };
        }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } };
        if (method === 'Runtime.releaseObject') return {};
        if (method === 'Input.dispatchMouseEvent' || method === 'Input.cancelDragging') return {};
        throw new Error(`unexpected CDP method ${method}`);
      },
    },
  };
  api.debugger = withSyntheticOverlay(api.debugger);
  api.state = state;
  return api;
}

const scope = action => ({
  taskId: 'task-v2', generation: 3, tabId: 7, action,
  allowedOrigins: ['https://example.com'],
});

test('shared native executor routes semantic snapshot and exact ref actions', async () => {
  const { Executor } = await load();
  const api = fixtureApi();
  const executor = new Executor(api);
  await executor.approve(task());

  const snapshot = await executor.execute({
    ...scope('semantic_snapshot'),
    options: { mode: 'interactive', query: 'Confirm', roles: ['button'], viewport: true, budget: 1200 },
  });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.binding.taskId, 'task-v2');
  assert.equal(snapshot.items[0].ref, 'namespace:e1');

  const token = { ...snapshot.binding, snapshotId: snapshot.snapshotId, ref: snapshot.items[0].ref };
  assert.deepEqual(await executeUserApproved(executor, api, { ...scope('ref_click'), binding: snapshot.binding, snapshotId: token.snapshotId, ref: token.ref }), { clicked: true, kind: 'trusted-input', delivery: 'confirmed', effect: 'unverified', popupOwnership: 'uncertain' });
  assert.deepEqual(await executeUserApproved(executor, api, { ...scope('ref_fill'), binding: snapshot.binding, snapshotId: token.snapshotId, ref: token.ref, text: 'draft' }), { filled: true, kind: 'dom-synthetic' });
  assert.ok(api.commands.some(([method, params]) => method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === 'semantic_snapshot'));
});

test('a dispatched click that navigates off the approved site is reported, not denied', async () => {
  const { Executor } = await load();
  const api = fixtureApi();
  const executor = new Executor(api);
  await executor.approve(task());
  const snapshot = await executor.execute({ ...scope('semantic_snapshot'), options: { mode: 'interactive' } });
  // 中文注释：点击派发后标签页已跳到授权范围外，但文档代次事件尚未到达。
  let left = false;
  const send = api.debugger.sendCommand;
  api.debugger.sendCommand = async (target, method, params) => {
    const reply = await send(target, method, params);
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') left = true;
    return reply;
  };
  const get = api.tabs.get;
  api.tabs.get = async id => left ? { ...(await get(id)), url: 'https://elsewhere.test/' } : get(id);
  const result = await executeUserApproved(executor, api, { ...scope('ref_click'), binding: snapshot.binding, snapshotId: snapshot.snapshotId, ref: snapshot.items[0].ref });
  assert.deepEqual(result, { clicked: true, kind: 'trusted-input', delivery: 'confirmed', effect: 'unverified', popupOwnership: 'uncertain', documentChanged: true, outOfScope: true });
});

test('shared native executor preserves V1 screenshot and accepts V1.1 bound interactions', async () => {
  const { Executor } = await load();
  const api = fixtureApi();
  const executor = new Executor(api);
  await executor.approve(task());

  const shot = await executor.execute(scope('screenshot'));
  assert.equal(shot.data, png(100, 80));
  assert.equal(api.commands.filter(([method]) => method === 'Page.captureScreenshot').length, 1);
  const captured = await executor.execute(scope('interaction.capture'));
  assert.equal(captured.image.mimeType, 'image/png');
  assert.equal(captured.image.data, shot.data);
  const bound = await executor.execute({ ...scope('interaction.bounds'), screenshotId: captured.id, selector: '#button' });
  assert.equal(bound.ref, 'node-ref');
  assert.deepEqual(bound.imageCenter, { x: 20, y: 15 });
  await assert.rejects(executor.execute({ ...scope('interaction.click'), screenshotId: 'stale', point: bound.imageCenter, expectedRef: bound.ref }), /confirmation required/);
  assert.equal(api.commands.filter(([method]) => method === 'Input.dispatchMouseEvent').length, 0);
  assert.deepEqual(await executeUserApproved(executor, api, { ...scope('interaction.click'), screenshotId: captured.id, point: bound.imageCenter, expectedRef: bound.ref }), { ok: true, kind: 'coordinate-click', delivery: 'confirmed' });
  assert.equal(api.commands.filter(([method]) => method === 'Input.dispatchMouseEvent').length, 3);
  await assert.rejects(executor.execute({ ...scope('interaction.bounds'), screenshotId: 'stale', selector: '#button' }), /UNKNOWN_SCREENSHOT/);
  await assert.rejects(executor.execute({ ...scope('raw_cdp') }), /V1 unsupported action/);
  assert.equal(executor.actionGrants.size, 0);
});

test('shared native executor rejects stale generation before semantic and interaction dispatch', async () => {
  const { Executor } = await load();
  const api = fixtureApi();
  const executor = new Executor(api);
  await executor.approve(task());
  // Approval immediately covers the tab with the overlay; settle that before counting.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  const baseline = api.commands.length;
  await assert.rejects(executor.execute({ ...scope('semantic_snapshot'), generation: 2 }), /stale generation/);
  await assert.rejects(executor.execute({ ...scope('interaction.capture'), generation: 2 }), /stale generation/);
  await assert.rejects(executor.execute({ ...scope('interaction.capture'), allowedOrigins: ['https://evil.example'] }), /origin authority mismatch/);
  await assert.rejects(executor.execute({ ...scope('interaction.capture'), tabId: 8 }), /tab lease denied/);
  assert.equal(api.commands.length, baseline);
});

test('back only returns to an approved page and scroll dispatches one wheel step', async () => {
  const { Executor } = await load();
  const api = fixtureApi();
  const executor = new Executor(api);
  await executor.approve(task());
  // 中文注释：滚动属于页面交互，智能审批下须先取得本次动作批准。
  const scroll={...scope('scroll'),direction:'down'};
  await assert.rejects(executor.execute(scroll),/confirmation required/);
  assert.equal(api.commands.some(([method])=>method==='Input.dispatchMouseEvent'),false);
  const scrolled = await executor.execute(confirmOnce(executor,scroll));
  assert.deepEqual(scrolled, { tabId: 7, scrolled: true, direction: 'down' });
  const wheel = api.commands.find(([method]) => method === 'Input.dispatchMouseEvent');
  assert.equal(wheel[1].type, 'mouseWheel');
  assert.equal(wheel[1].deltaY, 64);

  api.state.previousUrl = 'https://evil.test/';
  await assert.rejects(executeUserApproved(executor, api, scope('back')), /origin/);
  assert.equal(api.backs || 0, 0, 'a disallowed previous page is never navigated to');
});

test('background wheel request has its own deadline', async () => {
 // 中文注释：模拟后台页 CDP 滚轮回执永久挂起，动作须在扩展总超时前返回固定错误。
 const {Executor}=await load(),api=fixtureApi(),send=api.debugger.sendCommand;
 api.debugger.sendCommand=(target,method,params)=>method==='Input.dispatchMouseEvent'&&params.type==='mouseWheel'
  ? new Promise(()=>{}) : send(target,method,params);
 const executor=new Executor(api);await executor.approve(task());
 const scroll={...scope('scroll'),direction:'down'};
 await assert.rejects(Promise.race([executor.execute(confirmOnce(executor,scroll)),
  new Promise((_,reject)=>setTimeout(()=>reject(Error('action deadline missing')),4000))]),/SCROLL_TIMEOUT/);
});

test('scroll deadline covers layout lookup and prevents a late wheel', async () => {
 // 中文注释：布局回执迟到时不允许在动作超时后再派发滚轮。
 const {Executor}=await load(),api=fixtureApi(),send=api.debugger.sendCommand;
 let finishLayout;
 api.debugger.sendCommand=(target,method,params)=>method==='Page.getLayoutMetrics'
  ? new Promise(resolve=>{finishLayout=resolve;}) : send(target,method,params);
 const executor=new Executor(api);await executor.approve(task());
 const scroll={...scope('scroll'),direction:'down'};
 await assert.rejects(executor.execute(confirmOnce(executor,scroll)),/SCROLL_TIMEOUT/);
 finishLayout({cssLayoutViewport:{clientWidth:100,clientHeight:80}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(api.commands.some(([method])=>method==='Input.dispatchMouseEvent'),false);
});

test('official blank work tab ignores late seed events and drops its allowance on a real navigation',async()=>{
 const {Executor}=await load(),events=[];
 let current={url:'https://example.com/',pendingUrl:undefined};
 const executor=new Executor({tabs:{get:async()=>({...current,id:7})}},event=>events.push(event));
 const local={id:'blank-task',generation:1,allowedOrigins:['https://example.com'],
  officialBlank:new Set([7]),officialBlankSeeds:new Map([[7,'https://example.com/']]),officialBlankSeen:new Set(),
  tabIds:new Set([7]),agentTabs:new Set([7])};
 executor.tasks.set(local.id,local);executor.leases.set(7,local.id);
 executor.closeTabResources=async()=>({cleanupState:'succeeded'});
 executor.documentChanged=async()=>true;
 executor.restoreOverlay=()=>Promise.resolve(null);
 // 中文注释：建页种子 URL 的延迟通知不应撤销即将到来的官方 about:blank 导航。
 await executor.tabEvent(7,'navigated','https://example.com/',{status:'complete',urlChanged:true});
 assert.deepEqual(events,[]);
 current={url:'about:blank',pendingUrl:undefined};
 await executor.tabEvent(7,'navigated','about:blank',{status:'complete',urlChanged:true});
 assert.equal(events.at(-1).url,'about:blank');
 const count=events.length;
 await executor.tabEvent(7,'navigated','https://example.com/',{status:'complete',urlChanged:true});
 assert.equal(events.length,count,'旧种子事件不得覆盖已提交的空白页状态');
 current={url:'https://example.com/',pendingUrl:undefined};
 await executor.tabEvent(7,'navigated','https://example.com/',{status:'complete',urlChanged:true});
 assert.equal(events.at(-1).url,'https://example.com/');
 assert.equal(local.officialBlank.has(7),false);
});

test('gateway close marks its debugger detach as expected until tab removal is observed',async()=>{
 const {Executor}=await load(),events=[];
 let executor;
 const api={tabs:{get:async()=>({url:'https://close.test/'}),remove:async id=>{assert.equal(id,7);assert.equal(executor.closingTabs.has(7),true);}},
  debugger:{getTargets:async()=>[{id:'T7',tabId:7,type:'page'}]}};
 executor=new Executor(api,event=>events.push(event));
 const local={id:'close-task',generation:1,revoked:false,allowedOrigins:['https://close.test'],policy:{activeMode:'full',modeGeneration:1},agentTabs:new Set([7]),tabIds:new Set([7])};
 executor.tasks.set(local.id,local);executor.leases.set(7,local.id);
 executor.pageRuntime.assert=()=>({});
 executor.closeTabResources=async()=>({cleanupState:'succeeded'});
 assert.deepEqual(await executor.gateway('browser.cdp_close',{taskId:local.id,generation:1,modeGeneration:1,targetId:'T7'}),{success:true});
 assert.equal(executor.closingTabs.has(7),true);
 await executor.tabEvent(7,'closed');
 assert.equal(executor.closingTabs.has(7),false);
 assert.equal(executor.leases.has(7),false);
 assert.equal(events.at(-1).event,'closed');
});
