# Security policy

Hermes Browser Link lets an AI agent act inside a browser where you are logged in, so security reports are taken seriously.

## Reporting a vulnerability

For the public repository, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/FanJean/hermes-browser-link/security/advisories/new). Do not open a public issue. The maintainer must enable private vulnerability reporting before publication. If the form is unavailable, wait until the reporting channel is enabled; do not publish vulnerability details or secrets in an issue.

Include the version or commit, your OS and browser versions, a minimal reproduction and, if helpful, the relevant task-log entries. Never include real cookies, passwords, page captures of real accounts or personal paths.

Reports are reviewed privately; reporters can request credit or anonymity.

## Supported versions

Only the latest release receives security fixes.

## Security model

What the bridge is designed to guarantee:

- Only the trusted Hermes host supplies session identity; every action is bound to browser instance, task, tab lease, allowed origins and generation.
- Browser connection authorization (full access only) is confirmed only in the extension's own UI. Ordinary reads, navigation, writes, JavaScript, CDP and Python workflows then run without per-action approval. Task grants and leases are invalidated by disconnect/restart; a retained connection preference does not restore old task authority or prove an offline browser authorized. There is no user-selectable smart-approval mode. Internal low-level compatibility states remain fail-closed before authorization.
- Takeover/pause, stop, task identity, tab leases, origin scope, generations, credential-page script exclusion and content shielding remain independent protections. Cookie mirror and adopting an existing OAuth login window still need explicit special confirmation.
- A write whose outcome is unknown is never replayed automatically.
- Standard semantic/form helpers reject sensitive-field writes and hand entry to the user or optional private Vault channel. This is an interface restriction, not a guarantee that privileged JavaScript or Python cannot access sensitive data.
- Page content is treated as untrusted data, never as instructions or authorization.
- Diagnostics record only allowlisted fields — no page text, credentials or free-form exception text.

What it does **not** protect against:

- Tasks share the browser profile's cookies and logins; task separation is not account isolation.
- Under browser-level full access, the agent can run arbitrary JavaScript and CDP in task pages. Results are not comprehensively redacted. Network evidence strips credential headers (including Cookie and Authorization values), but page content and general script output may still contain private data.
- `browser_shared_script` runs Python with your user's permissions. Its environment scrubbing is not an OS sandbox; only run scripts produced for your own tasks.
- Screenshots mask visible sensitive inputs and frames that cannot be inspected, and reject unsafe sensitive captures. This does not remove every sensitive piece of ordinary page text.
- Local processes running as your user that can read the daemon's token file are trusted.
- `SHA256SUMS.json` proves package integrity, not publisher identity. Install packages only from sources you trust.

## Cookie mirror (1.5.0)

The extension adds `cookies` and `host_permissions: ["<all_urls>"]` to use `chrome.cookies` for default-store inventories and login-state copying, including httpOnly, Secure and partitioned cookies. The manifest key and extension ID remain unchanged. Inventories reveal site names and counts; they cannot identify which cookies represent a working login. Site grouping uses a small suffix table rather than a complete public suffix list; verify the sites and counts before confirming.

Every mirror needs a fresh, trusted click in the **source extension's own confirmation panel**, including in full-access mode. It names both browser instances, sites, counts and options. Neither Hermes nor a web page can approve. Desktop and `browser_shared_cookie_mirror` use the same private backend.

Values travel source extension → local daemon → target extension. Snapshots and transfers are held only in memory for at most 60 seconds from request time, including confirmation, in serialized chunks of at most 256 KiB. Chunks are consumed once. Failure, expiry, connection replacement or disconnect destroys the remaining transfer. No values or value-derived fingerprints enter request ledgers, task files, logs, diagnostics, desktop API or model results. Errors use fixed categories; public results contain only identifiers, sites and counts. A transfer interrupted during writing may have already changed target cookies; it is never replayed or rolled back automatically.

This protects the tool interfaces, not against a local process running as the same OS user that can read the daemon token. The target browser receives the **complete selected cookie login state** and can use those accounts. Revoking a task or deleting a transfer does not remove already imported cookies. Cookie identities present after readback prove import coverage; they do not prove that a server accepts the copied session. Local storage, device-bound sessions, MFA and server invalidation can require another login. Incognito stores and arbitrary cookie stores are excluded.

## Background confirmation notifications (1.5.1)

The `notifications` permission displays generic system reminders when focus cannot be verified. It does not add website access, change task scope or authorize a decision. Notifications contain only the extension name and request category, without site names, task titles, browser identities or Cookie values. Clicking a reminder only focuses the currently bound, unexpired extension window. Approve/reject still require `event.isTrusted` inside the extension panel, its exact extension origin/tab/window sender, and live request scope verification. [Chrome notifications API](https://developer.chrome.com/docs/extensions/reference/api/notifications).

This applies to Cookie mirror, existing OAuth-window adoption and manual-input panels that use the approval notifier. Manual-input instructions still require typing into the website and then confirming in the panel. Ordinary reads, writes and JavaScript/debugging no longer request per-action approval. Connection authorization remains in the extension; notification clicks never grant it. An unverified focus state keeps the window open instead of discarding it. Existing source/tab validation, expiry, unknown-result handling and no-replay rules remain in force.

Notifications can be denied by browser or operating-system settings. The panel and pending badge remain available; switch to the source browser or explicitly open the pending panel. Reminders are cleared when the panel closes, settles or expires during reconciliation. Neither notification delivery nor focusing a window proves user approval.

## Extension identity and installation packages

The extension ID is `dhioigkigkkhceflkkkmoljhdaefjohb`. The manifest `key` is a public key used to keep that ID stable, not a secret. The installer checks the derived identity and the exact Native Messaging origin allowlist; upgrade preserves both checks. `SHA256SUMS.json` verifies file integrity, not publisher identity. These checks run inside the installer and do not require users to compare IDs during installation.
