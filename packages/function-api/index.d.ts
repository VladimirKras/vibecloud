export type HttpMethod = "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

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

export interface HttpRequestContext {
  identity: {
    sourceIp: string
    userAgent: string
  }
  httpMethod: HttpMethod
  requestId: string
  requestTime: string
  requestTimeEpoch: number
  authorizer?: Record<string, unknown>
  apiGateway?: {
    operationContext?: Record<string, unknown>
    operationToken?: {
      access_token: string
      expires_in: number
      token_type: string
    }
  }
}

export interface HttpEvent {
  version: "1.0"
  resource: string
  path: string
  httpMethod: HttpMethod
  headers: Record<string, string>
  multiValueHeaders: Record<string, string[]>
  queryStringParameters: Record<string, string> | null
  multiValueQueryStringParameters: Record<string, string[]> | null
  requestContext: HttpRequestContext
  pathParameters: Record<string, string> | null
  body: string
  isBase64Encoded: boolean
  parameters?: Record<string, string> | null
  multiValueParameters?: Record<string, string[]> | null
  operationId?: string
}

export interface HttpResponse {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  body: string
  isBase64Encoded?: boolean
}
