import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyProject, activeFolder, cliRoot } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { readLivePublication, retainedAssets, type PublicationState } from "../src/publication.ts";
import { pinLegacyInvokers } from "../src/legacy-publication.ts";
import { pushProject } from "../src/push.ts";
import { readCommandOutput } from "../src/commands.ts";

function fixture(active: string): PublicationState {
  const attributes = { id: "id", version: "v-one", key: "", content_type: "image/png", spec: "" };
  return { resources: [
    { mode: "managed", type: "yandex_function", name: "functions", instances: [{ index_key: "http-nodejs22", attributes: { ...attributes, id: "function-one" } }] },
    { mode: "managed", type: "yandex_api_gateway", name: "gateway", instances: [{ attributes: { ...attributes, spec: JSON.stringify({ openapi: "3.0.0", info: { version: active }, paths: { "/api": { get: { "x-yc-apigateway-integration": { type: "cloud_functions", function_id: "function-one" } } } } }) } }] },
    { mode: "managed", type: "yandex_storage_object", name: "assets", instances: ["r-100", "r-200", "r-300", "r-400"].map((release) => ({ index_key: `website/_vibecloud/releases/${release}/website/app.js`, attributes: { ...attributes, key: `_vibecloud/releases/${release}/website/app.js` } })) },
    { mode: "managed", type: "yandex_function_trigger", name: "crons", instances: [{ attributes: { ...attributes, function: [{ id: "function-one" }] } }] },
  ] };
}

test("retention uses the active gateway release, excluding a newer failed upload", async () => {
  const { configPath } = await emptyProject();
  const { config } = await loadConfig(configPath);
  config.assets = { website: { template: "vite" } };
  const state = fixture("r-300");
  state.resources!.push({ mode: "managed", type: "terraform_data", name: "release", instances: [{ attributes: { ...state.resources![0].instances![0].attributes, output: { value: { release_id: "r-300", previous: "r-100", protected: [] } } } }] });
  const kept = retainedAssets(state, config, true);
  assert.equal(Object.keys(kept).length, 2);
  assert.ok(Object.keys(kept).every((key) => /r-(100|300)/.test(key)));
  assert.ok(Object.values(kept).every((object) => object.source === null));
});

test("overlapping checkouts regenerate retention when another push wins during planning", async () => {
  const first = await emptyProject("concurrent-first-app");
  const second = await emptyProject("concurrent-second-app");
  for (const { configPath } of [first, second]) {
    const loaded = await loadConfig(configPath);
    loaded.config.assets = { website: { template: "vite" } };
    loaded.config.gateway.routes = [{ pattern: "/*", assets: "website" }];
    await writeFile(configPath, JSON.stringify(loaded.config));
  }
  const state = fixture("r-100");
  state.serial = 1;
  state.lineage = "shared-backend";
  state.resources = state.resources!.filter((resource) => ["yandex_api_gateway", "yandex_storage_object"].includes(resource.type));
  const gateway = state.resources[0].instances![0].attributes;
  gateway.spec = JSON.stringify({ openapi: "3.0.0", info: { version: "r-100" }, paths: {} });
  state.resources[1].instances = state.resources[1].instances!.slice(0, 1);
  const ready = Promise.withResolvers<void>();
  const activate = Promise.withResolvers<void>();
  const releases: string[] = [];
  let secondPlans = 0;
  function options(checkout: "first" | "second", loaded: Awaited<ReturnType<typeof loadConfig>>): NonNullable<Parameters<typeof pushProject>[1]> {
    const plans = new Map<string, { serial: number, selected: { release_id: string, retained_assets: Record<string, unknown> } }>();
    return {
      environment: { YC_TOKEN: "t1.offline.token", YC_CLOUD_ID: "cloud", YC_SUBJECT: "serviceAccount:deployer", TF_WORKSPACE: "shared" },
      runBuildCommand: async (_command, _args, environment) => {
        const selected = JSON.parse(await readFile(environment.VIBECLOUD_CONFIG_PATH!, "utf8"));
        await mkdir(environment.VIBECLOUD_BUILD_OUTPUT!, { recursive: true });
        await writeFile(join(environment.VIBECLOUD_BUILD_OUTPUT!, "deployment-plan.json"), JSON.stringify(selected.deployment_plan));
      },
      readCommand: async (_command, args, environment) => {
        assert.equal(environment.TF_WORKSPACE, "shared");
        if (args[0] === "resource-manager") return activeFolder(loaded);
        if (args.includes("pull")) return JSON.stringify(state);
        if (args.includes("get-spec")) return gateway.spec;
        if (args.includes("output")) return "https://example.test";
        throw new Error(`Unexpected read: ${args.join(" ")}`);
      },
      runCommand: async (command, args) => {
        assert.equal(command, "terraform");
        if (args.includes("plan")) {
          const selected = JSON.parse(await readFile(args.find((arg) => arg.startsWith("-var-file="))!.slice(10), "utf8"));
          if (checkout === "second" && ++secondPlans === 1) {
            assert.equal(Object.keys(selected.retained_assets).length, 1);
            activate.resolve();
            await firstPush;
          }
          plans.set(args.find((arg) => arg.startsWith("-out="))!.slice(5), { serial: state.serial!, selected });
          return;
        }
        if (!args.includes("apply") || args.includes("-refresh-only")) return;
        assert.ok(args.includes("-lock=true"));
        assert.ok(!args.some((arg) => arg.startsWith("-var-file=")), "apply must use the checked saved plan");
        if (checkout === "first") {
          ready.resolve();
          await activate.promise;
        }
        const plan = plans.get(args.at(-1)!)!;
        assert.equal(plan.serial, state.serial, "saved plan must still match the backend");
        const objects = state.resources![1].instances!;
        for (const object of objects) assert.ok(Object.hasOwn(plan.selected.retained_assets, object.index_key!), "the other checkout's active release must survive");
        const release = plan.selected.release_id;
        objects.push({ index_key: `website/_vibecloud/releases/${release}/website/app.js`, attributes: { ...objects[0].attributes, key: `_vibecloud/releases/${release}/website/app.js` } });
        gateway.spec = JSON.stringify({ openapi: "3.0.0", info: { version: release }, paths: {} });
        state.serial!++;
        releases.push(release);
      },
    };
  }
  const firstPush = pushProject(await loadConfig(first.configPath), options("first", await loadConfig(first.configPath)));
  try {
    await ready.promise;
    await pushProject(await loadConfig(second.configPath), options("second", await loadConfig(second.configPath)));
    assert.equal(secondPlans, 2);
    assert.equal(releases.length, 2);
    for (const release of releases) assert.ok(state.resources[1].instances!.some(({ attributes }) => attributes.key.includes(release)));
  } finally {
    activate.resolve();
    await firstPush;
  }
});

