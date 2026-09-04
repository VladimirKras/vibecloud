# `@vibecloud/telemetry`

Common OpenTelemetry helpers for Vibecloud functions. Infrastructure captures
gateway and function runtime logs; this package sends application spans,
metrics, and logs directly to Monium over OTLP.

Telemetry exporters activate only when the generated Monium environment
variables are present.

```ts
import { businessEvent, setSpanAttributes, withSpan } from "@vibecloud/telemetry";

export async function instrumentTodoCreate<T extends { id: string }>(
  ownerId: string,
  createTodo: () => Promise<T>,
): Promise<T> {
  return withSpan("todo.create", { "todo.owner": ownerId }, async () => {
    const todo = await createTodo();
    setSpanAttributes({ "todo.id": todo.id });
    businessEvent("todo.created", { "todo.id": todo.id });
    return todo;
  });
}
```

`traceInvocation` wraps a function invocation and flushes configured exporters.
`withSpan`, `traceOperation`, `setSpanAttributes`, `recordError`, and
`businessEvent` instrument application work. `structuredLog` emits one OTLP log
record with the active trace and span IDs and automatically adds the function
`request_id` when called inside `traceInvocation`. It also writes the same
one-line JSON record to stdout so enabling direct OTLP export never removes the
container's durable runtime log. Business events use the OpenTelemetry
`event.name` attribute.

Use `createStructuredLogger("database")` for a named subsystem stream. Stream
names are validated, and an `event.name` attribute is also sent as the OTLP log
record's event name.

Use `structuredLog("INFO", "beacon batch processed", { processed: 1 })`, not
`console.log("beacon batch processed", { processed: 1 })`: Node may render an
object across multiple lines, which the function runtime stores as separate log
entries.

Do not duplicate infrastructure request or invocation logs. YC owns gateway
`GET` events and function `START`, `END`, and `REPORT` events. Those records
carry a platform `request_id`, but YC does not attach application OpenTelemetry
trace or span IDs to them. In generated infrastructure, application OTLP logs
use the logical function key as the Monium service; YC platform records use
service `default` and are configured independently with
`observability.platform_logs`.
