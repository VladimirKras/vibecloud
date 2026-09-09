import { parseRequest, invocationSignal, errorResponse, rateHeaders, json, environmentInteger, requestHeaders, requiredEnvironment, usageAttributes } from "@vibecloud/ai/http";
import {
  AIEndpointError,
  createAIContinuation,
  createAIStudioClient,
  createAIRateLimiter,
  readAIContinuation,
  requireAIStudioOutputText,
} from "@vibecloud/ai";
import type { SpeechRecognitionFormat, SpeechSynthesisFormat } from "@vibecloud/ai";
import { withYdb } from "@vibecloud/db";
import { createYdbAuth } from "@vibecloud/db/better-auth";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { businessEvent, setSpanAttributes, withSpan } from "@vibecloud/telemetry";

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
const auth = createYdbAuth({{PROJECT_NAME_JSON}}, authSecret);

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  try {
    return await handle(event, context);
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

  const request = parseRequest<AITurnRequest>(event);
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
  setSpanAttributes(usageAttributes(modelName, response.usage));

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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodeBase64(value: string): Buffer | undefined {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  return Buffer.from(value, "base64");
}
