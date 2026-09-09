import { refreshFrameworkFiles } from "./framework-files.ts";
import { buildRoot } from "./build-output.ts";
import { withProjectLock } from "./project-lock.ts";
import { functionGroupKey, matchFunctionRoute, orderFunctionRoutes } from "./function-groups.ts";
import { atomicWrite, exists } from "./files.ts";
import { localDatabases, localServicesCompose, requiresLocalAi } from "./local-services.ts";
import { invokeFunctionWorker, disposeFunctionWorkers, LocalFunctionTimeoutError } from "./local-functions.ts";
import { compileDeploymentPlan } from "./deployment-plan.ts";
import { runWatchedCompose } from "./compose-watch.ts";
import { inspectLocalResources } from "./local-runtime.ts";
import { serveLocalMedia, LOCAL_MEDIA_PREFIX } from "./local-media.ts";
import { localResourceNames } from "./local-identities.ts";
import { withLocalSession } from "./local-session.ts";
import type { HttpEvent, HttpResponse } from "@vibecloud/function-api";
import type { InvocationContext } from "@vibecloud/core";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { watch } from "node:fs";
import { join, relative } from "node:path";
import { functionRuntimeFamily, type LoadedConfig, type VibecloudConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, type OutputReader } from "./commands.ts";

type Route = NonNullable<VibecloudConfig["gateway"]["routes"]>[number];
interface LocalRequest {
  method: string
  url: URL
  headers: IncomingHttpHeaders
  body: Buffer
  remoteAddress?: string
}

const LOCAL_GATEWAY_PORT = 8787;
const LOCAL_VITE_PORT = 5173;
export const LOCAL_FUNCTION_PAYLOAD_LIMIT = 3_500_000;
export class LocalPayloadTooLargeError extends Error {}
export const LOCAL_BIND_HOST = "::";

export interface LocalAiCredentials {
  source: "api-key" | "iam-token" | "yc-profile"
  environment: NodeJS.ProcessEnv
  expiresAt?: Date
  refreshBy?: Date
}

export async function devProject(loaded: LoadedConfig): Promise<void> {
  const cloudOnly = compileDeploymentPlan(loaded.config).local.cloud_only;
  if (cloudOnly.length) console.log(`Cloud-only functions (run with pnpm push): ${cloudOnly.join(", ")}. Local execution supports Node.js HTTP handlers.`);
  if (process.env.VIBECLOUD_DEV_CONTAINER === "1") {
    await serveProjectInContainer(loaded);
    return;
  }
  await runProjectInCompose(loaded);
}

async function runProjectInCompose(loaded: LoadedConfig): Promise<void> {
  await withLocalSession(loaded.rootDirectory, async (signal) => {
    const read: OutputReader = (command, args, environment, cwd) => readCommandOutput(command, args, environment, cwd, signal);
    await withProjectLock(loaded.rootDirectory, () => refreshFrameworkFiles(loaded), signal);
    await requireOrbStack(loaded.rootDirectory, read);
    await runWatchedCompose(loaded, (current) => startProjectInCompose(current, read, signal), signal);
  });
}

async function startProjectInCompose(loaded: LoadedConfig, read: OutputReader, signal: AbortSignal): Promise<ChildProcess> {
  const identity = await inspectLocalResources(loaded.rootDirectory, process.env, read);
  const local = localProjectLocation(loaded.config.name, identity.project);
  const credentials = requiresLocalAi(loaded, process.env) ? await resolveLocalAiCredentials(process.env, read) : undefined;
  const composeEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...credentials?.environment,
    COMPOSE_ANSI: "never",
    COMPOSE_MENU: "false",
    COMPOSE_PROGRESS: "plain",
    VIBECLOUD_CONFIG_RELATIVE_PATH: relative(loaded.rootDirectory, loaded.configPath),
    VIBECLOUD_COMPOSE_PROJECT: identity.project,
    VIBECLOUD_LOCAL_OWNER: identity.owner,
    YANDEX_CLOUD_FOLDER_ID: credentials ? await localFolderId(loaded, read) : loaded.config.folder_id,
  };
  if (credentials?.source === "api-key") composeEnvironment.YANDEX_CLOUD_IAM_TOKEN = "";
  else if (credentials) composeEnvironment.YANDEX_CLOUD_API_KEY = "";
  composeEnvironment.VIBECLOUD_ORB_DOMAIN = local.appHost;
  console.log(`Starting ${loaded.config.name} with OrbStack…`);
  if (credentials) reportCredentialSource(credentials);
  const servicesPath = join(loaded.infraDirectory, ".local.services.compose.json");
  await atomicWrite(servicesPath, JSON.stringify(await localServicesCompose(loaded, identity), null, 2));
  const args = composeArguments(
    local.composeProject,
    join(loaded.infraDirectory, "local.compose.yaml"),
    join(loaded.infraDirectory, "local.orbstack.compose.yaml"),
    servicesPath,
    await exists(join(loaded.infraDirectory, "local.override.yaml")) ? join(loaded.infraDirectory, "local.override.yaml") : undefined,
  );
  await reportLocalBindings(loaded, local);
  signal.throwIfAborted();
  return spawn("docker", args, { env: composeEnvironment, cwd: loaded.rootDirectory, stdio: "inherit" });
}

