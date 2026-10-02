# Hermes Browser Link

[简体中文](README.zh-CN.md)

Let [Hermes Agent](https://github.com/NousResearch/hermes-agent) read and operate task tabs in your existing, logged-in Chrome or Edge.

It reads pages and tables, clicks and fills ordinary forms, uploads user-selected files, tracks downloads, and runs Python workflows. A local Native Messaging host connects the Hermes plugin to the extension; it does not copy your browser profile or use a cloud browser service. Page results still enter your agent's context and may be sent to its model provider.

**Permissions:** smart approval asks once per site per task before reading, and separately for writes, page JavaScript and debugging. Full access skips those prompts within task scope. You grant access in the extension; the Desktop switch opens that confirmation. You can take over or stop a task. Standard helpers hand sensitive input to you, and screenshots mask visible sensitive fields and uninspectable frames. Credential headers, including Cookie values, are stripped from network evidence. Arbitrary JavaScript/CDP results are not comprehensively redacted, and Python runs as your user, without an OS sandbox. Read [SECURITY.md](SECURITY.md).

The bridge cannot bypass login, CAPTCHA, site restrictions or browser permission dialogs. Existing personal tabs are outside task leases; new work tabs belong to tasks. Task separation does not isolate accounts.

## Requirements

| Component | Requirement |
|---|---|
| Hermes Agent | **0.21.4+**; the v2026.9.21 source includes `on_session_end` and `agent_loop_stopped`. Full integration uses the pinned revision in [testing](docs/testing.md). |
| Node.js | **22.12.0+** for packaging and development |
| Python | **3.11+** for this bridge; use the Python version required by your Hermes installation (the pinned integration uses 3.14) |
| Browser | Desktop Chrome or Edge; tested with **153**. No lower browser version is certified. |
| OS | **macOS developer preview**. Linux is untested and the installer rejects it; Windows is unsupported by the current installer and Unix socket transport. |

## Install from source

Use a permanent checkout directory: the unpacked extension must remain available there. Each command below is a separate step. Installation does not enable the plugin or restart applications.

1. Get the source:

   ```sh
   git clone https://github.com/FanJean/hermes-browser-link.git
   ```

2. Enter the checkout:

   ```sh
   cd hermes-browser-link
   ```

3. Check prerequisites:

   ```sh
   node --version
   ```

   ```sh
   python3 --version
   ```

   ```sh
   hermes --version
   ```

4. Build the installation package (output must not already exist):

   ```sh
   node scripts/package-executor.mjs --output ./out/browser-link
   ```

   Confirm it contains `SHA256SUMS.json`, `install-executor.py` and `native-extension/manifest.json`.

5. **You do this in the browser:** open `chrome://extensions` or `edge://extensions`, enable Developer mode, and load `out/browser-link/native-extension/`. Confirm ID `dhioigkigkkhceflkkkmoljhdaefjohb`. The manifest `key` is a **public key** fixing that ID, not a secret.

6. Preview plugin and native host registration:

   ```sh
   python3 scripts/install-executor.py --package ./out/browser-link --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/
   ```

   Confirm `status: plan`, the intended Hermes home, and Chrome/Edge manifest paths. Existing installations are refused.

7. Apply the reviewed plan:

   ```sh
   python3 scripts/install-executor.py --package ./out/browser-link --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ --apply
   ```

   Confirm `status: installed_disabled`. This registers both browser hosts and installs the plugin.

8. Enable the plugin for the Hermes profile you will use:

   ```sh
   hermes plugins enable browser-link
   ```

   ```sh
   hermes plugins list
   ```

   Confirm `browser-link` is enabled, then restart Hermes / Hermes Desktop. Optional official-tool routing needs a separate `tools.override` grant.

9. **You confirm browser access:** open the extension popup, check **已连接** (Connected), and enable access in **智能审批** (smart approval). In Hermes Desktop, open **浏览器连接**; its access switch opens the extension's confirmation. CLI users can use the popup directly.

10. Check registration and connection without repairing anything:

    ```sh
    python3 native-bridge/doctor.py
    ```

    Confirm the host manifests and a connected browser. Detailed steps, profile selection, upgrades and uninstall: [installation](docs/installation.md). For assisted installation, copy [the agent prompt](docs/agent-install-prompt.md).

## First use

Tell Hermes:

> Open https://example.com in my browser, read the page title and the first paragraph, then close the task. Do not submit anything.

Approve the first site read in the extension. Hermes should return the text and close its work tab. It starts with `browser_shared_open`; single actions use `browser_shared_run`, and multi-step work uses `browser_shared_script`. See [usage](docs/usage.md) and the [API reference](docs/browser-api-reference.md).

## Cookie mirror

Copy selected sites' cookies from the source extension popup to another connected Chrome/Edge profile. Each transfer requires a fresh confirmation in the **source extension**, including in full-access mode. The new `cookies` and `<all_urls>` permissions allow inventories and imports. Values use a one-use local memory channel with a 60-second deadline and never enter model results, logs or task files. Hermes sees only sites, states, counts and fixed failure categories.

Only the default, non-incognito cookie store is supported. Site grouping uses a small suffix table, so check the site list before confirming. Readback verifies imported cookie identities; device-bound sessions, local storage or server checks may still require login. Interrupted transfers can leave partial changes in the target. See [usage](docs/usage.md#cookie-mirror) and [security](SECURITY.md#cookie-mirror-150).

## Configuration and recovery

The full [environment variable table](docs/configuration.md) covers browser selection, export directories, pause and cleanup timeouts, shared homes and test settings. Set them in the relevant process before launch. `HERMES_BROWSER_DEFAULT` and `HERMES_BROWSER_EXPORT_ROOTS` also read the shared bridge home's `.env`; do not commit that file.

Finish tasks and disable the plugin before upgrading. The installer refuses in-place replacement; follow the backup and replacement procedure in [installation](docs/installation.md). Uninstalling runtime data also removes task-private files.

| Result | Action |
|---|---|
| Browser not connected / `no_browser` | Open the browser, check the extension and native host registration |
| `execution_denied` | Inspect its structured reason and `outcome_unknown`; do not guess or blindly retry |
| `origin_denied` / `tab_out_of_scope` | Use a task authorized for that origin and its returned tab; do not expand permissions silently |
| `approval_required` / `user_input_required` | Complete the extension's confirmation or sensitive input yourself |
| `outcome_unknown` | Inspect the page once; never automatically replay the write |

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
