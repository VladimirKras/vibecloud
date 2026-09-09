/**
 * Converts an unknown thrown value into an Error. Nested cause messages are
 * copied into the top-level message for runtimes that serialize only that
 * field, while the original error remains available through `cause`.
 */
export function errorFrom(value: unknown): Error {
  if (!(value instanceof Error)) return new Error(String(value));
  if (value.cause === undefined) return value;

  const messages = [value.message];
  const visited = new Set<unknown>([value]);
  let cause: unknown = value.cause;
  while (cause !== undefined && !visited.has(cause)) {
    visited.add(cause);
    if (cause instanceof Error) {
      messages.push(cause.message);
      cause = cause.cause;
    } else {
      messages.push(String(cause));
      break;
    }
  }

  return new Error(messages.join("\nCaused by: "), { cause: value });
}

export interface InvocationContext {
  functionFolderId: string
  functionName: string
  /** Authored handler name inside a shared deployment. */
  logicalFunctionName?: string
  functionVersion: string
  memoryLimitInMB: number
  requestId: string
  token?: {
    access_token: string
    expires_in: number
    token_type: string
  }
  getRemainingTimeInMillis(): number
  getPayload(): unknown
}

/** Leave time for exporters and response serialization when stopping authored work. */
export const invocationCleanupMillis = 2_500;

export function remainingInvocationMillis(context: { getRemainingTimeInMillis?: () => number }, reserve = 0, maximum = 30_000): number {
  const value = context.getRemainingTimeInMillis?.() ?? 30_000;
  return Math.max(0, Math.floor(Math.min(Number.isFinite(value) ? value : 30_000, maximum) - reserve));
}
