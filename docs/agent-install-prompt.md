# Agent installation prompt / 代理安装提示词

## English

> Check macOS, Chrome/Edge, `hermes --version` and Python 3.11+ (`python3 --version`). Download and extract the Release asset named `hermes-browser-link-<version>.zip` from https://github.com/fanjing188/hermes-browser-link/releases, not Source code (zip). The Release needs no Node.js, npm or Git. Only use source installation if requested; it needs Node.js 22.12+.
> Inspect `hermes profile list` and select my intended profiles explicitly with repeated `--profile <name>` flags. Without flags the first install enables only default, even in a named profile environment. Do not create profiles without asking.
> Enter the extracted directory and run `./install.sh --wait-seconds 0` (or `bash install.sh --wait-seconds 0` if not executable); do not use sudo. Use `--upgrade` for an existing installation. Do not edit config.yaml by hand or stop running apps for me.
> Report the enabled profiles and separate local program installation from browser connection. Stop and give me the printed Extension directory and Check command; wait while I load that directory at chrome://extensions or edge://extensions, confirm browser connection authorization (full access) myself in the extension, and restart Hermes Desktop with the intended profile (or start a new CLI session).
> Do not click browser security or connection authorization confirmations for me. Ordinary task actions run directly after I authorize the connection; independent protections remain.
> After I finish, run the exact printed Check command. It uses the installation's shared Hermes root and user home; do not replace them with the current profile's HERMES_HOME. This read-only check does not start or repair services.
> Report whether installation succeeded and the browser connected; if it failed, give the cause and next command or action.

## 中文

> 检查 macOS、Chrome/Edge、`hermes --version` 和 Python 3.11+（`python3 --version`）。从 https://github.com/fanjing188/hermes-browser-link/releases 下载并解压名为 `hermes-browser-link-<版本>.zip` 的附件，不选 Source code (zip)。Release 无需 Node.js、npm 或 Git；只有我要求时才用源码安装，源码需要 Node.js 22.12+。
> 用 `hermes profile list` 查看已有 profile，明确选择我要用的对象，重复加 `--profile <名>`。首次安装不加参数只启用 default，即使当前在命名 profile 环境里也一样。不要擅自创建 profile。
> 进入解压目录，运行 `./install.sh --wait-seconds 0`，无执行权限时用 `bash install.sh --wait-seconds 0`，不要用 sudo。已有安装用 `--upgrade`。不手工编辑 config.yaml，也不替我退出正在运行的应用。
> 报告启用的 profiles，分开说明程序安装和浏览器连接。停下来给我打印的“扩展目录”和“检查 / Check”命令，等我在 chrome://extensions 或 edge://extensions 加载该目录、亲自在扩展中确认浏览器连接授权（全部访问），用目标 profile 重启 Hermes 桌面端或新开 CLI 会话。
> 不替我点击浏览器的安全或权限确认。
> 浏览器连接授权由我亲自确认；确认后普通任务直接执行，独立保护不变。
> 等我完成后，运行打印的原样 Check 命令，使用安装时的共享根和用户目录，不换成当前 profile 的 HERMES_HOME。这个检查只读，不启动或修复服务。
> 报告安装是否成功、浏览器是否连接；失败时说明原因和下一条命令或操作。
