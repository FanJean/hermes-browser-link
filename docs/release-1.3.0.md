# V1.3.0 developer preview

This release connects Hermes to an existing Chrome or Edge on macOS. It is intended for developers comfortable loading an unpacked browser extension. It does not install a browser, clone profiles or patch Hermes.

## Changes

- Read-only page parsing: regions, content blocks, table spans and explicit header relationships, form groups and validation messages, record extraction, field provenance and incomplete-coverage reporting.
- Script helpers: separately serialized JavaScript function arguments, bounded conditional waits, response/navigation observation and Markdown derived from parsed blocks.
- Compact interfaces: the popup shows connection, task and Take over/Stop; Desktop shows current tasks and expands results/details only when requested.
- Bounded script output and result caches. Result eviction preserves replay protection; cleanup is not blocked by the old 2048-response connection limit.
- Independent core tests, pinned development dependencies, GitHub Actions and checksummed release packages.

## Compatibility and verification

- Supported execution platform: macOS, with Chrome or Edge. Other operating systems are not release-supported; CI on Linux checks the core code only.
- Browser acceptance has been performed on Chrome 153 and Edge 153 using temporary profiles and isolated package installations.
- The full offline integration recipe pins Hermes to `e62a47ab680bf952b26559e540c28bc18571017c`. Compatibility with every later Hermes revision is not implied.
- Browser Use CLI 0.13.7 was used for official-tool acceptance. It is optional unless the official `browser_exec` adapter is used.
- Unit, synthetic integration, real-browser and installed-application checks are distinct. See [testing.md](testing.md) for reproducible commands.

## Limits

- Installation is manual. The installer refuses to overwrite an existing installation; there is no transactional in-place updater.
- Arbitrary JavaScript/CDP are privileged capabilities. Python runs with the user's permissions. Neither is a security sandbox; see [SECURITY.md](../SECURITY.md).
- A screenshot, successful input dispatch or HTTP response is not proof of business completion. Unknown writes are not replayed.
- Parsing covers the declared, observed DOM scope. Virtualized/unloaded content, unsupported frames and Canvas/OCR are not silently treated as complete.
- Local in-memory parse results are not a durable result store. Automated multi-page collection and saved checkpoints remain future work.
- Lint warnings remain; CI fails on errors. This preview is not a security certification.

## Install and report

Download the versioned installation ZIP and its checksum manifest from the release, or build from source. Follow [installation.md](installation.md), then verify both the extension version and the live connection. For updates, read the data-preserving manual procedure before removing any files.

Report reproducible bugs using the issue template. Never attach real cookies, credentials, account screenshots or personal files. Security reports use the private channel described in [SECURITY.md](../SECURITY.md).
