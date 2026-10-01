# Changelog

## 1.4.4 — 2026-10-02（开发预览）

- 明确 helper 字典返回、JS 参数传值、按动作必填 tab_id 和 60 秒等待上限；参数错误只返回字段名。
- wait_for 使用有界轻量观察，命中或截止后完整解析一次；保留来源、文档、接管、撤权和脱敏检查。
- open 以正文/控件意图单次生成摘要，加载或摘要失败返回固定原因；裁剪附类别与续读提示。
- 跨站拒绝补已核实的当前 origin；overlay/文档诊断补固定阶段原因，不改变授权与拒绝行为。


## 1.4.3 — 2026-10-02（开发预览）

- 每轮完成由常驻 daemon 宽限 10 分钟后按 handoff 结束任务；同会话再次调用任意 `browser_shared_*` 取消计时，CLI 完成后退出仍保留宽限。
- 失败、中断与 `/stop` 立即结束该会话全部任务。
- ready 任务默认 60 分钟无调用自动结束，启动扫描保留旧活动时刻；用户暂停和等待人工处理的任务免于扫描。
- 收组使用扩展私有创建日志、组 ID 与窗口；改标题不阻止清理，用户移走的页、用户原有页和浏览器重启后无法验证的旧 ID 保留。`keep_tabs=true` 保留移交页并收组。
- 新增残留任务清理脚本，默认只读预览，显式执行后清理。

## 1.4.2 — 2026-09-30（开发预览）

- 截图跳过不可见的敏感输入；可见敏感字段及无法检查的框架在截图字节上遮罩，失败返回具体错误码。
- `screenshot` 可保存到 `HERMES_BROWSER_EXPORT_ROOTS` 允许的绝对目录，拒绝越界和覆盖；可按名称或选择器先滚动到目标。
- 名称匹配识别可选、必填、首尾星号和冒号；按钮型 input 使用 HTML 可访问名称，首屏外目标可定位。
- 同名填写目标优先可编辑项；透明单选与复选框可通过关联 label 可信点击，仍核对实际状态。

## 1.4.1 — 2026-09-30（开发预览）

- 接管先放行页面输入，再等待在途步骤收尾；脚本可等待同一任务恢复，`browser_shared_get` 支持 `until=resumed`，恢复后返回结构性变化摘要。接管快捷键为 `Ctrl+Alt+Shift+F12`。
- 步骤日志按任务保存为 JSONL，并在浮层显示最近五步；诊断保留受限的具体错误码与动作类型。
- 高亮跟随目标几何变化，显示动作与控件名称；增加默认开启、可在扩展弹窗关闭的模拟鼠标。
- 扩展和桌面插件可设主要链接；守护进程跨 profile 保存，打开任务按显式实例、主要链接、环境默认值和唯一实例的顺序选择。
- 迁移脚本修复 profile 旧插件软链接并提示重启网关；名称精确匹配忽略末尾必填标记和多余空白。

## 1.4.0 — 2026-09-30

- 改名为 hermes-browser-link；扩展显示为 Hermes Browser Link，插件 ID 为 `browser-link`，宿主为 `com.hermes.browser_link`。
- 扩展使用 manifest 公钥固定 ID；宿主仅允许对应的一个来源。
- 提供默认 dry-run 的迁移脚本：备份目录及配置、停止旧守护进程、保留数据权限、更新安装与启用项，验证后归档旧目录；失败回滚。
- 迁移步骤和回滚方法见 [迁移说明](docs/migration-1.4.0.md)。工具名及权限模型不变。

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 1.3.6 — 2026-09-30 (developer preview)

### Changed

- 同一会话同源打开默认复用 ready 任务及工作页；`new_task=true` 可建立独立任务。第五张模型工作页会回收最久未用的模型页，并在回执中列出。
- 同任务新标签的加载等待不占任务写屏障；正文已解析且稳定的慢页可返回 `ready: partial`。
- 打开和导航默认返回有上限的语义摘要及可复用引用，可显式关闭；选择器动作需要时居中滚动，派发前几何与状态拒绝标为未执行。
- 浏览器技能和工具描述增加单页脚本、摘要优先及任务与标签使用规则。

## 1.3.5 — 2026-09-30 (developer preview)

### Fixed

