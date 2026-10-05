# Installation / 安装

目前支持 macOS + Chrome/Edge。需要 Hermes 和 Python 3.11+；已测试 Hermes 0.21.4、浏览器 153。源码安装还需要 Node.js 22.12+。

Currently supported: macOS + Chrome/Edge. Install Hermes and Python 3.11+ first; tested with Hermes 0.21.4 and browser 153. Source installation also needs Node.js 22.12+.

## Install / 安装

从 [Release](https://github.com/FanJean/hermes-browser-link/releases) 下载 ZIP，解压并进入目录，运行：
Download the Release ZIP, extract it, enter its directory and run:

```sh
./install.sh
```

源码安装 / From source:

```sh
git clone https://github.com/FanJean/hermes-browser-link.git
cd hermes-browser-link
./install.sh
```

看到“程序安装并启用完成”后，在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，粘贴脚本打印的扩展路径。路径会复制到剪贴板。脚本最多等待 3 分钟；连接后显示 ✅，Ctrl+C 可跳过等待。

When **Program installed and enabled** appears, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked** and paste the printed extension path. The path is copied to the clipboard. The script waits up to 3 minutes and shows ✅ when connected; Ctrl+C skips waiting.

保留扩展默认的智能审批模式，重启 Hermes 桌面端。弹窗显示“已连接”、桌面“浏览器连接”页显示在线浏览器即完成。

Keep the default **smart approval** mode for the first trial and restart Hermes Desktop. Look for **Connected** in the popup and an online browser in Desktop → **Browser connections**.

## Profiles / 多 profile

先在 Hermes 创建需要的 profile，然后运行；未指定时使用 default：
Create the Hermes profiles first, then select them below; without flags, installation uses default:

```sh
./install.sh --profile default --profile work
```

升级和卸载会自动处理此前安装的 profile。/ Upgrade and uninstall include previously installed profiles.

## Upgrade / 升级

完成当前任务，在新安装包或更新后的源码目录运行：
Finish active tasks, then run from the new package or updated source:

```sh
./install.sh --upgrade
```

重载扩展并重启 Hermes 桌面端；此前若加载了其他目录，改为加载本次打印的路径。升级自动备份，失败时回滚；需要查看备份目录时加 `--verbose`。

Reload the extension and restart Hermes Desktop. If you previously loaded another directory, load the newly printed path. Upgrade backs up the installation and rolls back on failure; add `--verbose` to see the backup directory.

## Automatic updates / 自动更新

旧安装先在本次源码或安装包目录运行 `./install.sh --upgrade`，安装更新组件，再开启后台更新：
Upgrade an existing installation from this source or package first, then enable background updates:

```sh
./install.sh --auto-update install
```

每小时检查 GitHub 最新正式 Release；开发预览版（包括 1.7.1）不属于自动更新通道。Chrome、Edge 或 Hermes 运行时延后到下一次检查；不会退出应用。更新校验 GitHub 附件 SHA256、包内完整文件清单、扩展 ID 和版本，沿用原升级备份及失败回滚，包含此前安装的 profile。后台更新不打开浏览器或修改剪贴板。更新后，下次打开浏览器时重载扩展，再启动 Hermes。

Checks the latest stable GitHub Release hourly; developer previews, including 1.7.1, are excluded. Installation waits until Chrome, Edge and Hermes exit. The updater validates the asset SHA256, package file inventory, extension identity and version, and reuses transactional backups and rollback for all installed profiles. Reload the extension after opening the browser, then start Hermes.

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

自动更新默认关闭。使用 macOS 用户 LaunchAgent，只有用户登录期间运行；卸载时移除调度。网络或校验失败保留原安装，下一次检查重试。结果保存在 `$HERMES_HOME/plugin-data/browser-link-native/update-status.json`（默认 `$HOME/.hermes`），状态包括 `available`、`deferred`、`updated`、`up_to_date`、`no_stable_release` 和 `failed`。

Background updates are disabled by default and use a user LaunchAgent; uninstall removes it. Network or validation failures preserve the installation. Results are stored in `$HERMES_HOME/plugin-data/browser-link-native/update-status.json`, with `$HOME/.hermes` as the default home.

更新只接受正式版本。当前发布工作流创建的 Release 默认标记为 prerelease；维护者必须完成验收并在 GitHub 取消预发布标记，才会进入自动更新。没有正式版本时返回 `no_stable_release`；缺少 GitHub 附件摘要时拒绝更新。

Only stable releases are eligible. The release workflow creates prereleases; maintainers must verify the release and clear its prerelease flag in GitHub before automatic delivery. Releases without a GitHub asset digest are rejected.

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

```sh
python3 "${HERMES_HOME:-$HOME/.hermes}/plugins/browser-link/native_bridge/doctor.py"
```

使用 `--hermes-home` 安装时，将命令中的目录换成安装时指定的目录；检查命令也可加 `--hermes-home <dir> --user-home <dir>`。看到 `"ok": true` 表示连接检查通过。

If you installed with `--hermes-home`, use that directory in the command; the check also accepts `--hermes-home <dir> --user-home <dir>`. Look for `"ok": true`.

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
| 升级无法停止旧连接 / Upgrade cannot stop the old connection | 退出浏览器和 Hermes 后重试 / Quit the browser and Hermes, then retry |

[代理安装提示词 / Agent prompt](agent-install-prompt.md) · [配置 / Configuration](configuration.md) · [安全说明 / Security](https://github.com/FanJean/hermes-browser-link/blob/main/SECURITY.md) · [开发与手动安装 / Development and manual installation](development.md)
