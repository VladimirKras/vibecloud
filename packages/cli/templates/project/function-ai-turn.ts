import {
  AIEndpointError,
  AIStudioRequestError,
  AIStudioResponseError,
  createAIContinuation,
  createAIStudioClient,
  createAIRateLimiter,
  readAIContinuation,
  requireAIStudioOutputText,
} from "@vibecloud/ai";
import type { SpeechRecognitionFormat, SpeechSynthesisFormat } from "@vibecloud/ai";
import { getYdb, withYdb } from "@vibecloud/db";
import { ydbAdapter } from "@vibecloud/db/better-auth";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { SpanKind, businessEvent, setSpanAttributes, traceInvocation, withSpan } from "@vibecloud/telemetry";
import { betterAuth } from "better-auth";

interface AITurnRequest {
  input?: unknown
  output?: unknown
  continuation?: unknown
  previousResponseId?: unknown
}

const recognitionFormats = new Set<SpeechRecognitionFormat>(["lpcm", "oggopus"]);
const synthesisFormats = new Set<SpeechSynthesisFormat>(["mp3", "oggopus", "wav"]);
const outputModalities = new Set(["audio", "text"] as const);
const databaseEndpoint = requiredEnvironment("{{DATABASE_ENV}}_ENDPOINT");
const authSecret = requiredEnvironment("BETTER_AUTH_SECRET");
const rateLimiter = createAIRateLimiter();
const auth = betterAuth({
  appName: {{PROJECT_NAME_JSON}},
  secret: authSecret,
  database: ydbAdapter({ getDb: getYdb }),
  emailAndPassword: { enabled: true },
});

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  const route = event.resource || event.path;
  try {
    return await traceInvocation(`ai.turn ${route}`, context, {
      carrier: event.headers,
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": event.httpMethod,
        "http.route": route,
        "yandex.apigateway.request_id": event.requestContext?.requestId ?? context.requestId,
      },
    }, async () => handle(event, context));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handle(event: HttpEvent, context: InvocationContext): Promise<HttpResponse> {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" }, { allow: "POST" });
  const session = await withYdb(databaseEndpoint, () => auth.api.getSession({
    headers: requestHeaders(event),
    query: { disableCookieCache: true, disableRefresh: true },
  }));
  if (!session) return json(401, { error: "Sign in with Better Auth" });
  const access = rateLimiter.check(session.user.id);

  const request = parseRequest(event);
  if (!request) return json(400, { error: "body must be a JSON object" }, rateHeaders(access));
  if (request.previousResponseId !== undefined) {
    return json(400, { error: "previousResponseId is not accepted; use the signed continuation value" }, rateHeaders(access));
  }
  if (request.continuation !== undefined && typeof request.continuation !== "string") {
    return json(400, { error: "continuation must be a string" }, rateHeaders(access));
  }
  const input = asObject(request.input);
  if (!input || (input.type !== "text" && input.type !== "audio")) {
    return json(400, { error: "input.type must be text or audio" }, rateHeaders(access));
  }
  const output = asObject(request.output);
  if (!output || !Array.isArray(output.modalities) || output.modalities.length === 0) {
    return json(400, { error: "output.modalities must contain text, audio, or both" }, rateHeaders(access));
  }
  if (!output.modalities.every((value) => (
    typeof value === "string" && outputModalities.has(value as "audio" | "text")
  )) || new Set(output.modalities).size !== output.modalities.length) {
    return json(400, { error: "output.modalities must contain unique text and/or audio values" }, rateHeaders(access));
  }
  const wantsText = output.modalities.includes("text");
  const wantsAudio = output.modalities.includes("audio");
  if (!wantsAudio && output.audio !== undefined) {
    return json(400, { error: "output.audio requires the audio modality" }, rateHeaders(access));
  }
  const outputAudio = output.audio === undefined ? {} : asObject(output.audio);
  if (!outputAudio) return json(400, { error: "output.audio must be an object" }, rateHeaders(access));
  const outputFormat = outputAudio.format ?? "mp3";
  if (wantsAudio && (
    typeof outputFormat !== "string" || !synthesisFormats.has(outputFormat as SpeechSynthesisFormat)
  )) return json(400, { error: "output.audio.format must be mp3, oggopus, or wav" }, rateHeaders(access));
  for (const field of ["role", "voice"] as const) {
    if (outputAudio[field] !== undefined && typeof outputAudio[field] !== "string") {
      return json(400, { error: `output.audio.${field} must be a string` }, rateHeaders(access));
    }
  }
  if (outputAudio.speed !== undefined && (
    typeof outputAudio.speed !== "number" || outputAudio.speed < 0.1 || outputAudio.speed > 3
  )) return json(400, { error: "output.audio.speed must be between 0.1 and 3" }, rateHeaders(access));

  let inputText: string | undefined;
  let transcript: string | undefined;
  const signal = invocationSignal(context);
  const ai = createAIStudioClient(context);
  if (input.type === "text") {
    if (typeof input.text !== "string" || !input.text.trim()) {
      return json(400, { error: "input.text must be a non-empty string" }, rateHeaders(access));
    }
    inputText = input.text.trim();
  } else {
    if (typeof input.dataBase64 !== "string") {
      return json(400, { error: "input.dataBase64 must be a base64 string" }, rateHeaders(access));
    }
    const audio = decodeBase64(input.dataBase64);
    if (!audio) return json(400, { error: "input.dataBase64 must contain valid base64 data" }, rateHeaders(access));
    if (audio.byteLength > 1_000_000) return json(413, { error: "input audio cannot exceed 1 MB" }, rateHeaders(access));
    const format = input.format;
    if (typeof format !== "string" || !recognitionFormats.has(format as SpeechRecognitionFormat)) {
      return json(400, { error: "input.format must be oggopus or lpcm" }, rateHeaders(access));
    }
    if (input.language !== undefined && typeof input.language !== "string") {
      return json(400, { error: "input.language must be a string" }, rateHeaders(access));
    }
    const sampleRateHertz = input.sampleRateHertz;
    if ((sampleRateHertz !== undefined && (
      !Number.isInteger(sampleRateHertz) || Number(sampleRateHertz) <= 0
    )) || (format === "lpcm" && sampleRateHertz === undefined)) {
      return json(400, { error: "input.sampleRateHertz must be a positive integer and is required for lpcm" }, rateHeaders(access));
    }
    transcript = await withSpan("ai.speech.transcribe", {
      "gen_ai.input.modalities": "audio",
    }, () => ai.speech.transcribe(audio, {
      format: format as SpeechRecognitionFormat,
      language: input.language as string | undefined ?? process.env.YANDEX_SPEECHKIT_LANGUAGE ?? "ru-RU",
      ...(sampleRateHertz === undefined ? {} : { sampleRateHertz: Number(sampleRateHertz) }),
      signal,
    }));
    if (!transcript.trim()) return json(422, { error: "No speech was recognized" }, rateHeaders(access));
    inputText = transcript.trim();
  }
  if (inputText.length > environmentInteger("VIBECLOUD_AI_MAX_PROMPT_CHARS", 8_000)) {
    return json(413, { error: "input text is too long" }, rateHeaders(access));
  }

  const previousResponseId = request.continuation
    ? readAIContinuation(request.continuation, session.user.id, authSecret)
    : undefined;
  const modelName = process.env.YANDEX_AI_MODEL ?? "aliceai-llm";
  const response = await withSpan("ai.responses.create", {
    "gen_ai.request.model": modelName,
  }, () => ai.responses.create({
    model: ai.model(modelName),
    instructions: process.env.YANDEX_AI_INSTRUCTIONS
      ?? (wantsAudio
        ? "Reply in the user's language in at most 600 characters. Do not use Markdown."
        : "Reply in the user's language."),
    input: inputText,
    max_output_tokens: environmentInteger("VIBECLOUD_AI_MAX_OUTPUT_TOKENS", wantsAudio ? 384 : 1_024),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  }, { signal }));
  const responseText = requireAIStudioOutputText(response);
  recordUsage(modelName, response.usage);

  const responseOutput: Record<string, unknown> = { ...(wantsText ? { text: responseText } : {}) };
  if (wantsAudio) {
    const segments = speechSegments(responseText, environmentInteger("VIBECLOUD_AI_MAX_SPEECH_CHARS", 750));
    const chunks = [];
    let contentType = "";
    for (const segment of segments) {
      const synthesis = await withSpan("ai.speech.synthesize", {
        "gen_ai.output.modalities": "audio",
        "audio.segment.length": segment.length,
      }, () => ai.speech.synthesize(segment, {
        format: outputFormat as SpeechSynthesisFormat,
        voice: outputAudio.voice as string | undefined ?? process.env.YANDEX_SPEECHKIT_VOICE ?? "marina",
        role: outputAudio.role as string | undefined ?? process.env.YANDEX_SPEECHKIT_ROLE,
        speed: outputAudio.speed as number | undefined,
        signal,
      }));
      contentType = synthesis.contentType;
      chunks.push({ dataBase64: Buffer.from(synthesis.audio).toString("base64") });
    }
    responseOutput.audio = { chunks, format: outputFormat, contentType };
  }
  businessEvent("ai.turn.completed", {
    "ai.response.id": response.id,
    "ai.input.modality": String(input.type),
    "ai.output.audio": wantsAudio,
  });
  return json(200, {
    id: response.id,
    continuation: createAIContinuation(
      response.id,
      session.user.id,
      authSecret,
      environmentInteger("VIBECLOUD_AI_CONTINUATION_TTL_SECONDS", 3_600),
    ),
    input: { type: input.type, ...(transcript === undefined ? {} : { transcript }) },
    output: responseOutput,
  }, rateHeaders(access));
}

