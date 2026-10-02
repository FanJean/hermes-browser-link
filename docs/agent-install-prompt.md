# Agent installation prompt / 代理安装提示词

## English

> Download and extract the Release ZIP from https://github.com/FanJean/hermes-browser-link/releases, or clone https://github.com/FanJean/hermes-browser-link and enter its directory.
> Run `./install.sh --wait-seconds 0`; for specified Hermes profiles, add repeated `--profile <name>` flags. Use `--upgrade` when upgrading.
> Stop and give me the printed extension path; wait while I load it at chrome://extensions or edge://extensions, enable smart approval in the popup and restart Hermes Desktop.
> Do not click browser security or permission confirmations for me.
> Do not select Full access.
> After I finish, run `python3 "${HERMES_HOME:-$HOME/.hermes}/plugins/browser-link/native_bridge/doctor.py"`.
> Report whether installation succeeded and the browser connected; if it failed, give the cause and next command or action.

## 中文

> 从 https://github.com/FanJean/hermes-browser-link/releases 下载并解压 Release ZIP，或克隆 https://github.com/FanJean/hermes-browser-link 并进入目录。
> 运行 `./install.sh --wait-seconds 0`；指定多个 Hermes profile 时重复加 `--profile <名>`，升级时加 `--upgrade`。
> 停下来给我打印的扩展路径，等我在 chrome://extensions 或 edge://extensions 加载扩展、在弹窗开启“智能审批”并重启 Hermes 桌面端。
> 不替我点击浏览器的安全或权限确认。
> 不选择“全部访问”。
> 等我完成后，运行 `python3 "${HERMES_HOME:-$HOME/.hermes}/plugins/browser-link/native_bridge/doctor.py"`。
> 报告安装是否成功、浏览器是否连接；失败时说明原因和下一条命令或操作。
