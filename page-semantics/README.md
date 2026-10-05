# page-semantics

Page Semantics v2: bounded semantic snapshots of a live page, with element references, paging and incremental deltas. `index.js` exports **`createPageSemantics`**. No runtime dependencies and no cookie or profile access. It reduces **page output**, not cookies. The host must explicitly import/inject this module and keep the instance in its trusted isolated execution world.

## Calling contract

```js
import { createPageSemantics } from './page-semantics/index.js';

const semantics = createPageSemantics({
  document,
  taskId: trustedTaskId,
  documentId: trustedDocumentId,
  leaseId: trustedLeaseId,
  expiresAt: trustedLeaseExpiry, // epoch milliseconds; default Infinity
  maxScan: 20000,               // element scan ceiling
  maxItems: 200,                // retained page / baseline ceiling
  maxText: 400                  // characters per fragment (interactive names still clip)
});

const options = {
  mode: 'interactive', // 'interactive' | 'content' | 'table'
  root: '#checkout',   // connected Element or CSS selector; default document.body
  query: 'Confirm',    // case-insensitive substring of REDACTED name (interactive clipped)
  roles: ['button'],  // OR within roles, AND with other filters
  viewport: true,     // bounding-box viewport intersection; default false
  composed: false,    // opt in to open Shadow DOM + accessible same-origin frames
  budget: 1200       // minimum 512; estimated units, NOT exact model tokens
};
const page = semantics.snapshot(options);

// After host approval, immediately before a DOM action:
const node = semantics.resolve({
  ...page.binding,
  snapshotId: page.snapshotId,
  ref: page.items[0].ref
});
// Host action implementation uses this exact node; never re-query by name/index.
// node.click() is NOT performed by this library.

const next = page.nextCursor
  ? semantics.snapshot({ ...options, cursor: page.nextCursor })
  : null;

semantics.revoke(); // at task end, lease cancellation, navigation or host teardown
```

**Trust boundary:** binding strings are opaque non-secret identifiers from the host, not authority created by a model. This module validates equality/lifecycle but cannot authenticate a lease or approve an action. Keep existing approval, origin, frame, tab and session checks. Do not publish `resolve` in page-controlled main-world globals. `resolve` returns an Element, which must not be serialized into model output or retained for delayed use. Re-resolve immediately at execution time.

## Identity and rejection

- WeakMap associates actual Node identities with a random instance namespace + monotonically increasing **BigInt** sequence. Ref numbers never reset/recycle within an instance, including when nodes disappear or pages change. Recreated modules have independent random namespaces.
- Same-name buttons remain distinct. DOM replacement does not inherit the removed node's ref. Legacy bare `@e1` aliases are not accepted.
- Action resolution retains the materialized references from at most five snapshots. Evicted snapshot IDs, foreign refs, omitted refs and mismatched task/document/lease IDs fail closed.
- Resolution rechecks mutations, visibility and the current semantic item. A unique replacement may relocate only within the original document and Shadow tree. Removed, replaced or reparented frame/Shadow boundaries invalidate the reference; another same-origin document cannot supply a replacement. Changed checkbox state is rechecked even when only a JS property changed.
- Replaced `documentElement` requires a new instance; `revoke()` clears retained state and disconnects the observer. Finite `expiresAt` is enforced; NaN/non-number expiry is rejected.
- With `composed:true`, refs may resolve to nodes in an open shadow root or a reachable same-origin frame document. Shadow/frame mutations, frame navigation and replacement invalidate existing refs/cursors; a newly materialized page is required. The host must still authorize the **actual target frame/origin** before acting—this module's equality checks are not an approval.
- This is conservative: unrelated DOM mutations can require a fresh snapshot. It is not a lock against future page changes between resolution and an asynchronous action.

Errors are ordinary `Error` objects with stable messages: `BINDING_REQUIRED`, `INVALID_EXPIRY`, `INVALID_LIMIT`, `INVALID_OPTIONS`, `INVALID_ROOT`, `BUDGET_TOO_SMALL`, `LEASE_REVOKED`, `LEASE_EXPIRED`, `DOCUMENT_REPLACED`, `DOM_CHANGED`, `BINDING_MISMATCH`, `STALE_SNAPSHOT`, `STALE_REF`, `NODE_CHANGED`. Invalid CSS selectors may also raise the browser's native selector exception.

## Output

```js
{
  version: 2,
  binding: { taskId, documentId, leaseId },
  snapshotId,
  kind: 'full',
  mode: 'interactive',
  items: [{ ref, role, name, /* optional checked, disabled, truncated */ }],
  nextCursor: null, // or opaque cursor
  resync: null,    // or { reason }
  coverage: {
    scanned, matched, returned, omitted, filtered, truncated, offset,
    complete, traversalComplete,
    scope: 'light-dom; no iframe/shadow traversal' // changes for composed:true
  },
  budget: {
    kind: 'estimated',
    method: 'ceil(JSON.stringify(response).length/4)',
    limit
  }
}
```

