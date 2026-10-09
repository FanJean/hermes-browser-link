---
name: batch-scrape
description: Use browser_shared_script to read, locate elements by meaning and act in bulk in the user's authorized browser with Python — paging, extraction, de-duplication, saving, multi-step forms. Fewer model round trips.
---

# Batch page work with Python

First bind this session to a ready task with `browser_shared_open`; use its summary before another snapshot. Then run bounded steps with `browser_shared_script(code=..., timeout_s=...)`. Each call is a new Python process; the working directory is kept between calls. Do not carry element refs or approvals across calls. Use this tool set for the whole page workflow; do not mix in `browser_exec`.

## Helpers

| Function | Purpose |
|---|---|
| `new_tab(url)`, `goto_url(url)` | Open / navigate a work tab within the approved sites |
| `wait_for_load(timeout=15, until='interactive')` | Wait until the DOM is readable (`interactive`); pass `until='complete'` only if images/ads must finish; tolerates a slow page being replaced. Not proof that dynamic content is present |
| `wait_for(selector, state='present', timeout=10)` | Returns dict `{satisfied,timed_out,last_observation,coverage,reason}`; state=present/absent/text/count/stable; timeout `(0,60]` seconds. On false change locator or stop; never repeat the same wait |
| `read_page(query='', root=None, mode='content', budget=3000)` | Returns dict `{binding,snapshotId,items,coverage,nextCursor,...}`; read `page['items'][:5]`, never `page[:500]`. Use query/root; mode=content/table/interactive |
| `semantic_snapshot(**options)` | Same dict contract as read_page; follow coverage, nextCursor and delta |
| `frame_catalog()` | List the page's frames; only approved origins get a `frameToken`; writes in cross-origin frames need full access |
| `wait_for_element(name, role=None, root=None, exact=True, timeout=10)` | Wait for exactly one enabled match (max 60 s); returns `snapshot` / `ref` |
| `click_element(name, mode='pointer', **options)` | Locate in a fresh snapshot and click once; inspect delivery for trusted or background synthetic input |
| `fill_element(name, text, **options)` | Locate in a fresh snapshot and fill once |
| `scroll('down' / 'up')` | Controlled scroll; locate again afterwards |
| `click`, `fill`, `press`, `ref_click`, `ref_fill`, `ref_press` | Lower-level actions; `ref_press` keys: Enter, Tab, Escape, ArrowDown, ArrowUp. Authorization and sensitive-field checks still apply |
| `ref_set_checked(snapshot, ref, checked)` | Native or ARIA checkbox/switch/radio; a radio can only be checked; check `verified` |
| `ref_select_option(snapshot, ref, values, by='value')` | Native single/multi-select by exact value, trimmed Unicode label or zero-based index; custom ARIA combobox/listbox with `aria-controls` uses trusted pointer input; check `verified` and `selectedOptions` |
| `upload_files(selector, paths=[...])` | Select files the user named into a visible file input in the main document; then confirm on the page that the site accepted them |
| `downloads()`, `wait_for_download(timeout=30)`, `claim_download(id)`, `cancel_download(id)` | Task downloads; `claim_download` copies a verified file into the working directory |
| `evaluate(function, arguments, world='isolated')`, `js(expression)`, `cdp(method, **params)`, `cdp_events()` | Uses existing task browser access; no separate enable call. Prefer semantic helpers when they suffice |
| `screenshot(path)`, `page_text()` | screenshot returns a path; page_text returns dict `{url,title,elements,...}`. Read `page_text()['elements'][:5]`, never slice the dict |
| `wait_pending(timeout_s=20)` | Wait for the same approval / manual-input request; creates no new action |
| `reconnect()`, `operation_status(request_id=None)` | After a disconnect, verify the task and the request ledger read-only; never replays unknown writes |
| `load_checkpoint()` | Read the business checkpoint passed in this call's `resume_checkpoint`; does not restore an old Python process |
| `reconcile()` | After an unknown outcome, read the page to decide; never replays the action |

## How to work

