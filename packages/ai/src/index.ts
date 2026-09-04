import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const defaultBaseUrl = "https://ai.api.cloud.yandex.net/v1";
const defaultRealtimeModel = "speech-realtime-250923";
const defaultSpeechKitSttUrl = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";
const defaultSpeechKitTtsUrl = "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis";
const defaultYandexArtUrl = "https://llm.api.cloud.yandex.net/foundationModels/v1/imageGenerationAsync";
const defaultYandexArtOperationsUrl = "https://llm.api.cloud.yandex.net/operations";

export interface AIStudioInvocationContext {
  functionFolderId?: string
  token?: { access_token?: string }
}

export interface AIStudioClientOptions {
  folderId?: string
  apiKey?: string
  iamToken?: string
  baseUrl?: string
  realtimeUrl?: string
  speechKitSttUrl?: string
  speechKitTtsUrl?: string
  yandexArtUrl?: string
  yandexArtOperationsUrl?: string
  dataLogging?: boolean
  fetch?: typeof globalThis.fetch
  environment?: Record<string, string | undefined>
  maxRetries?: number
}

export interface AIStudioResponse {
  id: string
  status?: "queued" | "in_progress" | "completed" | "incomplete" | "failed" | "cancelled" | string
  output_text?: string | null
  output?: unknown[]
  usage?: Record<string, unknown>
  error?: { message?: unknown } | null
  incomplete_details?: { reason?: unknown } | null
}

export type AIStudioMetadata = Record<string, string>;
export type AIStudioOrder = "asc" | "desc";

export interface AIStudioPage<T> {
  object: string
  data: T[]
  has_more?: boolean
  first_id?: string
  last_id?: string
  next_page?: string | null
}

export interface AIStudioListOptions {
  after?: string
  before?: string
  limit?: number
  order?: AIStudioOrder
}

export type AIStudioItem = {
  id?: string
  type: string
  [key: string]: unknown
};

