import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import filesystem, { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  addAsset,
  addAuth,
  addFunction,
  addResource,
  addRoute,
  addSecret,
  addStream,
  addTrigger,
  listConfig,
  renameResource,
  renameSecret,
  renameStream,
  removeResource,
  removeSecret,
} from "../src/config-edit.ts";
import { loadConfig } from "../src/config.ts";
import { createResourceScaffold } from "../src/scaffold.ts";
import { emptyProject, freshProject } from "./helpers.ts";

test("resource edits are validated and idempotent", async () => {
  const { configPath } = await freshProject();
  assert.equal((await addResource(configPath, "bucket", "media")).action, "added");
  assert.equal((await addResource(configPath, "bucket", "media")).action, "unchanged");
  assert.equal((await addResource(configPath, "function", "worker", {
    template: "datastream-trigger",
  })).action, "added");
  await addStream(configPath, "primary.events");
  await addTrigger(configPath, "worker", { stream: "primary.events", retryAttempts: 3 });
  await addRoute(configPath, "GET", "/health", { function: "api" });
  await addRoute(configPath, "POST", "/health", { function: "api" });
  await addSecret(configPath, "WEBHOOK_SECRET");

  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config.buckets?.media, {});
  assert.equal(loaded.config.functions?.worker.handler, "index.consume");
  assert.equal(loaded.config.functions?.worker.triggers?.[0].retry_attempts, 3);
  assert.ok(listConfig(loaded.config).includes("stream\tprimary.events"));
  assert.ok(listConfig(loaded.config, "routes").includes("route\tGET /health -> function:api"));
  assert.ok(listConfig(loaded.config, "routes").includes("route\tPOST /health -> function:api"));

  const before = await readFile(configPath, "utf8");
  await assert.rejects(() => removeResource(configPath, "database", "primary"), /unknown stream: primary\.events/);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal((await removeSecret(configPath, "WEBHOOK_SECRET")).action, "removed");
  assert.equal((await removeSecret(configPath, "WEBHOOK_SECRET")).action, "unchanged");
});

