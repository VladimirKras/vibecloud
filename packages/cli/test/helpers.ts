import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
