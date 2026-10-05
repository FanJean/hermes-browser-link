# Usage

This page describes what Hermes (and you) can do once the bridge is installed. Hermes discovers the same information through the plugin's skills (`browser-link:use-my-browser`, `browser-link:batch-scrape`, `browser-link:troubleshoot`).

## Concepts

- **Browser instance** — one connected Chrome or Edge profile running the extension.
- **Task** — a unit of work bound to one browser instance, a set of allowed site origins, a generation number, and the tabs it owns. Tasks never share tabs.
- **Work tab** — a tab the task opened itself, placed in the task's tab group. The bridge never closes tabs you opened.
- **Session binding** — the Hermes session that owns a task. A session is bound to at most one task; the script tool and Hermes' official browser tools act on that task.
- **Generation** — increments when a task is resumed. Every action carries it, so authority from an older generation cannot be reused.

Task states: `pending_approval` → `authorizing` → `ready` / `running` → `cancelled` / `closed`. A task becomes `needs_sync` after a disconnect or an unknown outcome and must be resumed.

## Automatic task cleanup (1.4.3)

A completed turn closes its work tabs immediately by default. If a positive grace period is configured, any `browser_shared_*` call in the same Hermes session cancels it, including health, reference and script calls. CLI exit preserves a configured grace period. Failed or interrupted turns and `/stop` immediately end that session's tasks using handoff. An unmapped stop event logs a warning and closes no tasks.

The daemon also closes ready tasks after 60 minutes without calls, scanning once at startup and then every 0.5 seconds. A task-specific call updates that task's activity; a session-level call updates its active tasks. Paused tasks and tasks waiting for manual input or approval are exempt. After a daemon restart, previously paused/manual tasks require explicit resume and retain this protection. Running operations are not closed by the idle scan.

Set `HERMES_BROWSER_IDLE_CLOSE_SECONDS` (default `0`, positive values enable grace) and `HERMES_BROWSER_TASK_IDLE_TIMEOUT_SECONDS` (default `1200`) in the daemon's launch environment. Values must be finite non-negative seconds. Restart the daemon through your normal installation workflow to apply changes. This release does not change `.env` or the running installation automatically.

Use `browser_shared_close(task_id, keep_tabs=true)` for pages the user must finish. The task loses authority, its created tabs stay open, and its group is removed when the private creation journal proves ownership. Tabs moved to a user's group and tabs the user opened stay unchanged. Renaming a task group does not remove its identity; browser restart invalidates the old creation proof. Use `python3 scripts/sweep-stale-tasks.py --help` to inspect the one-time cleanup options.

## Tools

| Tool | Purpose |
|---|---|
| `browser_shared_open(url)` | The usual entry point. Picks the connected browser, creates or reuses a task for the site, waits for authorization, binds the session and opens (or reuses) a work tab. |
| `browser_shared_browsers`, `browser_shared_health` | List connected browsers; check the bridge service. |
| `browser_shared_create`, `browser_shared_list`, `browser_shared_get` | Manage tasks explicitly. `get` on a ready task also binds the session to it. |
| `browser_shared_run(task_id, action, ...)` | Run one page action (see below). |
| `browser_shared_script(code)` | Run a short Python script with page helpers — see [Python scripting](python-scripting.md). |
| `browser_shared_downloads(task_id, action)` | `list`, `claim` or `cancel` downloads started by the task's pages. |
| `browser_shared_cookie_mirror(action, ...)` | List site counts, request a confirmed transfer or query status; never returns cookie values. |
| `browser_shared_artifacts(task_id)` | List files registered to the task (metadata only). |
| `browser_shared_cancel`, `browser_shared_resume`, `browser_shared_close` | Stop, resume (new generation) or close a task. `close` removes only the task's own work tabs. |

### Page actions (`browser_shared_run`)

| Group | Actions |
|---|---|
| Navigation | `new_tab`, `navigate`, `back`, `tabs`, `scroll` |
| Reading | `semantic_snapshot`, `snapshot`, `frame_catalog`, `screenshot`, `images`, `console` |
| Semantic writes | `ref_click`, `ref_fill`, `ref_press`, `ref_set_checked`, `ref_select_option` (use `binding`, `snapshot_id` and `ref` from the latest snapshot) |
| Selector writes | `click`, `fill`, `press` |
| Screenshot-bound | `interaction.capture`, `interaction.bounds`, `interaction.click`, `interaction.drag_coordinates`, `interaction.drag_elements` |
| Files and dialogs | `files.upload` (`selector` + `paths`), `dialog` |
| Page scripts and CDP | `js.evaluate`, `cdp.send`, `cdp.events` |
| Read-only API | `api_request` (GET/HEAD to URLs approved at task creation, selected JSON fields only) |

