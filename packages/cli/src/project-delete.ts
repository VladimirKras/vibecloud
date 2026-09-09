import { writeTerraformInputs } from "./terraform-inputs.ts";
import { withProjectLock } from "./project-lock.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, type CommandRunner, type OutputReader } from "./commands.ts";
import { terraformEnvironmentFor } from "./terraform-environment.ts";
import { yandexEnvironmentFor } from "./yandex-environment.ts";
import { assertManagedFolderIdentity, readYandexFolder } from "./yandex-folder.ts";
import { writeProjectMetadata, type ProjectDeletion } from "./project-metadata.ts";
import { findDeletionOperation, listDeletionOperations, operationReceipt, parseDeletionOperation, readDeletionOperation, type DeletionOperation } from "./deletion-operation.ts";

interface DeleteProjectOptions {
  confirmation?: string
  deleteAfter?: string
  statusOnly?: boolean
  operationId?: string
  environment?: NodeJS.ProcessEnv
  runCommand?: CommandRunner
  readCommand?: OutputReader
}

interface DeleteProjectResult {
  confirmation: string
  destroyed: boolean
  folderDeletionSubmitted: boolean
  folderId?: string
  deleteAfter?: string
  deletionStatus?: ProjectDeletion["status"] | "not-requested"
  operationId?: string
  deleteAt?: string
  deletionError?: string
}

export function projectDeletionConfirmation(loaded: LoadedConfig) {
  return `delete:${loaded.config.name}`;
}