export async function requireOrbStack(
  cwd: string,
  readCommand: typeof readCommandOutput = readCommandOutput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let info: string;
  try {
    info = await readCommand("docker", ["info", "--format", "{{json .}}"], environment, cwd);
  } catch (cause) {
    throw new Error("OrbStack is unavailable. Start OrbStack and select its Docker engine to use .orb.local development URLs.", { cause });
  }
  try {
    await readCommand("docker", ["compose", "version", "--short"], environment, cwd);
  } catch (cause) {
    throw new Error("Docker Compose v2 is unavailable. Install the Docker Compose plugin and retry.", { cause });
  }
  if (!/orbstack/iu.test(info)) throw new Error("pnpm dev requires OrbStack for .orb.local routing. Select its Docker engine with docker context use orbstack and retry.");
}

export async function resolveLocalAiCredentials(
  environment: NodeJS.ProcessEnv,
  readCommand: typeof readCommandOutput = readCommandOutput,
): Promise<LocalAiCredentials> {
  if (environment.YANDEX_CLOUD_API_KEY?.trim()) {
    return {
      source: "api-key",
      environment: { YANDEX_CLOUD_API_KEY: environment.YANDEX_CLOUD_API_KEY.trim() },
    };
  }
  if (environment.YANDEX_CLOUD_IAM_TOKEN?.trim()) {
    const token = environment.YANDEX_CLOUD_IAM_TOKEN.trim();
    const expiresAt = tokenExpiration(token);
    assertUsableToken(expiresAt);
    return {
      source: "iam-token",
      environment: { YANDEX_CLOUD_IAM_TOKEN: token },
      expiresAt,
    };
  }

  let token: string;
  try {
    token = (await readCommand("yc", ["iam", "create-token"], environment)).trim();
  } catch (cause) {
    throw new Error("Local AI authentication failed. Run `yc init`, or set YANDEX_CLOUD_API_KEY or YANDEX_CLOUD_IAM_TOKEN.", { cause });
  }
  if (!token) throw new Error("Yandex Cloud CLI returned an empty IAM token. Run `yc init` and retry.");
  const expiresAt = tokenExpiration(token);
  assertUsableToken(expiresAt);
  return {
    source: "yc-profile",
    environment: { YANDEX_CLOUD_IAM_TOKEN: token },
    expiresAt,
    refreshBy: expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
  };
}

export async function localFolderId(
  loaded: LoadedConfig,
  readCommand: typeof readCommandOutput = readCommandOutput,
): Promise<string> {
  if (loaded.config.folder_id) return loaded.config.folder_id;
  const folderId = (await readCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "output",
    "-raw",
    "project_id",
  ], process.env)).trim();
  if (!folderId) throw new Error("The managed YC folder ID is missing. Run `pnpm vibecloud init` again.");
  return folderId;
}

export function composeArguments(composeProject: string, composePath: string, overridePath?: string, servicesPath?: string, customPath?: string): string[] {
  return [
    "compose",
    "--ansi", "never",
    "--progress", "plain",
    "--project-name", composeProject,
    "-f", composePath,
    ...(overridePath ? ["-f", overridePath] : []),
    ...(servicesPath ? ["-f", servicesPath] : []),
    ...(customPath ? ["-f", customPath] : []),
    "up", "--build", "--watch", "--remove-orphans", "--attach", "app", "--exit-code-from", "app",
  ];
}

