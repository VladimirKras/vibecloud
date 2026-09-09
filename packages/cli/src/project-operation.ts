import { loadConfig, type LoadedConfig } from "./config.ts";
import { withProjectLock } from "./project-lock.ts";
import { assertManagedFolderIdentity, readYandexFolder } from "./yandex-folder.ts";
import type { OutputReader } from "./commands.ts";

export type CloudOperation = "publish" | "migrate";

/** Cloud admission belongs to the project lifecycle, not individual adapters. */
export function assertCloudAdmission(loaded: LoadedConfig, operation: CloudOperation): void {
  const metadata = loaded.projectMetadata;
  if (!metadata || metadata.phase !== "ready") throw new Error(`Cannot ${operation} an uninitialized project. Run vibecloud init first.`);
  if (metadata.deletion && !["cancelled", "failed", "rejected"].includes(metadata.deletion.status)) {
    throw new Error(`Cannot ${operation}: project deletion is ${metadata.deletion.status}. Run vibecloud delete --status to reconcile it.`);
  }
}

export async function assertCloudFolderActive(loaded: LoadedConfig, environment: NodeJS.ProcessEnv, read: OutputReader): Promise<void> {
  const metadata = loaded.projectMetadata!;
  const folder = await readYandexFolder(metadata.yc_folder_id!, environment, read);
  if (metadata.yc_folder_lifecycle === "managed") assertManagedFolderIdentity(folder, metadata);
  else if (folder.id !== metadata.yc_folder_id || folder.status !== "ACTIVE") throw new Error("YC folder is missing or not active; cloud work cannot proceed.");
}

export async function withCloudOperation<T>(loaded: LoadedConfig, operation: CloudOperation, work: (current: LoadedConfig) => Promise<T>): Promise<T> {
  return withProjectLock(loaded.rootDirectory, async () => {
    const current = await loadConfig(loaded.configPath);
    assertCloudAdmission(current, operation);
    return work(current);
  });
}
