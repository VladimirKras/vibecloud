import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { listConfig, renameResource } from "../src/config-edit.ts";
import { loadConfig, validateConfig, validateCronExpression } from "../src/config.ts";
import {
  cliPackage,
  cliRoot,
  emptyProject,
  packagesRoot,
  readJson,
  runCli,
} from "./helpers.ts";

interface MockAI {
  model(name: string): string
  responses: {
    create(request: { input: string, previous_response_id?: string }): Promise<unknown>
  }
  speech?: {
    transcribe(): Promise<string>
    synthesize(): Promise<{ audio: Uint8Array, contentType: string }>
  }
}

const testGlobals = globalThis as typeof globalThis & {
  __vibecloudTestAI?: MockAI
  __vibecloudTestSession?: { user: { id: string } }
  __vibecloudTestArt?: {
    yandexArt: {
      start(request: { prompt: string }): Promise<unknown>
      retrieve(): Promise<unknown>
    }
  }
};

test("workspace packages share the CLI release and runtime contract", async () => {
  const manifest = await cliPackage();
  assert.equal(manifest.name, "@vibecloud/cli");
  assert.equal(manifest.engines.node, ">=26.0.0");

  for (const name of [
    "core",
    "ai",
    "function-api",
    "db",
    "function-trigger-cron",
    "function-trigger-datastream",
    "function-ws",
    "telemetry",
  ]) {
    const dependency = await readJson(join(packagesRoot, name, "package.json"));
    assert.equal(dependency.name, `@vibecloud/${name}`);
    assert.equal(dependency.version, manifest.version);
    assert.equal(dependency.engines.node, manifest.engines.node);
  }
});

test("bundled CLI exposes the documented command surfaces", () => {
  for (const command of ["init", "doctor", "add", "remove", "rename", "list", "db", "dev", "push", "delete"]) {
    const result = runCli([command, "--help"]);
    assert.equal(result.status, 0, result.stderr);
  }

  const push = runCli(["push", "--help"]);
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stdout, /Terraform variable file/);

  const database = runCli(["db", "up", "--help"]);
  assert.equal(database.status, 0, database.stderr);
  assert.match(database.stdout, /YDB Drizzle migrations/);

  const add = runCli(["add", "--help"]);
  assert.equal(add.status, 0, add.stderr);
  for (const command of ["asset", "auth", "bucket", "database", "function", "route", "secret", "stream", "trigger"]) {
    assert.match(add.stdout, new RegExp(`\\b${command}\\b`));
  }
  for (const template of ["vite", "api", "ai-agent", "ai-image", "ai-turn", "websocket", "cron-trigger", "datastream-trigger"]) {
    assert.match(add.stdout, new RegExp(`\\b${template}\\b`));
  }
  assert.match(add.stdout, /Better Auth service, YDB schema, secret, and web client/);
  assert.match(add.stdout, /pnpm vibecloud add function assistant --template ai-turn/);

  const functions = runCli(["add", "function", "--help"]);
  assert.equal(functions.status, 0, functions.stderr);
  assert.match(functions.stdout, /ai-agent \(aliases: ai, agent\)/);
  assert.match(functions.stdout, /ai-turn \(alias: turn\)/);
  assert.match(functions.stdout, /ai-image \(aliases: image, illustrator\)/);
  assert.match(functions.stdout, /Better Auth-protected text\/audio turn with chunked speech output/);
  assert.match(functions.stdout, /Input is limited to a 30-second, 1 MB/);
  assert.match(functions.stdout, /fails closed until implemented/);
  assert.match(functions.stdout, /Add Better Auth before ai-agent or ai-turn/);

  const assets = runCli(["add", "asset", "--help"]);
  assert.equal(assets.status, 0, assets.stderr);
  assert.match(assets.stdout, /Gravity UI React\/Vite frontend/);
  assert.match(assets.stdout, /pnpm dev/);
});

