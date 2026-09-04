import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
import {
  SpanKind,
  setSpanAttributes,
  traceInvocation,
} from "@vibecloud/telemetry";

export async function {{HANDLER}}(
  event: HttpEvent,
  context: InvocationContext,
): Promise<HttpResponse> {
  const route = event.resource || event.path;
  return traceInvocation(
    `${event.httpMethod} ${route}`,
    context,
    {
      carrier: event.headers,
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": event.httpMethod,
        "http.route": route,
        "yandex.apigateway.request_id": event.requestContext.requestId,
      },
    },
    async () => {
      const response: HttpResponse = {
        statusCode: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: true,
          method: event.httpMethod,
          path: event.path,
          requestId: context.requestId,
        }),
      };
      setSpanAttributes({ "http.response.status_code": response.statusCode });
      return response;
    },
  );
}
