# Features and limits

This catalog describes **1.7.1 macOS developer preview**. Local/offline checks, isolated browser checks, installed runtime checks and GitHub publication are distinct evidence states. Current acceptance commands and limits are in [testing](testing.md).

## Capabilities

| Area | What is supported | Limits |
|---|---|---|
| Connection | Existing Chrome/Edge instances over Native Messaging; several browsers at once | Does not start browsers or copy profiles. Task isolation is not cookie or account isolation. |
| Tasks and tabs | Per-task tab groups, exclusive tab leases, resume with a new generation, cleanup of task-created tabs only | Tabs you move out of the group or whose ownership is unclear are left alone. |
| Page reading | Semantic snapshots (content, tables, interactive), filtering by region/name/role, paging and incremental deltas | Smart mode confirms a task's first read of each site; later reads of that site run directly. Tabs list only that task's leased tabs. Not a full accessibility tree. Automatic shielding also applies to read results. |
| Targets | Open Shadow DOM, closed Shadow DOM in the main document, same-origin iframes, approved cross-origin (OOPIF) frames via `frame_catalog` tokens | Closed Shadow DOM inside same-origin iframes is not supported; rotated or skewed frames are rejected. |
| Actions | Confirmed reference clicks (trusted when visible, synthetic when hidden), fill, bounded key presses, checkboxes/radios/switches, native single/multi-select and ARIA single-select controls, scrolling (page or a specific container), back | Each action rechecks visibility, occlusion, stability and staleness before dispatch; nothing is retried after dispatch. |
| Screenshot-bound interactions | Capture, element bounds, coordinate click, pointer drag and HTML5-synthetic drag | Coordinates are raw PNG pixels from the same capture. Hidden coordinate clicks use confirmed DOM events; hidden pointer drags are rejected. Synthetic HTML5 drags report `isTrusted: false`. |
| Python scripts | `browser_shared_script` with page, file, download and page-execution helpers; request ledger, reconnect and explicit checkpoints | Each run is a new process running as your user — not an OS sandbox. A crashed script's Python state is not restored. |
| Page execution | Page JavaScript (isolated or main world), raw CDP, CDP event reads, `browser_exec` gateway | Smart mode asks for approval before execution; full mode runs directly. CDP events include other frame origins, while credential headers and Bearer values are removed. Credential fill and scripts cannot share a page. With shielding enabled, unsupported raw CDP/event, console, image-list and network-inspection outputs are refused. |
| Uploads | Local paths named in conversation, copied into task-private storage, selected into a visible file input in the main document | Up to 10 files, 100 MiB each. Hidden inputs and inputs inside frames are not supported. The OS file dialog is never driven. |
| Downloads | Attribution to the task, cancel, claim with size and digest verification | Ambiguous concurrent downloads are never claimed automatically. |
| Credentials | Optional takeover of Hermes' Vault tools: list, fill, TOTP entry, save login through a private local channel | Off by default. External password-manager CLIs must be installed and unlocked separately. Payment cards and addresses are not handled. |
| Official tools | 18 official Hermes browser tools and 28 `browser_exec` helpers, routed for bound sessions (see [usage](usage.md#hermes-official-browser-tools)) | Version-dependent; use the generated capability reference for the connected instance. `browser_snapshot(full=true)` is not supported. |
| Visibility | Whole-task input overlay, status, takeover/stop, action highlights and an always-enabled task cursor with smooth travel | Cursor remains between steps, hides on takeover/disconnection or hidden tabs, respects reduced motion, and is hidden/restored for capture. |
| Diagnostics | Correlated, field-allowlisted events and the latest task steps on the webpage overlay | Never records page text, credentials or free-form exception text. |

## Not supported

- A standalone browser, headless mode or profile cloning.
- Automatically claiming popups or windows opened by page scripts.
- Restoring an arbitrary Python process after it exits (resumption is cooperative, through explicit checkpoints).
- Cross-origin, mutating, or `Authorization`/CSRF-protected API calls through `api_request`.
- A built-in credential store, a third-party site-adapter catalog or a persistent result center.

## Current development additions

Verified custom site-tool drafts, bounded network evidence, same-origin page requests, read-only doctor and generated capability-aware API reference are described by module in the [product catalog](product-modules.zh-CN.md). These additions reuse the existing task and script execution chain. Development completion does not mean a personal installation or public release has been updated.

## Automatic text and screenshot shielding

Enable **自动屏蔽网页干扰** once in the browser popup. Built-in Chinese/English regexes group inline text by CSS block boundaries, detect automation notices and webpage instructions, and mask the matching text block and descendants. Parent summaries, associated names, plain script return values and screenshot annotations use the same inventory. No per-site origin or selector entry is required; the browser popup no longer exposes an extra-region form.

The webpage DOM and visible user page stay intact. Captured pixels use opaque masks, including the ordinary screenshot and interaction-capture paths. Real CAPTCHA, sign-in, access-denied and rate-limit signals remain. A detected site automation restriction is still reported as `siteAutomationRestricted`; filtering is not permission to automate that site.

Settings/readback failure, document or mask-geometry changes, and stale replay refuse unconfirmed content. Uninspectable frames, closed Shadow DOM and unsupported rendering are bounded refusals. Images/canvas/video are not OCR-scanned, and arbitrary JavaScript re-encoding is not a leakage-proof sandbox. See [complete boundaries](content-shield.md).

## Cookie mirror

Open **Hermes Desktop → 浏览器连接 → Cookie 镜像** to read/search the site inventory, select one or several sites, choose another connected browser/profile, and view transfer status and counts. The browser popup no longer displays Cookie mirror controls. The mirror dialog is centered on an opaque elevated surface with a scoped backdrop, fits narrow/short windows, and keeps native cancellation and focus behavior.

Each transfer requires a real click in the source extension confirmation panel, including full-access mode. Optional target-cookie clearing defaults off. Session cookies keep session lifetime unless persistence for 1–365 days is selected. Only the default non-incognito store is supported. Values travel once through bounded memory with a 60-second deadline including approval; disconnect/failure clears payloads. They do not enter task files, model responses or diagnostic logs.

Cookie copying does not copy localStorage, IndexedDB, device keys or MFA state, and readback identity matches do not prove login. Site grouping uses a small suffix table rather than a complete PSL. The public tool offers `list_sites`, `request_mirror`, and `status` with allowlisted metadata only. See [usage](usage.md#cookie-mirror) and [security](../SECURITY.md#cookie-mirror-150).

## Stable-release updates

After installing the maintenance component, use `./install.sh --check-update`, `--update`, or `--auto-update check|install|off`. Scheduled checks run hourly; automatic installation waits until Chrome, Edge and Hermes exit. GitHub asset digest, archive paths, complete package inventory, version and extension identity are checked before the existing backup/rollback transaction. Manual upgrade, update and uninstall share the installation lock.

Only stable releases qualify. GitHub pre-releases, including 1.7.1, are skipped; installing a preview uses its downloaded package and `--upgrade`. The updater does not close applications or approve browser access, and the updated extension still needs reloading. See [installation](installation.md#automatic-updates--自动更新).
