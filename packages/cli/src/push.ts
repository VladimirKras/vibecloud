import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildProject, type BuildCommandRunner } from "./build.ts";
import type { LoadedConfig } from "./config.ts";

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
type MigrationRunner = (
  projectRoot: string,
  connectionString: string,
  migrationsFolder: string,
  accessToken: string | undefined,
) => Promise<void>;

interface PushOptions {
  environment?: NodeJS.ProcessEnv
  runCommand?: CommandRunner
  readCommand?: OutputReader
  retryDelayMs?: number
  runBuildCommand?: BuildCommandRunner
  runMigration?: MigrationRunner
}

const YC_INSTALL_URL = "https://yandex.cloud/en/docs/cli/quickstart#install";

export async function pushProject(loaded: LoadedConfig, {
  environment = process.env,
  runCommand = spawnCommand,
  readCommand = readCommandOutput,
  retryDelayMs = 30_000,
  runBuildCommand,
  runMigration = runProjectMigration,
}: PushOptions = {}) {
  const built = await buildProject(loaded, { runCommand: runBuildCommand });
  await mkdir(join(loaded.infraDirectory, ".packages"), { recursive: true });
  const terraformEnvironment = await terraformEnvironmentFor(loaded, environment, readCommand);

  await runCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "init",
    "-reconfigure",
    "-input=false",
    "-lockfile=readonly",
  ], terraformEnvironment);

  const hasMigrations = Object.values(loaded.config.databases ?? {})
    .some((database) => database.migrations);
  if (hasMigrations) {
    await retry(3, retryDelayMs, async () => {
      await runCommand("terraform", [
        `-chdir=${loaded.infraDirectory}`,
        "apply",
        "-auto-approve",
        "-input=false",
        "-target=yandex_ydb_database_serverless.databases",
      ], terraformEnvironment);
    });
    await runMigrations(loaded, terraformEnvironment, readCommand, runMigration, "dist");
  }

  await retry(3, retryDelayMs, async () => {
    await runCommand("terraform", [
      `-chdir=${loaded.infraDirectory}`,
      "apply",
      "-auto-approve",
      "-input=false",
    ], terraformEnvironment);
  });
  const [url, monitoringDashboardUrl] = await Promise.all([
    readTerraformOutput(loaded, "url", terraformEnvironment, readCommand),
    readTerraformOutput(loaded, "monitoring_dashboard_url", terraformEnvironment, readCommand),
  ]);
  return {
    built,
    directory: loaded.infraDirectory,
    path: join(loaded.infraDirectory, "main.tf"),
    url,
    monitoringDashboardUrl,
  };
}

export async function migrateProjectDatabases(loaded: LoadedConfig, {
  environment = process.env,
  readCommand = readCommandOutput,
  runMigration = runProjectMigration,
}: Pick<PushOptions, "environment" | "readCommand" | "runMigration"> = {}): Promise<string[]> {
  const terraformEnvironment = await terraformEnvironmentFor(loaded, environment, readCommand);
  return runMigrations(loaded, terraformEnvironment, readCommand, runMigration, "src");
}

