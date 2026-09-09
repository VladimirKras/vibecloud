# `@vibecloud/ai`

Server-side access to Yandex Cloud AI Studio and SpeechKit for Vibecloud
applications. The client uses the short-lived service-account IAM token already
supplied to a Cloud Function, adds the required folder and privacy headers,
builds model URIs, and exposes typed Responses, Conversations, Models, Files,
Embeddings, Images, Vector Stores, speech, and Realtime primitives without
requiring an API key in production.

The SDK does not require Better Auth or YDB. The CLI's `ai-agent` and `ai-turn`
templates add application authentication; custom HTTP handlers can use this
package independently. Install it from the project's configured npm-compatible
registry at the same exact version as the Vibecloud CLI, and declare the AI
capabilities used by the handler in `infra/vibecloud.auto.tfvars.json`.

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

## Image generation

Alice AI ART uses the synchronous OpenAI-compatible Images API:

```ts
import {createAIStudioClient, requireAIStudioImage} from "@vibecloud/ai";

const ai = createAIStudioClient(context);
const response = await ai.images.generate({
  prompt: "A paper city at sunset",
  size: "1536x1024",
});
const {image, contentType} = requireAIStudioImage(response);
// image is a Uint8Array of decoded image bytes.
```

The default model is `art://<folder>/aliceai-image-art-3.0`. A `model` argument
or `YANDEX_AI_IMAGE_MODEL` can select another short name or full URI. The SDK
uses the existing IAM token/API key and OpenAI project header. Give the runtime
`ai.models.user`; scoped API keys also need `yc.ai.imageGeneration.execute`.

Prompts are limited to 500 Unicode characters. Supported sizes are `auto`,
`1x1`, `1024x1024`, `1024x1536`, and `1536x1024`. Only `prompt`, `model`, and
`size` are accepted; options marked unsupported by the provider are rejected
before any request. `requireAIStudioImage()` reads `data[0].b64_json`, validates
base64, and identifies PNG, JPEG, or WebP from its signature. Invalid output
throws `AIStudioImageError`; the helper never downloads a returned URL.

The provider sends base64 inside JSON; the SDK exposes decoded `image` bytes
and `dataBase64` for integrations that require it. The `ai-image` template uploads
the decoded bytes through `@vibecloud/storage` and returns small JSON metadata:
`{ key, url, contentType, sizeBytes }`. Browsers render `url` directly. Public media
is the default; signing and private access are optional. Returning full images in
Cloud Functions response envelopes can exceed the 3.5 MB payload limit.

There is no operation ID or polling endpoint. Supply an abort signal with enough
time for generation; the `ai-image` template defaults to 120 seconds. POSTs are
not automatically replayed. A timeout or lost connection may still consume a
generation; only retry on an explicit new request.

### Migration from YandexART

YandexART and `foundationModels/v1/imageGenerationAsync` were retired on
7 September 2026. The obsolete `yandexArt` client, operation types, result helper,
and `YANDEX_ART_*` endpoint settings have been removed. Migrate callers to
`images.generate()` and `requireAIStudioImage()`, remove operation polling,
replace aspect ratios with supported sizes, and shorten prompts to 500 characters.
Changing only a model URI does not migrate the retired API.

Sources: [model availability](https://aistudio.yandex.ru/en/docs/ai-studio/concepts/generation/models),
[Images API](https://aistudio.yandex.ru/ru/docs/ai-studio/api/Images/createImage).

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

## HTTP retries

The client defaults to two retries for transient failures of GET, HEAD, and
requests carrying an idempotency key. `maxRetries` accepts a finite number,
rounded down and bounded to 0–3. Streamed request bodies are never replayed.
Discarded retry responses are closed before the next attempt; successful
response bodies remain available to the caller. An `AbortSignal` cancels
retry backoff and its listener is removed when the wait finishes.

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

## HTTP endpoint policy

The optional `@vibecloud/ai/http` subpath provides JSON request parsing, request headers,
function deadlines, safe response polling, rate-limit headers and error-to-HTTP mapping.
It also exposes environment validation and usage attributes. Generated AI handlers use
these helpers; the core client remains independent of database and telemetry runtimes.
