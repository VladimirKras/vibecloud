import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BuildCommand {
  command: string
  cwd?: string
}

interface BuildDeclaration {
  functions?: Record<string, { handler: string, runtime?: string, build?: BuildCommand }>
  assets?: Record<string, { template: "vite" } | { template?: "custom", build: BuildCommand }>
  observability?: { source_maps?: boolean }
}

// Vite is installed only in projects with Vite assets. Describe the build API
// here so other projects can typecheck without installing that dependency.
interface ViteBuildApi {
  build(config: object): Promise<unknown>
  loadConfigFromFile(
    environment: { command: "build", mode: string },
    configFile: string,
    root: string,
  ): Promise<{ config: object } | null>
  mergeConfig(config: object, overrides: object): object
}

const project = dirname(fileURLToPath(import.meta.url));
const source = join(project, "src");
const dist = join(project, "dist");
const excludedPackageEntries = new Set([".DS_Store", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__"]);
const declaration: BuildDeclaration = JSON.parse(await readFile(join(project, "infra", "vibecloud.auto.tfvars.json"), "utf8"));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(project, "infra", ".packages"), { recursive: true });

const functions = Object.entries(declaration.functions ?? {});
const nodeEntries = Object.fromEntries(
  functions
    .filter(([, definition]) => !definition.build && runtimeFamily(definition.runtime ?? "nodejs22") === "nodejs")
    .map(([name, definition]) => {
      const separator = definition.handler.lastIndexOf(".");
      const module = definition.handler.slice(0, separator);
      return [`${name}/${module}`, join(source, "functions", name, `${module}.ts`)];
    }),
);
if (Object.keys(nodeEntries).length) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: nodeEntries,
    outdir: join(dist, "functions"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: declaration.observability?.source_maps ?? false,
  });
  for (const [name] of functions.filter(([, definition]) => (
    !definition.build && runtimeFamily(definition.runtime ?? "nodejs22") === "nodejs"
  ))) {
    await writeFile(join(dist, "functions", name, "package.json"), '{"type":"commonjs"}\n');
  }
}

for (const [name, definition] of functions) {
  const sourceDirectory = join(source, "functions", name);
  const outputDirectory = join(dist, "functions", name);
  if (definition.build) {
    await run(definition.build.command, resolve(project, definition.build.cwd ?? "."), {
      VIBECLOUD_FUNCTION_NAME: name,
      VIBECLOUD_FUNCTION_SOURCE: sourceDirectory,
      VIBECLOUD_FUNCTION_OUTPUT: outputDirectory,
    });
    if (!await exists(outputDirectory)) {
      throw new Error(`custom build for ${name} did not create ${outputDirectory}`);
    }
    continue;
  }
  const family = runtimeFamily(definition.runtime ?? "nodejs22");
  if (family === "python" || family === "go") {
    await cp(sourceDirectory, outputDirectory, { recursive: true, filter: packageFile });
  } else if (family !== "nodejs") {
    throw new Error(`function ${name} runtime ${definition.runtime} requires build.command`);
  }
}

const assets = Object.entries(declaration.assets ?? {});
const viteAssets = assets.filter(([, definition]) => definition.template === "vite");
if (viteAssets.length) {
  const vitePackage: string = "vite";
  const { build: buildVite, loadConfigFromFile, mergeConfig }: ViteBuildApi = await import(vitePackage);
  const configFile = join(project, "vite.config.ts");
  const loadedViteConfig = await loadConfigFromFile(
    { command: "build", mode: "production" },
    configFile,
    project,
  );
  if (!loadedViteConfig) throw new Error(`Vite did not load ${configFile}`);
  for (const [name] of viteAssets) {
    await buildVite(mergeConfig(loadedViteConfig.config, {
      root: join(source, "assets", name),
      build: {
        outDir: join(dist, "assets", name),
        emptyOutDir: false,
      },
    }));
  }
}

for (const [name, definition] of assets) {
  if (definition.template === "vite") continue;
  const outputDirectory = join(dist, "assets", name);
  await run(definition.build.command, resolve(project, definition.build.cwd ?? "."), {
    VIBECLOUD_ASSET_NAME: name,
    VIBECLOUD_ASSET_SOURCE: join(source, "assets", name),
    VIBECLOUD_ASSET_OUTPUT: outputDirectory,
  });
  if (!await exists(outputDirectory)) {
    throw new Error(`custom build for ${name} did not create ${outputDirectory}`);
  }
}

const migrations = join(source, "databases");
if (await exists(migrations)) {
  await cp(migrations, join(dist, "databases"), { recursive: true });
}

console.log(`built ${dist}`);

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runtimeFamily(runtime: string) {
  if (runtime.startsWith("nodejs")) return "nodejs";
  if (runtime.startsWith("python")) return "python";
  if (runtime.startsWith("golang")) return "go";
  return undefined;
}

function packageFile(path: string) {
  return !excludedPackageEntries.has(basename(path));
}

function run(command: string, cwd: string, extraEnvironment: NodeJS.ProcessEnv) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...extraEnvironment },
      shell: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
