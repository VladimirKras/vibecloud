import { withProjectLock } from "./project-lock.ts";
import { exists, writeJsonAtomic } from "./files.ts";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateConfig } from "./config.ts";
import { initProject } from "./init.ts";
import { readProjectMetadata } from "./project-metadata.ts";
import { readCommandOutput, spawnCommand, type CommandRunner, type OutputReader } from "./commands.ts";
import { yandexEnvironmentFor } from "./yandex-environment.ts";
import { assertManagedFolderIdentity, PROJECT_LABEL, readYandexFolder } from "./yandex-folder.ts";

interface LifecycleOptions { environment?: NodeJS.ProcessEnv, readCommand?: OutputReader, runCommand?: CommandRunner }
export interface DoctorCheck { name: string, status: "ok" | "warning" | "error", message: string }
export interface DoctorResult { directory: string, healthy: boolean, repaired: boolean, checks: DoctorCheck[] }

async function doctorProjectUnlocked(path: string, {
  repair = false,
  ...options
}: LifecycleOptions & { repair?: boolean } = {}): Promise<DoctorResult> {
  const directory = resolve(path);
  const configPath = join(directory, "infra", "vibecloud.auto.tfvars.json");
  let metadata = await readProjectMetadata(directory);
  let repaired = false;
  const checks: DoctorCheck[] = [];

  if (repair && metadata && metadata.phase !== "ready") {
    await initProject(directory, options);
    metadata = await readProjectMetadata(directory);
    repaired = true;
  }
  if (repair && metadata?.yc_folder_id) {
    try {
      const configValue = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      if (configValue.folder_id !== metadata.yc_folder_id) {
        configValue.folder_id = metadata.yc_folder_id;
        await writeJsonAtomic(configPath, configValue);
        repaired = true;
      }
      if (metadata.yc_folder_lifecycle === "managed") {
        const environment = await yandexEnvironmentFor(options.environment ?? process.env, options.readCommand ?? readCommandOutput);
        const folder = await readYandexFolder(metadata.yc_folder_id, environment, options.readCommand ?? readCommandOutput);
        assertManagedFolderIdentity(folder, metadata, { allowMissingLabel: true });
        if (folder.labels?.[PROJECT_LABEL] !== metadata.project_id) {
          const labels = { ...folder.labels, [PROJECT_LABEL]: metadata.project_id };
          await (options.runCommand ?? spawnCommand)("yc", [
            "resource-manager", "folder", "update", "--id", metadata.yc_folder_id,
            "--labels", Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(","),
          ], environment);
          repaired = true;
        }
      }
    } catch (error) {
      checks.push({ name: "repair", status: "error", message: errorMessage(error) });
    }
  }

  if (!metadata) {
    const hasConfig = await exists(configPath);
    checks.push({
      name: "metadata",
      status: hasConfig ? "error" : "warning",
      message: hasConfig ? "directory contains an unsupported pre-release scaffold; initialize a new directory" : "project is not initialized; run vibecloud init",
    });
  } else {
    checks.push({ name: "metadata", status: metadata.phase === "ready" ? "ok" : "error", message: `schema ${metadata.schema_version}, scaffold ${metadata.scaffold_version}, initialization phase ${metadata.phase}` });
    if (metadata.deletion) checks.push({
      name: "deletion",
      status: ["cancelled", "failed", "rejected"].includes(metadata.deletion.status) ? "warning" : "error",
      message: `last observed deletion status: ${metadata.deletion.status}${metadata.deletion.operation_id ? ` (${metadata.deletion.operation_id})` : ""}; run vibecloud delete --status to refresh`,
    });
  }

  let configFolderId: string | undefined;
  try {
    const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
    configFolderId = config.folder_id;
    const matches = !metadata?.yc_folder_id || config.folder_id === metadata.yc_folder_id;
    checks.push({ name: "config", status: matches ? "ok" : "error", message: matches ? `configuration uses folder ${config.folder_id ?? "<missing>"}` : "folder_id differs from project metadata" });
  } catch (error) {
    checks.push({ name: "config", status: "error", message: errorMessage(error) });
  }

  if (metadata?.yc_folder_id) {
    try {
      const environment = await yandexEnvironmentFor(options.environment ?? process.env, options.readCommand ?? readCommandOutput);
      const folder = await readYandexFolder(metadata.yc_folder_id, environment, options.readCommand ?? readCommandOutput);
      if (metadata.yc_folder_lifecycle === "managed") assertManagedFolderIdentity(folder, metadata);
      const healthy = folder.id === metadata.yc_folder_id && folder.status === "ACTIVE";
      checks.push({ name: "yc-folder", status: healthy ? "ok" : "error", message: healthy ? `${metadata.yc_folder_lifecycle} folder is active` : "folder identity, status, or managed-project label is invalid" });
    } catch (error) {
      checks.push({ name: "yc-folder", status: "error", message: errorMessage(error) });
    }
  }

  if (await exists(join(directory, "infra", ".terraform"))) {
    try {
      await (options.readCommand ?? readCommandOutput)("terraform", [`-chdir=${join(directory, "infra")}`, "state", "list"], options.environment ?? process.env);
      checks.push({ name: "terraform-state", status: "ok", message: "Terraform state is readable" });
    } catch (error) {
      const message = errorMessage(error);
      checks.push(/No state file was found/iu.test(message)
        ? { name: "terraform-state", status: "ok", message: "application is not deployed yet; the YC folder is ready for local AI" }
        : { name: "terraform-state", status: "warning", message: `state unavailable: ${message}` });
    }
  } else if (await exists(join(directory, "infra"))) {
    checks.push({
      name: "terraform-state",
      status: "ok",
      message: "application is not deployed yet; the YC folder is ready for local AI",
    });
  }

  try {
    await (options.readCommand ?? readCommandOutput)("docker", ["info", "--format", "{{json .ServerVersion}}"], options.environment ?? process.env, directory);
    await (options.readCommand ?? readCommandOutput)("docker", ["compose", "version", "--short"], options.environment ?? process.env, directory);
    checks.push({ name: "container-runtime", status: "ok", message: "Docker Engine and Compose are available" });
  } catch (error) {
    checks.push({ name: "container-runtime", status: "warning", message: `Docker Compose unavailable: ${errorMessage(error)}` });
  }
  if (metadata?.yc_folder_id && configFolderId && metadata.yc_folder_id !== configFolderId) {
    checks.push({ name: "identity", status: "error", message: "project folder identity is inconsistent" });
  }
  return { directory, repaired, checks, healthy: checks.every((check) => check.status !== "error") };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function doctorProject(path: string, options: LifecycleOptions & { repair?: boolean } = {}) {
  return withProjectLock(resolve(path), () => doctorProjectUnlocked(path, options));
}
