import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import type { OutputReader } from "./commands.ts";
import { yandexDeployerSubjectFor, yandexEnvironmentFor } from "./yandex-environment.ts";

export async function terraformEnvironmentFor(
  loaded: LoadedConfig,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<NodeJS.ProcessEnv> {
  const folderId = loaded.projectMetadata?.yc_folder_id ?? loaded.config.folder_id;
  if (!folderId) {
    throw new Error("Vibecloud project does not contain a YC folder ID; run vibecloud init to initialize project metadata");
  }
  const yandexEnvironment = await yandexEnvironmentFor(environment, readCommand);
  const deployerSubject = await yandexDeployerSubjectFor(yandexEnvironment, readCommand);
  return {
    ...yandexEnvironment,
    YC_FOLDER_ID: folderId,
    TF_VAR_deployer_subject: deployerSubject,
    TF_CLI_CONFIG_FILE: join(loaded.infraDirectory, "terraform.rc"),
    TF_IN_AUTOMATION: environment.TF_IN_AUTOMATION ?? "true",
    TF_INPUT: "0",
  };
}
