# 产品功能与模块索引

本文描述当前开发版本的功能、入口、模块归属和优化边界。源码版本号为 1.7.1，macOS 开发预览。历史版本的真实浏览器验证不代替本次验收，结果见 [测试说明](testing.md)。

## 1. 浏览器连接与授权

连接用户正在使用的 Chrome / Edge，复用登录状态。任务绑定可信 Hermes 会话、浏览器实例、允许来源、标签租约和代次；扩展批准动作。断线、取消、撤销或代次变化不自动恢复旧授权。

- 入口：`browser_shared_open`、`browser_shared_browsers`、任务管理工具。
- 实现：`executor-plugin/native_runtime.py`、`native-bridge/daemon.py`、`native-extension/core.mjs`。
- 优化边界：标签组隔离资源，不隔离账号；新增网站工具不能绕过此链路。

## 2. 网页读取与交互

提供正文、表格、表单、记录字段提取和语义引用；保留覆盖、不完整、分页和来源信息。交互执行前检查元素可见性、遮挡、文档和引用状态。坐标操作绑定截图。原生对话框、文件上传下载和人工敏感输入使用既有接口。

- 入口：`read_page`、`parse_page`、`extract`、`click_element`、`wait_for` 等 Python helper。
- 实现：`page-semantics/`、`browser-interactions/`、`native-extension/core.mjs`。
- 优化边界：页面解析不保证包含未加载或虚拟化记录；动作派发成功不等于业务处理成功。

## 3. Python 执行与网站工具

### 3.1 一次性脚本

`browser_shared_script` 在独立 Python 进程运行多步操作。每个 helper 复用现有受控动作，保留未知结果、等待审批和显式检查点语义。每次调用的内存变量不延续；工作目录文件延续。

### 3.2 可复用网站工具

固定三个入口，避免为每个站点增加常驻工具：

| 入口 | 功能 |
| --- | --- |
| `browser_site_search` | 按网站、名称、描述、来源搜索已启用工具；返回参数、结果契约和版本摘要 |
| `browser_site_manage` | `define` 定义草稿、`try` 实际试运行、`activate` 启用、`discard` 丢弃 |
| `browser_site_run` | 传入网站、工具名称和参数，执行已验证版本 |

定义必须包含 `site`、`name`、`description`、`origins`、`access`、`args_schema`、`result_schema`、`code`。代码只允许顶层 `def run(args)`，返回可序列化 JSON；函数体可使用现有 Python helper。定义阶段不执行代码。

参数和返回值使用固定 JSON Schema 子集：object、array、string、integer、number、boolean、null；支持 properties、required、items、enum、数值及长度上限。对象拒绝额外字段，不支持的关键字直接拒绝。

验证流程：

1. 定义生成草稿，搜索中不可见。
2. `try` 先校验参数和断言，再执行当前任务中的真实动作。退出码为 0 不代表完成；宿主按操作账本和在途状态返回 execution_complete，异常即使被脚本捕获也不改变该判断。待审批、待人工输入和未知结果不能通过试运行。
3. 结果通过返回契约和所有断言后，记录代码摘要、参数摘要、时间和通过状态。不持久化样例参数、结果正文或断言值。
4. 启用时重新核对定义摘要与正式版本基线。定义改动或正式工具被别人更新时拒绝启用。
5. 正式调用重新校验参数、结果和当前任务授权。启用不是长期授权。

断言结构为 `{path, equals? , min_items?}`。path 是相对业务返回值的点路径，支持数组下标；无 equals/min_items 时检查路径存在。空列表需显式使用 equals: []，字段缺失与 null 不混为一谈。一次通过只覆盖该样例，建议再验证空结果、分页、登录失效及字段缺失。

存储位于 `$HERMES_HOME/plugin-data/browser-link-native/site-tools/`，目录 0700、记录 0600，跨进程非阻塞锁，原子替换。试运行期间其他管理操作返回 `store_busy`，不静默等待或重跑。最近保留 16 次试运行摘要。

