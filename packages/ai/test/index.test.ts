import assert from "node:assert/strict";
import test from "node:test";
import {
  AIEndpointError,
  AIStudioRequestError,
  AIStudioResponseError,
  YandexArtOperationError,
  createAIContinuation,
  createAIStudioClient,
  createAIRateLimiter,
  readAIContinuation,
  requireAIStudioOutputText,
  requireYandexArtImage,
} from "../dist/index.js";

interface CapturedRequest {
  url: string
  init: RequestInit
}

function jsonBody(body: RequestInit["body"]) {
  assert.ok(typeof body === "string");
  return JSON.parse(body);
}

test("uses the function IAM token for Responses API calls", async () => {
  let captured: CapturedRequest | undefined;
  const client = createAIStudioClient({
    functionFolderId: "folder-1",
    token: { access_token: "iam-token" },
  }, {
    environment: {},
    fetch: async (url, init = {}) => {
      captured = { url: String(url), init };
      return Response.json({ id: "response-1", output_text: "hello" });
    },
  });

  const response = await client.responses.create({ model: client.model("aliceai-llm"), input: "Hi" });
  assert.equal(response.output_text, "hello");
  assert.ok(captured);
  assert.equal(captured.url, "https://ai.api.cloud.yandex.net/v1/responses");
  assert.equal(new Headers(captured.init.headers).get("authorization"), "Bearer iam-token");
  assert.equal(new Headers(captured.init.headers).get("openai-project"), "folder-1");
  assert.equal(new Headers(captured.init.headers).get("x-data-logging-enabled"), "false");
  assert.deepEqual(jsonBody(captured.init.body), {
    model: "gpt://folder-1/aliceai-llm",
    input: "Hi",
  });
});

test("exposes the complete Responses lifecycle with encoded IDs and pagination", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("/input_items?after=item-1&limit=10&order=asc")) {
        return Response.json({ object: "list", data: [], has_more: false });
      }
      return Response.json({ id: "response-1", status: "completed", output_text: "done" });
    },
  });

  await client.responses.retrieve("response/1");
  await client.responses.cancel("response/1");
  await client.responses.listInputItems("response/1", { after: "item-1", limit: 10, order: "asc" });
  await client.responses.delete("response/1");

  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
    ["https://ai.api.cloud.yandex.net/v1/responses/response%2F1", "GET"],
    ["https://ai.api.cloud.yandex.net/v1/responses/response%2F1/cancel", "POST"],
    ["https://ai.api.cloud.yandex.net/v1/responses/response%2F1/input_items?after=item-1&limit=10&order=asc", "GET"],
    ["https://ai.api.cloud.yandex.net/v1/responses/response%2F1", "DELETE"],
  ]);
  await assert.rejects(() => client.responses.retrieve(" "), /ID cannot be empty/);
});

test("provides typed model, conversation, embedding, and image resources", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/models")) return Response.json({ object: "list", data: [] });
      if (path.endsWith("/embeddings")) {
        return Response.json({ object: "list", data: [], model: "embeddings" });
      }
      if (path.endsWith("/images/generations")) return Response.json({ created: 1, data: [] });
      if (init.method === "DELETE") {
        return Response.json({ id: "conversation-1", object: "conversation.deleted", deleted: true });
      }
      return Response.json({ id: "conversation-1", object: "conversation", metadata: {}, created_at: 1 });
    },
  });

  await client.models.list();
  await client.conversations.create({ metadata: { user: "1" } });
  await client.conversations.retrieve("conversation-1");
  await client.conversations.update("conversation-1", { metadata: { user: "2" } });
  await client.conversations.listItems("conversation-1", { limit: 5, order: "desc" });
  await client.conversations.createItems("conversation-1", [{ type: "message", role: "user", content: "Hi" }]);
  await client.conversations.delete("conversation-1");
  await client.embeddings.create({ model: "emb://folder-1/text-search-query", input: "query" });
  await client.images.generate({ model: "image-model", prompt: "cat" });

  assert.deepEqual(calls.map(({ url, init }) => [new URL(url).pathname + new URL(url).search, init.method]), [
    ["/v1/models", "GET"],
    ["/v1/conversations", "POST"],
    ["/v1/conversations/conversation-1", "GET"],
    ["/v1/conversations/conversation-1", "POST"],
    ["/v1/conversations/conversation-1/items?limit=5&order=desc", "GET"],
    ["/v1/conversations/conversation-1/items", "POST"],
    ["/v1/conversations/conversation-1", "DELETE"],
    ["/v1/embeddings", "POST"],
    ["/v1/images/generations", "POST"],
  ]);
  assert.deepEqual(jsonBody(calls[5].init.body), {
    items: [{ type: "message", role: "user", content: "Hi" }],
  });
});

