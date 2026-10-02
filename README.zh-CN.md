# Hermes Browser Link

![Hermes Browser Link](docs/assets/readme-banner.png)

[English](README.md)

让 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 在你已登录的 Chrome / Edge 中读取网页并操作任务工作页。

支持读正文和表格、点击、填写表单、上传文件、跟踪下载和 Python 多步操作。在扩展弹窗开启“智能审批”；网站首次读取及后续写入会出现确认提示。详见 [安全说明](SECURITY.md)。

## 前置条件

| 组件 | 要求 |
|---|---|
| Hermes Agent | 已测试：**0.21.4** |
| Node.js | **22.12.0+**，仅源码安装和开发需要 |
| Python | **3.11+** |
| 平台 | 目前支持 **macOS + Chrome/Edge**；浏览器已测试 153 |

## 快速安装（3 步）

1. 下载 [Release 安装包](https://github.com/FanJean/hermes-browser-link/releases) 并安装（无需 Node.js）；出现“程序安装并启用完成”即成功：

   ```sh
   curl -fL https://github.com/FanJean/hermes-browser-link/releases/download/v1.5.3/hermes-browser-link-1.5.3.zip -o hermes-browser-link-1.5.3.zip && unzip hermes-browser-link-1.5.3.zip && cd hermes-browser-link-1.5.3 && ./install.sh
   ```

2. 在浏览器打开 `chrome://extensions` 或 `edge://extensions` → 开发者模式 → 加载已解压的扩展程序 → 粘贴脚本打印并复制的绝对路径；脚本最多等待 3 分钟，检测成功显示 ✅，可用 Ctrl+C 跳过等待。
3. 在扩展弹窗开启“智能审批”，重启 Hermes 桌面端；弹窗显示“已连接”、桌面“浏览器连接”页显示在线浏览器即完成。

升级：在新包目录运行 `./install.sh --upgrade`（自动备份，失败回滚），再重载扩展和重启桌面端。卸载：`./install.sh --uninstall`（默认保留任务私有数据；加 `--purge` 才删除）。

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

真实浏览器验收使用临时 profile，按需手动执行，见 [测试](docs/testing.md)；机械和代理基准见 [基准说明](docs/bench.md)。开发约定见 [开发文档](docs/development.md) 和 [贡献指南](CONTRIBUTING.md)。漏洞通过 [GitHub Security Advisories](https://github.com/FanJean/hermes-browser-link/security/advisories/new) 私下报告，不发公开 issue。

## 许可证与致谢

[MIT](LICENSE)。本项目最初基于 Jon Komet 的 [Hermes 浏览器扩展](https://github.com/abundantbeing/hermes-browser-extension)，感谢原始工作；许可证保留两行版权。
