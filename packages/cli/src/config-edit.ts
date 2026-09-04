import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  validateConfig,
  validateEnvironmentVariableName,
  validateResourceKey,
  validateStreamReference,
  type VibecloudConfig,
} from "./config.ts";

type ResourceKind = "asset" | "bucket" | "database" | "function";
type EditAction = "added" | "removed" | "renamed" | "unchanged";
type Route = NonNullable<VibecloudConfig["gateway"]["routes"]>[number];

export interface EditResult {
  action: EditAction
  description: string
  configPath: string
}

interface FunctionOptions {
  template?: "api" | "ai-agent" | "ai-image" | "ai-turn" | "better-auth" | "cron-trigger" | "datastream-trigger" | "websocket"
  database?: string
  cronExpression?: string
  cronPayload?: string
  handler?: string
  runtime?: string
  buildCommand?: string
  buildCwd?: string
  memoryMb?: number
  timeoutSeconds?: number
}

interface AssetOptions {
  template?: "vite"
  buildCommand?: string
  buildCwd?: string
  fallback?: string
}

interface DatabaseOptions { migrations?: boolean }

interface TriggerOptions {
  stream: string
  batchSizeBytes?: number
  batchCutoffSeconds?: number
  retryAttempts?: number
  retryIntervalSeconds?: number
  deadLetterQueue?: string
}

interface RouteTarget { function?: string, assets?: string }

interface TerraformMove { from: string, to: string }
interface FileMove { from: string, to: string }
interface FileEdit { path: string, original: string, updated: string }

export async function addResource(
  configPath: string,
  kind: ResourceKind,
  name: string,
  options: FunctionOptions | AssetOptions | DatabaseOptions = {},
) {
  const key = validateResourceKey(name);
  const sections = { asset: "assets", bucket: "buckets", database: "databases", function: "functions" } as const;
  return edit(configPath, `${kind} ${key}`, (config) => {
    const definitions = {
      asset: () => assetDefinition(options as AssetOptions),
      bucket: () => ({}),
      database: () => databaseDefinition(options),
      function: () => functionDefinitionForConfig(config, options as FunctionOptions),
    };
    const definition = definitions[kind]();
    const resources = config[sections[kind]] ?? {};
    const existing = resources[key];
    if (existing !== undefined) return containsDeclaration(existing, definition) ? "unchanged" : conflict(`${kind} ${key}`);
    (config as Record<string, unknown>)[sections[kind]] = { ...resources, [key]: definition };
    return "added";
  });
}

export async function addFunction(
  configPath: string,
  name: string,
  options: FunctionOptions,
  routePattern?: string,
) {
  if (routePattern === undefined) return addResource(configPath, "function", name, options);
  if (options.template === "datastream-trigger" || options.template === "cron-trigger") {
    throw new Error(`--route cannot be used with the ${options.template} template`);
  }

  const key = validateResourceKey(name);
  const method = options.template === "websocket" ? "WS" : "ANY";
  validatePattern(routePattern);
  if (method === "WS") validateWebSocketPattern(routePattern);
  const route = routeDefinition(method, routePattern, { function: key });
  const description = `function ${key} with route ${method} ${routePattern}`;

  return edit(configPath, description, (config) => {
    const definition = functionDefinitionForConfig(config, options);
    const functions = config.functions ?? {};
    const existingFunction = functions[key];
    if (existingFunction !== undefined && !containsDeclaration(existingFunction, definition)) conflict(`function ${key}`);

    const routes = config.gateway.routes ?? [];
    const existingRoute = findRoute(routes, method, routePattern);
    if (existingRoute !== undefined && !sameRoute(existingRoute, route)) conflict(`route ${method} ${routePattern}`);
    if (existingFunction !== undefined && existingRoute !== undefined) return "unchanged";

    if (existingFunction === undefined) config.functions = { ...functions, [key]: definition };
    if (existingRoute === undefined) config.gateway.routes = [...routes, route];
    return "added";
  });
}

