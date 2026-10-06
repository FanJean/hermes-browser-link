# Hermes Browser Link

**1.8.3 — macOS 正式稳定版。** 支持受授权网页任务、自动文本与截图屏蔽、持续任务鼠标、桌面 Cookie 镜像、独立云端浏览器调用和正式版自动更新。

![Hermes Browser Link](docs/assets/readme-banner.png)

[English](README.md)

让 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 在你已登录的 Chrome / Edge 中读取网页并操作任务工作页。

支持读正文和表格、点击、填写表单、上传文件、跟踪下载和 Python 多步操作。默认使用智能审批，网站首次读取及后续写入会出现确认提示；全部访问需要另行明确开启。详见 [安全说明](SECURITY.md)。

## 功能列表

| 功能 | 行为 |
|---|---|
| 现有浏览器 | 复用已登录的 Chrome/Edge；任务页放在独立工作窗口，输入切标签不抢用户窗口焦点。 |
| 页面读取与操作 | 提取正文、表格、表单和记录；支持语义引用、点击、输入、选择、滚动及文件上传下载。 |
| Python 工作流 | 多步脚本和经过验证的可复用网站工具，沿用同一任务授权链路。 |
| 自动内容屏蔽 | 开关开启后，内置中英文正则自动识别公告和网页指令，屏蔽 Agent 文本及对应截图区域，无需填写网站或选择器。 |
| 持续任务鼠标 | 固定启用，任务执行与等待下一步时持续显示，目标间平滑移动，支持接管和系统减少动态效果。 |
| 桌面 Cookie 镜像 | 在 Hermes 插件页选择站点和目标浏览器，每次复制都需在源扩展确认。 |
| 云端调用 | 本机弹窗生成连接码，与自己的 Sites 插件配对；独立权限、多个对话任务、多页面并发及清理确认。见 [云端连接](docs/cloud-connection.md)。 |
| 安装与更新 | 完整性校验、升级备份与失败回滚、手动升级、每小时检查正式版及空闲安装。 |

内容屏蔽只处理 Browser Link 发给 Agent 的输出，用户看到的网页保持原样；真实验证和错误信号保留。未支持的原始通道或不可检查页面结构会拒绝输出。详见 [屏蔽边界](docs/content-shield.md)、[完整功能](docs/features.md) 和 [模块索引](docs/product-modules.zh-CN.md)。

## 前置条件

| 组件 | 要求 |
|---|---|
| Hermes Agent | 已测试：**0.21.4** |
| Node.js | **22.12.0+**，仅源码安装和开发需要 |
| Python | **3.11+** |
| 平台 | 目前支持 **macOS + Chrome/Edge**；浏览器已测试 153 |

## 快速安装（3 步）

1. 下载 [Release 安装包](https://github.com/fanjing188/hermes-browser-link/releases) 并安装（无需 Node.js）；出现“程序安装并启用完成”即成功：

   ```sh
   curl -fL https://github.com/fanjing188/hermes-browser-link/releases/download/v1.8.3/hermes-browser-link-1.8.3.zip -o hermes-browser-link-1.8.3.zip && unzip hermes-browser-link-1.8.3.zip && cd hermes-browser-link-1.8.3 && ./install.sh
   ```

2. 在浏览器打开 `chrome://extensions` 或 `edge://extensions` → 开发者模式 → 加载已解压的扩展程序 → 粘贴脚本打印并复制的绝对路径；脚本最多等待 3 分钟，检测成功显示 ✅，可用 Ctrl+C 跳过等待。
3. 首次使用保留默认的智能审批模式，重启 Hermes 桌面端；弹窗显示“已连接”、桌面“浏览器连接”页显示在线浏览器即完成。

升级：在新包目录运行 `./install.sh --upgrade`（自动备份，失败回滚），再重载扩展和重启桌面端。卸载：`./install.sh --uninstall`（默认保留任务私有数据；加 `--purge` 才删除）。

1.8.3 为正式稳定版，可进入自动更新通道。旧安装先手动升级一次，安装当前仓库的更新源。安装本次更新组件后运行 `./install.sh --auto-update install`，每小时检查正式 Release，在浏览器和 Hermes 退出后安装。更新后重载扩展再启动 Hermes。仅检查用 `--auto-update check`，关闭用 `--auto-update off`；立即更新用 `--update`。详见 [自动更新](docs/installation.md#automatic-updates--自动更新)。

[源码、手动安装、多 profile 与故障排查](docs/installation.md) · [代理安装提示词](docs/agent-install-prompt.md)。

浮层卡住：点「放开页面」或刷新页面。

## 首次使用

对 Hermes 说：

> 在我的浏览器打开 https://example.com，读取页面标题和第一段，然后关闭任务。不要提交任何内容。

在扩展中批准首次网站读取。Hermes 应返回文本并关闭工作页。入口是 `browser_shared_open`，单步用 `browser_shared_run`，多步用 `browser_shared_script`。详见 [用法](docs/usage.md) 和 [接口参考](docs/browser-api-reference.md)。

## Cookie 镜像

在 Hermes 桌面端“浏览器连接”页展开源浏览器的“Cookie 镜像”，选择站点和目标浏览器，在源扩展弹出的面板确认。复制后若仍未登录，在目标浏览器重新登录。详见 [用法](docs/usage.md#cookie-mirror) 和 [安全说明](SECURITY.md#cookie-mirror-150)。

## 配置与排障

未连接时，加载或重载扩展，在弹窗点“连接 Hermes”，再按 [安装文档](docs/installation.md#check-connection--检查连接) 运行检查命令。操作失败时，先查看页面当前状态，再按提示处理。配置选项见 [配置表](docs/configuration.md)。

## 开发、贡献与安全报告

安装开发依赖：

```sh
npm ci --ignore-scripts
```

运行离线测试和文档检查：

```sh
npm test
```

```sh
npm run check:docs
```

```sh
python3 scripts/generate-browser-reference.py --check
```

```sh
bash scripts/check-public-release.sh
```

真实浏览器验收使用临时 profile，按需手动执行，见 [测试](docs/testing.md)；机械和代理基准见 [基准说明](docs/bench.md)。开发约定见 [开发文档](docs/development.md) 和 [贡献指南](CONTRIBUTING.md)。漏洞通过 [GitHub Security Advisories](https://github.com/fanjing188/hermes-browser-link/security/advisories/new) 私下报告，不发公开 issue。

## 许可证与致谢

[MIT](LICENSE)。本项目最初基于 Jon Komet 的 [Hermes 浏览器扩展](https://github.com/abundantbeing/hermes-browser-extension)，感谢原始工作；许可证保留两行版权。