Every action except `tabs` and `new_tab` needs an explicit `tab_id`.

### Hermes' official browser tools

When the plugin has the `tools.override` capability and the session is bound to a ready task, these Hermes tools act on the bound task instead of Hermes' own browser: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `browser_vision`, `browser_console`, `browser_cdp`, `browser_dialog`, and `browser_exec`. `browser_console` expressions, `browser_cdp` and `browser_exec` use the existing browser access. `browser_snapshot(full=true)` is not supported. Unbound sessions always use Hermes' built-in implementation.

## A typical flow

1. `browser_shared_open(url="https://example.com")` → returns `task_id` and `tab_id`.
2. Read the page: `semantic_snapshot` (or `browser_snapshot`). References are valid only for that snapshot.
3. Act with the references from the latest snapshot; after anything that changes the page, read again.
4. For multi-page collection or long form workflows, switch to `browser_shared_script`.
5. Moving to another site: call `browser_shared_open` with the new URL.
6. Done: `browser_shared_close(task_id)`.

## Approvals, sensitive fields and take-over

- **Smart approval** (default): new tasks are prepared automatically. The first read of each site in a task needs confirmation; later reads of that site run directly. A navigation or new-tab approval can include the site's read permission when its panel says so. Writes, page requests, JavaScript, raw CDP and `browser_exec` still request approval each time. The tool returns `approval_required`; Hermes must query again with the **same** `request_id` and arguments after the decision. `tabs` lists only the task's leased tabs.
- **Full access**: task tools and debug commands run directly. Cookie mirror always needs a fresh source-extension confirmation.
- `browser_exec` and Vault fill/save/code calls in smart mode use a one-time approval for the whole tool call. Retry with the same `request_id` after approval; use a new one for another independent run. A consumed approval returns `approval_consumed` without dispatch.
- **Sensitive fields** (passwords, payment data, one-time codes): the tool returns `user_input_required`, the browser asks you to fill the field yourself, and the result becomes `completed_by_user` after you confirm. The model never sees or types the value. With the Vault integration enabled, login passwords and OTP codes can instead be filled through a private channel.
- **Take over** (接管页面 on the page overlay) pauses the task so you can use the page; **Resume** (退出接管) hands it back. Actions sent while paused return `task_paused` and are not dispatched. **Stop task** (停止任务) ends the task.

While a task is active its pages are covered by a translucent overlay that blocks clicks and key presses. Each target is highlighted just before an action is dispatched.

The extension popup shows the installed extension version in the top right, **浏览器权限**, and **自动屏蔽网页干扰**. Cookie mirror controls and the primary browser link are on Hermes Desktop → **浏览器连接**. There is no popup cursor switch or additional selector form.

The task cursor is always enabled. It stays visible during active work and between steps, keeps its last position, and moves between targets with a 240 ms transform transition. Drag previews move to the start and then the end without restarting during geometry updates. Pausing, stopping, disconnection and hidden tabs hide it; returning to active work restores it. System reduced-motion preferences disable cursor travel. Capture temporarily hides the overlay and restores it afterward. These visuals do not synthesize extra webpage input or change action authorization.

## Cookie mirror

Desktop entry (1.5.1): connect the updated source and target extensions first. Separate profiles are separate instances; the target must differ from the source.

1. Open Hermes Desktop → **浏览器连接** and expand **Cookie 镜像** on the source browser.
2. Click **读取 Cookie 站点**, search by website, then click a row's **镜像**. You can also select multiple sites and click **镜像已选站点**. Only sites, counts and httpOnly/session flags are listed.
3. Select another connected browser/profile in the dialog. The source is excluded, including when both profiles use Chrome. Clearing target cookies and persisting session cookies are both off by default; persistence accepts 1–365 days.
4. Click **镜像**. Desktop shows preparation/waiting for extension approval, copying, then completion counts (success/failure and readback matched/missing), rejection, expiry or a fixed failure category.
5. Approve in the source extension's panel. It remains open when background focus cannot be verified; click the system notification to focus it, or bring the existing source-browser confirmation window to the front. Full access does not bypass this approval. A failed or uncertain request is never reissued automatically.

The protected desktop API uses `GET /shared/browsers/{id}/cookie-sites`, `POST /shared/cookie-mirror` and `GET /shared/cookie-mirror/{transfer_id}` beneath the plugin prefix. It binds the active profile's UI identity, rejects caller identities/approval/payload fields and returns only allowlisted metadata. The request deadline remains 60 seconds; status is not retained after expiry.