async function reportLocalBindings(loaded: LoadedConfig, local: ReturnType<typeof localProjectLocation>): Promise<void> {
  console.log(`  App: http://${local.appHost}`);
  console.log(`  API: http://${local.appServiceHost}:8787`);
  const assets = Object.entries(loaded.config.assets ?? {}).filter(([, asset]) => asset.template === "vite");
  for (const [index, [name]] of assets.entries()) console.log(`  ${name}: http://${local.appServiceHost}:${5173 + index}`);
  for (const [name, database] of Object.entries(await localDatabases(loaded, local.composeProject))) console.log(`  YDB ${name}: ${database.publicEndpoint} (UI: ${database.uiUrl})`);
}

async function serveProjectInContainer(loaded: LoadedConfig): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;
  let requestedStop = false;
  const stop = () => {
    requestedStop = true;
    controller.abort();
  };
  const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  const servers: ReturnType<typeof createLocalGateway>[] = [];
  const children: Promise<void>[] = [];
  const watchers: DrainingWatcher[] = [];
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const listen = async (port: number) => {
    signal.throwIfAborted();
    const server = createLocalGateway(loaded);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, LOCAL_BIND_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", (error) => controller.abort(error));
  };
  try {
    const local = await applyContainerEnvironment(loaded);
    await migrateLocalDatabases(loaded, signal);
    await spawnCommand("pnpm", ["build"], process.env, loaded.rootDirectory, signal);
    await listen(local.gatewayPort);
    const assets = Object.entries(loaded.config.assets ?? {}).filter(([, definition]) => definition.template === "vite");
    if (!assets.length) await listen(local.vitePort);
    for (const [index, [name]] of assets.entries()) {
      children.push(spawnCommand("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", LOCAL_BIND_HOST, "--port", String(local.vitePort + index), "--strictPort", "--logLevel", "warn", join("src", "assets", name)], process.env, loaded.rootDirectory, signal)
        .then(() => { if (!signal.aborted) controller.abort(new Error(`Vite ${name} stopped`)); }, (error) => {
          controller.abort(error);
        }));
    }
    const source = watchFunctions(loaded, signal);
    const migrations = watchMigrations(loaded, signal);
    if (source) watchers.push(source);
    if (migrations) watchers.push(migrations);
    console.log("Local handlers are ready on the reported .orb.local URLs.");
    await stopped;
    if (!requestedStop) signal.throwIfAborted();
  } catch (error) {
    if (!requestedStop) throw error;
  } finally {
    controller.abort();
    for (const watcher of watchers) watcher.close();
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    await Promise.allSettled([...children, ...watchers.map((watcher) => watcher.drain())]);
    await disposeLocalFunctions(loaded);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export function matchHttpRoute(routes: Route[], method: string, pathname: string): Route | undefined {
  return matchFunctionRoute(orderFunctionRoutes(routes), method, pathname);
}

export function localProjectLocation(projectName: string, composeProject = process.env.VIBECLOUD_COMPOSE_PROJECT ?? projectName) {
  return { composeProject, appHost: `${composeProject}.orb.local`, appServiceHost: `app.${composeProject}.orb.local` };
}

export function createLocalGateway(loaded: LoadedConfig) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (await serveLocalMedia(loaded, url.pathname, request.method ?? "GET", response)) return;
      send(response, await invokeLocalFunction(loaded, {
        method: request.method ?? "GET",
        url,
        headers: request.headers,
        body: await readBody(request),
        remoteAddress: request.socket.remoteAddress,
      }));
    } catch (error) {
      console.error(error);
      send(response, error instanceof LocalPayloadTooLargeError
        ? { statusCode: 413, body: "Function payload exceeds 3.5 MB" }
        : error instanceof LocalFunctionTimeoutError
          ? { statusCode: 504, body: "Local function exceeded its configured timeout" }
          : { statusCode: 500, body: "Local function invocation failed" });
    }
  });
}

