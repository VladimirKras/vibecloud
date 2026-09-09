import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { activeFolder, emptyProject, readJson, runCli, prepareStateOnlyTerraform, fixtureTerraformState } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { addResource, renameResource } from "../src/config-edit.ts";
import { commitProjectEdit } from "../src/project-edit.ts";
import { withProjectLock, withProjectMutation } from "../src/project-lock.ts";
import { pushProject } from "../src/push.ts";
import { readCommandOutput } from "../src/commands.ts";
import { compileDeploymentPlan, functionProxyPatterns } from "../src/deployment-plan.ts";
import { buildProject } from "../src/build.ts";

test("failed scaffold creation rolls back its declaration, source and generated dependencies", async () => {
  const { directory, configPath } = await emptyProject("scaffold-rollback-app");
  const originals = await Promise.all([configPath, join(directory, "package.json"), join(directory, ".vibecloud/generated-dependencies.json")].map((path) => readFile(path, "utf8")));
  await mkdir(join(directory, "src/functions/broken/index.ts"), { recursive: true });
  const result = runCli(["add", "function", "broken", "--template", "api", "--route", "/broken"], directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scaffold path has the wrong type/);
  assert.deepEqual(await Promise.all([configPath, join(directory, "package.json"), join(directory, ".vibecloud/generated-dependencies.json")].map((path) => readFile(path, "utf8"))), originals);
  await assert.rejects(readFile(join(directory, ".vibecloud/pending-edit.json")), { code: "ENOENT" });
});

test("one journal rolls back files created and rewritten by later phases", async () => {
  const { directory, configPath } = await emptyProject("phase-rollback-app");
  const created = join(directory, "src/new/nested/file.ts");
  await assert.rejects(withProjectMutation(directory, async () => {
    await addResource(configPath, "bucket", "temporary");
    await commitProjectEdit(directory, { moves: [], writes: [{ path: created, original: null, updated: "phase one" }] });
    await commitProjectEdit(directory, { moves: [], writes: [{ path: created, original: "phase one", updated: "phase two" }] });
    throw new Error("late package failure");
  }), /late package failure/);
  assert.equal((await loadConfig(configPath)).config.buckets, undefined);
  await assert.rejects(readdir(join(directory, "src/new")), { code: "ENOENT" });
});

test("a package synchronization failure removes the newly scaffolded resource", async () => {
  const { directory, configPath } = await emptyProject("package-rollback-app");
  const packagePath = join(directory, "package.json");
  const originals = await Promise.all([configPath, packagePath].map((path) => readFile(path, "utf8")));
  const provenance = join(directory, ".vibecloud/generated-dependencies.json");
  await writeFile(provenance, "invalid dependency metadata");
  const result = runCli(["add", "function", "fresh", "--template", "api", "--route", "/fresh"], directory);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await Promise.all([configPath, packagePath].map((path) => readFile(path, "utf8"))), originals);
  await assert.rejects(readdir(join(directory, "src/functions/fresh")), { code: "ENOENT" });
  assert.equal(await readFile(provenance, "utf8"), "invalid dependency metadata");
  await assert.rejects(readFile(join(directory, ".vibecloud/pending-edit.json")), { code: "ENOENT" });
});

test("crash recovery accepts a journaled intermediate version and preserves authored conflicts", async () => {
  const { directory, configPath } = await emptyProject("intermediate-app");
  const original = await readFile(configPath, "utf8");
  const first = JSON.stringify({ ...JSON.parse(original), buckets: { first: {} } });
  const second = JSON.stringify({ ...JSON.parse(original), buckets: { second: {} } });
  const journal = join(directory, ".vibecloud/pending-edit.json");
  const writes = [{ path: configPath, original, updated: first }, { path: configPath, original: first, updated: second }];
  await writeFile(configPath, first);
  await writeFile(journal, JSON.stringify({ writes, moves: [] }));
  await withProjectLock(directory, async () => undefined);
  assert.equal(await readFile(configPath, "utf8"), original);
  await writeFile(journal, JSON.stringify({ writes, moves: [] }));
  await writeFile(configPath, "authored outside CLI");
  await assert.rejects(withProjectLock(directory, async () => undefined), /Cannot recover changed file/);
  assert.equal(await readFile(configPath, "utf8"), "authored outside CLI");
});

