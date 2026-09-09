export type { InvocationContext } from "@vibecloud/core";

export interface TimerEvent {
  messages: Array<{
    event_metadata: {
      event_id: string
      event_type: "yandex.cloud.events.serverless.triggers.TimerMessage"
      created_at: string
      cloud_id: string
      folder_id: string
    }
    details: {
      trigger_id: string
      payload?: string
    }
  }>
}
