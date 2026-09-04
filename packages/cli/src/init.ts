import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, validateApplicationName } from "./config.ts";
import {
  newProjectMetadata,
  readProjectMetadata,
  writeProjectMetadata,
  type ProjectPhase,
  type ProjectMetadata,
} from "./project-metadata.ts";
import { readCommandOutput, spawnCommand, yandexEnvironmentFor } from "./push.ts";
import { initializeProjectScaffold, type ScaffoldResult } from "./scaffold.ts";

const PROJECT_LABEL = "vibecloud_project_id";

interface InitResult {
  directory: string
  configPath: string
  metadataPath: string
  folderId: string
  folderLifecycle: ProjectMetadata["yc_folder_lifecycle"]
  scaffold: ScaffoldResult
}

type OutputReader = typeof readCommandOutput;
type CommandRunner = typeof spawnCommand;

interface InitOptions {
  folderId?: string
  environment?: NodeJS.ProcessEnv
  readCommand?: OutputReader
  runCommand?: CommandRunner
  install?: boolean
  afterPhase?: (phase: ProjectPhase) => Promise<void>
}

interface YandexFolder {
  id?: string
  status?: string
  labels?: Record<string, string>
}

export async function initProject(path: string, {
  folderId,
  environment = process.env,
  readCommand = readCommandOutput,
  runCommand = spawnCommand,
  install = true,
  afterPhase = async () => undefined,
}: InitOptions = {}): Promise<InitResult> {
  const directory = resolve(path);
  const configPath = join(directory, "infra", "vibecloud.auto.tfvars.json");
  const configExists = await exists(configPath);
  const name = configExists
    ? validateApplicationName(String((JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>).name ?? ""))
    : validateApplicationName(basename(directory));
  const existingMetadata = await readProjectMetadata(directory);
  if (configExists && !existingMetadata) {
    throw new Error("directory contains an unsupported pre-release scaffold: initialize a new directory");
  }

  let metadata = existingMetadata ?? newProjectMetadata(folderId ? "external" : "managed", folderId ?? null);
  validateRequestedFolder(metadata, folderId);
  const metadataPath = join(directory, ".vibecloud", "project.json");
  if (!existingMetadata) {
    await writeProjectMetadata(directory, metadata);
    await afterPhase("scaffolded");
  }

  if (metadata.phase === "scaffolded") {
    const yandexEnvironment = await yandexEnvironmentFor(environment, readCommand, { requireFolderId: false });
    const resolvedFolderId = metadata.yc_folder_lifecycle === "external"
      ? await validateExternalFolder(requiredFolderId(metadata), yandexEnvironment, readCommand)
      : await recoverOrCreateManagedFolder(name, metadata.project_id, yandexEnvironment, readCommand);
    metadata = { ...metadata, yc_folder_id: resolvedFolderId, phase: "folder_created" };
    await writeProjectMetadata(directory, metadata);
    await afterPhase("folder_created");
  }

  const resolvedFolderId = requiredFolderId(metadata);
  await ensureConfig(configPath, name, resolvedFolderId);
  const loaded = await loadConfig(configPath);
  const scaffold = await initializeProjectScaffold(loaded);
  if (install) await runCommand("pnpm", ["install"], environment, directory);
  if (metadata.phase !== "ready") {
    metadata = { ...metadata, phase: "ready" };
    await writeProjectMetadata(directory, metadata);
    await afterPhase("ready");
  }
  return {
    directory,
    configPath,
    metadataPath,
    folderId: resolvedFolderId,
    folderLifecycle: metadata.yc_folder_lifecycle,
    scaffold,
  };
}

function validateRequestedFolder(metadata: ProjectMetadata, folderId: string | undefined): void {
  if (!folderId) return;
  if (metadata.yc_folder_lifecycle !== "external") {
    throw new Error("cannot adopt a folder for a project initialized with managed folder lifecycle");
  }
  if (metadata.yc_folder_id && metadata.yc_folder_id !== folderId) {
    throw new Error(`project metadata already references YC folder ${metadata.yc_folder_id}`);
  }
}

async function validateExternalFolder(
  folderId: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<string> {
  const folder = parseFolder(await readCommand("yc", [
    "resource-manager", "folder", "get",
    "--id", folderId,
    "--format", "json",
  ], environment));
  if (folder.id !== folderId) throw new Error(`Yandex Cloud returned a different folder for ${folderId}`);
  assertActiveFolder(folder, folderId);
  return folderId;
}

async function recoverOrCreateManagedFolder(
  name: string,
  projectId: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<string> {
  const cloudId = environment.YC_CLOUD_ID?.trim();
  if (!cloudId) throw new Error("Yandex Cloud returned an empty cloud ID");
  const folders = parseFolderList(await readCommand("yc", [
    "resource-manager", "folder", "list",
    "--cloud-id", cloudId,
    "--format", "json",
  ], environment)).filter((folder) => folder.labels?.[PROJECT_LABEL] === projectId);
  if (folders.length > 1) throw new Error(`multiple YC folders carry Vibecloud project label ${projectId}`);
  if (folders.length === 1) {
    const folderId = requiredYandexFolderId(folders[0]);
    assertActiveFolder(folders[0], folderId);
    return folderId;
  }

  const folder = parseFolder(await readCommand("yc", [
    "resource-manager", "folder", "create",
    "--name", name,
    "--description", `Project managed by Vibecloud for ${name}`,
    "--labels", `${PROJECT_LABEL}=${projectId}`,
    "--cloud-id", cloudId,
    "--format", "json",
  ], environment));
  const folderId = requiredYandexFolderId(folder);
  assertActiveFolder(folder, folderId);
  return folderId;
}

async function ensureConfig(configPath: string, name: string, folderId: string): Promise<void> {
  if (!await exists(configPath)) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      name,
      folder_id: folderId,
      gateway: { routes: [] },
    }, null, 2)}\n`, { flag: "wx" });
    return;
  }

  const value = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  if (value.name !== name) throw new Error(`${configPath}: project name changed during initialization`);
  if (value.folder_id !== undefined && value.folder_id !== folderId) {
    throw new Error(`${configPath}: folder_id does not match ${folderId}`);
  }
  if (value.folder_id === undefined) {
    value.folder_id = folderId;
    await writeJsonAtomic(configPath, value);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function requiredFolderId(metadata: ProjectMetadata): string {
  if (!metadata.yc_folder_id) throw new Error("Vibecloud project metadata does not contain a YC folder ID");
  return metadata.yc_folder_id;
}

function requiredYandexFolderId(folder: YandexFolder): string {
  if (!folder.id?.trim()) throw new Error("Yandex Cloud returned an empty folder ID");
  return folder.id;
}

function assertActiveFolder(folder: YandexFolder, folderId: string): void {
  if (folder.status !== "ACTIVE") {
    throw new Error(`YC folder ${folderId} is ${folder.status ?? "in an unknown state"}, expected ACTIVE`);
  }
}

function parseFolder(source: string): YandexFolder {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Yandex Cloud returned an invalid folder response");
  }
  return value as YandexFolder;
}

function parseFolderList(source: string): YandexFolder[] {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value)) throw new Error("Yandex Cloud returned an invalid folder list");
  return value as YandexFolder[];
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
