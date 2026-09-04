# `@vibecloud/ai`

Server-side access to Yandex Cloud AI Studio and SpeechKit for Vibecloud
applications. The client uses the short-lived service-account IAM token already
supplied to a Cloud Function, adds the required folder and privacy headers,
builds model URIs, and exposes typed Responses, Conversations, Models, Files,
Embeddings, Images, Vector Stores, speech, and Realtime primitives without
requiring an API key in production.

```ts
import { createAIStudioClient, requireAIStudioOutputText } from "@vibecloud/ai";
import type { InvocationContext } from "@vibecloud/function-api";

export async function answer(prompt: string, context: InvocationContext) {
  const ai = createAIStudioClient(context);
  const response = await ai.responses.create({
    model: ai.model("aliceai-llm"),
    input: prompt,
  });
  return requireAIStudioOutputText(response);
}
```

`responses.stream()` returns the checked `Response` containing the SSE stream.
Stored and background responses can be retrieved, cancelled, deleted, and
inspected through the rest of `responses`:

```ts
const pending = await ai.responses.create({
  model: ai.model("aliceai-llm"),
  input: "Analyze this document",
  background: true,
});
const current = await ai.responses.retrieve(pending.id);
if (current.status === "queued") await ai.responses.cancel(current.id);
```

Typed clients are also available as `models`, `conversations`, `files`,
`embeddings`, `images`, and `vectorStores`. Files use `Blob`, so uploads work
without a Node stream dependency:

```ts
const file = await ai.files.create({
  file: new Blob([documentText], { type: "text/markdown" }),
  filename: "knowledge.md",
  purpose: "assistants",
});
const store = await ai.vectorStores.create({ name: "Knowledge", file_ids: [file.id] });
```

`request()` remains the escape hatch for newly released compatible endpoints
while preserving the same authentication and headers. Request data logging is
disabled by default; opt in with `{ dataLogging: true }` only after reviewing
the data being sent.

Responses may finish as `incomplete`, `failed`, or `cancelled`, and may omit
`output_text`. Use `requireAIStudioOutputText()` before consuming text. Request
methods accept an `AbortSignal`; safe GET/HEAD requests retry bounded transient
failures, while POST requests are not replayed unless the caller supplies an
idempotency key. `AIStudioRequestError` carries request, server-trace, and
retry-after metadata when available.

## YandexART image generation

YandexART uses the native asynchronous Image Generation API. Start an
operation, return or persist its ID, and retrieve it from a later request:

```ts
const operation = await ai.yandexArt.start({
  prompt: "A paper city at sunset",
  aspectRatio: {widthRatio: 16, heightRatio: 9},
});
const current = await ai.yandexArt.retrieve(operation.id);
if (current.done) {
  const {dataBase64, contentType} = requireYandexArtImage(current);
}
```

The client builds the `art://<folder>/yandex-art/latest` URI, sends the function
IAM token, and returns the native operation contract. The result helper rejects
pending, failed, empty, and malformed completed operations.

## Serverless voice turns

SpeechKit recognition and synthesis reuse the same invocation credentials:

```ts
const transcript = await ai.speech.transcribe(oggAudio, {
  format: "oggopus",
  language: "ru-RU",
});
const response = await ai.responses.create({
  model: ai.model("aliceai-llm"),
  input: transcript,
});
const { audio, contentType } = await ai.speech.synthesize(requireAIStudioOutputText(response), {
  format: "mp3",
  voice: "marina",
});
```

Synchronous recognition accepts OggOpus or raw LPCM. It enforces SpeechKit's
1 MB request limit; callers must also keep the mono utterance within the
service's 30-second limit. LPCM requests must provide `sampleRateHertz`.
Synthesis supports MP3, OggOpus, and WAV. Each call accepts at most 250
characters. The generated `ai-turn` template splits longer output into
independently playable utterances instead of concatenating container files.

For local development, `pnpm dev` reads the project folder ID and resolves
credentials in this order: an explicit `YANDEX_CLOUD_API_KEY`, an explicit
`YANDEX_CLOUD_IAM_TOKEN`, or a temporary IAM token from the active `yc`
profile. The selected credential is passed only to the local `app` container
and is neither printed nor persisted. Run `yc init` once for interactive
development, or supply a scoped API key for unattended environments. Restart
`pnpm dev` when a temporary token needs refreshing. Production functions
normally need none of these local variables because invocation credentials are
provided by the platform.

## Realtime voice agents

`realtimeServerConnection()` returns the current Realtime WebSocket URL and
server authorization headers:

```ts
const { url, headers } = ai.realtimeServerConnection();
```

This configuration is for trusted server-side WebSocket clients. Never return
the authorization header or an AI Studio API key to browser code. Yandex's
Realtime API keeps an audio session on one persistent WebSocket, whereas API
Gateway WebSockets invoke their integration separately for connect, message,
and disconnect events. A continuous browser voice agent therefore needs a
trusted, long-lived relay runtime; a regular Vibecloud Cloud Function is not
that relay. Use serverless HTTP voice turns when continuous audio is not
required.

The default model is `speech-realtime-250923`, and the endpoint is
`wss://ai.api.cloud.yandex.net/v1/realtime`. Realtime is currently a Preview
feature, so keep the relay protocol isolated behind this package.
