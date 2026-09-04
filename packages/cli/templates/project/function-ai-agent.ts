import {
  AIEndpointError,
  type AIStudioClient,
  AIStudioRequestError,
  type AIStudioResponse,
  AIStudioResponseError,
  createAIContinuation,
  createAIStudioClient,
  createAIRateLimiter,
  readAIContinuation,
  requireAIStudioOutputText,
} from "@vibecloud/ai";
import { getYdb, withYdb } from "@vibecloud/db";
import { ydbAdapter } from "@vibecloud/db/better-auth";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { SpanKind, businessEvent, setSpanAttributes, traceInvocation, withSpan } from "@vibecloud/telemetry";
import { betterAuth } from "better-auth";

interface AgentRequest {
  prompt?: unknown
  continuation?: unknown
  previousResponseId?: unknown
}

const databaseEndpoint = requiredEnvironment("{{DATABASE_ENV}}_ENDPOINT");
const authSecret = requiredEnvironment("BETTER_AUTH_SECRET");
const rateLimiter = createAIRateLimiter();
const auth = betterAuth({
  appName: {{PROJECT_NAME_JSON}},
  secret: authSecret,
  baseURL: {
    allowedHosts: ["*.apigw.yandexcloud.net", "*.orb.local", "127.0.0.1:*", "localhost:*"],
    protocol: "auto",
  },
  database: ydbAdapter({ getDb: getYdb }),
  emailAndPassword: { enabled: true },
});

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  const route = event.resource || event.path;
  try {
    return await traceInvocation(`ai.agent ${route}`, context, {
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
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    return json(400, { error: "prompt must be a non-empty string" }, rateHeaders(access));
  }
  const prompt = request.prompt.trim();
  if (prompt.length > environmentInteger("VIBECLOUD_AI_MAX_PROMPT_CHARS", 8_000)) {
    return json(413, { error: "prompt is too long" }, rateHeaders(access));
  }
  if (request.continuation !== undefined && typeof request.continuation !== "string") {
    return json(400, { error: "continuation must be a string" }, rateHeaders(access));
  }
  const previousResponseId = request.continuation
    ? readAIContinuation(request.continuation, session.user.id, authSecret)
    : undefined;
  const modelName = process.env.YANDEX_AI_MODEL ?? "aliceai-llm";
  const ai = createAIStudioClient(context);
  const response = await withSpan("ai.responses.create", {
    "gen_ai.request.model": modelName,
  }, async () => {
    const signal = invocationSignal(context);
    const initial = await ai.responses.create({
      model: ai.model(modelName),
      instructions: process.env.YANDEX_AI_INSTRUCTIONS ?? "Answer clearly and concisely.",
      input: prompt,
      max_output_tokens: environmentInteger("VIBECLOUD_AI_MAX_OUTPUT_TOKENS", 1_024),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }, { signal });
    return waitForAIResponse(ai, initial, signal);
  });
  const output = requireAIStudioOutputText(response);
  recordUsage(modelName, response.usage);
  businessEvent("ai.response.completed", { "ai.response.id": response.id });
  return json(200, {
    id: response.id,
    continuation: createAIContinuation(
      response.id,
      session.user.id,
      authSecret,
      environmentInteger("VIBECLOUD_AI_CONTINUATION_TTL_SECONDS", 3_600),
    ),
    output,
  }, rateHeaders(access));
}

function parseRequest(event: HttpEvent): AgentRequest | undefined {
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as AgentRequest
      : undefined;
  } catch {
    return undefined;
  }
}

function requestHeaders(event: HttpEvent): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values) headers.append(name, value);
  }
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function invocationSignal(context: InvocationContext): AbortSignal {
  const remaining = typeof context.getRemainingTimeInMillis === "function"
    ? context.getRemainingTimeInMillis()
    : 30_000;
  return AbortSignal.timeout(Math.max(1, remaining - 1_500));
}

async function waitForAIResponse(
  ai: AIStudioClient,
  initial: AIStudioResponse,
  signal: AbortSignal,
): Promise<AIStudioResponse> {
  let response = initial;
  for (let attempt = 0; ["queued", "in_progress"].includes(response.status ?? ""); attempt += 1) {
    if (attempt >= 40) throw new DOMException("AI response polling timed out", "TimeoutError");
    await pause(500, signal);
    response = await ai.responses.retrieve(response.id, { signal });
  }
  return response;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function recordUsage(model: string, usage: Record<string, unknown> | undefined): void {
  const attributes: Record<string, string | number> = { "gen_ai.request.model": model };
  for (const [source, target] of [
    ["input_tokens", "gen_ai.usage.input_tokens"],
    ["output_tokens", "gen_ai.usage.output_tokens"],
    ["total_tokens", "gen_ai.usage.total_tokens"],
  ] as const) {
    const value = usage?.[source];
    if (typeof value === "number" && Number.isFinite(value)) attributes[target] = value;
  }
  setSpanAttributes(attributes);
}

function errorResponse(error: unknown): HttpResponse {
  if (error instanceof AIEndpointError) {
    return json(error.statusCode, { error: error.message }, error.retryAfterSeconds
      ? { "retry-after": String(error.retryAfterSeconds) }
      : {});
  }
  if (error instanceof AIStudioRequestError) {
    return json(error.status === 429 ? 503 : 502, {
      error: "AI service is temporarily unavailable",
      requestId: error.requestId,
    }, error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1_000)) } : {});
  }
  if (error instanceof AIStudioResponseError) {
    return json(502, { error: "AI service did not return a completed response", responseId: error.responseId });
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return json(504, { error: "AI request exceeded the available function time" });
  }
  return json(500, { error: "AI request failed" });
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
