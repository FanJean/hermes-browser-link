# Parallel tabs and transport

Use a separate task for each origin and explicit `tab=` in multi-page Python helpers. `new_tab` selects its returned tab; `use_tab` changes the current page. Same-page actions are serialized. Cross-page work can overlap while task barriers coordinate navigation, takeover and permission changes.

The bridge uses bounded diagnostic fields for queue, settling, overlay, target, highlight, dispatch and result checks. A persistent dispatch journal records operations before execution. Recovery never restores authorization or silently replays unknown writes. Snapshot persistence is coalesced outside the global state lock; creation, revocation and cleanup flush before returning.

A subagent has its own trusted session identity. A parent's binding is not automatically shared with a child. Parallel official-tool calls in one session share that session's selected page; use script helpers with explicit `tab=` when branches need different pages. Model-controlled arguments cannot choose owner identities.

## Verification

Offline tests cover transport counts, per-tab concurrency, task barriers, frame discovery, recovery and diagnostics. These checks do not measure real-browser end-to-end latency. Use the same-machine baseline procedure in `bench.md` to compare performance.

Real-browser acceptance should cover foreground/background actions, iframe navigation, sensitive screenshot masking, multiple origins, takeover, disconnect, revocation and repeated request IDs. Use temporary profiles and synthetic pages. Never treat an unavailable browser run as passed.