test("trigger and route validation rejects unsupported cloud values", async () => {
  const { configPath } = await freshProject();
  await addResource(configPath, "function", "worker", { template: "datastream-trigger" });
  for (const options of [
    { stream: "primary.events", batchSizeBytes: 65_537 },
    { stream: "primary.events", batchCutoffSeconds: 61 },
    { stream: "primary.events", retryAttempts: 6 },
    { stream: "primary.events", retryIntervalSeconds: 9 },
  ]) await assert.rejects(() => addTrigger(configPath, "worker", options), /must be an integer from/);

  await assert.rejects(
    () => addRoute(configPath, "GET", "/contains a space", { function: "api" }),
    /URL-safe literal segments/,
  );
  await assert.rejects(
    () => addRoute(configPath, "GET", "/wild/*/tail", { function: "api" }),
    /URL-safe literal segments/,
  );
  await assert.rejects(
    () => addRoute(configPath, "POST", "/static", { assets: "website" }),
    /assets route must use GET or ANY/,
  );

  const source = JSON.parse(await readFile(configPath, "utf8"));
  source.gateway.routes.push({ pattern: "/api/*", method: "ANY", function: "api" });
  await writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`);
  await assert.rejects(() => loadConfig(configPath), /duplicates the generated gateway operation/);
});

test("routable asset edits reject conflicts without partial writes", async () => {
  const { configPath } = await emptyProject("atomic-asset-route-app");
  assert.equal((await addFunction(configPath, "api", { template: "api" }, "/*")).action, "added");
  const before = await readFile(configPath, "utf8");
  await assert.rejects(
    () => addAsset(configPath, "website", { template: "vite" }, "/*"),
    /route ANY \/\* already exists with a different declaration/,
  );
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("routable function edits reject incompatible templates without partial writes", async () => {
  const { configPath } = await emptyProject("atomic-route-app");
  assert.equal((await addFunction(configPath, "api", { template: "api" }, "/api/*")).action, "added");
  assert.deepEqual((await loadConfig(configPath)).config.gateway.routes, [{ pattern: "/api/*", function: "api" }]);

  const before = await readFile(configPath, "utf8");
  await assert.rejects(
    () => addFunction(configPath, "events", { template: "datastream-trigger" }, "/events"),
    /--route cannot be used with the datastream-trigger template/,
  );
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("rename updates references, source paths, and Terraform moved blocks", async () => {
  const { directory, configPath } = await freshProject();
  await addResource(configPath, "function", "worker", { template: "datastream-trigger" });
  await mkdir(join(directory, "src", "functions", "worker"), { recursive: true });
  await writeFile(join(directory, "src", "functions", "worker", "marker.ts"), "export {};\n");
  await addStream(configPath, "primary.events");
  await addTrigger(configPath, "worker", { stream: "primary.events" });

  await renameResource(configPath, "function", "worker", "consumer");
  await renameResource(configPath, "database", "primary", "data");
  await renameStream(configPath, "data.events", "data.changes");
  await renameResource(configPath, "asset", "website", "web");
  await renameResource(configPath, "bucket", "uploads", "media");
  await renameSecret(configPath, "BETTER_AUTH_SECRET", "AUTH_SECRET");

  const loaded = await loadConfig(configPath);
  assert.equal(loaded.config.functions?.consumer.triggers?.[0].stream, "data.changes");
  assert.equal(loaded.config.gateway.routes?.find((route) => route.pattern === "/*")?.assets, "web");
  assert.deepEqual(loaded.config.secrets?.entries, { AUTH_SECRET: {} });
  await stat(join(directory, "src", "functions", "consumer", "marker.ts"));

  const moves = await readFile(join(directory, "infra", "moves.auto.tf"), "utf8");
  assert.match(moves, /from = yandex_function\.functions\["worker"\]/);
  assert.match(moves, /to\s+= yandex_ydb_database_serverless\.databases\["data"\]/);
  assert.match(moves, /to\s+= yandex_ydb_topic\.streams\["data\.changes"\]/);
  assert.match(moves, /to\s+= yandex_function_trigger\.triggers\["consumer\/data\.changes"\]/);
  assert.match(moves, /to\s+= yandex_storage_bucket\.assets\["web"\]/);
  assert.match(moves, /from = yandex_lockbox_secret_version\.application\["BETTER_AUTH_SECRET"\]/);

  const result = spawnSync("terraform", ["-chdir=infra", "fmt", "-check", "-diff"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("function renames preserve trigger identities across multiple consumers", async () => {
  const { directory, configPath } = await freshProject();
  await addStream(configPath, "primary.audit");
  for (const name of ["worker", "observer"]) {
    await addResource(configPath, "function", name, { template: "datastream-trigger" });
    await addTrigger(configPath, name, { stream: "primary.events" });
  }
  await addTrigger(configPath, "worker", { stream: "primary.audit" });
  const movesPath = join(directory, "infra", "moves.auto.tf");
  const triggerMoves = async () => [...(await readFile(movesPath, "utf8")).matchAll(
    /from = yandex_function_trigger\.triggers\["([^"]+)"\]\s+to\s+= yandex_function_trigger\.triggers\["([^"]+)"\]/g,
  )].map(([, from, to]) => [from, to]);

  await renameResource(configPath, "function", "worker", "consumer");
  const expected = [
    ["worker/primary.events", "consumer/primary.events"],
    ["worker/primary.audit", "consumer/primary.audit"],
  ];
  assert.deepEqual(await triggerMoves(), expected);
  assert.deepEqual((await loadConfig(configPath)).config.functions?.observer.triggers, [{ stream: "primary.events" }]);
  assert.equal((await renameResource(configPath, "function", "worker", "consumer")).action, "unchanged");
  assert.deepEqual(await triggerMoves(), expected);

  await renameResource(configPath, "database", "primary", "data");
  expected.push(
    ["observer/primary.events", "observer/data.events"],
    ["consumer/primary.events", "consumer/data.events"],
    ["consumer/primary.audit", "consumer/data.audit"],
  );
  assert.deepEqual(await triggerMoves(), expected);
  await renameStream(configPath, "data.events", "data.changes");
  expected.push(
    ["observer/data.events", "observer/data.changes"],
    ["consumer/data.events", "consumer/data.changes"],
  );
  assert.deepEqual(await triggerMoves(), expected);
});

test("database renames update generated handlers while preserving authored changes", async () => {
  const { directory, configPath, handlers } = await projectWithDatabaseHandlers();
  const originals = await Promise.all(handlers.map((path) => readFile(path, "utf8")));
  const unrelated = join(directory, "src", "functions", "unrelated.ts");
  await writeFile(unrelated, 'export const endpoint = "PRIMARY_ENDPOINT";\n');

  await renameResource(configPath, "database", "primary", "auth-data");
  const config = (await loadConfig(configPath)).config;
  assert.ok(config.functions);
  for (const definition of Object.values(config.functions)) assert.equal(definition.database, "auth-data");
  for (const [index, path] of handlers.entries()) {
    assert.equal(await readFile(path, "utf8"), originals[index].replaceAll('"PRIMARY_ENDPOINT"', '"AUTH_DATA_ENDPOINT"'));
  }
  assert.equal(await readFile(unrelated, "utf8"), 'export const endpoint = "PRIMARY_ENDPOINT";\n');
  await stat(join(directory, "src", "databases", "auth-data", "migrations", "001_better_auth.sql"));
  assert.equal((await renameResource(configPath, "database", "primary", "auth-data")).action, "unchanged");
});

test("database rename rolls back source and configuration when a handler cannot be updated", async (context) => {
  const { directory, configPath, handlers } = await projectWithDatabaseHandlers();
  const movesPath = join(directory, "infra", "moves.auto.tf");
  const paths = [configPath, movesPath, ...handlers];
  const originals = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const rename = filesystem.rename;
  const writeFailure = context.mock.method(filesystem, "rename", async (from: Parameters<typeof filesystem.rename>[0], to: Parameters<typeof filesystem.rename>[1]) => {
    if (to === handlers[1]) throw new Error("simulated handler write failure");
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => renameResource(configPath, "database", "primary", "data"), /simulated handler write failure/);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), originals);
    await stat(join(directory, "src", "databases", "primary", "migrations", "001_better_auth.sql"));
    await assert.rejects(() => stat(join(directory, "src", "databases", "data")), { code: "ENOENT" });
  } finally {
    writeFailure.mock.restore();
    syncBuiltinESMExports();
  }
});

test("asset routes reject conflicting HEAD handlers in either declaration order", async () => {
  for (const pattern of ["/index.html", "/static/*", "/*"]) {
    for (const assetFirst of [true, false]) {
      const { configPath } = await freshProject();
      const config = (await loadConfig(configPath)).config;
      config.gateway.routes = [];
      await writeFile(configPath, JSON.stringify(config));
      const headPattern = pattern === "/*" ? "/" : pattern;
      const addAssets = () => addRoute(configPath, "GET", pattern, { assets: "website" });
      const addHead = () => addRoute(configPath, "HEAD", headPattern, { function: "api" });
      await (assetFirst ? addAssets() : addHead());
      const before = await readFile(configPath, "utf8");
      await assert.rejects(assetFirst ? addHead : addAssets, /duplicates the generated gateway operation/);
      assert.equal(await readFile(configPath, "utf8"), before);
      await addRoute(configPath, "HEAD", "/health", { function: "api" });
    }
  }
});

async function projectWithDatabaseHandlers() {
  const { directory, configPath } = await emptyProject("database-rename-app");
  await addResource(configPath, "database", "primary", { migrations: true });
  await addAuth(configPath, "primary");
  await addFunction(configPath, "agent", { template: "ai-agent", handler: "nested/agent.run" }, "/api/agent");
  await addFunction(configPath, "assistant", { template: "ai-turn" }, "/api/turn");
  const loaded = await loadConfig(configPath);
  const handlers = [];
  assert.ok(loaded.config.functions);
  for (const [name, definition] of Object.entries(loaded.config.functions)) {
    await createResourceScaffold(loaded, { kind: "function", name });
    const path = join(directory, "src", "functions", name, `${definition.handler.slice(0, definition.handler.lastIndexOf("."))}.ts`);
    await writeFile(path, `${await readFile(path, "utf8")}\n// Preserve authored customizations.\n`);
    handlers.push(path);
  }
  return { directory, configPath, handlers };
}
