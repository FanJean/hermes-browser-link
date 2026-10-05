# Protocol

The plugin, daemon, Native Messaging host and extension exchange JSON messages. This document describes the contracts each side relies on; the code in `native-bridge/` and `native-extension/` is authoritative for exact fields.

## Transport

- **Client ↔ daemon.** Newline-delimited JSON over the Unix-domain socket `$HERMES_HOME/plugin-data/browser-link-native/bridge.sock`. The first line is a handshake `{role: "client" | "extension", token, ...}`. Requests are `{id, method, params}`; responses are `{id, result}` or `{id, error: {code, message, data?}}`. No TCP listener exists.
- **Extension ↔ host.** Chromium Native Messaging (4-byte little-endian length + JSON). The host adds the local token and forwards to the socket. It accepts only the extension origins listed in its manifest.
- **Bounds.** Payload sizes, pending-request counts and timeouts are bounded. Page-action dispatch allows up to 30 s for capture/input round trips.

## Request identity and replay

Every `shared.run` carries a `requestId`. The daemon binds each ID to a hash of its payload and keeps up to 4096 bindings per task (IDs are stored hashed; results, page content and typed text are never persisted).

- The same ID with the same payload returns the recorded state (for example, still awaiting approval).
- The same ID with a different payload fails with `request_id_conflict`.
- An ID whose outcome was lost across a daemon restart fails with `request_outcome_unavailable` instead of running again.
- A response lost after dispatch becomes `outcome_unknown` and moves the task to `needs_sync`. Nothing is replayed automatically.

## Client API (plugin → daemon)

