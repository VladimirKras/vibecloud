export type WebSocketEventType = "CONNECT" | "MESSAGE" | "DISCONNECT";

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

export interface WebSocketRequestContext {
  identity: {
    sourceIp: string
    userAgent: string
  }
  httpMethod: string
  requestId: string
  requestTime: string
  requestTimeEpoch: number
  connectionId: string
  connectedAt?: number | string
  eventType: WebSocketEventType
  messageId?: string
  disconnectStatusCode?: number | string
  disconnectReason?: string
  authorizer?: Record<string, unknown>
  apiGateway?: {
    operationContext?: Record<string, unknown>
  }
}

export interface WebSocketEvent {
  version: "1.0"
  resource: string
  path: string
  httpMethod: string
  body: string
  headers: Record<string, string>
  multiValueHeaders: Record<string, string[]>
  queryStringParameters: Record<string, string> | null
  multiValueQueryStringParameters: Record<string, string[]> | null
  pathParameters: Record<string, string> | null
  isBase64Encoded: boolean
  requestContext: WebSocketRequestContext
  parameters?: Record<string, string> | null
  multiValueParameters?: Record<string, string[]> | null
  operationId?: string
}

export interface WebSocketResponse {
  statusCode: number
  headers?: Record<string, string>
  body: string
  isBase64Encoded?: boolean
}
