# browser-workspaces

Task tab groups for the extension: creates work tabs in the background, tracks which tabs a task owns, recovers after a service-worker restart, and cleans up only what it can prove it created.

## Usage

```js
import {createAuthority, createWorkspaces} from './index.mjs';

// Only trusted extension bootstrap code holds the authority; never expose issue() to models or pages.
const authority = createAuthority(trustedBrowserInstance);
const workspaces = createWorkspaces({chrome, authority}); // one per service worker
await workspaces.reconcile();

const capability = authority.issue({owner, task, generation, windowId});
const {tabId, groupId} = await workspaces.open(capability, {requestId, url});
await workspaces.cleanup(capability, {closeTabs: true});
```

- A task is identified by instance + owner + task + generation. Capabilities are unforgeable (WeakMap-branded); issuing a newer generation stops the old capability from creating tabs, though it can still clean up its own.
- Each task gets one group, created lazily; tabs are created with `active: false`. There is no API to focus windows, activate tabs, or group/close arbitrary tab IDs.
- Only tabs returned by this module's own `tabs.create` are managed. Your tabs — even if you drag them into the group — are never grouped or closed.
- `open` is idempotent per identity and `requestId`. Mutations are serialized per task identity; distinct tasks can open pages concurrently. Local journal writes remain serialized; cancellation fences new creation synchronously.

## Cleanup

`cleanup(capability, {closeTabs = true, keepTabIds = [], tabIds, timeoutMs = 2000})`

- `closeTabs: true` (completion, cancellation) closes only journaled tabs the task still owns. `closeTabs: false` (disconnect, failure) keeps tabs and records for later recovery.
- `keepTabIds` excludes tabs from deletion; `tabIds` restricts deletion to an exact allowlist snapshot. Neither grants ownership.
- The budget is capped at 2 s and ends with `WORKSPACE_CLEANUP_TIMEOUT` instead of claiming success. Errors keep the remaining recoverable state.

## Recovery and conservative limits

- The journal lives in `chrome.storage.local` and survives extension reload/update. It contains scoped identities, request IDs, requested URLs for idempotency, sanitized group titles, tab/window/group IDs, baselines and states; it does not store page content. Old session-only journals are not upgraded into deletion authority.
- The worker registers `runtime.onStartup` synchronously at module load. On browser startup it immediately invalidates in-memory baselines and serializes invalidation of the local journal. `ready` waits for this barrier and checks the startup epoch again after reading, so an old in-flight read cannot restore deletion authority. Old IDs remain diagnostic records only. After extension reload, deletion requires the original baseline plus matching tab/group/window IDs and recorded group title. Moved or renamed resources are preserved.
- A creation whose response was lost is marked `unknown`: never retried, claimed or closed automatically.
- Child tabs opened by page scripts cannot be attributed reliably (`openerTabId` cannot tell an agent click from a simultaneous user action); they are journaled as `unknown` and left for the user.
- Terminal (`closed`/`cancelled`) tasks with unknown cleanup or intentionally retained pages use daemon-recorded `workTabs` to ungroup only matching tab/group/window IDs and the sanitized task title. This never closes pages and reports `unknown` / `ungrouped_unverified`, never `verified_complete`. `needs_sync` retains the group for `priorGroup` recovery.
- Release remains bounded while tab actions hold locks. One deferred cleanup runs after those locks settle, with the same journal and lease checks. The daemon retries non-destructive ungrouping after hello for the 100 most recently updated eligible terminal tasks; results are bound to the current connection and generation.
- Chrome's get → group/remove/ungroup is not atomic; a user moving a tab at the exact moment of cleanup is a known race. Browser startup invalidation relies on Chrome delivering `runtime.onStartup`; full identity checks also fail closed on mismatches. A missed event plus reuse of every recorded ID and title remains a platform limitation.
- Groups separate task resources, not cookies, storage or accounts.

## Tests

```sh
node --test browser-workspaces/workspaces.test.mjs
node browser-workspaces/real-browser-acceptance.mjs   # real Chrome and Edge, temporary profiles
```
