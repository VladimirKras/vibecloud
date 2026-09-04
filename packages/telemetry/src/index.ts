import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";

export { SpanKind };

interface InvocationContext {
  requestId: string
}

interface ActiveInvocation extends InvocationContext {
  attributes: Attributes
}

interface TraceInvocationOptions {
  attributes?: Attributes
  carrier?: Record<string, string>
  kind?: SpanKind
}

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
export interface ActiveOperationTrace {
  setAttributes(attributes: Record<string, string | number | boolean>): void
}
const flushTimeoutMillis = 2_000;

const provider = createProvider();
const meterProvider = createMeterProvider();
const loggerProvider = createLoggerProvider();
const invocationStorage = new AsyncLocalStorage<ActiveInvocation>();
const tracer = trace.getTracer(process.env.MONIUM_SERVICE ?? "vibecloud-function");
const serviceName = process.env.MONIUM_SERVICE ?? "vibecloud-function";
const logger = loggerProvider?.getLogger(serviceName);
const businessEventCounter = meterProvider
  ?.getMeter(process.env.MONIUM_SERVICE ?? "vibecloud-function")
  .createCounter("vibecloud.business.events", {
    description: "Successful business operations",
    unit: "{event}",
  });

export async function traceInvocation<T>(
  name: string,
  invocation: InvocationContext,
  options: TraceInvocationOptions,
  work: () => Promise<T>,
): Promise<T> {
  const parent = options.carrier
    ? propagation.extract(context.active(), normalizedCarrier(options.carrier))
    : context.active();
  return tracer.startActiveSpan(name, {
    kind: options.kind ?? SpanKind.INTERNAL,
    attributes: {
      "faas.invocation_id": invocation.requestId,
      ...options.attributes,
    },
  }, parent, (span) => invocationStorage.run({
    ...invocation,
    attributes: options.attributes ?? {},
  }, async () => {
    try {
      return await work();
    } catch (error) {
      recordError(error);
      throw error;
    } finally {
      span.end();
      await flushTelemetry();
    }
  }));
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: () => PromiseLike<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.recordException(asError(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: asError(error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function traceOperation<T>(
  tracerName: string,
  operationName: string,
  attributes: Record<string, string | number | boolean>,
  operation: (span: ActiveOperationTrace) => Promise<T>,
): Promise<T> {
  const operationTracer = trace.getTracer(tracerName);
  return operationTracer.startActiveSpan(operationName, async (span) => {
    span.setAttributes(attributes);
    try {
      return await operation({
        setAttributes: (nextAttributes) => span.setAttributes(nextAttributes),
      });
    } catch (error) {
      const exception = asError(error);
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setSpanAttributes(attributes: Attributes): void {
  trace.getSpan(context.active())?.setAttributes(attributes);
}

export function recordError(error: unknown): void {
  const value = asError(error);
  const span = trace.getSpan(context.active());
  span?.recordException(value);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: value.message });
}

export function businessEvent(name: string, attributes: Attributes = {}): void {
  trace.getSpan(context.active())?.addEvent(name, attributes);
  businessEventCounter?.add(1, { "event.name": name });
  structuredLog("INFO", "business event", { "event.name": name, ...attributes });
}

export function createStructuredLogger(streamName: string) {
  if (streamName.length < 1 || streamName.length > 63) {
    throw new Error("stream_name must contain 1-63 characters");
  }
  const streamLogger = loggerProvider?.getLogger(streamName);
  return (
    level: LogLevel,
    message: string,
    attributes: Record<string, unknown> = {},
  ): void => emitStructuredLog(streamName, streamLogger, level, message, attributes);
}

export function structuredLog(
  level: LogLevel,
  message: string,
  attributes: Record<string, unknown> = {},
): void {
  emitStructuredLog("application", logger, level, message, attributes);
}

function emitStructuredLog(
  streamName: string,
  otelLogger: ReturnType<NonNullable<typeof loggerProvider>["getLogger"]> | undefined,
  level: LogLevel,
  message: string,
  attributes: Record<string, unknown>,
): void {
  if (severityNumber(level) < configuredMinimumSeverity()) return;
  const spanContext = trace.getSpan(context.active())?.spanContext();
  const invocation = invocationStorage.getStore();
  const fields = {
    ...invocation?.attributes,
    ...attributes,
    ...(invocation?.requestId ? { request_id: invocation.requestId } : {}),
    ...(spanContext?.traceId ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
  };
  if (otelLogger) {
    otelLogger.emit({
      eventName: typeof attributes["event.name"] === "string"
        ? attributes["event.name"]
        : undefined,
      body: message,
      severityNumber: severityNumber(level),
      severityText: level,
      attributes: fields as LogAttributes,
      context: context.active(),
    });
  }
  writeConsoleLog(level, message, fields, streamName);
}

async function flushTelemetry(): Promise<void> {
  const flushes = [
    provider?.forceFlush().catch((error: unknown) => {
      writeConsoleLog("WARN", "trace export failed", { error: asError(error).message });
    }),
    meterProvider?.forceFlush().catch((error: unknown) => {
      writeConsoleLog("WARN", "metric export failed", { error: asError(error).message });
    }),
    loggerProvider?.forceFlush({ timeoutMillis: flushTimeoutMillis }).catch((error: unknown) => {
      writeConsoleLog("WARN", "log export failed", { error: asError(error).message });
    }),
  ].filter((flush): flush is Promise<void> => flush !== undefined);
  if (!flushes.length) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, flushTimeoutMillis);
    void Promise.all(flushes)
      .finally(() => {
        clearTimeout(timeout);
        resolve();
      });
  });
}

function createLoggerProvider(): LoggerProvider | undefined {
  if (process.env.MONIUM_LOGS_ENABLED !== "1") return undefined;
  const apiKey = process.env.MONIUM_API_KEY;
  const project = process.env.MONIUM_PROJECT;
  if (!apiKey || !project) return undefined;

  const service = process.env.MONIUM_SERVICE ?? "vibecloud-function";
  const cluster = process.env.MONIUM_CLUSTER ?? "default";
  const exporter = new OTLPLogExporter({
    url: process.env.MONIUM_OTLP_LOGS_ENDPOINT
      ?? "https://ingest.monium.yandex.cloud/otlp/v1/logs",
    headers: {
      "Authorization": `Api-Key ${apiKey}`,
      "x-monium-project": project,
      "x-monium-cluster": cluster,
      "x-monium-service": service,
    },
    timeoutMillis: flushTimeoutMillis,
  });
  return new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": service, cluster }),
    processors: [new BatchLogRecordProcessor({ exporter })],
  });
}

function createProvider(): NodeTracerProvider | undefined {
  if (process.env.MONIUM_TRACES_ENABLED !== "1") return undefined;
  const apiKey = process.env.MONIUM_API_KEY;
  const project = process.env.MONIUM_PROJECT;
  if (!apiKey || !project) return undefined;

  const service = process.env.MONIUM_SERVICE ?? "vibecloud-function";
  const cluster = process.env.MONIUM_CLUSTER ?? "default";
  const sampleRate = boundedSampleRate(process.env.MONIUM_TRACE_SAMPLE_RATE);
  const exporter = new OTLPTraceExporter({
    url: process.env.MONIUM_OTLP_TRACES_ENDPOINT
      ?? "https://ingest.monium.yandex.cloud/otlp/v1/traces",
    headers: {
      "Authorization": `Api-Key ${apiKey}`,
      "x-monium-project": project,
      "x-monium-cluster": cluster,
      "x-monium-service": service,
    },
    timeoutMillis: flushTimeoutMillis,
  });
  const value = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": service, cluster }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate) }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  value.register();
  return value;
}

function createMeterProvider(): MeterProvider | undefined {
  if (process.env.MONIUM_METRICS_ENABLED !== "1") return undefined;
  const apiKey = process.env.MONIUM_API_KEY;
  const project = process.env.MONIUM_PROJECT;
  if (!apiKey || !project) return undefined;

  const service = process.env.MONIUM_SERVICE ?? "vibecloud-function";
  const cluster = process.env.MONIUM_CLUSTER ?? "default";
  const exporter = new OTLPMetricExporter({
    url: process.env.MONIUM_OTLP_METRICS_ENDPOINT
      ?? "https://ingest.monium.yandex.cloud/otlp/v1/metrics",
    headers: {
      "Authorization": `Api-Key ${apiKey}`,
      "x-monium-project": project,
      "x-monium-cluster": cluster,
      "x-monium-service": service,
    },
    timeoutMillis: flushTimeoutMillis,
    temporalityPreference: AggregationTemporality.DELTA,
  });
  return new MeterProvider({
    resource: resourceFromAttributes({ "service.name": service, cluster }),
    readers: [new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: flushTimeoutMillis,
    })],
  });
}

