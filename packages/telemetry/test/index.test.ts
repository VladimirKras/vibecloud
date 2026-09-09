import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  businessEvent,
  createStructuredLogger,
  structuredLog,
  traceInvocation,
  withSpan,
} from "@vibecloud/telemetry";

test("disabled exporters leave tracing helpers usable", async () => {
  const value = await traceInvocation("test", { requestId: "request-1" }, {}, async () =>
    withSpan("child", {}, async () => 42));
  assert.equal(value, 42);

  const expected = new Error("failed");
  await assert.rejects(
    () => traceInvocation("test", { requestId: "request-2" }, {}, async () => { throw expected; }),
    (error) => error === expected,
  );
});

test("application logs are structured JSON", () => {
  const entries: unknown[] = [];
  const original = console.log;
  console.log = (value) => entries.push(value);
  try {
    structuredLog("INFO", "todo created", { todo_id: "todo-1" });
    businessEvent("todo.created", { todo_id: "todo-1" });
  } finally {
    console.log = original;
  }
  assert.deepEqual(entries.map((entry) => {
    assert.ok(typeof entry === "string");
    return JSON.parse(entry);
  }), [
    {
      message: "todo created",
      level: "INFO",
      stream_name: "application",
      todo_id: "todo-1",
    },
    {
      "message": "business event",
      "level": "INFO",
      "stream_name": "application",
      "event.name": "todo.created",
      "todo_id": "todo-1",
    },
  ]);
});

test("named structured loggers retain their stream in container output", () => {
  const entries: unknown[] = [];
  const original = console.log;
  console.log = (value) => entries.push(JSON.parse(value));
  try {
    createStructuredLogger("database")("INFO", "query complete", {
      "event.name": "ydb.client.query",
    });
  } finally {
    console.log = original;
  }
  assert.deepEqual(entries, [{
    "event.name": "ydb.client.query",
    "message": "query complete",
    "level": "INFO",
    "stream_name": "database",
  }]);
  assert.throws(() => createStructuredLogger(""), /1-63 characters/);
});

test("logging handles BigInt, cycles and hostile serializers without calling authored getters", () => {
  const entries: string[] = [];
  const original = console.log;
  console.log = (value) => entries.push(String(value));
  try {
    const attributes: Record<string, unknown> = { count: 1n, toJSON() {
      throw new Error("must not run");
    } };
    attributes.cycle = attributes;
    Object.defineProperty(attributes, "hostile", { enumerable: true, get() {
      throw new Error("must not run");
    } });
    assert.doesNotThrow(() => structuredLog("INFO", "completed", attributes));
    const entry = JSON.parse(entries[0]);
    assert.equal(entry.count, "1");
    assert.equal(entry.cycle, "[Circular]");
    assert.equal(entry.hostile, "[Accessor]");
    console.log = () => {
      throw new Error("output unavailable");
    };
    assert.doesNotThrow(() => structuredLog("INFO", "completed"));
  } finally { console.log = original; }
});

test("invalid exporter configuration cannot prevent application startup", () => {
  const module = new URL("../dist/index.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const { traceInvocation } = await import(${JSON.stringify(module)}); console.log(await traceInvocation('work', {requestId:'test'}, {}, async () => 'APPLICATION_RESULT'));`], {
    encoding: "utf8",
    env: { ...process.env, MONIUM_TRACES_ENABLED: "1", MONIUM_API_KEY: "fixture", MONIUM_PROJECT: "fixture", MONIUM_OTLP_TRACES_ENDPOINT: "invalid://[broken" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APPLICATION_RESULT/);
});
