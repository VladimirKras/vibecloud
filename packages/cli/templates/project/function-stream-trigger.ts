import type { DataStreamsEvent, InvocationContext } from "@vibecloud/function-trigger-datastream";

export async function {{HANDLER}}(
  event: DataStreamsEvent,
  context: InvocationContext,
): Promise<void> {
  throw new Error(
    `Data Streams handler is not implemented (${event.messages.length} messages, request ${context.requestId})`,
  );
}
