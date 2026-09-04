import type {
  InvocationContext,
  WebSocketEvent,
  WebSocketResponse,
} from "@vibecloud/function-ws";

export async function {{HANDLER}}(
  event: WebSocketEvent,
  context: InvocationContext,
): Promise<WebSocketResponse> {
  const { connectionId, eventType } = event.requestContext;

  if (eventType !== "MESSAGE") {
    return { statusCode: 200, body: "" };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      connectionId,
      messageId: event.requestContext.messageId,
      requestId: context.requestId,
      body: event.body,
    }),
  };
}