export async function addAuth(
  configPath: string,
  databaseName: string,
  functionName = "auth",
) {
  const databaseKey = validateResourceKey(databaseName);
  const functionKey = validateResourceKey(functionName);
  const definition = functionDefinition({ template: "better-auth", database: databaseKey });
  const route = routeDefinition("ANY", "/api/auth/*", { function: functionKey });
  const description = `Better Auth ${functionKey} with database ${databaseKey}`;

  return edit(configPath, description, (config) => {
    const database = config.databases?.[databaseKey];
    if (!database) throw new Error(`database ${databaseKey} does not exist`);

    const existingFunction = config.functions?.[functionKey];
    if (existingFunction !== undefined && !containsDeclaration(existingFunction, definition)) {
      conflict(`function ${functionKey}`);
    }
    const routes = config.gateway.routes ?? [];
    const existingRoute = findRoute(routes, "ANY", "/api/auth/*");
    if (existingRoute !== undefined && !sameRoute(existingRoute, route)) conflict("route ANY /api/auth/*");
    const secret = config.secrets?.entries.BETTER_AUTH_SECRET;
    const complete = existingFunction !== undefined
      && existingRoute !== undefined
      && secret !== undefined
      && database.migrations === true;
    if (complete) return "unchanged";

    database.migrations = true;
    config.functions = { ...(config.functions ?? {}), [functionKey]: definition };
    if (existingRoute === undefined) config.gateway.routes = [...routes, route];
    config.secrets = {
      entries: { ...(config.secrets?.entries ?? {}), BETTER_AUTH_SECRET: {} },
    };
    return "added";
  });
}

export async function addAsset(
  configPath: string,
  name: string,
  options: AssetOptions,
  routePattern?: string,
) {
  if (routePattern === undefined) return addResource(configPath, "asset", name, options);

  const key = validateResourceKey(name);
  const definition = assetDefinition(options);
  validatePattern(routePattern);
  const route = routeDefinition("ANY", routePattern, { assets: key });
  const description = `asset ${key} with route ANY ${routePattern}`;

  return edit(configPath, description, (config) => {
    const assets = config.assets ?? {};
    const existingAsset = assets[key];
    if (existingAsset !== undefined && !containsDeclaration(existingAsset, definition)) conflict(`asset ${key}`);

    const routes = config.gateway.routes ?? [];
    const existingRoute = findRoute(routes, "ANY", routePattern);
    if (existingRoute !== undefined && !sameRoute(existingRoute, route)) conflict(`route ANY ${routePattern}`);
    if (existingAsset !== undefined && existingRoute !== undefined) return "unchanged";

    if (existingAsset === undefined) config.assets = { ...assets, [key]: definition };
    if (existingRoute === undefined) config.gateway.routes = [...routes, route];
    return "added";
  });
}

export async function removeResource(configPath: string, kind: ResourceKind, name: string) {
  const key = validateResourceKey(name);
  const sections = { asset: "assets", bucket: "buckets", database: "databases", function: "functions" } as const;
  return edit(configPath, `${kind} ${key}`, (config) => {
    const resources = config[sections[kind]];
    if (resources?.[key] === undefined) return "unchanged";
    delete resources[key];
    if (!Object.keys(resources).length) delete (config as Record<string, unknown>)[sections[kind]];
    return "removed";
  });
}