export interface AIStudioModel {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export interface AIStudioConversation {
  id: string
  object: "conversation"
  metadata: AIStudioMetadata | null
  created_at: number
}

export interface AIStudioDeleted {
  id: string
  object: string
  deleted: boolean
}

export type AIStudioFilePurpose
  = | "assistants"
    | "assistants_output"
    | "batch"
    | "batch_output"
    | "fine-tune"
    | "fine-tune-results"
    | "vision"
    | "user_data";

export interface AIStudioFile {
  id: string
  object: "file"
  bytes: number
  created_at: number
  expires_at?: number
  filename: string
  purpose: AIStudioFilePurpose
  status?: "uploaded" | "processed" | "error"
  status_details?: string
  [key: string]: unknown
}

export interface AIStudioFileUpload {
  file: Blob
  filename?: string
  purpose: AIStudioFilePurpose
  format?: string
}

export interface AIStudioEmbedding {
  object: "embedding"
  embedding: number[] | string
  index: number
}

export interface AIStudioEmbeddingResponse {
  object: "list"
  data: AIStudioEmbedding[]
  model: string
  usage?: Record<string, unknown>
}

export interface AIStudioEmbeddingInput {
  model: string
  input: string | string[]
  dimensions?: number
  encoding_format?: "float" | "base64"
  user?: string
  [key: string]: unknown
}

export interface AIStudioImage {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

export interface AIStudioImageResponse {
  created: number
  data: AIStudioImage[]
  background?: "transparent" | "opaque"
  output_format?: "png" | "webp" | "jpeg"
  quality?: "low" | "medium" | "high"
  size?: "1024x1024" | "1024x1536" | "1536x1024"
  usage?: Record<string, unknown>
}

export interface AIStudioImageGenerationInput {
  prompt: string
  model?: string
  n?: number
  quality?: "low" | "medium" | "high"
  response_format?: "url" | "b64_json"
  size?: "1024x1024" | "1024x1536" | "1536x1024"
  output_format?: "png" | "webp" | "jpeg"
  user?: string
  [key: string]: unknown
}

export interface YandexArtGenerationInput {
  prompt: string
  negativePrompt?: string
  model?: string
  mimeType?: "image/jpeg"
  seed?: number
  aspectRatio?: {
    widthRatio: number
    heightRatio: number
  }
}

export interface YandexArtOperation {
  id: string
  done: boolean
  error?: {
    code?: number
    message?: string
    details?: unknown[]
  }
  response?: {
    image?: string
    modelVersion?: string
  }
}

export interface YandexArtImageResult {
  operationId: string
  dataBase64: string
  image: Uint8Array
  contentType: "image/jpeg"
  modelVersion?: string
}

export interface AIStudioVectorStoreFileCounts {
  in_progress: number
  completed: number
  failed: number
  cancelled: number
  total: number
}

export interface AIStudioVectorStore {
  id: string
  object: "vector_store"
  created_at: number
  name: string
  usage_bytes: number
  file_counts: AIStudioVectorStoreFileCounts
  status: "expired" | "in_progress" | "completed"
  expires_after?: { anchor: "last_active_at", days: number } | null
  expires_at?: number | null
  last_active_at?: number | null
  metadata?: AIStudioMetadata | null
  [key: string]: unknown
}

export interface AIStudioVectorStoreFile {
  id: string
  object: "vector_store.file"
  usage_bytes: number
  created_at: number
  vector_store_id: string
  status: "in_progress" | "completed" | "cancelled" | "failed"
  last_error?: { code?: string, message?: string } | null
  [key: string]: unknown
}

export interface AIStudioVectorStoreFileContent {
  object: "vector_store.file_content.page"
  data: Array<{ type: string, text: string }>
  has_more: boolean
  next_page: string | null
}

export interface AIStudioVectorStoreCreateInput {
  name?: string
  description?: string
  file_ids?: string[]
  expires_after?: { anchor: "last_active_at", days: number }
  chunking_strategy?: Record<string, unknown>
  metadata?: AIStudioMetadata
  [key: string]: unknown
}

export interface AIStudioVectorStoreSearchInput {
  query: string | string[]
  max_num_results?: number
  filters?: Record<string, unknown>
  ranking_options?: Record<string, unknown>
  rewrite_query?: boolean
  [key: string]: unknown
}

export interface AIStudioVectorStoreSearchResult {
  file_id: string
  filename: string
  score: number
  attributes: Record<string, string | number | boolean> | null
  content: Array<{ type: "text", text: string }>
}

export interface AIStudioVectorStoreSearchResponse {
  object: "vector_store.search_results.page"
  search_query: string[]
  data: AIStudioVectorStoreSearchResult[]
  has_more: boolean
  next_page: string | null
}

export interface AIStudioVectorStoreFileCreateInput {
  file_id: string
  chunking_strategy?: Record<string, unknown>
  attributes?: Record<string, string | number | boolean> | null
  [key: string]: unknown
}

export interface RealtimeServerConnection {
  url: string
  headers: Readonly<Record<string, string>>
}

export type SpeechRecognitionFormat = "lpcm" | "oggopus";
export type SpeechSynthesisFormat = "mp3" | "oggopus" | "wav";

export interface SpeechRecognitionOptions {
  format?: SpeechRecognitionFormat
  language?: string
  topic?: string
  sampleRateHertz?: number
  signal?: AbortSignal
}

export interface SpeechSynthesisOptions {
  format?: SpeechSynthesisFormat
  voice?: string
  role?: string
  speed?: number
  signal?: AbortSignal
}

export interface SpeechSynthesisResult {
  audio: Uint8Array
  contentType: string
  format: SpeechSynthesisFormat
}

export interface AIStudioClient {
  readonly folderId: string
  model(nameOrUri: string): string
  request(path: string, init?: RequestInit): Promise<Response>
  responses: {
    create<T extends AIStudioResponse = AIStudioResponse>(input: Record<string, unknown>, init?: RequestInit): Promise<T>
    stream(input: Record<string, unknown>, init?: RequestInit): Promise<Response>
    retrieve<T extends AIStudioResponse = AIStudioResponse>(responseId: string, init?: RequestInit): Promise<T>
    cancel<T extends AIStudioResponse = AIStudioResponse>(responseId: string, init?: RequestInit): Promise<T>
    delete(responseId: string, init?: RequestInit): Promise<void>
    listInputItems<T extends AIStudioItem = AIStudioItem>(
      responseId: string,
      options?: Omit<AIStudioListOptions, "before">,
      init?: RequestInit,
    ): Promise<AIStudioPage<T>>
  }
  models: {
    list(init?: RequestInit): Promise<AIStudioPage<AIStudioModel>>
  }
  conversations: {
    create(input?: { metadata?: AIStudioMetadata, items?: AIStudioItem[] }, init?: RequestInit): Promise<AIStudioConversation>
    retrieve(conversationId: string, init?: RequestInit): Promise<AIStudioConversation>
    update(conversationId: string, input: { metadata: AIStudioMetadata }, init?: RequestInit): Promise<AIStudioConversation>
    delete(conversationId: string, init?: RequestInit): Promise<AIStudioDeleted>
    listItems<T extends AIStudioItem = AIStudioItem>(
      conversationId: string,
      options?: Omit<AIStudioListOptions, "before">,
      init?: RequestInit,
    ): Promise<AIStudioPage<T>>
    createItems<T extends AIStudioItem = AIStudioItem>(
      conversationId: string,
      items: AIStudioItem[],
      init?: RequestInit,
    ): Promise<AIStudioPage<T>>
  }
  files: {
    list(options?: AIStudioListOptions & { purpose?: AIStudioFilePurpose }, init?: RequestInit): Promise<AIStudioPage<AIStudioFile>>
    create(input: AIStudioFileUpload, init?: RequestInit): Promise<AIStudioFile>
    retrieve(fileId: string, init?: RequestInit): Promise<AIStudioFile>
    delete(fileId: string, init?: RequestInit): Promise<AIStudioDeleted>
    content(fileId: string, init?: RequestInit): Promise<Response>
  }
  embeddings: {
    create(input: AIStudioEmbeddingInput, init?: RequestInit): Promise<AIStudioEmbeddingResponse>
  }
  images: {
    generate(input: AIStudioImageGenerationInput, init?: RequestInit): Promise<AIStudioImageResponse>
  }
  yandexArt: {
    start(input: YandexArtGenerationInput, init?: RequestInit): Promise<YandexArtOperation>
    retrieve(operationId: string, init?: RequestInit): Promise<YandexArtOperation>
  }
  vectorStores: {
    list(options?: AIStudioListOptions, init?: RequestInit): Promise<AIStudioPage<AIStudioVectorStore>>
    create(input: AIStudioVectorStoreCreateInput, init?: RequestInit): Promise<AIStudioVectorStore>
    retrieve(vectorStoreId: string, init?: RequestInit): Promise<AIStudioVectorStore>
    update(vectorStoreId: string, input: Record<string, unknown>, init?: RequestInit): Promise<AIStudioVectorStore>
    delete(vectorStoreId: string, init?: RequestInit): Promise<AIStudioDeleted>
    search(
      vectorStoreId: string,
      input: AIStudioVectorStoreSearchInput,
      init?: RequestInit,
    ): Promise<AIStudioVectorStoreSearchResponse>
    files: {
      create(vectorStoreId: string, input: AIStudioVectorStoreFileCreateInput, init?: RequestInit): Promise<AIStudioVectorStoreFile>
      retrieve(vectorStoreId: string, fileId: string, init?: RequestInit): Promise<AIStudioVectorStoreFile>
      content(vectorStoreId: string, fileId: string, init?: RequestInit): Promise<AIStudioVectorStoreFileContent>
      delete(vectorStoreId: string, fileId: string, init?: RequestInit): Promise<AIStudioDeleted>
    }
  }
  speech: {
    transcribe(audio: ArrayBuffer | Uint8Array, options?: SpeechRecognitionOptions): Promise<string>
    synthesize(text: string, options?: SpeechSynthesisOptions): Promise<SpeechSynthesisResult>
  }
  realtimeServerConnection(model?: string): RealtimeServerConnection
}

export class AIStudioRequestError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly serverTraceId?: string;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, options: string | {
    requestId?: string
    serverTraceId?: string
    retryAfterMs?: number
  } = {}) {
    super(`Yandex AI Studio request failed (${status}): ${message}`);
    this.name = "AIStudioRequestError";
    this.status = status;
    const details = typeof options === "string" ? { requestId: options } : options;
    this.requestId = details.requestId;
    this.serverTraceId = details.serverTraceId;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export class AIStudioResponseError extends Error {
  readonly responseId: string;
  readonly status: string;

  constructor(response: AIStudioResponse, message: string) {
    super(`Yandex AI Studio response ${response.id} is ${response.status ?? "invalid"}: ${message}`);
    this.name = "AIStudioResponseError";
    this.responseId = response.id;
    this.status = response.status ?? "invalid";
  }
}

export class YandexArtOperationError extends Error {
  readonly operationId: string;
  readonly code?: number;

  constructor(operation: YandexArtOperation, message: string) {
    super(`YandexART operation ${operation.id} failed: ${message}`);
    this.name = "YandexArtOperationError";
    this.operationId = operation.id;
    this.code = operation.error?.code;
  }
}

export function requireAIStudioOutputText(response: AIStudioResponse): string {
  const text = response.output_text?.trim() || nestedOutputText(response.output);
  if (response.status !== undefined && response.status !== "completed") {
    const detail = response.error?.message ?? response.incomplete_details?.reason;
    throw new AIStudioResponseError(
      response,
      typeof detail === "string" && detail.trim() ? detail.trim() : "no completed output is available",
    );
  }
  if (!text) throw new AIStudioResponseError(response, "no output text is available");
  return text;
}

export function requireYandexArtImage(operation: YandexArtOperation): YandexArtImageResult {
  if (!operation.done) throw new YandexArtOperationError(operation, "image generation is still in progress");
  if (operation.error) {
    throw new YandexArtOperationError(operation, operation.error.message?.trim() || "the service returned an error");
  }
  const dataBase64 = operation.response?.image?.trim();
  if (!dataBase64) throw new YandexArtOperationError(operation, "no generated image is available");
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    throw new YandexArtOperationError(operation, "the generated image is not valid base64");
  }
  const image = Buffer.from(dataBase64, "base64");
  if (image.byteLength === 0) throw new YandexArtOperationError(operation, "the generated image is empty");
  return {
    operationId: operation.id,
    dataBase64,
    image,
    contentType: "image/jpeg",
    ...(operation.response?.modelVersion ? { modelVersion: operation.response.modelVersion } : {}),
  };
}

function nestedOutputText(output: unknown[] | undefined): string {
  const parts: string[] = [];
  for (const item of output ?? []) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const candidate = part as { type?: unknown, text?: unknown };
      if (candidate.type === "output_text" && typeof candidate.text === "string" && candidate.text.trim()) {
        parts.push(candidate.text.trim());
      }
    }
  }
  return parts.join("\n");
}