function speechSegments(text: string, maximumTotal: number): string[] {
  const characters = [...text.trim()];
  if (characters.length > maximumTotal) throw new AIEndpointError(502, "AI response is too long for speech synthesis");
  const segments: string[] = [];
  while (characters.length) {
    if (characters.length <= 250) {
      segments.push(characters.join("").trim());
      break;
    }
    let cut = 250;
    for (let index = 249; index >= 100; index -= 1) {
      if (/\s/.test(characters[index])) {
        cut = index;
        break;
      }
    }
    segments.push(characters.splice(0, cut).join("").trim());
    while (characters[0] !== undefined && /\s/.test(characters[0])) characters.shift();
  }
  return segments;
}

function parseRequest(event: HttpEvent): AITurnRequest | undefined {
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return asObject(JSON.parse(body) as unknown) as AITurnRequest | undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodeBase64(value: string): Buffer | undefined {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  return Buffer.from(value, "base64");
}

function requestHeaders(event: HttpEvent): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values) headers.append(name, value);
  }
  for (const [name, value] of Object.entries(event.headers ?? {})) if (!headers.has(name)) headers.set(name, value);
  return headers;
}

function invocationSignal(context: InvocationContext): AbortSignal {
  const remaining = typeof context.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 30_000;
  return AbortSignal.timeout(Math.max(1, remaining - 1_500));
}