export async function renameResource(configPath: string, kind: ResourceKind, oldName: string, newName: string) {
  const oldKey = validateResourceKey(oldName);
  const newKey = validateResourceKey(newName);
  const sections = { asset: "assets", bucket: "buckets", database: "databases", function: "functions" } as const;
  const section = sections[kind];
  const description = `${kind} ${oldKey} -> ${newKey}`;
  return edit(configPath, description, async (config, context) => {
    if (oldKey === newKey) return "unchanged";
    const resources = config[section] as Record<string, Record<string, unknown>> | undefined;
    const definition = resources?.[oldKey];
    if (definition === undefined) {
      if (resources?.[newKey] !== undefined) return "unchanged";
      throw new Error(`${kind} ${oldKey} does not exist`);
    }
    const collection = resources!;
    if (collection[newKey] !== undefined) throw new Error(`${kind} ${newKey} already exists`);

    const oldTriggers = triggerIdentities(config);
    delete collection[oldKey];
    collection[newKey] = definition;

    if (kind === "function" || kind === "asset") {
      const target = kind === "function" ? "function" : "assets";
      for (const route of config.gateway.routes ?? []) {
        if (route[target] === oldKey) route[target] = newKey;
      }
    }
    if (kind === "database") {
      updateStreamReferences(config, (reference) => reference.startsWith(`${oldKey}.`)
        ? `${newKey}.${reference.slice(oldKey.length + 1)}`
        : reference);
      for (const [functionName, functionDefinition] of Object.entries(config.functions ?? {})) {
        if (functionDefinition.database !== oldKey) continue;
        functionDefinition.database = newKey;
        const module = functionDefinition.handler.slice(0, functionDefinition.handler.lastIndexOf("."));
        const path = join(dirname(dirname(configPath)), "src", "functions", functionName, `${module}.ts`);
        const sourceEdit = await databaseBindingEdit(path, oldKey, newKey);
        if (sourceEdit) context.fileEdits.push(sourceEdit);
      }
    }

    context.terraformMoves.push(...resourceTerraformMoves(kind, oldKey, newKey, definition));
    addTriggerMoves(context.terraformMoves, oldTriggers, triggerIdentities(config));
    if (kind !== "bucket") {
      context.fileMoves.push({
        from: join(dirname(dirname(configPath)), "src", section, oldKey),
        to: join(dirname(dirname(configPath)), "src", section, newKey),
      });
    }
    return "renamed";
  });
}

export async function addStream(configPath: string, reference: string) {
  const normalized = validateStreamReference(reference);
  const [database, stream] = normalized.split(".");
  return edit(configPath, `stream ${normalized}`, (config) => {
    const definition = config.databases?.[database];
    if (!definition) throw new Error(`database ${database} does not exist`);
    if (definition.streams?.[stream] !== undefined) return "unchanged";
    definition.streams = { ...definition.streams, [stream]: {} };
    return "added";
  });
}

export async function removeStream(configPath: string, reference: string) {
  const normalized = validateStreamReference(reference);
  const [database, stream] = normalized.split(".");
  return edit(configPath, `stream ${normalized}`, (config) => {
    const streams = config.databases?.[database]?.streams;
    if (streams?.[stream] === undefined) return "unchanged";
    delete streams[stream];
    if (!Object.keys(streams).length) delete config.databases![database].streams;
    return "removed";
  });
}

export async function renameStream(configPath: string, oldReference: string, newReference: string) {
  const oldStream = validateStreamReference(oldReference);
  const newStream = validateStreamReference(newReference);
  const [oldDatabase, oldKey] = oldStream.split(".");
  const [newDatabase, newKey] = newStream.split(".");
  if (oldDatabase !== newDatabase) throw new Error("stream rename cannot move a stream between databases");
  const description = `stream ${oldStream} -> ${newStream}`;
  return edit(configPath, description, (config, context) => {
    if (oldStream === newStream) return "unchanged";
    const streams = config.databases?.[oldDatabase]?.streams;
    if (streams?.[oldKey] === undefined) {
      if (streams?.[newKey] !== undefined) return "unchanged";
      throw new Error(`stream ${oldStream} does not exist`);
    }
    if (streams[newKey] !== undefined) throw new Error(`stream ${newStream} already exists`);
    const oldTriggers = triggerIdentities(config);
    delete streams[oldKey];
    streams[newKey] = {};
    updateStreamReferences(config, (reference) => reference === oldStream ? newStream : reference);
    context.terraformMoves.push(move("yandex_ydb_topic.streams", oldStream, newStream));
    addTriggerMoves(context.terraformMoves, oldTriggers, triggerIdentities(config));
    return "renamed";
  });
}

