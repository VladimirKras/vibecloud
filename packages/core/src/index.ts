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
