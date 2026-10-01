export const SCHEMA_VERSION = "browser.diagnostics/v1";

const EVENT_KEYS = Object.freeze([
  "schema_version",
  "timestamp",
  "component",
  "event_type",
  "task_id",
  "request_id",
  "connection_id",
  "generation",
  "status",
  "duration_ms",
  "error_code",
  "action",
  "stage",
]);
// 中文注释：阶段与动作只接受固定枚举，不接收页面数据。
const ACTIONS = new Set([null, "tabs", "new_tab", "navigate", "snapshot", "click", "fill", "press", "screenshot", "page.parse", "semantic_snapshot", "frame_catalog", "ref_click", "ref_fill", "ref_press", "ref_set_checked", "ref_select_option", "files.upload", "interaction.capture", "interaction.bounds", "interaction.click", "interaction.drag_coordinates", "interaction.drag_elements", "official.ready_state", "official.goto_url", "official.new_tab", "scroll", "back", "js.evaluate", "cdp.send", "cdp.events", "network.inspect", "images", "console", "dialog"]);
const STAGES = new Set([null, "queue_wait", "settle_wait", "overlay", "target_settle", "highlight", "dispatch", "post_check"]);
const INPUT_KEYS = new Set(EVENT_KEYS.filter((key) => key !== "schema_version"));
const COMPONENTS = new Set(["native_bridge", "mv3_background", "mv3_content", "diagnostics"]);
const EVENT_TYPES = new Set([
  "task_state",
  "request_state",
  "connection_state",
  "action_state",
  "buffer_state",
  "sink_state",
]);
const STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "connected",
  "disconnected",
  "dropped",
  "rotated",
  "recovered",
]);
const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERROR_CODES = new Set([
  "UNCLASSIFIED_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "DISCONNECTED",
  "PROTOCOL_ERROR",
  "VALIDATION_ERROR",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "TRANSPORT_ERROR",
]);
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();

export class UnsafeDiagnosticField extends TypeError {}

function rejectUnless(condition, message) {
  if (!condition) throw new UnsafeDiagnosticField(message);
}

function validateOpaque(name, value) {
  if (value === null) return null;
  rejectUnless(typeof value === "string" && OPAQUE_RE.test(value), `${name} must be an opaque identifier`);
  return value;
}

function validateEvent(event) {
  rejectUnless(event !== null && typeof event === "object" && !Array.isArray(event), "event must be an object");
  const keys = Object.keys(event).sort();
  const allowed = [...EVENT_KEYS].sort();
  rejectUnless(keys.length === allowed.length && keys.every((key, index) => key === allowed[index]), "event keys rejected");
  rejectUnless(event.schema_version === SCHEMA_VERSION, "unsupported schema_version");
  rejectUnless(typeof event.timestamp === "string" && TIMESTAMP_RE.test(event.timestamp), "timestamp must be canonical UTC milliseconds");
  rejectUnless(COMPONENTS.has(event.component), "component is not allowlisted");
  rejectUnless(EVENT_TYPES.has(event.event_type), "event_type is not allowlisted");
  rejectUnless(STATUSES.has(event.status), "status is not allowlisted");
  for (const name of ["task_id", "request_id", "connection_id", "generation"]) {
    validateOpaque(name, event[name]);
  }
  if (event.duration_ms !== null) {
    rejectUnless(
      typeof event.duration_ms === "number"
        && Number.isFinite(event.duration_ms)
        && event.duration_ms >= 0
        && event.duration_ms <= 86_400_000,
      "duration_ms is outside the allowed range",
    );
  }
  if (event.error_code !== null) {
    // 中文注释：协议错误可用受限的小写码，不能把异常原文放入诊断。
    rejectUnless(ERROR_CODES.has(event.error_code) || /^[a-z][a-z0-9_]{0,63}$/.test(event.error_code), "error_code is not allowlisted");
  }
  rejectUnless(ACTIONS.has(event.action) && STAGES.has(event.stage), "action or stage is not allowlisted");
  return event;
}