export async function addSecret(configPath: string, name: string) {
  const key = validateEnvironmentVariableName(name);
  return edit(configPath, `secret ${key}`, (config) => {
    if (config.secrets?.entries[key] !== undefined) return "unchanged";
    config.secrets = { entries: { ...config.secrets?.entries, [key]: {} } };
    return "added";
  });
}

export async function removeSecret(configPath: string, name: string) {
  const key = validateEnvironmentVariableName(name);
  return edit(configPath, `secret ${key}`, (config) => {
    if (config.secrets?.entries[key] === undefined) return "unchanged";
    delete config.secrets.entries[key];
    if (!Object.keys(config.secrets.entries).length) delete config.secrets;
    return "removed";
  });
}

export async function renameSecret(configPath: string, oldName: string, newName: string) {
  const oldKey = validateEnvironmentVariableName(oldName);
  const newKey = validateEnvironmentVariableName(newName);
  const description = `secret ${oldKey} -> ${newKey}`;
  return edit(configPath, description, (config, context) => {
    if (oldKey === newKey) return "unchanged";
    const entries = config.secrets?.entries;
    if (entries?.[oldKey] === undefined) {
      if (entries?.[newKey] !== undefined) return "unchanged";
      throw new Error(`secret ${oldKey} does not exist`);
    }
    if (entries[newKey] !== undefined) throw new Error(`secret ${newKey} already exists`);
    delete entries[oldKey];
    entries[newKey] = {};
    context.terraformMoves.push(move("yandex_lockbox_secret_version.application", oldKey, newKey));
    return "renamed";
  });
}

export async function addRoute(configPath: string, method: string, pattern: string, target: RouteTarget) {
  const normalizedMethod = normalizeMethod(method);
  validatePattern(pattern);
  const normalizedTarget = validateRouteTarget(target);
  if (normalizedMethod === "WS" && normalizedTarget.assets !== undefined) throw new Error("a WS route must target a function");
  if (normalizedMethod === "WS") validateWebSocketPattern(pattern);
  const route = routeDefinition(normalizedMethod, pattern, normalizedTarget);
  const description = `route ${normalizedMethod} ${pattern}`;
  return edit(configPath, description, (config) => {
    const routes = config.gateway.routes ?? [];
    const existing = findRoute(routes, normalizedMethod, pattern);
    if (existing) return sameRoute(existing, route) ? "unchanged" : conflict(description);
    config.gateway.routes = [...routes, route];
    return "added";
  });
}

export async function removeRoute(configPath: string, method: string, pattern: string) {
  const normalizedMethod = normalizeMethod(method);
  validatePattern(pattern);
  const description = `route ${normalizedMethod} ${pattern}`;
  return edit(configPath, description, (config) => {
    const routes = config.gateway.routes ?? [];
    const index = routes.findIndex((candidate) =>
      normalizeMethod(candidate.method ?? "ANY") === normalizedMethod && candidate.pattern === pattern);
    if (index === -1) return "unchanged";
    routes.splice(index, 1);
    if (!routes.length) delete config.gateway.routes;
    return "removed";
  });
}