test("Terraform rejects a saved publication plan after another checkout changes shared state", async () => {
  const { directory } = await emptyProject("stale-plan-app");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TF_|YC_)/.test(key)));
  const roots = [join(directory, "first"), join(directory, "second")];
  const pins = join(directory, "pins.txt");
  const template = await readFile(join(cliRoot, "templates/project/infra/main.tf"), "utf8");
  const legacy = template.slice(template.indexOf('resource "terraform_data" "legacy_pin"'), template.indexOf('resource "terraform_data" "migrations"')).replaceAll("var.release_id", "var.release");
  const adapter = { interpreter: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(pins)}, 'pin\\n')`], legacy_manifest: "fixture" };

  for (const root of roots) {
    await mkdir(root);
    await writeFile(join(root, "main.tf"), `terraform {\n backend "local" {\n path = ${JSON.stringify(join(directory, "shared.tfstate"))}\n }\n}\nvariable "release" { type = string }\nresource "terraform_data" "publication" { input = var.release }\n`);
    await writeFile(join(root, "legacy.tf"), `variable "cloud_action" { default = ${JSON.stringify(adapter).replaceAll('":', '"=')} }\n${legacy}`);
    await readCommandOutput("terraform", ["init", "-input=false"], environment, root);
  }
  const run = (root: string, args: string[]) => readCommandOutput("terraform", args, environment, root);
  await run(roots[0], ["apply", "-input=false", "-auto-approve", "-var=release=r-one"]);
  await run(roots[1], ["plan", "-input=false", "-var=release=r-stale", "-out=publication.tfplan"]);
  await run(roots[0], ["apply", "-input=false", "-auto-approve", "-var=release=r-two"]);
  await assert.rejects(run(roots[1], ["apply", "-input=false", "-lock=true", "publication.tfplan"]), /Saved plan is stale/);
  const state = JSON.parse(await run(roots[1], ["state", "pull"]));
  assert.equal(state.resources.find((resource: { name: string }) => resource.name === "publication").instances[0].attributes.input.value, "r-two");
  assert.equal((await readFile(pins, "utf8")).trim().split("\n").length, 2, "stale plan must not execute the legacy pin hook");
});

test("a live gateway update survives stale provider state and protects the assets it serves", async () => {
  const state = fixture("r-100");
  const deployed = fixture("r-300").resources![1].instances![0].attributes.spec;
  const live = await readLivePublication(state, {}, async (_command, args) => {
    assert.deepEqual(args, ["serverless", "api-gateway", "get-spec", "--id", "id", "--format", "json"]);
    return JSON.stringify({ openapi_spec: deployed });
  });
  const kept = retainedAssets(live, { name: "fixture", folder_id: "folder", gateway: { routes: [] }, assets: { website: { template: "vite" } } });
  assert.equal(Object.keys(kept).length, 4, "unrecorded history is preserved rather than inferred from release timestamps");
  assert.equal(JSON.parse(state.resources![1].instances![0].attributes.spec).info.version, "r-100");
  await assert.rejects(readLivePublication(state, {}, async () => "{}"), /Cannot read live gateway/);
  await assert.rejects(readLivePublication(state, {}, async () => {
    throw new Error("gateway unavailable");
  }), /gateway unavailable/);
});

test("retrying a failed legacy push never switches the gateway to the failed function version", async () => {
  const { configPath } = await emptyProject("legacy-retry-app");
  const loaded = await loadConfig(configPath);
  loaded.config.functions = { api: { handler: "index.handler" } };
  loaded.config.gateway.routes = [{ pattern: "/api", function: "api" }];
  await writeFile(configPath, JSON.stringify(loaded.config));
  const state = fixture("1.0.0");
  state.resources = state.resources!.filter((resource) => resource.type !== "yandex_storage_object" && resource.type !== "yandex_function_trigger");
  const gateway = state.resources[1].instances![0].attributes;
  let liveSpec = JSON.parse(gateway.spec);
  const pins: string[] = [];
  const timeline: string[] = [];
  let fail = true;
  let selected: { cloud_action: { legacy_manifest: string | null } };
  const options: NonNullable<Parameters<typeof pushProject>[1]> = {
    environment: { YC_TOKEN: "t1.offline.token", YC_CLOUD_ID: "cloud", YC_SUBJECT: "serviceAccount:deployer" },
    runBuildCommand: async (_command, _args, environment) => {
      const selected = JSON.parse(await readFile(environment!.VIBECLOUD_CONFIG_PATH!, "utf8"));
      await mkdir(environment!.VIBECLOUD_BUILD_OUTPUT!, { recursive: true });
      await writeFile(join(environment!.VIBECLOUD_BUILD_OUTPUT!, "deployment-plan.json"), JSON.stringify(selected.deployment_plan));
    },
    readCommand: async (_command, args) => {
      if (args[0] === "resource-manager") return activeFolder(loaded);
      if (args.includes("pull")) return JSON.stringify(state);
      if (args.includes("get-spec")) {
        timeline.push("read-live");
        return JSON.stringify(liveSpec);
      }
      if (args.includes("output")) return "https://example.test";
      throw new Error(`Unexpected read: ${args.join(" ")}`);
    },
    runCommand: async (command, args) => {
      if (args.includes("plan")) selected = JSON.parse(await readFile(args.find((arg) => arg.startsWith("-var-file="))!.slice(10), "utf8"));
      if (command === "yc") {
        if (args.includes("set-tag")) pins.push(args.at(-1)!);
        else if (args.includes("--spec")) {
          liveSpec = JSON.parse(await readFile(args.at(-1)!, "utf8"));
          timeline.push("pin-live");
        } else throw new Error(`Unexpected write: ${args.join(" ")}`);
      } else if (args.includes("apply") && !args.includes("-refresh-only")) {
        if (selected.cloud_action.legacy_manifest) await pinLegacyInvokers(JSON.parse(await readFile(selected.cloud_action.legacy_manifest, "utf8")), loaded.rootDirectory, {}, options.runCommand!);
        timeline.push("apply");
        assert.equal(liveSpec.paths["/api"].get["x-yc-apigateway-integration"].tag, "vc-v-one");
        if (fail) {
          state.resources![0].instances![0].attributes.version = "failed-version";
          throw new Error("application apply failed after creating a function version");
        }
      }
    },
  };
  await assert.rejects(pushProject(loaded, options), /application apply failed/);
  fail = false;
  await pushProject(loaded, options);
  assert.deepEqual(pins, ["vc-v-one"]);
  assert.deepEqual(timeline, ["read-live", "pin-live", "apply", "read-live", "apply"]);
  assert.equal(JSON.parse(gateway.spec).paths["/api"].get["x-yc-apigateway-integration"].tag, undefined);
});

test("legacy HTTP and timer invokers pin the existing version before any new code", async () => {
  const { directory } = await emptyProject();
  const commands: string[][] = [];
  await pinLegacyInvokers(fixture("1.0.0"), directory, {}, async (_command, args) => {
    commands.push(args);
    if (args.includes("--spec")) {
      const spec = JSON.parse(await readFile(args.at(-1)!, "utf8"));
      assert.equal(spec.paths["/api"].get["x-yc-apigateway-integration"].tag, "vc-v-one");
    }
  });
  assert.deepEqual(commands[0], ["serverless", "function", "version", "set-tag", "--id", "v-one", "--tag", "vc-v-one"]);
  assert.equal(commands.filter((args) => args.includes("set-tag")).length, 1);
  assert.ok(commands[1].includes("api-gateway"));
  assert.deepEqual(commands[2], ["serverless", "trigger", "update", "timer", "--id", "id", "--new-invoke-function-tag", "vc-v-one"]);
});

test("missing deployed versions stop migration before updating an invoker", async () => {
  const { directory } = await emptyProject();
  const state = fixture("1.0.0");
  state.resources = state.resources!.filter((resource) => resource.type !== "yandex_function");
  const commands: string[][] = [];
  await assert.rejects(pinLegacyInvokers(state, directory, {}, async (_command, args) => {
    commands.push(args);
  }), /version is missing/);
  assert.deepEqual(commands, []);
});