test("resource renames compose before apply and reverse after state has moved", async () => {
  const { directory, configPath } = await emptyProject("rename-history-app");
  await prepareStateOnlyTerraform(directory);
  await addResource(configPath, "bucket", "uploads");
  const movesPath = join(directory, "infra/moves.auto.tf");
  const plan = async (name: string) => {
    const moves = (await readFile(movesPath, "utf8")).replaceAll("yandex_storage_bucket.buckets", "terraform_data.buckets");
    await writeFile(join(directory, "main.tf"), `resource "terraform_data" "buckets" {\n for_each = toset(["${name}"])\n input = each.key\n}\n${moves}`);
    const result = spawnSync("terraform", [`-chdir=${directory}`, "plan", "-input=false", "-no-color", "-lock=false"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  await renameResource(configPath, "bucket", "uploads", "storage");
  await renameResource(configPath, "bucket", "storage", "uploads");
  assert.match(await readFile(movesPath, "utf8"), /from = yandex_storage_bucket.buckets\["storage"\]/);
  await plan("uploads");
  await renameResource(configPath, "bucket", "uploads", "storage");
  await renameResource(configPath, "bucket", "storage", "archive");
  assert.match(await readFile(movesPath, "utf8"), /from = yandex_storage_bucket.buckets\["uploads"\][\s\S]*to\s+= yandex_storage_bucket.buckets\["archive"\]/);
  await plan("archive");
  // Terraform's successful apply has moved the real resource to archive.
  await writeFile(join(directory, "infra/terraform.tfstate"), JSON.stringify(fixtureTerraformState([{ type: "yandex_storage_bucket", name: "buckets", keys: ["archive"] }])));
  await renameResource(configPath, "bucket", "archive", "uploads");
  assert.match(await readFile(movesPath, "utf8"), /from = yandex_storage_bucket.buckets\["archive"\]/);
  await plan("uploads");
});

test("push keeps its built artifacts while a development rebuild replaces dist", async () => {
  const { directory, configPath } = await emptyProject("artifact-snapshot-app");
  await writeFile(configPath, JSON.stringify({ ...await readJson(configPath), functions: { api: { handler: "index.handler" } }, gateway: { routes: [{ pattern: "/", function: "api" }] } }));
  const source = join(directory, "src/functions/api/index.ts");
  await mkdir(join(directory, "src/functions/api"), { recursive: true });
  await writeFile(source, 'export const handler = () => ({ statusCode: 200, body: "ORIGINAL_ARTIFACT" });');
  let artifact = "";
  await pushProject(await loadConfig(configPath), {
    environment: { YC_TOKEN: "test", YC_CLOUD_ID: "test", YC_SUBJECT: "userAccount:test" },
    runBuildCommand: async (_command, _args, environment, cwd) => {
      artifact = join(environment.VIBECLOUD_BUILD_OUTPUT!, "functions/http-nodejs22/router.js");
      await readCommandOutput(process.execPath, ["build.ts"], { ...process.env, ...environment }, cwd);
    },
    runCommand: async (_command, args) => {
      if (args.includes("init")) {
        await writeFile(source, 'export const handler = () => ({ statusCode: 200, body: "DEVELOPMENT_ARTIFACT" });');
        await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
      }
      if (args.includes("plan")) {
        assert.match(await readFile(artifact, "utf8"), /ORIGINAL_ARTIFACT/);
        assert.match(await readFile(join(directory, "dist/functions/http-nodejs22/router.js"), "utf8"), /DEVELOPMENT_ARTIFACT/);
        const selected = args.find((arg) => arg.startsWith("-var-file="))!.slice(10);
        assert.equal((await readJson(selected)).artifact_directory, join(artifact, "../../.."));
      }
    },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(await loadConfig(configPath)) : "",
  });
  await assert.rejects(readCommandOutput(process.execPath, ["build.ts"], { ...process.env, VIBECLOUD_BUILD_OUTPUT: directory }, directory), /must be dist or a CLI-owned/);
  assert.equal(await readFile(source, "utf8"), 'export const handler = () => ({ statusCode: 200, body: "DEVELOPMENT_ARTIFACT" });');
});

test("push rejects old project builders and mismatched manifests before Terraform", async () => {
  const { directory, configPath } = await emptyProject("build-contract-app");
  await writeFile(configPath, JSON.stringify({ ...await readJson(configPath), functions: { api: { handler: "index.handler" } } }));
  const loaded = await loadConfig(configPath);
  await assert.rejects(pushProject(loaded, {
    runBuildCommand: async () => undefined,
    runCommand: async () => assert.fail("Terraform must not run before a valid build"),
    readCommand: async () => assert.fail("Cloud credentials must not be requested before a valid build"),
  }), /did not produce isolated deployment artifacts/);
  const outputDirectory = join(directory, "dist-mismatched");
  await mkdir(outputDirectory);
  await writeFile(join(outputDirectory, "deployment-plan.json"), JSON.stringify(compileDeploymentPlan({ gateway: { routes: [] } })));
  await assert.rejects(buildProject(loaded, { outputDirectory, runCommand: async () => undefined }), /differs from the selected configuration/);
});

test("frontend proxy patterns accept query strings without matching neighboring paths", () => {
  const [exact, wildcard] = functionProxyPatterns([{ pattern: "/api/images", function: "images" }, { pattern: "/api/auth/*", function: "auth" }, { pattern: "/ws", function: "socket", method: "WS" }]);
  // Vite tests these expressions against req.url, rather than URL.pathname.
  for (const url of ["/api/images", "/api/images?operationId=123", "/api/images?"]) assert.match(url, new RegExp(exact));
  for (const url of ["/api/images/other", "/api/images-extra"]) assert.doesNotMatch(url, new RegExp(exact));
  assert.match("/api/auth/session?refresh=true", new RegExp(wildcard));
  assert.equal(functionProxyPatterns([{ pattern: "/ws", function: "socket", method: "WS" }]).length, 0);
});