- `interactive`: native controls, links, contenteditable, tabindex elements and supported interactive ARIA roles; no name-based deduplication.
- `content`: headings, paragraphs, list items, blockquotes, preformatted text and figure captions. Not a full accessibility tree or arbitrary-div article extractor.
- `table`: native/ARIA rows, with `cells` for direct cells/headers, maximum 40 cells per row. `omittedCells` and `truncated` disclose row truncation. Spans/grouped headers are not normalized into a spreadsheet grid.
- Names prefer aria-label, aria-labelledby and associated labels, then eligible descendant text. Input/select/textarea values, arbitrary attributes, scripts, hidden and `data-private` text are not serialized. Email, labeled secret/token/password/API-key values, Bearer strings and long number sequences are redacted before output budget fitting. This is a conservative heuristic, **not general-purpose PII/DLP protection**; unlabelled secrets can require a host policy.
- Nonprinting C0/C1 control characters (except tab/newline/carriage return, which normalize to spaces) are removed **before** redaction; Unicode replacement characters, combining marks, ZWJ emoji and multilingual text are not generically stripped. Interactive clipping avoids emitting half of a surrogate pair; clipped content is still unrecoverable and marked `truncated`.
- `composed:true` traverses light DOM, open shadow roots, and reachable same-origin frame bodies under the chosen root, including nested combinations. `coverage.scope` names this narrower reachability; `coverage.skippedFrames` counts inaccessible/unready frames and forces `complete:false`. Closed shadow roots, cross-origin frames, browser UI, and CSS pseudo-element text are out of scope. The main document's `root` selector still selects in the main document, not inside a shadow/frame. Shadow `aria-labelledby` IDs resolve within their own tree root. Hidden/private hosts, frame elements, and CSS-hidden ancestors suppress nested content. Same-name controls keep unique node refs (not a generated selector/path); `resolve` returns the actual node, including in a frame.
- `matched` counts matches in the **scanned prefix**, not an asserted whole-document total when `traversalComplete=false`.
- `returned` is the current materialized **entry/fragment** count, even for deltas; several entries can share one ref. `omitted = matched - distinct returned refs` counts unrepresented matched **nodes** (including earlier pages); it never goes negative. `filtered` counts semantic candidates rejected by visibility/query/roles. `truncated` counts matched nodes with irreversibly shortened fields, **not** ordinary recoverable fragments.
- `complete` only means all matches in the declared semantic scope were returned without irreversible text truncation and traversal was exhaustive (and no inaccessible frames were encountered in composed mode). It does **not** imply the complete rendered/accessibility page, especially where closed shadow roots exist. A single page can be complete with multiple fragments of the same node; conversely the last page can have no cursor but still be incomplete due to earlier pages, scan caps, text caps, or an entry too large for budget. Aggregate pages to reconstruct; never treat `complete:false` alone as proof that another cursor exists.
- Budget checks the **entire serialized response**, including metadata, refs, coverage and delta lists. It is an explicit UTF-16-character-based estimate; it can underestimate actual multilingual/model tokens. No tokenizer or token-cost claim is made.

## Incremental contract

```js
const first = semantics.snapshot(options);
const delta = semantics.snapshot({ ...options, baselineId: first.snapshotId });
```

Only the latest baseline is retained. Matching parameters are canonicalized mode, actual root-node identity, sanitized query, sorted/deduplicated roles, viewport flag + viewport/scroll geometry, budget, composed flag and page offset. Equivalent role ordering is allowed; changing any effective parameter forces full resync. Requesting a stale/foreign/evicted baseline also resyncs.

A successful delta has `kind:'delta'`, `baselineId`, `items` (added/changed entries), `removed` (entry identities), and `order` (the complete current page entry order). For an unfragmented item, its identity is its `ref`. For a fragment it is `JSON.stringify([ref, fragment.field, fragment.index ?? null, fragment.start])`. Apply removals and item upserts by this identity to the previous materialized map, then rebuild from `order`. **Do not deduplicate by `ref`**: that would discard all but one fragment. `ref` remains the stable **node/action** identity; it is not a fragment identifier. Adopt the **new** snapshot ID for all retained refs, including unchanged entries. Do not treat empty `items` as an empty page.

`kind:'full'` with `resync.reason` replaces the client's baseline. Reasons: `baseline_unavailable`, `parameters_changed`, `cursor_invalidated`, `delta_budget`. Budget overflow falls back to a bounded full response rather than dropping delta operations and silently corrupting the baseline. Cache copies cannot be mutated through returned arrays.

## Paging and memory

