import { setTimeout as delay } from "node:timers/promises";

export class AIStudioRequestError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly serverTraceId?: string;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, options: string | {
    requestId?: string
    serverTraceId?: string
    retryAfterMs?: number
  } = {}) {
    super(`Yandex AI Studio request failed (${status}): ${message}`);
    this.name = "AIStudioRequestError";
    this.status = status;
    const details = typeof options === "string" ? { requestId: options } : options;
    this.requestId = details.requestId;
    this.serverTraceId = details.serverTraceId;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export async function checkedFetch(
  fetchImplementation: typeof globalThis.fetch,
  url: string | URL,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const retryableMethod = !(init.body instanceof ReadableStream)
    && (method === "GET" || method === "HEAD" || headers.has("idempotency-key"));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImplementation(url, init);
      if (response.ok) return response;
      const retry = retryableMethod
        && attempt < maxRetries
        && (response.status === 429 || response.status >= 500);
      if (!retry) throw await requestError(response);
      // The transport owns discarded responses; callers own successful ones.
      await response.body?.cancel().catch(() => undefined);
      await delay(retryDelayMs(response, attempt), undefined, { signal: init.signal ?? undefined });
    } catch (error) {
      if (error instanceof AIStudioRequestError || init.signal?.aborted || isAbortError(error) || !retryableMethod || attempt >= maxRetries) {
        throw error;
      }
      await delay(Math.min(1_000, 100 * 2 ** attempt), undefined, { signal: init.signal ?? undefined });
    }
  }
}

async function requestError(response: Response): Promise<AIStudioRequestError> {
  let message = response.statusText || "request rejected";
  try {
    const body = await response.json() as {
      error?: { message?: unknown }
      error_message?: unknown
      message?: unknown
    };
    const detail = body.error?.message ?? body.error_message ?? body.message;
    if (typeof detail === "string" && detail.trim()) message = detail.trim();
  } catch {
    // The status and request ID are still actionable when the body is not JSON.
  }
  return new AIStudioRequestError(response.status, message, {
    requestId: response.headers.get("x-request-id") ?? undefined,
    serverTraceId: response.headers.get("x-server-trace-id") ?? undefined,
    retryAfterMs: retryAfterMs(response),
  });
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelayMs(response: Response, attempt: number): number {
  return Math.min(5_000, retryAfterMs(response) ?? 100 * 2 ** attempt);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