1. Read the page first and take target names, roles and regions from what you saw. Do not invent selectors.
2. Narrow with `role` / `name` / `root`. A repeated name returns `ambiguous_target` — never just take the first one.
3. `incomplete_target_scope` means the region was not fully read: narrow `root` / `query` and read again; do not ignore coverage.
4. Locator helpers read the main document by default. `semantic_snapshot(composed=True)` also reads open Shadow DOM and same-origin iframes; `frame_catalog()` tokens let you locate inside approved cross-origin frames. A semantic write may scroll the target into view once; if it then moved or is still covered, it is refused — read the page again.
5. Put the steps you have already decided on, plus the read-back you need, in one script. Re-read inside that same script; no extra model call is required. Print only target items, coverage and counts. Narrow query/root or parse_page sections; keep nextCursor and warnings. `stdout_prefix` / `stderr_prefix` clipping means output is incomplete, not that the page was fully read. Save large extraction to the workspace; return count/path/coverage and read the file by ranges later. Full-source reading tasks still require complete bounded continuation. A click receipt is not proof of a business result.
6. After `ApprovalRequired` / `UserInputRequired`, call `wait_pending` and continue with the next step. Do not call `click_element` or `fill_element` again — that would create a second action.
7. Unknown outcomes, stale refs, denials and disconnects: never retry a write automatically. Verify the page; if you cannot tell what happened, stop and report.
8. For collection, set an explicit limit, a stable de-duplication key and a checkpoint. The number of semantic items is not the number of records; handle paging and truncation.

```python
# 中文注释：名称和区域来自已读页面；只组合已决定的动作，不加入最终提交。
try:
    click_element('Search', role='button', root='#search-form')
except ApprovalRequired:
    wait_pending(timeout_s=30)
wait = wait_for('#results tr', timeout=10)
if not wait['satisfied']:
    raise RuntimeError('换定位或停止，不重复等同一条件')
page = read_page(root='#results', mode='table')
print({'coverage': page['coverage'], 'items': page['items'][:5]})
```

Use the current owned work tab; with multiple tabs select `use_tab(tab_id)` or pass `tab=`. Do not create an extra tab just to select one.

## JS 传值

先用 read_page/extract。确需 JS 时用函数参数，不拼接业务数据到源码：

```python
# 中文注释：选择器先从页面确认；特殊字符通过 arguments 传值。
text = evaluate('(selector)=>document.querySelector(selector)?.textContent', '#result')
count = evaluate('(selector)=>document.querySelectorAll(selector).length', '#results tr')
print({'text': text, 'count': count})
```

`isolated` 共享 DOM，不共享网站 JS 全局变量；需要已确认的网站变量才显式 `world='main'`。隔离世界不是只读沙箱；连接授权后 JS 直接执行，任务来源、租约、凭据排斥和内容保护仍生效。语法/selector 错误先修正，不自动切 main 或重放有副作用的函数；点击/填写优先用已有 locator/ref helper。

## 填表与人工交接

同一页有两步以上（填表、翻页、采集、点击后读取结果）时，用一次 `browser_shared_script`。对同一页面状态选择一种读取方式，不连续调用 `semantic_snapshot`、`page.parse`、`js.evaluate`。表单字段名先从真实页面读取：

```python
# 中文注释：审批或人工输入只等待原请求；不重新派发可能已执行的动作。
def once(action):
    try:
        return action()
    except (ApprovalRequired, UserInputRequired):
        return wait_pending(timeout_s=60)

# 中文注释：字段名和区域先从当前页面读取；示例值与文件路径须替换为用户提供的数据。
form = once(lambda: read_page(root='#submission-form', mode='interactive'))
assert form['coverage']['complete']
filled = [once(lambda: fill_element('Team name', 'Example Team', root='#submission-form')),
          once(lambda: fill_element('Product', 'Example Product', root='#submission-form'))]
category = once(lambda: wait_for_element('Category', role='combobox', root='#submission-form'))
selected = once(lambda: ref_select_option(category['snapshot'], category['ref'], ['Software'], by='label'))
# 中文注释：文件路径必须由用户在本次对话中指定；此处只选择文件，不提交表单。
uploaded = once(lambda: upload_files('input[type="file"]', paths=['/path/from/user/document.pdf']))
checked = once(lambda: read_page(root='#submission-form', mode='content'))
print({'filled': [item.get('verified') for item in filled],
       'selected': selected.get('verified'), 'files': uploaded.get('selectedFiles'),
       'form_readback': checked['items'][:20]})
# 中文注释：核对页面反馈后停在提交前，不点击最终提交按钮。
```

