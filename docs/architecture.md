# Architecture

In 1.4.3, the plugin sends completed-turn activity to the shared daemon instead of holding timers in the Hermes process. The daemon persists completion deadlines and task activity, scans on startup, and rechecks identity and activity before applying the existing handoff release. Stop hooks resolve `session_key` through the read-only, exact-scoped Hermes SQLite routing table and then verify the local profile's known owner. Unmapped routes close nothing.

Terminal group removal uses the extension's private workspace request journal and its instance/owner/task/generation baseline, plus the recorded tab/group/window IDs. The caller's title and task inventory cannot establish ownership. Only recorded created tabs are ungrouped; user tabs placed in a task group keep their group. The browser startup fence invalidates old creation proofs; daemon and extension-worker restarts alone do not grant new authority.

```
 Hermes Agent
   │  public plugin API (register_tool, pre_tool_call hook, skills)
   ▼
 executor-plugin/            Hermes plugin "browser-link"
   │  JSONL over a Unix-domain socket (token-authenticated)
   ▼
 native-bridge/daemon.py     per-profile daemon: tasks, leases, request ledger
   │  JSONL over the same socket
   ▼
 native-bridge/host.py       Native Messaging host (4-byte framed JSON ↔ socket)
   │  chrome.runtime.connectNative
   ▼
 native-extension/           MV3 extension: approvals, policy, CDP execution, overlay
   │  chrome.debugger / tabs / tabGroups / downloads / cookies
   ▼
 Work tabs in your Chrome or Edge
```

## Components

| Directory | Role |
|---|---|
| `executor-plugin/` | Registers the `browser_shared_*` tools, `browser_shared_open`, `browser_shared_script`, the optional overrides of Hermes' official browser and Vault tools, the skills, the Desktop page and its HTTP API. Converts trusted Hermes session identity into one-use owner leases. |
| `native-bridge/` | Python standard-library daemon and Native Messaging host. Owns task state, `(instanceId, tabId)` leases, request-ID deduplication, file staging for uploads and downloads, the CDP gateway for `browser_exec`, and the private Vault channel. |
| `native-extension/` | The only place where authorization is granted and page actions run. Validates every action against task, generation, origin and lease; runs page code in isolated worlds; draws the overlay and highlights. |
| `page-semantics/` | Bounded semantic snapshots, references, paging and deltas (runs inside the page). |
| `browser-interactions/` | Screenshot-bound coordinate clicks and drags with identity and occlusion checks. |
| `browser-workspaces/` | Task tab groups: creation, ownership journal, recovery and cleanup. |
| `approval-policy/` | Pure decision function for smart approval vs. full access. |
| `browser-diagnostics/` | Allowlisted diagnostic events (JS buffer and Python JSONL sink). |

The shared JavaScript modules are imported directly in source tests. `native-extension/build.mjs` copies them byte-for-byte into the extension's `vendor/` directory, rewrites the imports and records their SHA-256 in `BUILD-DEPS.json`, so there is a single canonical source for each module.

## Trust boundaries

- **Identity comes from the host.** The model never supplies an owner, approval state or generation. The `pre_tool_call` hook binds each call to the trusted Hermes session and tool-call ID; the plugin injects an opaque one-use lease.
- **Authorization lives in the extension.** Only the extension's own UI can approve tasks or turn on browser-level full access. Web pages cannot message the approval path. Access is never restored automatically after a disconnect or daemon restart — tasks become `needs_sync`.
- **Every action is re-checked.** The daemon checks owner, task state and lease; the extension checks task, generation, exact origin, tab lease and document before and after the work.
- **Unknown outcomes are final.** If a response is lost after dispatch the result is `outcome_unknown`. Request IDs are bound to their payload and remembered (hashed) so a retry cannot run twice.
- **Sensitive fields are for humans.** Password, payment and OTP fields are detected before writes and handed to the user (or to the private Vault channel when enabled).
- **Page content is data.** Text read from a page is never treated as an instruction or as authorization.
- **Shared profile.** Tasks share the browser's cookies and logins. Tab groups separate task resources, not accounts.

## Local service

The daemon listens on `$HERMES_HOME/plugin-data/browser-link-native/bridge.sock` (mode `0600`, directory `0700`) and authenticates clients with a token file that is never written to Native Messaging manifests. It is started on demand by the plugin or the host and is a per-profile singleton. Task metadata is persisted; page contents, typed text and raw request IDs are not. Dispatch fingerprints are appended and fsynced before browser execution. Action snapshots are coalesced over 100ms and written outside the global state lock; task creation, revocation and cleanup flush before returning; recovery merges both files and never restores authorization.

## Execution inside the page

- Page code runs in isolated worlds created through CDP, never by string interpolation of model input. Each world installs the versioned semantic library once; missing-library recovery occurs before action dispatch.
- Page actions serialize per tab and share a task read barrier; task-wide operations take a write barrier. Revocation fences immediately. Background writes verify a mounted, correctly bound highlight without activating the tab. Visible pages retain paint confirmation.
- The overlay is injected into its own isolated world and a closed shadow root. A lightweight pre-overlay is registered with `Page.addScriptToEvaluateOnNewDocument` so a new document is covered from its first paint; the full overlay replaces it as soon as the DOM is ready. During screenshots the overlay becomes transparent but keeps blocking input.
- Screenshots used for coordinate actions are bound to the document, viewport, DPR and scroll at capture time and expire quickly.