export async function terraformEnvironmentFor(
  loaded: LoadedConfig,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<NodeJS.ProcessEnv> {
  const folderId = loaded.projectMetadata?.yc_folder_id ?? loaded.config.folder_id;
  if (!folderId) {
    throw new Error("Vibecloud project does not contain a YC folder ID; run vibecloud init to initialize project metadata");
  }
  const yandexEnvironment = await yandexEnvironmentFor(environment, readCommand, { requireFolderId: false });
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

async function yandexDeployerSubjectFor(
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<string> {
  const configured = environment.YC_SUBJECT?.trim()
    || environment.TF_VAR_deployer_subject?.trim();
  if (configured) {
    if (!/^(?:userAccount|serviceAccount|federatedUser):[A-Za-z0-9_-]+$/.test(configured)) {
      throw new Error("YC_SUBJECT must use userAccount:<id>, serviceAccount:<id>, or federatedUser:<id> format.");
    }
    return configured;
  }

  let id: string;
  try {
    id = (await readCommand("yc", ["iam", "whoami"], environment)).trim();
  } catch (cause) {
    throw deployerSubjectError(cause);
  }
  if (!id) throw deployerSubjectError();

  try {
    const serviceAccount = JSON.parse(await readCommand(
      "yc", ["iam", "service-account", "get", "--id", id, "--format", "json"], environment,
    )) as { id?: string };
    if (serviceAccount.id === id) return `serviceAccount:${id}`;
  } catch {
    // The active subject is a user; inspect it below to distinguish federated users.
  }

  try {
    const userAccount = JSON.parse(await readCommand(
      "yc", ["iam", "user-account", "get", "--id", id, "--format", "json"], environment,
    )) as { id?: string, federated_user_account?: unknown };
    if (userAccount.id !== id) throw new Error("YC returned a different user account");
    return `${userAccount.federated_user_account ? "federatedUser" : "userAccount"}:${id}`;
  } catch (cause) {
    throw deployerSubjectError(cause);
  }
}

function deployerSubjectError(cause?: unknown): Error {
  return new Error([
    "Could not identify the Yandex Cloud subject running Terraform.",
    "Authenticate with yc init, or set YC_SUBJECT to userAccount:<id>, serviceAccount:<id>, or federatedUser:<id>.",
  ].join("\n"), cause === undefined ? undefined : { cause });
}

export async function yandexEnvironmentFor(
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
  { requireFolderId = true }: { requireFolderId?: boolean } = {},
) {
  const result: NodeJS.ProcessEnv = {
    ...environment,
  };
  const requiredConfiguration = requireFolderId
    ? ["YC_TOKEN", "YC_CLOUD_ID", "YC_FOLDER_ID"]
    : ["YC_TOKEN", "YC_CLOUD_ID"];
  const missingYandexConfiguration = requiredConfiguration
    .some((name) => !result[name]?.trim());
  if (missingYandexConfiguration) {
    try {
      await readCommand("yc", ["version"], result);
    } catch (cause) {
      throw new Error([
        "Yandex Cloud CLI (yc) was not found.",
        `Install it: ${YC_INSTALL_URL}`,
        "Then authenticate with: yc init",
        "Alternatively, set YC_TOKEN to a valid IAM token.",
      ].join("\n"), { cause });
    }
  }
  if (!result.YC_TOKEN?.trim()) {
    let token: string;
    try {
      token = (await readCommand("yc", ["iam", "create-token"], result)).trim();
    } catch (cause) {
      throw new Error([
        "Could not obtain an IAM token from Yandex Cloud CLI.",
        "Authenticate with: yc init",
        "Then retry the Vibecloud command, or set YC_TOKEN to a valid IAM token.",
      ].join("\n"), { cause });
    }
    if (!token) {
      throw new Error([
        "Yandex Cloud CLI returned an empty IAM token.",
        "Authenticate again with: yc init",
        "Then retry the Vibecloud command, or set YC_TOKEN to a valid IAM token.",
      ].join("\n"));
    }
    result.YC_TOKEN = token;
  }
  if (!result.YC_CLOUD_ID?.trim()) {
    result.YC_CLOUD_ID = await readYandexProfileValue(
      "cloud-id", "YC_CLOUD_ID", "cloud ID", result, readCommand,
    );
  }
  if (requireFolderId && !result.YC_FOLDER_ID?.trim()) {
    result.YC_FOLDER_ID = await readYandexProfileValue(
      "folder-id", "YC_FOLDER_ID", "folder ID", result, readCommand,
    );
  }
  return result;
}

async function readYandexProfileValue(
  property: "cloud-id" | "folder-id",
  environmentName: "YC_CLOUD_ID" | "YC_FOLDER_ID",
  label: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
) {
  let value: string;
  try {
    value = (await readCommand("yc", ["config", "get", property], environment)).trim();
  } catch (cause) {
    throw new Error([
      `Could not obtain the active ${label} from Yandex Cloud CLI.`,
      "Configure the active profile with: yc init",
      `Then retry the Vibecloud command, or set ${environmentName}.`,
    ].join("\n"), { cause });
  }
  if (!value) {
    throw new Error([
      `Yandex Cloud CLI returned an empty ${label}.`,
      "Configure the active profile with: yc init",
      `Then retry the Vibecloud command, or set ${environmentName}.`,
    ].join("\n"));
  }
  return value;
}

async function runMigrations(
  loaded: LoadedConfig,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
  runMigration: MigrationRunner,
  sourceDirectory: "src" | "dist",
): Promise<string[]> {
  const migrations = Object.entries(loaded.config.databases ?? {})
    .filter(([, database]) => database.migrations)
    .map(([name]) => name);
  if (!migrations.length) return [];
  const source = await readCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "output",
    "-json",
    "database_connection_strings",
  ], environment);
  const connections = JSON.parse(source) as Record<string, string>;
  for (const database of migrations) {
    const connection = connections[database];
    if (!connection) throw new Error(`Terraform did not return a connection string for database ${database}`);
    const token = environment.YDB_ACCESS_TOKEN_CREDENTIALS ?? environment.YC_TOKEN;
    await runMigration(
      loaded.rootDirectory,
      connection,
      join(loaded.rootDirectory, sourceDirectory, "databases", database, "migrations"),
      token,
    );
  }
  return migrations;
}

async function readTerraformOutput(
  loaded: LoadedConfig,
  name: string,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
): Promise<string> {
  return (await readCommand("terraform", [
    `-chdir=${loaded.infraDirectory}`,
    "output",
    "-raw",
    name,
  ], environment)).trim();
}

async function runProjectMigration(
  projectRoot: string,
  connectionString: string,
  migrationsFolder: string,
  accessToken: string | undefined,
): Promise<void> {
  let modulePath: string;
  try {
    const packagePath = findPackageJSON(
      "@vibecloud/db",
      pathToFileURL(join(projectRoot, "package.json")),
    );
    if (!packagePath) throw new Error("package was not found");
    modulePath = pathToFileURL(join(dirname(packagePath), "dist", "migrator.js")).href;
  } catch (cause) {
    throw new Error("YDB migrations require @vibecloud/db. Run pnpm install and retry.", { cause });
  }
  const module = await import(modulePath) as {
    migrateYdbFolder(
      connection: string,
      folder: string,
      options?: { accessToken?: string },
    ): Promise<void>
  };
  await module.migrateYdbFolder(connectionString, migrationsFolder, { accessToken });
}

async function retry(attempts: number, delayMs: number, operation: () => Promise<void>) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`deployment apply failed; retrying in ${delayMs / 1000}s (${attempt}/${attempts})`);
      await delay(delayMs);
    }
  }
}

export function spawnCommand(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

export function readCommandOutput(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(errorOutput.trim() || `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
