import type { LoadedConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, terraformEnvironmentFor, yandexEnvironmentFor } from "./push.ts";

type CommandRunner = (
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => Promise<void>;
type OutputReader = (
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => Promise<string>;

interface DeleteProjectOptions {
  confirmation?: string
  environment?: NodeJS.ProcessEnv
  runCommand?: CommandRunner
  readCommand?: OutputReader
}

export function projectDeletionConfirmation(loaded: LoadedConfig) {
  return `delete:${loaded.config.name}`;
}

export async function deleteProject(loaded: LoadedConfig, {
  confirmation,
  environment = process.env,
  runCommand = spawnCommand,
  readCommand = readCommandOutput,
}: DeleteProjectOptions = {}) {
  const expected = projectDeletionConfirmation(loaded);
  if (confirmation !== expected) throw new Error(`full project deletion requires --confirm ${expected}`);
  const lifecycle = loaded.projectMetadata?.yc_folder_lifecycle
    ?? (loaded.config.folder_id ? "external" : "managed");

  if (lifecycle === "managed") {
    const yandexEnvironment = await yandexEnvironmentFor(environment, readCommand, { requireFolderId: false });
    const folderId = loaded.projectMetadata?.yc_folder_id
      ?? (await readCommand("terraform", [
        `-chdir=${loaded.infraDirectory}`,
        "output",
        "-raw",
        "project_id",
      ], yandexEnvironment)).trim();
    if (!folderId) throw new Error("Vibecloud project metadata does not contain a managed YC folder ID");
    await runCommand("yc", [
      "resource-manager",
      "folder",
      "delete",
      "--id",
      folderId,
      "--async",
    ], yandexEnvironment);
    return { confirmation: expected, destroyed: false, folderDeletionSubmitted: true, folderId };
  }

  const terraformEnvironment = await terraformEnvironmentFor(loaded, environment, readCommand);
  await runCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "destroy",
    "-auto-approve",
    "-input=false",
  ], terraformEnvironment);

  const folderId = loaded.projectMetadata?.yc_folder_id ?? loaded.config.folder_id;
  return { confirmation: expected, destroyed: true, folderDeletionSubmitted: false, folderId };
}
