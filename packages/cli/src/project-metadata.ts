import { writeJsonAtomic } from "./files.ts";
import { withProjectLock } from "./project-lock.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PROJECT_METADATA_SCHEMA_VERSION = 2;
export const PROJECT_SCAFFOLD_VERSION = 2;
export const PROJECT_METADATA_RELATIVE_PATH = join(".vibecloud", "project.json");

export const projectPhases = ["scaffolded", "folder_created", "ready"] as const;
export type ProjectPhase = typeof projectPhases[number];

export const deletionSchema = z.strictObject({
  requested_at: z.iso.datetime({ offset: true }),
  requested_delay: z.string().optional(),
  operation_id: z.string().min(1).optional(),
  previous_operation_ids: z.array(z.string().min(1)).optional(),
  delete_after: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(["submitting", "pending", "deleting", "deleted", "cancelled", "failed", "rejected"]),
  error: z.string().optional(),
});
export type ProjectDeletion = z.infer<typeof deletionSchema>;

const projectMetadataSchema = z.strictObject({
  schema_version: z.literal(PROJECT_METADATA_SCHEMA_VERSION),
  scaffold_version: z.literal(PROJECT_SCAFFOLD_VERSION),
  project_id: z.string().uuid(),
  yc_folder_id: z.string().min(1).nullable(),
  yc_folder_lifecycle: z.enum(["managed", "external"]),
  phase: z.enum(projectPhases),
  deletion: deletionSchema.optional(),
}).superRefine((metadata, context) => {
  if (metadata.phase !== "scaffolded" && metadata.yc_folder_id === null) {
    context.addIssue({ code: "custom", path: ["yc_folder_id"], message: `is required in phase ${metadata.phase}` });
  }
});

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export function newProjectMetadata(lifecycle: ProjectMetadata["yc_folder_lifecycle"], folderId: string | null): ProjectMetadata {
  return {
    schema_version: PROJECT_METADATA_SCHEMA_VERSION,
    scaffold_version: PROJECT_SCAFFOLD_VERSION,
    project_id: randomUUID(),
    yc_folder_id: folderId,
    yc_folder_lifecycle: lifecycle,
    phase: "scaffolded",
  };
}

export async function readProjectMetadata(rootDirectory: string): Promise<ProjectMetadata | undefined> {
  const path = join(rootDirectory, PROJECT_METADATA_RELATIVE_PATH);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return projectMetadataSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`${path}: invalid Vibecloud project metadata`, { cause: error });
  }
}

export async function writeProjectMetadata(rootDirectory: string, metadata: ProjectMetadata): Promise<string> {
  return withProjectLock(rootDirectory, async () => {
    const path = join(rootDirectory, PROJECT_METADATA_RELATIVE_PATH);
    await writeJsonAtomic(path, projectMetadataSchema.parse(metadata));
    return path;
  });
}
