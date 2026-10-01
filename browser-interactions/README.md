# browser-interactions

Screenshot-bound coordinate actions for Chromium: capture, element bounds, coordinate click and drag, with node-identity, hit-test, occlusion and sensitivity checks. There is no vision model, OCR or image-based targeting — a caller may propose pixel coordinates, but only together with a DOM `ref` issued by this module for the same screenshot.

The runtime is the single file `index.mjs` with no dependencies; it runs in Node ESM and in an MV3 service worker. The extension uses it through `createChromeDebuggerAdapter`.

## Usage

```js
import {Interactions, createChromeDebuggerAdapter} from './index.mjs';

await chrome.debugger.attach({tabId}, '1.3');           // the host attaches after authorization
const adapter = createChromeDebuggerAdapter(chrome.debugger, {tabId});
const binding = {taskId: 'task-123', generation: 4};
const interactions = new Interactions(adapter, {...binding, ttlMs: 5000});

const shot = await interactions.capture(binding);
const scope = {...binding, screenshotId: shot.id};
const source = await interactions.bounds({...scope, selector: '#source'});
const target = await interactions.bounds({...scope, selector: '#target'});
await interactions.dragCoordinates({
  ...scope,
  from: {point: source.imageCenter, expectedRef: source.ref},
  to: {point: target.imageCenter, expectedRef: target.ref},
  mode: 'pointer', steps: 12,
});
```

`createPlaywrightAdapter(page)` and the low-level `createCDPAdapter(send)` exist for tests and trusted hosts. Never expose an adapter or `send` to pages or models.

## API

| Method | Notes |
|---|---|
| `capture(scope)` | Current viewport PNG plus `id`, document token, revision, viewport, DPR, scroll and expiry. A new capture revokes the previous one. Fails with `CAPTURE_CHANGED` if the page changed during capture. |
| `bounds({...scope, screenshotId, selector})` | Unique main-document match → `{ref, rect, imageCenter}`. `rect` is viewport CSS px; `imageCenter` is raw PNG pixels. |
| `clickCoordinates({...scope, screenshotId, point, expectedRef})` | Mouse move/down/up after identity, hit, occlusion and sensitivity checks. Consumes the screenshot. |
| `dragCoordinates({...scope, screenshotId, from, to, mode: 'pointer', steps})` | Pointer drag in 2–100 steps; the target is re-verified before release, and a failed drag is released outside the viewport. |
| `dragElements({...scope, screenshotId, source, target, mode})` | Element-centre drag; `mode` is `pointer` (trusted input) or `html5-synthetic` (DataTransfer events, `isTrusted: false`). |

One instance serves one task and generation. Success means the input sequence was sent, not that the application accepted it — read the page afterwards.

## Safety boundaries

- Screenshot IDs and refs are instance-issued and expire with navigation, DOM replacement, viewport/DPR/scroll changes or TTL.
- Inputs, textareas, selects, contenteditable, autocomplete-marked and `data-sensitive` elements, iframes/objects/embeds and Shadow DOM internals are refused as targets.
- Screenshots may contain sensitive visible information; this module does not redact them.
- CDP checks and input are not atomic; a hostile page can change between them. Do not retry risky business actions automatically.

Main error codes: `SCOPE_MISMATCH`, `UNKNOWN_SCREENSHOT`, `SCREENSHOT_EXPIRED`, `STALE_SCREENSHOT`, `CAPTURE_CHANGED`, `IMAGE_GEOMETRY_MISMATCH`, `INVALID_COORDINATES`, `INVALID_NODE_REF`, `TARGET_OCCLUDED`, `SENSITIVE_TARGET`, `NODE_MOVED`, `TARGET_NOT_ACTIONABLE`, `UNSUPPORTED_SHADOW_DOM`, `SELECTOR_NOT_UNIQUE`, `UNSUPPORTED_DRAG_MODE`, `INTERACTION_BUSY`, `ADAPTER_DETACHED`.

## Tests

```sh
node --test browser-interactions/test/*.test.mjs
node browser-interactions/test/acceptance.mjs   # real Chrome/Edge, temporary profiles; writes to evidence/ (ignored)
```
