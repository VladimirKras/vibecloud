import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAIStudioClient } from "@vibecloud/ai";
import { invocationSignal } from "@vibecloud/ai/http";
import { createObjectStorage } from "@vibecloud/storage";
import { traceInvocation, withSpan } from "@vibecloud/telemetry";
import "@vibecloud/db";
import "@vibecloud/db/migrator";
import "@vibecloud/db/better-auth";
let cancelled = false;
const ai = createAIStudioClient({}, { folderId: "fixture", iamToken: "fixture", environment: {}, fetch: async () => new Response(new ReadableStream({ cancel() {
  cancelled = true;
} })) });
await ai.responses.delete("fixture");
assert.equal(cancelled, true);
assert.equal(invocationSignal({ getRemainingTimeInMillis: () => 100 }).aborted, true);
let uploaded;
const storage = createObjectStorage({}, { bucket: "fixture-media", iamToken: "fixture", environment: {}, fetch: async (_url, init) => {
  uploaded = init.body;
  return new Response(null, { status: 200 });
} });
const media = await storage.put("image.png", Uint8Array.of(1, 2, 3), { contentType: "image/png" });
assert.deepEqual(uploaded, Uint8Array.of(1, 2, 3));
assert.equal(media.url, "https://storage.yandexcloud.net/fixture-media/image.png");
assert.equal(await traceInvocation("fixture", { requestId: "fixture" }, {}, () => withSpan("work", {}, async () => 42)), 42);
const failure = new Error("business failure");
await assert.rejects(traceInvocation("fixture", { requestId: "failed" }, {}, async () => {
  throw failure;
}), (error) => error === failure);
console.log(`SDK runtime smoke passed on ${process.version}`);

const compiled = createRequire(import.meta.url)("./dist/functions/http-nodejs22/router.js");
const result = await compiled.handler({ httpMethod: "GET", path: "/api/ping", headers: {} }, { requestId: "runtime-smoke", getRemainingTimeInMillis: () => 10_000 });
assert.equal(result.statusCode, 200);
assert.equal(JSON.parse(result.body).ok, true);
console.log(`Compiled HTTP handler passed on ${process.version}`);
