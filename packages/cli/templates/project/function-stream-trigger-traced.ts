import type { DataStreamsEvent, InvocationContext } from "@vibecloud/function-trigger-datastream";
import { SpanKind, traceInvocation } from "@vibecloud/telemetry";

export async function {{HANDLER}}(
  event: DataStreamsEvent,
  context: InvocationContext,
): Promise<void> {
  return traceInvocation("stream.consume", context, {
    kind: SpanKind.CONSUMER,
    attributes: { "messaging.batch.message_count": event.messages.length },
  }, async () => {
    throw new Error(`Data Streams handler is not implemented for request ${context.requestId}`);
  });
}
