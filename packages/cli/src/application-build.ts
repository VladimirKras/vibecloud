import { cp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildArtifact, buildFunctionGroups, compileDeploymentPlan, type DeploymentPlan, type FunctionDeclaration } from "./function-build.ts";
import { buildRoot, withBuildOutput } from "./build-output.ts";

interface BuildCommand {
  command: string
  cwd?: string
}

interface BuildDeclaration extends FunctionDeclaration {
  release_id?: string
  deployment_plan?: DeploymentPlan
  ai?: Parameters<typeof compileDeploymentPlan>[0]["ai"]
  databases?: Record<string, { migrations?: boolean }>
  assets?: Record<string, { template: "vite" } | { template?: "custom", build: BuildCommand }>
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

/** Versioned build implementation. build.ts remains an app-owned entrypoint. */
export async function buildApplication(root: string | URL, environment = process.env): Promise<void> {
  const project = await realpath(root instanceof URL ? fileURLToPath(root) : resolve(root));
  const source = join(project, "src");
  const require = createRequire(join(project, "package.json"));
  const declaration: BuildDeclaration = JSON.parse(await readFile(resolve(project, environment.VIBECLOUD_CONFIG_PATH ?? "infra/vibecloud.auto.tfvars.json"), "utf8"));
  const plan = declaration.deployment_plan ?? compileDeploymentPlan(declaration);
  await withBuildOutput(buildRoot(project, environment), environment.VIBECLOUD_BUILD_OUTPUT, async (dist) => {
    if (Object.keys(declaration.functions ?? {}).length) {
      const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
      await buildFunctionGroups(project, declaration, build, { outputDirectory: dist, plan });
    }

    const assets = Object.entries(declaration.assets ?? {});
    const viteAssets = assets.filter(([, definition]) => definition.template === "vite");
    if (viteAssets.length) {
      const vitePackage: string = "vite";
      const { build: buildVite, loadConfigFromFile, mergeConfig }: ViteBuildApi = await import(pathToFileURL(require.resolve(vitePackage)).href);
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
          ...(declaration.release_id ? { base: `/_vibecloud/releases/${declaration.release_id}/${name}/` } : {}),
          build: {
            outDir: join(dist, "assets", name),
            emptyOutDir: false,
          },
        }));
      }
    }

    for (const [name, definition] of assets) {
      if (definition.template === "vite") continue;
      await buildArtifact(project, "asset", name, definition.build, join(dist, "assets", name), undefined, declaration.release_id ? { VIBECLOUD_ASSET_BASE: `/_vibecloud/releases/${declaration.release_id}/${name}/` } : {});
    }

    for (const [name, database] of Object.entries(declaration.databases ?? {})) {
      if (!database.migrations) continue;
      const migrations = join(source, "databases", name, "migrations");
      await cp(migrations, join(dist, "databases", name, "migrations"), { recursive: true });
    }

    await writeFile(join(dist, "deployment-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  });
  console.log(`built ${environment.VIBECLOUD_BUILD_OUTPUT ?? join(buildRoot(project, environment), "dist")}`);
}
