# 页面内容屏蔽

本功能只保护 Browser Link 扩展处理后发给 Agent 的输出。不会更改网页 DOM、页面布局、焦点或浏览器可见内容。截图 selector/ref 入口仍沿用原有滚动行为。其他桌面截图工具不受此设置控制。

## 自动屏蔽

打开扩展弹窗，开启“自动屏蔽网页干扰”即可使用。无需填写网站 origin、CSS 选择器或自行编写正则。原有开关默认值和保存的偏好不变。

扩展按 CSS 文本块边界归并内联文字，用内置中英文正则匹配禁止自动化公告、要求 Agent 停止或忽略指令的文字，以及 title、alt、ARIA 等名称字段。命中后自动定位完整文本块，屏蔽该块及其子孙的文字、名称和截图像素。文本输出和截图使用同一批识别结果，每次操作重新扫描，新增或变化的公告也参与匹配。

例如 `<div><span>请勿使用自动化工具访问本平台</span><a>查看公告</a></div>` 会自动屏蔽整个公告块。普通导航和相邻业务块保留；不同段落不能拼接成一条公告。HTML/body/main 等页面骨架、含其他独立块的容器只遮本段文字和内联元素，不遮整个页面。脚本、样式和模板字符串不参与可见文本块定位。敏感输入的 value、value 属性、textarea 正文和 select 子项仍不读取。

内置正则保存在 `native-extension/content-filter.mjs` 的 `DIRECTIVES` 与 `SITE_AUTOMATION_RESTRICTIONS`；实际验证码、登录、拒绝访问和限流提示仍优先保留。

## 设置与权限

浏览器弹窗只显示自动屏蔽开关，不再展示网站/选择器配置。已保存的额外规则仍沿用原有校验和输出保护；开关未设置时的默认值及已有偏好不变。

规则保存在本扩展的 `chrome.storage.local`，后台规则读写仍只接受受信的 `popup.html` 发起者。不提供 Agent 工具写入、开关关闭或规则查询接口。规则和原文不会进入 Agent 审计信息、错误候选或诊断日志。

## 输出行为

| 入口 | 过滤开启时 |
| --- | --- |
| snapshot、semantic_snapshot、page.observe、page.parse | 脱敏指定区域文本、名称、属性，以及父汇总、字段和 metadata 中相同内容；受影响的引用不返回 |
| js.evaluate | 对原样返回的字符串/对象值及异常文字做脱敏；保留执行状态和协议身份 |
| screenshot，含 selector/ref/annotation | 复用敏感字段截图检查和不透明实色遮罩；重叠标注省略，保留 masked 审计 |
| interaction.capture | 与普通截图同样检查、遮罩和拒绝不可靠图片 |
| 官方 browser_vision 适配 | 已有适配转到上述 screenshot/interaction.capture，使用相同保护 |
| interaction.bounds 与其他正常动作返回 | 统一在执行器出口清理读到的区域内容 |
| tabs | 移除未探测的网页标题，保留标签页和授权信息 |
| cdp.send、cdp.events、network.inspect、images、console、dialog | 明确拒绝；这些入口的完整输出尚未实现可靠脱敏 |
| browser.cdp 及其 targets/version/activate/close/subscribe/chunk 网关 | 明确拒绝原始通道；已有事件订阅停止推送，设置读失败也不推送 |
| browser.status | 移除网页标题汇总，当前设置也保护旧缓存；保留页面标识和控制状态 |
| 来源、凭据、批准与任务生命周期 | 保留原有身份、授权与固定状态字段；不提供网页正文读取的新通道 |

默认中英文匹配仍有效，无须配置 selector。禁止自动化公告被隐藏后，返回 `contentFilter.siteAutomationRestricted: true`，不会表示网站允许自动化。验证码、人机验证、登录、401/403/429、拒绝访问和限流信息优先保留，不会改写失败为成功。指定区域与真实阻塞重叠时拒绝图片；文本保留明确独立的标准阻塞句段，其他指定句段仍屏蔽。疑似阻塞文字混有未能确认的内容（包括 title/alt/ARIA 属性）时也拒绝文本输出，不能把整个属性当作例外。URL、id/class 和输入值中的 login/403 等字样按数据处理，仍需全部脱敏。

## 拒绝与边界

