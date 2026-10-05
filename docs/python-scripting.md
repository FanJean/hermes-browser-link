# Python scripting

`browser_shared_script` runs a short Python script against the task bound to the current Hermes session. Use it for paging, collecting data, multi-step forms and anything else that would otherwise need many model round trips.

## How it runs

- Each call starts a **new** Python process; the session's working directory is kept between calls, so files you write there survive. Element references and approvals do not.
- Default timeout 120 s, maximum 600 s. A timeout does not mean the page action did not happen, and the script is not re-run automatically.
- Every helper goes through the same path as a single tool call — trusted session → script host → daemon → extension — with the same ownership, origin, generation, approval and sensitive-field checks. There is no second executor.
- Print only a summary to stdout; output is bounded.
- `execution_complete` comes from the trusted action state and ledger, not only the Python exit code. Caught unknown outcomes, pending approvals and pending manual input still make the run incomplete. `outcome_unknown` remains true when an outcome cannot be established. Resolve the original pending request with `wait_pending`, or explicitly reconcile unknown work; do not replay it.
- The process runs with your user's permissions. Environment scrubbing and helper limits are **not** an OS sandbox: never execute text taken from a web page as Python.

The script uses the task's only work tab automatically. If the task has several work tabs, the helpers refuse to guess; open one explicitly with `new_tab(url)`.

## Helpers

### Navigation and reading

| Helper | Description |
|---|---|
| `new_tab(url)`, `goto_url(url)` | Open or navigate a work tab within the task's allowed origins |
| `wait_for_load(timeout=15, until='interactive')` | Poll `document.readyState` until the DOM is readable (`interactive`, default) or `complete` (`until='complete'`); tolerates the transient errors of a slow page being replaced. Not proof that dynamic content has appeared. |
| `wait_for(selector, state='present', timeout=10)` | Wait for a specific element or state on a dynamic page; prefer this when the target is known. |
| `read_page(query='', root=None, mode='content', budget=3000, cursor=None)` | Read a region as text (`content`), tables (`table`) or controls (`interactive`), with coverage and paging info; pass `nextCursor` after scrolling a virtual list |
| `semantic_snapshot(**options)` | The underlying snapshot: `mode`, `root`, `query`, `roles`, `viewport`, `composed`, `accessibility`, `frameToken`, `budget`, `cursor`, `baselineId` |
| `frame_catalog()` | List child frames; approved cross-origin frames get a `frameToken` |
| `page_text()`, `screenshot(path)` | Basic text snapshot; save a screenshot into the working directory |

### Locating and acting

| Helper | Description |
|---|---|
| `wait_for_element(name, role=None, root=None, exact=True, timeout=10)` | Wait for exactly one enabled match (max 60 s); returns `snapshot` and `ref` |
| `click_element(name, mode='pointer', **options)` | Locate in a fresh snapshot and click once; inspect delivery for trusted or background synthetic input |
| `fill_element(name, text, **options)` | Locate in a fresh snapshot and fill once |
| `scroll('down' \| 'up')` | Controlled scroll; locate again afterwards |
| `ref_click`, `ref_fill`, `ref_press`, `ref_set_checked`, `ref_select_option` | Act on a reference from a snapshot you already have |
| `click`, `fill`, `press` | Selector-based actions |

Locating is strict: the same name in scope returns `ambiguous_target`, a truncated read returns `incomplete_target_scope`. Narrow `root`, `role` or `query` and read again rather than picking the first match. A successful click only means the input was delivered — read the page to confirm the business result.

`ref_press` accepts Enter, Tab, Escape, ArrowDown and ArrowUp. `ref_set_checked` cannot uncheck a radio button. `ref_select_option(snapshot, ref, values, by='value' | 'label' | 'index')` supports native single/multi-select by exact value, trimmed Unicode label or zero-based index. Native selects set `selected` and dispatch bubbling `input`/`change`, returning `kind: native-select` and the final selected value/label pairs. Custom ARIA combobox/listbox controls retain trusted pointer input for one option. Both return `verified`; if it is `false`, read the page instead of repeating the action.

When a reference action returns `relocated: true`, the original node was replaced inside the same document and exactly one target matched its non-sensitive role, name, attributes and ancestor structure. Read the resulting page before the next action. A navigation still invalidates the reference. `reference_target_missing` and `reference_target_ambiguous` mean no safe relocation was possible; take a new snapshot and narrow the target. A visual highlight timeout does not determine whether a semantic action can run; the executor separately checks the actual hit target.

