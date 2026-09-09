import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { reconcileTerraformMoves } from "../src/terraform-moves.ts";
import { emptyProject, fixtureTerraformState } from "./helpers.ts";

const bucket = (name: string) => `yandex_storage_bucket.assets[${JSON.stringify(name)}]`;
const object = (name: string) => `yandex_storage_object.assets[${JSON.stringify(name)}]`;
const move = (from: string, to: string) => `moved {\n  from = ${from}\n  to = ${to}\n}\n`;
const config = (name: string) => ({ name: "rename-app", gateway: {}, assets: { [name]: { template: "vite" as const } } });

test("reverse renames read the initialized backend and selected workspace rather than infra/terraform.tfstate", async () => {
  const { directory } = await emptyProject("backend-state-app");
  const infra = join(directory, "backend-infra");
  await mkdir(infra);
  await mkdir(join(directory, "backend"));
  await writeFile(join(infra, "terraform.rc"), "");
  await writeFile(join(infra, "backend.tf"), 'terraform {\n backend "local" {\n path = "../backend/state.json"\n workspace_dir = "../backend/workspaces"\n }\n}\n');
  terraform(infra, ["init", "-input=false"]);
  const state = (key: string) => JSON.stringify(fixtureTerraformState([{ type: "yandex_storage_bucket", name: "assets", keys: [key] }]));
  await writeFile(join(directory, "backend/state.json"), state("archive"));
  // A stale default-path file must not influence the selected backend.
  await writeFile(join(infra, "terraform.tfstate"), state("uploads"));
  const reconcile = () => reconcileTerraformMoves(infra, move(bucket("uploads"), bucket("archive")), [{ from: bucket("archive"), to: bucket("uploads") }], config("uploads"));
  assert.match(await reconcile(), /from = yandex_storage_bucket.assets\["archive"\][\s\S]*to\s+= yandex_storage_bucket.assets\["uploads"\]/);
  terraform(infra, ["workspace", "new", "review"]);
  await writeFile(join(directory, "backend/workspaces/review/terraform.tfstate"), state("archive"));
  await writeFile(join(directory, "backend/state.json"), state("uploads"));
  assert.match(await reconcile(), /from = yandex_storage_bucket.assets\["archive"\][\s\S]*to\s+= yandex_storage_bucket.assets\["uploads"\]/);
});

test("unreadable backend state never becomes an empty state", async () => {
  const calls: string[][] = [];
  await assert.rejects(reconcileTerraformMoves("/project/infra", "", [{ from: bucket("old"), to: bucket("new") }], config("new"), async (_command, args) => {
    calls.push(args);
    throw new Error("Backend access denied");
  }), /Cannot read the configured Terraform backend/);
  assert.deepEqual(calls, [["-chdir=/project/infra", "state", "pull"]]);
});

test("rename initializes missing backend dependencies and retries the state read", async () => {
  const calls: string[][] = [];
  await reconcileTerraformMoves("/project/infra", "", [{ from: bucket("old"), to: bucket("new") }], config("new"), async (command, args, environment) => {
    assert.equal(command, "terraform");
    assert.equal(environment.TF_CLI_CONFIG_FILE, "/project/infra/terraform.rc");
    calls.push(args);
    if (calls.length === 1) throw new Error("Required plugins are not installed");
    return "";
  });
  assert.deepEqual(calls.map((args) => args.slice(1)), [["state", "pull"], ["init", "-input=false", "-lockfile=readonly"], ["state", "pull"]]);
});

