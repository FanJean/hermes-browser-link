# Development

## Prerequisites

- Node.js 22.12+ and Python 3.11+ for the self-contained tests
- macOS with Chrome or Edge for actual browser execution
- The pinned Hermes test checkout only for the separate integration gate (see [testing.md](testing.md))

```sh
npm ci --ignore-scripts
npm test
```

The daemon and extension bundle no third-party runtime packages. The plugin uses the Hermes SDK and host-provided packages. npm dependencies are development-only, including the pinned React/React Query renderer used by unit tests; they are not shipped in the installation archive.

## Repository layout

```
executor-plugin/        Hermes plugin: tools, owner leases, script lane, official-tool and Vault adapters,
                        Desktop page (desktop/), HTTP API (dashboard/), skills (skills/)
native-bridge/          Daemon, Native Messaging host, client, staging installer, uploads/downloads, CDP gateway
native-extension/       MV3 extension: background, executor core, popup, approval panel, overlay, build script
page-semantics/         Semantic snapshot engine (browser ESM)
browser-interactions/   Screenshot-bound interactions (browser ESM)
browser-workspaces/     Task tab groups (browser ESM)
approval-policy/        Approval decision function
browser-diagnostics/    Diagnostic event schema, JS buffer and Python sink
scripts/                Build, package, install, gates and developer tools
tests/                  Offline suites and opt-in real-browser runners
docs/                   Documentation
```

## Common commands

| Command | What it does |
|---|---|
| `npm test` | Self-contained Node, script-lane and V1.3 regressions; no Hermes install |
| `npm run verify` | Full Hermes integration gate in an isolated snapshot; writes a report under `tests/v1.1-verification/` (ignored by Git) |
| `npm run lint` | ESLint over the repository |
| `npm run check:js` | Syntax and manifest checks for extension and plugin JavaScript |
| `npm run check:docs` | Link, path and secret checks for `docs/` |
| `npm run build` | Build the extension into `native-extension/dist-native/` |
| `npm run package -- --output <dir>` | Build a complete, hash-listed installation package |

## Working against your own Hermes install

`npm run dev:sync` copies the current source into your local Hermes plugin directory and your already-loaded extension directory, so you can try changes in your real browser.

1. Create `.dev-sync.local.json` (ignored by Git) with the extension directory that Chrome and Edge currently load. The development sync helper accepts an existing directory under `$HERMES_HOME/browser-link-releases/` (the standard Hermes home is used when unset):

   ```json
   {"extensionDir": "/absolute/path/to/native-extension"}
   ```

2. Run `npm run dev:sync`. It refuses to run while browser tasks are active, packages the source, syncs the root plugin, installed profile copies and extension, reloads Hermes plugins and restarts the local daemon. A temporary backup is kept only if the sync fails. It refuses when the installed extension version differs from the source; for a version upgrade (source newer, same extension) run `npm run dev:sync -- --allow-upgrade` after making your own backup.
3. Click **Reload** on the extension in each browser. Restart Hermes Desktop if you changed `executor-plugin/dashboard/plugin_api.py`.

For Desktop-page-only work, `npm run dev:watch` re-syncs `executor-plugin/desktop/plugin.js` on every save.

Make sure your checkout is up to date with `main` before syncing; `dev:sync` installs exactly what is in your working tree.

## Conventions

- **Reuse the existing path.** A new action must be wired through the tool schema, host identity, daemon, extension, build and tests — not just added as a name. New script helpers compose existing controlled actions; they do not add a second executor.
- **Fail closed.** Unknown outcomes are reported, not retried. Stale references, changed documents and ambiguous targets are errors. Do not trade authorization checks for speed.
- **Keep the model out of authority.** Owners, generations, approvals and credentials never appear in model-facing schemas or results.
- **Comments** explain constraints and intent. New code includes Chinese comments. Git commit descriptions are written in Chinese.
- **Commits** are small and describe the behavior change. Include tests with every behavior change, and add new offline tests to the explicit list in `scripts/verify-v1.1-offline.py` (real-browser runners must never be part of the default suite).
- Before deleting code, check production callers, the build, packaging, tests and docs.

See [testing.md](testing.md) for how to run and write tests.

## Maintaining new modules

See [product modules](product-modules.zh-CN.md) for source ownership and limits. After changing exported Python helpers or tool schemas, run `python3 scripts/generate-browser-reference.py`. `npm test` checks generated documentation drift. Site-tool and network test runners are explicitly included in the gate inventory; browser runners remain opt-in.

## Installation internals

`install.sh` uses the existing package verifier and transactional installer. Default output shows the extension directory needed for loading; `--verbose` also shows the Hermes/plugin directories and upgrade backup path. Root plugins live in `$HERMES_HOME/plugins/browser-link/`, selected profile copies in `$HERMES_HOME/profiles/<name>/plugins/browser-link/`, stable extensions in `$HERMES_HOME/browser-link-releases/native-extension/`, and private host/task data in `$HERMES_HOME/plugin-data/browser-link-native/`. Upgrade backups live outside plugin registries in `$HERMES_HOME/plugin-backups/`.

Hermes `VALID_HOOKS` controls lifecycle callback registration. Unsupported callbacks are skipped without warnings; daemon task-idle cleanup remains active. The required owner-lease and authorization checks are unchanged. Version numbers describe tested environments rather than an installation gate; unknown version output is left to the actual activation command.

Manual operators can build with `node scripts/package-executor.mjs --output out/manual-package` and use the package's lower-level installer:

```sh
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ --apply
hermes --profile default plugins enable browser-link
```

The first command returns a plan; apply returns `installed_disabled` and activation is separate. This interface refuses existing installations; use `install.sh --upgrade` for replacement. Manual operators handle profile copies, extension loading and app restart. Neither installation interface grants optional `tools.override` or Vault access. See [security](../SECURITY.md#extension-identity-and-installation-packages) for identity and checksum checks, and [testing](testing.md) for isolated acceptance.
