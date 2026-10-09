# Changelog

## 1.9.0 — 2026-10-09

- 移除本地和云端的智能审批开关、模式切换及普通任务重复确认；本地连接授权后，读取、导航、点击、填写、JS/CDP 与 Python 工作流直接执行；云端连接确认后直接读取、点击和填写，不新增任意 JS/CDP 接口。
- 保留接管、继续、停止、凭据保护和任务身份、来源、租约、代次检查；Cookie 镜像及接管已有 OAuth 登录窗口仍需独立确认，个人标签页不会自动授权。
- 桌面连接页只展示读回的连接授权；离线或未知状态不当成已授权。旧智能审批偏好不影响新版连接。
- 云端断连先撤销本机权限，远端离线或撤销失败不能继续派发旧任务；兼容当前已部署的配对交换协议，未确认或错误设备仍拒绝执行。
- 修复登录小窗接管回执的内容保护与未知结果处理；确认后立即安装任务浮层，初始化失败不授予控制权，任务结束保留原小窗。
- 云端连接码复制状态绑定实际复制的码，重新生成或异步复制完成不会误报新码已复制。
- Native host 在两条消息转发线程启动后才发送连接握手，避免启动延迟混入握手后的断连计时；提前到达的浏览器消息仍排在认证之后，保留半截帧、输出堵塞和断管退出回归。
- 更新安装步骤、功能清单、模型工具说明及本地/云端回归；已解压扩展升级后仍需用户重载。
- 使用一份共享主程序与命名 profile 的受控直接引用，迁移旧全副本及未登记入口；保留停用状态、独立配置权限和数据、原链接回滚及升级备份，Hermes Desktop 继续生成应用级界面缓存。
- 桥接在已保存且无未决工作时安全空闲 30 秒自行退出；Cookie 镜像后台清理计入活动。安装与开发同步复用本地/云端互斥门禁，旧云入口须显式维护迁移，旧自动更新器不能绕过保护。

## 1.8.5 — 2026-10-07（macOS 正式稳定版）

- 任务结束保留工作页（`keep_tabs=true`）必须同时给出 `handoff_reason`（captcha/login/verification/final_submit/user_requested），缺失时拒绝；说明改为遇阻、结果未知、读不到或遮挡时记录停点后普通关闭。交接原因写入任务和清理回执。
- 点击前自动滚动，并在约 2.5 秒内等待可见、启用、位置稳定与命中通过；持续遮挡时不派发，返回遮挡元素的角色和名称。
- 点击触发整页导航或 SPA 路由变化时，按本次派发证据判为成功并返回导航信息；已确认动作后的内容保护复查失败只拒绝输出，不再把动作降为结果未知。
- 失败和未知结果的任务日志与工具回执始终带固定错误码、可重试标记和下一步提示；部分送达回执记为未知且不重复派发。导航中瞬时丢失上下文的结构读取有限重试一次，已丢弃的标签页明确报 `tab_discarded`。
- 下拉标签匹配统一空白与 Unicode 规范化；无法预检的自定义下拉在展开前返回 `custom_select_unsupported`。图标按钮和单控件包装可用 title 或邻近文字推断名称。
- 清理状态把工作区日志恢复异常与真正缺少创建记录分开报告（`workspace_unknown` / `no_journal`）。

## 1.8.4 — 2026-10-07（macOS 正式稳定版）

- 修复 Native host 断连退出时后台线程持有标准输入缓冲锁、触发 Python 强制中止的问题；半截帧、输出堵塞和断管均可取消，退出前等待转发线程结束。
- 重连时的旧浮层清理仅返回任务身份、代次、状态和标签证据，避免历史操作详情超过 1 MiB 单帧上限引发断连循环；完整历史与普通任务读取保留。
- 推断点击行的名称排除独立子控件，悬停工具按钮出现不再导致旧引用失效；业务标题变化继续拒绝旧引用，正文和表格链接文字保持完整。
- 语义实现更新为第 7 代，撤销旧实现中的引用并重建；新增真实管道、历史清理、悬停名称和多列表格回归，登记固定离线门禁。