| Method | Purpose |
|---|---|
| `health` | Service check; returns `protocolVersion` |
| `browser.list` | Connected instances with `consentStatus` (`enabled` = full, `disabled` = smart, `unknown` = unreadable) and `accessRequestSupported` |
| `browser.access_request {instanceId}` | Ask the extension to open its browser mode window. It never changes the mode by itself. |
| `shared.create {owner, title, instanceId, allowedOrigins}` | New task; the extension prepares it in smart or full mode |
| `shared.list`, `shared.get`, `shared.cancel`, `shared.close`, `shared.resume` | Task lifecycle. `resume` increments the generation and needs fresh authorization. |
| `shared.run {owner, taskId, requestId, action, tabId?, ...}` | One page action (see [usage](usage.md#page-actions-browser_shared_run)) |
| `shared.operation_status` | Read the request ledger for a request ID |
| `shared.artifacts`, `shared.downloads`, `shared.download_claim` | Task files and downloads |
| `shared.cdp_gateway`, `shared.cdp_gateway_close` | Local CDP endpoint for `browser_exec`; full mode opens directly, smart mode consumes one approved script permit, then closes the gateway after the script |
| `shared.cleanup_status`, `shared.cleanup_retry` | Read-only verification and explicit retry of work-tab cleanup |
| `shared.handoff {owner, taskId, keepTabs?}` | Revoke task authority; preserve pages needing user input or explicitly handed over, then remove verified task groups. |
| `shared.activity {owner, taskId?}` | Trusted plugin activity cancels this owner's completion grace; a task ID narrows the idle activity update. It does not start a missing daemon. |
| `shared.session_end {owner}` | Trusted completed-turn signal; persists a daemon-managed deadline (default 600 seconds). Failed/interrupted hooks use handoff immediately. |
| `shared.sweep_close {owner, taskId, generation, lastActivityAt, idleSeconds}` | One-time script only: close a stale ready task after rechecking generation, activity and manual-control protection. |
| `shared.sweep_ungroup {owner, taskId, generation}` | One-time script only: recheck a terminal task's private creation journal and remove its group without granting tab-deletion authority. |
| `shared.diagnostics` | Read allowlisted diagnostic events (paged) |

Public task objects contain `id, title, instanceId, browser, state, generation, allowedOrigins, tabIds, createdAt, updatedAt, isolation: "shared-profile"` and never the raw owner.

`idleCloseAt` is a wall-clock deadline persisted in the daemon ledger. The daemon scans at startup and every 0.5 seconds, rechecking state, generation, deadline and activity under the state lock before release. Previously ready tasks become `needs_sync` on restart but retain their idle eligibility and original activity time. Previously paused/manual tasks remain protected until explicit resume. An automatic close recorded while the browser is offline revokes authority immediately and dispatches its previously unsent release once on reconnect. Unknown cleanup receipts never trigger automatic tab-deletion retries.

## Extension → daemon

| Method | Purpose |
|---|---|
| `extension.hello {instanceId, browser, version, capabilities}` | First message; binds the connection to an instance and returns a connection generation |
| `extension.tasks` | Tasks for this instance (no owners) |
| `extension.approve`, `extension.reject` | Decide a pending task. Approval can only narrow — never widen — the requested origins and must come from the extension UI. |
| `extension.mode` | Switch an authorized task between smart and full; switching clears per-site read approvals |
| `extension.approvals`, `extension.decide` | Pending per-action approvals and the user's decision |
| `extension.pause`, `extension.unpause`, `extension.stop` | Take-over and stop from the page overlay or popup |
| `extension.tab_event {taskId, tabId, event, documentGeneration, url?}` | Tab closed or navigated; invalidates references for that document |
| `extension.download_event`, `extension.cdp_events` | Download attribution and buffered CDP events |
| `extension.access_request_closed` | The authorization window opened for an access request was closed |

The daemon sends a `tasks.changed` notification whenever the pending or active task list changes; unknown notifications are ignored.

In smart mode, the first page read for a task and top-level origin creates a pending approval with `readOrigin`. The panel names the task and site and states that it permits reading page content; writes and debug commands remain per-action approvals. The extension reports only the current leased tab origin before displaying the request, and rechecks the origin before and after returning page content. A rejected site read does not dispatch. Navigation or new-tab approval may grant reading its target origin in the same decision. `tabs` returns only leased task tabs, so it does not expose the browser-wide tab list. Site read approvals are cleared on task end, mode change and generation change.

## Daemon → extension

| Method | Purpose |
|---|---|
| `browser.execute {taskId, generation, requestId, action, tabId, allowedOrigins, ...}` | Run one action. The daemon injects the current generation and exact origins after checking ownership and the lease. |
| `browser.assess` | Pre-check the target of `fill` / `press` / `ref_fill` for sensitivity before asking for approval |
| `browser.read_origin` | Read only the leased tab's current top-level origin before a smart-mode site read approval; no title, DOM or screenshot |
| `browser.release {taskId, generation, closeAgentTabs}` | Revoke a task; close only task-created tabs whose ownership is still proven |
| `browser.cleanup_status`, `browser.cleanup_retry` | Inspect or retry work-tab cleanup |
| `browser.credentials` | Cookies for one same-origin `api_request` URL after mode approval (never returned to the model) |
| `browser.vault_inspect`, `browser.vault_fill` | Private Vault fill, when enabled |
| `browser.download_cancel`, `browser.cdp_chunk` | Download cancellation; paging of large CDP results |
| `extension.consent_status`, `extension.access_request` | Fresh consent read; open the authorization window |

## Semantic references

A snapshot returns `binding = {taskId, documentId, leaseId}`, a `snapshotId` and per-element `ref`s. A write must supply exactly that binding, the latest snapshot ID and a ref. The extension never re-locates by label, index or selector; DOM mutation, a replaced document, a stale snapshot, a changed origin or generation all fail closed.

Snapshot `options`: `mode`, `root`, `query`, `roles`, `viewport`, `composed`, `accessibility`, `frameToken`, `budget`, `cursor`, `baselineId`. `composed: true` includes open/closed Shadow DOM and same-origin frames, including closed components inside those frames, with an ordered `targetPath`. Unreadable child frames are skipped and disclosed in coverage; their presence does not authorize reading or acting inside them. With content shielding enabled, `contentFilter.unreadFrames` and `coverage.contentShieldSkippedFrames` disclose protection-scan gaps, and `coverage.complete` is false. `frameToken` selects an approved cross-origin child frame; it binds task, tab, document, origin and session.

`items[].context` contains up to six meaningful ancestors within the selected root: `{ref, role, name, index?}`. `parentRef` identifies the nearest context container and is not an action reference. Container names use direct headings, explicit labels or bounded row/list text; action refs remain task/document/lease/snapshot-bound DOM identities. Official tool text renders this model as a compact tree with control states; Python callers keep the same structured items.

`accessibility:true` requests a bounded browser accessibility supplement. It requires an explicit CSS `root`, interactive mode and no cursor/baseline. At most 16 unnamed/inferred/already-supplemented controls are queried through `Accessibility.getPartialAXTree`; node backend IDs must match the DOM reference. Only allowlisted roles, names and boolean/mixed states are adopted, after redaction and privacy checks. Value-bearing controls and hidden/private label sources are excluded from AX requests. `coverage.axEnriched`, `axOmitted` and `axDiscoveryComplete` disclose the result; incomplete discovery or unprocessed candidates make `coverage.complete:false`. Temporary CDP objects and accessibility tracking are released. DOM mutations invalidate supplements, and reused virtual row indices invalidate old references.


`ref_click` uses trusted CDP pointer input on a visible resolved target only after an isolated-world listener confirms the target received a trusted click. Hidden task tabs stay writable and use a confirmed DOM-synthetic click with `fallbackReason`, without activating the tab. If visible CDP input reaches no page listener, one synthetic click is attempted; partial pointer delivery remains `outcomeUnknown` without replay. `clickMode: "pointer"` is an equivalent explicit mode. `clickMode: "open_link_in_task_tab"` opens an eligible `target=_blank` link in a new task-owned tab without running the page's click handler; ineligible targets return `CHILD_CREATION_UNSUPPORTED` rather than falling back.

`ref_select_option` uses the native select state API for HTML `select` elements: it validates every target by exact value, trimmed Unicode label, or zero-based index, sets `selected`, and dispatches bubbling `input` and `change` events. The result reports `kind: "native-select"` and final `selectedOptions`. Custom ARIA combobox/listbox controls use trusted pointer clicks when visible and confirmed DOM-synthetic clicks when hidden.

## Screenshot-bound interactions

`interaction.capture` returns a one-time screenshot ID plus the PNG. `interaction.bounds` maps a selector to a ref and its image-pixel centre. `interaction.click` and the drag actions take raw PNG-pixel coordinates plus the expected ref from the same capture. Coordinate clicks confirm delivery and use a confirmed DOM click in hidden tabs; pointer drags are rejected before dispatch in hidden tabs. A newer capture revokes the older one; a successful action consumes it; changes to document, viewport, DPR or scroll invalidate it. Before and after capture, pages with filled password/payment/OTP fields are refused — this is a conservative check, not general screenshot redaction.

## Read-only API requests

`api_request` uses the browser mode: smart requests approval, and full runs directly. It accepts a same-origin `GET` or `HEAD` URL and a list of top-level JSON fields to return. Cookies for that URL travel only over the private native channel, are held in memory for the single request, and are never returned. The HTTP client pins the resolved global IP, verifies TLS, ignores proxies, caps time and size, and redacts credential-like fields.

## Network evidence and capability discovery

`network.inspect` is an internal `shared.run` action with `{tabId, options}`. `options.operation` is `start`, `list`, `detail` or `stop`; smart mode requests approval and full mode runs directly. It requires the same task, tab lease and credential-page exclusion as raw CDP. The CDP gateway binds to the task’s existing generation and modeGeneration. Raw CDP events are not filtered by origin; credential headers and Bearer values are removed in both modes.

`Page.addScriptToEvaluateOnNewDocument` is available through raw CDP. In smart mode its approval explains that the script persists on later pages, including other sites. The extension records each returned identifier and removes registered scripts when the task ends or its mode changes.

The extension advertises `browser_core_v1`, `page_parse_v1`, `page_function_v1`, `network_evidence_v1` and `cookie_mirror_v1` in `extension.hello.capabilities.features`. The daemon publishes recognized values in `browser.list`. Missing features are not inferred from version strings. Generated API reference projection describes availability, never authority.

`page_request` composes `js.evaluate` with a fixed function and separately serialized parameters. It does not widen the existing local `api_request` protocol.

## Cookie mirror private channel (1.5.0)

Client method `browser.cookie_mirror` (trusted `owner` injected by plugin):

- `{action: "list_sites", source}` → `{sites: [{site, count, httpOnly?, session?}]}`. The 1.5.1 bridge preserves the extension's boolean flags; the model tool still projects only sites and counts.
- `{action: "request_mirror", source, target, sites, options?}` → `{transferId, status, sites, count, expiresAt}`. The 1.5.1 bridge exposes the existing deadline as Unix seconds for desktop expiry display; the deadline and deletion behavior are unchanged. `options` accepts `clearTarget` (default false) and `persistDays` (absent by default; integer 1–365). Source and target are distinct connected instance IDs with `cookie_mirror_v1` capability; separate profiles are separate instances.
- `{action: "status", transferId}` → owner-bound state and counts. States: `preparing`, `approval_required`, `executing`, `completed`, `denied`, `failed`. Poll the same transfer ID; do not repeat request_mirror. Status expires after 60 seconds.

Extension-only methods `extension.cookie_mirror.request`, `.status`, `.decide` bind source identity to the live connection. `.decide {transferId, approve}` is emitted only by the authenticated source approval panel. The source extension independently keeps a one-use UI approval flag; a daemon take request alone cannot bypass it. There is no client or desktop approval route.

Daemon-to-extension `browser.cookie_mirror.*` methods: `list_sites`, `prepare`, `take`, `begin`, `stage`, `finish`, `destroy`. `prepare` captures cookies locally and returns only site counts and chunk count. `take {transferId,index}` consumes one approved source chunk; `stage {transferId,index,cookies}` accepts one sequential target chunk. These private messages are handled before the generic request ledger, contain no payload fingerprints and retain no replay results. Serialized messages use UTF-8 bytes and reserve envelope space below the 256 KiB limit; the full transfer is bounded to 16 MiB / 128 chunks. Any transport failure destroys the remaining transfer on both ends. Values never cross client APIs.

Final per-site counts: `success`, `failed`, `matched`, `missing`, `cleared`, `clearFailed`; `reasons` counts only `expired`, `prefix_constraint`, `partition_write_failed`, `write_failed`. The target uses `cookies.set`, preserves host-only/domain, path, sameSite, Secure, httpOnly, expiration and partitionKey, and does not pass a source storeId. Secure cookies normally use an HTTPS URL; first-party HTTP loopback partitions keep their HTTP scheme with `secure:true` to preserve the partition scheme constraint. Readback checks name/domain/path/partition identities for every successful write without returning values. Expired cookies are skipped from inventory and recorded as expired if they expire while waiting. No atomic rollback or automatic retry is provided.