- 每次操作和发送/回放都读取当前设置。设置读失败、规则无效、设置在执行中变化，均不返回未经确认的页面内容。
- 文档、URL、视口、滚动、DPR、文本、遮罩位置在截图检查中变化时拒绝图片。不会回退原图。旧结果的设置或页面检查不一致时返回 `content_shield_stale`，须用新请求读取；不会为重放重新执行脚本或动作。
- 同源 iframe、开放及通过 CDP 确认的封闭 Shadow DOM 参与遍历，包括同源 iframe 内的封闭组件。封闭组件超过 200 个、节点解析失败、视觉缩放/偏移、未知几何和扫描上限失败会拒绝相关输出。iframe 内命中规则时遮住最外层宿主框架，以免局部坐标错误。
- snapshot、semantic_snapshot、page.observe、page.parse、official.ready_state 和 frame_catalog 可跳过不可读取 iframe，继续返回可访问 DOM；结果带 `contentFilter.unreadFrames`，已有 `coverage.complete` 置为 false，page.parse 还返回 `status:partial` 与 `unread_frames` 警告。不会返回被跳过框架的内部正文，也不会因此获得框架动作权限。截图、任意脚本、复杂控件和显式子框架操作仍保留不可检查框架的拒绝边界。
- 顶层原生引用操作（ref_click、ref_fill、ref_press、ref_set_checked、ref_select_option）可使用宿主核实的真实节点范围。无关不可读 iframe 不再阻断该目标；包含或覆盖目标的框架仍拒绝，嵌套框架按最外层宿主坐标核验。范围检查覆盖派发前的高亮等待/滚动、操作后和结果交付，字段脱敏仍扫描所有可访问内容。目标证明只保存在扩展内部，模型传入的节点编号不能授权。此范围适用于原生链接、按钮、输入框、文本域、复选框及 select；ARIA 复合控件、选择器/坐标动作沿用严格检查。
- 对固定格式的页面读取、控件操作和截图，若 iframe 本身或其真实祖先链明确为 `display:none`，可跳过该框架；不读取其正文，也不把它算作当前可见页面的覆盖缺口。截图前后会复查隐藏状态；框架变为可见或状态无法确认时拒绝输出。零尺寸、透明、`visibility:hidden` 或 `about:blank` 地址都不能替代这一检查；空 sandbox 框架也不能按地址推断为同源。任意脚本输出与显式 frameToken 读取仍拒绝不可检查框架。
- semantic_snapshot 与 page.parse 显式指定 root 时，只统计该根内的不可读框架；根外的第三方框架不影响局部完整性。显式 frameToken 读取会返回目标框架正文，不能沿用顶层部分读取的跳过规则；该框架保护未确认时继续拒绝。
- 固定语义角色与覆盖率字段保留协议含义，避免短屏蔽词损坏 listbox 等角色。任意脚本返回的同名字段仍作为页面值过滤。
- 截图中命中区域含文字阴影、滤镜或 CSS 生成内容时拒绝图片。Canvas 命中明确 selector 时整块遮罩；未指定 Canvas/视频/图片中的文字没有 OCR 匹配保证。正文规则依赖可读取的 DOM 文本，不能声称识别所有视觉文字。
- 对相同文本的其他出现位置可能一并脱敏。长文本截断命中时会清理整个字段。
- JS 任意重编码、逐字切分、自建图像、浏览器站外传输无法保证；隔离执行世界不是防泄漏沙箱。本功能不会新增访问授权、绕过反爬或改变网络传输。
- 原始图片不进入 Agent 响应或公开 CDP/chunk 路径。交互库只缓存截图尺寸和坐标身份所需状态，保护失败后撤销截图身份；捕获和遮罩处理期间仍会产生原始字节。
- 关闭过滤后恢复原有页面输出。已有脱敏缓存不会恢复成原文，应以新请求读取。

## 测试与安装交接

`node --test tests/popup-integration/*.test.mjs` 覆盖真实 Executor→Bridge 与受信后台消息路由，使用合成 DOM/CDP/Canvas。像素测试验证生产遮罩绘制指令和不透明 RGBA；合成图像后端不等于 Chromium PNG 验收。

`npm run build` 后可手动运行 `node tests/popup-integration/real-content-shield.mjs --output=/绝对路径/独立证据目录`。该脚本只使用 Chrome、Edge 的独立临时 profile 和本地测试页，仅打开开关，确认未保存任何网站/选择器规则；同时核对精简弹窗、manifest 版本、持续任务鼠标及实际移动中间位置、接管恢复和减少动态效果。覆盖默认正则自动定位、生产 Executor→Bridge、实际 PNG 全区域不透明像素、DPR=2、正常内容与阻塞提示、过滤关闭、祖先滤镜拒绝，以及 DOM、布局和焦点不变。它不连接个人安装的 native daemon，不能代替个人环境全链验收。

个人安装与实际 Chrome/Edge 验收由 Hermes 完成。此次扩展之外还修改 Python 插件的封闭结果投影、公共保护错误分类和官方适配元数据转发，以保留站点约束/遮罩审计并移除隐藏标注引用；daemon、版本和默认偏好不变。替换候选后须 reload 扩展并重启或重新加载 Hermes 插件运行时；不新增 daemon 代码或专门的 daemon 重启要求。若采用整个安装包升级，仍遵循安装流程本身既有的重启要求。

实际浏览器验收需分别检查：默认中英文公告、指定 selector 和子孙/ARIA/alt、父级汇总和 JS 原样值、普通/selector/ref/annotation/交互及官方截图、不透明遮罩、真实阻塞保留、滚动/缩放/导航/动态修改、同源 iframe/open Shadow、未知框架拒绝、旧请求回放、过滤关闭和未授权规则写入拒绝。必须解码实际 PNG/JPEG 对照像素，并确认 DOM、布局、焦点和用户看到的页面没有被内容屏蔽功能修改。
