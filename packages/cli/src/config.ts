import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { readProjectMetadata, type ProjectMetadata } from "./project-metadata.ts";

const applicationName = z.string().regex(
  /^[a-z][a-z0-9-]{2,62}$/,
  "must start with a lowercase letter and contain 3-63 lowercase letters, digits, or hyphens",
);
const resourceKey = z.string().max(63).regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  "must use a lowercase kebab-case resource name",
);
const environmentVariableName = z.string().regex(
  /^[A-Z_][A-Z0-9_]*$/,
  "must use an uppercase environment variable name",
);
const streamReference = z.string().regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  "must reference a stream as database.stream",
);
const positiveNumber = z.number().positive();
const integerInRange = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
const logLevel = z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);
const functionHandler = z.string().regex(
  /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z_$][A-Za-z0-9_$]*$/,
  "must be a safe module path followed by an exported handler name",
);
const routePattern = z.string().regex(
  /^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+|\*)?$/,
  "must be an absolute path of URL-safe literal segments with an optional trailing wildcard",
);
const bucketName = z.string().min(3).max(63).regex(
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/,
  "must use lowercase letters, digits, dots, or hyphens and start and end with a letter or digit",
).refine((value) => !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value), "must not look like an IPv4 address");

const buildSchema = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});
const assetsSchema = z.strictObject({
  template: z.enum(["vite"]).optional(),
  build: buildSchema,
  fallback: z.string().min(1).optional(),
  cloud_name: bucketName.optional(),
});
const streamTriggerSchema = z.strictObject({
  stream: streamReference,
  batch_size_bytes: integerInRange(1, 65_536).optional(),
  batch_cutoff_seconds: integerInRange(1, 60).optional(),
  retry_attempts: integerInRange(1, 5).optional(),
  retry_interval_seconds: integerInRange(10, 60).optional(),
  dead_letter_queue: z.string().min(1).optional(),
});

interface CronField {
  name: string
  minimum: number
  maximum: number
  names?: readonly string[]
  special?: "dayOfMonth" | "dayOfWeek"
}

