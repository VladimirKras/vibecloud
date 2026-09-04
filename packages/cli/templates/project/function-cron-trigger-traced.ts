import type { InvocationContext, TimerEvent } from "@vibecloud/function-trigger-cron";
import { SpanKind, traceInvocation } from "@vibecloud/telemetry";

export async function {{HANDLER}}(
  event: TimerEvent,
  context: InvocationContext,
): Promise<void> {
  return traceInvocation("timer.run", context, {
    kind: SpanKind.CONSUMER,
    attributes: { "messaging.batch.message_count": event.messages.length },
  }, async () => {
    throw new Error(`cron handler is not implemented for request ${context.requestId}`);
  });
}
