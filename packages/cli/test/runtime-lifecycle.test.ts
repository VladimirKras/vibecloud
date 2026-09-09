import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { disposeLocalFunctions, invokeLocalFunction } from "../src/dev.ts";
import { LocalFunctionTimeoutError } from "../src/local-functions.ts";
import { withProjectLock } from "../src/project-lock.ts";
import { migrateProjectDatabases } from "../src/push.ts";
import { emptyProject, activeFolder } from "./helpers.ts";

test("db up waits for the project lock and reloads configuration after acquiring it", async () => {
  const { directory, configPath } = await emptyProject("migration-lock-app");
  const loaded = await loadConfig(configPath);
  loaded.config.databases = { old: { migrations: true } };
  await writeFile(configPath, JSON.stringify(loaded.config));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = withProjectLock(directory, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const paths: string[] = [];
  const migration = migrateProjectDatabases(loaded, {
    environment: { YC_TOKEN: "mock", YC_CLOUD_ID: "mock", YC_SUBJECT: "userAccount:mock" },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(loaded) : JSON.stringify({ current: "grpc://mock/local" }),
    runMigration: async (_root, _connection, path) => { paths.push(path); },
  });
  try {
    await delay(75);
    assert.deepEqual(paths, []);
    await writeFile(configPath, JSON.stringify({ ...loaded.config, databases: { current: { migrations: true } } }));
  } finally { release.resolve(); }
  await owner;
  assert.deepEqual(await migration, ["current"]);
  assert.deepEqual(paths, [join(directory, "src/databases/current/migrations")]);
});

test("local invocation reports the compiled group's memory and deadline", async () => {
  const loaded = await localProject("runtime-limits-app", 3, "exports.handler = async (_event, context) => ({statusCode:200,body:JSON.stringify({memory:context.memoryLimitInMB,remaining:context.getRemainingTimeInMillis()})});");
  try {
    const context = JSON.parse((await invokeLocalFunction(loaded, request("/"))).body);
    assert.equal(context.memory, 512);
    assert.ok(context.remaining > 0 && context.remaining <= 3_000, context.remaining);
  } finally { await disposeLocalFunctions(loaded); }
});

test("local deadlines terminate both stalled promises and synchronous loops, then restart the worker", async () => {
  const loaded = await localProject("runtime-timeout-app", 0.3, `
let calls = 0;
exports.handler = async (event) => {
  calls++;
  if(event.path === "/async") await new Promise(() => {});
  if(event.path === "/sync") while(true) {}
  return {statusCode:200,body:String(calls)};
};`);
  try {
    for (const path of ["/async", "/sync"]) {
      await assert.rejects(invokeLocalFunction(loaded, request(path)), LocalFunctionTimeoutError);
      assert.equal((await invokeLocalFunction(loaded, request("/"))).body, "1");
    }
  } finally { await disposeLocalFunctions(loaded); }
});

const request = (path: string) => ({ method: "GET", url: new URL(`http://localhost${path}`), headers: {}, body: Buffer.alloc(0) });

async function localProject(name: string, timeout: number, handler: string) {
  const { directory, configPath } = await emptyProject(name);
  const loaded = await loadConfig(configPath);
  loaded.config.functions = { api: { handler: "index.handler", memory_mb: 512, timeout_seconds: timeout } };
  loaded.config.gateway.routes = [{ pattern: "/*", function: "api" }];
  await writeFile(configPath, JSON.stringify(loaded.config));
  const output = join(directory, "dist/functions/http-nodejs22");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "package.json"), '{"type":"commonjs"}');
  await writeFile(join(output, "router.js"), handler);
  return loaded;
}

test("db up forwards deliberate interrupted-migration recovery to the installed runner", async () => {
  const { configPath } = await emptyProject("migration-recovery-app");
  const loaded = await loadConfig(configPath);
  loaded.config.databases = { primary: { migrations: true } };
  await writeFile(configPath, JSON.stringify(loaded.config));
  let recovery: unknown;
  await migrateProjectDatabases(loaded, {
    migrationRecovery: "retry",
    environment: { YC_TOKEN: "mock", YC_CLOUD_ID: "mock", YC_SUBJECT: "userAccount:mock" },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(loaded) : JSON.stringify({ primary: "grpc://mock/local" }),
    runMigration: async (_root, _connection, _path, _token, options) => { recovery = options; },
  });
  assert.deepEqual(recovery, { recovery: "retry" });
});
