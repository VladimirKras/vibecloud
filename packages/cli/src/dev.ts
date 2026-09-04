import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire, findPackageJSON } from "node:module";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { functionRuntimeFamily, type LoadedConfig, type VibecloudConfig } from "./config.ts";
import { readCommandOutput } from "./push.ts";

type Route = NonNullable<VibecloudConfig["gateway"]["routes"]>[number];
type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
interface HttpEvent {
  version: "1.0"
  resource: string
  path: string
  httpMethod: HttpMethod
  headers: Record<string, string>
  multiValueHeaders: Record<string, string[]>
  queryStringParameters: Record<string, string> | null
  multiValueQueryStringParameters: Record<string, string[]> | null
  requestContext: {
    identity: { sourceIp: string, userAgent: string }
    httpMethod: HttpMethod
    requestId: string
    requestTime: string
    requestTimeEpoch: number
  }
  pathParameters: Record<string, string> | null
  body: string
  isBase64Encoded: boolean
}
interface HttpResponse {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  body: string
  isBase64Encoded?: boolean
}
interface InvocationContext {
  functionFolderId: string
  functionName: string
  functionVersion: string
  memoryLimitInMB: number
  requestId: string
  getRemainingTimeInMillis(): number
  getPayload(): unknown
}
interface LocalRequest {
  method: string
  url: URL
  headers: IncomingHttpHeaders
  body: Buffer
  remoteAddress?: string
}
type FunctionHandler = (event: HttpEvent, context: InvocationContext) => Promise<HttpResponse> | HttpResponse;

const LOCAL_GATEWAY_PORT = 8787;
const LOCAL_VITE_PORT = 5173;
export const LOCAL_BIND_HOST = "::";
export type ContainerRuntimeKind = "docker" | "orbstack";

export interface LocalAiCredentials {
  source: "api-key" | "iam-token" | "yc-profile"
  environment: NodeJS.ProcessEnv
  expiresAt?: Date
  refreshBy?: Date
}

export async function devProject(loaded: LoadedConfig): Promise<void> {
  if (process.env.VIBECLOUD_DEV_CONTAINER === "1") {
    await serveProjectInContainer(loaded);
    return;
  }
  await runProjectInCompose(loaded);
}

async function runProjectInCompose(loaded: LoadedConfig): Promise<void> {
  const runtime = await detectContainerRuntime(loaded.rootDirectory);
  const local = localYdbLocation(loaded.config.name, runtime);
  const credentials = await resolveLocalAiCredentials(process.env);
  const composeEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...credentials.environment,
    COMPOSE_ANSI: "never",
    COMPOSE_MENU: "false",
    COMPOSE_PROGRESS: "plain",
    VIBECLOUD_CONFIG_RELATIVE_PATH: relative(loaded.rootDirectory, loaded.configPath),
    VIBECLOUD_CONFIG_FILE_NAME: basename(loaded.configPath),
    VIBECLOUD_LOCAL_RUNTIME: runtime,
    YANDEX_CLOUD_FOLDER_ID: await localFolderId(loaded),
  };
  if (credentials.source === "api-key") composeEnvironment.YANDEX_CLOUD_IAM_TOKEN = "";
  else composeEnvironment.YANDEX_CLOUD_API_KEY = "";
  if (runtime === "orbstack") composeEnvironment.VIBECLOUD_ORB_DOMAIN = local.appHost;
  console.log(`Starting ${loaded.config.name} with ${runtime === "orbstack" ? "OrbStack" : "Docker Compose"}…`);
  reportCredentialSource(credentials);
  await run("docker", composeArguments(
    local.composeProject,
    join(loaded.infraDirectory, "local.compose.yaml"),
    runtime === "orbstack" ? join(loaded.infraDirectory, "local.orbstack.compose.yaml") : undefined,
  ), loaded.rootDirectory, false, composeEnvironment);
}

