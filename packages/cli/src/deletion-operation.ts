import { z } from "zod";
import type { OutputReader } from "./commands.ts";
import type { ProjectDeletion } from "./project-metadata.ts";

const operationSchema = z.object({
  id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  done: z.boolean().optional(),
  metadata: z.object({
    "@type": z.literal("type.googleapis.com/yandex.cloud.resourcemanager.v1.DeleteFolderMetadata"),
    "folder_id": z.string().min(1),
    "delete_after": z.iso.datetime({ offset: true }).optional(),
    "cancelled_at": z.string().optional(),
  }),
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
});
export type DeletionOperation = z.infer<typeof operationSchema>;

export function parseDeletionOperation(value: unknown, folderId: string): DeletionOperation {
  const operation = operationSchema.parse(value);
  if (operation.metadata.folder_id !== folderId) throw new Error("Deletion operation belongs to a different YC folder");
  return operation;
}

export async function readDeletionOperation(id: string, folderId: string, environment: NodeJS.ProcessEnv, readCommand: OutputReader): Promise<DeletionOperation> {
  const operation = parseDeletionOperation(JSON.parse(await readCommand("yc", ["operation", "get", id, "--format", "json"], environment)), folderId);
  if (operation.id !== id) throw new Error("YC returned a different deletion operation");
  return operation;
}

/** Recover requests accepted before the caller could save their operation ID. */
export async function listDeletionOperations(folderId: string, environment: NodeJS.ProcessEnv, readCommand: OutputReader): Promise<DeletionOperation[]> {
  const value: unknown = JSON.parse(await readCommand("yc", ["resource-manager", "folder", "list-operations", "--id", folderId, "--format", "json"], environment));
  if (!Array.isArray(value)) throw new Error("YC returned an invalid folder operation list");
  return value.flatMap((entry) => {
    const result = operationSchema.safeParse(entry);
    if (!result.success || result.data.metadata.folder_id !== folderId) return [];
    return [result.data];
  }).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export async function findDeletionOperation(folderId: string, environment: NodeJS.ProcessEnv, readCommand: OutputReader, attempt?: ProjectDeletion): Promise<DeletionOperation | undefined> {
  const candidates = (await listDeletionOperations(folderId, environment, readCommand)).filter((operation) => {
    if (!attempt) return !operation.done;
    return !attempt.previous_operation_ids?.includes(operation.id)
      && Date.parse(operation.created_at) >= Date.parse(attempt.requested_at);
  });
  if (candidates.length > 1) throw new Error("Multiple YC deletion operations match. Use vibecloud delete --status --operation <id> to select the exact request; no deletion was submitted.");
  return candidates[0];
}

export function operationReceipt(operation: DeletionOperation, previous?: ProjectDeletion, folderStatus?: string): ProjectDeletion {
  const cancelled = operation.metadata.cancelled_at !== undefined || operation.error?.code === 1;
  return {
    requested_at: previous?.requested_at ?? operation.created_at,
    ...(previous?.requested_delay === undefined ? {} : { requested_delay: previous.requested_delay }),
    ...(previous?.previous_operation_ids === undefined ? {} : { previous_operation_ids: previous.previous_operation_ids }),
    operation_id: operation.id,
    ...(operation.metadata.delete_after === undefined ? {} : { delete_after: operation.metadata.delete_after }),
    status: operation.done
      ? cancelled ? "cancelled" : operation.error ? "failed" : "deleted"
      : folderStatus === "DELETING" ? "deleting" : "pending",
    ...(operation.error ? { error: operation.error.message ?? `YC operation failed (${operation.error.code})` } : {}),
  };
}
