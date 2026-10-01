# Installation

This guide installs the Hermes plugin, the local Native Messaging host and the browser extension on macOS. The same file ships as `README.md` inside every release package.

## What gets installed

| Piece | Location | Notes |
|---|---|---|
| Hermes plugin | `$HERMES_HOME/plugins/browser-link/` | Pure Python, no third-party dependencies |
| Native host launcher and config | `$HERMES_HOME/plugin-data/browser-link-native/` | Runtime data (socket, token, task metadata) also lives here, mode `0700` |
| Native Messaging manifests | `~/Library/Application Support/{Google/Chrome,Microsoft Edge}/NativeMessagingHosts/com.hermes.browser_link.json` | Allow only the fixed extension ID |
| Browser extension | Wherever you keep the package's `native-extension/` folder | Loaded unpacked |

`$HERMES_HOME` defaults to `~/.hermes`.

## 1. Get a package

Download a release package, or build one from source:

```sh
node scripts/package-executor.mjs --output ./out/browser-link
```

The output directory must not exist yet. Every file is listed with its SHA-256 in `SHA256SUMS.json`; the installer verifies all of them. The manifest proves integrity, not who built the package, so only install packages from a source you trust.

## 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the package's `native-extension/` folder.
3. Confirm the extension ID is `dhioigkigkkhceflkkkmoljhdaefjohb` in both Chrome and Edge. The manifest `key` is a public key, not a credential; it fixes this ID independently of the loading path.

## 3. Install the plugin and host

From the package directory:

```sh
# Preview: prints what would be created, changes nothing
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/

# Install
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ --apply
```

The installer refuses to overwrite an existing installation, rejects symbolic links, and never enables the plugin or restarts Hermes or the browsers. Use `--hermes-home` and `--user-home` to install into an isolated test environment.

## 4. Enable in Hermes

1. Run `hermes plugins enable browser-link`, then `hermes plugins list` and confirm it is enabled. Restart Hermes / Hermes Desktop. For a named profile, use `hermes -p <profile> plugins enable browser-link` and inspect that same profile's list. The installer does not perform activation.
2. Optional — let Hermes' own `browser_*` and `browser_exec` tools use your browser when a session is bound to a task: grant the plugin the `tools.override` capability (Hermes plugin consent flow, or `plugins.entries.browser-link.granted_capabilities`). Without it, only the plugin's own `browser_shared_*` and `browser_shared_script` tools are registered, and unbound sessions always keep Hermes' built-in behavior.
3. Optional — route Hermes' Vault tools through the bridge's private fill path: set the plugin option `vault_tools.enabled: true` (requires `tools.override`).

## 5. Connect the browser

The extension and the Hermes page are currently in Simplified Chinese; the original labels are shown in parentheses.

1. Click the extension's toolbar icon. The connection status should read **Connected** (已连接). If it does not, click **Connect Hermes** (连接 Hermes) and check that the Native Messaging manifest lists this extension's ID.
2. Enable **browser access** in the popup and choose **smart approval** (智能审批) for the first test. The first read of each site in each task asks once; writes, page JavaScript and debugging ask separately. **Full access** (全部访问) skips these prompts within task scope. Switching access off revokes authority. Sensitive entry uses a separate user confirmation panel. Optional page-text filtering is under **More settings** (更多设置).
3. Hermes Desktop's **Browser connections** (浏览器连接) panel shows bridge state, browser connections and access mode. Clicking **Enable access** (开启访问) opens the extension confirmation. CLI users can use the popup directly. The Desktop panel is provided by the installed plugin; there is no separate desktop package to install.

## Verify the first task

From the source checkout, run `python3 native-bridge/doctor.py`. From an installed package, the script is at `$HERMES_HOME/plugins/browser-link/native_bridge/doctor.py`. The check is read-only: it does not start or repair the service. Verify host registration, protocol health and the connected browser, then ask Hermes to read `https://example.com` and close the task. Confirm the work tab opens, the first site read asks for approval, and the returned text matches the page.

