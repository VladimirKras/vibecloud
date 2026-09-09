import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { addFunction, addResource, renameResource } from "../src/config-edit.ts";
import { loadConfig } from "../src/config.ts";
import { readCommandOutput } from "../src/commands.ts";
import { disposeLocalFunctions, invokeLocalFunction } from "../src/dev.ts";
import { managedFrameworkFile, refreshFrameworkFiles } from "../src/framework-files.ts";
import { createResourceScaffold } from "../src/scaffold.ts";
import { pushProject } from "../src/push.ts";
import { emptyProject, readJson, activeFolder } from "./helpers.ts";

test("scaffolding preserves authored build, typecheck, and dev scripts", async () => {
  const { directory, configPath } = await emptyProject("custom-scripts-app");
  const path = join(directory, "package.json");
  const manifest = await readJson(path);
  const scripts = { ...manifest.scripts, build: "node prebuild.mjs && node build.ts", typecheck: "tsc --noEmit -p tsconfig.application.json", dev: "node local-wrapper.mjs" };
  await writeFile(path, JSON.stringify({ ...manifest, scripts }));
  await addFunction(configPath, "api", { template: "api" });
  await createResourceScaffold(await loadConfig(configPath), { kind: "function", name: "api" });
  assert.deepEqual((await readJson(path)).scripts, scripts);
});

test("local edits and rename history work with an unavailable Terraform backend", async () => {
  const { directory, configPath } = await emptyProject("offline-edit-app");
  await writeFile(join(directory, "infra/backend.tf"), 'terraform { backend "not-a-real-backend" {} }');
  await addResource(configPath, "asset", "website", { template: "vite" });
  await renameResource(configPath, "asset", "website", "web");
  const moves = await readFile(join(directory, "infra/moves.auto.tf"), "utf8");
  await addResource(configPath, "bucket", "images");
  assert.deepEqual((await loadConfig(configPath)).config.buckets?.images, {});
  assert.equal(await readFile(join(directory, "infra/moves.auto.tf"), "utf8"), moves);
  await assert.rejects(addResource(configPath, "asset", "website", { template: "vite" }), /retained for other states/);
});

test("build output cannot replace source, infrastructure, or symlink aliases", async () => {
  const { directory } = await emptyProject("guard-build-app");
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/authored.txt"), "keep me");
  const config = await readFile(join(directory, "infra/vibecloud.auto.tfvars.json"), "utf8");
  const build = (output: string) => readCommandOutput(process.execPath, ["build.ts"], { ...process.env, VIBECLOUD_BUILD_OUTPUT: output }, directory);
  for (const output of ["src", "infra", ".", "dist/../src", "../outside"]) await assert.rejects(build(output), /must be dist or a CLI-owned/);
  await symlink("src", join(directory, "dist"));
  await assert.rejects(build("dist"), /outside CLI-owned/);
  await symlink("../src", join(directory, "infra/.packages"));
  await assert.rejects(build("infra/.packages/deployment-example/dist"), /parent must not be a symlink/);
  assert.equal(await readFile(join(directory, "src/authored.txt"), "utf8"), "keep me");
  assert.equal(await readFile(join(directory, "infra/vibecloud.auto.tfvars.json"), "utf8"), config);
});

