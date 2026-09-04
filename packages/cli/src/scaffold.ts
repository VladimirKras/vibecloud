import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { functionRuntimeFamily, type LoadedConfig } from "./config.ts";

interface ScaffoldEntry {
  kind: "directory" | "file"
  path: string
  content?: string
  mode?: number
}

export interface ScaffoldResult {
  created: string[]
  existing: string[]
  updated: string[]
}

type ScaffoldScope = { kind: "project" } | { kind: "asset" | "database" | "function", name: string };

export async function initializeProjectScaffold(loaded: LoadedConfig): Promise<ScaffoldResult> {
  const result = await createScaffold(loaded, await scaffoldEntries(loaded, { kind: "project" }));
  if (await ensureProjectGitignore(loaded.rootDirectory)) result.updated.push(".gitignore");
  return result;
}

export async function createResourceScaffold(
  loaded: LoadedConfig,
  scope: Exclude<ScaffoldScope, { kind: "project" }>,
): Promise<ScaffoldResult> {
  const result = await createScaffold(loaded, await scaffoldEntries(loaded, scope));
  if (scope.kind === "function" && loaded.config.functions?.[scope.name]?.template === "better-auth") {
    result.updated.push(...await updateGeneratedAssetAppsForAuth(loaded));
  }
  if (await updateProjectPackage(loaded)) result.updated.push("package.json");
  return result;
}

export async function synchronizeProjectPackage(loaded: LoadedConfig) {
  return updateProjectPackage(loaded);
}

