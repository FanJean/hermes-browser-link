# Hermes Browser Link

![Hermes Browser Link](docs/assets/readme-banner.png)

[English](README.md)

让 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 在你已登录的 Chrome / Edge 中读取网页并操作任务工作页。

支持读正文和表格、点击、填写普通表单、上传用户指定文件、跟踪下载和 Python 多步操作。插件通过本地 Native Messaging 宿主连接扩展，不复制浏览器 profile，也不使用云浏览器服务。读取结果会进入代理上下文，可能发给其模型提供商。

**权限边界：**默认“智能审批”在每个任务首次读取每个网站时确认一次；写入、网页 JavaScript 和调试另行批准。“全部访问”跳过这些逐项确认，仍保留任务范围。授权由扩展确认，桌面端开关打开该确认页。你可以接管或停止任务。普通 helper 将敏感输入交给你；截图遮罩可见敏感字段及无法检查的框架；网络证据剥离 Cookie 值和其他凭据请求头。任意 JS/CDP 返回值不保证完整脱敏，Python 以你的用户权限运行，没有操作系统沙箱。详见 [安全说明](SECURITY.md)。

不能绕过登录、人机验证、网站限制或浏览器权限弹窗。个人原有标签不属于任务租约；新工作页属于任务。任务隔离不等于账号隔离。

