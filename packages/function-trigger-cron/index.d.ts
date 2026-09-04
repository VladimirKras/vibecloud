export interface InvocationContext {
  functionFolderId: string
  functionName: string
  functionVersion: string
  memoryLimitInMB: number
  requestId: string
  token?: {
    access_token: string
    expires_in: number
    token_type: string
  }
  getRemainingTimeInMillis(): number
  getPayload(): unknown
}

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