async function createScaffold(
  loaded: LoadedConfig,
  entries: ScaffoldEntry[],
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const updated: string[] = [];

  for (const entry of entries) {
    const displayPath = relative(loaded.rootDirectory, entry.path);
    const current = await entryKind(entry.path);
    if (current) {
      if (current !== entry.kind) {
        throw new Error(`scaffold path has the wrong type: ${entry.path}`);
      }
      existing.push(displayPath);
      continue;
    }
    if (entry.kind === "directory") {
      await mkdir(entry.path, { recursive: true });
    } else {
      await mkdir(dirname(entry.path), { recursive: true });
      try {
        await writeFile(entry.path, entry.content ?? "", { flag: "wx", mode: entry.mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    created.push(displayPath);
  }

  return { created, existing, updated };
}

async function scaffoldEntries(loaded: LoadedConfig, scope: ScaffoldScope): Promise<ScaffoldEntry[]> {
  const entries: ScaffoldEntry[] = [];
  const sourceRoot = join(loaded.rootDirectory, "src");
  const viteAssets = Object.entries(loaded.config.assets ?? {})
    .filter(([, assets]) => assets.template === "vite")
    .map(([name]) => name);
  const betterAuthFunctions = Object.entries(loaded.config.functions ?? {})
    .filter(([, definition]) => definition.template === "better-auth");
  const hasBetterAuth = betterAuthFunctions.length > 0;

  if (scope.kind === "project") {
    entries.push(...await bundledSkillEntries(loaded.rootDirectory));
    entries.push({
      kind: "file",
      path: join(loaded.rootDirectory, "AGENTS.md"),
      content: await template("AGENTS.md"),
    });
    entries.push({
      kind: "file",
      path: join(loaded.rootDirectory, ".gitignore"),
      content: await template("gitignore"),
    });
    entries.push(
      ...["main.tf", "monitoring.tf", "variables.tf", "outputs.tf", "moves.auto.tf", "terraform.rc", ".terraform.lock.hcl"].map((name): ScaffoldEntry => ({
        kind: "file",
        path: join(loaded.infraDirectory, name),
        content: "",
      })),
      {
        kind: "file",
        path: join(loaded.rootDirectory, "package.json"),
        content: await projectPackage(loaded),
      },
      {
        kind: "file",
        path: join(loaded.rootDirectory, "pnpm-workspace.yaml"),
        content: await template("pnpm-workspace.yaml"),
      },
      {
        kind: "file",
        path: join(loaded.rootDirectory, "build.ts"),
        content: await template("build.ts"),
      },
      {
        kind: "file",
        path: join(loaded.rootDirectory, "vite.config.ts"),
        content: await template("vite.config.ts"),
      },
      {
        kind: "file",
        path: join(loaded.infraDirectory, "local.compose.yaml"),
        content: await template("infra/local.compose.yaml"),
      },
      {
        kind: "file",
        path: join(loaded.infraDirectory, "local.orbstack.compose.yaml"),
        content: await template("infra/local.orbstack.compose.yaml"),
      },
      {
        kind: "file",
        path: join(loaded.infraDirectory, "local.Dockerfile"),
        content: await template("infra/local.Dockerfile"),
      },
      {
        kind: "file",
        path: join(loaded.rootDirectory, "eslint.config.ts"),
        content: await template("eslint.config.ts"),
      },
      {
        kind: "file",
        path: join(loaded.rootDirectory, "tsconfig.json"),
        content: render(await template("tsconfig.json"), {
          TYPES: JSON.stringify(viteAssets.length ? ["node", "vite/client"] : ["node"]),
        }),
      },
    );
    for (const entry of entries) {
      if (entry.kind === "file" && dirname(entry.path) === loaded.infraDirectory && entry.content === "") {
        entry.content = await template(`infra/${basename(entry.path)}`);
      }
    }
  }

  for (const name of viteAssets) {
    if (scope.kind !== "project" && (scope.kind !== "asset" || scope.name !== name)) continue;
    entries.push(
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "index.html"),
        content: render(await template("assets/index.html"), {
          PROJECT_NAME: loaded.config.name,
        }),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "vite-env.d.ts"),
        content: await template("assets/vite-env.d.ts"),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "main.tsx"),
        content: await template("assets/main.tsx"),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "App.tsx"),
        content: render(await template(hasBetterAuth ? "assets/App-auth.tsx" : "assets/App.tsx"), {
          PROJECT_NAME: loaded.config.name,
        }),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "App.module.css"),
        content: await template("assets/App.module.css"),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "hooks", "useTheme.ts"),
        content: await template("assets/hooks/useTheme.ts"),
      },
      {
        kind: "file",
        path: join(sourceRoot, "assets", name, "themes", "common.css"),
        content: await template("assets/themes/common.css"),
      },
    );
    if (hasBetterAuth) entries.push(...await authAssetEntries(sourceRoot, name));
  }

  for (const [name, definition] of Object.entries(loaded.config.functions ?? {})) {
    if (scope.kind !== "project" && (scope.kind !== "function" || scope.name !== name)) continue;
    const handler = parseHandler(definition.handler);
    const runtime = definition.runtime ?? "nodejs22";
    const family = functionRuntimeFamily(runtime);
    const telemetryEnabled = family === "nodejs" && (
      loaded.config.observability?.logs?.enabled === true
      || loaded.config.observability?.metrics?.enabled === true
      || loaded.config.observability?.traces?.enabled === true
    );
    const datastreamTrigger = definition.template === "datastream-trigger"
      || (definition.template === undefined && Boolean(definition.triggers?.length));
    const cronTrigger = definition.template === "cron-trigger";
    const websocket = definition.template === "websocket";
    const betterAuth = definition.template === "better-auth";
    const aiAgent = definition.template === "ai-agent";
    const aiImage = definition.template === "ai-image";
    const aiTurn = definition.template === "ai-turn";
    if (family === "nodejs") {
      const functionTemplate = aiTurn
        ? "function-ai-turn.ts"
        : aiImage
          ? "function-ai-image.ts"
          : aiAgent
            ? "function-ai-agent.ts"
            : betterAuth
              ? "function-better-auth.ts"
              : websocket
                ? telemetryEnabled ? "function-websocket-traced.ts" : "function-websocket.ts"
                : cronTrigger
                  ? telemetryEnabled ? "function-cron-trigger-traced.ts" : "function-cron-trigger.ts"
                  : datastreamTrigger
                    ? telemetryEnabled ? "function-stream-trigger-traced.ts" : "function-stream-trigger.ts"
                    : telemetryEnabled ? "function-http-traced.ts" : "function-http.ts";
      entries.push({
        kind: "file",
        path: join(sourceRoot, "functions", name, `${handler.module}.ts`),
        content: render(await template(functionTemplate), {
          HANDLER: handler.exportName,
          PROJECT_NAME_JSON: JSON.stringify(loaded.config.name),
          DATABASE_ENV: environmentBinding(definition.database ?? "primary"),
        }),
      });
    } else if (family === "python") {
      entries.push(
        {
          kind: "file",
          path: join(sourceRoot, "functions", name, `${handler.module}.py`),
          content: render(await template(websocket
            ? "function-websocket.py"
            : cronTrigger
              ? "function-cron-trigger.py"
              : datastreamTrigger ? "function-stream-trigger.py" : "function-http.py"), {
            HANDLER: handler.exportName,
          }),
        },
        {
          kind: "file",
          path: join(sourceRoot, "functions", name, "requirements.txt"),
          content: "",
        },
      );
    } else if (family === "go") {
      entries.push(
        {
          kind: "file",
          path: join(sourceRoot, "functions", name, `${handler.module}.go`),
          content: render(await template(websocket
            ? "function-websocket.go"
            : cronTrigger
              ? "function-cron-trigger.go"
              : datastreamTrigger ? "function-stream-trigger.go" : "function-http.go"), {
            HANDLER: handler.exportName,
          }),
        },
        {
          kind: "file",
          path: join(sourceRoot, "functions", name, "go.mod"),
          content: `module vibecloud.local/${loaded.config.name}/functions/${name}\n`,
        },
      );
    } else {
      entries.push({ kind: "directory", path: join(sourceRoot, "functions", name) });
    }
  }

  for (const [functionName, definition] of betterAuthFunctions) {
    if (scope.kind !== "project" && (scope.kind !== "function" || scope.name !== functionName)) continue;
    const migrationRoot = join(sourceRoot, "databases", definition.database!, "migrations");
    entries.push({
      kind: "file",
      path: join(migrationRoot, await betterAuthMigrationName(migrationRoot)),
      content: await template("database-better-auth.sql"),
    });
    if (scope.kind === "function") {
      for (const assetName of viteAssets) entries.push(...await authAssetEntries(sourceRoot, assetName));
    }
  }

  for (const [binding, database] of Object.entries(loaded.config.databases ?? {})) {
    if (scope.kind !== "project" && (scope.kind !== "database" || scope.name !== binding)) continue;
    if (!database.migrations) continue;
    entries.push({
      kind: "directory",
      path: join(sourceRoot, "databases", binding, "migrations"),
    });
  }

  return entries;
}

