# `@vibecloud/function-api`

TypeScript declarations for HTTP functions exposed through a Vibecloud API
Gateway route. The event shape matches Yandex API Gateway payload format 1.0.

```ts
import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";

export async function handler(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  return { statusCode: 200, body: JSON.stringify({ requestId: context.requestId }) };
}
```
