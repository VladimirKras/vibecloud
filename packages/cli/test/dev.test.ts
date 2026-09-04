import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  LOCAL_BIND_HOST,
  detectContainerRuntime,
  invokeLocalFunction,
  localFolderId,
  localYdbLocation,
  matchHttpRoute,
  composeArguments,
  resolveLocalAiCredentials,
} from "../src/dev.ts";
import { loadConfig } from "../src/config.ts";
import { emptyProject, readJson } from "./helpers.ts";

test("local services listen on the IPv4/IPv6 dual-stack host", () => {
  assert.equal(LOCAL_BIND_HOST, "::");
});

test("local dev reads a managed YC folder ID from initialized config", async () => {
  const { configPath } = await emptyProject("local-folder-app");
  const loaded = await loadConfig(configPath);
  const folderId = await localFolderId(loaded, async () => {
    throw new Error("Terraform should not run");
  });
  assert.equal(folderId, "local-folder-app-folder-id");
});

test("local dev uses an adopted YC folder without reading Terraform state", async () => {
  const { configPath } = await emptyProject("adopted-local-folder-app", "adopted-folder-id");
  const loaded = await loadConfig(configPath);
  assert.equal(await localFolderId(loaded, async () => {
    throw new Error("Terraform should not run");
  }), "adopted-folder-id");
});

test("local route matching honors methods, wildcards, and function routes", () => {
  const routes = [
    { pattern: "/exact", method: "POST", function: "api" },
    { pattern: "/exact", function: "fallback" },
    { pattern: "/api/*", function: "api" },
    { pattern: "/api/todos", function: "specific" },
    { pattern: "/*", assets: "website" },
  ];
  assert.equal(matchHttpRoute(routes, "POST", "/exact"), routes[0]);
  assert.equal(matchHttpRoute(routes, "GET", "/exact"), routes[1]);
  assert.equal(matchHttpRoute(routes, "GET", "/api/todos"), routes[3]);
  assert.equal(matchHttpRoute(routes, "GET", "/api/other"), routes[2]);
  assert.equal(matchHttpRoute(routes, "GET", "/outside"), undefined);
});

test("local YDB uses the project-isolated OrbStack hostname", () => {
  assert.deepEqual(localYdbLocation("billing-app"), {
    composeProject: "billing-app",
    appHost: "billing-app.orb.local",
    appServiceHost: "app.billing-app.orb.local",
    host: "ydb.billing-app.orb.local",
    endpoint: "grpc://ydb.billing-app.orb.local:2136/local",
    uiUrl: "http://ydb.billing-app.orb.local",
    containerYdbEndpoint: "grpc://ydb:2136/local",
  });
});

test("ordinary Docker publishes localhost endpoints", () => {
  assert.deepEqual(localYdbLocation("billing-app", "docker"), {
    composeProject: "billing-app",
    appHost: "localhost",
    appServiceHost: "localhost",
    host: "localhost",
    endpoint: "grpc://localhost:2136/local",
    uiUrl: "http://localhost:8765",
    containerYdbEndpoint: "grpc://ydb:2136/local",
  });
});

test("container runtime detection keeps OrbStack optional", async () => {
  const calls: string[][] = [];
  assert.equal(await detectContainerRuntime("/workspace", async (_command, arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "info") return "Docker Desktop";
    if (arguments_[0] === "compose") return "2.30.0";
    return "desktop-linux";
  }), "docker");
  assert.equal(await detectContainerRuntime("/workspace", async (_command, arguments_) => {
    if (arguments_[0] === "info") return "OrbStack";
    if (arguments_[0] === "compose") return "2.30.0";
    return "orbstack";
  }), "orbstack");
  assert.ok(calls.some((arguments_) => (
    arguments_[0] === "info"
    && arguments_[1] === "--format"
    && arguments_[2] === "{{json .}}"
  )));
  assert.ok(calls.some((arguments_) => arguments_[0] === "compose"));
});

test("local AI credentials prefer API keys, then IAM tokens, then yc", async () => {
  const api = await resolveLocalAiCredentials({
    YANDEX_CLOUD_API_KEY: "api-key",
    YANDEX_CLOUD_IAM_TOKEN: "iam-token",
  }, async () => { throw new Error("yc must not run"); });
  assert.equal(api.source, "api-key");
  assert.deepEqual(api.environment, { YANDEX_CLOUD_API_KEY: "api-key" });

  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
  const iam = await resolveLocalAiCredentials({ YANDEX_CLOUD_IAM_TOKEN: `header.${payload}.signature` }, async () => {
    throw new Error("yc must not run");
  });
  assert.equal(iam.source, "iam-token");
  assert.equal(iam.expiresAt?.toISOString(), "2033-05-18T03:33:20.000Z");

  const profile = await resolveLocalAiCredentials({}, async (command, arguments_) => {
    assert.equal(command, "yc");
    assert.deepEqual(arguments_, ["iam", "create-token"]);
    return "profile-token\n";
  });
  assert.equal(profile.source, "yc-profile");
  assert.deepEqual(profile.environment, { YANDEX_CLOUD_IAM_TOKEN: "profile-token" });
  assert.ok(profile.refreshBy);
  assert.ok(profile.refreshBy.getTime() > Date.now());
});

test("local Compose watches changes and attaches only application logs", () => {
  assert.deepEqual(composeArguments("billing-app", "/workspace/infra/local.compose.yaml"), [
    "compose",
    "--ansi", "never",
    "--progress", "plain",
    "--project-name", "billing-app",
    "-f", "/workspace/infra/local.compose.yaml",
    "up", "--build", "--watch", "--attach", "app", "--exit-code-from", "app",
  ]);
  assert.deepEqual(composeArguments(
    "billing-app",
    "/workspace/infra/local.compose.yaml",
    "/workspace/infra/local.orbstack.compose.yaml",
  ), [
    "compose",
    "--ansi", "never",
    "--progress", "plain",
    "--project-name", "billing-app",
    "-f", "/workspace/infra/local.compose.yaml",
    "-f", "/workspace/infra/local.orbstack.compose.yaml",
    "up", "--build", "--watch", "--attach", "app", "--exit-code-from", "app",
  ]);
});

test("local gateway invokes a built Node function with the cloud event shape", async () => {
  const { directory, configPath } = await emptyProject("local-gateway-app");
  const initialized = await readJson(configPath);
  await writeFile(configPath, `${JSON.stringify({
    ...initialized,
    name: "local-gateway-app",
    gateway: { routes: [{ pattern: "/api/*", function: "api" }] },
    functions: { api: { template: "api", handler: "index.handler" } },
  }, null, 2)}\n`);
  const output = join(directory, "dist", "functions", "api");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(join(output, "index.js"), `exports.handler = async (event, context) => ({
    statusCode: 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: event.httpMethod, path: event.path, query: event.queryStringParameters, body: event.body, functionName: context.functionName }),
  });\n`);

  const response = await invokeLocalFunction(await loadConfig(configPath), {
    method: "POST",
    url: new URL("http://127.0.0.1:8787/api/todos?page=2"),
    headers: { host: "127.0.0.1:8787" },
    body: Buffer.from("payload"),
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), {
    method: "POST",
    path: "/api/todos",
    query: { page: "2" },
    body: "payload",
    functionName: "api",
  });
});