async function bundledSkillEntries(rootDirectory: string): Promise<ScaffoldEntry[]> {
  const root = new URL("../skills/", import.meta.url);
  const entries: ScaffoldEntry[] = [];
  for await (const source of walkFiles(root)) {
    const sourceStat = await stat(source);
    entries.push({
      kind: "file",
      path: join(rootDirectory, ".agents", "skills", relative(root.pathname, source.pathname)),
      content: await readFile(source, "utf8"),
      mode: sourceStat.mode & 0o777,
    });
  }
  return entries;
}

async function* walkFiles(directory: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

async function projectPackage(loaded: LoadedConfig): Promise<string> {
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const vibecloudVersion = JSON.parse(packageSource).version as string;
  const hasViteAssets = Object.values(loaded.config.assets ?? {})
    .some((assets) => assets.template === "vite");
  const hasYdb = Object.keys(loaded.config.databases ?? {}).length > 0;
  const hasNodeFunctions = Object.values(loaded.config.functions ?? {})
    .some((definition) => functionRuntimeFamily(definition.runtime ?? "nodejs22") === "nodejs");
  const nodeFunctions = Object.values(loaded.config.functions ?? {})
    .filter((definition) => functionRuntimeFamily(definition.runtime ?? "nodejs22") === "nodejs");
  const hasNodeApi = nodeFunctions.some((definition) =>
    definition.template !== "cron-trigger"
    && definition.template !== "datastream-trigger"
    && definition.template !== "websocket");
  const hasNodeCronTrigger = nodeFunctions.some((definition) => definition.template === "cron-trigger");
  const hasNodeDatastreamTrigger = nodeFunctions.some((definition) =>
    definition.template === "datastream-trigger" || Boolean(definition.triggers?.length));
  const hasNodeWebSocket = nodeFunctions.some((definition) => definition.template === "websocket");
  const hasBetterAuth = nodeFunctions.some((definition) => definition.template === "better-auth");
  const hasAiAgent = nodeFunctions.some((definition) => definition.template === "ai-agent");
  const hasAiImage = nodeFunctions.some((definition) => definition.template === "ai-image");
  const hasAiTurn = nodeFunctions.some((definition) => definition.template === "ai-turn");
  const hasLogs = loaded.config.observability?.logs?.enabled === true;
  const hasMetrics = loaded.config.observability?.metrics?.enabled === true;
  const hasTraces = loaded.config.observability?.traces?.enabled === true;
  const dependencies = {
    ...(hasViteAssets
      ? {
        "@bem-react/classname": "^1.6.0",
        "@gravity-ui/icons": "^2.21.0",
        "@gravity-ui/navigation": "^6.4.0",
        "@gravity-ui/uikit": "^7.47.2",
        "react": "^19.2.8",
        "react-dom": "^19.2.8",
      }
      : {}),
    ...(hasYdb
      ? {
        "@vibecloud/db": vibecloudVersion,
        "@ydbjs/drizzle-adapter": "^0.1.1",
        "drizzle-orm": "^0.45.2",
      }
      : {}),
    ...(hasBetterAuth ? { "better-auth": "1.6.26" } : {}),
    ...(hasAiAgent || hasAiImage || hasAiTurn ? { "@vibecloud/ai": vibecloudVersion } : {}),
    ...((hasAiAgent || hasAiImage || hasAiTurn || ((hasLogs || hasMetrics || hasTraces) && hasNodeFunctions))
      ? {
        "@vibecloud/telemetry": vibecloudVersion,
      }
      : {}),
  };
  const devDependencies = {
    "@eslint/js": "^10.0.1",
    "@stylistic/eslint-plugin": "^5.10.0",
    // Authored function code targets Yandex Cloud's nodejs22 runtime even
    // though the Vibecloud build tool itself requires Node 26.
    "@types/node": "^22.20.1",
    "esbuild": "^0.28.2",
    "eslint": "^10.8.1",
    "globals": "^17.9.0",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.66.0",
    "@vibecloud/cli": vibecloudVersion,
    ...(hasNodeApi ? { "@vibecloud/function-api": vibecloudVersion } : {}),
    ...(hasNodeCronTrigger ? { "@vibecloud/function-trigger-cron": vibecloudVersion } : {}),
    ...(hasNodeDatastreamTrigger ? { "@vibecloud/function-trigger-datastream": vibecloudVersion } : {}),
    ...(hasNodeWebSocket ? { "@vibecloud/function-ws": vibecloudVersion } : {}),
    ...(hasViteAssets
      ? {
        "@types/react": "^19.2.14",
        "@types/react-dom": "^19.2.3",
        "@vitejs/plugin-react": "^6.0.5",
        "vite": "^8.2.1",
      }
      : {}),
  };
  const scripts = {
    "vibecloud": "vibecloud",
    "dev": "vibecloud dev",
    "build": "pnpm typecheck && node build.ts",
    "lint": "eslint --flag unstable_native_nodejs_ts_config .",
    "lint:fix": "eslint --flag unstable_native_nodejs_ts_config . --fix",
    "typecheck": "tsc --noEmit",
    "push": "vibecloud push",
    "delete": "vibecloud delete",
  };
  return `${JSON.stringify({
    name: loaded.config.name,
    private: true,
    type: "module",
    packageManager: "pnpm@11.15.1",
    engines: { node: ">=26.0.0" },
    scripts,
    dependencies,
    devDependencies,
  }, null, 2)}\n`;
}

async function updateProjectPackage(loaded: LoadedConfig) {
  const path = join(loaded.rootDirectory, "package.json");
  if (!await exists(path)) return false;
  const currentSource = await readFile(path, "utf8");
  const current = JSON.parse(currentSource) as Record<string, unknown>;
  const desired = JSON.parse(await projectPackage(loaded)) as Record<string, unknown>;
  const currentScripts = record(current.scripts);
  if (isGeneratedViteDevScript(currentScripts.dev)) delete currentScripts.dev;
  for (const [name, value] of Object.entries(currentScripts)) {
    if (isGeneratedAssetDevScript(name, value)) delete currentScripts[name];
  }
  const next = {
    ...current,
    scripts: mergeRecord(currentScripts, desired.scripts),
    dependencies: mergeRecord(desired.dependencies, current.dependencies),
    devDependencies: mergeRecord(desired.devDependencies, current.devDependencies),
  };
  const nextSource = `${JSON.stringify(next, null, 2)}\n`;
  if (nextSource === currentSource) return false;
  await writeFile(path, nextSource);
  return true;
}

function isGeneratedViteDevScript(value: unknown): boolean {
  return typeof value === "string" && /^vite --host 127\.0\.0\.1 src\/assets\/[a-z][a-z0-9-]*$/.test(value);
}

function isGeneratedAssetDevScript(name: string, value: unknown): boolean {
  if (!name.startsWith("dev:") || typeof value !== "string") return false;
  const assetName = name.slice("dev:".length);
  return value === `vite --config vite.config.ts --host 127.0.0.1 src/assets/${assetName}`;
}

async function authAssetEntries(sourceRoot: string, name: string): Promise<ScaffoldEntry[]> {
  return [
    {
      kind: "file",
      path: join(sourceRoot, "assets", name, "auth-client.ts"),
      content: await template("assets/auth-client.ts"),
    },
    {
      kind: "file",
      path: join(sourceRoot, "assets", name, "components", "AuthPanel.tsx"),
      content: await template("assets/AuthPanel.tsx"),
    },
  ];
}

async function updateGeneratedAssetAppsForAuth(loaded: LoadedConfig): Promise<string[]> {
  const updated: string[] = [];
  const original = render(await template("assets/App.tsx"), { PROJECT_NAME: loaded.config.name });
  const authenticated = render(await template("assets/App-auth.tsx"), { PROJECT_NAME: loaded.config.name });
  for (const [name, definition] of Object.entries(loaded.config.assets ?? {})) {
    if (definition.template !== "vite") continue;
    const path = join(loaded.rootDirectory, "src", "assets", name, "App.tsx");
    if (!await exists(path) || await readFile(path, "utf8") !== original) continue;
    await writeFile(path, authenticated);
    updated.push(relative(loaded.rootDirectory, path));
  }
  return updated;
}

function environmentBinding(resource: string): string {
  return resource.toUpperCase().replaceAll("-", "_");
}

async function betterAuthMigrationName(directory: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "001_better_auth.sql";
    throw error;
  }
  const existing = files.find((file) => /^\d+_better_auth\.sql$/.test(file));
  if (existing) return existing;
  const highest = Math.max(0, ...files.map((file) => Number.parseInt(/^\d+/.exec(file)?.[0] ?? "0", 10)));
  return `${String(highest + 1).padStart(3, "0")}_better_auth.sql`;
}

