import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { AIStudioRequestError, createAIStudioClient } from "../dist/index.js";

test("retrying AI requests releases discarded bodies and abort listeners", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let attempts = 0;
  const client = createAIStudioClient({}, {
    folderId: "folder",
    iamToken: "token",
    environment: {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(new ReadableStream({
          cancel() { cancelled = true; },
        }), {
          status: 503,
          headers: { "retry-after": "0" },
        });
      }
      assert.equal(cancelled, true, "discarded response must release its connection before retrying");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      return Response.json({ data: [] });
    },
  });
  await client.models.list({ signal: controller.signal });
  assert.equal(attempts, 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("AI retry budgets reject non-finite values", () => {
  for (const maxRetries of [NaN, Infinity, -Infinity]) {
    assert.throws(() => createAIStudioClient({}, {
      folderId: "folder", iamToken: "token", environment: {}, maxRetries,
    }), /maxRetries/);
  }
});

test("aborting AI retry backoff stops further attempts and releases listeners", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = createAIStudioClient({}, {
    folderId: "folder",
    iamToken: "token",
    environment: {},
    fetch: async () => {
      attempts += 1;
      setImmediate(() => controller.abort());
      return new Response(null, { status: 503, headers: { "retry-after": "5" } });
    },
  });
  await assert.rejects(client.models.list({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(attempts, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("AI transport does not replay a streamed request body even with an idempotency key", async () => {
  let attempts = 0;
  const client = createAIStudioClient({}, {
    folderId: "folder",
    iamToken: "token",
    environment: {},
    fetch: async () => {
      attempts += 1;
      return Response.json({ error: { message: "unavailable" } }, { status: 503 });
    },
  });
  await assert.rejects(client.request("upload", {
    method: "POST",
    headers: { "idempotency-key": "one-upload" },
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  }), AIStudioRequestError);
  assert.equal(attempts, 1);
});
