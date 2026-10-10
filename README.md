# Hermes Browser Link

**1.10.0 — macOS stable release.** Authorized browser tasks, automatic text and screenshot shielding, a persistent task cursor, Desktop Cookie mirroring, independent cloud browser access and stable-release updates.

![Hermes Browser Link](docs/assets/readme-banner.png)

[简体中文](README.zh-CN.md)

Let [Hermes Agent](https://github.com/NousResearch/hermes-agent) read and operate task tabs in your existing, logged-in Chrome or Edge.

Read pages and tables, click, fill forms, upload files, track downloads and run Python workflows. Confirm browser connection authorization once in the extension: ordinary reads, navigation, writes, JavaScript, CDP and Python workflows then run directly, without per-action prompts. Takeover, stop, credential protection and special confirmations remain independent. See [security](SECURITY.md).

## Features

| Capability | Behavior |
|---|---|
| Connection authorization | Confirm once in the extension; ordinary task actions execute directly. Takeover, stop, credential protections and Cookie/OAuth-window confirmations remain independent. |
| Existing browsers | Reuse logged-in Chrome/Edge; task tabs use a separate work window without taking focus from your window. |
| OAuth login windows | Discover and explicitly adopt an existing login popup with user confirmation; operation access does not grant deletion rights. |
| Page reading and input | Read text, tables, forms and records; use semantic references, clicks, typing, selection, scrolling and file transfers. |
| Python workflows | Run multi-step scripts and validated reusable site tools through the same task authorization. |
| Automatic content shielding | One switch detects matching Chinese/English notices and webpage instructions, hides the text block from Agent output and masks its screenshot region. No site or CSS-selector setup. |
| Continuous task cursor | Always enabled during task work and between steps, with smooth target-to-target travel, takeover controls and reduced-motion support. |
| Desktop Cookie mirror | Select source sites and target browsers in Hermes Desktop; every transfer requires confirmation in the source extension. |
| Cloud access | Pair your browser with your own Sites plugin using a connection code; independent cloud permissions, separate conversation tasks, multiple pages and verified cleanup. See [Cloud connection](docs/cloud-connection.md). |
| Installation and updates | One shared program with per-profile references and isolated settings/data; verified packages, backup/rollback, hourly stable-release checks and idle installation. |

Shielding protects Browser Link outputs, leaves your visible webpage intact, and preserves real verification/error signals. Unsupported raw channels or uninspectable page structures are refused. See [shielding boundaries](docs/content-shield.md), [complete features](docs/features.md), and the [module catalog](docs/product-modules.zh-CN.md).

## Requirements

| Component | Requirement |
|---|---|
| Hermes Agent | Tested: **0.21.4** |
| Node.js | **22.12.0+** for source installation and development |
| Python | **3.11+** |
| Platform | Currently supports **macOS + Chrome/Edge**; browser tested with 153 |

## Quick start (3 steps)

1. With Hermes and Python already installed (`hermes --version`, `python3 --version`), download the [Release asset](https://github.com/fanjing188/hermes-browser-link/releases) named `hermes-browser-link-1.10.0.zip` — not GitHub's **Source code (zip)**. No Node.js or npm is needed. **Program installed and enabled** confirms the local installation only, not a browser connection:

   ```sh
   curl -fL https://github.com/fanjing188/hermes-browser-link/releases/download/v1.10.0/hermes-browser-link-1.10.0.zip -o hermes-browser-link-1.10.0.zip && unzip hermes-browser-link-1.10.0.zip && cd hermes-browser-link-1.10.0 && ./install.sh
   ```

2. While the terminal waits, open `chrome://extensions` or `edge://extensions` → **Developer mode** → **Load unpacked** → paste the printed absolute **Extension directory** (not the extracted ZIP directory). The installer copies it to the clipboard when available. It waits up to 3 minutes; **Extension connected** confirms the connection. Ctrl+C skips only this wait. A timeout does not undo installation or require reinstalling; load the extension and run the printed **Check** command.
3. Open the extension popup, click **Connect Hermes** if disconnected, and confirm connection authorization (full access) in the browser. There is no smart-approval mode or per-action permission switch. Restart Hermes Desktop (or start a new CLI session) using the installed profile. Confirm **Connected** (已连接) in the popup and, if using Desktop, an online browser in **Browser connections** (浏览器连接).

The first install enables **default** unless you pass `--profile <name>`, even inside a named profile's environment. For existing profiles, use `./install.sh --profile default --profile work`; to enable only `work`, use `./install.sh --profile work`. One program lives in the shared root; named profiles use direct links, with separate enablement, permissions and private data. Upgrade migrates old copies without enabling disabled profiles. Upgrade backups and Hermes Desktop's application-level UI cache remain separate. See [profiles](docs/installation.md#profiles--多-profile).

Upgrade: quit Chrome, Edge and Hermes, then run `./install.sh --upgrade` from the new package (automatic backup and rollback). If an older cloud launcher requires it, run `./install.sh --upgrade --maintenance` once, then reload the extension and restart Desktop. Uninstall: `./install.sh --uninstall` keeps task-private data; add `--purge` to delete it.

Automatic updates accept stable releases; 1.10.0 is eligible. Upgrade an older installation manually once to install the current update source. After installing the update component, run `./install.sh --auto-update install`. It checks stable releases hourly and installs after browsers and Hermes exit. Reload the extension before starting Hermes again. Use `--auto-update check` for checks only, `--auto-update off` to disable, or `--update` to update now. See [automatic updates](docs/installation.md#automatic-updates--自动更新).

[Source/manual installation, profiles and troubleshooting](docs/installation.md) · [Agent installation prompt](docs/agent-install-prompt.md).

Overlay stuck while disconnected or status is unknown: click “放开页面” (release page) or refresh to remove the local veil. This does not prove background execution stopped; reconnect and verify task state before continuing.

## First use

Tell Hermes:

> Open https://example.com in my browser, read the page title and the first paragraph, then close the task. Do not submit anything.

With browser connection authorization already confirmed, Hermes should read directly, return the text and close its work tab; no first-site confirmation is needed. It starts with `browser_shared_open`; single actions use `browser_shared_run`, and multi-step work uses `browser_shared_script`. See [usage](docs/usage.md) and the [API reference](docs/browser-api-reference.md).

## Cookie mirror

Open Hermes Desktop → **Browser connections** → **Cookie mirror** on the source browser, select sites and the target browser, then confirm in the source extension's panel. If the target still asks for a login, sign in there. See [usage](docs/usage.md#cookie-mirror) and [security](SECURITY.md#cookie-mirror-150).

## Configuration and recovery

If disconnected, load or reload the extension, click **Connect Hermes** in the popup and run the check in [installation](docs/installation.md#check-connection--检查连接). If an action fails, inspect the current page and follow the displayed instructions. Settings are in [configuration](docs/configuration.md).

## Development and contributions

Install development dependencies:

```sh
npm ci --ignore-scripts
```

Run offline tests and documentation checks:

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

Real-browser runners are opt-in and use temporary profiles: see [testing](docs/testing.md). Mechanical and agent benchmark commands are in [benchmarks](docs/bench.md). See [development](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities through [GitHub Security Advisories](https://github.com/fanjing188/hermes-browser-link/security/advisories/new), not a public issue.

## License and acknowledgement

[MIT](LICENSE). This project began with Jon Komet's [Hermes browser extension](https://github.com/abundantbeing/hermes-browser-extension); thank you for the original work. The license retains both copyright notices.