export async function addTrigger(configPath: string, functionName: string, options: TriggerOptions) {
  const functionKey = validateResourceKey(functionName);
  const stream = validateStreamReference(options.stream);
  const trigger = {
    stream,
    ...(options.batchSizeBytes === undefined ? {} : { batch_size_bytes: integerInRange(options.batchSizeBytes, "batch size", 1, 65_536) }),
    ...(options.batchCutoffSeconds === undefined ? {} : { batch_cutoff_seconds: integerInRange(options.batchCutoffSeconds, "batch cutoff", 1, 60) }),
    ...(options.retryAttempts === undefined ? {} : { retry_attempts: integerInRange(options.retryAttempts, "retry attempts", 1, 5) }),
    ...(options.retryIntervalSeconds === undefined ? {} : { retry_interval_seconds: integerInRange(options.retryIntervalSeconds, "retry interval", 10, 60) }),
    ...(options.deadLetterQueue === undefined ? {} : { dead_letter_queue: nonempty(options.deadLetterQueue, "dead letter queue") }),
  };
  const description = `trigger ${functionKey} <- ${stream}`;
  return edit(configPath, description, (config) => {
    const definition = config.functions?.[functionKey];
    if (!definition) throw new Error(`function ${functionKey} does not exist`);
    const existing = definition.triggers?.find((candidate) => candidate.stream === stream);
    if (existing) return containsDeclaration(existing, trigger) ? "unchanged" : conflict(description);
    definition.triggers = [...definition.triggers ?? [], trigger];
    return "added";
  });
}

export async function removeTrigger(configPath: string, functionName: string, streamReference: string) {
  const functionKey = validateResourceKey(functionName);
  const stream = validateStreamReference(streamReference);
  const description = `trigger ${functionKey} <- ${stream}`;
  return edit(configPath, description, (config) => {
    const definition = config.functions?.[functionKey];
    const index = definition?.triggers?.findIndex((candidate) => candidate.stream === stream) ?? -1;
    if (!definition?.triggers || index === -1) return "unchanged";
    definition.triggers.splice(index, 1);
    if (!definition.triggers.length) delete definition.triggers;
    return "removed";
  });
}

export function listConfig(config: VibecloudConfig, kind?: string): string[] {
  const normalizedKind = kind?.replace(/s$/, "");
  const rows = [
    ...mapResources("asset", config.assets),
    ...mapResources("bucket", config.buckets),
    ...mapResources("database", config.databases),
    ...Object.entries(config.databases ?? {}).flatMap(([database, definition]) =>
      Object.keys(definition.streams ?? {}).map((stream) => `stream\t${database}.${stream}`)),
    ...mapResources("function", config.functions),
    ...(config.gateway.routes ?? []).map((route) => {
      const target = route.function ? `function:${route.function}` : `assets:${route.assets}`;
      return `route\t${normalizeMethod(route.method ?? "ANY")} ${route.pattern} -> ${target}`;
    }),
    ...Object.entries(config.functions ?? {}).flatMap(([functionName, definition]) =>
      (definition.triggers ?? []).map((trigger) => `trigger\t${functionName} <- ${trigger.stream}`)),
    ...Object.entries(config.functions ?? {}).flatMap(([functionName, definition]) =>
      definition.cron ? [`cron\t${functionName} <- ${definition.cron.expression}`] : []),
    ...Object.keys(config.secrets?.entries ?? {}).map((name) => `secret\t${name}`),
  ];
  if (!normalizedKind) return rows;
  const supported = new Set(["asset", "bucket", "cron", "database", "stream", "function", "route", "trigger", "secret"]);
  if (!supported.has(normalizedKind)) throw new Error(`unknown resource kind: ${kind}`);
  return rows.filter((row) => row.startsWith(`${normalizedKind}\t`));
}

interface EditContext { terraformMoves: TerraformMove[], fileMoves: FileMove[], fileEdits: FileEdit[] }

