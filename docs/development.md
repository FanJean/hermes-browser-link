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

2. Run `npm run dev:sync`. One command performs the whole local deployment; you do not need to quit the browsers, stop the Hermes gateway, edit `tasks.json` or reload the extension by hand:
   1. It runs `hermes pause --reason "browser-link dev:sync"` so Hermes starts no new work. If Hermes was already paused (`$HERMES_HOME/ESTOP` exists) it neither pauses nor resumes. `BROWSER_LINK_HERMES` selects a different `hermes` executable.
   2. It polls `tasks.json` until every task is `closed`, `cancelled` or `failed` with cleanup `succeeded`. The limit is 300 seconds; change it with `--wait-seconds <n>` or `BROWSER_LINK_DEV_SYNC_WAIT_SECONDS`. On timeout it lists the unfinished task ids and titles and exits without stopping any process. A task that already ended but whose cleanup is `unknown` or `failed` is listed at once, because waiting will not change it (see step 4 below).
   3. It writes the maintenance marker `$HERMES_HOME/plugin-data/browser-link-native/maintenance.json` (0600, private directory, links refused). While it exists the Native host and plugin client do not start the daemon, a daemon started anyway exits immediately, and cloud hosts close themselves and release their instance locks. The extension waits for its regular 30-second reconnect instead of retrying quickly.
   4. It sends SIGTERM only to a daemon whose PID file and command line match this installation, waits for it to exit by itself, and waits for the cloud instance locks to be released. Unknown processes are refused and never signalled.
   5. It packages the source and, under the formal installation locks, updates the shared root program once plus the extension and Desktop UI cache. Named profile references follow the root without being replaced. Old profile copies must first be migrated with `./install.sh --upgrade`; unknown, indirect or linked ancestor paths are rejected before writing targets. A temporary backup is kept only if the sync fails.
   6. Whether the sync succeeded or failed, it removes the maintenance marker, runs `hermes resume` (unless Hermes was paused before), and reloads Hermes plugins.

   It refuses when the installed extension version differs from the source; for a version upgrade (source newer, same extension) run `npm run dev:sync -- --allow-upgrade` after making your own backup.
3. The extension reloads itself: on its next connection to the local bridge (within about 30 seconds) it compares the `buildId` in the installed `BUILD-DEPS.json` with the build it loaded and calls `chrome.runtime.reload()` once per new build. Restart Hermes Desktop if you changed `executor-plugin/dashboard/plugin_api.py`.
4. If a closed task with unknown cleanup blocks the sync, check in the browser that it left nothing behind, then mark it verified:

   ```sh
   npm run tasks:ack -- <taskId> --reason "checked in Edge" --stop-daemon
   ```

   It only writes while the daemon is stopped and its start lock is held; without `--stop-daemon` it refuses a running daemon, with it the command uses the same maintenance marker to stop the verified daemon first and removes the marker afterwards. It copies `tasks.json` to `tasks.json.ack-<time>-<random>.bak`, sets `cleanupState=succeeded` and `cleanupReason=verified_complete`, and records the reason and previous cleanup state under `userVerified`. It refuses tasks that are not closed, still hold permits or pending input, and an unmerged request journal. Once the daemon is confirmed stopped, closed tasks with successful cleanup no longer block the sync because of leftover `unknown`/`dispatched` entries in `requestHistory` or `operationTimeline`.

For Desktop-page-only work, `npm run dev:watch` re-syncs `executor-plugin/desktop/plugin.js` on every save, writing only the shared root entry and application-level Desktop UI cache. It does not create per-profile program copies or enable profiles.

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

`install.sh` uses the existing package verifier and transactional installer. Default output shows the extension directory needed for loading; `--verbose` also shows the Hermes/plugin directories and upgrade backup path. Resolve a profile-shaped `HERMES_HOME` to the shared root: one regular program lives in `<shared-root>/plugins/browser-link/`, named profiles use direct links in `<shared-root>/profiles/<name>/plugins/browser-link/`, and the extension lives in `<shared-root>/browser-link-releases/native-extension/`. Profile enablement, capabilities and private data remain isolated; the native connection is shared. Upgrade backups live outside plugin registries in `<shared-root>/plugin-backups/`, retaining original node types and link targets. Hermes Desktop materializes its existing application-level UI cache separately.

Hermes `VALID_HOOKS` controls lifecycle callback registration. Unsupported callbacks are skipped without warnings; daemon task-idle cleanup remains active. The required owner-lease and authorization checks are unchanged. Version numbers describe tested environments rather than an installation gate; unknown version output is left to the actual activation command.

Manual operators can build with `node scripts/package-executor.mjs --output out/manual-package` and use the package's lower-level installer:

```sh
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/
python3 install-executor.py --extension-origin chrome-extension://dhioigkigkkhceflkkkmoljhdaefjohb/ --apply
hermes --profile default plugins enable browser-link
```

The first command returns a plan; apply returns `installed_disabled` and activation is separate. This lower-level interface installs only the root and refuses existing installations; use `install.sh` for shared profile references and `install.sh --upgrade` for replacement. Manual operators still handle extension loading and app restart. Neither installation interface grants optional `tools.override` or Vault access. See [security](../SECURITY.md#extension-identity-and-installation-packages) for identity and checksum checks, and [testing](testing.md) for isolated acceptance.