test("add auth creates a deployable Better Auth service, schema, and client", async () => {
  const { directory, configPath } = await emptyProject("auth-app");
  assert.equal(runCli(["add", "database", "primary", "--migrations"], directory).status, 0);
  assert.equal(runCli(["add", "asset", "website", "--template", "vite", "--route", "/*"], directory).status, 0);

  const first = runCli(["add", "auth", "--database", "primary"], directory);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /added: Better Auth auth with database primary/);
  assert.match(first.stdout, /created: src\/functions\/auth\/index\.ts/);
  assert.match(first.stdout, /created: src\/databases\/primary\/migrations\/001_better_auth\.sql/);
  assert.match(first.stdout, /updated: src\/assets\/website\/App\.tsx/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.auth, {
    template: "better-auth",
    handler: "index.handler",
    database: "primary",
  });
  assert.ok(loaded.config.gateway.routes?.some((route) => (
    route.pattern === "/api/auth/*" && route.function === "auth"
  )));
  assert.deepEqual(loaded.config.secrets?.entries.BETTER_AUTH_SECRET, {});
  assert.equal(loaded.config.databases?.primary.migrations, true);
  assert.throws(() => validateConfig({
    ...loaded.config,
    vars: { ...(loaded.config.vars ?? {}), BETTER_AUTH_SECRET: "plaintext" },
  }), /must be a generated secret for Better Auth/);

  const handler = await readFile(join(directory, "src", "functions", "auth", "index.ts"), "utf8");
  assert.match(handler, /betterAuth\(/);
  assert.match(handler, /withYdb\(endpoint/);
  assert.match(handler, /allowedHosts: \["\*\.apigw\.yandexcloud\.net", "\*\.orb\.local"/);
  assert.match(handler, /forwardedProtocol === "http" \|\| forwardedProtocol === "https"/);
  assert.doesNotMatch(handler, /localHost \? "http" : forwardedProtocol/);
  const migration = await readFile(
    join(directory, "src", "databases", "primary", "migrations", "001_better_auth.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `user`/);
  assert.match(migration, /idx_session_token.*GLOBAL UNIQUE SYNC/);
  assert.match(await readFile(join(directory, "src", "assets", "website", "App.tsx"), "utf8"), /<AuthPanel \/>/);
  await stat(join(directory, "src", "assets", "website", "auth-client.ts"));
  await stat(join(directory, "src", "assets", "website", "components", "AuthPanel.tsx"));
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.dependencies["better-auth"], "1.6.26");

  const second = runCli(["add", "auth", "--database", "primary"], directory);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged: Better Auth auth with database primary/);

  await renameResource(configPath, "database", "primary", "data");
  assert.equal((await loadConfig(configPath)).config.functions?.auth.database, "data");
  assert.equal(await readFile(join(directory, "src", "functions", "auth", "index.ts"), "utf8"),
    handler.replaceAll('"PRIMARY_ENDPOINT"', '"DATA_ENDPOINT"'));
  await stat(join(directory, "src", "databases", "data", "migrations", "001_better_auth.sql"));
});

test("function --route creates an authenticated AI Studio Responses agent", async () => {
  const { directory, configPath } = await emptyProject("agent-app");
  const arguments_ = ["add", "function", "agent", "--template", "ai-agent", "--route", "/api/agent"];
  const unauthenticatedProject = runCli(arguments_, directory);
  assert.equal(unauthenticatedProject.status, 1);
  assert.match(unauthenticatedProject.stderr, /AI templates require Better Auth/);
  assert.equal(runCli(["add", "database", "primary", "--migrations"], directory).status, 0);
  assert.equal(runCli(["add", "auth", "--database", "primary"], directory).status, 0);

  const result = runCli(arguments_, directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added: function agent with route ANY \/api\/agent/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.agent, {
    template: "ai-agent",
    handler: "index.handler",
    database: "primary",
    timeout_seconds: 30,
  });
  assert.deepEqual(loaded.config.gateway.routes, [
    { pattern: "/api/auth/*", function: "auth" },
    { pattern: "/api/agent", function: "agent" },
  ]);
  assert.equal(validateConfig({
    ...loaded.config,
    ai: { responses: true, realtime: true, speechkit_tts: true },
  }).ai?.realtime, true);
  assert.throws(() => validateConfig({
    ...loaded.config,
    functions: { agent: { ...loaded.config.functions?.agent, runtime: "python312" } },
  }), /AI templates require a nodejs runtime/);

  const source = await readFile(join(directory, "src", "functions", "agent", "index.ts"), "utf8");
  assert.match(source, /createAIStudioClient\(context\)/);
  assert.match(source, /previous_response_id/);
  assert.match(source, /auth\.api\.getSession/);
  assert.match(source, /createAIContinuation/);
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.dependencies["@vibecloud/ai"], (await cliPackage()).version);

  const terraform = await readFile(join(directory, "infra", "main.tf"), "utf8");
  assert.match(terraform, /ai\.assistants\.editor/);
  assert.match(terraform, /ai\.models\.user/);

  const mocks = {
    "@vibecloud/ai": `
export class AIEndpointError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
export class AIStudioRequestError extends Error {}
export class AIStudioResponseError extends Error { constructor(response) { super("incomplete"); this.responseId = response.id; } }
export const createAIStudioClient = () => globalThis.__vibecloudTestAI;
export const createAIRateLimiter = () => ({ check: () => ({ limit: 20, remaining: 19 }) });
export const createAIContinuation = (id, user) => \`signed-\${user}-\${id}\`;
export const readAIContinuation = (value, user) => value.replace(\`signed-\${user}-\`, "");
export const requireAIStudioOutputText = (response) => {
  if (response.status && response.status !== "completed") throw new AIStudioResponseError(response);
  return response.output_text;
};`,
    "@vibecloud/db": "export const getYdb = () => ({}); export const withYdb = async (_endpoint, work) => work();",
    "@vibecloud/db/better-auth": "export const ydbAdapter = () => ({});",
    "@vibecloud/telemetry": `
export const SpanKind = { SERVER: 1 };
export const businessEvent = () => {};
export const setSpanAttributes = () => {};
export const traceInvocation = async (_name, _context, _options, work) => work();
export const withSpan = async (_name, _attributes, work) => work();`,
    "better-auth": "export const betterAuth = () => ({ api: { getSession: async () => globalThis.__vibecloudTestSession } });",
  };
  const aliases = new Map();
  for (const [specifier, content] of Object.entries(mocks)) {
    const path = join(directory, `mock-${aliases.size}.mjs`);
    await writeFile(path, `${content}\n`);
    aliases.set(specifier, path);
  }
  const bundledHandler = join(directory, "agent-handler.mjs");
  await build({
    entryPoints: [join(directory, "src", "functions", "agent", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundledHandler,
    plugins: [{
      name: "test-aliases",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined);
      },
    }],
  });
  testGlobals.__vibecloudTestAI = {
    model: (name) => `g://${name}`,
    responses: {
      create: async ({ input, previous_response_id }) => input === "incomplete"
        ? { id: "response-bad", status: "incomplete", output_text: null }
        : { id: previous_response_id ? "response-2" : "response-1", status: "completed", output_text: `Answer: ${input}` },
    },
  };
  process.env.PRIMARY_ENDPOINT = "grpc://database";
  process.env.BETTER_AUTH_SECRET = "test-secret";
  try {
    const generated = await import(`${pathToFileURL(bundledHandler).href}?test=${Date.now()}`);
    const invoke = async (body: unknown, isBase64Encoded = false) => {
      const response = await generated.handler({
        httpMethod: "POST", resource: "/api/agent", path: "/api/agent",
        headers: {}, multiValueHeaders: {}, requestContext: { requestId: "gateway-request" },
        body: isBase64Encoded ? Buffer.from(JSON.stringify(body)).toString("base64") : JSON.stringify(body),
        isBase64Encoded,
      }, { requestId: "function-request", getRemainingTimeInMillis: () => 30_000 });
      return { ...response, body: JSON.parse(response.body) };
    };
    testGlobals.__vibecloudTestSession = undefined;
    assert.equal((await invoke({ prompt: "Hello" })).statusCode, 401);
    testGlobals.__vibecloudTestSession = { user: { id: "user-1" } };
    const first = await invoke({ prompt: "Hello" });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body, {
      id: "response-1",
      continuation: "signed-user-1-response-1",
      output: "Answer: Hello",
    });
    assert.equal((await invoke({ prompt: "Again", continuation: first.body.continuation })).body.id, "response-2");
    assert.equal((await invoke({ prompt: "Again", previousResponseId: "response-1" })).statusCode, 400);
    assert.equal((await invoke({ prompt: "incomplete" })).statusCode, 502);
    const encoded = await invoke({ prompt: "Привет 🌍" }, true);
    assert.equal(encoded.statusCode, 200);
    assert.equal(encoded.body.output, "Answer: Привет 🌍");
    assert.equal((await invoke([], true)).statusCode, 400);
  } finally {
    delete testGlobals.__vibecloudTestAI;
    delete testGlobals.__vibecloudTestSession;
    delete process.env.PRIMARY_ENDPOINT;
    delete process.env.BETTER_AUTH_SECRET;
  }
});

