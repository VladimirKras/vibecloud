import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { addResource, removeResource } from "../src/config-edit.ts";
import { loadConfig } from "../src/config.ts";
import { readCommandOutput } from "../src/commands.ts";
import { disposeLocalFunctions, invokeLocalFunction } from "../src/dev.ts";
import { localDatabases, localServicesCompose, requiresLocalAi } from "../src/local-services.ts";
import { inspectProjectOrphans, synchronizeProjectPackage } from "../src/scaffold.ts";
import { pushProject } from "../src/push.ts";
import { initProject } from "../src/init.ts";
import { activeFolder, cliPath, cliRoot, emptyProject, offlineInitOptions, readJson } from "./helpers.ts";

test("concurrent edits in different processes retain every resource", async () => {
  const { directory, configPath } = await emptyProject("concurrent-app");
  await Promise.all(Array.from({ length: 8 }, (_, index) => readCommandOutput(
    process.execPath, [cliPath, "add", "bucket", `bucket-${index}`], process.env, directory,
  )));
  assert.equal(Object.keys((await loadConfig(configPath)).config.buckets ?? {}).length, 8);
});

test("initialization serializes folder creation and keeps one project identity", async () => {
  const { directory } = await emptyProject("init-parent");
  const root = join(directory, "child-app");
  const options = offlineInitOptions();
  let created = 0;
  const readCommand: NonNullable<typeof options.readCommand> = async (...args) => {
    if (args[1].includes("create")) created += 1;
    return options.readCommand!(...args);
  };
  const results = await Promise.all([initProject(root, { ...options, readCommand }), initProject(root, { ...options, readCommand })]);
  assert.equal(created, 1);
  assert.equal(results[0].folderId, results[1].folderId);
});

test("the next mutation recovers an interrupted config and source rename", async () => {
  const { directory, configPath } = await emptyProject("recovery-app");
  const original = await readFile(configPath, "utf8");
  const updated = JSON.stringify({ ...JSON.parse(original), buckets: { interrupted: {} } });
  const from = join(directory, "src", "functions", "old");
  const to = join(directory, "src", "functions", "new");
  await mkdir(from, { recursive: true });
  await writeFile(join(from, "index.ts"), "authored source");
  await writeFile(join(directory, ".vibecloud", "pending-edit.json"), JSON.stringify({
    writes: [{ path: configPath, original, updated }], moves: [{ from, to }],
  }));
  await rename(from, to);
  await writeFile(configPath, updated);
  await addResource(configPath, "bucket", "complete");
  assert.deepEqual((await loadConfig(configPath)).config.buckets, { complete: {} });
  assert.equal(await readFile(join(from, "index.ts"), "utf8"), "authored source");
});

test("deployment builds and applies one complete snapshot of the selected config", async () => {
  const { directory, configPath } = await emptyProject("selected-app");
  const base = await readJson(configPath);
  await writeFile(configPath, JSON.stringify({ ...base, buckets: { unwanted: {} }, ai: { responses: true } }));
  const selected = join(directory, "infra", "custom.tfvars.json");
  await writeFile(selected, JSON.stringify({ ...base, functions: { worker: { handler: "index.handler", runtime: "python312" } } }));
  await mkdir(join(directory, "src", "functions", "worker"), { recursive: true });
  await writeFile(join(directory, "src", "functions", "worker", "index.py"), "def handler(event, context): return {}\n");
  let buildInput = "";
  let buildOutput = "";
  const result = await pushProject(await loadConfig(selected), {
    environment: { YC_TOKEN: "test", YC_CLOUD_ID: "test", YC_SUBJECT: "userAccount:test" },
    runBuildCommand: async (command, args, environment, cwd) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["build"]);
      buildInput = environment.VIBECLOUD_CONFIG_PATH!;
      buildOutput = environment.VIBECLOUD_BUILD_OUTPUT!;
      await readCommandOutput(process.execPath, ["build.ts"], { ...process.env, ...environment }, cwd);
    },
    runCommand: async (_command, args) => {
      if (!args.includes("plan")) return;
      assert.ok(args.includes(`-var-file=${buildInput}`));
      const inputs = await readJson(buildInput);
      assert.deepEqual(inputs.buckets, {});
      assert.deepEqual(inputs.ai, {});
      assert.equal(inputs.secrets, null);
    },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(await loadConfig(configPath)) : "",
  });
  assert.equal(result.built, true);
  assert.match(await readFile(join(buildOutput, "functions", "http-python312", "handlers", "h0", "index.py"), "utf8"), /def handler/);
});