function boundedSampleRate(value: string | undefined): number {
  const parsed = Number(value ?? "0.1");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.1;
}

function severityNumber(level: LogLevel): SeverityNumber {
  if (level === "TRACE") return SeverityNumber.TRACE;
  if (level === "DEBUG") return SeverityNumber.DEBUG;
  if (level === "WARN") return SeverityNumber.WARN;
  if (level === "ERROR") return SeverityNumber.ERROR;
  if (level === "FATAL") return SeverityNumber.FATAL;
  return SeverityNumber.INFO;
}

function configuredMinimumSeverity(): SeverityNumber {
  const configured = process.env.MONIUM_LOG_LEVEL?.toUpperCase();
  if (configured === "TRACE") return SeverityNumber.TRACE;
  if (configured === "DEBUG") return SeverityNumber.DEBUG;
  if (configured === "WARN") return SeverityNumber.WARN;
  if (configured === "ERROR") return SeverityNumber.ERROR;
  if (configured === "FATAL") return SeverityNumber.FATAL;
  return SeverityNumber.INFO;
}

function writeConsoleLog(
  level: LogLevel,
  message: string,
  attributes: Record<string, unknown>,
  streamName = "application",
): void {
  const entry = JSON.stringify({ ...attributes, message, level, stream_name: streamName });
  if (level === "ERROR" || level === "FATAL") console.error(entry);
  else if (level === "WARN") console.warn(entry);
  else console.log(entry);
}

function normalizedCarrier(carrier: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(carrier).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