test("starts and retrieves native asynchronous YandexART generations", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({
    functionFolderId: "folder-1",
    token: { access_token: "iam-token" },
  }, {
    environment: {},
    yandexArtUrl: "https://art.example/generate",
    yandexArtOperationsUrl: "https://art.example/operations",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/generate")
        ? Response.json({ id: "operation-1", done: false })
        : Response.json({
          id: "operation-1",
          done: true,
          response: { image: Buffer.from("jpeg").toString("base64"), modelVersion: "1" },
        });
    },
  });

  const started = await client.yandexArt.start({
    prompt: "A paper city",
    negativePrompt: "text",
    seed: 42,
    aspectRatio: { widthRatio: 16, heightRatio: 9 },
  });
  assert.equal(started.done, false);
  const completed = await client.yandexArt.retrieve(started.id);
  const image = requireYandexArtImage(completed);
  assert.equal(Buffer.from(image.image).toString(), "jpeg");
  assert.equal(image.dataBase64, Buffer.from("jpeg").toString("base64"));
  assert.equal(image.contentType, "image/jpeg");
  assert.equal(image.modelVersion, "1");

  assert.equal(calls[0].url, "https://art.example/generate");
  assert.equal(calls[1].url, "https://art.example/operations/operation-1");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer iam-token");
  assert.equal(new Headers(calls[0].init.headers).get("x-folder-id"), "folder-1");
  assert.deepEqual(jsonBody(calls[0].init.body), {
    modelUri: "art://folder-1/yandex-art/latest",
    messages: [
      { text: "A paper city", weight: "1" },
      { text: "text", weight: "-1" },
    ],
    generationOptions: {
      mimeType: "image/jpeg",
      seed: "42",
      aspectRatio: { widthRatio: "16", heightRatio: "9" },
    },
  });

  assert.throws(
    () => requireYandexArtImage({ id: "pending", done: false }),
    YandexArtOperationError,
  );
  assert.throws(
    () => requireYandexArtImage({ id: "failed", done: true, error: { code: 8, message: "quota" } }),
    /quota/,
  );
  assert.throws(
    () => requireYandexArtImage({ id: "invalid", done: true, response: { image: "not base64" } }),
    /valid base64/,
  );
});

test("uploads and downloads files without overriding multipart boundaries", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/content")) return new Response("contents", { headers: { "content-type": "text/plain" } });
      return Response.json({
        id: "file-1",
        object: "file",
        bytes: 5,
        created_at: 1,
        filename: "notes.txt",
        purpose: "assistants",
      });
    },
  });

  await client.files.create({
    file: new Blob(["hello"], { type: "text/plain" }),
    filename: "notes.txt",
    purpose: "assistants",
    format: "chunks",
  });
  const content = await client.files.content("file-1");

  assert.equal(await content.text(), "contents");
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("purpose"), "assistants");
  assert.equal(calls[0].init.body.get("format"), "chunks");
  assert.equal(new Headers(calls[0].init.headers).has("content-type"), false);
  assert.equal(calls[1].url, "https://ai.api.cloud.yandex.net/v1/files/file-1/content");
});

