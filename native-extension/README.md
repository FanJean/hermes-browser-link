# native-extension

The Manifest V3 extension for Chrome and Edge. It is the only component that grants authorization and runs page actions.

## Files

| File | Role |
|---|---|
| `background.mjs`, `bridge.mjs` | Native connection, trusted message routing, error mapping |
| `content-filter.mjs` | Built-in Chinese/English notice and webpage-instruction rules; preserves real blockers and structured site restrictions |
| `content-shield.mjs` | Automatic CSS text-block inventory, text/name redaction and screenshot mask geometry |
| `core.mjs` | `Executor`: task/generation/origin/lease checks, actions, semantic bindings, overlay lifecycle |
| `official-actions.mjs`, `page-runtime.mjs`, `cdp-policy.mjs` | Official-tool actions, task-scoped JS/CDP runtime and its method policy |
| `downloads.mjs`, `vault.mjs`, `page-observers.mjs` | Download attribution, private Vault fill, dialogs/console observers |
| `workspace-adapter.mjs` | Task tab groups (wraps `browser-workspaces`) |
| `automation-overlay.mjs`, `interaction-highlight.mjs` | Whole-task input overlay, persistent smooth task cursor, takeover/stop controls and target highlights |
| `popup.*`, `approval-panel.*`, `approval-notifier.mjs` | Connection and access UI, per-action approvals, manual-input prompts |
| `build.mjs` | Builds `dist-native/`: copies shared modules into `vendor/`, rewrites imports, writes `BUILD-DEPS.json` hashes |

Permissions: `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `downloads`, `storage`, `alarms`, `cookies`, plus `<all_urls>` host access for Cookie mirror. No history or bookmarks permissions.

## Build and load

```sh
npm run build   # → native-extension/dist-native/
```

Load `dist-native/` (or the `native-extension/` folder of a package) as an unpacked extension. The Native Messaging host must list the extension's ID; see [docs/installation.md](../docs/installation.md).

## Tests

Offline: `npm test` / `npm run verify`. Real-browser runners live in `tests/native-extension/` and `tests/native-v2/`; read the safety rules in [docs/testing.md](../docs/testing.md) before running them.

## Cookie 镜像

`cookie-mirror.mjs` 是独立内存模块，不进入注入库的 65000 字节预算。Hermes 插件页面选择站点和目标，浏览器弹窗不再展示镜像入口；独立确认面板必须亲自批准本次复制，全部访问也不例外。默认 store、60 秒 TTL、256 KiB 分块、单条失败计数及无值回读；不写存储、日志或诊断。新增 `cookies` + `<all_urls>` 权限用于站点 Cookie 清单和跨站导入。构建在 `BUILD-DEPS.json` 记录该模块原文哈希。

页面文本与指定元素截图屏蔽的配置、入口支持及拒绝边界见 [页面内容屏蔽](../docs/content-shield.md)。扩展仅交付经过保护的图片；未知框架、视觉变更和未支持的原始入口不回退原图。

浏览器弹窗右上角从当前 manifest 显示版本，只保留权限、当前任务控制和自动屏蔽。模拟鼠标固定启用，任务执行和等待下一步期间持续显示，目标间以 240ms 的 transform 动画衔接；接管、断连及任务结束时隐藏，截图完成后恢复。