async function deleteProjectUnlocked(loaded: LoadedConfig, {
  confirmation,
  deleteAfter,
  statusOnly = false,
  operationId,
  environment = process.env,
  runCommand = spawnCommand,
  readCommand = readCommandOutput,
}: DeleteProjectOptions = {}): Promise<DeleteProjectResult> {
  const expected = projectDeletionConfirmation(loaded);
  if (!statusOnly && confirmation !== expected) throw new Error(`full project deletion requires --confirm ${expected}`);
  if (statusOnly && deleteAfter !== undefined) throw new Error("--status cannot be combined with --delete-after");
  if (operationId && !statusOnly) throw new Error("--operation requires --status");
  const lifecycle = loaded.projectMetadata?.yc_folder_lifecycle
    ?? (loaded.config.folder_id ? "external" : "managed");
  if (deleteAfter !== undefined) {
    if (lifecycle !== "managed") throw new Error("--delete-after applies only to managed YC folders; adopted folders are not deleted");
    if (deleteAfter.trim() !== deleteAfter || !/^(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(deleteAfter)) {
      throw new Error("--delete-after must be a non-negative duration in HhMmSs format, such as 24h, 22h30m50s, or 0s");
    }
  }

  if (lifecycle === "managed") {
    const metadata = loaded.projectMetadata;
    if (!metadata?.yc_folder_id) throw new Error("Vibecloud project metadata does not contain a managed YC folder ID");
    const folderId = metadata.yc_folder_id;
    const yandexEnvironment = await yandexEnvironmentFor(environment, readCommand);
    let receipt = metadata.deletion;
    const save = async (next: ProjectDeletion) => {
      // This is an external operation receipt, not a reversible source edit.
      // Keep it even when submission or a later status read is interrupted.
      await writeProjectMetadata(loaded.rootDirectory, { ...metadata, deletion: next });
      receipt = next;
    };
    const result = (submitted: boolean): DeleteProjectResult => ({
      confirmation: expected, destroyed: false, folderDeletionSubmitted: submitted, folderId,
      deleteAfter: receipt?.requested_delay,
      deletionStatus: receipt?.status ?? "not-requested",
      operationId: receipt?.operation_id,
      deleteAt: receipt?.delete_after,
      deletionError: receipt?.error,
    });

    let recoveredOperation: DeletionOperation | undefined;
    if (operationId) {
      if (receipt?.operation_id && receipt.operation_id !== operationId) throw new Error("Project already tracks a different deletion operation");
      if (receipt?.previous_operation_ids?.includes(operationId)) throw new Error("This operation predates the current deletion submission");
      recoveredOperation = await readDeletionOperation(operationId, folderId, yandexEnvironment, readCommand);
      await save(operationReceipt(recoveredOperation, receipt));
    }
    if (receipt?.status === "submitting" && !receipt.operation_id) {
      // Recover before reading the folder: an immediate deletion may already
      // have removed it by the time a lost submission response is retried.
      const operation = await findDeletionOperation(folderId, yandexEnvironment, readCommand, receipt);
      if (!operation) {
        if (statusOnly) return result(false);
        throw new Error("YC deletion submission is unresolved. Run vibecloud delete --status, or --status --operation <id> for an exact receipt; no second deletion was submitted.");
      }
      await save(operationReceipt(operation, receipt));
      recoveredOperation = operation;
    }

    if (receipt?.operation_id) {
      const operation = recoveredOperation ?? await readDeletionOperation(receipt.operation_id, folderId, yandexEnvironment, readCommand);
      if (operation.done) {
        await save(operationReceipt(operation, receipt));
        if (statusOnly || recoveredOperation || receipt!.status === "deleted") return result(false);
        // A fresh confirmed delete may retry a failed or cancelled operation,
        // but only after checking that this same owned folder is active again.
      } else {
        const folder = await readYandexFolder(folderId, yandexEnvironment, readCommand);
        assertManagedFolderIdentity(folder, metadata, { allowedStatuses: ["ACTIVE", "PENDING_DELETION", "DELETING"] });
        await save(operationReceipt(operation, receipt, folder.status));
        return result(false);
      }
    }

    const folder = await readYandexFolder(folderId, yandexEnvironment, readCommand);
    assertManagedFolderIdentity(folder, metadata, { allowedStatuses: ["ACTIVE", "PENDING_DELETION", "DELETING"] });
    if (folder.status !== "ACTIVE") {
      const operation = await findDeletionOperation(folderId, yandexEnvironment, readCommand);
      if (operation) {
        await save(operationReceipt(operation, receipt, folder.status));
        return result(false);
      }
      throw new Error("YC folder is already being deleted, but its operation is unavailable. Retry vibecloud delete --status; no second deletion was submitted.");
    }
    if (statusOnly) return result(false);

    const previousOperations = await listDeletionOperations(folderId, yandexEnvironment, readCommand);
    const activeOperations = previousOperations.filter((operation) => !operation.done);
    if (activeOperations.length > 1) throw new Error("YC has multiple active folder deletions. Use vibecloud delete --status --operation <id> to select the exact request.");
    if (activeOperations.length === 1) {
      await save(operationReceipt(activeOperations[0]));
      return result(false);
    }
    await save({ requested_at: new Date().toISOString(), previous_operation_ids: previousOperations.map(({ id }) => id), ...(deleteAfter === undefined ? {} : { requested_delay: deleteAfter }), status: "submitting" });
    let source: string;
    try {
      source = await readCommand("yc", [
        "resource-manager",
        "folder",
        "delete",
        "--id",
        folderId,
        ...(deleteAfter === undefined ? [] : ["--delete-after", deleteAfter]),
        "--async",
        "--format", "json",
        "--retry", "0",
      ], yandexEnvironment);
    } catch (error) {
      // Only an explicit rejection or a failure to start the CLI proves that no
      // operation was accepted. Transport failures retain the submission intent.
      if (isRejectedSubmission(error)) await save({ ...receipt!, status: "rejected", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await save(operationReceipt(parseDeletionOperation(JSON.parse(source), folderId), receipt));
    return result(true);
  }

  if (statusOnly) throw new Error("Deletion status tracking applies only to managed YC folders");

  const configPath = await writeTerraformInputs(loaded);
  const terraformEnvironment = await terraformEnvironmentFor(loaded, environment, readCommand);
  await runCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "destroy",
    `-var-file=${configPath}`,
    "-auto-approve",
    "-input=false",
  ], terraformEnvironment);

  const folderId = loaded.projectMetadata?.yc_folder_id ?? loaded.config.folder_id;
  return { confirmation: expected, destroyed: true, folderDeletionSubmitted: false, folderId };
}

function isRejectedSubmission(error: unknown): boolean {
  if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:ERROR:\s*)?(?:rpc error:\s*code\s*=\s*)?(?:PermissionDenied|Unauthenticated|InvalidArgument|FailedPrecondition|NotFound)\b/m.test(message);
}

export async function deleteProject(loaded: LoadedConfig, options: DeleteProjectOptions = {}) {
  return withProjectLock(loaded.rootDirectory, async () => deleteProjectUnlocked(await loadConfig(loaded.configPath), options));
}
