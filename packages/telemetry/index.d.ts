import type { Attributes } from "@opentelemetry/api";

export { SpanKind } from "@opentelemetry/api";

export interface InvocationContext {
  requestId: string
}

export interface TraceInvocationOptions {
  attributes?: Attributes
  carrier?: Record<string, string>
  kind?: import("@opentelemetry/api").SpanKind
}

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
export interface ActiveOperationTrace {
  setAttributes(attributes: Record<string, string | number | boolean>): void
}

export function traceInvocation<T>(
  name: string,
  invocation: InvocationContext,
  options: TraceInvocationOptions,
  work: () => Promise<T>,
): Promise<T>;

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: () => PromiseLike<T>,
): Promise<T>;

export function traceOperation<T>(
  tracerName: string,
  operationName: string,
  attributes: Record<string, string | number | boolean>,
  operation: (span: ActiveOperationTrace) => Promise<T>,
): Promise<T>;

export function setSpanAttributes(attributes: Attributes): void;
export function recordError(error: unknown): void;
export function businessEvent(name: string, attributes?: Attributes): void;
export function structuredLog(
  level: LogLevel,
  message: string,
  attributes?: Record<string, unknown>,
): void;
export function createStructuredLogger(streamName: string): (
  level: LogLevel,
  message: string,
  attributes?: Record<string, unknown>,
) => void;