- 滚动动作增加短期限；单次扩展超时保留任务、代次和标签租约，并禁止重放同一请求。
- doctor 对单次探测超时返回未确认；解析预算、JS 语法和运行异常返回固定错误码。
- 隐藏文件输入使用关联可见区域高亮，文件选择后读回数量与文件名。
- 视口外的可交互目标滚动到中部；固定浮层视口外目标直接返回可恢复提示。
- 基准评分识别 Hermes 元工具调用及回执包装；修正表格脚本引号与诊断导出读取。

## 1.3.4 — 2026-09-29 (developer preview)

### Fixed

- 普通表单 CSS 类、`data-*` 属性及外层标签说明不再误判为密码、支付或验证码；真实敏感字段仍交给用户填写。
- 扩展和脚本对已识别的目标、页面状态及连接错误返回固定错误码，保留结果不确定标志。
- 非默认 profile 从共享 Hermes 根目录读取默认浏览器配置，显式实例选择仍优先。
- 会话结束时，等待人工处理的工作页和标签组保留，任务权限、租约和遮罩撤销。

### Changed

- 工具说明建议同一页多步操作使用一次脚本并读取一次页面；截图路径错误显示允许的工作目录。

## 1.3.3 — 2026-09-29 (developer preview)

### Fixed

- 脚本异常显示可信错误码，区分确定未执行与结果不确定；扩展固定错误码进入脚本回执。
- 普通租约工作页可以查询 `official.ready_state`；`wait_for_load()` 对加载中的临时目标不可用持续轮询。
- 同协议 apex/www 跳转加入当前任务来源；其他跳转在网址提交后返回 `redirected_out_of_scope` 和最终来源。
- 新页及导航在 DOM 可交互时返回，最多等待八秒，并报告 `ready` 状态；关闭中的代理页保留租约到清理完成。
- 多台已启用浏览器可通过 `HERMES_BROWSER_DEFAULT` 选择默认浏览器。

## 1.3.2 — 2026-09-28 (developer preview)

### Changed

- 权限统一为「智能审批」「全部访问」两档，删除其余权限等级。全部访问下所有工具、脚本与调试命令直接执行；智能审批下每个任务首次读取某网站需确认一次，写入、按键、调试命令、Vault 等逐项审批，批准随任务结束或切换模式失效。
- 原始 CDP 不再因任务页含第三方子框架或使用 `Page.addScriptToEvaluateOnNewDocument` 而硬拒绝，改按两档权限处理；持久脚本在任务结束或切换模式时移除。原始网络事件不按来源过滤，但始终剥离 Cookie、Authorization 等凭据字段。
- Hermes 桌面面板精简为桥接状态与各浏览器的连接和权限档位；扩展弹窗只保留连接状态、权限两档、当前任务一行状态与「接管 / 继续 / 停止」，文本过滤移入折叠的「更多设置」。
- 语义点击改为确认送达：可见页使用可信输入并确认页面收到点击；后台标签页使用经确认的 DOM 点击并在回执中标注原因，绝不在未送达时回报成功。原生下拉支持中文等 Unicode 选项与多选。
- Hermes 会话或子代理结束时自动关闭其浏览器任务。

### Fixed

- 页面遮罩：动作成功、失败、超时、导航、撤权后都立即恢复拦截；阻断网页模态框、浮层、滚轮与 iframe 焦点绕过；网页修改样式不能获得接管；遮罩被删除或文档替换后自动重建。
- 接管：从弹窗接管会真正暂停任务并放开该任务所有页面；弹窗与遮罩状态同步；继续回执丢失、跨入口提前继续等竞态。
- 任务结束后工作页清理状态误报为未知；关闭浏览器访问后旧任务仍可读取；旧连接与旧代次的迟到消息修改新状态；停止与撤权回执早于持久化。
- CDP 网关死锁与连接配额泄漏、网络证据撤权误报、页面脚本结果序列化超时、下载文件句柄泄漏与误认领、安装器符号链接越界、Vault 填写前未复核字段状态、dev-sync 按 PID 误停无关进程等问题。

### Earlier unreleased changes included in 1.3.2

### Changed

- 删除高级执行模式的独立申请、期限、代次、主上下文授权与提示；JavaScript、CDP、网络观察统一复用任务已有的浏览器访问。停止、接管、断线、来源检查和凭据隔离保持有效。

### Added

