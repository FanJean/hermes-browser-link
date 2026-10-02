# Features and limits

V1.3 development builds add page parsing, schema extraction, parameterized functions, conditional waits and compact task interfaces. See [Python scripting](python-scripting.md#v13-parsing-and-conditional-execution) for their contracts. The capabilities below retain the V1.1 baseline. "Verified" means exercised end to end in real Chrome and Edge, not only in unit tests. The verified environment is macOS with Chrome 153, Edge 153, Hermes commit `e62a47a` and Browser Use CLI 0.13.7.

## Capabilities

| Area | What is supported | Limits |
|---|---|---|
| Connection | Existing Chrome/Edge instances over Native Messaging; several browsers at once | Does not start browsers or copy profiles. Task isolation is not cookie or account isolation. |
| Tasks and tabs | Per-task tab groups, exclusive tab leases, resume with a new generation, cleanup of task-created tabs only | Tabs you move out of the group or whose ownership is unclear are left alone. |
| Page reading | Semantic snapshots (content, tables, interactive), filtering by region/name/role, paging and incremental deltas | Smart mode confirms a task's first read of each site; later reads of that site run directly. Tabs list only that task's leased tabs. Not a full accessibility tree. |
| Targets | Open Shadow DOM, closed Shadow DOM in the main document, same-origin iframes, approved cross-origin (OOPIF) frames via `frame_catalog` tokens | Closed Shadow DOM inside same-origin iframes is not supported; rotated or skewed frames are rejected. |
| Actions | Confirmed reference clicks (trusted when visible, synthetic when hidden), fill, bounded key presses, checkboxes/radios/switches, native single/multi-select and ARIA single-select controls, scrolling (page or a specific container), back | Each action rechecks visibility, occlusion, stability and staleness before dispatch; nothing is retried after dispatch. |
| Screenshot-bound interactions | Capture, element bounds, coordinate click, pointer drag and HTML5-synthetic drag | Coordinates are raw PNG pixels from the same capture. Hidden coordinate clicks use confirmed DOM events; hidden pointer drags are rejected. Synthetic HTML5 drags report `isTrusted: false`. |
| Python scripts | `browser_shared_script` with page, file, download and page-execution helpers; request ledger, reconnect and explicit checkpoints | Each run is a new process running as your user — not an OS sandbox. A crashed script's Python state is not restored. |
| Page execution | Page JavaScript (isolated or main world), raw CDP, CDP event reads, `browser_exec` gateway | Smart mode asks for approval before execution; full mode runs directly. CDP events include other frame origins, while credential headers and Bearer values are removed. Credential fill and scripts cannot share a page. |
| Uploads | Local paths named in conversation, copied into task-private storage, selected into a visible file input in the main document | Up to 10 files, 100 MiB each. Hidden inputs and inputs inside frames are not supported. The OS file dialog is never driven. |
| Downloads | Attribution to the task, cancel, claim with size and digest verification | Ambiguous concurrent downloads are never claimed automatically. |
| Credentials | Optional takeover of Hermes' Vault tools: list, fill, TOTP entry, save login through a private local channel | Off by default. External password-manager CLIs must be installed and unlocked separately. Payment cards and addresses are not handled. |
| Official tools | 18 official Hermes browser tools and 28 `browser_exec` helpers, routed for bound sessions (see [usage](usage.md#hermes-official-browser-tools)) | Verified only against the Hermes / Browser Use versions above. `browser_snapshot(full=true)` is not supported. |
| Visibility | Click-blocking overlay for the whole task (including reloads and navigations), status bar, take-over/stop, per-action target highlight | During the brief dispatch of a click, key press or drag the overlay lets that input through. |
| Diagnostics | Correlated, field-allowlisted event log; per-task step log on the Hermes Browser work page | Never records page text, credentials or free-form exception text. |

## Not supported

- A standalone browser, headless mode or profile cloning.
- Automatically claiming popups or windows opened by page scripts.
- Restoring an arbitrary Python process after it exits (resumption is cooperative, through explicit checkpoints).
- Cross-origin, mutating, or `Authorization`/CSRF-protected API calls through `api_request`.
- A built-in credential store, a third-party site-adapter catalog or a persistent result center.

## Current development additions

Verified custom site-tool drafts, bounded network evidence, same-origin page requests, read-only doctor and generated capability-aware API reference are described by module in the [product catalog](product-modules.zh-CN.md). These additions reuse the existing task and script execution chain. Development completion does not mean a personal installation or public release has been updated.

## Cookie 镜像（1.5.0，真实浏览器待验收）

源扩展弹窗读取默认 store Cookie 清单，按站点聚合、搜索和勾选，可选择另一个已连接 Chrome/Edge 或同浏览器的另一个 profile。可选清除目标站点旧 Cookie；默认关闭。会话 Cookie 默认保持会话属性，也可显式保存 1–365 天。每次复制均在源扩展确认面板批准，包括全部访问模式。

`browser_shared_cookie_mirror` 提供 `list_sites`、`request_mirror`、`status`；仅返回站点、数量、状态及失败类别。值仅一次性内存中转，60 秒含确认时间，断连/失败销毁，不写任务账本或文件。仅 Cookie 登录态，无法保证服务端接受；不复制 localStorage、IndexedDB、客户端证书或设备密钥。回读匹配与实际登录是两个验收步骤。

域去掉前导点后按可注册域聚合，包含子域；`co.uk`、`com.cn` 等常见多段后缀使用内置小表。没有完整 PSL，未知多段及私有后缀可能聚合过宽，应在确认时检查站点和数量。仅默认 store，不处理隐身窗口。分区写入失败单独计数，不中断其他 Cookie。