test("a failed rebuild preserves both warm and never-started runtime groups", async (t) => {
  const { directory, configPath } = await emptyProject("last-good-build-app");
  const config = await readJson(configPath);
  config.functions = { warm: { handler: "index.handler", runtime: "nodejs22" }, cold: { handler: "index.handler", runtime: "nodejs20" } };
  config.gateway.routes = [{ pattern: "/warm", function: "warm" }, { pattern: "/cold", function: "cold" }];
  await writeFile(configPath, JSON.stringify(config));
  for (const name of ["warm", "cold"]) {
    await mkdir(join(directory, "src/functions", name), { recursive: true });
    await writeFile(join(directory, "src/functions", name, "index.ts"), `export const handler = () => ({statusCode:200,body:${JSON.stringify(name)}});`);
  }
  const loaded = await loadConfig(configPath);
  t.after(() => disposeLocalFunctions(loaded));
  const invoke = (path: string) => invokeLocalFunction(loaded, { method: "GET", url: new URL(path, "http://localhost"), headers: {}, body: Buffer.alloc(0) });
  const build = () => readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  await build();
  const previous = await realpath(join(directory, "dist"));
  assert.equal((await invoke("/warm"))?.body, "warm");
  await writeFile(join(directory, "src/functions/warm/index.ts"), "export const handler = ;");
  await assert.rejects(build(), /Unexpected/);
  assert.equal(await realpath(join(directory, "dist")), previous);
  assert.equal((await invoke("/warm"))?.body, "warm");
  assert.equal((await invoke("/cold"))?.body, "cold");
  assert.deepEqual(await readdir(join(directory, ".vibecloud/builds")), [previous.split("/").at(-1)]);
});

test("managed framework files upgrade together and reject overwriting authored changes", async () => {
  const { directory, configPath } = await emptyProject("framework-update-app");
  const loaded = await loadConfig(configPath);
  const path = join(directory, "infra/main.tf");
  const expected = await readFile(path, "utf8");
  await writeFile(path, managedFrameworkFile("# old framework release\n"));
  await refreshFrameworkFiles(loaded);
  assert.equal(await readFile(path, "utf8"), expected);
  const custom = expected + "# authored change\n";
  await writeFile(path, custom);
  await assert.rejects(refreshFrameworkFiles(loaded), /edits to managed framework/);
  assert.equal(await readFile(path, "utf8"), custom);
  await writeFile(path, "# explicitly app-owned Terraform\n");
  await refreshFrameworkFiles(loaded);
  assert.equal(await readFile(path, "utf8"), "# explicitly app-owned Terraform\n");
});

test("deterministic Terraform errors fail immediately without repeated applies", async () => {
  const loaded = await loadConfig((await emptyProject("apply-failure-app")).configPath);
  let applies = 0;
  await assert.rejects(pushProject(loaded, {
    environment: { YC_TOKEN: "test", YC_CLOUD_ID: "test", YC_SUBJECT: "userAccount:test" },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(loaded) : "",
    runCommand: async (_command, args) => {
      if (args.includes("apply")) {
        applies++;
        throw new Error("Invalid resource configuration");
      }
    },
  }), /Invalid resource configuration/);
  assert.equal(applies, 1);
});

test("push records pending renames before migration staging and stops on migration failure", async () => {
  const { directory, configPath } = await emptyProject("rename-migration-app");
  await writeFile(configPath, JSON.stringify({ ...await readJson(configPath), buckets: { renamed: {} }, databases: { primary: { migrations: true } } }));
  await mkdir(join(directory, "src/databases/primary/migrations"), { recursive: true });
  await writeFile(join(directory, "infra/moves.auto.tf"), 'moved {\n from = yandex_storage_bucket.buckets["original"]\n to = yandex_storage_bucket.buckets["renamed"]\n}\n');
  const timeline: string[] = [];
  await assert.rejects(pushProject(await loadConfig(configPath), {
    environment: { YC_TOKEN: "test", YC_CLOUD_ID: "test", YC_SUBJECT: "userAccount:test" },
    runBuildCommand: async (_command, _args, environment, cwd) => { await readCommandOutput(process.execPath, ["build.ts"], { ...process.env, ...environment }, cwd); },
    runCommand: async (_command, args) => {
      timeline.push(args.includes("-refresh-only") ? "record-renames" : args[1]);
      if (args.includes("apply") && !args.includes("-refresh-only")) throw new Error("migration failed");
    },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(await loadConfig(configPath)) : "",
  }), /migration failed/);
  assert.deepEqual(timeline, ["init", "record-renames", "plan", "apply"]);
});
