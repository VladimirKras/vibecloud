import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { cliRoot, emptyProject } from "./helpers.ts";

test("Terraform template declares the current deployment resources", async () => {
  const terraform = await readFile(
    join(cliRoot, "templates", "project", "infra", "main.tf"),
    "utf8",
  );
  assert.match(terraform, /resource "yandex_function" "functions"/);
  assert.match(terraform, /for_each\s+= var\.functions/);
  assert.match(terraform, /dist\/functions\/\$\{each\.key\}/);
  assert.match(terraform, /project_id\s+= var\.folder_id/);
  assert.doesNotMatch(terraform, /resource "yandex_resourcemanager_folder" "project"/);
  assert.match(terraform, /cloud_suffix\s+= substr\(replace\(local\.project_id/);
  assert.match(terraform, /has_functions\s+= length\(var\.functions\) > 0/);
  assert.match(terraform, /resource "yandex_function_iam_binding" "invoker"/);
  assert.match(terraform, /resource "yandex_iam_service_account_iam_member" "deployer_use"/);
  assert.match(terraform, /role\s+= "iam\.serviceAccounts\.user"/);
  assert.match(terraform, /member\s+= var\.deployer_subject/);
  assert.match(terraform, /function_id\s+= yandex_function\.functions\[each\.key\]\.id/);
  assert.match(terraform, /role\s+= "functions\.functionInvoker"/);
  assert.doesNotMatch(terraform, /local\.has_functions \? \["functions\.functionInvoker"\] : \[\]/);
  assert.match(terraform, /local\.has_functions && local\.responses_enabled \? \["ai\.languageModels\.user", "ai\.assistants\.editor"\] : \[\]/);
  assert.match(terraform, /length\(var\.assets\) > 0 \? \["storage\.viewer"\] : \[\]/);
  assert.doesNotMatch(terraform, /\["functions\.functionInvoker", "ai\.languageModels\.user"\]/);
  assert.match(terraform, /yandex_function_iam_binding\.invoker/);
  assert.match(terraform, /ignore_changes = \[bucket\]/);
  assert.match(terraform, /required = true/);
  assert.doesNotMatch(terraform, /parameters\s+= endswith\(route\.pattern, "\*"\)[\s\S]*: null/);
  assert.match(terraform, /path => merge\(\[for route in local\.route_operations/);
  assert.match(terraform, /operationId = "route_\$\{index\}_head"/);
  assert.match(terraform, /operationId = "route_\$\{index\}_root_head"/);
  assert.match(terraform, /try\(regex\("\\\\\.\[\^\.\]\+\$", each\.value\.file\), ""\)/);
  assert.match(terraform, /dynamic "dlq"/);
});

test("Terraform asset integrations only emit configured fallback objects", async () => {
  const terraform = await readFile(
    join(cliRoot, "templates", "project", "infra", "main.tf"),
    "utf8",
  );
  assert.equal((terraform.match(/"error_object" => fallback if/g) ?? []).length, 4);
  assert.doesNotMatch(terraform, /error_object\s*=\s*try\(/);
});

test("generated Terraform is formatted", async () => {
  const { directory } = await emptyProject("format-app");
  const result = spawnSync("terraform", ["-chdir=infra", "fmt", "-check", "-diff"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