export interface AIEndpointAccess {
  remaining: number
  limit: number
}

export interface AIRateLimiterOptions {
  requestsPerMinute?: number
  environment?: Record<string, string | undefined>
  now?: () => number
}

export class AIEndpointError extends Error {
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;

  constructor(statusCode: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AIEndpointError";
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AIRateLimiter {
  check(principal: string): AIEndpointAccess
}

export function createAIRateLimiter(options: AIRateLimiterOptions = {}): AIRateLimiter {
  const environment = options.environment ?? process.env;
  const limit = options.requestsPerMinute
    ?? positiveInteger(environment.VIBECLOUD_AI_REQUESTS_PER_MINUTE, 20);
  const now = options.now ?? Date.now;
  const windows = new Map<string, { minute: number, count: number }>();

  return {
    check(principal) {
      const minute = Math.floor(now() / 60_000);
      const current = windows.get(principal);
      const count = current?.minute === minute ? current.count + 1 : 1;
      windows.set(principal, { minute, count });
      if (windows.size > 1_000) {
        for (const [key, value] of windows) if (value.minute < minute) windows.delete(key);
      }
      if (count > limit) throw new AIEndpointError(429, "AI request rate limit exceeded", 60 - Math.floor(now() / 1000) % 60);
      return { remaining: Math.max(0, limit - count), limit };
    },
  };
}

export function createAIContinuation(
  responseId: string,
  principal: string,
  secret: string,
  ttlSeconds = 3600,
  now = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({
    responseId,
    principal: digest(principal),
    expiresAt: Math.floor(now / 1000) + ttlSeconds,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function readAIContinuation(
  token: string,
  principal: string,
  secret: string,
  now = Date.now(),
): string {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !secureEqual(signature, sign(payload, secret))) {
    throw new AIEndpointError(400, "continuation is invalid");
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.responseId !== "string"
      || value.principal !== digest(principal)
      || typeof value.expiresAt !== "number") throw new Error("invalid payload");
    if (value.expiresAt < Math.floor(now / 1000)) throw new AIEndpointError(400, "continuation has expired");
    return value.responseId;
  } catch (error) {
    if (error instanceof AIEndpointError) throw error;
    throw new AIEndpointError(400, "continuation is invalid");
  }
}

export function createAIStudioClient(
  context: AIStudioInvocationContext = {},
  options: AIStudioClientOptions = {},
): AIStudioClient {
  const environment = options.environment ?? process.env;
  const folderId = first(
    options.folderId,
    environment.YANDEX_CLOUD_FOLDER_ID,
    environment.YANDEX_FOLDER_ID,
    context.functionFolderId === "local" ? undefined : context.functionFolderId,
  );
  if (!folderId) {
    throw new Error("Yandex AI Studio requires a folder ID; set YANDEX_CLOUD_FOLDER_ID for local development");
  }

  const explicitAuthorization = options.apiKey
    ? `Api-Key ${options.apiKey}`
    : options.iamToken
      ? `Bearer ${options.iamToken}`
      : undefined;
  const iamToken = first(
    context.token?.access_token,
    environment.YANDEX_CLOUD_IAM_TOKEN,
    environment.YC_TOKEN,
  );
  const apiKey = first(environment.YANDEX_CLOUD_API_KEY, environment.YANDEX_AI_API_KEY);
  const authorization = explicitAuthorization
    ?? (iamToken ? `Bearer ${iamToken}` : undefined)
    ?? (apiKey ? `Api-Key ${apiKey}` : undefined);
  if (!authorization) {
    throw new Error("Yandex AI Studio requires the function IAM token or YANDEX_CLOUD_API_KEY for local development");
  }

  const baseUrl = (options.baseUrl ?? environment.YANDEX_AI_BASE_URL ?? defaultBaseUrl).replace(/\/+$/, "");
  const realtimeUrl = options.realtimeUrl
    ?? environment.YANDEX_AI_REALTIME_URL
    ?? `${baseUrl}/realtime`;
  const speechKitSttUrl = options.speechKitSttUrl
    ?? environment.YANDEX_SPEECHKIT_STT_URL
    ?? defaultSpeechKitSttUrl;
  const speechKitTtsUrl = options.speechKitTtsUrl
    ?? environment.YANDEX_SPEECHKIT_TTS_URL
    ?? defaultSpeechKitTtsUrl;
  const yandexArtUrl = options.yandexArtUrl
    ?? environment.YANDEX_ART_URL
    ?? defaultYandexArtUrl;
  const yandexArtOperationsUrl = (options.yandexArtOperationsUrl
    ?? environment.YANDEX_ART_OPERATIONS_URL
    ?? defaultYandexArtOperationsUrl).replace(/\/+$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maxRetries = Math.max(0, Math.min(3, options.maxRetries ?? 2));
  const model = (nameOrUri: string) => {
    const value = nameOrUri.trim();
    if (!value) throw new Error("Yandex AI Studio model name cannot be empty");
    return value.includes("://") ? value : `gpt://${folderId}/${value}`;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const url = apiUrl(baseUrl, path);
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("OpenAI-Project", folderId);
    headers.set("x-data-logging-enabled", options.dataLogging === true ? "true" : "false");
    if (!headers.has("x-client-request-id")) headers.set("x-client-request-id", randomUUID());
    return checkedFetch(fetchImplementation, url, { ...init, headers }, maxRetries);
  };
  const speechRequest = async (url: URL, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("x-folder-id", folderId);
    if (!headers.has("x-client-request-id")) headers.set("x-client-request-id", randomUUID());
    return checkedFetch(fetchImplementation, url, { ...init, headers }, maxRetries);
  };
  const yandexArtRequest = async (url: URL, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("x-folder-id", folderId);
    if (!headers.has("x-client-request-id")) headers.set("x-client-request-id", randomUUID());
    return checkedFetch(fetchImplementation, url, { ...init, headers }, maxRetries);
  };

  return {
    folderId,
    model,
    request,
    responses: {
      async create<T extends AIStudioResponse = AIStudioResponse>(input: Record<string, unknown>, init: RequestInit = {}): Promise<T> {
        const response = await request("responses", mergeRequest(jsonRequest(input), init));
        return readJson<T>(response);
      },
      stream(input: Record<string, unknown>, init: RequestInit = {}) {
        return request("responses", mergeRequest(jsonRequest({ ...input, stream: true }), init));
      },
      async retrieve<T extends AIStudioResponse = AIStudioResponse>(responseId: string, init: RequestInit = {}): Promise<T> {
        return readJson<T>(await request(resourcePath("responses", responseId), { ...init, method: "GET" }));
      },
      async cancel<T extends AIStudioResponse = AIStudioResponse>(responseId: string, init: RequestInit = {}): Promise<T> {
        return readJson<T>(await request(`${resourcePath("responses", responseId)}/cancel`, { ...init, method: "POST" }));
      },
      async delete(responseId: string, init: RequestInit = {}): Promise<void> {
        await request(resourcePath("responses", responseId), { ...init, method: "DELETE" });
      },
      async listInputItems<T extends AIStudioItem = AIStudioItem>(responseId: string, listOptions = {}, init: RequestInit = {}) {
        const path = withQuery(`${resourcePath("responses", responseId)}/input_items`, listOptions);
        return readJson<AIStudioPage<T>>(await request(path, { ...init, method: "GET" }));
      },
    },
    models: {
      async list(init: RequestInit = {}) {
        return readJson<AIStudioPage<AIStudioModel>>(await request("models", { ...init, method: "GET" }));
      },
    },
    conversations: {
      async create(input = {}, init: RequestInit = {}) {
        return readJson<AIStudioConversation>(await request("conversations", mergeRequest(jsonRequest(input), init)));
      },
      async retrieve(conversationId: string, init: RequestInit = {}) {
        return readJson<AIStudioConversation>(
          await request(resourcePath("conversations", conversationId), { ...init, method: "GET" }),
        );
      },
      async update(conversationId: string, input: { metadata: AIStudioMetadata }, init: RequestInit = {}) {
        return readJson<AIStudioConversation>(
          await request(resourcePath("conversations", conversationId), mergeRequest(jsonRequest(input), init)),
        );
      },
      async delete(conversationId: string, init: RequestInit = {}) {
        return readJson<AIStudioDeleted>(
          await request(resourcePath("conversations", conversationId), { ...init, method: "DELETE" }),
        );
      },
      async listItems<T extends AIStudioItem = AIStudioItem>(conversationId: string, listOptions = {}, init: RequestInit = {}) {
        const path = withQuery(`${resourcePath("conversations", conversationId)}/items`, listOptions);
        return readJson<AIStudioPage<T>>(await request(path, { ...init, method: "GET" }));
      },
      async createItems<T extends AIStudioItem = AIStudioItem>(conversationId: string, items: AIStudioItem[], init: RequestInit = {}) {
        const path = `${resourcePath("conversations", conversationId)}/items`;
        return readJson<AIStudioPage<T>>(await request(path, mergeRequest(jsonRequest({ items }), init)));
      },
    },
    files: {
      async list(listOptions = {}, init: RequestInit = {}) {
        return readJson<AIStudioPage<AIStudioFile>>(
          await request(withQuery("files", listOptions), { ...init, method: "GET" }),
        );
      },
      async create(input: AIStudioFileUpload, init: RequestInit = {}) {
        const form = new FormData();
        if (input.filename === undefined) form.set("file", input.file);
        else form.set("file", input.file, input.filename);
        form.set("purpose", input.purpose);
        if (input.format !== undefined) form.set("format", input.format);
        return readJson<AIStudioFile>(await request("files", mergeRequest({ method: "POST", body: form }, init)));
      },
      async retrieve(fileId: string, init: RequestInit = {}) {
        return readJson<AIStudioFile>(await request(resourcePath("files", fileId), { ...init, method: "GET" }));
      },
      async delete(fileId: string, init: RequestInit = {}) {
        return readJson<AIStudioDeleted>(await request(resourcePath("files", fileId), { ...init, method: "DELETE" }));
      },
      content(fileId: string, init: RequestInit = {}) {
        return request(`${resourcePath("files", fileId)}/content`, { ...init, method: "GET" });
      },
    },
    embeddings: {
      async create(input: AIStudioEmbeddingInput, init: RequestInit = {}) {
        return readJson<AIStudioEmbeddingResponse>(await request("embeddings", mergeRequest(jsonRequest(input), init)));
      },
    },
    images: {
      async generate(input: AIStudioImageGenerationInput, init: RequestInit = {}) {
        return readJson<AIStudioImageResponse>(await request("images/generations", mergeRequest(jsonRequest(input), init)));
      },
    },
    yandexArt: {
      async start(input, init: RequestInit = {}) {
        const prompt = input.prompt.trim();
        if (!prompt) throw new Error("YandexART prompt cannot be empty");
        const modelName = input.model?.trim() || "yandex-art";
        const modelUri = modelName.includes("://") ? modelName : `art://${folderId}/${modelName}/latest`;
        const negativePrompt = input.negativePrompt?.trim();
        const aspectRatio = input.aspectRatio;
        if (aspectRatio && (!Number.isSafeInteger(aspectRatio.widthRatio)
          || aspectRatio.widthRatio <= 0
          || !Number.isSafeInteger(aspectRatio.heightRatio)
          || aspectRatio.heightRatio <= 0)) {
          throw new Error("YandexART aspect ratio values must be positive integers");
        }
        if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) {
          throw new Error("YandexART seed must be a non-negative integer");
        }
        const body = {
          modelUri,
          messages: [
            { text: prompt, weight: "1" },
            ...(negativePrompt ? [{ text: negativePrompt, weight: "-1" }] : []),
          ],
          generationOptions: {
            mimeType: input.mimeType ?? "image/jpeg",
            ...(input.seed === undefined ? {} : { seed: String(input.seed) }),
            ...(aspectRatio
              ? { aspectRatio: { widthRatio: String(aspectRatio.widthRatio), heightRatio: String(aspectRatio.heightRatio) } }
              : {}),
          },
        };
        return readJson<YandexArtOperation>(await yandexArtRequest(
          new URL(yandexArtUrl),
          mergeRequest(jsonRequest(body), init),
        ));
      },
      async retrieve(operationId, init: RequestInit = {}) {
        const id = requiredId(operationId, "YandexART operation");
        return readJson<YandexArtOperation>(await yandexArtRequest(
          new URL(`${yandexArtOperationsUrl}/${encodeURIComponent(id)}`),
          { ...init, method: "GET" },
        ));
      },
    },
    vectorStores: {
      async list(listOptions = {}, init: RequestInit = {}) {
        return readJson<AIStudioPage<AIStudioVectorStore>>(
          await request(withQuery("vector_stores", listOptions), { ...init, method: "GET" }),
        );
      },
      async create(input: AIStudioVectorStoreCreateInput, init: RequestInit = {}) {
        return readJson<AIStudioVectorStore>(await request("vector_stores", mergeRequest(jsonRequest(input), init)));
      },
      async retrieve(vectorStoreId: string, init: RequestInit = {}) {
        return readJson<AIStudioVectorStore>(
          await request(resourcePath("vector_stores", vectorStoreId), { ...init, method: "GET" }),
        );
      },
      async update(vectorStoreId: string, input: Record<string, unknown>, init: RequestInit = {}) {
        return readJson<AIStudioVectorStore>(
          await request(resourcePath("vector_stores", vectorStoreId), mergeRequest(jsonRequest(input), init)),
        );
      },
      async delete(vectorStoreId: string, init: RequestInit = {}) {
        return readJson<AIStudioDeleted>(
          await request(resourcePath("vector_stores", vectorStoreId), { ...init, method: "DELETE" }),
        );
      },
      async search(vectorStoreId: string, input: AIStudioVectorStoreSearchInput, init: RequestInit = {}) {
        const path = `${resourcePath("vector_stores", vectorStoreId)}/search`;
        return readJson<AIStudioVectorStoreSearchResponse>(await request(path, mergeRequest(jsonRequest(input), init)));
      },
      files: {
        async create(vectorStoreId: string, input: AIStudioVectorStoreFileCreateInput, init: RequestInit = {}) {
          const path = `${resourcePath("vector_stores", vectorStoreId)}/files`;
          return readJson<AIStudioVectorStoreFile>(await request(path, mergeRequest(jsonRequest(input), init)));
        },
        async retrieve(vectorStoreId: string, fileId: string, init: RequestInit = {}) {
          return readJson<AIStudioVectorStoreFile>(
            await request(vectorStoreFilePath(vectorStoreId, fileId), { ...init, method: "GET" }),
          );
        },
        async content(vectorStoreId: string, fileId: string, init: RequestInit = {}) {
          return readJson<AIStudioVectorStoreFileContent>(
            await request(`${vectorStoreFilePath(vectorStoreId, fileId)}/content`, { ...init, method: "GET" }),
          );
        },
        async delete(vectorStoreId: string, fileId: string, init: RequestInit = {}) {
          return readJson<AIStudioDeleted>(
            await request(vectorStoreFilePath(vectorStoreId, fileId), { ...init, method: "DELETE" }),
          );
        },
      },
    },
    speech: {
      async transcribe(audio, speechOptions = {}) {
        const byteLength = audio.byteLength;
        if (byteLength === 0) throw new Error("SpeechKit recognition audio cannot be empty");
        if (byteLength > 1_000_000) throw new Error("SpeechKit synchronous recognition audio cannot exceed 1 MB");
        const format = speechOptions.format ?? "oggopus";
        if (format === "lpcm" && speechOptions.sampleRateHertz === undefined) {
          throw new Error("SpeechKit LPCM recognition requires sampleRateHertz");
        }
        const url = new URL(speechKitSttUrl);
        url.searchParams.set("folderId", folderId);
        url.searchParams.set("format", format);
        url.searchParams.set("lang", speechOptions.language ?? "ru-RU");
        url.searchParams.set("topic", speechOptions.topic ?? "general");
        if (speechOptions.sampleRateHertz !== undefined) {
          url.searchParams.set("sampleRateHertz", String(speechOptions.sampleRateHertz));
        }
        const response = await speechRequest(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: audio as BodyInit,
          signal: speechOptions.signal,
        });
        const result = await response.json() as { result?: unknown };
        if (typeof result.result !== "string") throw new Error("SpeechKit recognition returned no transcript");
        return result.result;
      },
      async synthesize(text, speechOptions = {}) {
        const input = text.trim();
        if (!input) throw new Error("SpeechKit synthesis text cannot be empty");
        const format = speechOptions.format ?? "mp3";
        if ([...input].length > 250) throw new Error("SpeechKit synthesis text cannot exceed 250 characters; split it into utterances");
        if (speechOptions.speed !== undefined && (
          !Number.isFinite(speechOptions.speed) || speechOptions.speed < 0.1 || speechOptions.speed > 3
        )) throw new Error("SpeechKit synthesis speed must be between 0.1 and 3");
        const response = await speechRequest(new URL(speechKitTtsUrl), mergeRequest(jsonRequest({
          text: input,
          outputAudioSpec: { containerAudio: { containerAudioType: speechContainerFormat(format) } },
          hints: [
            { voice: speechOptions.voice ?? "marina" },
            ...(speechOptions.role ? [{ role: speechOptions.role }] : []),
            ...(speechOptions.speed === undefined ? [] : [{ speed: speechOptions.speed }]),
          ],
        }), { signal: speechOptions.signal }));
        const result = await response.json() as {
          audioChunk?: { data?: unknown }
          result?: { audioChunk?: { data?: unknown } }
        };
        const data = result.audioChunk?.data ?? result.result?.audioChunk?.data;
        if (typeof data !== "string" || !data) throw new Error("SpeechKit synthesis returned no audio");
        return {
          audio: Buffer.from(data, "base64"),
          contentType: speechContentType(format),
          format,
        };
      },
    },
    realtimeServerConnection(name = defaultRealtimeModel) {
      const url = new URL(realtimeUrl);
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      url.searchParams.set("model", model(name));
      return {
        url: url.href,
        headers: Object.freeze({
          "Authorization": authorization,
          "OpenAI-Project": folderId,
          "x-data-logging-enabled": options.dataLogging === true ? "true" : "false",
        }),
      };
    },
  };
}

function apiUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error("AI Studio request path must be relative");
  const normalized = path.replace(/^\/+/, "");
  if (!normalized) throw new Error("AI Studio request path cannot be empty");
  return `${baseUrl}/${normalized}`;
}

function resourcePath(resource: string, id: string): string {
  const value = id.trim();
  if (!value) throw new Error(`AI Studio ${resource.replaceAll("_", " ")} ID cannot be empty`);
  return `${resource}/${encodeURIComponent(value)}`;
}

function vectorStoreFilePath(vectorStoreId: string, fileId: string): string {
  return `${resourcePath("vector_stores", vectorStoreId)}/files/${encodeURIComponent(requiredId(fileId, "file"))}`;
}

function requiredId(id: string, name: string): string {
  const value = id.trim();
  if (!value) throw new Error(`AI Studio ${name} ID cannot be empty`);
  return value;
}

function withQuery<T extends object>(
  path: string,
  values: T,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      query.set(key, String(value));
    }
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function mergeRequest(base: RequestInit, override: RequestInit): RequestInit {
  const headers = new Headers(base.headers);
  new Headers(override.headers).forEach((value, key) => headers.set(key, value));
  return { ...base, ...override, headers };
}

async function checkedFetch(
  fetchImplementation: typeof globalThis.fetch,
  url: string | URL,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const retryableMethod = method === "GET" || method === "HEAD" || headers.has("idempotency-key");
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImplementation(url, init);
      if (response.ok) return response;
      const retry = retryableMethod
        && attempt < maxRetries
        && (response.status === 429 || response.status >= 500);
      if (!retry) throw await requestError(response);
      await delay(retryDelayMs(response, attempt), init.signal);
    } catch (error) {
      if (error instanceof AIStudioRequestError || init.signal?.aborted || isAbortError(error) || !retryableMethod || attempt >= maxRetries) {
        throw error;
      }
      await delay(Math.min(1_000, 100 * 2 ** attempt), init.signal);
    }
  }
}

