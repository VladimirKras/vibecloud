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
