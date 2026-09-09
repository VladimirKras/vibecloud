export type { InvocationContext } from "@vibecloud/core";

export interface DataStreamsEvent<Message = Record<string, unknown>> {
  messages: Message[]
}