For `target_occluded`, inspect the page for a banner or dialog, then explicitly choose whether to close it. The executor never closes an obstruction itself. `target_out_of_viewport`, `target_zero_size`, `target_disabled` and `target_hidden` distinguish geometry and control state. Scroll or expand only when the returned state supports that action. `read_page(mode='table')` includes native rows, ARIA rows and `data-ui-name="Body.Row"` rows. `semantic_snapshot(composed=True)` traverses open Shadow DOM and accessible same-origin frames; use `frame_catalog()` and a `frameToken` for cross-origin frames. `coverage.unsupportedCanvas > 0` means canvas pixels were not parsed; use a screenshot and the existing `interaction.click` coordinate action when appropriate.

### Files and downloads

| Helper | Description |
|---|---|
| `upload_files(selector, paths=[...])` | Select local files (paths the user gave; relative paths resolve against the working directory) into a unique visible file input. Up to 10 files, 100 MiB each. Confirm on the page that the site received them. |
| `downloads()` | Downloads attributed to the task, plus a count of unattributed ones |
| `wait_for_download(timeout=30, ignore=())` | Wait for a new finished download |
| `claim_download(download_id, dest=None)` | Verify and copy a finished download into the working directory |
| `cancel_download(download_id)` | Cancel an in-progress task download |

### Page execution