test("function --route creates a public asynchronous YandexART endpoint", async () => {
  const { directory, configPath } = await emptyProject("image-app");
  const result = runCli([
    "add", "function", "illustrator", "--template", "ai-image", "--route", "/api/images",
  ], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added: function illustrator with route ANY \/api\/images/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.illustrator, {
    template: "ai-image",
    handler: "index.handler",
  });
  assert.deepEqual(loaded.config.gateway.routes, [
    { pattern: "/api/images", function: "illustrator" },
  ]);
  assert.throws(() => validateConfig({
    ...loaded.config,
    functions: { illustrator: { ...loaded.config.functions?.illustrator, runtime: "python312" } },
  }), /AI templates require a nodejs runtime/);

  const source = await readFile(join(directory, "src", "functions", "illustrator", "index.ts"), "utf8");
  assert.match(source, /ai\.yandexArt\.start/);
  assert.match(source, /ai\.yandexArt\.retrieve/);
  assert.match(source, /requireYandexArtImage/);
  assert.match(source, /status: "in_progress"/);
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.dependencies["@vibecloud/ai"], (await cliPackage()).version);
  assert.equal(packageJson.dependencies["better-auth"], undefined);
  assert.equal(packageJson.dependencies["@vibecloud/db"], undefined);

  const terraform = await readFile(join(directory, "infra", "main.tf"), "utf8");
  assert.match(terraform, /template, null\) == "ai-image"/);
  assert.match(terraform, /ai\.imageGeneration\.user/);

  const mocks = {
    "@vibecloud/ai": `
export class AIEndpointError extends Error {}
export class AIStudioRequestError extends Error {}
export class YandexArtOperationError extends Error {}
export const createAIStudioClient = () => globalThis.__vibecloudTestArt;
export const createAIRateLimiter = () => ({ check: () => ({ limit: 5, remaining: 4 }) });
export const requireYandexArtImage = (operation) => ({
  operationId: operation.id,
  dataBase64: operation.response.image,
  image: Buffer.from(operation.response.image, "base64"),
  contentType: "image/jpeg",
  modelVersion: operation.response.modelVersion,
});`,
    "@vibecloud/telemetry": `
export const SpanKind = { SERVER: 1 };
export const setSpanAttributes = () => {};
export const traceInvocation = async (_name, _context, _options, work) => work();
export const withSpan = async (_name, _attributes, work) => work();`,
  };
  const aliases = new Map();
  for (const [specifier, content] of Object.entries(mocks)) {
    const path = join(directory, `image-mock-${aliases.size}.mjs`);
    await writeFile(path, `${content}\n`);
    aliases.set(specifier, path);
  }
  const bundledHandler = join(directory, "image-handler.mjs");
  await build({
    entryPoints: [join(directory, "src", "functions", "illustrator", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundledHandler,
    plugins: [{
      name: "test-aliases",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined);
      },
    }],
  });
  testGlobals.__vibecloudTestArt = {
    yandexArt: {
      start: async ({ prompt }) => ({ id: prompt === "Бумажный город 🌆" ? "operation-encoded" : "operation-1", done: false }),
      retrieve: async () => ({
        id: "operation-1",
        done: true,
        response: { image: Buffer.from("jpeg").toString("base64"), modelVersion: "1" },
      }),
    },
  };
  try {
    const generated = await import(`${pathToFileURL(bundledHandler).href}?test=${Date.now()}`);
    const invoke = (httpMethod: string, body = "", operationId?: string, isBase64Encoded = false) => generated.handler({
      httpMethod,
      resource: "/api/images",
      path: "/api/images",
      headers: {},
      multiValueHeaders: {},
      queryStringParameters: operationId ? { operationId } : null,
      requestContext: { requestId: "gateway-request", identity: { sourceIp: "127.0.0.1" } },
      body: isBase64Encoded ? Buffer.from(body).toString("base64") : body,
      isBase64Encoded,
    }, { requestId: "function-request", getRemainingTimeInMillis: () => 10_000 });
    const started = await invoke("POST", JSON.stringify({ prompt: "Paper city" }));
    assert.equal(started.statusCode, 202);
    assert.deepEqual(JSON.parse(started.body), { operationId: "operation-1", status: "in_progress" });
    const completed = await invoke("GET", "", "operation-1");
    assert.equal(completed.statusCode, 200);
    assert.equal(JSON.parse(completed.body).image.contentType, "image/jpeg");
    const encoded = await invoke("POST", JSON.stringify({ prompt: "Бумажный город 🌆" }), undefined, true);
    assert.equal(encoded.statusCode, 202);
    assert.equal(JSON.parse(encoded.body).operationId, "operation-encoded");
    assert.equal((await invoke("POST", "invalid JSON", undefined, true)).statusCode, 400);
  } finally {
    delete testGlobals.__vibecloudTestArt;
  }
});

