import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateConfig } from "./config.ts";
import { initProject } from "./init.ts";
import { readProjectMetadata, type ProjectMetadata } from "./project-metadata.ts";
import { readCommandOutput, spawnCommand, yandexEnvironmentFor } from "./push.ts";

type OutputReader = typeof readCommandOutput;
type CommandRunner = typeof spawnCommand;
interface LifecycleOptions { environment?: NodeJS.ProcessEnv, readCommand?: OutputReader, runCommand?: CommandRunner }
export interface DoctorCheck { name: string, status: "ok" | "warning" | "error", message: string }
export interface DoctorResult { directory: string, healthy: boolean, repaired: boolean, checks: DoctorCheck[] }

export async function doctorProject(path: string, {
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
        const environment = await yandexEnvironmentFor(options.environment ?? process.env, options.readCommand ?? readCommandOutput, { requireFolderId: false });
        const folder = JSON.parse(await (options.readCommand ?? readCommandOutput)("yc", [
          "resource-manager", "folder", "get", "--id", metadata.yc_folder_id, "--format", "json",
        ], environment)) as { id?: string, status?: string, labels?: Record<string, string> };
        assertManagedFolderIdentity(folder, metadata);
        if (folder.labels?.vibecloud_project_id !== metadata.project_id) {
          await (options.runCommand ?? spawnCommand)("yc", [
            "resource-manager", "folder", "update", "--id", metadata.yc_folder_id,
            "--labels", `vibecloud_project_id=${metadata.project_id}`,
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
    checks.push({ name: "metadata", status: metadata.phase === "ready" ? "ok" : "error", message: `schema ${metadata.schema_version}, scaffold ${metadata.scaffold_version}, phase ${metadata.phase}` });
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
      const environment = await yandexEnvironmentFor(options.environment ?? process.env, options.readCommand ?? readCommandOutput, { requireFolderId: false });
      const folder = JSON.parse(await (options.readCommand ?? readCommandOutput)("yc", [
        "resource-manager", "folder", "get", "--id", metadata.yc_folder_id, "--format", "json",
      ], environment)) as { id?: string, status?: string, labels?: Record<string, string> };
      const labelMatches = metadata.yc_folder_lifecycle === "external" || folder.labels?.vibecloud_project_id === metadata.project_id;
      const healthy = folder.id === metadata.yc_folder_id && folder.status === "ACTIVE" && labelMatches;
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function assertManagedFolderIdentity(folder: { id?: string, status?: string, labels?: Record<string, string> }, metadata: ProjectMetadata): void {
  if (folder.id !== metadata.yc_folder_id || folder.status !== "ACTIVE") throw new Error(`YC folder ${metadata.yc_folder_id} is missing or not active`);
  const projectId = folder.labels?.vibecloud_project_id;
  if (projectId && projectId !== metadata.project_id) throw new Error(`YC folder ${metadata.yc_folder_id} belongs to different Vibecloud project ${projectId}`);
}