test("asset object moves compose, reverse and repair legacy bucket-only moves", async () => {
  const keys = ["website/index.html", 'website/assets/a"b.js'];
  const state = fixtureTerraformState([
    { type: "yandex_storage_bucket", name: "assets", keys: ["website"] },
    { type: "yandex_storage_object", name: "assets", keys },
  ]);
  const read = async () => JSON.stringify(state);
  const first = await reconcileTerraformMoves("/infra", "", [{ from: bucket("website"), to: bucket("web") }], config("web"), read);
  for (const key of keys) assert.ok(first.includes(`from = ${object(key)}`));
  const chained = await reconcileTerraformMoves("/infra", first, [{ from: bucket("web"), to: bucket("site") }], config("site"), read);
  assert.ok(chained.includes(`to   = ${object("site/index.html")}`));
  assert.ok(chained.includes(`to   = ${object('site/assets/a"b.js')}`));
  const reversed = await reconcileTerraformMoves("/infra", chained, [{ from: bucket("site"), to: bucket("website") }], config("website"), read);
  assert.ok(reversed.includes(`from = ${bucket("web")}`));
  assert.ok(reversed.includes(`from = ${bucket("site")}`));
  assert.ok(!reversed.includes(`from = ${bucket("website")}`));
  const repaired = await reconcileTerraformMoves("/infra", move(bucket("website"), bucket("web")), [], config("web"), read);
  assert.ok(repaired.includes(`from = ${object("website/index.html")}`));
  const partiallyApplied = await reconcileTerraformMoves("/infra", move(bucket("website"), bucket("web")), [], config("web"), async () => JSON.stringify(fixtureTerraformState([
    { type: "yandex_storage_bucket", name: "assets", keys: ["web"] },
    { type: "yandex_storage_object", name: "assets", keys },
  ])));
  assert.ok(partiallyApplied.includes(`from = ${object("website/index.html")}`));
  assert.ok(partiallyApplied.includes(`from = ${bucket("website")}`));
  const applied = await reconcileTerraformMoves("/infra", first, [], config("web"), async () => JSON.stringify(fixtureTerraformState([
    { type: "yandex_storage_bucket", name: "assets", keys: ["web"] },
    { type: "yandex_storage_object", name: "assets", keys: keys.map((key) => key.replace("website/", "web/")) },
  ])));
  assert.equal(applied, first);
});

test("asset rename plans retain bucket and object identities", async () => {
  const { directory } = await emptyProject("object-state-app");
  // Terraform's built-in resources exercise real state address moves offline.
  await writeFile(join(directory, "main.tf"), `
variable "asset" { type = string }
resource "terraform_data" "assets" {
  for_each = toset([var.asset])
  input = "bucket-\u0024{each.key}"
  lifecycle { ignore_changes = [input] }
}
resource "terraform_data" "objects" {
  for_each = { for file in ["index.html", "\u0024\u0024{file}.js", "%%{file}"] : "\u0024{var.asset}/\u0024{file}" => file }
  input = { bucket = terraform_data.assets[var.asset].output, key = each.value }
}
`);
  terraform(directory, ["apply", "-auto-approve", "-input=false", "-var=asset=website"]);
  const source = fixtureTerraformState([
    { type: "yandex_storage_bucket", name: "assets", keys: ["website"] },
    { type: "yandex_storage_object", name: "assets", keys: ["website/index.html", "website/${file}.js", "website/%{file}"] },
  ]);
  const moves = await reconcileTerraformMoves(directory, "", [{ from: bucket("website"), to: bucket("web") }], config("web"), async () => JSON.stringify(source));
  assert.equal(await reconcileTerraformMoves(directory, moves, [], config("web"), async () => JSON.stringify(source)), moves);
  await writeFile(join(directory, "moves.tf"), moves.replaceAll("yandex_storage_bucket.assets", "terraform_data.assets").replaceAll("yandex_storage_object.assets", "terraform_data.objects"));
  terraform(directory, ["plan", "-input=false", "-var=asset=web", "-out=rename.tfplan"]);
  const plan = JSON.parse(terraform(directory, ["show", "-json", "rename.tfplan"]));
  assert.deepEqual(plan.resource_changes.map((change: { change: { actions: string[] } }) => change.change.actions), [["no-op"], ["no-op"], ["no-op"], ["no-op"]]);
});