test("local functions keep limiter state until the worker is replaced", async () => {
  const { directory, configPath } = await emptyProject("warm-app");
  const config = await readJson(configPath);
  await writeFile(configPath, JSON.stringify({ ...config, functions: { api: { handler: "index.handler" } }, gateway: { routes: [{ pattern: "/", function: "api" }] } }));
  const output = join(directory, "dist", "functions", "http-nodejs22");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "package.json"), '{"type":"commonjs"}');
  await build({
    stdin: { contents: `import { createAIRateLimiter } from ${JSON.stringify(join(cliRoot, "..", "ai", "src", "index.ts"))};
const limiter = createAIRateLimiter({ requestsPerMinute: 1 });
export const handler = () => { try { limiter.check("user"); return {statusCode:200,body:"ok"}; } catch { return {statusCode:429,body:"limited"}; } };`, resolveDir: directory, loader: "ts" },
    outfile: join(output, "router.js"), bundle: true, platform: "node", format: "cjs",
  });
  const loaded = await loadConfig(configPath);
  const request = { method: "GET", url: new URL("http://localhost/"), headers: {}, body: Buffer.alloc(0) };
  try {
    assert.equal((await invokeLocalFunction(loaded, request)).statusCode, 200);
    assert.equal((await invokeLocalFunction(loaded, request)).statusCode, 429);
    await disposeLocalFunctions(loaded);
    assert.equal((await invokeLocalFunction(loaded, request)).statusCode, 200);
  } finally { await disposeLocalFunctions(loaded); }
});

test("local services isolate database storage and require AI only when requested", async () => {
  const { configPath } = await emptyProject("services-app");
  const loaded = await loadConfig(configPath);
  assert.equal(requiresLocalAi(loaded, {}), false);
  assert.equal(requiresLocalAi(loaded, { VIBECLOUD_LOCAL_AI: "1" }), true);
  assert.deepEqual(Object.keys((await localServicesCompose(loaded)).services), ["app"]);
  loaded.config.databases = { primary: {}, analytics: {} };
  const databases = await localDatabases(loaded);
  assert.notEqual(databases.primary.endpoint, databases.analytics.endpoint);
  const compose = await localServicesCompose(loaded);
  assert.equal(Object.keys(compose.volumes).length, 4);
  assert.equal(Object.keys(compose.services.app.depends_on).length, 2);
});

test("orphan reporting identifies retained authored source and obsolete generated dependencies", async () => {
  const { directory, configPath } = await emptyProject("orphan-app");
  const config = await readJson(configPath);
  await writeFile(configPath, JSON.stringify({ ...config, functions: { api: { handler: "index.handler" } } }));
  await synchronizeProjectPackage(await loadConfig(configPath));
  await mkdir(join(directory, "src", "functions", "api"), { recursive: true });
  await writeFile(join(directory, "src", "functions", "api", "index.ts"), "authored source");
  await removeResource(configPath, "function", "api");
  const orphans = await inspectProjectOrphans(await loadConfig(configPath));
  assert.ok(orphans.includes("source: src/functions/api"));
  assert.ok(orphans.some((entry) => entry.startsWith("dependency: @vibecloud/function-api")));
  assert.equal(await readFile(join(directory, "src", "functions", "api", "index.ts"), "utf8"), "authored source");
});

test("enabling tracing after scaffolding instruments the build without rewriting the handler", async () => {
  const { directory, configPath } = await emptyProject("late-tracing-app");
  const config = await readJson(configPath);
  await writeFile(configPath, JSON.stringify({ ...config, functions: { api: { handler: "index.handler" } } }));
  const source = join(directory, "src", "functions", "api", "index.ts");
  await mkdir(join(directory, "src", "functions", "api"), { recursive: true });
  await writeFile(source, 'export const handler = () => ({ statusCode: 200, body: "authored" });');
  await mkdir(join(directory, "node_modules", "@vibecloud"), { recursive: true });
  await symlink(join(cliRoot, "..", "telemetry"), join(directory, "node_modules", "@vibecloud", "telemetry"));
  const authored = await readFile(source, "utf8");
  await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  const plain = await readFile(join(directory, "dist", "functions", "http-nodejs22", "router.js"), "utf8");
  assert.doesNotMatch(plain, /instrumentFunction/);
  await writeFile(configPath, JSON.stringify({ ...config, functions: { api: { handler: "index.handler" } }, observability: { traces: { enabled: true } } }));
  await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  assert.match(await readFile(join(directory, "dist", "functions", "http-nodejs22", "router.js"), "utf8"), /instrumentFunction/);
  assert.equal(await readFile(source, "utf8"), authored);
});