## 1.8.3 — 2026-10-06（macOS 正式稳定版）

- 交互快照新增固定 `actions`，角色、禁用、只读、编辑、勾选和选择资格由解析库与执行器共用。
- 采用首个有效非抽象 ARIA 角色，未知角色回退到原生语义；补齐菜单复选/单选、ARIA 祖先禁用与原生三态核验。
- Python 填写 helper 排除同名但不可编辑的展示控件，官方紧凑快照展示固定可用动作，结果投影不接收任意动作值。
- 结构读取遇到前后文档变化时丢弃旧结果并最多重新读取一次；保护设置变化、写入、截图、脚本及绑定旧快照的读取不自动重试。
- 语义实现升级时撤销旧引用并重新创建实例；读取与写入的保护变化提示分别说明。
- 共享声明冷安装增加约 2.5KB，八次热调用实测约 2.6KB，保留原 6KB 热调用上限。

## 1.8.2 — 2026-10-06（macOS 正式稳定版）

- 顶层原生引用操作按宿主核实的真实节点范围检查内容保护，无关不可读 iframe 不再阻断填写、点击、复选框及原生下拉选择；包含或覆盖目标的框架继续拒绝。
- 范围在高亮等待/滚动后、操作后和结果交付时复查；嵌套框架沿用最外层宿主坐标，目标证明不进入公开结果，回放不重做写入。
- 工作窗口编号失效时查找并复用已有扩展首页；最后任务清理成功且仅剩首页时自动关闭空窗口，保留结果页与用户页。
- 新增解析扫描光带和真实语义元素边框，步骤变化、暂停及错误时清理，截图隐藏装饰，并支持减少动态效果。
- 执行日志保留未知结果的固定错误码，工具投影和网页最近步骤显示中文原因；控件后置核验失败不再误称未派发。
- 安装包、插件、扩展、Native 握手及云端 MCP 版本统一为 1.8.2，继续保留截图、任意脚本、复杂控件及显式子框架入口的严格保护。

## 1.8.1 — 2026-10-05

- 元素引用在原控件仍存在时忽略周边动态正文变化；重定位限制在快照指定区域，区域替换或虚拟记录身份变化继续拒绝旧引用。
- 语义快照和结构化表单统一识别空属性及 `plaintext-only` 编辑区，填写和回读使用相同判断。
- Hermes 成功完成任务默认立即关闭自己的工作页；显式完成宽限、人工接管及用户页面保护保留。
- 构建与打包统一检查插件、扩展、桌面元数据、锁文件及握手版本；云端 MCP 同样使用 1.8.1；本机同步覆盖已安装的命名 profile 副本。
- 云端工具明确要求回复用户前关闭并核实回执；闲置回收关闭自建工作页，断线和待人工处理仍保留页面。

## 1.8.0 — 2026-10-05（macOS 正式稳定版）

- 新增独立云端连接、十二位连接码、私有 Sites 插件配对及浏览器在线状态。
- 云端权限与本地权限分离；云端完全访问仅授权任务页，原个人标签页不授权。
- 支持多个云端会话和同任务多页面并发；同页顺序、关闭屏障、取消通道及合并通信。
- 完善断线、恢复、闲置和在途创建的回收；本机执行日志位置不变，云端通信正文领取或交付后清除。
- 收录当前本地语义解析、closed Shadow DOM、无障碍补充、截图与文本屏蔽及隐私投影修复。
- 修正正式自动更新仓库地址、清除开发依赖审计问题，并将云端回归加入固定门禁与 CI。
- 更新安装、云端配置、并发操作、数据保存和发布文档；保留真实浏览器与模拟验收的区别。

## 1.7.1 — 2026-10-05（macOS 开发预览）

