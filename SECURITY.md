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
- Authorization is granted only in the extension's own UI. Task grants and leases are invalidated by disconnect/restart; the browser-level full-access preference remains enabled until the user turns it off, and can authorize new tasks.
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