test("composes vector store management, search, and file operations", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ id: "resource-1", object: "vector_store", deleted: true, data: [] });
    },
  });

  await client.vectorStores.list({ after: "store-0", limit: 2 });
  await client.vectorStores.create({ name: "Docs" });
  await client.vectorStores.retrieve("store-1");
  await client.vectorStores.update("store-1", { name: "Knowledge" });
  await client.vectorStores.search("store-1", { query: "auth" });
  await client.vectorStores.files.create("store-1", { file_id: "file-1" });
  await client.vectorStores.files.retrieve("store-1", "file-1");
  await client.vectorStores.files.content("store-1", "file-1");
  await client.vectorStores.files.delete("store-1", "file-1");
  await client.vectorStores.delete("store-1");

  assert.deepEqual(calls.map(({ url, init }) => [new URL(url).pathname + new URL(url).search, init.method]), [
    ["/v1/vector_stores?after=store-0&limit=2", "GET"],
    ["/v1/vector_stores", "POST"],
    ["/v1/vector_stores/store-1", "GET"],
    ["/v1/vector_stores/store-1", "POST"],
    ["/v1/vector_stores/store-1/search", "POST"],
    ["/v1/vector_stores/store-1/files", "POST"],
    ["/v1/vector_stores/store-1/files/file-1", "GET"],
    ["/v1/vector_stores/store-1/files/file-1/content", "GET"],
    ["/v1/vector_stores/store-1/files/file-1", "DELETE"],
    ["/v1/vector_stores/store-1", "DELETE"],
  ]);
});

test("supports local API keys and the current server-side Realtime endpoint", () => {
  const client = createAIStudioClient({ functionFolderId: "local" }, {
    environment: {
      YANDEX_CLOUD_FOLDER_ID: "local-folder",
      YANDEX_CLOUD_API_KEY: "api-key",
    },
  });
  const connection = client.realtimeServerConnection();

  assert.equal(
    connection.url,
    "wss://ai.api.cloud.yandex.net/v1/realtime?model=gpt%3A%2F%2Flocal-folder%2Fspeech-realtime-250923",
  );
  assert.equal(connection.headers.Authorization, "Api-Key api-key");
  assert.equal(connection.headers["x-data-logging-enabled"], "false");
  assert.equal(client.model("gpt://another/model"), "gpt://another/model");
});

test("prefers the invocation IAM token over inherited environment credentials", async () => {
  let authorization;
  const client = createAIStudioClient({
    functionFolderId: "cloud-folder",
    token: { access_token: "function-token" },
  }, {
    environment: {
      YANDEX_CLOUD_API_KEY: "local-api-key",
      YANDEX_AI_BASE_URL: "https://example.test/v1/",
      YANDEX_AI_REALTIME_URL: "wss://realtime.example.test/v1/realtime",
    },
    fetch: async (_url, init = {}) => {
      authorization = new Headers(init.headers).get("authorization");
      return Response.json({ id: "response-1", output_text: "hello" });
    },
  });

  await client.responses.create({ input: "Hi" });
  assert.equal(authorization, "Bearer function-token");
  assert.match(client.realtimeServerConnection().url, /^wss:\/\/realtime\.example\.test\/v1\/realtime/);
});

test("transcribes a bounded utterance and synthesizes a playable response", async () => {
  const calls: CapturedRequest[] = [];
  const client = createAIStudioClient({
    functionFolderId: "folder-1",
    token: { access_token: "iam-token" },
  }, {
    environment: {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://stt.api.cloud.yandex.net/")) {
        return Response.json({ result: "Привет" });
      }
      return Response.json({ audioChunk: { data: Buffer.from("voice").toString("base64") } });
    },
  });

  const transcript = await client.speech.transcribe(Buffer.from("ogg-audio"), {
    format: "oggopus",
    language: "ru-RU",
  });
  const synthesis = await client.speech.synthesize("Здравствуйте", {
    voice: "marina",
    role: "friendly",
    format: "mp3",
  });

  assert.equal(transcript, "Привет");
  assert.equal(Buffer.from(synthesis.audio).toString(), "voice");
  assert.equal(synthesis.contentType, "audio/mpeg");
  assert.match(calls[0].url, /format=oggopus/);
  assert.match(calls[0].url, /folderId=folder-1/);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer iam-token");
  assert.equal(new Headers(calls[1].init.headers).get("x-folder-id"), "folder-1");
  assert.deepEqual(jsonBody(calls[1].init.body), {
    text: "Здравствуйте",
    outputAudioSpec: { containerAudio: { containerAudioType: "MP3" } },
    hints: [{ voice: "marina" }, { role: "friendly" }],
  });
});

