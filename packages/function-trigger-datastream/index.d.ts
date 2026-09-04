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

export interface DataStreamsEvent<Message = Record<string, unknown>> {
  messages: Message[]
}
