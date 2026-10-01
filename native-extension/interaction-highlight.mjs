const labels = Object.freeze({
  click: '准备点击',
  input: '正在输入',
  select: '正在选择',
  drag: '正在拖动',
});

const DEFAULT_COMPLETE_MS = 600;
const MAX_COMPLETE_MS = 2000;
const owners = new WeakMap();

export function createInteractionHighlight({
  document: doc = globalThis.document,
  taskId,
  generation,
  documentId,
  isCurrent = () => true,
  surface = null,
} = {}) {
  const validBinding = value => value && typeof value.taskId === 'string' && value.taskId.length > 0 &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.documentId === 'string' && value.documentId.length > 0 &&
    typeof value.operationToken === 'string' && value.operationToken.length > 0;
  if (!doc?.documentElement || typeof taskId !== 'string' || !taskId ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      typeof documentId !== 'string' || !documentId || typeof isCurrent !== 'function') {
    throw new TypeError('INVALID_HIGHLIGHT_BINDING');
  }
  if (surface !== null && (!surface || typeof surface.isAvailable !== 'function' ||
      typeof surface.update !== 'function' || typeof surface.clear !== 'function' ||
      typeof surface.isVisible !== 'function')) {
    throw new TypeError('INVALID_HIGHLIGHT_SURFACE');
  }

  const rootAtCreation = doc.documentElement;
  const binding = Object.freeze({taskId, generation, documentId});
  const sharedSurface = surface;
  const record = {active: false};
  const previous = owners.get(doc);
  if (previous?.active) throw new Error('HIGHLIGHT_OWNER_CONFLICT');
  owners.set(doc, record);

  let host = null;
  let frame = null;
  let dragStartFrame = null;
  let dragEndFrame = null;
  let status = null;
  let active = null;
  let cleanupWatch = null;
  let completeTimer = null;
  let nextSuspensionId = 1;

  const isLive = () => {
    if (owners.get(doc) !== record || doc.documentElement !== rootAtCreation) return false;
    try { return isCurrent(binding) !== false; } catch { return false; }
  };

  function removeHost() {
    if (!sharedSurface) host?.remove();
    host = sharedSurface?.host || null;
    frame = null;
    dragStartFrame = null;
    dragEndFrame = null;
    status = null;
  }

  function clearActive() {
    if (completeTimer !== null) clearTimeout(completeTimer);
    completeTimer = null;
    if (sharedSurface && active) {
      try { sharedSurface.clear({...binding, operationToken: active.operationToken}); } catch {}
    }
    active?.suspensions?.clear();
    active = null;
    record.active = false;
    cleanupWatch?.();
    cleanupWatch = null;
    removeHost();
  }

  function scopeMatches(request) {
    return validBinding(request) && request.taskId === taskId &&
      request.generation === generation && request.documentId === documentId;
  }

  function hasOverlayConflict() {
    if (sharedSurface) return false;
    if (doc.querySelector('[data-hermes-automation-overlay]:not([data-hermes-interaction-highlight])')) return true;
    return [...doc.querySelectorAll('[data-hermes-interaction-highlight]')].some(candidate => candidate !== host);
  }

  function makeHost() {
    if (sharedSurface) {
      if (!isLive() || sharedSurface.isAvailable(binding) !== true) return false;
      host = sharedSurface.host || null;
      return Boolean(host?.isConnected);
    }
    if (!isLive() || hasOverlayConflict()) return false;
    if (host?.isConnected) return true;

    host = doc.createElement('div');
    host.setAttribute('data-hermes-automation-overlay', '');
    host.setAttribute('data-hermes-interaction-highlight', '');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
      position: 'fixed', inset: '0px', zIndex: '2147483647',
      pointerEvents: 'none', overflow: 'hidden', margin: '0', padding: '0',
      border: '0', background: 'transparent', contain: 'layout style paint',
    });

    const shadow = host.attachShadow({mode: 'closed'});
    const stylesheet = doc.createElement('style');
    stylesheet.textContent = `
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    [data-role="target"], [data-role="drag-start"], [data-role="drag-end"] { position: fixed; box-sizing: border-box; border: 2px solid #e59b17; background: rgba(229,155,23,.12); pointer-events: none; }
      [data-role="drag-start"] { border-color: #3888e8; background: rgba(56,136,232,.12); }
      [data-role="status"] { position: fixed; top: 8px; left: 8px; max-width: min(240px, 90vw); padding: 6px 9px; border-radius: 7px; background: #172b43; color: #fff; font: 13px/1.35 system-ui, sans-serif; box-shadow: 0 2px 8px #0004; pointer-events: none; }
    `;
    frame = doc.createElement('div');
    frame.setAttribute('data-role', 'target');
    frame.setAttribute('aria-hidden', 'true');
    dragStartFrame = doc.createElement('div');
    dragStartFrame.setAttribute('data-role', 'drag-start');
    dragStartFrame.setAttribute('aria-hidden', 'true');
    dragEndFrame = doc.createElement('div');
    dragEndFrame.setAttribute('data-role', 'drag-end');
    dragEndFrame.setAttribute('aria-hidden', 'true');
    for (const visual of [frame, dragStartFrame, dragEndFrame]) visual.style.pointerEvents = 'none';
    status = doc.createElement('div');
    status.setAttribute('data-role', 'status');
    status.setAttribute('aria-hidden', 'true');
    shadow.append(stylesheet, frame, dragStartFrame, dragEndFrame, status);
    rootAtCreation.append(host);
    return true;
  }

  function belongsToOverlay(target) {
    for (let node = target; node; node = node.parentNode || node.host) {
      if (node.nodeType === 1 && node.hasAttribute?.('data-hermes-automation-overlay')) return true;
    }
    return false;
  }

  function elementRect(target) {
    if (!target || target.nodeType !== 1 || !target.isConnected || belongsToOverlay(target)) return null;
    let rect;
    try {
      if (target.getClientRects && target.getClientRects().length === 0) return null;
      const style = target.ownerDocument.defaultView?.getComputedStyle(target);
      if (style && (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0)) return null;
      rect = target.getBoundingClientRect();
      let currentDoc = target.ownerDocument;
      while (currentDoc !== doc) {
        const frameElement = currentDoc.defaultView?.frameElement;
        if (!frameElement?.isConnected) return null;
        const outer = frameElement.getBoundingClientRect();
        const frameStyle = frameElement.ownerDocument.defaultView.getComputedStyle(frameElement);
        // 中文注释：高亮坐标与命中检查采用同一逐层 frame 映射，无法核实的变换不绘制。
        // 中文注释：与目标核实一致，只接受正向缩放与平移；此时包围盒比例可精确换算高亮位置。
        const matrix = /^matrix\(([^)]+)\)$/.exec(frameStyle.transform);
        const [a, b, c, d] = matrix ? matrix[1].split(',').map(Number) : [];
        if (frameStyle.transform !== 'none' && !(matrix && b === 0 && c === 0 && a > 0 && d > 0)) return null;
        const scaleX = outer.width / frameElement.offsetWidth;
        const scaleY = outer.height / frameElement.offsetHeight;
        if (![scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) return null;
        rect = {
          left: outer.left + (frameElement.clientLeft + rect.left) * scaleX,
          top: outer.top + (frameElement.clientTop + rect.top) * scaleY,
          width: rect.width * scaleX, height: rect.height * scaleY,
        };
        currentDoc = frameElement.ownerDocument;
      }
    } catch { return null; }
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    const width = doc.defaultView?.innerWidth || doc.documentElement.clientWidth;
    const height = doc.defaultView?.innerHeight || doc.documentElement.clientHeight;
    if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0 || rect.left >= width || rect.top >= height) return null;
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }

  function endpointRect(endpoint) {
    if (endpoint?.nodeType === 1) return elementRect(endpoint);
    if (!endpoint || !Number.isFinite(endpoint.x) || !Number.isFinite(endpoint.y)) return null;
    const width = doc.defaultView?.innerWidth || doc.documentElement.clientWidth;
    const height = doc.defaultView?.innerHeight || doc.documentElement.clientHeight;
    if (endpoint.x < 0 || endpoint.y < 0 || endpoint.x >= width || endpoint.y >= height) return null;
    const size = 14;
    return {left: endpoint.x - size / 2, top: endpoint.y - size / 2, width: size, height: size};
  }

  function applyRect(visual, rect) {
    Object.assign(visual.style, {
      display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
  }

  function geometry(kind, target, from, to) {
    if (kind !== 'drag') {
      const rect = elementRect(target);
      return rect ? [rect] : null;
    }
    const start = endpointRect(from);
    const end = endpointRect(to);
    return start && end ? [start, end] : null;
  }

  function paint() {
    if (!active || !makeHost()) return false;
    const rects = geometry(active.kind, active.target, active.from, active.to);
    if (!rects) return false;
    if (sharedSurface) {
      const result = sharedSurface.update({...binding, operationToken: active.operationToken, kind: active.kind,
        rects, label: active.label, point: active.point});
      if (result?.ok !== true) return false;
      active.rects = rects;
      return true;
    }
    status.textContent = `${labels[active.kind]}${active.label ? `：${active.label}` : ''}`;
    if (active.kind !== 'drag') {
      applyRect(frame, rects[0]);
      dragStartFrame.style.display = 'none';
      dragEndFrame.style.display = 'none';
      active.rects = rects;
      return true;
    }
    frame.style.display = 'none';
    applyRect(dragStartFrame, rects[0]);
    applyRect(dragEndFrame, rects[1]);
    active.rects = rects;
    return true;
  }

  function watch() {
    const win = doc.defaultView;
    if (!win) return;
    let frameId = null;
    const requestFrame = typeof win.requestAnimationFrame === 'function'
      ? callback => win.requestAnimationFrame(callback)
      : callback => win.setTimeout(callback, 0);
    const cancelFrame = typeof win.cancelAnimationFrame === 'function'
      ? id => win.cancelAnimationFrame(id)
      : id => win.clearTimeout(id);
    const refresh = () => {
      frameId = null;
      if (!active) return;
      if (!isLive() || hasOverlayConflict() || !paint()) {
        clearActive();
      }
    };
    const schedule = () => {
      if (frameId === null) frameId = requestFrame(refresh);
    };
    const changed = () => schedule();
    win.addEventListener('scroll', changed, true);
    doc.addEventListener('scroll', changed, true);
    win.addEventListener('resize', changed, {passive: true});
    const viewport = win.visualViewport;
    viewport?.addEventListener('scroll', changed, {passive: true});
    viewport?.addEventListener('resize', changed, {passive: true});
    const mutation = typeof win.MutationObserver === 'function'
      ? new win.MutationObserver(records => {if(records.some(record=>!host?.contains(record.target)))schedule();})
      : null;
    mutation?.observe(rootAtCreation, {subtree: true, childList: true, attributes: true});
    const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
    if(active.target?.nodeType===1)resize?.observe(active.target);
    // 中文注释：前台持续校准移动目标，后台只响应结构事件，不等待绘制帧。
    let following=true;
    const follow=()=>{if(!following||!active)return;if(doc.visibilityState!=='hidden')schedule();if(doc.visibilityState!=='hidden')requestFrame(follow);};
    if(typeof win.requestAnimationFrame==='function'&&doc.visibilityState!=='hidden')requestFrame(follow);

    cleanupWatch = () => {
      if (frameId !== null) cancelFrame(frameId);
      win.removeEventListener('scroll', changed, true);
      doc.removeEventListener('scroll', changed, true);
      win.removeEventListener('resize', changed);
      viewport?.removeEventListener('scroll', changed);
      viewport?.removeEventListener('resize', changed);
      mutation?.disconnect();
      following=false;resize?.disconnect();
    };
  }

  function update(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    // 中文注释：后台页不等待绘制时仍必须确认真实高亮节点挂载。
    if (!host?.isConnected) return {ok: false, code: 'HIGHLIGHT_NOT_VISIBLE'};
    if (!active || active.operationToken !== request.operationToken || active.completed) {
      return {ok: false, code: 'STALE_OPERATION'};
    }
    if (Object.hasOwn(request, 'target')) active.target = request.target;
    if (Object.hasOwn(request, 'from')) active.from = request.from;
    if (Object.hasOwn(request, 'to')) active.to = request.to;
    if (!paint()) {
      clearActive();
      return {ok: false, code: 'INVALID_TARGET'};
    }
    return {ok: true};
  }

  function complete(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!active || active.operationToken !== request.operationToken || active.completed) {
      return {ok: false, code: 'STALE_OPERATION'};
    }
    const durationMs = request.durationMs ?? DEFAULT_COMPLETE_MS;
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_COMPLETE_MS) {
      return {ok: false, code: 'INVALID_DURATION'};
    }
    const completed = active;
    completed.completed = true;
    if(sharedSurface&&typeof sharedSurface.fade==='function')sharedSurface.fade({...binding,operationToken:active.operationToken,durationMs});
    else if(host){host.style.transition=`opacity ${durationMs}ms ease-out`;host.style.opacity='0';}
    completeTimer = setTimeout(() => {
      completeTimer = null;
      if (active !== completed) return;
      if (!isLive()) { clearActive(); return; }
      clearActive();
    }, durationMs);
    return {ok: true};
  }

  function verify(request, targets = {}) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!active || active.operationToken !== request.operationToken || active.completed) {
      return {ok: false, code: 'STALE_OPERATION'};
    }
    const target = Object.hasOwn(targets, 'target') ? targets.target : active.target;
    const from = Object.hasOwn(targets, 'from') ? targets.from : active.from;
    const to = Object.hasOwn(targets, 'to') ? targets.to : active.to;
    if (target !== active.target || from !== active.from || to !== active.to) return {ok: false, code: 'TARGET_CHANGED'};
    const rects = geometry(active.kind, target, from, to);
    if (!rects || JSON.stringify(rects) !== JSON.stringify(active.rects)) return {ok: false, code: 'TARGET_CHANGED'};
    if (sharedSurface && sharedSurface.isVisible(request.operationToken) !== true) return {ok: false, code: 'HIGHLIGHT_NOT_VISIBLE'};
    return {ok: true};
  }

  function suspend(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!active || active.operationToken !== request.operationToken) return {ok: false, code: 'STALE_OPERATION'};
    if (!['screenshot', 'overlay'].includes(request.reason)) return {ok: false, code: 'INVALID_SUSPEND_REASON'};
    if (!host?.isConnected) { clearActive(); return {ok: false, code: 'HIDE_FAILED'}; }
    const suspensionId = nextSuspensionId++;
    active.suspensions ||= new Set();
    active.suspensions.add(suspensionId);
    try {
      host.style.setProperty('display', 'none', 'important');
      if (doc.defaultView.getComputedStyle(host).display !== 'none') throw new Error('hide not confirmed');
    } catch {
      clearActive();
      return {ok: false, code: 'HIDE_FAILED'};
    }
    return {ok: true, suspensionId};
  }

  function resume(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!active || active.operationToken !== request.operationToken || !active.suspensions?.has(request.suspensionId)) {
      return {ok: false, code: 'STALE_SUSPENSION'};
    }
    active.suspensions.delete(request.suspensionId);
    if (active.suspensions.size > 0) return {ok: true, hidden: true};
    try {
      if (!paint()) throw new Error('target no longer paintable');
      host.style.removeProperty('display');
      if (!host.isConnected || doc.defaultView.getComputedStyle(host).display === 'none') throw new Error('restore not confirmed');
    } catch {
      clearActive();
      return {ok: false, code: 'RESTORE_FAILED'};
    }
    return {ok: true};
  }

  function clear(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!active || active.operationToken !== request.operationToken) return {ok: false, code: 'STALE_OPERATION'};
    clearActive();
    return {ok: true};
  }

  function prepare(request) {
    if (!isLive()) { clearActive(); return {ok: false, code: 'STALE_DOCUMENT'}; }
    if (!scopeMatches(request)) return {ok: false, code: 'INVALID_SCOPE'};
    if (!['click', 'input', 'select', 'drag'].includes(request.kind)) return {ok: false, code: 'INVALID_KIND'};
    clearActive();
    active = {
      operationToken: request.operationToken,
      kind: request.kind,
      target: request.target,
      from: request.from,
      to: request.to,
      label: typeof request.label==='string'?request.label.slice(0,48):'',
      point: request.point,
    };
    if(host){host.style.transition='left 180ms ease-out, top 180ms ease-out';host.style.opacity='1';}
    if (!paint()) {
      const code = hasOverlayConflict() ? 'OVERLAY_CONFLICT' : 'INVALID_TARGET';
      clearActive();
      return {ok: false, code};
    }
    record.active = true;
    watch();
    return {ok: true};
  }

  return Object.freeze({prepare, update, verify, complete, clear, suspend, resume});
}