export async function invokeLocalFunction(loaded: LoadedConfig, request: LocalRequest): Promise<HttpResponse> {
  const route = matchHttpRoute(loaded.config.gateway.routes ?? [], request.method, request.url.pathname);
  if (!route?.function) return { statusCode: 404, body: "Not found" };
  const definition = loaded.config.functions?.[route.function];
  if (!definition) return { statusCode: 500, body: "Route function is missing" };
  if (functionRuntimeFamily(definition.runtime ?? "nodejs22") !== "nodejs") {
    return { statusCode: 501, body: "Local gateway supports Node.js functions" };
  }

  const group = functionGroupKey(route.function, definition, loaded.config.gateway.routes ?? []);
  const limits = compileDeploymentPlan(loaded.config).function_groups[group];
  const modulePath = join(buildRoot(loaded.rootDirectory), "dist", "functions", group, "router.js");
  const event = requestEvent(request, route.pattern);
  assertLocalPayloadSize(event);
  const result = await invokeFunctionWorker(modulePath, "handler",
    event, invocationContext(group, limits.memory_mb, limits.timeout_seconds));
  assertLocalPayloadSize(result);
  return result;
}

async function applyContainerEnvironment(loaded: LoadedConfig) {
  const ydb = localProjectLocation(loaded.config.name);
  process.env.VIBECLOUD_CONFIG_PATH = loaded.configPath;
  process.env.VIBECLOUD_YDB_DISCOVERY = "0";
  process.env.YDB_ANONYMOUS_CREDENTIALS = "1";
  process.env.VIBECLOUD_STORAGE_DIRECTORY = join(loaded.rootDirectory, ".vibecloud", "media");
  process.env.VIBECLOUD_STORAGE_URL = LOCAL_MEDIA_PREFIX.slice(0, -1);
  for (const [name, bucket] of Object.entries(await localResourceNames(loaded.rootDirectory, "buckets", loaded.config.buckets))) process.env[`${environmentBinding(name)}_BUCKET`] = bucket;
  for (const [name, database] of Object.entries(await localDatabases(loaded))) {
    process.env[`${environmentBinding(name)}_ENDPOINT`] = database.endpoint;
  }
  for (const [name, value] of Object.entries(loaded.config.vars ?? {})) {
    process.env[name] ??= String(value);
  }
  for (const name of Object.keys(loaded.config.secrets?.entries ?? {})) {
    process.env[name] ??= createHash("sha256")
      .update(`vibecloud-local:${loaded.config.name}:${name}`)
      .digest("base64url");
  }
  return {
    appHost: ydb.appHost,
    appServiceHost: ydb.appServiceHost,
    gatewayPort: LOCAL_GATEWAY_PORT,
    vitePort: LOCAL_VITE_PORT,
  };
}

async function migrateLocalDatabases(loaded: LoadedConfig, signal: AbortSignal) {
  const databases = await localDatabases(loaded);
  for (const [name, definition] of Object.entries(loaded.config.databases ?? {})) {
    if (!definition.migrations) continue;
    console.log(`Applying local migrations for ${name}…`);
    await spawnCommand(process.execPath, [fileURLToPath(new URL("../dist/cloud-action.js", import.meta.url)), "migrate", JSON.stringify({ project: loaded.rootDirectory, connection: databases[name].endpoint, directory: join(loaded.rootDirectory, "src", "databases", name, "migrations") })], process.env, loaded.rootDirectory, signal);
  }
}

export interface DrainingWatcher { close(): void, drain(): Promise<void> }

export function watchFunctions(loaded: LoadedConfig, signal?: AbortSignal): DrainingWatcher | undefined {
  if (!Object.keys(loaded.config.functions ?? {}).length) return undefined;
  return watchAndRun(
    join(loaded.rootDirectory, "src"),
    "Function rebuild",
    async () => {
      console.log("Rebuilding local functions…");
      await spawnCommand(process.execPath, ["build.ts"], process.env, loaded.rootDirectory, signal);
      await disposeLocalFunctions(loaded);
    },
  );
}

function watchMigrations(loaded: LoadedConfig, signal: AbortSignal): DrainingWatcher | undefined {
  if (!Object.values(loaded.config.databases ?? {}).some((database) => database.migrations)) return undefined;
  return watchAndRun(
    join(loaded.rootDirectory, "src", "databases"),
    "Database migration",
    async () => {
      console.log("Applying changed local migrations…");
      await migrateLocalDatabases(loaded, signal);
    },
  );
}

