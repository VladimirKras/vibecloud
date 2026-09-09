import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig, type VibecloudConfig } from "../packages/cli/src/config.ts";
import { compileDeploymentPlan } from "../packages/cli/src/deployment-plan.ts";

/** Each evaluated Terraform scenario consumes the same compiler as real pushes. */
export async function writeTerraformFixtureInputs(directory: string, base: VibecloudConfig) {
  const api = { handler: "index.handler" };
  const socket = { ...api, template: "websocket" as const };
  const clock = { ...api, template: "cron-trigger" as const, cron: { expression: "0 * * * ? *" } };
  const initial = { zulu: api, clock, socket };
  const added = { ...initial, alpha: { ...api, memory_mb: 512 }, tick: { ...clock, cron: { expression: "0 1 * * ? *" } }, second: socket };
  const initialRoutes = [{ pattern: "/zulu", function: "zulu" }, { pattern: "/ws", function: "socket", method: "WS" }];
  const addedRoutes = [...initialRoutes, { pattern: "/alpha", function: "alpha" }, { pattern: "/ws-two", function: "second", method: "WS" }];
  const cases: Record<string, Partial<VibecloudConfig>> = {
    selected_empty_configuration: {},
    immutable_publication: { assets: { website: { template: "vite", fallback: "index.html" } }, functions: { api }, gateway: { routes: [{ pattern: "/api", function: "api" }, { pattern: "/*", assets: "website" }] } },
    unrouted_assets: { assets: { website: { template: "vite" } } },
    exact_asset_route: { assets: { website: { template: "vite" } }, gateway: { routes: [{ pattern: "/index.html", assets: "website" }] } },
    renamed_asset: { assets: { renamed: { template: "vite" } }, gateway: { routes: [{ pattern: "/*", assets: "renamed" }] } },
    independent_database_resources: { databases: { primary: {}, analytics: {} } },
    function_invocation_permissions: { functions: { api }, gateway: { routes: [{ pattern: "/api/*", function: "api" }] } },
    image_generation_permissions: { buckets: { images: { public: true } }, functions: { image: { ...api, template: "ai-image", bucket: "images" } }, gateway: { routes: [{ pattern: "/api/images", function: "image" }] } },
    shared_runtime_routers: {
      functions: { first: api, second: { ...api, memory_mb: 512, timeout_seconds: 60 }, daily: { ...clock, cron: { expression: "0 1 * * ? *", payload: "original" } }, hourly: clock, socket, other: socket },
      gateway: { routes: [{ pattern: "/first", function: "first" }, { pattern: "/second", method: "POST", function: "second" }, { pattern: "/ws-one", method: "WS", function: "socket" }, { pattern: "/ws-two", method: "WS", function: "other" }] },
    },
    mixed_runtimes_and_stream_isolation: { functions: { node: api, python: { ...api, runtime: "python312" }, one: { ...api, template: "datastream-trigger" }, two: { ...api, template: "datastream-trigger" } }, gateway: { routes: [{ pattern: "/node", function: "node" }, { pattern: "/python", function: "python" }] } },
    membership_initial: { functions: initial, gateway: { routes: initialRoutes } },
    membership_added: { functions: added, gateway: { routes: addedRoutes } },
    membership_removed_originals: { functions: { alpha: added.alpha, tick: added.tick, second: added.second }, gateway: { routes: addedRoutes.filter((route) => ["alpha", "second"].includes(route.function)) } },
    membership_removed_last_timer_and_socket: { functions: { alpha: added.alpha }, gateway: { routes: [{ pattern: "/alpha", function: "alpha" }] } },
    membership_removed_all: {},
  };
  await mkdir(directory, { recursive: true });
  for (const [name, declaration] of Object.entries(cases)) {
    const config = validateConfig({ ...base, assets: {}, functions: {}, databases: {}, ai: {}, gateway: { routes: [] }, ...declaration });
    await writeFile(join(directory, `${name}.json`), JSON.stringify({ ...config, deployment_plan: compileDeploymentPlan(config) }, null, 2));
  }
}
