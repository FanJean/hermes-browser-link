# native-bridge

Python standard-library daemon and Chromium Native Messaging host. Wire contracts are described in [docs/protocol.md](../docs/protocol.md).

## Files

| File | Role |
|---|---|
| `daemon.py` | Per-profile service on a Unix-domain socket: tasks, `(instanceId, tabId)` leases, request ledger, approvals routing, persistence |
| `host.py` | Native Messaging host: 4-byte little-endian framing ↔ JSONL socket |
| `client.py` | Synchronous client used by the plugin: `ensure_service(home)` and `BridgeClient(home).call(method, params)` |
| `api_client.py` | Pinned, bounded HTTPS client for approved read-only `api_request` calls |
| `artifacts.py`, `downloads.py` | Task-private upload staging and download attribution / claiming |
| `cdp_gateway.py` | Local CDP endpoint for the `browser_exec` override under task browser access |
| `vault_private.py`, `vault_client.py` | Private channel for the optional Vault fill integration |
| `install.py` | Stages the host launcher and Chrome/Edge manifests into an **isolated** home for tests (refuses the active user's home) |

Runtime data lives in `$HERMES_HOME/plugin-data/browser-link-native/` (mode `0700`); `bridge.sock`, `token`, `daemon.pid` and `tasks.json` are `0600`. The token never appears in a Native Messaging manifest.

## Behavior worth knowing

- Native host uses cancellable unbuffered pipe I/O and joins both forwarding threads before closing its socket reader. Bridge EOF, partial frames and a browser that stops draining output do not leave a buffered daemon thread alive at interpreter shutdown.
- `extension.tasks` with `{includeClosed: true}` is the trusted extension's overlay cleanup inventory. Each row contains only `id`, `instanceId`, `generation`, `state` and `tabIds`; operation history remains persisted and ordinary task reads retain their existing details. This keeps reconnect cleanup below the transport limit for large histories.
- A lost response after dispatch returns `outcome_unknown`; the client never replays.
- Approval authority is never restored after a daemon or connection restart. Non-terminal tasks become `needs_sync` and need `shared.resume` plus fresh approval.
- Each task keeps at most 4096 hashed request-ID/payload bindings. A retained ID whose outcome is unknown after a restart fails with `request_outcome_unavailable`.
- Extension timeouts, disconnects and invalid `new_tab` outcomes revoke the task's leases and start a bounded best-effort release.
- An existing socket at the path is never unlinked automatically; after an unclean crash, remove a verified-stale `bridge.sock` by hand.

## Tests

```sh
python3 -m unittest discover -s native-bridge/tests -v
```

The suite uses real Unix sockets and subprocess Native Messaging framing under a temporary Hermes home, and terminates every daemon it starts.
