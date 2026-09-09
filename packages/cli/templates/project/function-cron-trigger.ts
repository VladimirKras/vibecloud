import type { InvocationContext, TimerEvent } from "@vibecloud/function-trigger-cron";

export async function {{HANDLER}}(
  event: TimerEvent,
  context: InvocationContext,
): Promise<void> {
  throw new Error(
    `cron handler is not implemented (${event.messages.length} messages, request ${context.requestId})`,
  );
}