async function requestError(response: Response): Promise<AIStudioRequestError> {
  let message = response.statusText || "request rejected";
  try {
    const body = await response.json() as {
      error?: { message?: unknown }
      error_message?: unknown
      message?: unknown
    };
    const detail = body.error?.message ?? body.error_message ?? body.message;
    if (typeof detail === "string" && detail.trim()) message = detail.trim();
  } catch {
    // The status and request ID are still actionable when the body is not JSON.
  }
  return new AIStudioRequestError(response.status, message, {
    requestId: response.headers.get("x-request-id") ?? undefined,
    serverTraceId: response.headers.get("x-server-trace-id") ?? undefined,
    retryAfterMs: retryAfterMs(response),
  });
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelayMs(response: Response, attempt: number): number {
  return Math.min(5_000, retryAfterMs(response) ?? 100 * 2 ** attempt);
}

function delay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function speechContainerFormat(format: SpeechSynthesisFormat): "MP3" | "OGG_OPUS" | "WAV" {
  return format === "oggopus" ? "OGG_OPUS" : format.toUpperCase() as "MP3" | "WAV";
}

function speechContentType(format: SpeechSynthesisFormat): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "oggopus") return "audio/ogg; codecs=opus";
  return "audio/wav";
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value) => Boolean(value));
}