For runtime settings, read `docs/configuration.md` in the source or package. The plugin requires Hermes 0.21.4+; the [v2026.9.21 hook registry](https://github.com/NousResearch/hermes-agent/blob/v2026.9.21/hermes_cli/plugins.py) includes the turn-finalization and stop hooks used for cleanup. Node 22.12+ packages the source; bridge Python requires 3.11+, while the pinned Hermes integration uses 3.14. Tested browsers are Chrome/Edge 153. Linux has not been tested and this installer rejects it; Windows is unsupported by this installer and Unix socket transport.

## Profiles

The default installation uses the root Hermes home. Named profiles share that daemon when their directory layout identifies the shared root; otherwise set `HERMES_BROWSER_BRIDGE_HOME` in the plugin's process environment. Enable the plugin for the profile that runs your chat. Use the installer's `--hermes-home` only when deliberately choosing a different installation root, and verify the resulting launcher/manifests before applying. Do not change `HOME` to choose a profile.

## Updating

For the 1.4.0 rename migration, follow [migration-1.4.0.md](migration-1.4.0.md). Back up first; the migration defaults to dry-run.

The installer does not upgrade in place. Do not use the full uninstall command as an upgrade shortcut: it also removes task-private data.

For a manual upgrade, finish active tasks and disable the plugin. Back up the plugin directory, extension directory, Native Messaging launcher/config/manifests and task-private data to a private directory **outside** `plugins/` and `desktop-plugins/`; Hermes can discover backup directories left there as duplicate plugins. The extension ID is fixed by the manifest `key`; moving the folder does not change its ID. Preserve that key and the exact origin allowlist. Replace only verified program files, reload both browser extensions, and restart Hermes Desktop so its API routes refresh. Check the displayed version and connection before re-enabling work. Keep the old program files and matching configuration until verification completes.

This is a maintainer procedure, not an automated updater. A fresh isolated installation is recommended for first-time evaluation. Never restore old task authorization or replay an operation with an unknown outcome.

## Uninstalling

Finish active tasks, disable the plugin and quit Hermes / Hermes Desktop and the connected browsers first:

```sh
hermes plugins disable browser-link
```

Confirm `hermes plugins list` reports it disabled. Stop any remaining bridge daemon only after checking its PID and command belong to this installation. Back up data you want to keep; the following deletion is permanent. Commands use the default home when `HERMES_HOME` is unset; if you used `--hermes-home` or `--user-home`, substitute those exact roots.

```sh
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/browser-link"
```

```sh
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugin-data/browser-link-native"
```

```sh
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.browser_link.json"
```

```sh
rm -f "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.hermes.browser_link.json"
```

Then remove the extension from each browser. Removing `plugin-data/browser-link-native` also deletes task metadata, diagnostics and any task-private upload/download copies.

## Troubleshooting

| Symptom | Check |
|---|---|
| Extension shows *Not connected* | Manifest `allowed_origins` contains the exact `chrome-extension://<ID>/`; the launcher in `plugin-data/browser-link-native/` is executable |
| Hermes reports `no_browser` | The extension is enabled and connected; the browser window is open |
| `execution_denied` | Inspect `reasonCode`, `stage`, `code` and `outcome_unknown`; an unclassified denial does not identify a website problem. Do not retry an unknown write |
| `tab_out_of_scope` | Use the returned work tab within its authorized origin, or open a task for the new origin |
| `origin_denied` | The origin is outside this task; start a task for it rather than silently expanding access |
| `awaiting_authorization` never resolves | Open the extension popup and approve the task, or turn on browser access |
| Official `browser_*` tools ignore the bridge | `tools.override` is granted and the session is bound (`browser_shared_open` or `browser_shared_get` on a ready task) |

For error codes and recovery steps, see `docs/usage.md` in the source repository.
