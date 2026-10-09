---
name: troubleshoot
description: What to do when the browser plugin returns an error or status code (not connected, not authorized, confirmation needed, sensitive field, unknown outcome, site not approved, page still loading). Read this when a browser action fails.
---

# When a browser action fails

Check `code` (or `bridgeCode`) and `outcome_unknown` in the result. If `outcome_unknown=true`, **never retry** — verify the page first.

| Status / error | Meaning | What to do |
|---|---|---|
| `no_browser`, `instance_unavailable`, `extension_disconnected` | The browser extension is not connected | Ask the user to enable the Hermes extension and check that the Hermes "Browser connections" (浏览器连接) page shows *Connected* (已连接), then try again |
| `task_paused` | The user has taken over the work tab | Wait for the user to click "Resume" (退出接管), check the task state, re-read the page; old refs are invalid |
| `browser_choice_required` | Several browsers are connected | Show the list to the user or pass `instance_id` |
| `awaiting_authorization`, `pending_approval`, `invalid_state` | The task is not authorized yet | Check browser connection authorization in the extension and wait for task preparation with `browser_shared_get` until `ready`; Desktop has no action-request or mode-switch button |
| `approval_required` | An independent special confirmation is pending | Tell the user; for requests other than `popup_adopt`, query with the same `request_id` and arguments according to the returned contract. Popup adoption follows the read-only flow below |
| `user_input_required`, `sensitive_target` | Password / payment / one-time-code field | The browser asked the user to fill it. Do not fill it or ask for the value. After the user clicks "I've filled it" (我已填写), query again with the same arguments to get `completed_by_user` |
| `approval_denied`, `user_input_declined` | The user refused | Not executed. Tell the user and ask whether to try another way; do not work around it |
| `approval_expired` | The confirmation timed out | Not executed. Only with the user's agreement, start again with a **new** `request_id` |
| `approval_consumed` | A legacy one-use execution permit was already consumed; this is not a selectable approval mode | Not executed. Start a new request with a new `request_id` if the user still wants another run |
| `origin_denied` | The site is outside the task's scope | Call `browser_shared_open(url=<new site>)` to create a task for it (authorized automatically when full access is on) |
| `foreign_tab`, `tab_required` | The tab is not this task's, or none was given | Use the returned `tab_id`; for a new page use `new_tab` or `browser_shared_open` |
| `stale_reference`, `document_changed` | The page changed | Take a new snapshot, then act |
| `reference_target_missing`, `reference_target_ambiguous` | Same-document relocation had zero or several matches | Take a new snapshot and narrow role, name or region; do not guess |
| `target_disabled`, `target_hidden`, `target_zero_size`, `target_out_of_viewport` | Control state or geometry prevents safe interaction | Expand, enable or scroll only when the page explicitly permits it; then read again |
| `page_not_ready` | The page is still loading or was just replaced | Wait a few seconds and read the **same tab** again; do not reopen the URL or open a new tab |
| `target_occluded`, `target_unstable`, `ambiguous_target`, `incomplete_target_scope` | The target is covered, moving, not unique or not fully read | Nothing was dispatched. Re-read and inspect the obstruction; choose any close action explicitly, then retry with a fresh reference |
| `outcome_unknown`, `extension_timeout`, `request_outcome_unavailable` | The action may have happened | Do not retry. Read the page once (snapshot, or `reconcile()` in a script) and decide |
| `needs_sync` | The task was frozen after a disconnect | Verify the page state, then `browser_shared_resume(task_id)`; the user may need to authorize again |
| `binding_missing`, `session_identity_required` | This session is not bound to a task | `browser_shared_open`, or `browser_shared_get` a ready task |
| `browser_access_required` | Task access is unavailable or the task ended | Check the task state and create a fresh task if needed |
| `credential_mode_conflict` | A credential was filled on this page, so script/CDP execution is blocked (or the reverse) | Use semantic actions on this page, or continue in a fresh page |
| `tab_out_of_scope` | The work tab left the approved sites and is frozen | Navigate it back to an approved site, or `browser_shared_open` the new site |
| `redirected_out_of_scope` | The page committed a redirect to another origin; nothing was dispatched there | Use `final_origin` with `browser_shared_open` to create a new task |
| `dialog_open` | A JavaScript dialog is blocking the page | Handle it with the `dialog` action (or `browser_dialog`), then continue |
| `unsupported_operation` | Not available through the shared browser (for example `browser_snapshot(full=true)`) | Use snapshots, screenshots or `browser_shared_script` instead |

## Popup adoption after approval

For `popup_adopt`, never resend the action for a cached receipt. Keep the original same-script catalog candidate. `wait_pending(tab=source)` is read-only: it queries the ledger/current scope and returns `state=confirmed`, not `adopted` or `tabId`.

For single tools, use `browser_shared_get` to check the original/current generation and `adoptedPopupTabIds`; select the known candidate with `browser_shared_use_tab`, then re-read the page. Scripts use `use_tab(candidate['tabId'])` and fresh `read_page`. Metadata is not access proof. Rejected, unknown, expired, revoked or changed-scope requests must not replay.

## "I approved, but nothing happened in the browser"

1. Ask the user to bring the browser window to the front and check that the extension is enabled.
2. On the Hermes Browser connections page, click "Enable access / Manage access" (开启访问 / 管理访问) again; the extension opens a centered authorization window.
3. If no window appears, ask the user to click the Hermes extension icon in the toolbar and act in its popup. The authorization state shown on the Browser connections page is the source of truth.

## Installation and new capability errors

Use `browser_shared_doctor` for a read-only installation/connection check. It never starts or repairs the service. Use `browser_shared_reference` to inspect the chosen connected instance.

- `draft_not_verified` / `draft_changed`: run a new real trial with a result assertion before activation.
- `draft_conflict`: define a fresh draft against the current active tool.
- `store_busy`: another operation owns the store; inspect its result before making another call.
- `network_capture_stale`: start a new capture; do not reuse old seq/cursors.
- `network_entry_unavailable`: the entry was evicted or never existed; list current requests.
- `outcome_unknown` / `result_truncated` / `invalid_result`: inspect business state; do not automatically replay the workflow.

- `operation_incomplete`: the Python process exited but an action still awaits approval or manual input. Continue the original request with `wait_pending`; do not activate the draft or issue the action again.