- 可复用网站工具：草稿、参数/结果契约、真实试运行断言、版本冲突检测、启用、搜索与执行；复用既有 Python 脚本和任务授权链。
- 任务范围网络证据：独立捕获缓存、请求摘要、JSON 正文分页、来源过滤、淘汰与撤销状态。
- 同源 GET/HEAD 页面请求 helper：登录态复用、重定向拒绝、流式响应上限、字段选择与凭据字段过滤。
- 只读 doctor、按连接实例展示的 helper 能力参考、从源码生成的接口文档，以及按模块整理的产品功能索引。

### Changed

- 开发包包含完整产品文档；自动测试检查生成接口参考是否漂移。
- 真实浏览器验收先展开授权设置，再点击授权开关，避免对隐藏控件发送点击。


### Fixed

- CDP 网关每次派发前后核对当前标签页和目标子 session 来源，离站后旧网关失效，禁止通过缓存会话继续读取外站。
- 脚本正常退出不再覆盖未完成的动作状态；未知结果、待审批和待人工输入不能通过网站工具试运行。
- 授权来源内导航和遮罩重建保留网络捕获；离站、关闭、停止和撤销仍清除缓存。

## 1.3.0 — 2026-09-26 (developer preview)

### Added

- Read-only page parsing and schema extraction with regions, content blocks, table spans/header references, form relationships, bounded results, field provenance and explicit partial coverage.
- Parameterized page functions, conditional read-only waits, response/navigation observation and Markdown derived from parsed blocks.
- Compact popup task controls and a Desktop task/result view with owner-scoped in-memory parsing results and a bounded operation timeline.

### Changed

- Public installation documentation and automated checks.
- Script output is drained through bounded buffers instead of accumulating all output before clipping.
- Current daemon-to-extension requests use monotonic sequence watermarks with bounded response retention; evicted requests cannot replay.
- Daemon cached result bodies have an 8 MiB budget, independent from persisted replay fingerprints.
- Packaging accepts stable release versions and checks package/plugin/extension consistency. The installer still refuses in-place upgrades.


### Fixed

- The page overlay stays in place for the whole task: it is re-installed as soon as a new document's DOM is ready instead of waiting for the page to finish loading, it is kept on the old page while `navigate` / `back` are in flight (and after they fail), and screenshots make it transparent instead of removing it, so it keeps blocking clicks.
- The lightweight pre-overlay also blocks keyboard input, and its safety timeout was raised to 60 seconds.
- Blocking is restored after an action is rejected before dispatch or after access is revoked. In advanced mode, raw CDP input only opens a short pass-through window.
- Slow pages: read-only actions wait up to 8 seconds for the page to load and retry once after transient "document replaced" errors, reported as `page_not_ready`. Raw CDP is refused while the user has taken over the page.


## 1.1.0 — 2026-09-25

First release of the bridge to existing Chrome and Edge browsers.

### Added

- Hermes plugin `browser-executor` with `browser_shared_*` tools, `browser_shared_open` and `browser_shared_script`; local daemon and Native Messaging host; MV3 extension with approvals, overlay and target highlighting.
- Semantic snapshots with references, paging and deltas; composed targets across open Shadow DOM, main-document closed Shadow DOM, same-origin and approved cross-origin frames.
- Semantic actions for click (DOM or trusted pointer), fill, key press, checkbox/radio/switch and select; screenshot-bound coordinate click and drag.
- Browser-level full access: no per-action approvals, and advanced mode (page JavaScript, raw CDP, `browser_exec` gateway) turns on automatically on first use. Advanced mode and credential fill are mutually exclusive on a page.
- Uploads from local paths named in conversation (up to 10 files, 100 MiB each); download attribution, cancel and claim.
- Optional routing of Hermes' official browser tools (18 tools, 28 `browser_exec` helpers) and Vault tools for sessions bound to a task.
- Script-lane request ledger, reconnect verification and explicit checkpoints for cooperative resumption.
- `browser_shared_open` reuses an existing work tab with the same URL when resuming a task.

### Known limits

- `browser_snapshot(full=true)` is not supported; rotated or skewed frames are rejected; closed Shadow DOM inside same-origin iframes is not supported.
- Restoring an arbitrary exited Python process is not supported. External password managers need their own CLI; payment cards and addresses are not handled.
- Advanced-mode results are not redacted.

Verified on macOS with Chrome 153, Edge 153, Hermes `e62a47a` and Browser Use CLI 0.13.7.
