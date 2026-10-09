# Hermes Browser Link 1.9.1

macOS 版本，适用于已登录的 Chrome / Edge。日期：2026-10-10。

## 改动

- 新建标签页不再白等 8 秒：主框架仍是 about:blank 时只跳过本轮就绪探测，页面一可操作即返回（此前约 13%–28% 的新开页等满上限）。
- 工作页跳到第三方登录页（Google、Microsoft、Apple、Yahoo、Okta、Auth0）时，扩展弹系统通知请用户在该页亲自登录；模型收到 `user_action_required: "sign_in"`，提示等待用户而不是导航回原站。登录页仍不允许自动化操作。
- 页面遮罩的控制卡片移到右下角，避免被固定在右上角的 Google One Tap / FedCM 登录框盖住“接管页面”按钮。
- 解析类读取（semantic_snapshot、page.parse 等）遇到页面 JS 异常时返回 `page_script_error`，只带异常类型、不带网页文本；小写 `document changed` 归为可重读的 `document_changed`，不再落入笼统的 `execution_denied`。
- 步骤日志写入移出 daemon 全局锁，日志目录清理每分钟最多一次（上千个日志文件时每个动作约少阻塞 20ms）；连接口令改为常量时间比较。
- `npm run dev:sync` 一条命令完成本机部署：自动 `hermes pause`、等待任务收尾（默认 300 秒，超时列出未结束任务且不杀进程）、写维护标记让 daemon 与云端宿主平滑退出且不被扩展重新拉起、同步后删除标记并 `hermes resume`；扩展按构建 ID 自动重载一次。
- 新增 `npm run tasks:ack -- <taskId>`：备份后把已关闭、清理状态不确定的旧任务标为用户已核实；daemon 已停止时，已关闭且清理成功任务里残留的未知历史不再阻塞同步。
- 测试入口：仅当 TMPDIR 恰好是 macOS 系统默认目录时改用 /tmp 短目录，显式指定的 TMPDIR 原样使用；优先使用 Hermes venv 解释器。dev:sync 接受指向根程序的 profile 链接型 Desktop 标记。机械基准移除 1.7.0 起已不存在的光标开关。

## 安装

下载本版本的 `hermes-browser-link-1.9.1.zip`，不要下载 GitHub 自动生成的 Source code ZIP。解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后重载 Chrome / Edge 扩展，并重启使用该插件的 Hermes 会话。

## 验证范围

- 离线门禁：同一源码 `npm test` 退出 0（Node 873/873，Python 各套件 OK）；`npm run verify` 通过（`passed=True`，drift=0）；`npm run lint` 0 错误；`check:js`、`check:docs`、`check:manifest`、`check:version`、`build` 通过。
- 真实浏览器：隔离临时 profile 与临时安装下的机械基准，Chrome 与 Edge 各 22 项 × 3 轮全部成功、无错误码。Chrome p50：ref_click 376 ms、ref_fill 351 ms、自定义下拉 397 ms、慢页 4500 ms（1.4.2 基线分别为 790 / 591 / 623 / 6349 ms）。
- 第三方登录跳转的提示与通知、FedCM 登录框与控制卡片的位置关系仅有离线用例，未在真实 Google 账号登录流程中验收。新开页 8 秒问题的效果需在真实站点日志中复核。
- 支持范围为 macOS + Chrome / Edge；Windows、Linux 未完成安装验收。
