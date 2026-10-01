# Agent-assisted installation prompt

Copy one prompt into Hermes, Claude Code or Codex with local terminal/file access. It authorizes installation only on the user's macOS machine; extension loading and browser approval remain manual. These agents do not become Browser Link clients merely by installing it: the runtime tools are Hermes plugins.

## English

> Install Hermes Browser Link from https://github.com/FanJean/hermes-browser-link on this machine. First read README.md, docs/installation.md and SECURITY.md from the checked-out source. Inspect the OS, Node (22.12+), bridge Python (3.11+) and Hermes (0.21.4+) versions without installing or upgrading any of them. Stop if a prerequisite is missing, the OS is not macOS, the chosen directory has unrelated changes, an existing Browser Link installation would be overwritten, or you cannot verify the source. Explain what needs to be resolved; do not delete an existing installation or invent compatibility workarounds.
>
> Use a permanent checkout and a new package output directory. Run the repository's package-executor script. Verify the package's file manifest using the installer dry-run, and check that the package contains the extension, plugin, native bridge and installer. The manifest key is a public key fixing extension ID dhioigkigkkhceflkkkmoljhdaefjohb; do not remove or replace it. SHA256SUMS checks integrity, not publisher identity.
>
> STOP and ask me to load the unpacked native-extension directory manually in chrome://extensions or edge://extensions and confirm the displayed ID. Do not click browser security dialogs, enable developer mode, inspect my existing profile, copy cookies, or automate permission confirmation. Wait for my reply before continuing.
>
> Preview installation with the exact chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ origin. Confirm that plugin and native host paths target my intended Hermes home. Install using the same script with --apply, check status installed_disabled, and enable browser-link for the Hermes profile I will use. Verify it is enabled with the plugin list. If there is a tools.override capability prompt, stop for me to choose; do not grant optional tool overrides or enable Vault yourself.
>
> Ask me to restart Hermes / Hermes Desktop, open the extension popup and confirm Connected, then enable smart approval myself. STOP at extension/browser access prompts and wait for my confirmation; do not choose full access. In Desktop, verify the Browser connections panel shows the browser; CLI users use the popup. Run the read-only doctor and report host registration and connection results without printing tokens, .env values or personal paths.
>
> With my consent, ask Hermes to open https://example.com, read its title and first paragraph, then close the task without submitting anything. STOP for my first-site approval. Verify returned content and task-tab cleanup. If any result says outcome_unknown, do not replay the operation. Report each completed check and any unresolved step. Do not push, publish, alter unrelated settings or run dev:sync.

## 中文

> 请在本机安装 https://github.com/FanJean/hermes-browser-link。先读取检出的 README.zh-CN.md、docs/installation.md 和 SECURITY.md。只读检查系统、Node（22.12+）、桥接 Python（3.11+）和 Hermes（0.21.4+）版本，不自动安装或升级这些前置组件。系统不是 macOS、缺前置组件、目标目录有无关修改、安装会覆盖已有 Browser Link，或无法确认源码来源时，停止并说明需要解决什么；不要删除旧安装或加入兼容兜底。
>
> 使用长期保留的源码目录和新的输出目录，运行仓库 package-executor 脚本。用安装器 dry-run 校验文件清单，并核对扩展、插件、原生桥接和安装器齐全。manifest 的 key 是固定扩展 ID dhioigkigkkhceflkkkmoljhdaefjohb 的公钥，不要删除或替换。SHA256SUMS 只能证明文件完整性，不能证明发布者身份。
>
> 停下来让我在 chrome://extensions 或 edge://extensions 手动加载 native-extension 目录，并确认显示的扩展 ID。不要自动点击浏览器安全弹窗、开启开发者模式、读取我的现有 profile、复制 Cookie 或确认权限。等我回复后才能继续。
>
> 用精确的 chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ 来源预览安装，核对插件和原生宿主路径指向我准备使用的 Hermes 根目录。使用同一安装器加 --apply 安装，核对 installed_disabled，为实际使用的 Hermes profile 启用 browser-link，并用插件列表确认。遇到 tools.override 能力确认时停下来让我选择；不要自行开启官方工具接管或 Vault。
>
> 让我重启 Hermes / Hermes Desktop，打开扩展弹窗确认“已连接”，再由我开启“智能审批”。扩展或浏览器访问确认必须停下来等我操作，不选“全部访问”。桌面端核对“浏览器连接”面板中的在线浏览器；CLI 用户使用弹窗。运行只读 doctor，报告注册和连接结果，不打印令牌、.env 值或个人路径。
>
> 经我同意后，让 Hermes 打开 https://example.com，读取标题和第一段，然后关闭任务，不提交内容。首次网站批准仍须停下来等我确认。核对内容与工作页清理；遇到 outcome_unknown 不重放操作。最终逐项报告已验证步骤与未完成事项。不推送、不发布、不改无关设置、不运行 dev:sync。
