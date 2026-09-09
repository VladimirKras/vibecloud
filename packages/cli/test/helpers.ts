import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { initProject } from "../src/init.ts";
import { createResourceScaffold } from "../src/scaffold.ts";

export const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const packagesRoot = dirname(cliRoot);
export const cliPath = join(cliRoot, "dist", "vibecloud.js");
export const defaultConfigPath = join("infra", "vibecloud.auto.tfvars.json");

export async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** State-only fixtures don't install providers; packaged acceptance checks the lock. */
export async function prepareStateOnlyTerraform(directory: string) {
  await unlink(join(directory, "infra", ".terraform.lock.hcl"));
}

export function fixtureTerraformState(resources: Array<{ type: string, name: string, keys: string[] }>) {
  return {
    version: 4, terraform_version: "1.6.3", serial: 1,
    lineage: "35a801a7-6f28-4a38-9639-676b391ed49f", outputs: {},
    resources: resources.map(({ type, name, keys }) => ({
      mode: "managed", type, name,
      provider: 'provider["registry.terraform.io/yandex-cloud/yandex"]',
      instances: keys.map((key) => ({ index_key: key, schema_version: 0, attributes: { id: key }, sensitive_attributes: [] })),
    })),
  };
}

export function fixtureDeletionOperation(folderId: string, id = "delete-operation") {
  return {
    id, created_at: new Date().toISOString(),
    metadata: {
      "@type": "type.googleapis.com/yandex.cloud.resourcemanager.v1.DeleteFolderMetadata",
      "folder_id": folderId,
      "delete_after": new Date().toISOString(),
    },
  };
}

export async function cliPackage() {
  return readJson(join(cliRoot, "package.json"));
}

export async function emptyProject(name = "empty-app", adoptedFolderId?: string) {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, name);
  const { configPath } = await initProject(directory, {
    ...offlineInitOptions(`${name}-folder-id`),
    ...(adoptedFolderId ? { folderId: adoptedFolderId } : {}),
  });
  await mkdir(join(directory, "node_modules", "@vibecloud"), { recursive: true });
  await symlink(cliRoot, join(directory, "node_modules", "@vibecloud", "cli"));
  await symlink(join(cliRoot, "node_modules", "esbuild"), join(directory, "node_modules", "esbuild"));
  return { directory, configPath };
}

export function offlineInitOptions(folderId = "test-folder-id"): NonNullable<Parameters<typeof initProject>[1]> {
  return {
    install: false,
    environment: {
      YC_TOKEN: "test-token",
      YC_CLOUD_ID: "test-cloud-id",
      YC_FOLDER_ID: "test-profile-folder-id",
    },
    readCommand: async (command, arguments_) => {
      if (command === "yc" && arguments_.includes("list")) return "[]";
      if (command === "yc" && arguments_.includes("create")) {
        return `${JSON.stringify({ id: folderId, status: "ACTIVE" })}\n`;
      }
      if (command === "yc" && arguments_.includes("get")) {
        const requestedFolderId = arguments_[arguments_.indexOf("--id") + 1];
        return `${JSON.stringify({ id: requestedFolderId, status: "ACTIVE" })}\n`;
      }
      throw new Error(`unexpected initialization command: ${command} ${arguments_.join(" ")}`);
    },
  };
}

export async function freshProject(name = "fresh-app") {
  const { directory, configPath } = await emptyProject(name);
  const initialized = await readJson(configPath);
  await writeFile(configPath, `${JSON.stringify({
    ...initialized,
    name,
    gateway: { routes: [
      { pattern: "/api/*", function: "api" },
      { pattern: "/*", assets: "website" },
    ] },
    assets: { website: { template: "vite", build: { command: "pnpm build" }, fallback: "index.html" } },
    functions: { api: { template: "api", handler: "index.handler" } },
    databases: { primary: { migrations: true, streams: { events: {} } } },
    buckets: { uploads: {} },
    secrets: { entries: { BETTER_AUTH_SECRET: {} } },
  }, null, 2)}\n`);

  for (const scope of [
    { kind: "asset", name: "website" },
    { kind: "function", name: "api" },
    { kind: "database", name: "primary" },
  ] as const) {
    await createResourceScaffold(await loadConfig(configPath), scope);
  }
  return { directory, configPath };
}

export function runCli(arguments_: string[], cwd = cliRoot) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

export function activeFolder(loaded: Awaited<ReturnType<typeof loadConfig>>) {
  return JSON.stringify({ id: loaded.projectMetadata!.yc_folder_id, status: "ACTIVE", labels: { vibecloud_project_id: loaded.projectMetadata!.project_id } });
}
