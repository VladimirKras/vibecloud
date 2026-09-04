import {
  AIEndpointError,
  AIStudioRequestError,
  YandexArtOperationError,
  createAIStudioClient,
  createAIRateLimiter,
  requireYandexArtImage,
} from "@vibecloud/ai";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { SpanKind, setSpanAttributes, traceInvocation, withSpan } from "@vibecloud/telemetry";

interface ImageRequest {
  prompt?: unknown
  negativePrompt?: unknown
  seed?: unknown
  aspectRatio?: unknown
}

const rateLimiter = createAIRateLimiter({
  requestsPerMinute: environmentInteger("VIBECLOUD_AI_IMAGE_REQUESTS_PER_MINUTE", 5),
});

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  const route = event.resource || event.path;
  try {
    return await traceInvocation(`ai.image ${route}`, context, {
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
  const ai = createAIStudioClient(context);
  const signal = invocationSignal(context);
  if (event.httpMethod === "POST") {
    const principal = event.requestContext?.identity?.sourceIp ?? "unknown";
    const access = rateLimiter.check(principal);
    const request = parseRequest(event);
    if (!request) return json(400, { error: "body must be a JSON object" }, rateHeaders(access));
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      return json(400, { error: "prompt must be a non-empty string" }, rateHeaders(access));
    }
    const prompt = request.prompt.trim();
    if (prompt.length > environmentInteger("VIBECLOUD_AI_IMAGE_MAX_PROMPT_CHARS", 2_000)) {
      return json(413, { error: "prompt is too long" }, rateHeaders(access));
    }
    if (request.negativePrompt !== undefined && typeof request.negativePrompt !== "string") {
      return json(400, { error: "negativePrompt must be a string" }, rateHeaders(access));
    }
    const negativePrompt = request.negativePrompt?.trim();
    if (negativePrompt && negativePrompt.length > 1_000) {
      return json(413, { error: "negativePrompt is too long" }, rateHeaders(access));
    }
    if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || Number(request.seed) < 0)) {
      return json(400, { error: "seed must be a non-negative integer" }, rateHeaders(access));
    }
    const aspectRatio = parseAspectRatio(request.aspectRatio);
    if (request.aspectRatio !== undefined && !aspectRatio) {
      return json(400, { error: "aspectRatio must contain positive integer widthRatio and heightRatio" }, rateHeaders(access));
    }
    const operation = await withSpan("ai.yandex_art.start", {
      "gen_ai.request.model": process.env.YANDEX_ART_MODEL ?? "yandex-art",
    }, () => ai.yandexArt.start({
      prompt,
      ...(negativePrompt ? { negativePrompt } : {}),
      ...(request.seed === undefined ? {} : { seed: Number(request.seed) }),
      ...(aspectRatio ? { aspectRatio } : {}),
      model: process.env.YANDEX_ART_MODEL ?? "yandex-art",
    }, { signal }));
    return operationResponse(operation, rateHeaders(access));
  }

  if (event.httpMethod === "GET") {
    const operationId = event.queryStringParameters?.operationId?.trim();
    if (!operationId) return json(400, { error: "operationId query parameter is required" });
    const operation = await withSpan("ai.yandex_art.retrieve", {}, () => (
      ai.yandexArt.retrieve(operationId, { signal })
    ));
    return operationResponse(operation);
  }

  return json(405, { error: "Use POST or GET" }, { allow: "POST, GET" });
}

function operationResponse(
  operation: Awaited<ReturnType<ReturnType<typeof createAIStudioClient>["yandexArt"]["retrieve"]>>,
  headers: Record<string, string> = {},
): HttpResponse {
  if (!operation.done) return json(202, { operationId: operation.id, status: "in_progress" }, headers);
  const result = requireYandexArtImage(operation);
  return json(200, {
    operationId: result.operationId,
    status: "completed",
    image: {
      dataBase64: result.dataBase64,
      contentType: result.contentType,
      modelVersion: result.modelVersion,
    },
  }, headers);
}

function parseRequest(event: HttpEvent): ImageRequest | undefined {
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as ImageRequest
      : undefined;
  } catch {
    return undefined;
  }
}

function parseAspectRatio(value: unknown): { widthRatio: number, heightRatio: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ratio = value as Record<string, unknown>;
  if (!Number.isSafeInteger(ratio.widthRatio) || Number(ratio.widthRatio) <= 0
    || !Number.isSafeInteger(ratio.heightRatio) || Number(ratio.heightRatio) <= 0) return undefined;
  return { widthRatio: Number(ratio.widthRatio), heightRatio: Number(ratio.heightRatio) };
}

function invocationSignal(context: InvocationContext): AbortSignal {
  const remaining = typeof context.getRemainingTimeInMillis === "function"
    ? context.getRemainingTimeInMillis()
    : 10_000;
  return AbortSignal.timeout(Math.max(1, remaining - 1_000));
}

function errorResponse(error: unknown): HttpResponse {
  if (error instanceof AIEndpointError) {
    return json(error.statusCode, { error: error.message }, error.retryAfterSeconds
      ? { "retry-after": String(error.retryAfterSeconds) }
      : {});
  }
  if (error instanceof AIStudioRequestError) {
    return json(error.status === 429 ? 503 : 502, {
      error: "Image service is temporarily unavailable",
      requestId: error.requestId,
    }, error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1_000)) } : {});
  }
  if (error instanceof YandexArtOperationError) {
    return json(502, { error: "Image generation failed", operationId: error.operationId });
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return json(504, { error: "Image request exceeded the available function time" });
  }
  return json(500, { error: "Image request failed" });
}

function rateHeaders(access: { remaining: number, limit: number }): Record<string, string> {
  return {
    "x-ratelimit-limit": String(access.limit),
    "x-ratelimit-remaining": String(access.remaining),
  };
}

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  setSpanAttributes({ "http.response.status_code": statusCode });
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  };
}

function environmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
