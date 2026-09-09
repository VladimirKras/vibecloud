import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withExclusive } from "../src/exclusive.ts";
import { watchAndRun } from "../src/dev.ts";
import { compileDeploymentPlan } from "../src/deployment-plan.ts";
import { loadConfig } from "../src/config.ts";
import { refreshFrameworkFiles } from "../src/framework-files.ts";
import { readCommandOutput } from "../src/commands.ts";
import { pushProject } from "../src/push.ts";
import { writeProjectMetadata } from "../src/project-metadata.ts";
import { cliRoot, emptyProject, readJson } from "./helpers.ts";

test("kernel-held local locks release on SIGKILL and serialize a second owner", { timeout: 10_000 }, async (t) => {
  const { directory } = await emptyProject("crashed-lock-app");
  for (const kind of ["project", "build"] as const) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { withExclusive } from ${JSON.stringify(new URL("../src/exclusive.ts", import.meta.url).href)}; await withExclusive(${JSON.stringify(directory)}, ${JSON.stringify(kind)}, async () => { setInterval(()=>{},1000); console.log('locked'); await new Promise(()=>{}); });`], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    await once(child.stdout!, "data");
    const cancelled = new AbortController();
    let entered = false;
    const contender = withExclusive(directory, kind, async () => {
      entered = true;
    }, cancelled.signal);
    const outcome = contender.catch((error: unknown) => error);
    await delay(75);
    assert.equal(entered, false);
    cancelled.abort();
    assert.ok(await outcome instanceof Error);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    await withExclusive(directory, kind, async () => {
      entered = true;
    });
    assert.equal(entered, true);
  }
});

test("closing a source watcher drains pending work and discards queued rebuilds", { timeout: 5_000 }, async () => {
  const { directory } = await emptyProject("drain-app");
  const source = join(directory, "src");
  await mkdir(source, { recursive: true });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const watcher = watchAndRun(source, "fixture", async () => {
    calls++;
    started.resolve();
    await finish.promise;
  })!;
  try {
    await writeFile(join(source, "source.txt"), "one");
    await started.promise;
    await writeFile(join(source, "source.txt"), "two");
    await delay(200);
    watcher.close();
    let drained = false;
    const drain = watcher.drain().then(() => {
      drained = true;
    });
    await delay(25);
    assert.equal(drained, false);
    finish.resolve();
    await drain;
    assert.equal(calls, 1);
  } finally {
    watcher.close();
    finish.resolve();
    await watcher.drain();
  }
});

test("template defaults become persistent capabilities, independent of later template labels", async () => {
  const { configPath } = await emptyProject("capability-app");
  const source = await readJson(configPath);
  source.buckets = { media: { public: true } };
  source.functions = { image: { template: "ai-image", handler: "index.handler", bucket: "media" }, tick: { handler: "index.handler", cron: { expression: "* * ? * * *" } } };
  await writeFile(configPath, JSON.stringify(source));
  const initial = await loadConfig(configPath);
  const before = compileDeploymentPlan(initial.config);
  await refreshFrameworkFiles(initial);
  const current = await readJson(configPath);
  assert.equal(current.functions.image.kind, "http");
  assert.deepEqual(current.functions.image.features, { ai: ["image_generation"], public_media: true });
  delete current.functions.image.template;
  await writeFile(configPath, JSON.stringify(current));
  const after = compileDeploymentPlan((await loadConfig(configPath)).config);
  assert.deepEqual(after.function_groups, before.function_groups);
  assert.deepEqual(after.ai, before.ai);
  assert.deepEqual(after.local.cloud_only, ["tick"]);
});

test("pending deletion blocks publishing before build or credential discovery", async () => {
  const { configPath } = await emptyProject("admission-app");
  const loaded = await loadConfig(configPath);
  await writeProjectMetadata(loaded.rootDirectory, { ...loaded.projectMetadata!, deletion: { requested_at: new Date().toISOString(), status: "pending", operation_id: "deletion" } });
  await assert.rejects(pushProject(loaded, {
    readCommand: async () => { assert.fail("no cloud reads"); },
    runCommand: async () => { assert.fail("no mutation"); },
    runBuildCommand: async () => { assert.fail("no build"); },
  }), /deletion is pending/);
});

test("native Terraform migration failure prevents publication and its release record", { timeout: 30_000 }, async () => {
  const { directory } = await emptyProject("native-migration-app");
  const infra = join(directory, "native");
  const artifacts = join(directory, "artifacts");
  const migrationDirectory = join(artifacts, "databases/primary/migrations");
  const db = join(directory, "node_modules/@vibecloud/db");
  await mkdir(infra);
  await mkdir(db, { recursive: true });
  await mkdir(migrationDirectory, { recursive: true });
  await writeFile(join(migrationDirectory, "001_initial.sql"), "valid");
  await writeFile(join(db, "package.json"), JSON.stringify({ type: "module", exports: { "./migrator": "./migrator.js" } }));
  await writeFile(join(db, "migrator.js"), "import { readFile } from 'node:fs/promises'; import { join } from 'node:path'; export async function migrateYdbFolder(connection, directory) { if (connection !== 'grpc://fixture/local') throw Error('wrong connection'); if ((await readFile(join(directory,'001_initial.sql'),'utf8')) === 'fail') throw Error('MIGRATION_FAILED'); }");
  const source = await readFile(join(cliRoot, "templates/project/infra/main.tf"), "utf8");
  // Execute the actual migration and completion resources with a builtin database
  // stand-in. This needs neither a cloud provider nor cloud credentials.
  const migration = source.slice(source.indexOf('resource "terraform_data" "migrations"'), source.indexOf('resource "terraform_data" "release"'))
    .replaceAll("yandex_ydb_database_serverless.databases", "terraform_data.databases").replaceAll(".ydb_full_endpoint", ".output");
  const release = source.slice(source.indexOf('resource "terraform_data" "release"'))
    .replace("yandex_api_gateway.gateway, yandex_function_trigger.crons, yandex_function_trigger.triggers", "terraform_data.gateway");
  await writeFile(join(infra, "main.tf"), `variable "publication_record" { type = any }\nvariable "cloud_action" { type = any }\nvariable "databases" { type = any }\nlocals { artifacts = ${JSON.stringify(artifacts)} }\nresource "terraform_data" "databases" {\n for_each = var.databases\n input = "grpc://fixture/local"\n}\n${migration}\nresource "terraform_data" "gateway" {\n input = var.publication_record.release_id\n depends_on = [terraform_data.migrations]\n}\n${release}`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TF_|YC_)/.test(key)));
  const run = (args: string[]) => readCommandOutput("terraform", args, environment, infra);
  const select = async (id: string) => writeFile(join(infra, "inputs.json"), JSON.stringify({ databases: { primary: { migrations: true } }, cloud_action: { interpreter: [process.execPath, join(cliRoot, "dist/cloud-action.js")], project: directory }, publication_record: { release_id: id, previous: null, protected: [] } }));
  await run(["init", "-input=false"]);
  await select("first");
  await run(["apply", "-input=false", "-auto-approve", "-var-file=inputs.json"]);
  await select("second");
  await writeFile(join(migrationDirectory, "001_initial.sql"), "fail");
  await assert.rejects(run(["apply", "-input=false", "-auto-approve", "-var-file=inputs.json"]), /MIGRATION_FAILED/);
  let state = JSON.parse(await run(["state", "pull"]));
  const value = (name: string) => state.resources.find((resource: { name: string }) => resource.name === name).instances[0].attributes.output.value;
  assert.equal(value("gateway"), "first");
  assert.equal(value("release").release_id, "first");
  await writeFile(join(migrationDirectory, "001_initial.sql"), "valid again");
  await run(["apply", "-input=false", "-auto-approve", "-var-file=inputs.json"]);
  state = JSON.parse(await run(["state", "pull"]));
  assert.equal(value("gateway"), "second");
  assert.equal(value("release").release_id, "second");
});