| Helper | Description |
|---|---|
| `js(expression, world='isolated', await_promise=True, timeout_ms=10000, frame_token=None)` | Evaluate JavaScript in the page (`world='main'` for the page's own context) |
| `cdp(method, frame_token=None, **params)` | Send a raw CDP command to the page; credential, interception and browser-global methods are refused |
| `cdp_events(max=200)` | Read buffered CDP events |

JavaScript and CDP use the task’s existing browser access. No extra enable call, main-world permission or authorization expiry is needed. A page where a credential was filled cannot run arbitrary JavaScript or CDP.

### Approvals, recovery and checkpoints

| Helper | Description |
|---|---|
| `wait_pending(timeout_s=20)` | After `ApprovalRequired` / `UserInputRequired`, wait for the **same** request to be decided (max 300 s per call) |
| `reconcile()` | After an unknown outcome, read the page to decide; never replays the action |
| `operation_status(request_id=None)` | Read the daemon's request ledger: `awaiting_approval`, `awaiting_human`, `dispatched`, `confirmed`, `rejected` or `unknown` |
| `reconnect(timeout_s=30)` | After a disconnect, re-verify the task, instance, generation and work tab (read-only) |
| `load_checkpoint()` | Read the business checkpoint Hermes passed in `resume_checkpoint` |

`ApprovalRequired` and `UserInputRequired` (subclasses of `BrowserError`) are raised when the user must decide. Call `wait_pending()` and continue; calling `click_element` again would create a second action.

`resume_checkpoint` is cooperative resumption: Hermes passes an explicit checkpoint to the new process, and the result's `last_operation` lets it check what happened last. The plugin does not store script source or restore a dead process.

## Patterns

1. Read the page first and take names, roles and regions from what you saw — do not guess selectors.
2. Combine the steps you have already decided on, plus the read-back you need, in one script.
3. For collection, set explicit limits, a stable de-duplication key and a checkpoint. Do not treat the number of semantic items as the number of records, and do not ignore paging or truncation.
4. On unknown outcomes, stale references, denials or disconnects, do not retry writes. Verify the page; if you cannot tell what happened, stop and report.

```python
try:
    click_element('Search', role='button', root='#search-form')
except ApprovalRequired:
    wait_pending(timeout_s=30)
page = read_page(root='#results', mode='table')
print({'coverage': page['coverage'], 'items': page['items'][:5]})
```


## V1.3: parsing and conditional execution

The following helpers use the existing task, origin and lease checks. Parsing is read-only; `evaluate` and event observation use the existing browser access. Results are bounded and do not imply all website records were loaded.

| Helper | Contract |
| --- | --- |
| `parse_page(root=None, sections=[...], composed=False, budget=12000, maxScan=20000, cursor=None)` | Returns regions, blocks, table-row fragments, form relationships and collections, with source references, coverage, warnings and a continuation cursor. Sections are `regions`, `blocks`, `tables`, `forms`, `collections`. |
| `extract(schema, **options)` | A schema has a CSS `record` selector and named `fields`; each field accepts `selector`, `type` (`text`, `number`, `url`), optional allowlisted `attribute`, and `required`. `:scope` selects the record itself; selectors such as `:scope > h2` are evaluated relative to each record in its own DOM tree. Ambiguous/missing/redacted/truncated fields are explicit, never guessed. |
| `page_markdown(**options)` | Renders the current block page as Markdown while retaining coverage and continuation metadata. |
| `evaluate(function, arguments=None, world='isolated', timeout_ms=10000)` | Executes a JavaScript function string with separately serialized arguments. This is arbitrary JavaScript, not a read-only sandbox. |
| `wait_for(selector, state='present', text=None, count=None, timeout=10, interval=0.25)` | Read-only wait for `present`, `absent`, `text`, `count` or `stable`. Returns `satisfied`, `timed_out` and the last observation. Partial reads never prove absence. |
| `expect_response(url=None, timeout=15)` / `expect_navigation(url=None, timeout=15)` | Context managers that subscribe before your action and expose a matching event in `.result`. Matching is observation by filter, not proof that your action caused it or that business processing succeeded. Ambiguous events, overflow and timeouts fail without replaying the action. |

With `composed=True`, schema fields and ARIA form options include descendants across accessible Shadow trees and same-origin frames within the selected root and record/control. Hidden and private content stays excluded; multiple matching fields remain ambiguous. With `composed=False`, containment uses the light DOM. Implicit table column headers associate with every column interval covered by a cell's `colSpan`; explicit `headers` take priority and row headers stay limited to their row spans. These associations do not normalize a table into a spreadsheet.

```python
# 中文注释：先选定业务记录范围，再按明确字段读取；字段缺失会保留状态。
result = extract({
    'record': '.product',
    'fields': {
        'title': {'selector': 'h2', 'required': True},
        'price': {'selector': '.price', 'type': 'text'},
        'link': {'selector': 'a', 'attribute': 'href', 'type': 'url'},
    },
})
print({'records': result['records'], 'coverage': result['coverage']})

# 中文注释：监听先于一次点击建立；超时后核对页面，不重复点击。
with expect_response('https://example.com/search') as response:
    click_element('Search', role='button')
print(response.result)
```

Numeric conversion accepts unambiguous decimal notation only. Currency symbols, localized dates and decimal separators remain raw evidence with `invalid_format` when numeric conversion is requested. URL values omit query strings and fragments. Form input values are not returned. Sources are reading evidence, not actionable snapshot references.

A cursor continues the current document result, not the website's next page. Document mutation invalidates it (`parse_cursor_stale`); discard the old accumulation and start a new parse. Table fragments retain row/column coordinates, spans and `headerRefs`; they must be grouped by `tableRef`, not counted as complete tables. `observedRecords` describes matched visible DOM records, while `totalRecords` remains unknown. Virtualized rows, unloaded pages and unsupported frames cannot be claimed as complete website data.

Parsing results for Desktop are held in memory for the latest 16 tasks and the current task generation. They are not persisted in diagnostic logs. Script outputs retain at most 20,000 characters per stream; output is drained with an 80,000-byte buffer per stream and total byte counts are reported.

## Reusable site tools, network evidence and page requests

The `browser_site_search`, `browser_site_manage` and `browser_site_run` tools persist a verified `def run(args)` workflow on top of this same script lane. A draft must pass its output schema and explicit assertions before activation. Trial writes are real writes. A trial with `execution_complete:false` cannot pass or activate, even when the script catches its exception and returns matching JSON. Source changes and concurrent active-version changes invalidate activation; failures never replay browser actions.

```python
# 中文注释：先订阅，再执行已确认的读取；只打印需要的业务摘要。
capture = network_start()
result = page_request('/api/items', fields=['items', 'total'])
print(result)
requests = network_list(capture['captureId'], filter='/api/items')
print(requests)
# 中文注释：从真实列表选取 seq；详情正文分页使用 nextStart，不重新发请求。
if requests['entries']:
    print(network_detail(capture['captureId'], requests['entries'][0]['seq']))
network_stop()
```

Network inspection, raw CDP and `page_request` share the task’s existing browser access. `world` selects an execution context, not another permission. The request helper only accepts same-origin GET/HEAD, rejects redirects, bounds streamed response bytes and returns selected JSON fields. HTTP or acquisition failures are explicit. GET is not proof of a side-effect-free endpoint.

Network summaries omit query strings and headers. JSON detail filters credential-like keys, with explicit withheld/pending/evicted states. It is not general-purpose PII filtering. Capture IDs survive script process changes and navigation within authorized origins in the same live task; Python variables do not. Leaving the authorized origins or closing the tab clears its capture. Network inspection does not drain the raw CDP event buffer.

See the [module catalog](product-modules.zh-CN.md) for contracts and limits, and the [generated API reference](browser-api-reference.md) for exact helper and tool schemas. `browser_shared_reference` projects helpers for a connected instance; `browser_shared_doctor` checks installation and connection without starting the service.

## 显式选择工作页

`new_tab(url)` 返回 tab id，并将它设为当前页。使用 `current_tab()` 查看、`use_tab(tab_id)` 切换；页面 helper 支持关键字 `tab=`，只作用于指定页，不改变当前页。多页脚本推荐始终传 `tab=`。官方工具使用 `browser_shared_use_tab(tab_id)` 选择当前页；`browser_shared_open` 成功后自动选择刚打开或复用的页。不同网站的任务同时保留，撤销一个任务不撤销其他任务。

读动作只等待 DOM 的 `interactive`/`complete`，上限 1.5 秒。导航和新建页最多等待 8 秒，`ready` 返回 `interactive`、`complete` 或 `loading`。等具体元素用 `wait_for(selector, ...)`，等完整加载用 `wait_for_load()`；`goto_url()` 已等待 DOM 可交互，不再叠加 `wait_for_load()` 或 `time.sleep()`。

`redirected_out_of_scope` 表示页面跳到其他来源，错误的 `final_origin` 只含来源；用该来源调用 `browser_shared_open` 新开任务。多台浏览器时，在 Hermes 进程环境设置 `HERMES_BROWSER_DEFAULT=edge`、`chrome` 或具体 instance ID；显式 `instance_id` 优先，未配置仍返回 `browser_choice_required`。

`parallel(fn, tabs)` 对每个页执行 `fn(tab)`，最多八个线程，结果按输入顺序返回。任一分支失败后汇总 `BrowserError.errors` 与已成功的 `BrowserError.results`，不重试动作；用显式 `tab=` 核实未知结果。同一页的动作仍串行，同一会话仍只能运行一个脚本进程。

### Click receipts

`click_element(...)` returns `effect: "observed"` when the action causes a DOM, URL/document, focus, form submission, or request change within about 1.5 seconds. `delivery: "confirmed"` records event delivery. It is not a business success check; read the resulting page and check the expected outcome.

If no effect is observed, it raises `BrowserError` with `code == "click_no_effect"`, `effect == "unobserved"`, and a fixed `suggestion`. Do not loop or automatically replay the click; read the page in a new script or reconcile the uncertain action first. The pointer path uses real CDP input in hidden tabs too; synthetic input is used only when real delivery is unavailable.

```python
# 中文注释：观察到页面效果后仍检查业务结果；没有效果时不重复点击。
try:
    receipt = click_element("Apply", role="button")
    print(receipt.get("effect"))
except BrowserError as error:
    print(error.code, error.effect, error.suggestion)
```


## 局部无障碍读取与树形结果

官方 `browser_snapshot` 使用同一份语义数据展示所属区域、记录、控件状态和 `@eN`，容器不创建动作别名。Python 的 `semantic_snapshot` 仍返回结构化数据，可明确请求局部浏览器语义：

```python
# 中文注释：只补充指定区域内的控件，不读取 AX value；完整性不足时先缩小 root。
page = semantic_snapshot(root="#actions", mode="interactive", accessibility=True, budget=5000)
print(page["items"])
print(page["coverage"])
```

`accessibility=True` 不支持分页或增量基线，最多查询 16 个复杂控件；`axEnriched`、`axOmitted` 和 `axDiscoveryComplete` 说明覆盖范围。带值控件及私密名称来源不进行 AX 查询。不要在不完整范围内推断唯一目标。

虚拟表格的 `row`、`column` 使用从零开始的 ARIA 业务索引，`domRow` 保留本次 DOM 顺序；`observedRows` 与 `declaredRows/declaredColumns` 分开。声明总量不是已读取总量，仍须检查 partial 和 warnings。