function terraform(directory: string, args: string[]): string {
  const result = spawnSync("terraform", [`-chdir=${directory}`, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test("refresh-only records unrelated renames before database targeting without activating code", async () => {
  const { directory } = await emptyProject("migration-moves-app");
  const source = (next: boolean) => `
resource "terraform_data" "buckets" {
  for_each = toset(["${next ? "new" : "old"}"])
  input = "physical-bucket"
}
resource "terraform_data" "databases" {
  for_each = toset(${next ? '["primary"]' : "[]"})
  input = "database"
}
resource "terraform_data" "functions" {
  input = "${next ? "new-code" : "old-code"}"
}
${next ? 'moved {\n from = terraform_data.buckets["old"]\n to = terraform_data.buckets["new"]\n}' : ""}
`;
  await writeFile(join(directory, "main.tf"), source(false));
  terraform(directory, ["apply", "-auto-approve", "-input=false"]);
  await writeFile(join(directory, "main.tf"), source(true));
  const blocked = spawnSync("terraform", [`-chdir=${directory}`, "plan", "-input=false", "-no-color", "-target=terraform_data.databases"], { encoding: "utf8" });
  assert.match(blocked.stderr, /Moved resource instances excluded by targeting/);
  terraform(directory, ["apply", "-refresh-only", "-auto-approve", "-input=false"]);
  terraform(directory, ["apply", "-target=terraform_data.databases", "-auto-approve", "-input=false"]);
  const state = JSON.parse(terraform(directory, ["state", "pull"]));
  assert.equal(state.resources.find((resource: { name: string }) => resource.name === "functions").instances[0].attributes.input.value, "old-code");
  assert.equal(state.resources.find((resource: { name: string }) => resource.name === "buckets").instances[0].index_key, "new");
  assert.equal(state.resources.find((resource: { name: string }) => resource.name === "databases").instances[0].index_key, "primary");
  terraform(directory, ["apply", "-auto-approve", "-input=false"]);
  const deployed = JSON.parse(terraform(directory, ["state", "pull"]));
  assert.equal(deployed.resources.find((resource: { name: string }) => resource.name === "functions").instances[0].attributes.input.value, "new-code");
});

test("applied rename chains remain safe in lagging workspaces, including a return to an old name", async () => {
  const { directory } = await emptyProject("workspace-history-app");
  await writeFile(join(directory, "main.tf"), `
variable "asset" { type = string }
resource "terraform_data" "assets" {
  for_each = toset([var.asset])
  input = "physical-bucket"
}
resource "terraform_data" "objects" {
  for_each = toset(["\u0024{var.asset}/index.html"])
  input = terraform_data.assets[var.asset].output
}
`);
  terraform(directory, ["apply", "-auto-approve", "-input=false", "-var=asset=website"]);
  terraform(directory, ["workspace", "new", "review"]);
  terraform(directory, ["apply", "-auto-approve", "-input=false", "-var=asset=website"]);
  const readState = async () => {
    const state = JSON.parse(terraform(directory, ["state", "pull"]));
    for (const resource of state.resources) {
      resource.type = resource.name === "assets" ? "yandex_storage_bucket" : "yandex_storage_object";
      resource.name = "assets";
    }
    return JSON.stringify(state);
  };
  let moves = "";
  const saveMoves = () => writeFile(join(directory, "moves.tf"), moves.replaceAll("yandex_storage_bucket.assets", "terraform_data.assets").replaceAll("yandex_storage_object.assets", "terraform_data.objects"));
  const noReplacement = (name: string) => {
    terraform(directory, ["plan", "-input=false", `-var=asset=${name}`, "-out=rename.tfplan"]);
    const plan = JSON.parse(terraform(directory, ["show", "-json", "rename.tfplan"]));
    assert.deepEqual(plan.resource_changes.map((change: { change: { actions: string[] } }) => change.change.actions), [["no-op"], ["no-op"]]);
  };
  for (const [from, to] of [["website", "web"], ["web", "site"]]) {
    moves = await reconcileTerraformMoves(directory, moves, [{ from: bucket(from), to: bucket(to) }], config(to), readState);
    await saveMoves();
    noReplacement(to);
    terraform(directory, ["apply", "-auto-approve", "-input=false", `-var=asset=${to}`]);
    moves = await reconcileTerraformMoves(directory, moves, [], config(to), readState);
    await saveMoves();
    terraform(directory, ["workspace", "select", "default"]);
    noReplacement(to);
    terraform(directory, ["workspace", "select", "review"]);
  }
  moves = await reconcileTerraformMoves(directory, moves, [{ from: bucket("site"), to: bucket("website") }], config("website"), readState);
  await saveMoves();
  noReplacement("website");
  terraform(directory, ["workspace", "select", "default"]);
  noReplacement("website");
  await assert.rejects(reconcileTerraformMoves(directory, moves, [], { ...config("website"), assets: { website: { template: "vite" }, web: { template: "vite" } } }, readState), /retained for other states/);
});
