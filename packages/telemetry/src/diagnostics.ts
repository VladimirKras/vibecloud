type SafeValue = string | number | boolean | null | SafeValue[] | { [key: string]: SafeValue };

export function safeLogValue(value: unknown): SafeValue {
  const seen = new WeakSet<object>();
  let remaining = 1_000;
  const visit = (item: unknown, depth: number): SafeValue => {
    if (--remaining < 0 || depth > 6) return "[Truncated]";
    if (typeof item === "string") return item.slice(0, 8_192);
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "boolean" || item === null) return item;
    if (typeof item === "bigint") return item.toString();
    if (typeof item !== "object") return `[${typeof item}]`;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        return Array.from({ length: Math.min(item.length, 100) }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          return descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor]";
        });
      }
      const result: { [key: string]: SafeValue } = Object.create(null);
      for (const key of Object.keys(item).slice(0, 100)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        result[key.slice(0, 256)] = descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor]";
      }
      return result;
    } catch { return "[Unserializable]"; }
  };
  return visit(value, 0);
}

/** Diagnostics must not change the application result, even if stderr is unavailable. */
export function reportTelemetryFailure(): void {
  try {
    console.error('{"level":"WARN","message":"Telemetry operation failed"}');
  } catch { /* no secondary failure */ }
}

export function telemetryEffect(work: () => unknown): void {
  try {
    const result = work();
    if (result instanceof Promise) void result.catch(reportTelemetryFailure);
  } catch { reportTelemetryFailure(); }
}
