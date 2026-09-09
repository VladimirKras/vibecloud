import { setTimeout as delay } from "node:timers/promises";
import { invocationCleanupMillis, remainingInvocationMillis } from "@vibecloud/core";
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import { AIEndpointError, AIStudioRequestError, AIStudioResponseError, AIStudioImageError, type AIStudioClient, type AIStudioResponse } from "@vibecloud/ai";

export function requestHeaders(event: HttpEvent): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    for (const value of values) headers.append(name, value);
  }
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

export function rateHeaders(access: { remaining: number, limit: number }): Record<string, string> {
  return {
    "x-ratelimit-limit": String(access.limit),
    "x-ratelimit-remaining": String(access.remaining),
  };
}

export function environmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseRequest<T extends object>(event: HttpEvent): T | undefined {
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
  } catch { return undefined; }
}

export function invocationSignal(context: Pick<InvocationContext, "getRemainingTimeInMillis">): AbortSignal {
  const remaining = remainingInvocationMillis(context, invocationCleanupMillis, 2_147_483_647);
  return remaining ? AbortSignal.timeout(remaining) : AbortSignal.abort(new DOMException("Invocation deadline reached", "TimeoutError"));
}

export async function waitForAIResponse(ai: AIStudioClient, initial: AIStudioResponse, signal: AbortSignal): Promise<AIStudioResponse> {
  let response = initial;
  for (let attempt = 0; ["queued", "in_progress"].includes(response.status ?? ""); attempt += 1) {
    if (attempt >= 40) throw new DOMException("AI response polling timed out", "TimeoutError");
    await delay(500, undefined, { signal });
    response = await ai.responses.retrieve(response.id, { signal });
  }
  return response;
}

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}

export function errorResponse(error: unknown): HttpResponse {
  if (error instanceof AIEndpointError) return json(error.statusCode, { error: error.message }, error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {});
  if (error instanceof AIStudioRequestError) {
    const message = error.status === 401 || error.status === 403
      ? "AI service denied the request; check model availability and access permissions"
      : error.status === 400 || error.status === 404
        ? "AI service rejected the request; check the model and request parameters"
        : error.status === 429
          ? "AI service quota or rate limit reached"
          : "AI service is temporarily unavailable";
    return json(error.status === 429 ? 503 : 502, { error: message, requestId: error.requestId }, error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1_000)) } : {});
  }
  if (error instanceof AIStudioResponseError) return json(502, { error: "AI service did not return a completed response", responseId: error.responseId });
  if (error instanceof AIStudioImageError) return json(502, { error: "AI service did not return a valid image" });
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return json(504, { error: "AI request exceeded the available function time" });
  return json(500, { error: "AI request failed" });
}

export function usageAttributes(model: string, usage: Record<string, unknown> | undefined): Record<string, string | number> {
  const attributes: Record<string, string | number> = { "gen_ai.request.model": model };
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value)) attributes[`gen_ai.usage.${key}`] = value;
  }
  return attributes;
}