const cronFields: readonly CronField[] = [
  { name: "minutes", minimum: 0, maximum: 59 },
  { name: "hours", minimum: 0, maximum: 23 },
  { name: "day of month", minimum: 1, maximum: 31, special: "dayOfMonth" },
  { name: "month", minimum: 1, maximum: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", minimum: 1, maximum: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], special: "dayOfWeek" },
  { name: "year", minimum: 1970, maximum: 2099 },
] as const;

function cronValue(value: string, field: CronField): number | undefined {
  const numeric = Number(value);
  if (Number.isInteger(numeric)) return numeric;
  const named = field.names?.indexOf(value.toUpperCase());
  return named === undefined || named < 0 ? undefined : field.minimum + named;
}

function validCronAtom(atom: string, field: CronField): boolean {
  const [base, step, ...extra] = atom.split("/");
  if (extra.length > 0 || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) return false;
  if (base === "*") return true;
  if (base === "?" && field.special !== undefined) return step === undefined;
  if (field.special === "dayOfMonth" && /^(?:L|LW|(?:[1-9]|[12]\d|3[01])W)$/i.test(base)) return step === undefined;
  if (field.special === "dayOfWeek" && /^(?:(?:[1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)L|(?:[1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)#[1-5]|L)$/i.test(base)) return step === undefined;
  const bounds = base.split("-");
  if (bounds.length > 2) return false;
  const values = bounds.map((value) => cronValue(value, field));
  return values.every((value) => value !== undefined && value >= field.minimum && value <= field.maximum)
    && (values.length === 1 || values[0]! <= values[1]!);
}

export function validateCronExpression(expression: string): boolean {
  const values = expression.trim().split(/\s+/);
  if (![5, 6].includes(values.length)) return false;
  if (!values.every((value, index) => value.split(",").every((atom) => atom.length > 0 && validCronAtom(atom, cronFields[index]!)))) return false;
  const dayOfMonthAny = values[2] === "?";
  const dayOfWeekAny = values[4] === "?";
  return dayOfMonthAny !== dayOfWeekAny;
}

const cronTriggerSchema = z.strictObject({
  expression: z.string().min(1).refine(validateCronExpression, "must be a valid Yandex Cloud cron expression"),
  payload: z.string().max(4096).optional(),
});
const functionSchema = z.strictObject({
  template: z.enum(["api", "ai-agent", "ai-image", "ai-turn", "better-auth", "cron-trigger", "datastream-trigger", "websocket"]).optional(),
  handler: functionHandler,
  database: resourceKey.optional(),
  runtime: z.string().min(1).optional(),
  build: buildSchema.optional(),
  memory_mb: positiveNumber.optional(),
  timeout_seconds: positiveNumber.optional(),
  triggers: z.array(streamTriggerSchema).optional(),
  cron: cronTriggerSchema.optional(),
});
const databaseSchema = z.strictObject({
  migrations: z.boolean().optional(),
  streams: z.record(resourceKey, z.strictObject({})).optional(),
});
const bucketSchema = z.strictObject({
  cloud_name: bucketName.optional(),
});
const routeSchema = z.strictObject({
  pattern: routePattern,
  method: z.string().refine(
    (value) => /^(ANY|GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|WS)$/i.test(value),
    "must be ANY, an HTTP method, or WS",
  ).optional(),
  function: resourceKey.optional(),
  assets: resourceKey.optional(),
}).refine((route) => Number(route.assets !== undefined) + Number(route.function !== undefined) === 1, {
  message: "must target exactly one function or assets bundle",
});

const declarationShape = {
  name: applicationName,
  folder_id: z.string().min(1).optional(),
  gateway: z.strictObject({ routes: z.array(routeSchema).optional() }),
  assets: z.record(resourceKey, assetsSchema).optional(),
  functions: z.record(resourceKey, functionSchema).optional(),
  databases: z.record(resourceKey, databaseSchema).optional(),
  buckets: z.record(resourceKey, bucketSchema).optional(),
  vars: z.record(environmentVariableName, z.unknown()).optional(),
  ai: z.strictObject({
    responses: z.boolean().optional(),
    realtime: z.boolean().optional(),
    speechkit_stt: z.boolean().optional(),
    speechkit_tts: z.boolean().optional(),
    image_generation: z.boolean().optional(),
  }).optional(),
  secrets: z.strictObject({
    entries: z.record(environmentVariableName, z.strictObject({})).refine(
      (entries) => Object.keys(entries).length > 0,
      "must declare at least one generated secret entry",
    ),
  }).optional(),
  observability: z.strictObject({
    logs: z.strictObject({
      enabled: z.boolean(),
      min_level: logLevel.optional(),
      cluster: z.string().min(1).max(63).optional(),
    }).optional(),
    platform_logs: z.strictObject({
      enabled: z.boolean(),
      min_level: logLevel.optional(),
    }).optional(),
    metrics: z.strictObject({
      enabled: z.boolean(),
      cluster: z.string().min(1).max(63).optional(),
    }).optional(),
    traces: z.strictObject({
      enabled: z.boolean(),
      sample_rate: z.number().min(0).max(1).optional(),
      cluster: z.string().min(1).max(63).optional(),
    }).optional(),
    source_maps: z.boolean().optional(),
  }).optional(),
};

export const configSchema = z.strictObject(declarationShape).superRefine((config, context) => {
  const assets = new Set(Object.keys(config.assets ?? {}));
  const functions = new Set(Object.keys(config.functions ?? {}));
  const logsEnabled = config.observability?.logs?.enabled === true;
  const metricsEnabled = config.observability?.metrics?.enabled === true;
  const tracesEnabled = config.observability?.traces?.enabled === true;
  if (logsEnabled || metricsEnabled || tracesEnabled) {
    if (config.vars?.MONIUM_API_KEY !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["vars", "MONIUM_API_KEY"],
        message: "is reserved when Monium observability is enabled",
      });
    }
    if (config.secrets?.entries.MONIUM_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["secrets", "entries", "MONIUM_API_KEY"],
        message: "is managed automatically when Monium observability is enabled",
      });
    }
  }
  const metricsCluster = config.observability?.metrics?.cluster;
  const tracesCluster = config.observability?.traces?.cluster;
  const logsCluster = config.observability?.logs?.cluster;
  const enabledClusters = [
    logsEnabled ? logsCluster : undefined,
    metricsEnabled ? metricsCluster : undefined,
    tracesEnabled ? tracesCluster : undefined,
  ].filter((cluster): cluster is string => cluster !== undefined);
  if (new Set(enabledClusters).size > 1) {
    context.addIssue({
      code: "custom",
      path: ["observability"],
      message: "enabled Monium signals must use the same cluster",
    });
  }
  const routedFunctions = new Set<string>();
  const httpRoutedFunctions = new Set<string>();
  const websocketRoutedFunctions = new Set<string>();
  const routeOperations = new Map<string, number>();
  const registerRouteOperation = (key: string, index: number) => {
    const previous = routeOperations.get(key);
    if (previous === undefined) {
      routeOperations.set(key, index);
      return;
    }
    context.addIssue({
      code: "custom",
      path: ["gateway", "routes", index],
      message: `duplicates the generated gateway operation from route ${previous}`,
    });
  };
  for (const [index, route] of (config.gateway.routes ?? []).entries()) {
    const method = route.method?.toUpperCase() ?? "ANY";
    const websocket = method === "WS";
    registerRouteOperation(`${route.assets ? "GET" : method}:${route.pattern}`, index);
    if (route.assets) {
      registerRouteOperation(`HEAD:${route.pattern}`, index);
      if (route.pattern === "/*") {
        registerRouteOperation("GET:/", index);
        registerRouteOperation("HEAD:/", index);
      }
    }
    if (route.assets && !assets.has(route.assets)) {
      context.addIssue({ code: "custom", path: ["gateway", "routes", index, "assets"], message: `references unknown assets: ${route.assets}` });
    }
    if (websocket && route.assets) {
      context.addIssue({ code: "custom", path: ["gateway", "routes", index, "assets"], message: "a WS route must target a function" });
    }
    if (route.assets && !["ANY", "GET"].includes(method)) {
      context.addIssue({ code: "custom", path: ["gateway", "routes", index, "method"], message: "an assets route must use GET or ANY" });
    }
    if (websocket && route.pattern.includes("*")) {
      context.addIssue({ code: "custom", path: ["gateway", "routes", index, "pattern"], message: "a WS route cannot use an HTTP wildcard" });
    }
    if (route.function && !functions.has(route.function)) {
      context.addIssue({ code: "custom", path: ["gateway", "routes", index, "function"], message: `references unknown function: ${route.function}` });
    }
    if (route.function) {
      routedFunctions.add(route.function);
      (websocket ? websocketRoutedFunctions : httpRoutedFunctions).add(route.function);
    }
  }
  for (const [functionName, definition] of Object.entries(config.functions ?? {})) {
    const runtime = definition.runtime ?? "nodejs22";
    const family = functionRuntimeFamily(runtime);
    const [handlerModule, handlerExport] = definition.handler.split(".");
    if (family === undefined && definition.build === undefined) {
      context.addIssue({
        code: "custom",
        path: ["functions", functionName, "build"],
        message: `is required for runtime ${runtime}; built-in builders support nodejs*, python*, and golang*`,
      });
    }
    if (family === "python" && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(handlerModule) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(handlerExport))) {
      context.addIssue({
        code: "custom",
        path: ["functions", functionName, "handler"],
        message: "must use root_module.callable for Python runtimes",
      });
    }
    if (family === "go" && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(handlerModule) || !/^[A-Z][A-Za-z0-9_]*$/.test(handlerExport))) {
      context.addIssue({
        code: "custom",
        path: ["functions", functionName, "handler"],
        message: "must use root_file.ExportedHandler for Go runtimes",
      });
    }
    if (definition.template === "api" && definition.triggers?.length) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "template"], message: "api template cannot be used with stream triggers" });
    }
    if (["ai-agent", "ai-image", "ai-turn"].includes(definition.template ?? "") && family !== "nodejs") {
      context.addIssue({ code: "custom", path: ["functions", functionName, "runtime"], message: "AI templates require a nodejs runtime" });
    }
    if (["ai-agent", "ai-image", "ai-turn"].includes(definition.template ?? "")
      && (definition.triggers?.length || websocketRoutedFunctions.has(functionName))) {
      context.addIssue({ code: "custom", path: ["functions", functionName], message: "AI templates can only handle HTTP routes" });
    }
    if (definition.template === "ai-agent" || definition.template === "ai-turn") {
      const authenticatedDatabase = definition.database;
      const hasMatchingAuth = authenticatedDatabase !== undefined && Object.values(config.functions ?? {}).some(
        (candidate) => candidate.template === "better-auth" && candidate.database === authenticatedDatabase,
      );
      if (!hasMatchingAuth) {
        context.addIssue({
          code: "custom",
          path: ["functions", functionName, "database"],
          message: "must reference a database used by a Better Auth function",
        });
      }
    }
    if (definition.template === "better-auth") {
      if (family !== "nodejs") {
        context.addIssue({ code: "custom", path: ["functions", functionName, "runtime"], message: "Better Auth requires a nodejs runtime" });
      }
      if (!definition.database) {
        context.addIssue({ code: "custom", path: ["functions", functionName, "database"], message: "is required for the Better Auth template" });
      } else if (!config.databases?.[definition.database]) {
        context.addIssue({ code: "custom", path: ["functions", functionName, "database"], message: `references unknown database: ${definition.database}` });
      } else if (config.databases[definition.database].migrations !== true) {
        context.addIssue({ code: "custom", path: ["databases", definition.database, "migrations"], message: "must be enabled for Better Auth" });
      }
      if (!config.secrets?.entries.BETTER_AUTH_SECRET) {
        context.addIssue({ code: "custom", path: ["secrets", "entries", "BETTER_AUTH_SECRET"], message: "is required for Better Auth" });
      }
      if (config.vars?.BETTER_AUTH_SECRET !== undefined) {
        context.addIssue({ code: "custom", path: ["vars", "BETTER_AUTH_SECRET"], message: "must be a generated secret for Better Auth" });
      }
      if (!(config.gateway.routes ?? []).some((route) => (
        route.function === functionName
        && (route.method?.toUpperCase() ?? "ANY") === "ANY"
        && route.pattern === "/api/auth/*"
      ))) {
        context.addIssue({ code: "custom", path: ["gateway", "routes"], message: `must expose Better Auth function ${functionName} at ANY /api/auth/*` });
      }
      if (definition.triggers?.length || websocketRoutedFunctions.has(functionName)) {
        context.addIssue({ code: "custom", path: ["functions", functionName], message: "Better Auth can only handle HTTP routes" });
      }
    } else if (definition.database !== undefined
      && definition.template !== "ai-agent"
      && definition.template !== "ai-turn") {
      context.addIssue({ code: "custom", path: ["functions", functionName, "database"], message: "requires the Better Auth template" });
    }
    if (definition.template === "websocket" && definition.triggers?.length) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "template"], message: "websocket template cannot be used with stream triggers" });
    }
    if (definition.template === "cron-trigger" && definition.triggers?.length) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "template"], message: "cron template cannot be used with stream triggers" });
    }
    if (definition.template === "websocket" && httpRoutedFunctions.has(functionName)) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "template"], message: "websocket template can only target WS routes" });
    }
    if (definition.template === "api" && websocketRoutedFunctions.has(functionName)) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "template"], message: "api template cannot target WS routes" });
    }
    if (definition.template === "cron-trigger" && routedFunctions.has(functionName)) {
      context.addIssue({ code: "custom", path: ["functions", functionName], message: "a cron function cannot be routed" });
    }
    if (definition.template === "cron-trigger" && definition.cron === undefined) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "cron"], message: "is required for the cron-trigger template" });
    }
    if (definition.template !== "cron-trigger" && definition.cron !== undefined) {
      context.addIssue({ code: "custom", path: ["functions", functionName, "cron"], message: "requires the cron-trigger template" });
    }
    if ((definition.template === "datastream-trigger" || definition.triggers?.length) && routedFunctions.has(functionName)) {
      context.addIssue({ code: "custom", path: ["functions", functionName], message: "a function cannot be both an HTTP route target and a stream trigger consumer" });
    }
    for (const [triggerIndex, trigger] of (definition.triggers ?? []).entries()) {
      const [databaseName, streamName] = trigger.stream.split(".");
      if (!config.databases?.[databaseName]?.streams?.[streamName]) {
        context.addIssue({
          code: "custom",
          path: ["functions", functionName, "triggers", triggerIndex, "stream"],
          message: `references unknown stream: ${trigger.stream}`,
        });
      }
    }
  }
});