- 插件 manifest、扩展管理页、安装包元数据和 GitHub 简介统一使用中文描述。
- 对齐插件、桌面 API、扩展握手和安装说明版本；功能与权限范围沿用 1.7.0。

## 1.7.0 — 2026-10-05（macOS 开发预览）

- 新增正式 Release 自动更新：可开启每小时检查，在 Chrome、Edge 和 Hermes 退出后安装；也支持仅检查、立即更新和关闭调度。
- 更新前校验 GitHub 附件 SHA256、ZIP 路径、完整文件清单、版本和扩展身份，复用既有升级备份及失败回滚。
- 手动升级、自动更新和卸载使用同一安装锁；后台更新不打开浏览器或改写剪贴板，卸载清理更新调度。已解压扩展更新后仍需重载。

- 新增自动内容屏蔽：开启开关后用内置中英文正则定位完整文本块，同步脱敏 Agent 的文本结果和截图，无需填写网站或选择器；保留真实验证码、登录和错误提示以及结构化站点限制。
- 屏蔽覆盖父汇总、名称、属性、脚本原样值、截图标注和回放；设置或页面状态无法确认时拒绝输出，未支持的原始 CDP、事件和网络读取通道明确拒绝。
- 任务鼠标固定启用，在执行及等待下一步时持续显示，目标间以 240ms 平滑移动；拖动不因重复绘制回跳，支持系统减少动态效果，截图完成后恢复。
- 浏览器弹窗只保留权限、任务控制和自动屏蔽，右上角显示当前扩展版本；Cookie 镜像集中在 Hermes 桌面插件页面。
- 修复桌面 Cookie 镜像弹窗的透明背景、左上角定位和窄窗口溢出；使用居中的不透明表面、独立遮罩和原生焦点/取消行为。
- 交互截图缓存只保留尺寸及身份状态，保护失败作废截图引用；敏感控件值不进入新增扫描器。
- 完整离线门禁包含 95 个步骤；临时 Chrome/Edge 验证自动遮罩真实 PNG、任务鼠标和弹窗，桌面镜像弹层另覆盖普通、窄、短窗口及深色主题。测试范围和个人环境边界见测试文档。

## 1.6.1 — 2026-10-04（开发预览）

- 修复语义引用重定位，保持在引用原属的 document 或 tree 内解析。
- 修复 composed 字段与选项传递，并补齐同源 iframe 和 Shadow DOM 的最小正确性回归。
- 修复 colspan 表格读取，保留跨列单元格对应的全部表头。
- 统一诊断 JSON Schema、JavaScript 与 Python 的错误码声明。
- 去重 CDP helper，不提高性能测试阈值。
- 修正离线测试的 socket 路径、默认 browser 和上游测试包遮蔽问题；这些属于测试环境与门禁回归。

## 1.6.0

- 修复后台标签页里点不动的问题：后台也优先使用真实浏览器输入，并核实事件送达。
- 工作页默认改到单独窗口；并发输入按窗口串行，切标签不抢用户焦点。可通过 `HERMES_BROWSER_WORK_WINDOW=current` 保持原窗口方式。
- 点击无效果时会如实报错 `click_no_effect`；观察到效果后返回 `effect: observed`，工具和 Python 脚本均保留该信息。
- 任务空闲回收默认改为 20 分钟，定期清理超过 24 小时且无工作页的 `needs_sync` 记录；打开页面时显示会话工作页数量，超过六页提示关闭不用的网站。


## 1.5.3 — 2026-10-03（开发预览）

- 网页浮层的接管、停止和退出接管在连续 8 秒没有回执或等待进度后显示断开提示，并提供「放开页面」和「重试」；快捷键使用同一流程。
- 「放开页面」移除本地浮层并恢复输入，不代表任务已经暂停；请在 Hermes 中核查任务状态。
- debugger 分离时卸载页面输入拦截；扩展重连后清理本实例已结束或待同步任务的残留浮层。新增 scripting 权限用于工作页浮层清理。
- 接管需要等待当前步骤结束时显示等待进度，确认完成后才显示已暂停并交出页面操作权。

