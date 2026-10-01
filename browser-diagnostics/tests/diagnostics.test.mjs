import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DiagnosticEventBuffer,
  SCHEMA_VERSION,
  UnsafeDiagnosticField,
  createDiagnosticEvent,
  observeAction,
} from "../js/diagnostics.mjs";

function baseEvent(overrides = {}) {
  return {
    component: "mv3_background",
    event_type: "request_state",
    task_id: "task-opaque-1",
    request_id: "request-opaque-1",
    connection_id: "connection-opaque-1",
    generation: "generation-opaque-1",
    status: "running",
    duration_ms: 4.5,
    error_code: null,
    action: null,
    stage: null,
    timestamp: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

test("machine-readable contract matches the MV3 event shape", () => {
  const contract = JSON.parse(readFileSync(new URL("../schema-v1.json", import.meta.url), "utf8"));
  const event = createDiagnosticEvent(baseEvent());
  assert.equal(contract.$id, SCHEMA_VERSION);
  assert.deepEqual(new Set(contract.required), new Set(Object.keys(event)));
  assert.equal(contract.additionalProperties, false);
  for (const component of contract.properties.component.enum) createDiagnosticEvent(baseEvent({ component }));
  for (const event_type of contract.properties.event_type.enum) createDiagnosticEvent(baseEvent({ event_type }));
  for (const status of contract.properties.status.enum) createDiagnosticEvent(baseEvent({ status }));
  for (const error_code of contract.properties.error_code.oneOf[1].enum) {
    createDiagnosticEvent(baseEvent({ error_code }));
  }
});

test("MV3 event schema exactly matches the versioned Python contract", () => {
  const event = createDiagnosticEvent(baseEvent());
  assert.deepEqual(event, {
    schema_version: SCHEMA_VERSION,
    timestamp: "2026-09-22T00:00:00.000Z",
    component: "mv3_background",
    event_type: "request_state",
    task_id: "task-opaque-1",
    request_id: "request-opaque-1",
    connection_id: "connection-opaque-1",
    generation: "generation-opaque-1",
    status: "running",
    duration_ms: 4.5,
    error_code: null,
    action: null,
    stage: null,
  });
});

test("nested secrets and non-allowlisted content are rejected and never buffered", () => {
  const buffer = new DiagnosticEventBuffer({ maxEvents: 10, maxBytes: 10_000 });
  const dangerous = [
    { exception: "Bearer raw-secret" },
    { url: "https://example.test/?token=raw-secret" },
    { cookie: "session=raw-secret" },
    { headers: { authorization: "raw-secret" } },
    { body: { nested: { password: "raw-secret" } } },
    { page_text: "raw-secret" },
    { metadata: { nested: { deeply: { secret: "raw-secret" } } } },
  ];

  for (const extra of dangerous) {
    assert.throws(() => createDiagnosticEvent({ ...baseEvent(), ...extra }), UnsafeDiagnosticField);
    assert.equal(buffer.recordSafely({ ...baseEvent(), ...extra }), false);
  }
  assert.equal(buffer.size, 0);
  assert.doesNotMatch(JSON.stringify(buffer.exportBundle()), /raw-secret/);
});

test("opaque fields reject path query and CRLF injection", () => {
  const cases = [
    ["task_id", "../escape"],
    ["request_id", "request\r\ninjected"],
    ["connection_id", "connection/child"],
    ["generation", "generation?token=secret"],
    ["error_code", "FAIL\r\nINJECTED"],
    ["error_code", "PASSWORD_RAW_SECRET"],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => createDiagnosticEvent(baseEvent({ [field]: value })), UnsafeDiagnosticField);
  }
});

test("buffer is bounded by event count and encoded byte size", () => {
  const buffer = new DiagnosticEventBuffer({ maxEvents: 3, maxBytes: 1_400 });
  for (let index = 0; index < 10; index += 1) {
    buffer.push(createDiagnosticEvent(baseEvent({ request_id: `request-${index}` })));
  }
  const snapshot = buffer.snapshot();
  assert.ok(snapshot.length <= 3);
  assert.ok(buffer.byteSize <= 1_400);
  assert.ok(buffer.droppedCount >= 7);
  assert.equal(snapshot.at(-1).request_id, "request-9");
});

test("snapshots and exports cannot mutate buffered events", () => {
  const buffer = new DiagnosticEventBuffer({ maxEvents: 3, maxBytes: 2_000 });
  buffer.push(createDiagnosticEvent(baseEvent()));
  const snapshot = buffer.snapshot();
  snapshot[0].request_id = "mutated";
  const bundle = buffer.exportBundle();
  bundle.events[0].request_id = "also-mutated";
  assert.equal(buffer.snapshot()[0].request_id, "request-opaque-1");
});

test("diagnostic failures never change or swallow an unknown action result", async () => {
  const unknownResult = Object.freeze({ unusual: Symbol("opaque"), nested: { value: 1 } });
  const brokenBuffer = { recordSafely() { throw new Error("sink failed"); } };

  const returned = await observeAction(
    () => unknownResult,
    brokenBuffer,
    baseEvent({ status: "running", duration_ms: null }),
  );

  assert.equal(returned, unknownResult);
});

test("diagnostic failures rethrow the exact action error without logging its text", async () => {
  const secretError = new Error("password=raw-secret");
  const buffer = new DiagnosticEventBuffer({ maxEvents: 10, maxBytes: 10_000 });

  await assert.rejects(
    observeAction(
      () => { throw secretError; },
      buffer,
      baseEvent({ status: "running", duration_ms: null }),
      () => "INVALID code with spaces",
    ),
    (caught) => caught === secretError,
  );

  const serialized = JSON.stringify(buffer.exportBundle());
  assert.doesNotMatch(serialized, /raw-secret|password=/);
  assert.match(serialized, /UNCLASSIFIED_ERROR/);
});
