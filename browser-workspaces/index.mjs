// Only trusted bootstrap code may hold this issuer. Capabilities do not survive JSON.
export function createAuthority(instance) {
  if (typeof instance !== 'string' || !instance) throw Error('INVALID_INSTANCE');
  const issued = new WeakMap(), generations = new Map();
  const ownerKey = id => JSON.stringify([id.owner, id.task]);
  return Object.freeze({instance,
    issue({owner, task, generation, windowId}) {
      if (![owner, task].every(x => typeof x === 'string' && x.length > 0 && x.length <= 128) || !Number.isSafeInteger(generation) || generation < 1 || !Number.isInteger(windowId) || windowId < 0) throw Error('INVALID_IDENTITY');
      const id = Object.freeze({instance, owner, task, generation, windowId});
      const key = ownerKey(id);
      if (generation < (generations.get(key) || 0)) throw Error('STALE');
      generations.set(key, generation);
      const cap = Object.freeze({}); issued.set(cap, id); return cap;
    },
    resolve(cap, {allowStale = false} = {}) {
      const id = issued.get(cap); if (!id) throw Error('UNTRUSTED');
      if (!allowStale && generations.get(ownerKey(id)) !== id.generation) throw Error('STALE');
      return id;
    }
  });
}

// Tab group label: short task name, stripped of control/bidi/format characters.
export const DEFAULT_GROUP_TITLE = 'AI 工作';
export function groupTitle(title) {
  if (typeof title !== 'string') return DEFAULT_GROUP_TITLE;
  const clean = [...title.normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()];
  if (!clean.length) return DEFAULT_GROUP_TITLE;
  return clean.length > 16 ? clean.slice(0, 15).join('') + '…' : clean.join('');
}

// 中文注释：启动监听必须在 worker 顶层注册；先同步撤权，再串行作废磁盘日志，避免 ready 的旧读取恢复删除权。
const startupStates = new WeakMap();
const storageKey = 'hermes.backgroundWorkspaces.v1';
export function registerWorkspaceStartup(chrome) {
  if (startupStates.has(chrome.storage)) return startupStates.get(chrome.storage);
  const state = {epoch: 0, barrier: Promise.resolve(), invalidate: new Set()};
  startupStates.set(chrome.storage, state);
  chrome.runtime?.onStartup?.addListener(() => {
    state.epoch++;
    for (const invalidate of state.invalidate) invalidate();
    state.barrier = state.barrier.then(async () => {
      const stored = (await chrome.storage.local.get(storageKey))[storageKey];
      if (!stored) return;
      for (const [, t] of stored.tasks) {t.baseline = null; t.restartInvalidated = true;}
      await chrome.storage.local.set({[storageKey]: stored});
    });
  });
  return state;
}

