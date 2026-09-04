# Yandex Cloud AI reference

Use `@vibecloud/ai` for server-side AI Studio calls. It centralizes folder
model URIs, authentication, privacy headers, error handling, and the current
Realtime endpoint so application handlers do not duplicate cloud plumbing.

Vibecloud applications can use AI Studio, YandexART, and SpeechKit immediately.
In deployed functions, `createAIStudioClient(context)` authenticates with the
function's short-lived service-account token; there is no production API key
for the user or agent to create, request, or store. For local `pnpm dev`, an
authenticated `yc` profile supplies a temporary IAM token automatically.
Application user authentication, such as Better Auth, is a separate concern.

## Text agents

Create a runnable Node.js Responses API endpoint:

```bash
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
pnpm vibecloud add function agent --template ai-agent --route /api/agent
pnpm install
```

The generated POST handler requires a Better Auth session and accepts a
non-empty `prompt` plus an optional signed `continuation` returned by the
previous call. It never accepts a caller-supplied upstream response ID.
Customize `YANDEX_AI_MODEL` and
`YANDEX_AI_INSTRUCTIONS` through `vars`, or replace the handler with direct
package usage:

```ts
import { createAIStudioClient } from "@vibecloud/ai";

const ai = createAIStudioClient(context);
const response = await ai.responses.create({
  model: ai.model("aliceai-llm"),
  input: prompt,
  previous_response_id: previousResponseId,
});
```

`responses.stream()` returns the upstream SSE `Response`, but Yandex API
Gateway's Cloud Functions integration buffers HTTP responses. Use the
non-streaming result for ordinary HTTP function routes. A streaming user
experience needs a WebSocket delivery design rather than returning the SSE
response from the function.

The client also has typed surfaces for stored/background response lifecycle,
Models, Conversations, Files, Embeddings, Images, and Vector Stores. Use
`responses.retrieve()` to poll a background response and `responses.cancel()`
to stop it. Use `files` plus `vectorStores` for RAG ingestion and direct search.
`request(relativePath, init)` remains an escape hatch for newly released
compatible endpoints while retaining the same authentication and headers.
Request data logging is disabled by default. Opt in with
`{ dataLogging: true }` only after reviewing what the application sends.

## YandexART images

Create a ready public asynchronous image endpoint:

```bash
pnpm vibecloud add function illustrator --template ai-image --route /api/images
pnpm install
```

POST `{ "prompt": "..." }` to start generation. Optional fields are
`negativePrompt`, a non-negative integer `seed`, and
`aspectRatio: { "widthRatio": 16, "heightRatio": 9 }`. The response has status
202 and an `operationId`. Poll
`GET /api/images?operationId=<id>` until it returns status 200 with
`image.dataBase64` and `image.contentType`.

YandexART uses its native asynchronous API. In custom handlers, call
`ai.yandexArt.start()` and `ai.yandexArt.retrieve()`, then validate a completed
operation with `requireYandexArtImage()`. The template infers
`ai.imageGeneration.user`, uses the function IAM token, bounds prompt fields,
and applies a warm-instance source-IP rate limit. It is public by default so a
frontend can use it without application registration; add application auth and
durable quotas before exposing a cost-bearing production service.

## Serverless multimodal turns

Create a complete HTTP text and audio endpoint without a persistent relay:

```bash
pnpm vibecloud add function assistant --template ai-turn --route /api/turn
pnpm install
```

The generated function accepts exactly one of text or audio, calls AI Studio
Responses, and returns text, synthesized audio, or both. For a text-only turn:

```json
{
  "input": {
    "type": "text",
    "text": "Explain our current plan"
  },
  "output": {
    "modalities": ["text"]
  },
  "continuation": "signed_value_from_the_previous_response"
}
```

For an audio turn with both response modalities:

```json
{
  "input": {
    "type": "audio",
    "dataBase64": "<base64 OggOpus or raw LPCM>",
    "format": "oggopus",
    "language": "ru-RU"
  },
  "output": {
    "modalities": ["text", "audio"],
    "audio": {
      "format": "mp3",
      "voice": "marina",
      "role": "friendly"
    }
  },
  "continuation": "signed_value_from_the_previous_response"
}
```

`output.modalities` explicitly selects `text`, `audio`, or both. Text-only
output skips SpeechKit synthesis. Audio input runs SpeechKit recognition; for
`lpcm`, also provide a positive integer `input.sampleRateHertz`. The response
contains its conversation `id`, a user-bound signed `continuation`, an input
transcript for audio, and an `output` object containing requested text and/or
audio. Audio has `format`, `contentType`, and an ordered `chunks` array of
independently playable `{ "dataBase64" }` utterances. Reuse `continuation`, not
`id`, for the next turn.