export async function detectContainerRuntime(
  cwd: string,
  readCommand: typeof readCommandOutput = readCommandOutput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ContainerRuntimeKind> {
  let info: string;
  try {
    info = await readCommand("docker", ["info", "--format", "{{json .}}"], environment, cwd);
  } catch (cause) {
    throw new Error("Docker Engine is unavailable. Start Docker Desktop, Colima, OrbStack, or the Linux Docker daemon and retry.", { cause });
  }
  try {
    await readCommand("docker", ["compose", "version", "--short"], environment, cwd);
  } catch (cause) {
    throw new Error("Docker Compose v2 is unavailable. Install the Docker Compose plugin and retry.", { cause });
  }
  let context = "";
  try {
    context = await readCommand("docker", ["context", "show"], environment, cwd);
  } catch {
    // Docker can still be usable when context inspection is unavailable.
  }
  return /orbstack/iu.test(`${context}\n${info}`) ? "orbstack" : "docker";
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

export function composeArguments(composeProject: string, composePath: string, overridePath?: string): string[] {
  return [
    "compose",
    "--ansi", "never",
    "--progress", "plain",
    "--project-name", composeProject,
    "-f", composePath,
    ...(overridePath ? ["-f", overridePath] : []),
    "up", "--build", "--watch", "--attach", "app", "--exit-code-from", "app",
  ];
}

async function serveProjectInContainer(loaded: LoadedConfig): Promise<void> {
  const local = applyContainerEnvironment(loaded);
  const ordinaryDocker = process.env.VIBECLOUD_LOCAL_RUNTIME === "docker";
  const assetNames = Object.entries(loaded.config.assets ?? {})
    .filter(([, definition]) => definition.template === "vite")
    .map(([name]) => name);
  if (Object.keys(loaded.config.databases ?? {}).length) {
    await migrateLocalDatabases(loaded, local.containerYdbEndpoint);
  }

  await run("pnpm", ["build"], loaded.rootDirectory);
  const gateway = createLocalGateway(loaded);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    gateway.once("error", rejectPromise);
    gateway.listen(local.gatewayPort, LOCAL_BIND_HOST, () => resolvePromise());
  });
  const frontDoorGateway = assetNames.length ? undefined : createLocalGateway(loaded);
  if (frontDoorGateway) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      frontDoorGateway.once("error", rejectPromise);
      frontDoorGateway.listen(local.vitePort, LOCAL_BIND_HOST, () => resolvePromise());
    });
  }

  const children = startViteAssets(loaded, local.vitePort);
  const sourceWatcher = watchFunctions(loaded);
  const migrationWatcher = watchMigrations(loaded, local.containerYdbEndpoint);
  console.log("Vibecloud is ready:");
  console.log(`  App: http://${local.appHost}${ordinaryDocker ? `:${local.vitePort}` : ""}`);
  console.log(`  API: http://${local.appHost}${ordinaryDocker ? `:${local.gatewayPort}` : ""} (declared function routes)`);
  for (const [index, name] of assetNames.entries()) {
    console.log(`  ${name}: ${index === 0
      ? `http://${local.appHost}`
      : `http://${local.appServiceHost}:${local.vitePort + index}`}`);
  }
  if (Object.keys(loaded.config.databases ?? {}).length) {
    console.log(`  YDB: ${local.ydbEndpoint}`);
    console.log(`  YDB UI: ${local.ydbUiUrl}`);
  }

  try {
    await waitUntilStopped(children);
  } finally {
    sourceWatcher?.close();
    migrationWatcher?.close();
    gateway.close();
    frontDoorGateway?.close();
    for (const child of children) child.kill("SIGTERM");
  }
}

export function matchHttpRoute(routes: Route[], method: string, pathname: string): Route | undefined {
  return routes.filter((route) => {
    if (!route.function || (route.method ?? "ANY").toUpperCase() === "WS") return false;
    const declaredMethod = (route.method ?? "ANY").toUpperCase();
    if (declaredMethod !== "ANY" && declaredMethod !== method.toUpperCase()) return false;
    return route.pattern.endsWith("*")
      ? pathname.startsWith(route.pattern.slice(0, -1))
      : pathname === route.pattern;
  }).sort((left, right) => {
    const leftExact = Number(!left.pattern.endsWith("*"));
    const rightExact = Number(!right.pattern.endsWith("*"));
    if (leftExact !== rightExact) return rightExact - leftExact;
    if (left.pattern.length !== right.pattern.length) return right.pattern.length - left.pattern.length;
    const leftExplicit = Number((left.method ?? "ANY").toUpperCase() !== "ANY");
    const rightExplicit = Number((right.method ?? "ANY").toUpperCase() !== "ANY");
    return rightExplicit - leftExplicit;
  })[0];
}

export function localYdbLocation(projectName: string, runtime: ContainerRuntimeKind = "orbstack") {
  const composeProject = projectName;
  const orbstack = runtime === "orbstack";
  const appHost = orbstack ? `${projectName}.orb.local` : "localhost";
  const appServiceHost = orbstack ? `app.${projectName}.orb.local` : "localhost";
  const host = orbstack ? `ydb.${projectName}.orb.local` : "localhost";
  return {
    composeProject,
    appHost,
    appServiceHost,
    host,
    endpoint: `grpc://${host}:2136/local`,
    uiUrl: orbstack ? `http://${host}` : "http://localhost:8765",
    containerYdbEndpoint: "grpc://ydb:2136/local",
  };
}