test("function --route creates a serverless multimodal AI turn", async () => {
  const { directory, configPath } = await emptyProject("turn-app");
  assert.equal(runCli(["add", "database", "primary", "--migrations"], directory).status, 0);
  assert.equal(runCli(["add", "auth", "--database", "primary"], directory).status, 0);
  const arguments_ = ["add", "function", "assistant", "--template", "ai-turn", "--route", "/api/turn"];

  const result = runCli(arguments_, directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added: function assistant with route ANY \/api\/turn/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.assistant, {
    template: "ai-turn",
    handler: "index.handler",
    database: "primary",
    memory_mb: 256,
    timeout_seconds: 30,
  });
  assert.deepEqual(loaded.config.gateway.routes, [
    { pattern: "/api/auth/*", function: "auth" },
    { pattern: "/api/turn", function: "assistant" },
  ]);

  const source = await readFile(join(directory, "src", "functions", "assistant", "index.ts"), "utf8");
  assert.match(source, /input\.type must be text or audio/);
  assert.match(source, /output\.modalities must contain text, audio, or both/);
  assert.match(source, /ai\.speech\.transcribe\(audio/);
  assert.match(source, /ai\.responses\.create/);
  assert.match(source, /ai\.speech\.synthesize/);
  assert.match(source, /if \(wantsAudio\)/);
  assert.match(source, /previous_response_id/);
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.dependencies["@vibecloud/ai"], (await cliPackage()).version);

  const terraform = await readFile(join(directory, "infra", "main.tf"), "utf8");
  assert.match(terraform, /ai\.speechkit-stt\.user/);
  assert.match(terraform, /ai\.speechkit-tts\.user/);
  assert.match(terraform, /ai\.assistants\.editor/);

  const typecheckConfig = join(directory, "tsconfig.turn.json");
  await writeFile(typecheckConfig, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      ignoreDeprecations: "6.0",
      types: ["node"],
      typeRoots: [join(cliRoot, "node_modules", "@types")],
      baseUrl: directory,
      paths: {
        "@vibecloud/ai": [join(cliRoot, "..", "ai", "src", "index.ts")],
        "@vibecloud/core": [join(cliRoot, "..", "core", "src", "index.ts")],
        "@vibecloud/db": [join(cliRoot, "..", "db", "src", "index.ts")],
        "@vibecloud/db/better-auth": [join(cliRoot, "..", "db", "src", "better-auth.ts")],
        "@vibecloud/function-api": [join(cliRoot, "..", "function-api", "index.d.ts")],
        "@vibecloud/telemetry": [join(cliRoot, "..", "telemetry", "src", "index.ts")],
        "better-auth": [join(cliRoot, "..", "db", "node_modules", "better-auth", "dist", "index.d.mts")],
      },
    },
    include: [join(directory, "src", "functions", "assistant", "index.ts")],
  }, null, 2)}\n`);
  const typecheck = spawnSync(join(cliRoot, "node_modules", ".bin", "tsc"), [
    "--noEmit",
    "-p",
    typecheckConfig,
  ], { encoding: "utf8" });
  assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);

  const mockAi = join(directory, "mock-ai.mjs");
  const mockDb = join(directory, "mock-db.mjs");
  const mockDbAuth = join(directory, "mock-db-auth.mjs");
  const mockTelemetry = join(directory, "mock-telemetry.mjs");
  const mockBetterAuth = join(directory, "mock-better-auth.mjs");
  const bundledHandler = join(directory, "turn-handler.mjs");
  await writeFile(mockAi, `