扩展弹窗直接显示浏览器权限、模拟鼠标和文字过滤。Cookie 镜像收成一行入口，提供「在桌面页打开」和「打开待确认请求」。设为主要链接仅在 Hermes 桌面端「浏览器连接」页操作；已连接配置仍可作为镜像目标。后台浏览器无法确认聚焦时，确认窗口仍保留，并通过新增 `notifications` 权限发送通用系统提醒。点击通知只聚焦窗口，批准仍必须在扩展面板真实点击。通知不含网站、任务或 Cookie 值；系统关闭通知时仍可看角标；Cookie 镜像可点「打开待确认请求」重开确认面板。参见 [Chrome 通知 API](https://developer.chrome.com/docs/extensions/reference/api/notifications) 和[安全说明](SECURITY.md#background-confirmation-notifications-151)。

## 前置条件

| 组件 | 要求 |
|---|---|
| Hermes Agent | **0.21.4+**；v2026.9.21 源码已有 `on_session_end`、`agent_loop_stopped`。固定集成版本见 [测试说明](docs/testing.md)。 |
| Node.js | **22.12.0+**，用于打包和开发 |
| Python | 本桥接需 **3.11+**；Hermes 需使用其自身要求的版本，固定集成环境用 3.14 |
| 浏览器 | 桌面 Chrome / Edge；已测试 **153**，未认证更低版本 |
| 系统 | **macOS 开发预览**。Linux 未测试且安装器拒绝执行；Windows 不受当前安装器和 Unix socket 传输支持。 |

## 从源码安装

选一个长期保留的目录，加载扩展后不要删除安装包。以下命令逐条执行；安装器不启用插件、不重启应用。

1. 获取仓库：

   ```sh
   git clone https://github.com/FanJean/hermes-browser-link.git
   ```

2. 进入仓库：

   ```sh
   cd hermes-browser-link
   ```

3. 核对版本：

   ```sh
   node --version
   ```

   ```sh
   python3 --version
   ```

   ```sh
   hermes --version
   ```

4. 打包（输出目录不能已存在）：

   ```sh
   node scripts/package-executor.mjs --output ./out/browser-link
   ```

   确认有 `SHA256SUMS.json`、`install-executor.py` 和 `native-extension/manifest.json`。

5. **用户手动操作：**打开 `chrome://extensions` / `edge://extensions`，启用开发者模式，加载 `out/browser-link/native-extension/`。核对扩展 ID 为 `dhioigkigkkhceflkkkmoljhdaefjohb`。manifest 的 `key` 是固定 ID 用的**公钥**，不是密钥。

6. 预览插件和原生宿主注册：

   ```sh
   python3 scripts/install-executor.py --package ./out/browser-link --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/
   ```

   确认 `status: plan`、Hermes 根目录和 Chrome / Edge 的宿主路径正确。已有安装会被拒绝覆盖。

7. 执行已核对的计划：

   ```sh
   python3 scripts/install-executor.py --package ./out/browser-link --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ --apply
   ```

   确认 `status: installed_disabled`；这一步安装插件并注册两个浏览器的原生宿主。

8. 为实际使用的 Hermes profile 启用插件：

   ```sh
   hermes plugins enable browser-link
   ```

   ```sh
   hermes plugins list
   ```

   确认插件已启用，重启 Hermes / Hermes Desktop。接管官方浏览器工具还需单独授予 `tools.override`。

9. **用户确认权限：**打开扩展弹窗，确认“已连接”，开启访问并选“智能审批”。桌面端打开“浏览器连接”，其访问开关会打开扩展确认页；CLI 用户直接使用扩展弹窗。

10. 只读检查注册与连接：

    ```sh
    python3 native-bridge/doctor.py
    ```

    确认宿主注册和在线浏览器。完整安装、升级、卸载见 [安装文档](docs/installation.md)；辅助安装可复制 [代理安装提示词](docs/agent-install-prompt.md)。

## 首次使用

对 Hermes 说：

> 在我的浏览器打开 https://example.com，读取页面标题和第一段，然后关闭任务。不要提交任何内容。

在扩展中批准首次网站读取。Hermes 应返回文本并关闭工作页。入口是 `browser_shared_open`，单步用 `browser_shared_run`，多步用 `browser_shared_script`。详见 [用法](docs/usage.md) 和 [接口参考](docs/browser-api-reference.md)。

## Cookie 镜像

在 Hermes 桌面端「浏览器连接」页展开源浏览器的「Cookie 镜像」，读取并搜索站点后选择目标浏览器或配置。弹窗「在桌面页打开」通过 `hermes://open/browser-link` 打开该页；「打开待确认请求」用于重新打开已有的源扩展确认面板。

在桌面页按站点选择 Cookie，复制到另一个已连接的 Chrome/Edge profile。每次都必须在**源扩展确认面板**重新确认，全部访问也不例外。新增 `cookies` 与 `<all_urls>` 权限用于清单和导入；值经本地一次性内存通道中转，60 秒到期，不进入模型结果、日志或任务文件。Hermes 只看到站点、状态、计数和固定失败类别。

仅支持默认、非隐身 Cookie store。站点分组使用小型后缀表，确认前需核对站点清单。回读只验证 Cookie 身份集合；设备绑定、localStorage 和服务端检查仍可能要求登录。中断可能留下目标端的部分修改。详见 [用法](docs/usage.md#cookie-mirror) 和 [安全边界](SECURITY.md#cookie-mirror-150)。

## 配置与排障

全部环境变量见 [配置表](docs/configuration.md)，包括默认浏览器、导出目录、暂停和清理时限、共享根目录及测试设置。变量需在对应进程启动前设置；默认浏览器和导出目录也可读取共享桥接根目录的 `.env`，不要提交该文件。

升级前完成任务并禁用插件；安装器不支持原地覆盖，按 [安装文档](docs/installation.md) 备份和替换。卸载运行数据会删除任务私有文件。

| 结果 | 处理 |
|---|---|
| 浏览器未连接 / `no_browser` | 打开浏览器，检查扩展与宿主注册 |
| `execution_denied` | 查看结构化原因和 `outcome_unknown`，不猜测、不盲目重试 |
| `origin_denied` / `tab_out_of_scope` | 使用已授权该来源的任务及返回的标签，不自行扩权 |
| `approval_required` / `user_input_required` | 用户在扩展中确认或填写敏感字段 |
| `outcome_unknown` | 先读回页面，绝不自动重放写操作 |

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
