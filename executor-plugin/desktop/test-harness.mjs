import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

export async function load(queries = {}, rest = async () => [], state = []) {
  const source = await readFile(new URL('./plugin.js', import.meta.url), 'utf8')
  const registrations = [], calls = [], notices = [], queryOptions = []
  let cursor = 0
  const jsx = (type, props) => ({ type, props })
  const context = { URL, URLSearchParams, console, Date,
    __sdk: { host: { navigate() {}, notify(value) { notices.push(value) } }, ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', PALETTE_AREA: 'palette',
      useQuery(options) { queryOptions.push(options); return { isLoading: false, refetch: async () => ({}), ...queries[options.queryKey.at(-1)] } },
      useQueryClient() { return { invalidateQueries: async () => {}, setQueryData() {} } } },
    __react: { useEffect() {}, useRef: initial => ({ current: initial }), useState(initial) { const i = cursor++; if (state[i] === undefined) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] } },
    __jsx: { jsx, jsxs: jsx }
  }
  const transformed = source.replace(/import \{([^}]+)\} from '@hermes\/plugin-sdk'/, 'const {$1} = __sdk')
    .replace(/import \{([^}]+)\} from 'react'/, 'const {$1} = __react')
    .replace(/import \{([^}]+)\} from 'react\/jsx-runtime'/, 'const {$1} = __jsx')
    .replace('export default {', 'globalThis.plugin = {').replace('export const __testables =', 'globalThis.helpers =')
  // Only fixed local component names are evaluated in this test-only VM.
  vm.runInNewContext(`${transformed}\nglobalThis.component = name => eval(name)`, context)
  context.plugin.register({ registerMany: rows => registrations.push(...rows), rest: async (path, opts) => { calls.push([path, opts]); return rest(path, opts) } })
  function expand(node) {
    if (!node || typeof node !== 'object') return []
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return [node, ...[].concat(node.props?.children || []).flatMap(expand)]
  }
  return { context, registrations, calls, notices, state, queryOptions, expand,
    page: () => expand(registrations.find(r => r.area === 'routes').render()),
    render: (name, props) => { cursor = 0; return expand(context.component(name)(props)) } }
}
export const content = nodes => nodes.map(n => typeof n.props?.children === 'string' ? n.props.children : '').join('\n')

