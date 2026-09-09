import assert from "node:assert/strict";
import test from "node:test";
import { websocketMessageText } from "./websocket-message.ts";

const value = JSON.stringify({ ok: true });

test("decodes WebSocket message payloads exposed by supported Node runtimes", async () => {
  const bytes = new TextEncoder().encode(value);
  assert.equal(await websocketMessageText(value), value);
  assert.equal(await websocketMessageText(new Blob([bytes])), value);
  assert.equal(await websocketMessageText(bytes.buffer), value);
  assert.equal(await websocketMessageText(bytes), value);
});

test("rejects unsupported WebSocket message payloads", async () => {
  await assert.rejects(websocketMessageText({}), /Unsupported WebSocket message payload/);
});
