import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exercise the pinned provider's diff, which Terraform mock_provider does not reproduce. */
export function verifyTriggerTagPlans(infra: string): void {
  const directory = join(infra, "tests", "trigger-provider");
  mkdirSync(directory, { recursive: true });
  const template = readFileSync(join(infra, "main.tf"), "utf8");
  const requirements = template.match(/terraform \{[\s\S]*?\n\}/)?.[0];
  assert.ok(requirements);
  const resources = [...template.matchAll(/resource "yandex_function_trigger" "(?:triggers|crons)" \{[\s\S]*?\n\}/g)].map(([resource]) => resource
    .replace(/yandex_function\.functions\[local\.function_group_keys\[[^\]]+\]\]\.id/g, '"offline-function"')
    .replace(/yandex_ydb_topic\.streams\[each\.value\.stream\]\.name/g, '"events"')
    .replace(/yandex_ydb_database_serverless\.databases\[local\.streams\[each\.value\.stream\]\.database_key\]\.database_path/g, '"/offline-database"')
    .replace("var.deployment_plan.timer_payloads[each.key]", '"clock"')
    .replace(/^ {2}depends_on = .*$/gm, ""));
  assert.equal(resources.length, 2);
  writeFileSync(join(directory, "main.tf"), `${requirements}
provider "yandex" {
  token = "t1.offline.token"
}
variable "name" { default = "offline" }
variable "release_id" { type = string }
locals {
  project_id = "offline-folder"
  runtime_id = "offline-account"
  release_tag = var.release_id
  crons = { clock = { expression = "0 * * * ? *" } }
  triggers = { worker = {
    function_key = "worker"
    retry_attempts = 1
    retry_interval_seconds = 10
    batch_cutoff_seconds = 1
    batch_size_bytes = 1
    dead_letter_queue = null
  } }
}
${resources.join("\n")}
`);
  copyFileSync(join(infra, ".terraform.lock.hcl"), join(directory, ".terraform.lock.hcl"));
  if (!existsSync(join(directory, ".terraform"))) symlinkSync(join(infra, ".terraform"), join(directory, ".terraform"), "dir");
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(YC_|TF_VAR_|TF_CLI_ARGS)/.test(key))),
    TF_CLI_CONFIG_FILE: join(infra, "terraform.rc"),
  };
  const terraform = (args: string[]) => {
    const result = spawnSync("terraform", args, { cwd: directory, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const invocation = { id: "offline-function", tag: "r-one", service_account_id: "offline-account", retry_attempts: "1", retry_interval: "10" };
  const state = {
    version: 4, terraform_version: "1.6.3", serial: 1, lineage: "offline-trigger-tags", outputs: {},
    resources: [
      { name: "crons", key: "clock", attributes: { name: "offline-clock-cron", timer: [{ cron_expression: "0 * * * ? *", payload: "clock" }] } },
      { name: "triggers", key: "worker", attributes: { name: `offline-worker-${createHash("sha256").update("worker").digest("hex").slice(0, 8)}`, data_streams: [{ stream_name: "events", database: "/offline-database", service_account_id: "offline-account", batch_cutoff: "1", batch_size: "1" }] } },
    ].map(({ name, key, attributes }) => ({
      mode: "managed", type: "yandex_function_trigger", name,
      provider: 'provider["registry.terraform.io/yandex-cloud/yandex"]',
      instances: [{ index_key: key, schema_version: 0, attributes: { id: `offline-${name}`, folder_id: "offline-folder", function: [invocation], ...attributes } }],
    })),
  };
  // Use each planned state as the next synthetic deployed state. No cloud apply occurs.
  for (const release of ["r-two", "r-three"]) {
    writeFileSync(join(directory, "terraform.tfstate"), JSON.stringify(state));
    terraform(["plan", "-refresh=false", "-input=false", `-var=release_id=${release}`, "-out=tags.plan"]);
    const plan = JSON.parse(terraform(["show", "-json", "tags.plan"]));
    assert.equal(plan.resource_changes.length, 2);
    for (const change of plan.resource_changes) {
      assert.deepEqual(change.change.actions, ["update"], `${change.address} must update in place`);
      assert.equal(change.change.after.function[0].tag, release);
      assert.deepEqual({ ...change.change.after, function: change.change.before.function }, change.change.before, "Only the invocation tag should change");
      const resource = state.resources.find((resource) => resource.name === change.name)!;
      assert.equal(change.change.after.id, resource.instances[0].attributes.id);
      resource.instances[0].attributes = change.change.after;
    }
    state.serial++;
  }
  console.log("pinned provider updates timer and stream tags in place across consecutive releases");
}
