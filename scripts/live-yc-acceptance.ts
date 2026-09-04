import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcceptanceWorkspace, removeSuccessfulAcceptanceWorkspace } from "./acceptance-workspace.ts";

if (process.env.VIBECLOUD_LIVE_YC !== "1") {
  console.log("live YC acceptance skipped; set VIBECLOUD_LIVE_YC=1 to create billable temporary resources");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ACCEPTANCE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const temporary = createAcceptanceWorkspace(join(root, ".tmp"), "vibecloud-live-yc-", { ttlMs: LIVE_ACCEPTANCE_TTL_MS });
const name = `vc-live-${Date.now().toString(36)}`;
const project = join(temporary, name);
const marker = `vibecloud-live-${crypto.randomUUID()}`;
const registry = process.env.VIBECLOUD_LOCAL_REGISTRY ?? "http://registry.verdaccio.orb.local/";
const cli = join(root, "packages", "cli", "dist", "vibecloud.js");
const version = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;
const startedAt = new Date(Date.now() - 60_000).toISOString();
const environment = {
  ...process.env,
  PNPM_CONFIG_REGISTRY: registry,
  PNPM_CONFIG_PREFER_ONLINE: "true",
};
let passed = false;
let failure: unknown;
let folderId: string | undefined;

try {
  run("yc", ["version"], root, environment);
  run("terraform", ["version"], root, environment);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, ".npmrc"), `registry=${registry}\n@vibecloud:registry=${registry}\n`);
  writeFileSync(join(project, "pnpm-workspace.yaml"), `packages: []\n\nminimumReleaseAgeExclude:\n  - "@vibecloud/cli@${version}"\n  - "@vibecloud/function-api@${version}"\n  - "@vibecloud/function-ws@${version}"\n  - "@vibecloud/function-trigger-cron@${version}"\n`);
  run(process.execPath, [cli, "init", project], root, environment);
  const metadataPath = join(project, ".vibecloud", "project.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.yc_folder_lifecycle, "managed");
  folderId = metadata.yc_folder_id;
  assert.ok(typeof folderId === "string");

  run(process.execPath, [cli, "add", "function", "ping", "--template", "api", "--route", "/api/ping"], project, environment);
  run(process.execPath, [cli, "add", "function", "socket", "--template", "websocket", "--route", "/ws"], project, environment);
  run(process.execPath, [cli, "add", "function", "timer", "--cron", "* * ? * * *", "--payload", marker], project, environment);

  const configPath = join(project, "infra", "vibecloud.auto.tfvars.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.observability = { platform_logs: { enabled: true, min_level: "INFO" } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(project, "src", "functions", "ping", "index.ts"), httpHandler(marker));
  writeFileSync(join(project, "src", "functions", "socket", "index.ts"), websocketHandler(marker));
  writeFileSync(join(project, "src", "functions", "timer", "index.ts"), cronHandler(marker));
  run("pnpm", ["install"], project, environment);
  run("pnpm", ["push"], project, environment);
  const terraformState = JSON.parse(capture(
    "terraform", ["-chdir=infra", "show", "-json"], project, environment,
  ));
  const deployerBinding = terraformState.values.root_module.resources.find(
    (resource: { address: string, values: { member?: string } }) => resource.address === "yandex_iam_service_account_iam_member.deployer_use",
  );
  assert.match(deployerBinding?.values?.member ?? "", /^(userAccount|serviceAccount|federatedUser):/);
  const terraformEnvironment = {
    ...environment,
    YC_TOKEN: capture("yc", ["iam", "create-token"], root, environment).trim(),
    YC_FOLDER_ID: folderId,
    TF_VAR_deployer_subject: deployerBinding.values.member,
    TF_CLI_CONFIG_FILE: join(project, "infra", "terraform.rc"),
  };
  run("terraform", ["-chdir=infra", "plan", "-input=false", "-lock=false", "-detailed-exitcode", "-no-color"], project, terraformEnvironment);

  const baseUrl = capture("terraform", ["-chdir=infra", "output", "-raw", "url"], project, environment).trim();
  const response = await retryUntil("HTTP route", 180_000, async () => {
    const value = await fetch(`${baseUrl}/api/ping`);
    if (!value.ok) throw new Error(`HTTP ${value.status}: ${await value.text()}`);
    const body = await value.json() as { marker?: string, ok?: boolean };
    assert.equal(body.marker, marker);
    return body;
  });
  assert.equal(response.ok, true);

  run(process.execPath, [join(root, "scripts", "live-websocket-smoke.ts"), `${baseUrl}/ws`], root, environment);
  await waitForFunctionLogs("ping", [marker, "HTTP"], 180_000);
  await waitForFunctionLogs("socket", [marker, "CONNECT", "MESSAGE", "DISCONNECT"], 240_000);
  await waitForFunctionLogs("timer", [marker, "CRON"], 420_000);
  console.log(`live YC HTTP/WebSocket/cron/log acceptance passed in folder ${folderId}`);
  passed = true;
} catch (error) {
  failure = error;
  if (folderId) printFunctionDiagnostics(["ping", "socket", "timer"]);
} finally {
  if (folderId) {
    try {
      run("yc", ["resource-manager", "folder", "delete", "--id", folderId, "--async"], root, environment);
      console.log(`submitted asynchronous deletion for live acceptance folder ${folderId}`);
    } catch (error) {
      failure ??= new Error(`live acceptance cleanup failed for folder ${folderId}`, { cause: error });
    }
  }
  if (passed && !failure) removeSuccessfulAcceptanceWorkspace(temporary, { keep: Boolean(process.env.VIBECLOUD_KEEP_ACCEPTANCE) });
  else console.error(`live acceptance workspace retained at ${temporary}`);
}

if (failure) throw failure;

async function waitForFunctionLogs(functionKey: string, required: string[], timeoutMs: number) {
  assert.ok(folderId);
  const functionName = `${name}-${functionKey}`;
  const functionDescription = JSON.parse(capture("yc", [
    "serverless", "function", "get", "--name", functionName,
    "--folder-id", folderId, "--format", "json",
  ], root, environment, { timeout: 15_000 }));
  return retryUntil(`${functionName} logs`, timeoutMs, async () => {
    const logs = capture("yc", [
      "logging", "read", "--group-name", "default", "--folder-id", folderId,
      "--resource-ids", functionDescription.id, "--since", startedAt,
      "--until", new Date().toISOString(), "--limit", "100",
      "--filter", `json_payload.marker = "${marker}"`, "--format", "json",
    ], root, environment, { timeout: 15_000 });
    for (const value of required) assert.match(logs, new RegExp(value));
    return logs;
  });
}

function printFunctionDiagnostics(functionKeys: string[]) {
  assert.ok(folderId);
  for (const functionKey of functionKeys) {
    try {
      const logs = capture("yc", [
        "serverless", "function", "logs", "--name", `${name}-${functionKey}`,
        "--folder-id", folderId, "--since", startedAt, "--limit", "200",
      ], root, environment, { timeout: 15_000 }).trim();
      if (logs) console.error(`diagnostic logs for ${functionKey}:\n${logs}`);
    } catch (error) {
      console.error(`could not read diagnostic logs for ${functionKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function retryUntil<T>(label: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(10_000);
    }
  }
  throw new Error(`${label} did not become observable within ${timeoutMs / 1000}s`, { cause: lastError });
}

function run(command: string, arguments_: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, arguments_, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} failed with exit code ${result.status}`);
}

function capture(command: string, arguments_: string[], cwd: string, env: NodeJS.ProcessEnv, options: { timeout?: number } = {}) {
  const result = spawnSync(command, arguments_, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed with exit code ${result.status}`);
  return result.stdout;
}

function httpHandler(value: string) {
  return `import type { HttpEvent, HttpResponse, InvocationContext } from "@vibecloud/function-api";
export async function handler(event: HttpEvent, context: InvocationContext): Promise<HttpResponse> {
  console.log(JSON.stringify({ message: "Vibecloud live acceptance HTTP", level: "INFO", marker: ${JSON.stringify(value)}, lifecycle: "HTTP", requestId: context.requestId }));
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, marker: ${JSON.stringify(value)}, method: event.httpMethod }) };
}
`;
}

function websocketHandler(value: string) {
  return `import type { InvocationContext, WebSocketEvent, WebSocketResponse } from "@vibecloud/function-ws";
export async function handler(event: WebSocketEvent, context: InvocationContext): Promise<WebSocketResponse> {
  const { connectionId, eventType } = event.requestContext;
  console.log(JSON.stringify({ message: "Vibecloud live acceptance " + eventType, level: "INFO", marker: ${JSON.stringify(value)}, lifecycle: eventType, connectionId, requestId: context.requestId }));
  if (eventType !== "MESSAGE") return { statusCode: 200, body: "" };
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, connectionId, messageId: event.requestContext.messageId, requestId: context.requestId, body: event.body }) };
}
`;
}

function cronHandler(value: string) {
  return `import type { InvocationContext, TimerEvent } from "@vibecloud/function-trigger-cron";
export async function run(event: TimerEvent, context: InvocationContext): Promise<void> {
  console.log(JSON.stringify({ message: "Vibecloud live acceptance CRON", level: "INFO", marker: ${JSON.stringify(value)}, lifecycle: "CRON", messages: event.messages.length, requestId: context.requestId }));
}
`;
}