## User interfaces

- **扩展弹窗** — 连接状态、浏览器访问、当前页任务状态、接管/继续与停止按钮；**独立确认面板** — 敏感字段人工输入与未开启完全访问时的确认。完全访问不逐项审批；Cookie 镜像仍每次确认。
- **Page overlay** — status, take over, stop.
- **Hermes 桌面面板**（`executor-plugin/desktop/`）— 本地桥接状态、在线/离线浏览器及浏览器访问入口。任务日志、文件和结果不在此展示；诊断工具仍可读取受限诊断接口。

For wire-level details see [protocol.md](protocol.md).

## Reusable site tools and evidence

`executor-plugin/site_tools/` stores inactive drafts, schema contracts and verified revisions. Definition management never executes source. Trial and run enter the existing `script_lane`; every helper still goes through the owner-bound task. Profile-level tool definitions are reusable across sessions, while execution authority is not.

`native-extension/network-evidence.mjs` keeps bounded capture state inside the live task, separately from the raw CDP event queue. Its structured action is routed through the same daemon and extension checks. `script_lane/page-request.js` is the fixed same-origin request function used by the Python helper.

`reference.py` derives documentation from helper exports and registered schemas. `native-bridge/doctor.py` reads installation state and probes an existing authenticated socket without auto-starting the daemon. See the [module catalog](product-modules.zh-CN.md) for ownership, limits and tests.

## Task-group cleanup

Workspace ownership is persisted in `chrome.storage.local`, so extension reloads retain cleanup evidence. The top-level `runtime.onStartup` listener revokes old baselines synchronously and persists that revocation behind a startup barrier; journal initialization checks the startup epoch before accepting a read. Browser-restart records never authorize closing reused tab IDs. Removal also checks group/window identity and the recorded group title, and preserves baseline/protected tabs and tabs moved by the user.

Release fences execution before cleanup and remains bounded. If an in-flight tab lock exceeds the deadline, one cleanup is queued after the outstanding locks settle. Unknown ownership never authorizes deletion. For terminal tasks, the daemon can request non-destructive ungrouping using its recorded `workTabs` and task title, including after extension hello; every page is revalidated under its tab lock. Such results remain `unknown` (`ungrouped_unverified` when pages were ungrouped). `needs_sync` keeps its group for recovery. Chrome does not provide atomic compare-and-remove/ungroup; the final API dispatch race remains.

## 原始 CDP 的框架范围

原始 CDP 的上下文、节点和对象句柄可能指向同一调试目标内的第三方子框架。智能审批在调试命令说明中列出额外来源，批准后执行；全部访问直接执行。事件不按来源过滤，凭据类请求和响应头及 Bearer 值始终剥离。顶层任务页离站时停止派发；派发期间顶层离站按结果未知处理，不重发。

智能审批的低风险页面读取另有任务级顶层来源批准。daemon 在首次读取前请扩展仅回报当前租约标签的 origin；批准后仅该任务、该模式代次可直接重复读取该来源。导航或新建标签的动作审批可同时批准目标来源。扩展在实际读页前后比较 origin，换站时不回传结果。标签列表只遍历本任务的租约标签，不读取全浏览器标签。

原始 `Page.addScriptToEvaluateOnNewDocument` 已禁用：真实 Chrome 中，注册后的脚本会在用户导航到未授权来源时先执行。扩展自己的预遮罩脚本仍按固定来源列表注册；单次页面 JS 执行不受此项禁用影响。

接管先冻结宿主新派发，并等待扩展已有动作收尾，再同步放开该任务全部工作页。此前排队请求因控制代次变化被拒绝，不因继续操作复活。暂停返回 `task_paused` 且不可自动重试；其他任务保持可用。

## Cookie 镜像（1.5.0）

`native-extension/cookie-mirror.mjs` 独立于页面注入与 CDP，以 `chrome.cookies` 查询和写入当前非隐身扩展的默认 store。新增 `cookies` 与全站点 host 权限用于 Cookie 清单与导入；manifest key 和 ID 保持不变。站点清单只暴露域分组与数量。

弹窗和 `browser_shared_cookie_mirror` 共用 `native-bridge/cookie_mirror.py` 通路。源扩展固定内存快照，已有 `approval-notifier` / `approval-panel` 展示源/目标实例、站点、数量和选项；每次必须用户在源扩展亲自确认，全部访问模式也不放行。确认后源逐块取出，daemon 一次性内存块取走即删，目标重组后逐 Cookie 写入并回读身份集合。Native Messaging 每块完整序列化后不超过 256 KiB。

60 秒 TTL 从发起请求开始计算，包含确认时间。失败、过期或任一端断连/被替换清空剩余载荷；正在派发的单次浏览器 API 无法撤回，可能已部分写入。Cookie 通路在 `Bridge` 的通用账本/指纹/重放缓存之前分流，daemon 不调用任务存储、任务日志、诊断或请求账本。Hermes、桌面面板和错误只得到站点、数量、状态和固定失败类别；值不落盘。操作状态仅内存保存至 TTL 到期。

本机同用户进程能读取 daemon 令牌，仍属于信任边界。目标浏览器拿到完整选中登录态；任务结束不会撤销已复制 Cookie。回读匹配只验证导入覆盖，服务器是否承认登录仍须访问受保护页面验收。
