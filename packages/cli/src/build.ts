import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileDeploymentPlan } from "./deployment-plan.ts";
import { spawnCommand, type CommandRunner } from "./commands.ts";
import type { LoadedConfig } from "./config.ts";

export async function buildProject(
  loaded: LoadedConfig,
  { runCommand = spawnCommand, environment = process.env, outputDirectory }: { runCommand?: CommandRunner, environment?: NodeJS.ProcessEnv, outputDirectory?: string } = {},
): Promise<boolean> {
  const hasBuild = Object.keys(loaded.config.assets ?? {}).length > 0
    || Object.keys(loaded.config.functions ?? {}).length > 0
    || Object.values(loaded.config.databases ?? {}).some((database) => database.migrations);
  if (hasBuild) {
    await runCommand("pnpm", ["build"], { ...environment, VIBECLOUD_CONFIG_PATH: loaded.configPath, ...(outputDirectory ? { VIBECLOUD_BUILD_OUTPUT: outputDirectory } : {}) }, loaded.rootDirectory);
    if (outputDirectory) {
      let manifest: string;
      try {
        manifest = await readFile(join(outputDirectory, "deployment-plan.json"), "utf8");
      } catch (cause) {
        throw new Error("Project build did not produce isolated deployment artifacts. Update build.ts to honor VIBECLOUD_BUILD_OUTPUT and write deployment-plan.json.", { cause });
      }
      if (JSON.stringify(JSON.parse(manifest)) !== JSON.stringify(compileDeploymentPlan(loaded.config))) {
        throw new Error("Built deployment plan differs from the selected configuration");
      }
    }
  }
  return hasBuild;
}
