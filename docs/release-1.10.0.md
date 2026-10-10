# Hermes Browser Link 1.10.0

macOS 版本，适用于已登录的 Chrome / Edge。日期：2026-10-11。

## 改动

- 第三方登录弹窗不再打断连续执行：点击只打开弹窗或新标签、源页不变时，判为点击已生效（此前报 `click_no_effect`），结果返回 `popupOpened`（候选、来源、窗口类型、标签）和下一步提示。
- 默认模式下，Google、Apple、Microsoft（login.microsoftonline.com / login.live.com）、GitHub、Facebook、X 的授权页弹窗自动接管，不再单独确认；先开 about:blank 再跳到授权页的弹窗同样适用。每次自动接管写入操作时间线和审批日志。其他来源的弹窗及 full 模式仍需精确确认；密码、验证码、2FA 仍由用户亲自填写，不读写 Cookie。
- 同窗口新标签、普通新窗口纳入登录窗口候选；观察期 30→120 秒，候选有效期 2→10 分钟。观察前已存在的标签、其他任务的标签不会被认领。
- 登录页自行关闭后，任务自动回到源标签，结果带 `popupClosed.returnedTo`，随后读取得到登录后的新文档；旧 ref 仍须重读后使用。
- 审批面板可以在已接管的登录小窗内弹出（此前只认普通窗口，小窗里的确认无法显示）。
- 页面遮罩“最近步骤”改为中文句式和本地时间，错误码移到悬停提示；等待文案延迟 400ms 切换、同值跳过、行复用，减少闪烁。
- `npm run tasks:ack`：daemon 刚停止时短暂等待桥接锁释放，不再立即报“桥接仍在运行”。

## 安装

下载本版本的 `hermes-browser-link-1.10.0.zip`，不要下载 GitHub 自动生成的 Source code ZIP。解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后重载 Chrome / Edge 扩展，并重启使用该插件的 Hermes 会话。

## 验证范围

- 离线门禁：`npm test` 退出 0；`npm run lint` 0 错误；`check:js`、`check:docs`、`check:version`、`build` 通过。
- 真实浏览器（临时 profile、完整 background/daemon 链路、本地模拟身份提供方）：`tests/complex-ui/real-login-windows.mjs` Chrome 19/19、Edge 19/19，覆盖只开窗点击、白名单自动接管与审计、非白名单仍需确认、关闭回源读取新文档、full 模式不自动接管。`real-overlay`、`real-takeover`、`real-tabs-interaction` 通过。
- 已知未覆盖：未在真实 Google / Apple / Microsoft 账号登录流程中验收（测试未访问外部登录站）。`tests/native-v2/real-native-v2.mjs` 的下拉选项用例（`select_option_missing`）在 1.9.1 上同样失败，属既有问题，本版未改。
- 支持范围为 macOS + Chrome / Edge；Windows、Linux 未完成安装验收。
