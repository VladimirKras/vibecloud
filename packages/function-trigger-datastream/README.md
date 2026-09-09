# `@vibecloud/function-trigger-datastream`

TypeScript declarations for Yandex Data Streams functions. It exports generic
`DataStreamsEvent<Message>` and function `InvocationContext` interfaces.

The trigger parses each JSON record and places the resulting value directly in
`event.messages`; it does not wrap records in a Base64 `details.data` envelope.

```ts
import type {
  DataStreamsEvent,
  InvocationContext,
} from "@vibecloud/function-trigger-datastream";

interface EventMessage { id: string }

export async function consume(
  event: DataStreamsEvent<EventMessage>,
  context: InvocationContext,
): Promise<void> {
  for (const message of event.messages) {
    console.log(message.id, context.requestId);
  }
}
```
