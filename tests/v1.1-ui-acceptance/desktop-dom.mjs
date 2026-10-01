import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const pluginSource = new URL('../../executor-plugin/desktop/plugin.js', import.meta.url);
const defaultRest = async () => [];

export async function mountDesktop({ queries = {}, rest = defaultRest, initialHash = '' } = {}) {
  // Static sibling source is deliberately loaded for the synthetic UI test.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = await readFile(pluginSource, 'utf8');
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><main id="app"></main></body></html>', { url: 'http://desktop.test/' });
  const { document } = dom.window;
  const root = document.querySelector('#app');
  const registrations = [];
  const calls = [];
  const notices = [];
  const queryOptions = [];
  const hooks = new Map();
  const effects = new Map();
  const queryStates = new Map();
  const pendingQueries = new Map();
  const activeQueryKeys = new Set();
  const listeners = new Map();
  const locationState = { hash: initialHash };
  let activePath = '';
  let hookIndex = 0;
  let scheduled = false;
  let mounted = true;
  let lastAction = Promise.resolve();
  let renderRoot = () => {};

  const scheduleRender = () => {
    if (scheduled || !mounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (mounted) renderRoot();
    });
  };
  const queryKey = options => JSON.stringify(options.queryKey);
  const startQuery = (options, state, key, force = false) => {
    if (rest === defaultRest || options.enabled === false || pendingQueries.has(key) || state.fetchStatus === 'paused') return pendingQueries.get(key);
    if (!force && (state.data !== undefined || state.error)) return Promise.resolve(state.data);
    state.error = undefined;
    state.fetchStatus = 'fetching';
    state.isFetching = true;
    state.isLoading = state.data === undefined;
    scheduleRender();
    const pending = Promise.resolve()
      .then(() => options.queryFn())
      .then(value => {
        state.data = value;
        state.error = undefined;
        state.dataUpdatedAt = Date.now();
        state.fetchStatus = 'idle';
      }, error => {
        state.error = error;
        state.fetchStatus = 'idle';
      })
      .finally(() => {
        state.isFetching = false;
        pendingQueries.delete(key);
        scheduleRender();
      });
    pendingQueries.set(key, pending);
    return pending;
  };

  const jsx = (type, props = {}, key = null) => ({ type, props: props || {}, key });
  const useState = initial => {
    const id = `${activePath}:${hookIndex++}`;
    if (!hooks.has(id)) hooks.set(id, typeof initial === 'function' ? initial() : initial);
    const set = value => {
      hooks.set(id, typeof value === 'function' ? value(hooks.get(id)) : value);
      scheduleRender();
    };
    return [hooks.get(id), set];
  };
  const useRef = initial => {
    const id = `${activePath}:${hookIndex++}`;
    if (!hooks.has(id)) hooks.set(id, { current: initial });
    return hooks.get(id);
  };
  const useEffect = effect => {
    const id = `${activePath}:effect:${hookIndex++}`;
    if (!effects.has(id)) effects.set(id, effect());
  };
  const sdk = {
    host: {
      navigate(path) {
        locationState.hash = path.startsWith('#') ? path : `#${path}`;
        for (const listener of listeners.get('hashchange') || []) listener();
        renderRoot();
      },
      notify: value => notices.push(value),
    },
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', PALETTE_AREA: 'palette',
    useQuery(options) {
      queryOptions.push(options);
      const key = queryKey(options);
      activeQueryKeys.add(key);
      let state = queryStates.get(key);
      if (!state) {
        const exactFixture = queries[key];
        const leafFixture = queries[options.queryKey.at(-1)];
        const supplied = exactFixture ?? leafFixture ?? {};
        state = {
          isLoading: supplied.data === undefined && !supplied.error,
          isFetching: false,
          fetchStatus: supplied.fetchStatus || (supplied.data === undefined ? 'idle' : 'idle'),
          dataUpdatedAt: supplied.data === undefined ? 0 : Date.now(),
          ...supplied,
        };
        queryStates.set(key, state);
      }
      if (options.enabled !== false && state.fetchStatus !== 'paused') startQuery(options, state, key);
      return {
        ...state,
        refetch: () => startQuery(options, state, key, true),
      };
    },
    useQueryClient() {
      return {
        setQueryData(_key, value) { queries[value?.id || 'shared'] = { data: [value] }; },
        invalidateQueries: async () => {},
      };
    },
  };
  const context = {
    URL, URLSearchParams, Date, console, location: locationState,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    __sdk: sdk,
    __react: { useEffect, useRef, useState },
    __jsx: { jsx, jsxs: jsx },
  };
  const transformed = source
    .replace(/import \{([^}]+)\} from '@hermes\/plugin-sdk'/, 'const {$1} = __sdk')
    .replace(/import \{([^}]+)\} from 'react'/, 'const {$1} = __react')
    .replace(/import \{([^}]+)\} from 'react\/jsx-runtime'/, 'const {$1} = __jsx')
    .replace('export default {', 'globalThis.plugin = {')
    .replace('export const __testables =', 'globalThis.helpers =');
  vm.runInNewContext(transformed, context);
  context.plugin.register({ registerMany: rows => registrations.push(...rows), rest: async (path, options) => { calls.push([path, options]); return rest(path, options); } });

  function renderNode(value, path) {
    if (value === null || value === undefined || value === false || value === true) return null;
    if (Array.isArray(value)) {
      const fragment = document.createDocumentFragment();
      value.forEach((child, index) => {
        const node = renderNode(child, `${path}.${index}`);
        if (node) fragment.append(node);
      });
      return fragment;
    }
    if (typeof value !== 'object') return document.createTextNode(String(value));
    if (typeof value.type === 'function') {
      const componentPath = `${path}/${value.type.name || 'anonymous'}:${value.key ?? ''}`;
      const previousPath = activePath;
      const previousIndex = hookIndex;
      activePath = componentPath;
      hookIndex = 0;
      const result = value.type(value.props || {});
      activePath = previousPath;
      hookIndex = previousIndex;
      return renderNode(result, `${componentPath}.render`);
    }

    const element = document.createElement(value.type);
    const props = value.props || {};
    for (const [name, prop] of Object.entries(props)) {
      if (name === 'children' || name === 'key' || name === 'ref' || prop === null || prop === undefined || typeof prop === 'function') continue;
      if (name === 'className') element.setAttribute('class', String(prop));
      else if (name === 'value') element.value = String(prop);
      else if (name === 'disabled') element.disabled = !!prop;
      else if (name === 'open') element.open = !!prop;
      else if (name === 'tabIndex') element.tabIndex = Number(prop);
      else if (name === 'role' || name.startsWith('aria-') || name.startsWith('data-') || name === 'title' || name === 'type') element.setAttribute(name, String(prop));
    }
    if (typeof props.onClick === 'function') {
      element.addEventListener('click', event => {
        lastAction = Promise.resolve(props.onClick(event));
      });
    }
    if (typeof props.onChange === 'function') {
      // 中文注释：合成 Desktop 事件沿用组件的真实 onChange，验证文件选择到受限 REST 调用。
      element.addEventListener('change', event => { lastAction = Promise.resolve(props.onChange(event)); });
    }
    if (props.ref && typeof props.ref === 'object') props.ref.current = element;
    const children = props.children;
    const childValues = Array.isArray(children) ? children : [children];
    childValues.forEach((child, index) => {
      const node = renderNode(child, `${path}.${index}`);
      if (node) element.append(node);
    });
    return element;
  }

  renderRoot = () => {
    activeQueryKeys.clear();
    const route = registrations.find(entry => entry.area === 'routes');
    const page = route.render();
    const content = renderNode(page, 'page');
    root.replaceChildren(...(content ? [content] : []));
  };
  renderRoot();

  return {
    dom, root, calls, notices, queryOptions, location: locationState,
    // 中文注释：模拟宿主导航，供详情页之间的状态隔离测试使用。
    navigate: path => sdk.host.navigate(path),
    async click(selectorOrElement) {
      const target = typeof selectorOrElement === 'string' ? root.querySelector(selectorOrElement) : selectorOrElement;
      if (!target) throw new Error(`missing control: ${selectorOrElement}`);
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await lastAction;
      await new Promise(resolve => setImmediate(resolve));
      if (scheduled) await new Promise(resolve => setImmediate(resolve));
      return target;
    },
    async clickText(label, occurrence = 0) {
      const targets = [...root.querySelectorAll('button')].filter(button => button.textContent.trim() === label);
      const target = targets[occurrence];
      if (!target) throw new Error(`missing button: ${label}`);
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await lastAction;
      await new Promise(resolve => setImmediate(resolve));
      if (scheduled) await new Promise(resolve => setImmediate(resolve));
      return target;
    },
    async waitForQueries() {
      while (true) {
        const activePending = [...pendingQueries.entries()]
          .filter(([key]) => activeQueryKeys.has(key))
          .map(([, pending]) => pending);
        if (!activePending.length) break;
        await Promise.all(activePending);
      }
      await new Promise(resolve => setImmediate(resolve));
      if (scheduled) await new Promise(resolve => setImmediate(resolve));
    },
    unmount() {
      mounted = false;
      for (const cleanup of effects.values()) if (typeof cleanup === 'function') cleanup();
      dom.window.close();
    },
  };
}