需要用户处理人机验证、敏感字段或付费时，结果列出工作标签页 ID。会话结束后待人工处理的工作页及标签组会保留，任务权限和遮罩会撤销。验证码、Turnstile、最终提交这类执行器看不到的人工步骤，用 `browser_shared_close(task_id, keep_tabs=true)` 把工作页明确交给用户；不要对已交给用户的页调用普通关闭。后续要自动操作必须重新调用 `browser_shared_open`。

## Reuse verified workflows

Use only data and destinations supplied or approved for the current task. Local export roots are user configuration; do not assume any private directory layout or project-specific workflow.

Search `browser_site_search` before repeating a known site workflow. `browser_site_manage` defines a `def run(args)` draft with argument/result schemas, runs a real trial with result assertions, and activates a passing unchanged draft. Writes during a trial have real effects. Use `browser_site_run` only within the bound authorized task. A read/write label never grants authority.

For network inspection, use `network_start`, `network_list(capture_id)`, `network_detail(capture_id, seq)` and `network_stop`; summaries and detail reads do not drain CDP events. `page_request(url, fields=[...])` performs a bounded same-origin GET/HEAD through the existing evaluation permission. It rejects redirects and returns failures explicitly. Treat credential-key filtering as a limited heuristic. Use `browser_shared_reference(instance_id=...)` for exact currently supported helper signatures.

## 显式选择工作页

`new_tab(url)` 返回 tab id，并将它设为当前页。使用 `current_tab()` 查看、`use_tab(tab_id)` 切换；页面 helper 支持关键字 `tab=`，只作用于指定页，不改变当前页。多页脚本推荐始终传 `tab=`。官方工具使用 `browser_shared_use_tab(tab_id)` 选择当前页；`browser_shared_open` 成功后自动选择刚打开或复用的页。不同网站的任务同时保留，撤销一个任务不撤销其他任务。

读动作只等待 DOM 的 `interactive`/`complete`，上限 1.5 秒。导航和新建页最多等待 8 秒；正文已解析且稳定可返回 `partial`。`goto_url()` 回执默认附摘要，可用 `summary=False` 关闭。等具体元素用 `wait_for(selector, ...)`；已有可读回执时不要再叠加 `wait_for_load()`。

`redirected_out_of_scope` 的 `final_origin` 只含来源；用它调用 `browser_shared_open` 新开任务。多台已启用浏览器可在 Hermes 进程环境中设置 `HERMES_BROWSER_DEFAULT=edge`、`chrome` 或具体 instance ID；显式 `instance_id` 优先。

`parallel(fn, tabs)` 对每个页执行 `fn(tab)`，结果按输入顺序返回。同站顺序读多页时复用同一标签；需要同时等待至少三张慢页时才并行建页，模型标签最多四张。任一分支失败后汇总 `BrowserError.errors` 与已成功的 `BrowserError.results`，不重试动作；用显式 `tab=` 核实未知结果。同一页的动作仍串行，同一会话仍只能运行一个脚本进程。

| 场景 | 标签操作 |
|---|---|
| 同站顺序读多页 | `goto_url(url)` 复用当前标签。 |
| 同站至少三张慢页需同时读取 | 在同任务打开最多四张模型标签；`parallel(lambda tab: read_page(tab=tab), tabs)` 并行读取。 |
| 换站且以后还要返回 | `browser_shared_open` 建新任务并保留旧任务。 |
| 会话结束或人工接手 | 关闭自动化任务；人工接手页用 `keep_tabs=true` 保留。 |