export class AIEndpointError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
export class AIStudioRequestError extends Error {}
export class AIStudioResponseError extends Error {}
export const createAIStudioClient = () => globalThis.__vibecloudTestAI;
export const createAIRateLimiter = () => ({ check: () => ({ limit: 20, remaining: 19 }) });
export const createAIContinuation = (id) => \`signed-\${id}\`;
export const readAIContinuation = (value) => value.replace("signed-", "");
export const requireAIStudioOutputText = (response) => response.output_text;
`);
  await writeFile(mockDb, "export const getYdb = () => ({}); export const withYdb = async (_endpoint, work) => work();\n");
  await writeFile(mockDbAuth, "export const ydbAdapter = () => ({});\n");
  await writeFile(mockTelemetry, `
export const SpanKind = { SERVER: 1 };
export const businessEvent = () => {};
export const setSpanAttributes = () => {};
export const traceInvocation = async (_name, _context, _options, work) => work();
export const withSpan = async (_name, _attributes, work) => work();
`);
  await writeFile(mockBetterAuth, "export const betterAuth = () => ({ api: { getSession: async () => globalThis.__vibecloudTestSession } });\n");
  const aliases = new Map([
    ["@vibecloud/ai", mockAi],
    ["@vibecloud/db", mockDb],
    ["@vibecloud/db/better-auth", mockDbAuth],
    ["@vibecloud/telemetry", mockTelemetry],
    ["better-auth", mockBetterAuth],
  ]);
  await build({
    entryPoints: [join(directory, "src", "functions", "assistant", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundledHandler,
    plugins: [{
      name: "test-aliases",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined);
      },
    }],
  });

  const calls = { responses: 0, synthesize: 0, transcribe: 0 };
  testGlobals.__vibecloudTestAI = {
    model: (name) => `g://${name}`,
    responses: {
      create: async ({ input }) => {
        calls.responses += 1;
        return { id: `response-${calls.responses}`, output_text: `Answer: ${input}` };
      },
    },
    speech: {
      transcribe: async () => {
        calls.transcribe += 1;
        return "Spoken question";
      },
      synthesize: async () => {
        calls.synthesize += 1;
        return { audio: Uint8Array.from([1, 2, 3]), contentType: "audio/mpeg" };
      },
    },
  };
  testGlobals.__vibecloudTestSession = { user: { id: "user-1" } };
  process.env.PRIMARY_ENDPOINT = "grpc://database";
  process.env.BETTER_AUTH_SECRET = "test-secret";
  try {
    const generated = await import(`${pathToFileURL(bundledHandler).href}?test=${Date.now()}`);
    const invoke = async (body: unknown, isBase64Encoded = false) => {
      const response = await generated.handler({
        httpMethod: "POST",
        resource: "/api/turn",
        path: "/api/turn",
        headers: {},
        multiValueHeaders: {},
        requestContext: { requestId: "gateway-request" },
        body: isBase64Encoded ? Buffer.from(JSON.stringify(body)).toString("base64") : JSON.stringify(body),
        isBase64Encoded,
      }, { requestId: "function-request", getRemainingTimeInMillis: () => 30_000 });
      return { ...response, body: JSON.parse(response.body) };
    };

    testGlobals.__vibecloudTestSession = undefined;
    const unauthenticated = await invoke({
      input: { type: "text", text: "Hello" },
      output: { modalities: ["text"] },
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.deepEqual(calls, { responses: 0, synthesize: 0, transcribe: 0 });
    testGlobals.__vibecloudTestSession = { user: { id: "user-1" } };

    const invalid = await invoke({
      input: { type: "text", text: "Hello" },
      output: { modalities: [] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(calls, { responses: 0, synthesize: 0, transcribe: 0 });

    const text = await invoke({
      input: { type: "text", text: "Hello" },
      output: { modalities: ["text"] },
    });
    assert.equal(text.statusCode, 200);
    assert.deepEqual(text.body, {
      id: "response-1",
      continuation: "signed-response-1",
      input: { type: "text" },
      output: { text: "Answer: Hello" },
    });
    assert.deepEqual(calls, { responses: 1, synthesize: 0, transcribe: 0 });

    const audio = await invoke({
      input: {
        type: "audio",
        dataBase64: Buffer.from("audio").toString("base64"),
        format: "oggopus",
      },
      output: { modalities: ["text", "audio"], audio: { format: "mp3" } },
      continuation: "signed-response-1",
    });
    assert.equal(audio.statusCode, 200);
    assert.deepEqual(audio.body, {
      id: "response-2",
      continuation: "signed-response-2",
      input: { type: "audio", transcript: "Spoken question" },
      output: {
        text: "Answer: Spoken question",
        audio: { chunks: [{ dataBase64: "AQID" }], format: "mp3", contentType: "audio/mpeg" },
      },
    });
    assert.deepEqual(calls, { responses: 2, synthesize: 1, transcribe: 1 });

    const audioOnly = await invoke({
      input: { type: "text", text: "Read this" },
      output: { modalities: ["audio"] },
    });
    assert.equal(audioOnly.statusCode, 200);
    assert.deepEqual(audioOnly.body, {
      id: "response-3",
      continuation: "signed-response-3",
      input: { type: "text" },
      output: {
        audio: { chunks: [{ dataBase64: "AQID" }], format: "mp3", contentType: "audio/mpeg" },
      },
    });
    assert.deepEqual(calls, { responses: 3, synthesize: 2, transcribe: 1 });

    const chunked = await invoke({
      input: { type: "text", text: "word ".repeat(60) },
      output: { modalities: ["audio"] },
    });
    assert.equal(chunked.statusCode, 200);
    assert.equal(chunked.body.output.audio.chunks.length, 2);
    assert.deepEqual(calls, { responses: 4, synthesize: 4, transcribe: 1 });
    const encoded = await invoke({
      input: { type: "text", text: "Привет 🌍" },
      output: { modalities: ["text"] },
    }, true);
    assert.equal(encoded.statusCode, 200);
    assert.equal(encoded.body.output.text, "Answer: Привет 🌍");
    assert.equal((await invoke([], true)).statusCode, 400);
    assert.deepEqual(calls, { responses: 5, synthesize: 4, transcribe: 1 });
  } finally {
    delete testGlobals.__vibecloudTestAI;
    delete testGlobals.__vibecloudTestSession;
    delete process.env.PRIMARY_ENDPOINT;
    delete process.env.BETTER_AUTH_SECRET;
  }
});

test("function --route atomically creates a websocket function", async () => {
  const { directory, configPath } = await emptyProject("socket-app");
  const arguments_ = ["add", "function", "game", "--template", "websocket", "--route", "/ws"];

  const first = runCli(arguments_, directory);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /added: function game with route WS \/ws/);
  assert.match(first.stdout, /created: src\/functions\/game\/index\.ts/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.game, {
    template: "websocket",
    handler: "index.handler",
  });
  assert.deepEqual(loaded.config.gateway.routes, [{
    pattern: "/ws",
    method: "WS",
    function: "game",
  }]);
  assert.ok(listConfig(loaded.config, "routes").includes("route\tWS /ws -> function:game"));

  const source = await readFile(join(directory, "src", "functions", "game", "index.ts"), "utf8");
  assert.match(source, /from "@vibecloud\/function-ws"/);
  assert.match(source, /eventType !== "MESSAGE"/);
  const packageJson = await readJson(join(directory, "package.json"));
  const manifest = await cliPackage();
  assert.equal(packageJson.devDependencies["@vibecloud/cli"], manifest.version);
  assert.equal(packageJson.devDependencies["@vibecloud/function-ws"], manifest.version);

  const terraform = await readFile(join(directory, "infra", "main.tf"), "utf8");
  assert.match(terraform, /x-yc-apigateway-websocket-\$\{event\}/);
  assert.match(terraform, /api-gateway\.websocketWriter/);

  const second = runCli(arguments_, directory);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged: function game with route WS \/ws/);

  const output = join(directory, "dist", "functions", "game", "index.js");
  await mkdir(dirname(output), { recursive: true });
  const build = spawnSync(join(cliRoot, "node_modules", ".bin", "esbuild"), [
    join(directory, "src", "functions", "game", "index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${output}`,
  ], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  await stat(output);
});

test("asset --route atomically creates a Vite asset", async () => {
  const { directory, configPath } = await emptyProject("website-app");
  const arguments_ = ["add", "asset", "website", "--template", "vite", "--route", "/*"];

  const first = runCli(arguments_, directory);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /added: asset website with route ANY \/\*/);
  assert.match(first.stdout, /created: src\/assets\/website\/App\.tsx/);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.assets?.website, {
    template: "vite",
    build: { command: "pnpm build" },
  });
  assert.deepEqual(loaded.config.gateway.routes, [{ pattern: "/*", assets: "website" }]);
  assert.ok(listConfig(loaded.config, "routes").includes("route\tANY /* -> assets:website"));

  const second = runCli(arguments_, directory);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged: asset website with route ANY \/\*/);
});