- 实现：`executor-plugin/site_tools/store.py`、`tools.py`，复用 `script_lane/`。
- 权限：试运行和正式运行都要求绑定任务包含定义所需来源；实际每个动作继续执行既有授权检查。origins 是前置需求，access 是行为声明，均不是沙箱。
- 限制：Python 仍以本机用户权限运行。不要把网页文字当 Python 执行。写工具试运行会真的写入；异常、超时、输出不完整后应核对现场，不自动重试。业务结果须放进有界 JSON，额外 print 进入有界 stderr。
- 当前不包含：内置第三方网站适配器库、工具市场、自动定时运行、跨账号隔离或 JavaScript 常驻 REPL。

## 4. 网络证据

在已授权任务中，`network_start()` 建立主标签页捕获，返回 captureId；`network_list(capture_id)` 返回请求摘要；`network_detail(capture_id, seq)` 返回指定请求的过滤后 JSON 正文；`network_stop()` 清除缓存。

| 字段 | 含义 |
| --- | --- |
| captureId | 本次捕获身份；重启捕获后旧身份失效 |
| seq | 本次捕获内的请求标识，供详情查询 |
| updatedSequence / cursor | 请求状态变化的序号；后续列表用 after_sequence 读取变化 |
| hasMore | 当前过滤范围仍有更新可读；必须继续使用返回游标 |
| dropped | 已淘汰的条目数；非零时不能宣称采集完整 |
| body.nextStart | 同一已缓存正文的下一段偏移；不是网站分页 |
| body.withheld / reason | 正文未返回的原因，如尚未完成、非 JSON、超限、二进制或 CDP 缓存失效 |

只保留当前任务允许来源的主标签请求，不合并子 frame session。URL 摘要删除查询与 fragment，不返回请求头；正文递归替换凭据类字段及 Bearer 值。此规则不是通用个人信息过滤，业务正文仍可能含用户数据。

每页最多保留 128 个请求，原始正文读取阈值 65,536 字符，详情每段最多 20,000 字符。Chrome Network 缓存配置为总计 1 MiB、单资源 64 KiB；CDP 返回正文后再检查限制，并非对浏览器进程内存的绝对约束。缓存仅在内存中，不写诊断日志。撤销浏览器访问、停止捕获、标签页离开授权来源或关闭后不可继续读取。授权来源内的导航与遮罩重建仅清理文档资源，保留网络捕获 ID 和有界记录。

捕获与原始 CDP 事件缓冲独立，列表查询不消耗 `expect_response` 的事件。相关时间窗口只提供证据，不保证每个请求都是某次操作导致的。

- 实现：`native-extension/network-evidence.mjs`、`page-runtime.mjs`；协议动作 `network.inspect`；Python helper 位于 `script_lane/child.py`。
- 当前不包含：静态脚本接口扫描、任意 HAR 导出、响应全文持久化。

页面运行资源随任务释放。JavaScript 的 world 参数仅选择执行上下文。智能审批逐项批准 JS/CDP 调试动作；全部访问直接执行。原始 CDP 可以读取任务页中的其他来源子框架，事件不按来源过滤；Cookie、Set-Cookie、Authorization、Proxy-Authorization 请求和响应头及 Bearer 值始终剥离。顶层任务页离站时停止派发，返回任务来源后需重新建立网关。

智能审批下，任务首次读取某个顶层网站来源时确认一次，审批面板说明任务、网站和可读取页面内容；同站后续读取直接执行。导航或新建工作页的批准可同时批准目标网站的读取，写入和调试命令仍逐项询问。切回智能审批、任务结束或新代次会清空旧网站读取批准。`tabs` 仅返回本任务租约标签，不暴露浏览器其他标签。

## 5. 页面请求

`page_request(url, fields=[...])` 在已授权页面的隔离世界内发送同源 GET/HEAD，使用该页面的登录态。只返回指定 JSON 点路径对应字段，保留缺失字段、HTTP 状态和大小信息。

- 使用浏览器两档模式，沿用 `js.evaluate`；智能审批需用户批准本次页面请求。
- 仅支持与当前页面完全同源的 HTTP(S) URL；拒绝含账号密码的 URL 和所有重定向。
- 不接受自定义请求头、POST、请求体或凭据参数。
- 默认响应上限 64 KiB，最大 128 KiB；流式读取超限即取消并返回 `response_too_large`。
- 超过 16 层的结构明确标记 structureTruncated，并将 complete 设为 false。HTTP 失败、非 JSON、JSON 无效、缺失字段和请求超时分别报告，不返回伪造空数据。
- fields 不能选择凭据类字段；选中对象内部继续递归过滤。过滤不是通用 DLP。
- GET 也可能触发业务副作用；使用前核实接口语义。失败、超时不会重放请求。