export function watchAndRun(directory: string, label: string, operation: () => Promise<void>): DrainingWatcher | undefined {
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let runAgain = false;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    if (pending) {
      runAgain = true;
      return;
    }
    pending = (async () => {
      do {
        runAgain = false;
        try {
          await operation();
        } catch (error) {
          if (!closed) console.error(`${label} failed:`, error);
        }
      } while (runAgain && !closed);
    })().finally(() => { pending = undefined; });
  };
  try {
    const watcher = watch(directory, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(schedule, 150);
    });
    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        watcher.close();
      },
      async drain() { await pending; },
    };
  } catch (error) {
    console.warn(`${label} watching is unavailable: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function requestEvent(request: LocalRequest, resource: string): HttpEvent {
  const textBody = isUtf8(request.body);
  const multiValueHeaders = multiHeaders(request.headers);
  const query = new Map<string, string[]>();
  for (const [name, value] of request.url.searchParams) query.set(name, [...(query.get(name) ?? []), value]);
  const queryEntries = [...query];
  const now = Date.now();
  const requestId = crypto.randomUUID();
  return {
    version: "1.0",
    resource,
    path: request.url.pathname,
    httpMethod: request.method as HttpEvent["httpMethod"],
    headers: Object.fromEntries(Object.entries(request.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    multiValueHeaders,
    queryStringParameters: queryEntries.length
      ? Object.fromEntries(queryEntries.map(([name, values]) => [name, values.at(-1)!]))
      : null,
    multiValueQueryStringParameters: queryEntries.length ? Object.fromEntries(queryEntries) : null,
    requestContext: {
      identity: {
        sourceIp: request.remoteAddress ?? "127.0.0.1",
        userAgent: request.headers["user-agent"] ?? "",
      },
      httpMethod: request.method as HttpEvent["httpMethod"],
      requestId,
      requestTime: new Date(now).toISOString(),
      requestTimeEpoch: now,
    },
    pathParameters: resource.endsWith("*")
      ? { path: request.url.pathname.slice(resource.slice(0, -1).length) }
      : null,
    body: request.body.toString(textBody ? "utf8" : "base64"),
    isBase64Encoded: !textBody,
  };
}

function invocationContext(functionName: string, memoryMb: number, timeoutSeconds: number): InvocationContext {
  const started = Date.now();
  return {
    functionFolderId: "local",
    functionName,
    functionVersion: "local",
    memoryLimitInMB: memoryMb,
    requestId: crypto.randomUUID(),
    getRemainingTimeInMillis: () => Math.max(0, timeoutSeconds * 1_000 - (Date.now() - started)),
    getPayload: () => undefined,
  };
}

function multiHeaders(headers: IncomingHttpHeaders): Record<string, string[]> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (Array.isArray(value)) return [[name, value]];
    if (value === undefined) return [];
    return [[name, [value]]];
  }));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > LOCAL_FUNCTION_PAYLOAD_LIMIT) {
      request.resume();
      throw new LocalPayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function assertLocalPayloadSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > LOCAL_FUNCTION_PAYLOAD_LIMIT) throw new LocalPayloadTooLargeError();
}

function send(response: ServerResponse, result: HttpResponse) {
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  for (const [name, values] of Object.entries(result.multiValueHeaders ?? {})) response.setHeader(name, values);
  response.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
}

function tokenExpiration(token: string): Date | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof value.exp === "number" ? new Date(value.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function reportCredentialSource(credentials: LocalAiCredentials): void {
  if (credentials.source === "api-key") {
    console.log("Local AI authentication: explicit API key.");
    return;
  }
  const expiration = credentials.expiresAt
    ? ` It expires at ${credentials.expiresAt.toISOString()}.`
    : credentials.refreshBy
      ? ` Its exact expiration is not exposed; refresh it by ${credentials.refreshBy.toISOString()} (YC recommends hourly refresh).`
      : " Its expiration is not encoded in the token; replace it with a fresh token before it expires.";
  console.log(`Local AI authentication: ${credentials.source === "yc-profile" ? "temporary IAM token from yc" : "explicit IAM token"}.${expiration}`);
  console.log("Restart `pnpm dev` to obtain or supply a fresh IAM token.");
}

function assertUsableToken(expiresAt: Date | undefined): void {
  if (expiresAt && expiresAt.getTime() <= Date.now() + 60_000) {
    throw new Error(`The IAM token expires at ${expiresAt.toISOString()}. Restart \`pnpm dev\` to obtain or supply a fresh token.`);
  }
}

function environmentBinding(resource: string): string {
  return resource.toUpperCase().replaceAll("-", "_");
}

export async function disposeLocalFunctions(loaded: LoadedConfig): Promise<void> {
  await disposeFunctionWorkers(join(buildRoot(loaded.rootDirectory), "dist", "functions"));
}