export function createDiagnosticEvent(fields) {
  rejectUnless(fields !== null && typeof fields === "object" && !Array.isArray(fields), "fields must be an object");
  for (const key of Object.keys(fields)) {
    rejectUnless(INPUT_KEYS.has(key), `non-allowlisted field: ${key}`);
  }
  const event = {
    schema_version: SCHEMA_VERSION,
    timestamp: fields.timestamp ?? new Date().toISOString(),
    component: fields.component ?? null,
    event_type: fields.event_type ?? null,
    task_id: fields.task_id ?? null,
    request_id: fields.request_id ?? null,
    connection_id: fields.connection_id ?? null,
    generation: fields.generation ?? null,
    status: fields.status ?? null,
    duration_ms: fields.duration_ms ?? null,
    error_code: fields.error_code ?? null,
    action: fields.action ?? null,
    stage: fields.stage ?? null,
  };
  validateEvent(event);
  return Object.freeze(event);
}

function encodedSize(event) {
  return encoder.encode(JSON.stringify(event)).byteLength + 1;
}

export class DiagnosticEventBuffer {
  #events = [];
  #byteSize = 0;
  #droppedCount = 0;

  constructor({ maxEvents = 200, maxBytes = 262_144 } = {}) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
      throw new RangeError("maxEvents must be an integer from 1 to 10000");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > 16_777_216) {
      throw new RangeError("maxBytes must be an integer from 512 to 16777216");
    }
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
  }

  get size() {
    return this.#events.length;
  }

  get byteSize() {
    return this.#byteSize;
  }

  get droppedCount() {
    return this.#droppedCount;
  }

  push(event) {
    validateEvent(event);
    const safeEvent = Object.freeze({ ...event });
    const bytes = encodedSize(safeEvent);
    if (bytes > this.maxBytes) throw new RangeError("event exceeds buffer maxBytes");
    while (this.#events.length >= this.maxEvents || this.#byteSize + bytes > this.maxBytes) {
      const removed = this.#events.shift();
      this.#byteSize -= removed.bytes;
      this.#droppedCount += 1;
    }
    this.#events.push({ event: safeEvent, bytes });
    this.#byteSize += bytes;
  }

  recordSafely(fields) {
    try {
      this.push(createDiagnosticEvent(fields));
      return true;
    } catch {
      return false;
    }
  }

  snapshot() {
    return this.#events.map(({ event }) => ({ ...event }));
  }

  exportBundle() {
    return {
      bundle_format: "browser.diagnostics.buffer/v1",
      schema_version: SCHEMA_VERSION,
      redaction: "strict_allowlist",
      dropped_count: this.#droppedCount,
      events: this.snapshot(),
    };
  }

  clear() {
    this.#events = [];
    this.#byteSize = 0;
  }
}

function safeRecord(buffer, fields) {
  try {
    return buffer?.recordSafely?.(fields) === true;
  } catch {
    return false;
  }
}

function actionEvent(context, status, durationMs, errorCode) {
  return {
    component: context?.component,
    event_type: context?.event_type ?? "action_state",
    task_id: context?.task_id ?? null,
    request_id: context?.request_id ?? null,
    connection_id: context?.connection_id ?? null,
    generation: context?.generation ?? null,
    status,
    duration_ms: durationMs,
    error_code: errorCode,
    timestamp: new Date().toISOString(),
  };
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function observeAction(action, buffer, context, classifyError = error => error?.code) {
  const started = monotonicNow();
  safeRecord(buffer, actionEvent(context, "running", null, null));
  try {
    const result = await action();
    safeRecord(buffer, actionEvent(context, "succeeded", Math.max(0, monotonicNow() - started), null));
    return result;
  } catch (error) {
    let errorCode = "UNCLASSIFIED_ERROR";
    try {
      const candidate = classifyError(error);
      if (typeof candidate === "string" && (ERROR_CODES.has(candidate) || /^[a-z][a-z0-9_]{0,63}$/.test(candidate))) errorCode = candidate;
    } catch {
      errorCode = "UNCLASSIFIED_ERROR";
    }
    safeRecord(buffer, actionEvent(context, "failed", Math.max(0, monotonicNow() - started), errorCode));
    throw error;
  }
}