function createLocalGateway(loaded: LoadedConfig) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      send(response, await invokeLocalFunction(loaded, {
        method: request.method ?? "GET",
        url,
        headers: request.headers,
        body: await readBody(request),
        remoteAddress: request.socket.remoteAddress,
      }));
    } catch (error) {
      console.error(error);
      send(response, { statusCode: 500, body: "Local function invocation failed" });
    }
  });
}

export async function invokeLocalFunction(loaded: LoadedConfig, request: LocalRequest): Promise<HttpResponse> {
  const route = matchHttpRoute(loaded.config.gateway.routes ?? [], request.method, request.url.pathname);
  if (!route?.function) return { statusCode: 404, body: "Not found" };
  const definition = loaded.config.functions?.[route.function];
  if (!definition) return { statusCode: 500, body: "Route function is missing" };
  if (functionRuntimeFamily(definition.runtime ?? "nodejs22") !== "nodejs" || definition.build) {
    return { statusCode: 501, body: "Local gateway supports built-in Node.js functions" };
  }

  const separator = definition.handler.lastIndexOf(".");
  const module = definition.handler.slice(0, separator);
  const exportName = definition.handler.slice(separator + 1);
  const modulePath = join(loaded.rootDirectory, "dist", "functions", route.function, `${module}.js`);
  const require = createRequire(join(loaded.rootDirectory, "package.json"));
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const exports = require(resolved) as Record<string, unknown>;
  const handler = exports[exportName];
  if (typeof handler !== "function") throw new Error(`Function ${route.function} does not export ${exportName}`);
  return (handler as FunctionHandler)(
    requestEvent(request, route.pattern),
    invocationContext(route.function),
  );
}

function applyContainerEnvironment(loaded: LoadedConfig) {
  const runtime = process.env.VIBECLOUD_LOCAL_RUNTIME === "docker" ? "docker" : "orbstack";
  const ydb = localYdbLocation(loaded.config.name, runtime);
  process.env.VIBECLOUD_CONFIG_PATH = loaded.configPath;
  process.env.VIBECLOUD_YDB_DISCOVERY = "0";
  process.env.YDB_ANONYMOUS_CREDENTIALS = "1";
  for (const name of Object.keys(loaded.config.databases ?? {})) {
    process.env[`${environmentBinding(name)}_ENDPOINT`] = ydb.containerYdbEndpoint;
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
    ydbEndpoint: ydb.endpoint,
    ydbUiUrl: ydb.uiUrl,
    containerYdbEndpoint: ydb.containerYdbEndpoint,
    gatewayPort: LOCAL_GATEWAY_PORT,
    vitePort: LOCAL_VITE_PORT,
  };
}

