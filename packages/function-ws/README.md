# `@vibecloud/function-ws`

TypeScript declarations for WebSocket functions exposed through Vibecloud's
Yandex API Gateway integration.

```ts
import type {
  InvocationContext,
  WebSocketEvent,
  WebSocketResponse,
} from "@vibecloud/function-ws";

export async function handler(
  event: WebSocketEvent,
  context: InvocationContext,
): Promise<WebSocketResponse> {
  return { statusCode: 200, body: `${event.requestContext.eventType}:${context.requestId}` };
}
```