test("validates SpeechKit turn inputs before making a request", async () => {
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async () => {
      throw new Error("fetch should not run");
    },
  });

  await assert.rejects(() => client.speech.transcribe(new Uint8Array()), /cannot be empty/);
  await assert.rejects(
    () => client.speech.transcribe(new Uint8Array(2), { format: "lpcm" }),
    /requires sampleRateHertz/,
  );
  await assert.rejects(() => client.speech.synthesize("   "), /cannot be empty/);
  await assert.rejects(() => client.speech.synthesize("a".repeat(251)), /cannot exceed 250 characters/);
  await assert.rejects(() => client.speech.synthesize("hello", { speed: 4 }), /speed must be between/);
});

test("requires local credentials and reports API failures", async () => {
  assert.throws(
    () => createAIStudioClient({ functionFolderId: "local" }, { environment: {} }),
    /folder ID/,
  );
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async () => Response.json(
      { error: { message: "model is unavailable" } },
      { status: 429, headers: { "x-request-id": "request-1" } },
    ),
  });

  await assert.rejects(
    () => client.responses.create({ input: "Hi" }),
    (error) => error instanceof AIStudioRequestError
      && error.status === 429
      && error.requestId === "request-1"
      && /model is unavailable/.test(error.message),
  );
});

test("requires a completed Responses result with output text", () => {
  assert.equal(requireAIStudioOutputText({
    id: "response-1",
    status: "completed",
    output_text: " Answer ",
  }), "Answer");
  assert.equal(requireAIStudioOutputText({
    id: "response-nested",
    status: "completed",
    output: [{
      type: "message",
      content: [
        { type: "output_text", text: " First answer " },
        { type: "refusal", refusal: "ignored" },
        { type: "output_text", text: "Second answer" },
      ],
    }],
  }), "First answer\nSecond answer");
  assert.throws(
    () => requireAIStudioOutputText({ id: "response-2", status: "incomplete", output_text: null }),
    (error) => error instanceof AIStudioResponseError && error.responseId === "response-2",
  );
  assert.throws(
    () => requireAIStudioOutputText({ id: "response-3", status: "completed" }),
    AIStudioResponseError,
  );
});

test("signs continuations for one Better Auth user and expires them", () => {
  const continuation = createAIContinuation("response-1", "user-1", "auth-secret", 60, 1_000);
  assert.equal(readAIContinuation(continuation, "user-1", "auth-secret", 30_000), "response-1");
  assert.throws(
    () => readAIContinuation(continuation, "user-2", "auth-secret", 30_000),
    (error) => error instanceof AIEndpointError && error.statusCode === 400,
  );
  assert.throws(
    () => readAIContinuation(continuation, "user-1", "auth-secret", 62_000),
    /expired/,
  );
});

test("rate limits each authenticated principal independently", () => {
  let now = 0;
  const limiter = createAIRateLimiter({ requestsPerMinute: 2, now: () => now, environment: {} });
  assert.deepEqual(limiter.check("user-1"), { limit: 2, remaining: 1 });
  assert.deepEqual(limiter.check("user-1"), { limit: 2, remaining: 0 });
  assert.throws(
    () => limiter.check("user-1"),
    (error) => error instanceof AIEndpointError && error.statusCode === 429,
  );
  assert.deepEqual(limiter.check("user-2"), { limit: 2, remaining: 1 });
  now = 60_000;
  assert.deepEqual(limiter.check("user-1"), { limit: 2, remaining: 1 });
});

test("retries only safe transient requests and preserves trace metadata", async () => {
  let safeCalls = 0;
  const client = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async () => {
      safeCalls += 1;
      if (safeCalls === 1) return new Response("temporary", { status: 503 });
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await (await client.request("models", { method: "GET" })).json(), { ok: true });
  assert.equal(safeCalls, 2);

  const failing = createAIStudioClient({}, {
    folderId: "folder-1",
    iamToken: "token",
    environment: {},
    fetch: async () => Response.json({ error: { message: "busy" } }, {
      status: 429,
      headers: { "retry-after": "2", "x-server-trace-id": "trace-1" },
    }),
  });
  await assert.rejects(
    () => failing.responses.create({ input: "Hi" }),
    (error) => error instanceof AIStudioRequestError
      && error.serverTraceId === "trace-1"
      && error.retryAfterMs === 2_000,
  );
});
