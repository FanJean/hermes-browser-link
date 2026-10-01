# 1.4.0 改名迁移

1.4.1 的迁移脚本会检查 `profiles/*/plugins/` 中精确指向旧插件目录的软链接，并改为指向 `plugins/browser-link`。已经完成 1.4.0 迁移的安装也可用同一脚本先预览、再修复遗留链接。结果中的 `gatewayRestartRequired: true` 表示需要重启 Hermes 网关；网关启动时才重新加载各 profile 的插件。

项目名为 **hermes-browser-link**，扩展显示 **Hermes Browser Link**，插件 ID 为 `browser-link`，Native Messaging 宿主为 `com.hermes.browser_link`。工具名、脚本 helper 和 `HERMES_BROWSER_DEFAULT` 不变。

## 准备与预览

迁移脚本从本仓库运行，输入经过哈希校验的 1.4.0 包。先结束浏览器任务，退出 Hermes Desktop 和其他 Hermes 会话，关闭两个浏览器，防止旧宿主在迁移期间重启。不要删除用户数据。

```sh
node scripts/package-executor.mjs --output ./out/browser-link-1.4.0
python3 scripts/migrate-to-browser-link.py --package ./out/browser-link-1.4.0
```

默认 dry-run 只读取并显示计划，不创建备份、不停止进程、不写配置。`HERMES_HOME` 默认 `~/.hermes`；隔离环境可指定 `--hermes-home` 和 `--browser-root`，后者包含 `Google/Chrome` 和 `Microsoft Edge` 子目录。新目标已存在但没有成功标记时会拒绝合并；先核对已有安装。配置的 `plugins` 和 `entries` 使用块式映射，`enabled` 支持行内或块式列表；流式插件对象、别名和标量在预检时拒绝，需先展开为明确配置。

## 执行

确认预览路径正确后执行：

```sh
python3 scripts/migrate-to-browser-link.py --package ./out/browser-link-1.4.0 --apply
```

1. 完整备份旧安装、旧数据和主配置及所有 profile 配置到 `$HERMES_HOME/plugin-backups/browser-link-migration-<时间戳>/`。权限保留；套接字不备份、不搬运。
2. 通过令牌认证、PID 权限与命令行核对旧守护进程后停止它。身份核对失败就中止，不向未知进程发信号。
3. 将持久数据复制到 `plugin-data/browser-link` 与 `plugin-data/browser-link-native`，保留任务记录、授权、owner、诊断和 Vault 令牌。新扩展仍需重新授权。
4. 安装插件、桌面副本和 `browser-link-releases/current/native-extension`，注册 Chrome 和 Edge 宿主。核对包哈希、桌面文件与宿主精确来源后，替换 YAML 中的插件启用项与 entries 键，保留其他字节、注释、顺序和权限。
5. 旧目录和旧宿主注册移入备份的 `retired/`。成功标记使重复执行仅校验现有安装，不重新覆盖数据。

扩展 ID 由 manifest `key` 固定为 `dhioigkigkkhceflkkkmoljhdaefjohb`，Chrome 与 Edge 相同，不随加载目录变化。私钥不保存、不入库。宿主只允许 `chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/`。

打开 `chrome://extensions` / `edge://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择 `$HERMES_HOME/browser-link-releases/current/native-extension`。按脚本打印的旧扩展名称移除旧扩展，打开 Hermes Browser Link 重新授权，再重启 Hermes，核对版本与连接状态。脚本的文件校验不代替这一步真实浏览器验收。

## 回滚

执行失败时脚本还原已移走的旧目录、撤销新目标并恢复配置，保留备份并报告位置。已经停止的守护进程不会自动重启；退出新扩展后重新启动 Hermes。若回滚本身遇到磁盘或权限错误，保留报错与备份，按下面方法恢复。

成功后若需人工回滚：

1. 退出 Hermes 和浏览器，先备份迁移后新产生的数据，停用新扩展。
2. 打开该次备份的 `restore-map.json`；每项 `target` 是原位置，`snapshot` 是备份内对应路径。核对路径后，将当前新安装和数据目录移到单独私有备份目录，再按映射恢复旧目录、主配置、profile 配置及旧宿主注册，保留文件权限。不要恢复套接字或旧 PID 文件。
3. 移走两个浏览器的 `com.hermes.browser_link.json`，恢复旧扩展加载目录与旧程序配套的注册，重新启动 Hermes 并重新授权。不要混用不同版本的宿主与扩展，也不要重放结果未知的任务。

旧名称仅保留于 `CHANGELOG.md` 历史条目和迁移脚本的 `LEGACY` 映射。用户本地未跟踪或忽略的配置备份不属于发布源码，不自动改写。
