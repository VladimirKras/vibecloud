import { refreshFrameworkFiles } from "./framework-files.ts";
import { compileDeploymentPlan } from "./deployment-plan.ts";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { writeJsonAtomic } from "./files.ts";

/** Explicit empty values prevent other auto-loaded tfvars from adding undeclared resources. */
export async function writeTerraformInputs(loaded: LoadedConfig, { directory = join(loaded.infraDirectory, ".packages"), artifactDirectory, releaseId }: { directory?: string, artifactDirectory?: string, releaseId?: string } = {}): Promise<string> {
  await refreshFrameworkFiles(loaded);
  const path = join(directory, "selected.tfvars.json");
  await writeJsonAtomic(path, {
    assets: {}, functions: {}, databases: {}, buckets: {}, vars: {}, ai: {}, secrets: null, observability: {},
    ...loaded.config,
    deployment_plan: compileDeploymentPlan(loaded.config),
    ...(artifactDirectory ? { artifact_directory: artifactDirectory } : {}),
    ...(releaseId ? { release_id: releaseId } : {}),
  });
  return path;
}
