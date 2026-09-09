import type { OutputReader } from "./commands.ts";
import type { ProjectMetadata } from "./project-metadata.ts";

export const PROJECT_LABEL = "vibecloud_project_id";

export interface YandexFolder {
  id?: string
  status?: string
  labels?: Record<string, string>
}

export async function readYandexFolder(
  folderId: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<YandexFolder> {
  return parseYandexFolder(await readCommand("yc", [
    "resource-manager", "folder", "get", "--id", folderId, "--format", "json",
  ], environment));
}

export function parseYandexFolder(source: string): YandexFolder {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Yandex Cloud returned an invalid folder response");
  }
  return value as YandexFolder;
}

export function assertManagedFolderIdentity(
  folder: YandexFolder,
  metadata: ProjectMetadata,
  { allowMissingLabel = false, allowedStatuses = ["ACTIVE"] }: { allowMissingLabel?: boolean, allowedStatuses?: string[] } = {},
): void {
  if (!metadata.yc_folder_id || folder?.id !== metadata.yc_folder_id || !allowedStatuses.includes(folder.status ?? "")) {
    throw new Error(`YC folder ${metadata.yc_folder_id} is missing or not active`);
  }
  const projectId = folder.labels?.[PROJECT_LABEL];
  if (projectId === metadata.project_id) return;
  if (!projectId && allowMissingLabel) return;
  if (!projectId) throw new Error(`YC folder ${metadata.yc_folder_id} is missing its managed-project label; run vibecloud doctor --repair`);
  throw new Error(`YC folder ${metadata.yc_folder_id} belongs to different Vibecloud project ${projectId}`);
}
