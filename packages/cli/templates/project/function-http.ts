import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      method: event.httpMethod,
      path: event.path,
      requestId: context.requestId,
    }),
  };
}