// 中文注释：一个 worker 使用一个管理器；local 日志跨扩展重载，浏览器启动事件单独撤销旧记录删除权。
export function createWorkspaces({chrome, authority}) {
  const startup = registerWorkspaceStartup(chrome), loadEpoch = startup.epoch;
  const tasks = new Map(), cancelled = new Set(), preserved = new Set(), kept = new Map(), deletionLimits = new Map(), deletionGuards = new Map(), spawning = new Set();
  // 中文注释：任务分别排队，整份 local 日志的写入独立串行。
  const tails = new Map();let saveTail = Promise.resolve(),globalTail=Promise.resolve();
  // 中文注释：同一任务不同代次仍共用队列，恢复不能越过旧代次在途创建。
  const enqueue = (key,fn) => {key=key==='reconcile'?key:JSON.stringify(JSON.parse(key).slice(0,3));const p = (key==='reconcile'?Promise.all([globalTail,...tails.values()]):Promise.all([globalTail,tails.get(key)||Promise.resolve()])).then(fn),settled=p.catch(()=>{});tails.set(key,settled);if(key==='reconcile')globalTail=settled;void settled.then(()=>{if(tails.get(key)===settled)tails.delete(key);});return p;};
  const identity = (cap, allowStale = false) => {
    const id = authority.resolve(cap, {allowStale});
    return {id, key: JSON.stringify([id.instance, id.owner, id.task, id.generation])};
  };
  // 中文注释：local 日志不会随会话清空，只持久化仍可能需要清理的任务。已结束且页面全部释放、或已被浏览器重启
  // 撤权的任务只留在内存围栏中（旧能力句柄不会跨 worker 存活）；其余已结束任务最多保留最近 200 条。
  const MAX_PERSISTED_TERMINAL = 200;
  const persistedKeys = () => {
    const settled = t => [...t.requests.values()].every(r => r.status === 'released');
    const terminal = [...tasks.keys()].filter(key => cancelled.has(key));
    const dropped = new Set(terminal.filter(key => {const t = tasks.get(key);return t.restartInvalidated || (!preserved.has(key) && settled(t));}));
    const retained = terminal.filter(key => !dropped.has(key));
    for (const key of retained.slice(0, Math.max(0, retained.length - MAX_PERSISTED_TERMINAL))) dropped.add(key);
    return new Set([...tasks.keys()].filter(key => !dropped.has(key)));
  };
  const save = () => {const next=saveTail.then(async()=>{await startup.barrier;const keep=persistedKeys();return chrome.storage.local.set({[storageKey]: {
    instance: authority.instance,
    tasks: [...tasks].filter(([key]) => keep.has(key)).map(([key, t]) => [key, {...t, requests: [...t.requests]}]),
    deletionLimits: [...deletionLimits].filter(([key]) => keep.has(key)).map(([key, ids]) => [key, [...ids]]),
    cancelled: [...cancelled].filter(key => keep.has(key)), preserved: [...preserved].filter(key => keep.has(key)),
    kept: [...kept].filter(([key]) => keep.has(key)).map(([key, ids]) => [key, [...ids]])
  }});});saveTail=next.catch(()=>{});return next;};
  // Scope binds the negative authority to browser instance, owner, task and generation.
  // 中文注释：浏览器重启后 baseline 作废，旧 tabId 即使重新分配也不能成为删除依据。
  const invalidate = () => {for (const t of tasks.values()) {t.baseline = null; t.restartInvalidated = true;}};
  startup.invalidate.add(invalidate);
  const validBaseline = (t, key) => !t.restartInvalidated && t.baseline?.scope === key && Array.isArray(t.baseline.tabIds) && t.baseline.tabIds.every(id => Number.isInteger(id) && id >= 0);
  const protectedTab = (t, key, tabId) => !validBaseline(t, key) || t.baseline.tabIds.includes(tabId);
  async function ensureTask(id, key) {
    let t = tasks.get(key);
    if (!t) {
      let baseline = null;
      try {
        const tabs = await chrome.tabs.query({});
        if (Array.isArray(tabs) && tabs.every(tab => Number.isInteger(tab.id) && tab.id >= 0)) baseline = {scope: key, tabIds: [...new Set(tabs.map(tab => tab.id))]};
      } catch { /* Missing inventory only subtracts deletion authority. */ }
      t = {windowId: id.windowId, groupId: null, requests: new Map(), baseline};
      tasks.set(key, t);
      await save(); // Durable protection before task execution or browser side effects.
    }
    if (t.windowId !== id.windowId) throw Error('WINDOW_MISMATCH');
    return t;
  }
  async function start(cap) {
    const {id, key} = identity(cap);
    return enqueue(key,async () => {await ready; identity(cap); if (cancelled.has(key)) throw Error('CANCELLED'); await ensureTask(id, key); await save();});
  }
  function isMissingTabError(error, id) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const match = /^No tab with id:\s*(\d+)\.?$/.exec(message);
    return match?.[1] === String(id);
  }
  async function inspectTab(id) {
    try {return {kind: 'present', tab: await chrome.tabs.get(id)};}
    catch (error) {return {kind: isMissingTabError(error, id) ? 'missing' : 'unknown'};}
  }
  async function ownership(t, r) {
    const result = await inspectTab(r.tabId);
    if (result.kind !== 'present') return result.kind;
    // 中文注释：不完整或串页的读取回执不能成为清理身份依据。
    if (result.tab.id !== r.tabId) return 'unknown';
    if (result.tab.windowId !== t.windowId || result.tab.groupId !== r.groupId) return 'moved';
    // 中文注释：未完成分组仅信任本 worker；已分组的页以私有创建日志、组 ID 和窗口判断，标题可修改。
    if (r.groupId === -1) return r.restored ? 'unknown' : 'owned';
    if(t.restartInvalidated)return 'unknown';
    try {const group = await chrome.tabGroups.get(r.groupId);return group.id === r.groupId && group.windowId === t.windowId ? 'owned' : 'moved';}
    catch {return 'unknown';}
  }
  async function scan(taskKey=null) {
    for (const [key,t] of tasks) {
      if(taskKey!==null&&key!==taskKey)continue;
      for (const r of t.requests.values()) {
        if (r.status !== 'ready' && !(r.status === 'unknown' && Number.isInteger(r.tabId))) continue;
        const state = await ownership(t, r);
        if (state === 'missing') {r.status = 'released';r.disposition = 'gone';r.cleanupOutcome = 'succeeded';}
        else if (state === 'unknown') {r.status = 'unknown';r.cleanupOutcome = r.cleanupOutcome || 'unknown';r.cleanupReason = r.cleanupReason || 'ownership_unavailable';}
        else if (state === 'moved' && r.status === 'ready') {r.status = 'released';r.disposition = 'moved';}
      }
      if (![...t.requests.values()].some(r => r.status === 'ready')) t.groupId = null;
    }
  }
  const ready = (async () => {
    await startup.barrier;
    const stored = (await chrome.storage.local.get(storageKey))[storageKey];
    await startup.barrier;
    if (stored?.instance === authority.instance) {
      for (const [key, t] of stored.tasks) {
        t.requests = new Map(t.requests);
        // An interrupted create/group has unknown outcome: never replay or guess ownership.
        for (const r of t.requests.values()) {r.restored = true;if (r.status === 'pending' || (r.source === 'opener' && r.status === 'ready')) r.status = 'unknown';}
        if (loadEpoch !== startup.epoch) {t.baseline = null; t.restartInvalidated = true;}
        tasks.set(key, t);
      }
      for (const key of stored.cancelled) cancelled.add(key);
      for (const key of stored.preserved || []) preserved.add(key);
      for (const [key, ids] of stored.kept || []) kept.set(key, new Set([...(kept.get(key) || []), ...ids]));
      for (const [key, ids] of stored.deletionLimits || []) if (!deletionLimits.has(key)) deletionLimits.set(key, new Set(ids));
      await scan();
    }
  })();
  async function cleanupTask(key, exactIds = deletionLimits.get(key), canDelete = deletionGuards.get(key) || (() => true)) {
    if (preserved.has(key)) return;
    const t = tasks.get(key); if (!t) return;
    for (const r of t.requests.values()) {
      if (r.status !== 'ready' || (exactIds && !exactIds.has(r.tabId))) continue;
      if (protectedTab(t, key, r.tabId) || kept.get(key)?.has(r.tabId)) {r.status = 'kept'; continue;}
      const state = await ownership(t, r);
      if (preserved.has(key)) return;
      if (protectedTab(t, key, r.tabId) || kept.get(key)?.has(r.tabId)) {r.status = 'kept'; continue;}
      if (exactIds && !exactIds.has(r.tabId)) continue;
      // 中文注释：只有期限耗尽可延期；租约冲突等否决仍永久保留，不能被后续补清理扩大权限。
      const decision = canDelete(r.tabId);
      if (decision !== true) {if (decision !== 'defer') r.status = 'kept'; continue;}
      if (state === 'missing') {
        r.status = 'released'; r.disposition = 'gone'; r.cleanupOutcome = 'succeeded';
      } else if (state === 'unknown') {
        r.cleanupOutcome = 'unknown'; r.cleanupReason = 'ownership_unavailable';
        preserved.add(key);
      } else if (state === 'owned') {
        // Chrome does not provide compare-and-delete; a user change between get/remove
        // is a residual API race. No arbitrary tab-id input is ever accepted here.
        try {await chrome.tabs.remove(r.tabId);}
        catch (error) {
          const after = await ownership(t, r);
          if (after === 'missing') {
            r.status = 'released'; r.disposition = 'gone'; r.cleanupOutcome = 'succeeded';
            continue;
          }
          if (after === 'moved') {
            r.status = 'released'; r.disposition = 'moved';
            continue;
          }
          r.cleanupOutcome = after === 'owned' ? 'failed' : 'unknown';
          r.cleanupReason = after === 'owned' ? 'remove_failed' : 'remove_readback_unavailable';
          throw error;
        }
        r.status = 'released'; r.disposition = 'removed'; r.cleanupOutcome = 'succeeded';
      } else {
        r.status = 'released'; r.disposition = 'moved';
      }
    }
    t.groupId = null;
  }
  // A resumed task (new generation) keeps working in the group its earlier
  // generation created, as long as that group still exists in the same window.
  async function priorGroup(id) {
    for (const [key, t] of tasks) {
      const [instance, owner, task, generation] = JSON.parse(key);
      if (instance !== id.instance || owner !== id.owner || task !== id.task || generation >= id.generation) continue;
      if (t.windowId !== id.windowId || !Number.isInteger(t.lastGroupId)) continue;
      try {
        const group = await chrome.tabGroups?.get?.(t.lastGroupId);
        if (!t.restartInvalidated && group?.id === t.lastGroupId && group.windowId === id.windowId) return group.id;
      } catch { /* Group closed by the user: start a new one. */ }
    }
    return null;
  }
  async function open(cap, {requestId, url, title}) {
    const {id, key} = identity(cap);
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw Error('INVALID_REQUEST');
    if (!['https:', 'http:'].includes(new URL(url).protocol)) throw Error('INVALID_URL');
    return enqueue(key,async () => {
      await ready; identity(cap);
      if (cancelled.has(key)) throw Error('CANCELLED');
      await scan(key);
      const t = await ensureTask(id, key);
      identity(cap);
      if (cancelled.has(key)) throw Error('CANCELLED');
      const prior = t.requests.get(requestId);
      if (prior) {
        if (prior.url !== url) throw Error('INVALID_REQUEST');
        if (prior.status !== 'ready') throw Error(prior.status.toUpperCase());
        return {tabId: prior.tabId, groupId: prior.groupId};
      }
      const r = {status: 'pending', url, groupTitle: groupTitle(title)}; t.requests.set(requestId, r);
      await save(); // Persist intent before any browser side effect.
      try {
        const tab = await chrome.tabs.create({url, windowId: id.windowId, active: false});
        r.tabId = tab.id;
        // A returned ID that existed at startup is not proof of creation, even if
        // unleased or subsequently regrouped. Never upgrade it to execution ownership.
        if (validBaseline(t, key) && t.baseline.tabIds.includes(tab.id)) throw Error('PREEXISTING_TAB');
        // A user may move a tab while tabs.create's response is in flight.
        const freshResult = await inspectTab(tab.id);
        if (freshResult.kind === 'unknown') {
          r.status = 'unknown'; r.cleanupOutcome = 'unknown'; r.cleanupReason = 'create_readback_unavailable';
          throw Error('WORKSPACE_UNKNOWN');
        }
        if (freshResult.kind === 'missing') {
          r.status = 'released'; r.disposition = 'gone'; r.cleanupOutcome = 'succeeded';
          throw Error('RELEASED');
        }
        const fresh = freshResult.tab;
        if (fresh.windowId !== id.windowId || fresh.groupId !== -1) {r.status = 'released'; r.disposition = 'moved'; throw Error('RELEASED');}
        if (cancelled.has(key)) {
          r.groupId = -1; r.status = 'ready';
          await cleanupTask(key); throw Error('CANCELLED');
        }
        try {identity(cap);} catch (error) {r.groupId = -1; r.status = 'ready'; cancelled.add(key); await cleanupTask(key); throw error;}
        const reuse = t.groupId === null ? await priorGroup(id) : null;
        const newGroup = t.groupId === null && reuse === null;
        const joinGroup = t.groupId ?? reuse;
        r.groupId = await chrome.tabs.group({tabIds: [tab.id], ...(newGroup ? {createProperties: {windowId: id.windowId}} : {groupId: joinGroup})});
        // Group completion is not proof the user left the tab in our group.
        const groupedResult = await inspectTab(tab.id);
        if (groupedResult.kind === 'unknown') {
          r.status = 'unknown'; r.cleanupOutcome = 'unknown'; r.cleanupReason = 'group_readback_unavailable';
          throw Error('WORKSPACE_UNKNOWN');
        }
        if (groupedResult.kind === 'missing') {
          r.status = 'released'; r.disposition = 'gone'; r.cleanupOutcome = 'succeeded';
          throw Error('RELEASED');
        }
        const grouped = groupedResult.tab;
        if (grouped.windowId !== id.windowId || grouped.groupId !== r.groupId) {
          r.status = 'released'; r.disposition = 'moved';
          throw Error('RELEASED');
        }
        t.groupId = r.groupId; t.lastGroupId = r.groupId;
        // 中文注释：先保存实际组标题再发布 ready，复用组沿用用户当前标题。
        if (newGroup) await chrome.tabGroups.update(r.groupId, {title: r.groupTitle, color: 'blue'});
        else r.groupTitle = (await chrome.tabGroups.get(r.groupId)).title;
        r.status = 'ready';
        try {identity(cap);} catch (error) {cancelled.add(key); await cleanupTask(key); throw error;}
        await save();
        if (cancelled.has(key)) {await cleanupTask(key); throw Error('CANCELLED');}
        await save();
        return {tabId: r.tabId, groupId: r.groupId};
      } catch (error) {
        if (r.status === 'pending') r.status = 'unknown';
        await save();
        throw error;
      }
    });
  }
  // Opener plus action timing is ambiguous: a concurrent user gesture is indistinguishable.
  // Ownership here never confers navigation or credential authority.
  function spawned(cap, tab) {
    const {id,key}=identity(cap,true);
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.openerTabId) || tab.windowId!==id.windowId || spawning.has(tab.id)) return Promise.resolve(null);
    spawning.add(tab.id);
    return enqueue(key,async()=>{
      await ready;
      let t=tasks.get(key);
      if(!t){t={windowId:id.windowId,groupId:null,requests:new Map()};tasks.set(key,t);}
      if([...tasks.values()].some(other=>[...other.requests.values()].some(r=>r.tabId===tab.id)))return null;
      // Record uncertainty for honest cleanup reporting, never group or delete it.
      t.requests.set(`spawn:${tab.id}`,{status:'unknown',tabId:tab.id,openerTabId:tab.openerTabId,source:'opener',reason:'ambiguous_creation'});
      await save();
      return null;
    }).finally(()=>spawning.delete(tab.id));
  }
  async function status(cap) {
    const {key}=identity(cap,true);await ready;
    const t=tasks.get(key),remainingTabIds=[],preservedTabIds=[],unknownTabIds=[];
    if(!t || !t.requests.size)return {cleanupState:'unknown',remainingTabIds,preservedTabIds,unknownTabIds,remainingCount:0,preservedCount:0,unknownCount:0,cleanupReason:'no_journal'};
    let unknownCount=0,failedCount=0;
    for(const r of t.requests.values()) {
      if(r.status==='pending'||r.status==='unknown'){unknownCount++;if(Number.isInteger(r.tabId))unknownTabIds.push(r.tabId);continue;}
      if(r.status==='kept'||r.disposition==='moved'){preservedTabIds.push(r.tabId);continue;}
      if(r.status!=='ready')continue;
      const state=await ownership(t,r);
      if(state==='missing')continue;
      if(state==='unknown'){
        unknownCount++;unknownTabIds.push(r.tabId);continue;
      }
      if(state==='moved'||protectedTab(t,key,r.tabId)||kept.get(key)?.has(r.tabId)){
        preservedTabIds.push(r.tabId);continue;
      }
      if(r.cleanupOutcome==='failed'||(r.cleanupOutcome==='unknown'&&r.cleanupReason==='remove_readback_unavailable')){
        failedCount++;preservedTabIds.push(r.tabId);continue;
      } else if(r.cleanupOutcome==='unknown'){
        unknownCount++;unknownTabIds.push(r.tabId);continue;
      } else if(preserved.has(key)){
        preservedTabIds.push(r.tabId);continue;
      }
      remainingTabIds.push(r.tabId);
    }
    const cleanupState=!validBaseline(t,key)||unknownCount?'unknown':failedCount?'failed':remainingTabIds.length?'pending':'succeeded';
    const cleanupReason=t.restartInvalidated?'browser_restarted':!validBaseline(t,key)?'baseline_unavailable':unknownCount?'ownership_unknown':failedCount?'cleanup_failed':remainingTabIds.length?'remaining_owned_tabs':preserved.has(key)?'preserved':'verified_complete';
    return {cleanupState,remainingTabIds,preservedTabIds,unknownTabIds,remainingCount:remainingTabIds.length,preservedCount:preservedTabIds.length,unknownCount,...(cleanupReason?{cleanupReason}:{})};
  }
  async function cleanup(cap, {closeTabs = true, keepTabIds = [], tabIds, canDelete, timeoutMs = 2000} = {}) {
    const {key} = identity(cap, true);
    if (tabIds !== undefined) {
      if (!Array.isArray(tabIds) || tabIds.some(id => !Number.isInteger(id) || id < 0)) throw Error('INVALID_CLEANUP_ALLOWLIST');
      deletionLimits.set(key, new Set(tabIds));
    }
    if (canDelete !== undefined) {
      if (typeof canDelete !== 'function') throw Error('INVALID_CLEANUP_GUARD');
      deletionGuards.set(key, canDelete);
    }
    const exactIds = deletionLimits.get(key); // Private snapshot; later retries cannot expand this invocation.
    cancelled.add(key); // Synchronous fence precedes queued cleanup.
    kept.set(key, new Set([...(kept.get(key) || []), ...keepTabIds]));
    if (!closeTabs) preserved.add(key);
    let expired = false, timer;
    const work = enqueue(key,async () => {
      await ready;
      if (closeTabs && !expired) preserved.delete(key);
      try {await save(); await cleanupTask(key, exactIds, canDelete); await save();return status(cap);}
      catch (error) {preserved.add(key); await save().catch(() => {}); throw error;}
    });
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true; preserved.add(key);
          // A browser operation cannot be aborted; retain the journal and stop any
          // further deletions when it eventually returns. Never claim success.
          void ready.then(save).catch(() => {});
          reject(Error('WORKSPACE_CLEANUP_TIMEOUT'));
        }, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 2000)) : 2000);
      })]);
    } finally {clearTimeout(timer);}
  }
  async function reconcile() {
    return enqueue('reconcile',async () => {
      await ready; await scan();
      for (const key of cancelled) await cleanupTask(key);
      await save();
      return {tasks: tasks.size, unknown: [...tasks.values()].flatMap(t => [...t.requests.values()]).filter(r => r.status === 'unknown').length};
    });
  }
  async function ungroup(cap, {records, withTabLock, canUngroup}) {
    const {key}=identity(cap,true);
    // 中文注释：daemon 清单只能缩小范围；私有日志里的 API 创建回执和同浏览器启动期 baseline 才是身份依据。
    records=records.map(row=>({...row}));
    return enqueue(key,async()=>{
      await ready;
      const t=tasks.get(key);
      if(!t||!validBaseline(t,key))return status(cap);
      const unknownTabIds=[],preservedTabIds=[];
      for(const record of records){
        const r=[...t.requests.values()].find(row=>row.tabId===record.tabId&&row.groupId===record.groupId);
        if(!r||record.windowId!==t.windowId||protectedTab(t,key,record.tabId)||r.source==='opener'
           ||!['ready','kept','released'].includes(r.status)||r.disposition==='moved')continue;
        await withTabLock(record.tabId,async()=>{
          const state=await ownership(t,r);
          if(state==='missing'){r.status='released';r.disposition='gone';r.cleanupOutcome='succeeded';return;}
          if(state==='moved'){r.status='released';r.disposition='moved';return;}
          if(state!=='owned'||!canUngroup(record.tabId)){unknownTabIds.push(record.tabId);return;}
          // 中文注释：仅解绑有创建证据的这一页；用户放进任务组的其他页和用户自建组不动。
          try{await chrome.tabs.ungroup(record.tabId);r.status='kept';r.disposition='ungrouped';preservedTabIds.push(record.tabId);}
          catch{unknownTabIds.push(record.tabId);}
        });
      }
      await save();
      const result=await status(cap);
      if(unknownTabIds.length)return {...result,cleanupState:'unknown',unknownTabIds:[...new Set([...result.unknownTabIds,...unknownTabIds])],cleanupReason:'ownership_unknown'};
      return {...result,preservedTabIds:[...new Set([...result.preservedTabIds,...preservedTabIds])]};
    });
  }
  return Object.freeze({ready, start, open, spawned, status, cleanup, reconcile, ungroup});
}
