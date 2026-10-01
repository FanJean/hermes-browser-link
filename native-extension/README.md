# native-extension

The Manifest V3 extension for Chrome and Edge. It is the only component that grants authorization and runs page actions.

## Files

| File | Role |
|---|---|
| `background.mjs`, `bridge.mjs` | Native connection, trusted message routing, error mapping |
| `content-filter.mjs` | Optional popup-controlled text filtering for snapshots, page parsing and successful JS values; preserves errors, references and access blockers |
| `core.mjs` | `Executor`: task/generation/origin/lease checks, actions, semantic bindings, overlay lifecycle |
| `official-actions.mjs`, `page-runtime.mjs`, `cdp-policy.mjs` | Official-tool actions, task-scoped JS/CDP runtime and its method policy |
| `downloads.mjs`, `vault.mjs`, `page-observers.mjs` | Download attribution, private Vault fill, dialogs/console observers |
| `workspace-adapter.mjs` | Task tab groups (wraps `browser-workspaces`) |
| `automation-overlay.mjs`, `interaction-highlight.mjs` | Click-blocking overlay with status and controls; target highlights |
| `popup.*`, `approval-panel.*`, `approval-notifier.mjs` | Connection and access UI, per-action approvals, manual-input prompts |
| `build.mjs` | Builds `dist-native/`: copies shared modules into `vendor/`, rewrites imports, writes `BUILD-DEPS.json` hashes |

Permissions: `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `downloads`, `storage`, `alarms`. No history, bookmarks or cookie permissions.

## Build and load

```sh
npm run build   # → native-extension/dist-native/
```

Load `dist-native/` (or the `native-extension/` folder of a package) as an unpacked extension. The Native Messaging host must list the extension's ID; see [docs/installation.md](../docs/installation.md).

## Tests

Offline: `npm test` / `npm run verify`. Real-browser runners live in `tests/native-extension/` and `tests/native-v2/`; read the safety rules in [docs/testing.md](../docs/testing.md) before running them.
