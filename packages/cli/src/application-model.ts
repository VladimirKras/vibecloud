/** Pure application policy. Templates expand here once; adapters use explicit fields. */
export const aiCapabilities = ["responses", "realtime", "speechkit_stt", "speechkit_tts", "image_generation"] as const;
export type AiCapability = typeof aiCapabilities[number];
export type FunctionKind = "http" | "websocket" | "timer" | "stream";
export interface FunctionFeatures {
  ai?: AiCapability[]
  auth?: "provider" | "session"
  public_media?: boolean
}
export interface FunctionDefinition {
  handler: string
  template?: string
  kind?: FunctionKind
  features?: FunctionFeatures
  runtime?: string
  build?: { command: string, cwd?: string }
  memory_mb?: number
  timeout_seconds?: number
  cron?: { expression: string, payload?: string }
  triggers?: { stream: string }[]
}
export interface FunctionRoute {
  pattern: string
  method?: string
  function?: string
  assets?: string
}
export interface FunctionDeclaration {
  functions?: Record<string, FunctionDefinition>
  gateway: { routes?: FunctionRoute[] }
  observability?: { source_maps?: boolean, logs?: { enabled?: boolean }, metrics?: { enabled?: boolean }, traces?: { enabled?: boolean } }
}
const templates: Record<string, { kind?: FunctionKind, features?: FunctionFeatures, memory_mb?: number, timeout_seconds?: number }> = {
  "api": { kind: "http" },
  "ai-agent": { kind: "http", features: { ai: ["responses"], auth: "session" }, timeout_seconds: 30 },
  "ai-turn": { kind: "http", features: { ai: ["responses", "speechkit_stt", "speechkit_tts"], auth: "session" }, memory_mb: 256, timeout_seconds: 30 },
  "ai-image": { kind: "http", features: { ai: ["image_generation"], public_media: true }, memory_mb: 256, timeout_seconds: 120 },
  "better-auth": { kind: "http", features: { auth: "provider" } },
  "cron-trigger": { kind: "timer" },
  "datastream-trigger": { kind: "stream" },
  "websocket": { kind: "websocket" },
};

export function normalizeFunction(name: string, definition: FunctionDefinition, routes: FunctionRoute[]) {
  const defaults = templates[definition.template ?? ""] ?? {};
  return {
    ...definition,
    kind: definition.kind ?? defaults.kind ?? (definition.cron
      ? "timer"
      : definition.triggers?.length
        ? "stream"
        : routes.some((route) => route.function === name && route.method?.toUpperCase() === "WS") ? "websocket" : "http"),
    runtime: definition.runtime ?? "nodejs22",
    features: structuredClone(definition.features ?? defaults.features ?? {}),
    memory_mb: definition.memory_mb ?? defaults.memory_mb ?? 128,
    timeout_seconds: definition.timeout_seconds ?? defaults.timeout_seconds ?? 10,
  };
}

/** Materialized defaults survive template edits and are persisted by resource mutations. */
export function normalizeApplication<T extends FunctionDeclaration>(declaration: T): T {
  return {
    ...declaration,
    ...(declaration.functions
      ? { functions: Object.fromEntries(Object.entries(declaration.functions)
        .map(([name, definition]) => [name, normalizeFunction(name, definition, declaration.gateway.routes ?? [])])) }
      : {}),
  };
}