In `content`/`table` mode, a long item's redacted `name` and each redacted `cells[index]` value split into bounded entries. Each entry has its original `ref`, `role`, `fragment: { field: 'name' | 'cells', index?: number, start, end, total, part }`, and the payload in `name` (for `field:'name'`) or `cellText` (for `field:'cells'`). `start`/`end` are UTF-16 offsets into the **redacted field**; `total` is that field's redacted length; `part` is its ordinal within this node's full name-plus-cells sequence. Reconstruct separately by `(ref, field, index)` and ascending `start`, concatenate each payload, check contiguous offsets from `0` to `total`, and require all pages through `nextCursor:null`. Do not concatenate all fields into one string or deduplicate by ref. If any page resyncs, discard earlier fragments and start over. Interactive items remain clipped and do not use fragments.

One active ref map, one materialized baseline (both at most `maxItems` **entries**, though the ref map can have fewer distinct nodes) and one cursor are retained; no full result-list/page-history cache. WeakMap does not keep removed DOM nodes alive. `stats()` reports actual retained map/baseline/cursor counts. The caller must also bound its own accumulated page cache.

Every page rescans the live scoped DOM, discards earlier matches and retains only a bounded candidate page, **packing multiple fragments per response** until `maxItems` or the whole-response budget is reached. A continuation resumes after the last **actually emitted** fragment; a too-small budget never loops on a nonadvancing cursor. This trades CPU for bounded retained memory; the same DOM text may be reread on subsequent pages. Only the latest cursor is valid. A DOM mutation, parameter/viewport change or evicted cursor returns a full first page with `cursor_invalidated`; callers must replace, not append, that page. Scan limits may require a narrower root/query. An entry larger than the entire budget can yield an empty, explicitly incomplete page with no cursor; increase budget or narrow fields/scope rather than loop forever.

Full text reads are capped at **16,384 UTF-16 units per matched node** across its name and up to 40 cells, with at most `maxScan` text nodes per field read. DOM text-node reads request only bounded prefixes rather than materializing unbounded `textContent` strings in JS; aria-label and aria-labelledby reads are bounded too. If a cap cuts through a token, the unfinished token is dropped before redaction, preventing a secret tail at the cap from being serialized. Redaction occurs **before fragment splitting**. The remainder is **not recoverable by further cursors**: the item has `truncated:true`, `coverage.truncated` counts it, and `coverage.complete` stays false. This is a work/JS-string bound, not a promise that arbitrary secret patterns are recognized or that a hostile DOM cannot consume browser memory.

Limits are clamped to maxScan 100000, maxItems 1000 and maxText 2000. This is not browser-heap measurement: DOM itself, weak ref identity entries for live nodes and transient DOM reads exist outside the retained pagination cache. DOM epochs do not detect every possible rendering-only/CSSOM change; avoid treating multi-page output as an atomic database transaction.

## Control states

Interactive snapshots fall back to a redacted placeholder when a control has no label or text, and mark `nameSource`. They report disabled fieldsets, ARIA checked/mixed, expanded, selected, busy, readonly and required states without reading input values. These states help locate targets; they do not replace the executor's final actionability checks.

Icon controls can use visible image `alt`, SVG `title`, or a control's `title` after explicit labels and text, marked as `nameSource: 'descendant'` or `'title'`. Hidden/private icons remain excluded. `display:contents` containers do not suppress visible text or shadow descendants. Table rows accept cell wrappers, while nested rows/tables keep separate cell ownership. The parser shares those cell rules, supports ARIA treegrids, and follows `aria-controls`/`aria-owns` to associate portal options within the selected parse root; an external option list produces `options_outside_scope` instead of widening the root.

## Tests

```sh
node --test page-semantics/long-text.test.mjs page-semantics/controls.test.mjs tests/v1.1-semantics/enhancement.test.mjs
node page-semantics/test.mjs   # real headless Chrome with a temporary profile; set CHROME_PATH to use Edge
```

The real-browser runner loads the unmodified module in a fresh temporary profile, runs synthetic fixtures and removes the profile on exit. Size savings it reports compare noisy synthetic HTML with a budgeted semantic response; they are not token measurements.


## Structured interaction context

Interactive items include bounded `context` entries for meaningful region/record/group ancestors inside the selected root, plus `parentRef`. Context refs describe containers, not actions. The host's compact text renderer derives its tree and states from these same items. Context uses direct headings and sanitized labels; same-name controls retain independent action refs. Slotted labels use assigned nodes, and slot hiding/privacy also applies to projected light DOM. Inline text is assembled before redaction and fragmentation; native option names check private/hidden optgroup ancestors without reading option values. Virtual row/list position attributes participate in relocation identity, so reusing a DOM button for another declared row invalidates its prior reference.

The host may explicitly supplement up to 16 scoped interactive DOM refs with browser AX names, allowlisted roles and states. The pure module does not call CDP. `accessibilityNode` and `applyAccessibility` are trusted-host helpers and must not be exposed to page scripts. Hidden/private label sources and value-bearing controls are excluded; adopted strings are redacted. Supplements expire on DOM epoch or control-state changes. Existing final DOM reference, scope and actionability checks remain necessary.
