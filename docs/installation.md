# Installation / 安装

目前支持 macOS + Chrome/Edge。需要先安装 [Hermes](https://hermes-agent.nousresearch.com/docs/) 和 Python 3.11+；已测试 Hermes 0.21.4、浏览器 153。**Release 安装无需 Node.js、npm 或 Git**；仅源码安装需要 Node.js 22.12+。

Currently supported: macOS + Chrome/Edge. Install [Hermes](https://hermes-agent.nousresearch.com/docs/) and Python 3.11+ first; tested with Hermes 0.21.4 and browser 153. **Release installation needs no Node.js, npm or Git**; only source installation needs Node.js 22.12+.

先确认以下命令可运行，且 `python3` 显示 3.11 或更高。macOS 自带的 Python 可能太旧；安装新版后仍要确认 PATH 中的 `python3` 指向新版。

Check these commands first; `python3` must report 3.11 or later. macOS may ship an older Python; after installing a newer one, ensure `python3` on PATH selects it.

```sh
hermes --version
python3 --version
```

## Install / 安装

从 [Release](https://github.com/fanjing188/hermes-browser-link/releases) 的 Assets 下载 `hermes-browser-link-<版本>.zip`，不要选 **Source code (zip)**。完整解压、在终端进入包含 `install.sh` 的目录后运行：
Download the asset named `hermes-browser-link-<version>.zip`, not **Source code (zip)**. Extract the complete archive and enter the directory containing `install.sh` in your terminal:

```sh
./install.sh
```

源码安装 / From source:

```sh
git clone https://github.com/fanjing188/hermes-browser-link.git
cd hermes-browser-link
./install.sh
```

若提示 Permission denied，在同一目录用 `bash install.sh`；不要用 `sudo`。这是用户级安装：校验包、安装程序和浏览器原生宿主、启用选定 profile；不会替你点击浏览器安全确认。

If the terminal reports Permission denied, use `bash install.sh` in the same directory; do not use `sudo`. This is a per-user install: it verifies the package, installs the program/native host and enables selected profiles, without clicking browser security confirmations for you.

安装分两段：**“程序安装并启用完成”只代表程序装好**，同一行显示启用的 profiles；**“扩展已连接”才代表浏览器连接确认**。终端等待时，在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，粘贴打印的“扩展目录”，不是下载包目录。剪贴板可用时会复制路径；否则手动复制。这个稳定目录应保留，不要搬走或删除。

There are two stages: **Program installed and enabled** confirms only the local installation and lists enabled profiles; **Extension connected** confirms the browser connection. While the terminal waits, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked** and paste the printed **Extension directory**, not the downloaded package directory. Clipboard copying is best-effort; copy manually if needed. Keep this stable extension directory in place.

等待最多 3 分钟，Ctrl+C 只跳过连接等待。超时或 `--wait-seconds 0` 不会撤销安装；看到“浏览器连接尚未确认”时，完成加载后运行输出的 **检查 / Check** 命令，不要重复首次安装。

The connection wait is at most 3 minutes. Ctrl+C skips only this wait. A timeout or `--wait-seconds 0` does not undo installation. If **Browser connection not yet verified** appears, load the extension and run the printed **Check** command; do not repeat the first install.

打开扩展弹窗，未连接时点“连接 Hermes”，在浏览器中确认连接授权（全部访问）；重启使用目标 profile 的 Hermes 桌面端，或新开 CLI 会话。弹窗显示“已连接”、桌面用户确认“浏览器连接”页显示在线浏览器即完成。连接授权后普通任务直接执行，不再逐页或逐项确认；任务就绪、来源范围、接管、停止和凭据保护仍须核实。离线或状态未知不代表已授权。

Open the popup, click **Connect Hermes** if disconnected, and confirm browser connection authorization (full access). Restart Hermes Desktop with the target profile, or start a new CLI session. Look for **Connected** in the popup and, if using Desktop, an online browser in **Browser connections**. After connection authorization, ordinary task actions run directly without per-page or per-action prompts. Task readiness, origin scope, takeover, stop and credential protections still apply. Offline or unknown state is not proof of authorization.

## Profiles / 多 profile

未指定 `--profile` 时首次安装只启用 **default**，不是当前对话的 profile，也不是所有 profile。先用 `hermes profile list` 查看现有 profile；不存在时才创建，然后按需选择：
Without `--profile`, the first install enables only **default**, not the current conversation's profile or every profile. Use `hermes profile list` to inspect existing profiles; create one only if missing, then select:

```sh
hermes profile create work  # 仅当不存在 / only if missing
./install.sh --profile default --profile work
```

只启用 `work` 时运行 `./install.sh --profile work`。共享根默认是 `$HOME/.hermes`；仅 `<共享根>/plugins/browser-link` 保存一份使用中的正规程序目录，命名 profile 的 `<共享根>/profiles/<名>/plugins/browser-link` 是直接指向它的目录链接，由 Hermes CLI 单独启用。新增 profile 用 `./install.sh --upgrade --profile <名>`，不必复制程序或加载第二份扩展。

To enable only `work`, run `./install.sh --profile work`. The shared root defaults to `$HOME/.hermes`; one regular program directory lives at `<shared-root>/plugins/browser-link`. Named profiles use direct directory links at `<shared-root>/profiles/<name>/plugins/browser-link` and are enabled separately through the Hermes CLI. Add a profile with `./install.sh --upgrade --profile <name>`; no program copy or second extension is needed.

程序共用不等于权限共用：各 profile 的启停、可选权限、配置、记忆、工作区、站点工具、任务身份和凭据数据继续隔离。Hermes Desktop 仍会生成一份应用级界面缓存；升级备份也保留，不承诺磁盘上没有任何额外程序副本。

Sharing code does not share permissions: profile settings, optional capabilities, memory, workspaces, site tools, task identities and credential data remain separate. Hermes Desktop still materializes an application-level UI cache, and upgrade backups are retained; this is not a zero-copy claim for the entire disk.

`HERMES_HOME` 或 `--hermes-home` 指向 `.../profiles/<名>` 时，安装器会解析到共享根；**仍需用 `--profile <名>` 选择启用对象**。自定义目录示例：`./install.sh --hermes-home /path/to/hermes-root --profile work`，其中 `work` 必须已存在于该根目录。不要把当前 profile 的 `HERMES_HOME` 直接用作连接检查根目录。

When `HERMES_HOME` or `--hermes-home` points to `.../profiles/<name>`, the installer resolves the shared root; **you must still select the profile with `--profile <name>`**. For a custom root: `./install.sh --hermes-home /path/to/hermes-root --profile work`, where `work` must already exist under that root. Do not use the active profile's `HERMES_HOME` directly as the connection-check root.

升级会将已有全副本、未登记或停用的入口一并迁移为共享引用，但不把迁移当作启用授权。未传 `--profile` 的升级保留原启停状态；停用的仍停用。卸载包含已有入口，删除合法引用只解除链接，不沿链接删除共享程序。

Upgrade includes existing, unrecorded and disabled program entries, migrating copies to shared references without granting enablement. An upgrade without `--profile` preserves each profile's enablement. Disabled profiles stay disabled. Uninstall includes existing entries; removing a valid reference unlinks it rather than following it to delete the shared program.

## Upgrade / 升级

完成当前任务，在新安装包或更新后的源码目录运行：
Finish active tasks, then run from the new package or updated source:

```sh
./install.sh --upgrade
```

重载扩展并重启 Hermes 桌面端；此前若加载了其他目录，改为加载本次打印的路径。升级自动备份，失败时回滚；需要查看备份目录时加 `--verbose`。

Reload the extension and restart Hermes Desktop. If you previously loaded another directory, load the newly printed path. Upgrade backs up the installation and rolls back on failure; add `--verbose` to see the backup directory.

升级备份位于 `<共享根>/plugin-backups/`，在插件扫描目录之外；目录、原链接目标和配置按原类型恢复。未知、断链、链式、跨根及祖先链接会拒绝；数据目录不享受程序链接例外。无法创建目录链接时不提权、不回退复制，保持目标不变。

Backups live outside plugin discovery in `<shared-root>/plugin-backups/`; rollback preserves directory types, original link targets and configuration. Unknown, broken, chained, cross-root and ancestor links are rejected. Data directories have no program-link exception. If directory links cannot be created, installation leaves targets unchanged instead of elevating privileges or falling back to copies.

升级到本版后，退出 Chrome、Edge 和 Hermes，桥接仅在无连接、任务已终结且清理成功、没有未决操作并且账本已保存时，等待 30 秒自行退出。未知状态会继续阻止升级；安装器不会停止任务或进程。云端所有实例和历史账本也必须能确认空闲。

After upgrading to this version and quitting Chrome, Edge and Hermes, the bridge exits after 30 seconds only when there are no clients, all tasks have finished with successful cleanup, no operations are pending, and state is saved. Unknown state blocks upgrade. The installer never stops tasks or processes; all cloud instances and legacy journals must also be verified idle.

旧版桥接没有这项自动退出功能。首次迁移时先在旧版界面核实并完成任务和清理，再退出上述应用；若安装器仍报告旧桥接在运行，需要你核实 PID 对应本次共享根目录的 `daemon.py`，并自行以 `SIGTERM` 或 `SIGINT` 正常退出该旧进程。安装器不会代为停止进程。未决任务、`needs_sync` 或清理未知仍须先处理，不能强停或删除账本绕过门禁；系统重启也可能保留旧 PID/socket，不能作为已安全退出的证明。

Older bridges do not support automatic exit. For the first migration, verify and finish tasks and cleanup in the old UI, then quit those apps. If the installer still reports a running bridge, verify that its PID belongs to this shared root's `daemon.py` and manually request a normal exit with `SIGTERM` or `SIGINT`. The installer never stops it. Pending tasks, `needs_sync` and unknown cleanup still block migration; do not force-stop or delete journals to bypass the guard. A system restart may leave stale PID/socket files and does not prove a safe exit.

如果旧云端入口提示需要维护迁移，确认已退出上述应用后，在新包目录运行一次：
For an older cloud launcher that requires maintenance, quit those apps and run once from the new package:

```sh
./install.sh --upgrade --maintenance
```

此流程备份并临时暂停旧启动入口，再核实空闲；成功后切换到新版，失败恢复原入口，不删除配对。旧更新器会拒绝自动安装此共享包，须先完成这次手动迁移。

Maintenance backs up and temporarily pauses the old launcher, verifies idle state, and restores the original launcher on failure. Pairing data is kept. Older updaters reject this shared package; complete the manual migration first.

## Automatic updates / 自动更新

旧安装先在本次源码或安装包目录运行 `./install.sh --upgrade`，安装更新组件，再开启后台更新：
Upgrade an existing installation from this source or package first, then enable background updates:

```sh
./install.sh --auto-update install
```

每小时检查 GitHub 最新正式 Release，开发预览版不属于自动更新通道。Chrome、Edge 或 Hermes 运行时延后到下一次检查；不会退出应用。更新校验 GitHub 附件 SHA256、包内完整文件清单、扩展 ID 和版本，沿用原升级备份及失败回滚，包含此前安装的 profile。后台更新不打开浏览器或修改剪贴板。更新后，下次打开浏览器时重载扩展，再启动 Hermes。

Checks the latest stable GitHub Release hourly; developer previews are excluded. Installation waits until Chrome, Edge and Hermes exit. The updater validates the asset SHA256, package file inventory, extension identity and version, and reuses transactional backups and rollback for all installed profiles. Reload the extension after opening the browser, then start Hermes.

```sh
# 只自动检查 / Automatically check without installing
./install.sh --auto-update check
# 立即检查 / Check now
./install.sh --check-update
# 检查并安装；应用运行时会延后 / Update now; defers while apps run
./install.sh --update
# 关闭 / Disable background updates
./install.sh --auto-update off
```

自动更新默认关闭。使用 macOS 用户 LaunchAgent，只有用户登录期间运行；卸载时移除调度。网络或校验失败保留原安装，下一次检查重试。结果保存在 `<共享根>/plugin-data/browser-link-native/update-status.json`（共享根默认 `$HOME/.hermes`），状态包括 `available`、`deferred`、`updated`、`up_to_date`、`no_stable_release` 和 `failed`。

Background updates are disabled by default and use a user LaunchAgent; uninstall removes it. Network or validation failures preserve the installation. Results are stored in `<shared-root>/plugin-data/browser-link-native/update-status.json`, with `$HOME/.hermes` as the default shared root.

没有正式版本时返回 `no_stable_release`；缺少 GitHub 附件摘要时拒绝更新。

If no stable release exists, the result is `no_stable_release`. Releases without a GitHub asset digest are rejected.

## Uninstall / 卸载

```sh
./install.sh --uninstall
```

输入 `y` 确认；默认保留任务数据。随后在浏览器扩展管理页移除扩展，重启 Hermes。需要同时删除任务数据时运行：
Enter `y` to confirm; task data is kept. Remove the extension in the browser and restart Hermes. To also delete task data, run:

```sh
./install.sh --uninstall --purge
```

## Options / 选项

| 需要 / Need | 命令参数 / Flag |
|---|---|
| 预览安装 / Preview installation | `--dry-run` |
| 查看安装目录 / Show installation directories | `--verbose` |
| 跳过连接等待 / Skip connection waiting | `--wait-seconds 0` |
| 指定 Hermes 目录 / Select Hermes home | `--hermes-home <dir>` |
| 指定用户目录 / Select user home | `--user-home <dir>` |
| 卸载时跳过提问 / Uninstall without a confirmation question | `--yes` |

## Check connection / 检查连接

优先复制安装器打印的 **检查 / Check** 命令：它已包含安装时的 Python、共享根和用户目录。默认安装也可运行：

Prefer the installer's printed **Check** command: it uses the installation's Python, shared root and user home. For a default installation:

```sh
bridge_home="$HOME/.hermes"
python3 "$bridge_home/plugins/browser-link/native_bridge/doctor.py" --hermes-home "$bridge_home" --user-home "$HOME"
```

自定义安装将 `bridge_home` 换成实际**共享根目录**，不是 `<共享根>/profiles/<名>`；自定义 `--user-home` 也需使用相同目录。doctor 只读，不启动服务、不修复文件或恢复授权。看到顶层 `"ok": true` 表示连接检查通过；失败不代表需要重装。

For custom installs, set `bridge_home` to the actual **shared root**, not `<shared-root>/profiles/<name>`, and reuse the installed `--user-home` if customized. The doctor is read-only: it does not start services, repair files or restore permissions. A top-level `"ok": true` confirms the connection; a failed check is not a reason to reinstall.

## Troubleshooting / 故障排查

| 问题 / Problem | 处理 / Action |
|---|---|
| 缺少 Python / Missing Python | 安装 Python 3.11+，确认终端可运行 `python3` / Install Python 3.11+ and make `python3` available |
| 缺少 Hermes / Missing Hermes | 安装 Hermes，确认终端可运行 `hermes` / Install Hermes and make `hermes` available |
| 源码安装缺少 Node.js / Missing Node.js | 下载 Release ZIP，或安装 Node.js 22.12+ / Use the Release ZIP or install Node.js 22.12+ |
| 缺少浏览器 / Missing browser | 安装 Chrome 或 Edge / Install Chrome or Edge |
| 已有安装 / Already installed | 在新包目录运行 `./install.sh --upgrade` / Run it from the new package |
| 安装包校验失败 / Package validation failed | 重新下载完整 Release ZIP / Download the complete Release ZIP again |
| 未连接 / Not connected | 加载或重载打印的目录，在弹窗点“连接 Hermes”，再运行上面的检查命令 / Load or reload the printed directory, click Connect Hermes in the popup and rerun the check |
| 插件启用失败 / Plugin activation failed | 运行 `hermes --profile <name> plugins enable browser-link` 查看原因 / Run this command to see the cause |
| 升级检测到活动或未知状态 / Upgrade finds active or unknown state | 退出浏览器和 Hermes 后重试 / Quit the browser and Hermes, then retry |

[代理安装提示词 / Agent prompt](agent-install-prompt.md) · [配置 / Configuration](configuration.md) · [安全说明 / Security](https://github.com/fanjing188/hermes-browser-link/blob/main/SECURITY.md) · [开发与手动安装 / Development and manual installation](development.md)