function mergeRecord(defaults: unknown, overrides: unknown) {
  return {
    ...record(defaults),
    ...record(overrides),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseHandler(handler: string): { module: string, exportName: string } {
  const separator = handler.lastIndexOf(".");
  const module = handler.slice(0, separator);
  const exportName = handler.slice(separator + 1);
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(module)) {
    throw new Error(`cannot scaffold handler module: ${handler}`);
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new Error(`cannot scaffold handler export: ${handler}`);
  }
  return { module, exportName };
}

async function template(name: string): Promise<string> {
  return readFile(new URL(`../templates/project/${name}`, import.meta.url), "utf8");
}

function render(source: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{{${name}}}`, value),
    source,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureProjectGitignore(rootDirectory: string): Promise<boolean> {
  const path = join(rootDirectory, ".gitignore");
  const required = (await template("gitignore")).trim().split("\n");
  const current = await readFile(path, "utf8");
  const existing = new Set(current.split("\n"));
  const missing = required.filter((line) => !existing.has(line));
  if (!missing.length) return false;
  const separator = current.length && !current.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${current}${separator}${missing.join("\n")}\n`);
  return true;
}

async function entryKind(path: string): Promise<ScaffoldEntry["kind"] | undefined> {
  try {
    const value = await stat(path);
    if (value.isDirectory()) return "directory";
    if (value.isFile()) return "file";
    throw new Error(`scaffold path is neither a file nor a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
