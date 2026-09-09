import { createHash } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, type CommandRunner, type OutputReader } from "./commands.ts";
import { withProjectLock } from "./project-lock.ts";
import { stopLocalSession } from "./local-session.ts";

export const LOCAL_OWNER_LABEL = "dev.vibecloud.owner";

/** Checkout identity, not a mutable display name or a UUID shared by worktrees. */
export async function localRuntimeIdentity(root: string) {
  const owner = createHash("sha256").update(await realpath(root)).digest("hex");
  return { owner, project: `vibecloud-${owner.slice(0, 16)}` };
}

export async function inspectLocalResources(root: string, environment = process.env, readCommand: OutputReader = readCommandOutput) {
  const identity = await localRuntimeIdentity(root);
  const resources = { containers: [] as string[], volumes: [] as string[], networks: [] as string[] };
  for (const [kind, list, format] of [
    ["containers", ["ps", "-a"], "{{.ID}}"],
    ["volumes", ["volume", "ls"], "{{.Name}}"],
    ["networks", ["network", "ls"], "{{.ID}}"],
  ] as const) {
    const output = await readCommand("docker", [...list, "--filter", `label=com.docker.compose.project=${identity.project}`, "--format", format], environment, root);
    const ids = output.trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const args = kind === "containers"
        ? ["inspect", "--format", "{{json .Config.Labels}}", id]
        : [kind === "volumes" ? "volume" : "network", "inspect", "--format", "{{json .Labels}}", id];
      const labels = JSON.parse(await readCommand("docker", args, environment, root)) as Record<string, string> | null;
      if (labels?.[LOCAL_OWNER_LABEL] !== identity.owner) throw new Error(`Refusing to use Docker ${kind} ${id}: it is not owned by this checkout`);
    }
    resources[kind] = ids;
  }
  return { ...identity, ...resources };
}

/** Exact inspected IDs avoid Compose accidentally selecting another checkout's data. */
export async function stopLocalProject(loaded: LoadedConfig, {
  volumes = false, confirmation, environment = process.env, readCommand = readCommandOutput, runCommand = spawnCommand,
}: { volumes?: boolean, confirmation?: string, environment?: NodeJS.ProcessEnv, readCommand?: OutputReader, runCommand?: CommandRunner } = {}) {
  if (volumes && confirmation !== `delete-local:${loaded.config.name}`) throw new Error(`Removing local data requires --confirm delete-local:${loaded.config.name}`);
  return withProjectLock(loaded.rootDirectory, async () => {
    if (volumes) {
      const storage = join(loaded.rootDirectory, ".vibecloud", "media");
      const physical = await realpath(storage).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (physical && physical !== join(await realpath(loaded.rootDirectory), ".vibecloud", "media")) throw new Error("Local media storage must not be a symlink");
    }
    await stopLocalSession(loaded.rootDirectory);
    const resources = await inspectLocalResources(loaded.rootDirectory, environment, readCommand);
    if (resources.containers.length) await runCommand("docker", ["stop", ...resources.containers], environment, loaded.rootDirectory);
    if (resources.containers.length) await runCommand("docker", ["rm", ...resources.containers], environment, loaded.rootDirectory);
    if (resources.networks.length) await runCommand("docker", ["network", "rm", ...resources.networks], environment, loaded.rootDirectory);
    if (volumes && resources.volumes.length) await runCommand("docker", ["volume", "rm", ...resources.volumes], environment, loaded.rootDirectory);
    if (volumes) await rm(join(loaded.rootDirectory, ".vibecloud", "media"), { recursive: true, force: true });
    return resources;
  });
}
