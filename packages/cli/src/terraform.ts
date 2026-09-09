import type { LoadedConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, type CommandRunner, type OutputReader } from "./commands.ts";
import { terraformEnvironmentFor } from "./terraform-environment.ts";
import type { PublicationState } from "./publication.ts";

/** A command adapter, not a resource engine: Terraform owns planning, graph execution and locking. */
export async function terraform(loaded: LoadedConfig, options: { environment?: NodeJS.ProcessEnv, runCommand?: CommandRunner, readCommand?: OutputReader } = {}) {
  const run = options.runCommand ?? spawnCommand;
  const read = options.readCommand ?? readCommandOutput;
  const environment = await terraformEnvironmentFor(loaded, options.environment ?? process.env, read);
  const prefix = [`-chdir=${loaded.infraDirectory}`];
  return {
    environment, read,
    init: () => run("terraform", [...prefix, "init", "-reconfigure", "-input=false", "-lockfile=readonly"], environment),
    async state(): Promise<PublicationState> {
      const source = await read("terraform", [...prefix, "state", "pull"], environment);
      if (!source.trim()) return {};
      const value = JSON.parse(source) as PublicationState;
      if (!Array.isArray(value.resources)) throw new Error("Terraform state has no resource list; refusing cloud mutation");
      return value;
    },
    output: (name: string, json = false) => read("terraform", [...prefix, "output", json ? "-json" : "-raw", name], environment),
    refresh: (inputs: string) => run("terraform", [...prefix, "apply", "-refresh-only", `-var-file=${inputs}`, "-auto-approve", "-input=false", "-lock=true", "-lock-timeout=30s"], environment),
    plan: (inputs: string, plan: string, extra: string[] = []) => run("terraform", [...prefix, "plan", `-var-file=${inputs}`, `-out=${plan}`, "-input=false", "-lock=true", "-lock-timeout=30s", ...extra], environment),
    apply: (plan: string) => run("terraform", [...prefix, "apply", "-input=false", "-lock=true", "-lock-timeout=30s", plan], environment),
  };
}