function recordUsage(model: string, usage: Record<string, unknown> | undefined): void {
  const attributes: Record<string, string | number> = { "gen_ai.request.model": model };
  for (const [source, target] of [["input_tokens", "gen_ai.usage.input_tokens"], ["output_tokens", "gen_ai.usage.output_tokens"], ["total_tokens", "gen_ai.usage.total_tokens"]] as const) {
    const value = usage?.[source];
    if (typeof value === "number" && Number.isFinite(value)) attributes[target] = value;
  }
  setSpanAttributes(attributes);
}

function errorResponse(error: unknown): HttpResponse {
  if (error instanceof AIEndpointError) return json(error.statusCode, { error: error.message }, error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {});
  if (error instanceof AIStudioRequestError) return json(error.status === 429 ? 503 : 502, { error: "AI service is temporarily unavailable", requestId: error.requestId }, error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1_000)) } : {});
  if (error instanceof AIStudioResponseError) return json(502, { error: "AI service did not return a completed response", responseId: error.responseId });
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) return json(504, { error: "AI request exceeded the available function time" });
  return json(500, { error: "AI request failed" });
}

function rateHeaders(access: { remaining: number, limit: number }): Record<string, string> {
  return { "x-ratelimit-limit": String(access.limit), "x-ratelimit-remaining": String(access.remaining) };
}

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  setSpanAttributes({ "http.response.status_code": statusCode });
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}

function environmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