实现：`executor-plugin/script_lane/page-request.js` 和 `child.py`。现有本机 `api_request` 保持独立的受限读取契约。

## 6. 诊断与接口发现

### 6.1 只读 doctor

`browser_shared_doctor` 或源码命令 `python3 native-bridge/doctor.py --hermes-home <目录>` 检查：插件 manifest 是否存在、Chrome/Edge 的 Native Messaging 注册与可执行启动路径、已有宿主的认证连接、扩展连接状态。返回分层检查项和修复建议，不启动服务、不重启、不修改文件或恢复授权。

连接正常与浏览器访问授权分开报告。任一浏览器注册有效即可通过注册层；不要求同时安装两种浏览器。插件文件存在不证明 Hermes 已启用或加载插件，doctor 也不证明某个任务可执行。

### 6.2 生成文档和在线能力

`python3 scripts/generate-browser-reference.py` 从实际 HELPERS 导出、函数签名、docstring 和工具 schema 生成 [接口参考](browser-api-reference.md)。`--check` 检查漂移，并已接入核心测试。

`browser_shared_reference(instance_id=...)` 用只读探针读取当前已连接扩展上报的能力，仅展示该实例支持的 helper。未连接或没有上报能力时不推断支持；不指定实例时返回可选浏览器与工具入口。接口存在不等于当前任务获得授权。

实现：`executor-plugin/reference.py`、`native-bridge/doctor.py`、扩展握手及 daemon 的能力投影。

## 7. 自动屏蔽、任务可视化与桌面入口

- 扩展弹窗：从当前 manifest 显示版本，提供权限模式、当前任务控制和自动屏蔽；不再展示额外区域、模拟鼠标或 Cookie 镜像设置行。
- 自动屏蔽：`content-filter.mjs` 提供中英文规则，`content-shield.mjs` 按 CSS 文本块归并、定位和脱敏，`core.mjs` 与 `bridge.mjs` 在执行及回放出口核对设置、文档和图像遮罩。具体支持及拒绝边界见 [内容屏蔽](content-shield.md)。
- 任务鼠标：`automation-overlay.mjs` 在执行和等待下一步时持续显示，沿目标位置平滑移动，接管、断连和终止后隐藏；截图期间隐藏浮层并恢复。可视动画不额外派发网页输入。
- Cookie 镜像：Hermes 桌面插件页提供站点、目标、选项及状态。居中、不透明的原生 dialog 保留焦点隔离、Esc 和返回焦点；每次复制仍须源扩展批准。

## 8. 正式版自动更新

`executor-plugin/maintenance/update.py` 提供正式版检查、手动更新和每小时检查/空闲安装。GitHub digest、ZIP 路径、完整包清单、版本及扩展身份校验后，复用 `install-cli.py` 和 `install-executor.py` 的事务、备份及回滚；安装、更新、卸载共用目录锁。应用运行时延后，不自动退出程序；开发预览版不进入自动更新通道。见 [安装与更新](installation.md#automatic-updates--自动更新)。

## 9. 测试与后续优化入口

| 模块 | 自动测试 | 优化时需要保留的约束 |
| --- | --- | --- |
| 网站工具 | `tests/site-tools/test_sites.py` | 未验证不可见、断言先验、修改失效、冲突拒绝、相同执行链 |
| 网络证据 | `tests/network-evidence/network.test.mjs` | 来源隔离、分页、条目淘汰可见、撤销失效、与原始事件独立 |
| doctor / 文档 | `tests/site-tools/test_reference_doctor.py` | 诊断无写入、不启动服务、缺失能力不推断、生成文档一致 |
| Chrome / Edge | `tests/site-tools/real-sites.mjs` | 临时 profile、安装包、HttpOnly 测试登录态、真实 helper 调用 |
| 全量集成 | `npm run verify` | 身份、协议、授权、打包、回归测试清单完整 |

优化顺序建议由真实使用问题决定：先维护少量可复用网站工具及失败样例，再考虑接口候选分析和定位引擎替换。不要为了覆盖站点数量引入未经验证的适配器。