export type VibecloudConfig = z.infer<typeof configSchema>;
type FunctionRuntimeFamily = "nodejs" | "python" | "go";

export function functionRuntimeFamily(runtime: string): FunctionRuntimeFamily | undefined {
  if (runtime.startsWith("nodejs")) return "nodejs";
  if (runtime.startsWith("python")) return "python";
  if (runtime.startsWith("golang")) return "go";
  return undefined;
}

export function validateApplicationName(value: string) {
  return parseWith(applicationName, value);
}
export function validateResourceKey(value: string) {
  return parseWith(resourceKey, value);
}
export function validateEnvironmentVariableName(value: string) {
  return parseWith(environmentVariableName, value);
}
export function validateStreamReference(value: string) {
  return parseWith(streamReference, value);
}
export function validateConfig(value: unknown) {
  return parseWith(configSchema, value);
}

export interface LoadedConfig {
  config: VibecloudConfig
  configPath: string
  rootDirectory: string
  infraDirectory: string
  projectMetadata?: ProjectMetadata
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const source = await readFile(configPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const infraDirectory = dirname(configPath);
  const rootDirectory = dirname(infraDirectory);
  const config = validateConfig(value);
  const projectMetadata = await readProjectMetadata(rootDirectory);
  if (projectMetadata?.yc_folder_id && config.folder_id !== projectMetadata.yc_folder_id) {
    throw new Error(`${configPath}: folder_id does not match .vibecloud/project.json`);
  }
  return {
    config,
    configPath,
    infraDirectory,
    rootDirectory,
    projectMetadata,
  };
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((issue) => {
    const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  }).join("\n"));
}
