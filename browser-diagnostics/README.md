# browser-diagnostics

Structured, privacy-minimized diagnostics shared by the native bridge (Python) and the extension (JavaScript). Events carry only allowlisted fields and fixed error codes — never page text, credentials or free-form exception text.

## Deliverables

- `python/browser_diagnostics/`: private, bounded, concurrent-safe JSONL sink and best-effort action wrapper.
- `js/diagnostics.mjs`: dependency-free MV3 event validator, bounded in-memory buffer, export object, and best-effort async action wrapper.
- `schema-v1.json`: normative machine-readable event contract shared by both runtimes.
- `tests/`: Python `unittest` and Node `node:test` coverage.

## Event contract

Every stored or buffered event has exactly these keys. Additional keys are rejected (`additionalProperties: false`).

| Field | Contract |
|---|---|
| `schema_version` | Exact value `browser.diagnostics/v1` |
| `timestamp` | UTC RFC 3339 with milliseconds, e.g. `2026-09-22T00:00:00.000Z` |
| `component` | `native_bridge`, `mv3_background`, `mv3_content`, or `diagnostics` |
| `event_type` | `task_state`, `request_state`, `connection_state`, `action_state`, `buffer_state`, or `sink_state` |
| `task_id` | Opaque string or `null` |
| `request_id` | Opaque string or `null` |
| `connection_id` | Opaque string or `null` |
| `generation` | Opaque string or `null` |
| `status` | `pending`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`, `connected`, `disconnected`, `dropped`, `rotated`, or `recovered` |
| `duration_ms` | Finite number from 0 through 86,400,000, or `null` |
| `error_code` | `null`, one exact uppercase code listed below, or a lowercase protocol code matching `[a-z][a-z0-9_]{0,63}` in full |

Opaque identifiers must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`. They are correlation tokens only—not user text, URLs, paths, account names, or other descriptive values.

Allowed error codes:

Lowercase protocol codes include `target_occluded` and `execution_denied`. JSON Schema, JS and Python accept the same string grammar; non-string values, trailing newlines and payload text are rejected.

- `UNCLASSIFIED_ERROR`
- `TIMEOUT`
- `CANCELLED`
- `DISCONNECTED`
- `PROTOCOL_ERROR`
- `VALIDATION_ERROR`
- `PERMISSION_DENIED`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `INTERNAL_ERROR`
- `TRANSPORT_ERROR`

## Data minimization boundary

There is no general metadata/details field. The validators reject arbitrary nested objects and all non-contract fields, including:

- exception names, messages, stacks, or `repr` output;
- URLs, origins, paths, and URL query strings;
- cookies and cookie values;
- request/response headers;
- request/response bodies and form/input values;
- page text, HTML, accessibility trees, screenshots, or DOM content.

Do not transform these values into opaque IDs or error codes. Generate opaque correlation IDs independently and map failures to the fixed code list without incorporating exception text.

## Native bridge adapter contract (Python)

The bridge owns the log location and correlation IDs. A receiver must pass only a complete v1 event to `sink.write`; the sink validates it again before persistence.

```python
from browser_diagnostics import JsonlDiagnosticSink, observe_action

sink = JsonlDiagnosticSink(
    "/private/application-support/browser-diagnostics",
    max_bytes=1_048_576,
    max_files=5,
)

context = {
    "component": "native_bridge",
    "event_type": "action_state",
    "task_id": opaque_task_id,
    "request_id": opaque_request_id,
    "connection_id": opaque_connection_id,
    "generation": opaque_generation,
}

result = observe_action(
    lambda: dispatch_request_without_logging_payloads(),
    sink,
    context,
    classify_error=lambda exc: map_exception_type_to_fixed_code(exc),
)
```

`observe_action` logs `running` and a terminal state on a best-effort basis. A logging/validation/rotation failure is swallowed; the action's exact return object is preserved, and the action's exact exception is re-raised. The wrapper never records exception text.

### Sink guarantees

- Directory mode `0700`; lock, JSONL, rotated logs, and export ZIP mode `0600`.
- Refuses a symlink root, symlink immediate parent, symlink lock, or symlink module-owned log path.
- Uses an in-process lock plus `flock` for thread/process serialization.
- Uses append-only single-line JSON writes under the lock.
- Rotates before `max_bytes`; total active/rotated/recovery-owned data files are retained within `max_files`.
- If an active file is malformed, it is deleted rather than exported or retained, and a clean `sink_state/recovered` event is emitted.
- `cleanup()` removes only `events.jsonl`, `events.NNNNNN.jsonl`, and legacy `corrupt.NNNNNN.jsonl`; unrelated files are untouched. The module lock file remains for continued safe use.
- `export_bundle(output_dir, safe_name)` creates a new ZIP containing only revalidated `events.jsonl` and a fixed-field `manifest.json`. It never copies raw/corrupt files and refuses traversal, separators, CR/LF, symlinks, and overwrite.

The Python sink uses `fcntl.flock` and targets macOS/Linux native-host processes.

## MV3 adapter contract (JavaScript)

The module has no Node dependency and can be imported by a bundled or module-capable MV3 service worker.

```js
import {
  DiagnosticEventBuffer,
  observeAction,
} from "./browser-diagnostics/js/diagnostics.mjs";

const diagnostics = new DiagnosticEventBuffer({
  maxEvents: 200,
  maxBytes: 262_144,
});

const result = await observeAction(
  () => performBrowserActionWithoutPassingPageData(),
  diagnostics,
  {
    component: "mv3_background",
    event_type: "action_state",
    task_id: opaqueTaskId,
    request_id: opaqueRequestId,
    connection_id: opaqueConnectionId,
    generation: opaqueGeneration,
  },
  (error) => mapErrorTypeToFixedCode(error),
);
```

- The buffer evicts oldest events until both event-count and UTF-8 byte limits are met.
- `recordSafely` returns `false` instead of changing the caller's outcome.
- `snapshot()` and `exportBundle()` return copies, so callers cannot mutate buffered records.
- `observeAction` preserves unknown result identity and rethrows the original action error even when validation or buffer methods fail.
- An invalid error classifier result becomes `UNCLASSIFIED_ERROR`; exception text is never serialized.

### Browser-to-native handoff

The extension may send one `snapshot()` event at a time over the existing approved connection, or serialize `exportBundle()` for an explicit diagnostics export flow. The native side must call `JsonlDiagnosticSink.write(event)` and must not trust the browser-side validation alone. Diagnostics messages must use the same task/request/connection/generation already assigned by the action path; diagnostics must not create authority, approvals, replay entries, or retries.

Do not send the buffer automatically with ordinary action results. Export must be an explicit diagnostic operation so action responses remain unchanged and do not accidentally become a log transport.

## Test commands

```bash
cd browser-diagnostics
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/diagnostics.test.mjs
python3 -m compileall -q python tests
node --check js/diagnostics.mjs
```