test("function --cron atomically scaffolds and schedules a timer function", async () => {
  const { directory, configPath } = await emptyProject("cron-app");
  const result = runCli([
    "add",
    "function",
    "cleanup",
    "--cron",
    "0 * ? * * *",
    "--payload",
    "compact",
  ], directory);
  assert.equal(result.status, 0, result.stderr);

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.functions?.cleanup, {
    template: "cron-trigger",
    handler: "index.run",
    cron: { expression: "0 * ? * * *", payload: "compact" },
  });
  assert.ok(listConfig(loaded.config, "cron").includes("cron\tcleanup <- 0 * ? * * *"));
  assert.match(
    await readFile(join(directory, "src", "functions", "cleanup", "index.ts"), "utf8"),
    /from "@vibecloud\/function-trigger-cron"/,
  );
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.devDependencies["@vibecloud/function-trigger-cron"], (await cliPackage()).version);

  const terraform = await readFile(join(directory, "infra", "main.tf"), "utf8");
  assert.match(terraform, /resource "yandex_function_trigger" "crons"/);
  assert.match(terraform, /cron_expression = each\.value\.expression/);

  await renameResource(configPath, "function", "cleanup", "sweep");
  const moves = await readFile(join(directory, "infra", "moves.auto.tf"), "utf8");
  assert.match(moves, /from = yandex_function_trigger\.crons\["cleanup"\]/);
  assert.match(moves, /to\s+= yandex_function_trigger\.crons\["sweep"\]/);
});

test("cron validation enforces Yandex Cloud field syntax and ranges", () => {
  for (const expression of [
    "0 * ? * * *",
    "*/15 10-12 ? JAN,MAR MON-FRI 2026",
    "0 9 15W * ?",
    "0 9 ? * 6#3",
    "0 9 LW * ? *",
  ]) assert.equal(validateCronExpression(expression), true, expression);

  for (const expression of [
    "60 * ? * * *",
    "0 24 ? * * *",
    "0 9 32 * ? *",
    "0 9 ? 13 * *",
    "0 9 ? * MON#6 *",
    "0 9 * * * *",
    "0 9 ? * ? *",
    "0 9 ? * FUNDAY *",
    "0 9 ? * MON-FRI/0 *",
  ]) assert.equal(validateCronExpression(expression), false, expression);
});