async function edit(
  configPath: string,
  description: string,
  mutate: (config: VibecloudConfig, context: EditContext) => EditAction | Promise<EditAction>,
): Promise<EditResult> {
  const originalConfig = await readFile(configPath, "utf8");
  const config = validateConfig(JSON.parse(originalConfig));
  const context: EditContext = { terraformMoves: [], fileMoves: [], fileEdits: [] };
  const action = await mutate(config, context);
  if (action !== "unchanged") {
    validateConfig(config);
    const movesPath = join(dirname(configPath), "moves.auto.tf");
    const originalMoves = context.terraformMoves.length ? await readFile(movesPath, "utf8") : undefined;
    const moved = await applyFileMoves(context.fileMoves);
    const written: FileEdit[] = [];
    try {
      for (const sourceEdit of context.fileEdits) {
        await atomicWrite(sourceEdit.path, sourceEdit.updated);
        written.push(sourceEdit);
      }
      await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
      if (originalMoves !== undefined) await atomicWrite(movesPath, originalMoves + renderMoves(context.terraformMoves));
    } catch (error) {
      const failures: unknown[] = [];
      for (const sourceEdit of written.reverse()) {
        try {
          await atomicWrite(sourceEdit.path, sourceEdit.original);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      try {
        await atomicWrite(configPath, originalConfig);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      if (originalMoves !== undefined) {
        try {
          await atomicWrite(movesPath, originalMoves);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      failures.push(...await restoreFileMoves(moved));
      if (failures.length) {
        throw new AggregateError([error, ...failures], "configuration edit rollback was incomplete", { cause: error });
      }
      throw error;
    }
  }
  return { action, description, configPath };
}

function resourceTerraformMoves(kind: ResourceKind, oldKey: string, newKey: string, definition: unknown) {
  if (kind === "asset") return [move("yandex_storage_bucket.assets", oldKey, newKey)];
  if (kind === "bucket") return [move("yandex_storage_bucket.buckets", oldKey, newKey)];
  if (kind === "database") {
    const database = definition as NonNullable<VibecloudConfig["databases"]>[string];
    return [
      move("yandex_ydb_database_serverless.databases", oldKey, newKey),
      ...Object.keys(database.streams ?? {}).map((stream) =>
        move("yandex_ydb_topic.streams", `${oldKey}.${stream}`, `${newKey}.${stream}`)),
    ];
  }
  const functionDefinition = definition as NonNullable<VibecloudConfig["functions"]>[string];
  return [
    move("yandex_function.functions", oldKey, newKey),
    ...(functionDefinition.cron ? [move("yandex_function_trigger.crons", oldKey, newKey)] : []),
  ];
}

function triggerIdentities(config: VibecloudConfig) {
  // Edits mutate trigger objects in place, but may reorder function keys.
  return new Map(Object.entries(config.functions ?? {}).flatMap(([functionName, definition]) =>
    (definition.triggers ?? []).map((trigger) => [trigger, `${functionName}/${trigger.stream}`] as const)));
}

function addTriggerMoves(
  moves: TerraformMove[],
  before: ReturnType<typeof triggerIdentities>,
  after: ReturnType<typeof triggerIdentities>,
) {
  if (before.size !== after.size) throw new Error("trigger identity reconciliation failed");
  for (const [trigger, from] of before) {
    const to = after.get(trigger);
    if (to === undefined) throw new Error("trigger identity reconciliation failed");
    if (from !== to) moves.push(move("yandex_function_trigger.triggers", from, to));
  }
}

async function databaseBindingEdit(path: string, oldKey: string, newKey: string): Promise<FileEdit | undefined> {
  let original: string;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const oldBinding = `${oldKey.toUpperCase().replaceAll("-", "_")}_ENDPOINT`;
  const newBinding = `${newKey.toUpperCase().replaceAll("-", "_")}_ENDPOINT`;
  const updated = original
    .replaceAll(`"${oldBinding}"`, `"${newBinding}"`)
    .replaceAll(`'${oldBinding}'`, `'${newBinding}'`);
  return updated === original ? undefined : { path, original, updated };
}

function move(resource: string, from: string, to: string): TerraformMove {
  return { from: `${resource}[${JSON.stringify(from)}]`, to: `${resource}[${JSON.stringify(to)}]` };
}

function renderMoves(moves: TerraformMove[]) {
  return `\n${moves.map((item) => `moved {\n  from = ${item.from}\n  to   = ${item.to}\n}`).join("\n")}\n`;
}

function updateStreamReferences(config: VibecloudConfig, update: (reference: string) => string) {
  for (const definition of Object.values(config.functions ?? {})) {
    for (const trigger of definition.triggers ?? []) trigger.stream = update(trigger.stream);
  }
}

function functionDefinition(options: FunctionOptions) {
  if (options.buildCwd !== undefined && options.buildCommand === undefined) throw new Error("--build-cwd requires --build-command");
  if (options.cronPayload !== undefined && options.cronExpression === undefined) throw new Error("--payload requires --cron");
  if (options.template === "cron-trigger" && options.cronExpression === undefined) throw new Error("cron-trigger requires --cron");
  if (options.template !== "cron-trigger" && options.cronExpression !== undefined) throw new Error("--cron requires the cron-trigger template");
  const runtime = nonempty(options.runtime ?? "nodejs22", "runtime");
  const goRuntime = runtime.startsWith("golang");
  const memoryMb = options.memoryMb ?? (options.template === "ai-turn" ? 256 : undefined);
  const timeoutSeconds = options.timeoutSeconds
    ?? (options.template === "ai-agent" || options.template === "ai-turn" ? 30 : undefined);
  let defaultHandler = options.template === "datastream-trigger"
    ? "index.consume"
    : options.template === "cron-trigger" ? "index.run" : "index.handler";
  if (goRuntime) defaultHandler = options.template === "datastream-trigger"
    ? "index.Consume"
    : options.template === "cron-trigger" ? "index.Run" : "index.Handler";
  return {
    ...(options.template === undefined ? {} : { template: options.template }),
    handler: nonempty(options.handler ?? defaultHandler, "handler"),
    ...(options.database === undefined ? {} : { database: validateResourceKey(options.database) }),
    ...(options.runtime === undefined ? {} : { runtime: nonempty(options.runtime, "runtime") }),
    ...(options.buildCommand === undefined
      ? {}
      : {
        build: {
          command: nonempty(options.buildCommand, "build command"),
          ...(options.buildCwd === undefined ? {} : { cwd: nonempty(options.buildCwd, "build cwd") }),
        },
      }),
    ...(options.cronExpression === undefined
      ? {}
      : {
        cron: {
          expression: nonempty(options.cronExpression, "cron expression"),
          ...(options.cronPayload === undefined ? {} : { payload: options.cronPayload }),
        },
      }),
    ...(memoryMb === undefined ? {} : { memory_mb: positive(memoryMb, "memory") }),
    ...(timeoutSeconds === undefined ? {} : { timeout_seconds: positive(timeoutSeconds, "timeout") }),
  };
}

function functionDefinitionForConfig(config: VibecloudConfig, options: FunctionOptions) {
  if (options.template !== "ai-agent" && options.template !== "ai-turn") {
    return functionDefinition(options);
  }
  const authDatabases = new Set(Object.values(config.functions ?? {})
    .filter((definition) => definition.template === "better-auth" && definition.database)
    .map((definition) => definition.database!));
  if (authDatabases.size === 0) {
    throw new Error("AI templates require Better Auth; run `vibecloud add auth --database <name>` first");
  }
  const database = options.database ?? (authDatabases.size === 1 ? [...authDatabases][0] : undefined);
  if (!database || !authDatabases.has(database)) {
    throw new Error("AI template --database must select a database used by a Better Auth function");
  }
  return functionDefinition({ ...options, database });
}

function databaseDefinition(options: FunctionOptions | AssetOptions | DatabaseOptions) {
  return "migrations" in options && options.migrations === true ? { migrations: true } : {};
}

function assetDefinition(options: AssetOptions) {
  if (options.template === undefined && options.buildCommand === undefined) {
    throw new Error("asset requires --template vite or --build-command");
  }
  if (options.template !== undefined && options.buildCommand !== undefined) {
    throw new Error("asset accepts either --template or --build-command, not both");
  }
  if (options.buildCwd !== undefined && options.buildCommand === undefined) {
    throw new Error("--build-cwd requires --build-command");
  }
  return {
    ...(options.template === undefined ? {} : { template: options.template }),
    build: {
      command: nonempty(options.buildCommand ?? "pnpm build", "build command"),
      ...(options.buildCwd === undefined ? {} : { cwd: nonempty(options.buildCwd, "build cwd") }),
    },
    ...(options.fallback === undefined ? {} : { fallback: nonempty(options.fallback, "fallback") }),
  };
}

function validateRouteTarget(target: RouteTarget): RouteTarget {
  if (Number(target.function !== undefined) + Number(target.assets !== undefined) !== 1) {
    throw new Error("route requires exactly one of --function or --assets");
  }
  return target.function === undefined
    ? { assets: validateResourceKey(target.assets!) }
    : { function: validateResourceKey(target.function) };
}

function normalizeMethod(method: string) {
  const normalized = method.toUpperCase();
  if (!/^(ANY|GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|WS)$/.test(normalized)) throw new Error(`unsupported route method: ${method}`);
  return normalized;
}

function routeDefinition(method: string, pattern: string, target: RouteTarget) {
  return { pattern, ...(method === "ANY" ? {} : { method }), ...target };
}

function findRoute(routes: Route[], method: string, pattern: string) {
  return routes.find((candidate) =>
    normalizeMethod(candidate.method ?? "ANY") === method && candidate.pattern === pattern);
}

function validatePattern(pattern: string) {
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+|\*)?$/.test(pattern)) {
    throw new Error("route pattern must be an absolute path of URL-safe literal segments with an optional trailing wildcard");
  }
}
function validateWebSocketPattern(pattern: string) {
  if (pattern.includes("*")) throw new Error("a WS route cannot use an HTTP wildcard");
}
function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}
function integerInRange(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
function nonempty(value: string, label: string) {
  if (!value.length) throw new Error(`${label} must not be empty`);
  return value;
}

function sameRoute(left: Route, right: RouteTarget & { pattern: string, method?: string }) {
  return left.pattern === right.pattern
    && normalizeMethod(left.method ?? "ANY") === normalizeMethod(right.method ?? "ANY")
    && left.function === right.function
    && left.assets === right.assets;
}

function containsDeclaration(existing: unknown, requested: unknown): boolean {
  if (Array.isArray(requested)) return Array.isArray(existing)
    && existing.length === requested.length
    && requested.every((entry, index) => containsDeclaration(existing[index], entry));
  if (requested === null || typeof requested !== "object") return existing === requested;
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return false;
  const record = existing as Record<string, unknown>;
  return Object.entries(requested as Record<string, unknown>).every(([key, value]) => containsDeclaration(record[key], value));
}

function conflict(description: string): never {
  throw new Error(`${description} already exists with a different declaration`);
}
function mapResources(kind: string, resources: Record<string, unknown> | undefined) {
  return Object.keys(resources ?? {}).map((name) => `${kind}\t${name}`);
}

async function atomicWrite(path: string, source: string) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const sourceMode = (await stat(path)).mode;
    await writeFile(temporaryPath, source, { flag: "wx", mode: sourceMode });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function applyFileMoves(moves: FileMove[]) {
  const moved: FileMove[] = [];
  for (const item of moves) {
    if (!await exists(item.from)) continue;
    if (await exists(item.to)) await rollbackFileMoves(moved, new Error(`source path already exists: ${item.to}`));
    try {
      await rename(item.from, item.to);
      moved.push(item);
    } catch (error) {
      await rollbackFileMoves(moved, error);
    }
  }
  return moved;
}

async function rollbackFileMoves(moves: FileMove[], cause: unknown): Promise<never> {
  const failures = await restoreFileMoves(moves);
  if (failures.length) throw new AggregateError([cause, ...failures], "configuration edit failed and source rollback was incomplete");
  throw cause;
}

async function restoreFileMoves(moves: FileMove[]) {
  const failures: unknown[] = [];
  for (const item of [...moves].reverse()) {
    try {
      await rename(item.to, item.from);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