## 1.5.2 — 2026-10-02（开发预览）

- 安装缩为 3 步：运行 `./install.sh`，手动加载浏览器扩展，在弹窗开启授权并重启 Hermes。Release 包不需要 Node.js；源码安装自动打包。
- 安装器检查 macOS、Python、Hermes 和浏览器；复制扩展路径到剪贴板，打开浏览器并最多等待 3 分钟检测连接。Ctrl+C 可跳过等待。
- `--upgrade` 自动备份程序和配置到插件目录之外，保留固定扩展 ID、来源白名单及任务私有数据；写入或校验失败自动回滚。
- `--uninstall` 默认保留任务私有数据，`--purge` 才删除；删除前说明内容并确认，`--verbose` 可查看目录。支持 `--dry-run` 和多个 `--profile`。
- 增加标签触发的 GitHub Release ZIP 工作流；本次源码改动不等于已经发布。加载扩展和浏览器授权仍须用户手动完成；授权与 Cookie 安全边界不变。
- 安装文案只保留命令、预期结果和失败处理；代理提示词中英各 7 行。Hermes 版本只提示已测试范围，缺少生命周期钩子时跳过注册并保留守护进程空闲清理。


## 1.5.1 — 2026-10-02（开发预览）

- Hermes 桌面端「浏览器连接」页新增 Cookie 镜像入口：读取和搜索站点、单站点或多站点选择、目标浏览器/配置选择。
- 对话框提供清除目标旧 Cookie 和会话 Cookie 持久保存选项，默认关闭；目标列表排除源浏览器。
- 显示等待扩展确认、复制中、完成计数、拒绝、过期和固定失败类别，并提示确认面板未弹出时的打开方法。
- 每次镜像仍必须在源浏览器扩展里批准，全部访问也不能跳过；桌面 API 和列表不返回 Cookie 值，继续使用一次性内存中转与 60 秒期限。
- 新增桌面交互和 API 离线回归及临时双浏览器验收脚本。此次桌面入口的真实浏览器验收待运行。

- 源浏览器在后台时仍创建确认面板并记录未确认聚焦；新增通用系统通知，点击只聚焦，真实批准与 Cookie 私有通路边界不变。权限管理窗口同样支持后台提醒。
- 扩展弹窗移除浏览器列表，主要链接只在桌面页设置；模拟鼠标和文字过滤直接展示。
- 弹窗 Cookie 镜像收成一行，仅保留桌面页深链和打开待确认请求；站点选择、复制与结果查看统一在桌面页操作。
- 接入 H + 链节图标和中英 README 图片；桌面导航保留内置 browser 图标，Dashboard 保留 Globe。

## 1.5.0 — 2026-10-02（开发预览）

- 扩展弹窗新增 Cookie 镜像：按站点选择并复制到已连接的浏览器 profile；可选清除目标旧 Cookie、将会话 Cookie 保存 1–365 天，默认均关闭。
- 新工具 `browser_shared_cookie_mirror` 可列站点计数、发起复制和查询状态。每次必须用户在源扩展确认，全部访问也不免确认；模型看不到 Cookie 值。
- Cookie 仅在本机内存中一次性中转，60 秒到期；逐条导入并汇总失败类别，回读报告匹配与缺失数量。中断可能部分导入，设备绑定或服务端检查仍可能要求重新登录。
- 新增 `cookies` 与全站点权限，保留扩展固定 ID；仅支持默认非隐身 store。

## 1.4.5 — 2026-10-02（开发预览）

- 加强发布包校验，覆盖扩展运行文件、版本一致性、超时后的任务恢复与脱敏诊断。
- 迁移工具支持 1.4.5 安装包，继续核对扩展固定身份。

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