Synchronous SpeechKit recognition is limited to one mono utterance of at most
30 seconds and 1 MB. Keep the base64 request below that decoded limit. This is
a turn-based interaction: the browser records one utterance, waits for one
complete answer, and then plays it. It does not provide partial transcription,
barge-in, VAD across turns, or streaming output. The scaffold defaults to
256 MB of function memory and a 30-second invocation timeout. `ai-agent` also
defaults to 30 seconds.

Customize defaults through `vars`: `YANDEX_AI_MODEL`,
`YANDEX_AI_INSTRUCTIONS`, `YANDEX_SPEECHKIT_LANGUAGE`,
`YANDEX_SPEECHKIT_VOICE`, and `YANDEX_SPEECHKIT_ROLE`. Request fields override
the SpeechKit defaults. The authenticated text/voice templates enforce Better Auth sessions, per-user
warm-instance rate limits, bounded prompt/model/speech output, deadline-linked
cancellation, completed-response checks, and AI usage telemetry.

## Authentication

Text and voice endpoint users authenticate through the project's existing Better Auth
cookie. Add Better Auth before `ai-agent` or `ai-turn`; the CLI binds the AI
function to that same database. `BETTER_AUTH_SECRET` also signs continuation
tokens so an upstream response cannot be resumed by another user. There is no
parallel AI bearer-token system.

In a deployed Cloud Function, pass the invocation `context`. The package uses
its short-lived service-account IAM token and `functionFolderId`. Do not create
or store a production API key for this path.

For unattended local development, export a scoped API key into the shell that
starts Compose:

```bash
export YANDEX_CLOUD_API_KEY=<scoped-api-key>
pnpm dev
```

For interactive development, `yc init` followed by `pnpm dev` is sufficient:
Vibecloud obtains a temporary IAM token from the active profile. An explicit
`YANDEX_CLOUD_IAM_TOKEN` takes precedence over the profile, while an explicit
API key takes precedence over both. Vibecloud reads the initialized `folder_id`
and passes only the selected credential to the `app` container without printing
or persisting it. Restart `pnpm dev` to refresh a temporary token; for opaque YC
tokens the CLI reports the recommended hourly refresh deadline. Do not write
credentials to tfvars, source files, or browser bundles.

## Capabilities and IAM

The `ai-agent` template automatically enables Responses access.
`ai-turn` automatically enables Responses, SpeechKit STT, and SpeechKit
TTS. `ai-image` automatically enables YandexART image generation. Declare
capabilities explicitly for custom handlers:

```json
{
  "ai": {
    "responses": true,
    "realtime": true,
    "speechkit_stt": true,
    "speechkit_tts": true,
    "image_generation": true
  }
}
```

The generated Terraform maps them to the runtime service account:

| Declaration | Added role |
| --- | --- |
| base runtime | `ai.languageModels.user` |
| `ai.responses`, `ai-agent`, or `ai-turn` | `ai.assistants.editor` |
| `ai.realtime` | `ai.models.user` |
| `ai.speechkit_stt` or `ai-turn` | `ai.speechkit-stt.user` |
| `ai.speechkit_tts` or `ai-turn` | `ai.speechkit-tts.user` |
| `ai.image_generation` or `ai-image` | `ai.imageGeneration.user` |

Capabilities are IAM declarations, not client-side feature flags. Enable only
what the application calls.

## Realtime audio agents

AI Studio Realtime is an event-driven, bidirectional audio protocol on one
persistent WebSocket. A trusted Node relay can get its upstream connection
configuration from the same client:

```ts
const ai = createAIStudioClient(context);
const { url, headers } = ai.realtimeServerConnection();
```

The default upstream is
`wss://ai.api.cloud.yandex.net/v1/realtime` with model
`speech-realtime-250923`. The returned authorization and project headers are
server secrets. Never send them to a browser or embed them in frontend code.

Do not implement the relay as a normal Vibecloud WebSocket Cloud Function.
API Gateway invokes integrations separately for connect, message, and
disconnect events, while the upstream audio session must remain attached to
one live process and socket. Vibecloud deliberately keeps its built-in path
serverless through `ai-turn`; continuous Realtime relay code belongs in a
separately operated trusted runtime. The package exposes only the safe server
connection primitive.

Realtime can use AI Studio function calling, search, and MCP tools. Keep tool
execution behind the relay or another trusted backend, validate every tool
argument, and apply application authorization before allowing side effects.