async function migrateLocalDatabases(loaded: LoadedConfig, ydbEndpoint: string) {
  const databases = Object.entries(loaded.config.databases ?? {})
    .filter(([, definition]) => definition.migrations)
    .map(([name]) => name);
  if (!databases.length) return;
  let modulePath: string;
  try {
    const packagePath = findPackageJSON(
      "@vibecloud/db",
      pathToFileURL(join(loaded.rootDirectory, "package.json")),
    );
    if (!packagePath) throw new Error("package was not found");
    modulePath = pathToFileURL(join(dirname(packagePath), "dist", "migrator.js")).href;
  } catch (cause) {
    throw new Error("Local YDB migrations require @vibecloud/db. Run pnpm install and retry.", { cause });
  }
  const migrator = await import(modulePath) as {
    migrateYdbFolder(connection: string, folder: string): Promise<void>
  };
  for (const name of databases) {
    console.log(`Applying local migrations for ${name}…`);
    await migrator.migrateYdbFolder(
      ydbEndpoint,
      join(loaded.rootDirectory, "src", "databases", name, "migrations"),
    );
  }
}

function startViteAssets(loaded: LoadedConfig, firstPort: number): ChildProcess[] {
  return Object.entries(loaded.config.assets ?? {})
    .filter(([, definition]) => definition.template === "vite")
    .map(([name], index) => spawn("pnpm", [
      "exec", "vite",
      "--config", "vite.config.ts",
      "--host", LOCAL_BIND_HOST,
      "--port", String(firstPort + index),
      "--strictPort",
      join("src", "assets", name),
    ], {
      cwd: loaded.rootDirectory,
      env: process.env,
      stdio: "inherit",
    }));
}

function watchFunctions(loaded: LoadedConfig): FSWatcher | undefined {
  if (!Object.keys(loaded.config.functions ?? {}).length) return undefined;
  return watchAndRun(
    join(loaded.rootDirectory, "src", "functions"),
    "Function rebuild",
    async () => {
      console.log("Rebuilding local functions…");
      await run("node", ["build.ts"], loaded.rootDirectory);
    },
  );
}

function watchMigrations(loaded: LoadedConfig, ydbEndpoint: string): FSWatcher | undefined {
  if (!Object.values(loaded.config.databases ?? {}).some((database) => database.migrations)) return undefined;
  return watchAndRun(
    join(loaded.rootDirectory, "src", "databases"),
    "Database migration",
    async () => {
      console.log("Applying changed local migrations…");
      await migrateLocalDatabases(loaded, ydbEndpoint);
    },
  );
}

function watchAndRun(directory: string, label: string, operation: () => Promise<void>): FSWatcher | undefined {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let runAgain = false;
  const execute = async () => {
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    try {
      await operation();
    } catch (error) {
      console.error(`${label} failed:`, error);
    } finally {
      running = false;
      if (runAgain) {
        runAgain = false;
        void execute();
      }
    }
  };
  try {
    return watch(directory, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void execute(), 150);
    });
  } catch (error) {
    console.warn(`${label} watching is unavailable: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function requestEvent(request: LocalRequest, resource: string): HttpEvent {
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
    body: request.body.toString("utf8"),
    isBase64Encoded: false,
  };
}

function invocationContext(functionName: string): InvocationContext {
  const started = Date.now();
  return {
    functionFolderId: "local",
    functionName,
    functionVersion: "local",
    memoryLimitInMB: 128,
    requestId: crypto.randomUUID(),
    getRemainingTimeInMillis: () => Math.max(0, 600_000 - (Date.now() - started)),
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
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, result: HttpResponse) {
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  for (const [name, values] of Object.entries(result.multiValueHeaders ?? {})) response.setHeader(name, values);
  response.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
}

function waitUntilStopped(children: ChildProcess[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stop = () => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    for (const child of children) {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") resolvePromise();
        else rejectPromise(new Error(`Vite exited ${signal ?? `with code ${code}`}`));
      });
    }
  });
}

function run(
  command: string,
  arguments_: string[],
  cwd: string,
  quiet = false,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${arguments_.join(" ")} exited ${signal ?? `with code ${code}`}`));
    });
  });
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
