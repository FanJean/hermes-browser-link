# Hermes Browser Link

Task pages now use a separate Hermes work window by default. Input activates tabs inside that window without focusing it; clicks without an observed effect return an error.

![Hermes Browser Link](docs/assets/readme-banner.png)

[简体中文](README.zh-CN.md)

Let [Hermes Agent](https://github.com/NousResearch/hermes-agent) read and operate task tabs in your existing, logged-in Chrome or Edge.

Read pages and tables, click, fill forms, upload files, track downloads and run Python workflows. Enable **smart approval** in the extension popup; first site reads and later writes show confirmation prompts. See [security](SECURITY.md).

## Requirements

| Component | Requirement |
|---|---|
| Hermes Agent | Tested: **0.21.4** |
| Node.js | **22.12.0+** for source installation and development |
| Python | **3.11+** |
| Platform | Currently supports **macOS + Chrome/Edge**; browser tested with 153 |

## Quick start (3 steps)

1. Download a [Release package](https://github.com/FanJean/hermes-browser-link/releases) and install (no Node.js needed); **Program installed and enabled** confirms success:

   ```sh
   curl -fL https://github.com/FanJean/hermes-browser-link/releases/download/v1.6.1/hermes-browser-link-1.6.1.zip -o hermes-browser-link-1.6.1.zip && unzip hermes-browser-link-1.6.1.zip && cd hermes-browser-link-1.6.1 && ./install.sh
   ```

2. Open `chrome://extensions` or `edge://extensions` → **Developer mode** → **Load unpacked** → paste the absolute path printed and copied by the installer. It waits up to 3 minutes and shows ✅ when connected; Ctrl+C skips the wait.
3. Enable **smart approval** (智能审批) in the extension popup, then restart Hermes Desktop. Confirm **Connected** (已连接) in the popup and an online browser in Desktop → **Browser connections** (浏览器连接).

Upgrade: run `./install.sh --upgrade` from the new package (automatic backup and rollback), then reload the extension and restart Desktop. Uninstall: `./install.sh --uninstall` keeps task-private data; add `--purge` to delete it.

[Source/manual installation, profiles and troubleshooting](docs/installation.md) · [Agent installation prompt](docs/agent-install-prompt.md).

Overlay stuck: click “放开页面” (release page) or refresh the page.

## First use

Tell Hermes:

> Open https://example.com in my browser, read the page title and the first paragraph, then close the task. Do not submit anything.

Approve the first site read in the extension. Hermes should return the text and close its work tab. It starts with `browser_shared_open`; single actions use `browser_shared_run`, and multi-step work uses `browser_shared_script`. See [usage](docs/usage.md) and the [API reference](docs/browser-api-reference.md).

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

Real-browser runners are opt-in and use temporary profiles: see [testing](docs/testing.md). Mechanical and agent benchmark commands are in [benchmarks](docs/bench.md). See [development](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities through [GitHub Security Advisories](https://github.com/FanJean/hermes-browser-link/security/advisories/new), not a public issue.

## License and acknowledgement

[MIT](LICENSE). This project began with Jon Komet's [Hermes browser extension](https://github.com/abundantbeing/hermes-browser-extension); thank you for the original work. The license retains both copyright notices.