The extension popup no longer displays Cookie mirror controls. Site selection, options and transfer results remain on the Hermes Desktop browser-connection page. Check both instances, sites, counts and options in the source extension panel; neither Hermes nor a website can approve for you.

Keep both Desktop options off to preserve target cookies and source session lifetimes. Enable clearing only when you intend to remove existing target cookies for those sites; optional session persistence accepts 1–365 days. Read per-site `success`, `failed`, `matched`, `missing`, `cleared`, `clearFailed` and fixed failure categories on Desktop. Readback checks name/domain/path/partition identities. Verify login by opening the site's protected page in the target.

Hermes can call `browser_shared_cookie_mirror` with `action="list_sites"` and `source`, then `action="request_mirror"` with `source`, `target`, `sites` and optional `options`. It must wait for your confirmation and query `action="status"` with the returned ID in `transfer_id`. Query the same transfer; do not reissue `request_mirror` after a timeout. Neither tool nor popup exposes values to the model, logs, diagnostics or task files.

Background focus failure no longer prevents creating the confirmation panel. If focus cannot be verified, the extension sends a generic system notification using the `notifications` permission. Clicking it only focuses the valid panel; approval still needs your real click inside it. Notifications contain no website, task or Cookie data. If system settings suppress notifications, bring the source browser and its existing confirmation window to the front. The badge keeps the pending count. First-site reads, other operation approvals and manual-input panels use the same behavior. The separate access-mode management window also sends a reminder when unfocused.

The 60-second deadline starts at request time, including confirmation. Failure, expiry or either profile disconnecting destroys remaining memory payloads. Writes already dispatched may have changed the target; there is no automatic rollback or replay. Only the default non-incognito store is supported. Domain grouping uses a small suffix table, not a complete public suffix list; check the site selection. Cookie identities do not prove working login: localStorage, device binding, MFA or server invalidation can require another login. Copying all cookies for a site does not identify which one carries login. Ending a task does not remove imported cookies. See [security](../SECURITY.md#cookie-mirror-150).

## Uploads and downloads

- **Upload**: `files.upload` with `selector` and `paths` (local paths the user gave in conversation, `~` allowed; up to 10 files, 100 MiB each). Files are copied into a task-private area first and then selected into a unique, visible file input in the main document. The result means *selected*, not *received* — read the page to confirm the site accepted them. Submitting the form is a separate action.
- **Download**: downloads started from task pages are attributed to the task when that is unambiguous. `claim` verifies completion, size and digest and moves the file into a private directory, returning a `localPath`. Downloads that cannot be attributed (for example, a simultaneous user download from the same URL) are counted but never claimed automatically.

## Errors and recovery

Look at `code` and `outcome_unknown` in the result. **If `outcome_unknown` is true, never retry — read the page first.**

| Code | Meaning | What to do |
|---|---|---|
| `no_browser`, `instance_unavailable`, `extension_disconnected` | The extension is not connected | Enable the extension and check the Browser work page shows *Connected* |
| `browser_choice_required` | Several browsers are connected | Pick one with `instance_id` |
| `awaiting_authorization`, `pending_approval`, `invalid_state` | The task is not authorized yet | Approve in the extension, then `browser_shared_get` until `ready` |
| `approval_required` | This action needs your confirmation | Confirm, then repeat with the same `request_id` and arguments |
| `user_input_required`, `sensitive_target` | Sensitive field | Fill it yourself in the browser |
| `approval_denied`, `user_input_declined`, `approval_expired` | Not executed | Tell the user; only retry with a new `request_id` after they agree |
| `origin_denied` | Site not in the task's scope | `browser_shared_open` the new site |
| `foreign_tab`, `tab_required` | Wrong or missing tab | Use the task's `tab_id` or open a new work tab |
| `stale_reference`, `document_changed` | The page changed | Take a new snapshot |
| `page_not_ready` | The page is still loading | Wait a few seconds and read the **same** tab again; do not reopen the URL |
| `task_paused` | The user took over the page | Wait for them to hand it back, then re-read the page |
| `outcome_unknown`, `extension_timeout`, `request_outcome_unavailable` | The action may have happened | Read the page and decide; never replay |
| `needs_sync` | Authority was dropped (disconnect, restart) | Verify the page, then `browser_shared_resume` |
| `binding_missing`, `session_identity_required` | The session is not bound | `browser_shared_open` or `browser_shared_get` a ready task |
| `unsupported_operation` | Not available through the bridge | Use snapshots, screenshots or a script instead |
