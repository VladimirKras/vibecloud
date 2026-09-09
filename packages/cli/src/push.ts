import { atomicWrite, writeJsonAtomic } from "./files.ts";
import { reconcileTerraformMoves } from "./terraform-moves.ts";
import { writeTerraformInputs } from "./terraform-inputs.ts";
import { assertCloudFolderActive, withCloudOperation } from "./project-operation.ts";
import { terraform } from "./terraform.ts";
import { fileURLToPath } from "node:url";
import { loadProjectMigrator } from "./project-migrator.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildProject } from "./build.ts";
import { type LoadedConfig } from "./config.ts";
import { readCommandOutput, spawnCommand, type CommandRunner, type OutputReader } from "./commands.ts";
import { terraformEnvironmentFor } from "./terraform-environment.ts";
import { randomBytes } from "node:crypto";
import { readLivePublication, retainedAssets, nextRelease, hasLegacyInvokers } from "./publication.ts";

type MigrationRunner = (
  projectRoot: string,
  connectionString: string,
  migrationsFolder: string,
  accessToken: string | undefined,
  options?: { recovery?: "retry" },
) => Promise<void>;

interface PushOptions {
  environment?: NodeJS.ProcessEnv
  runCommand?: CommandRunner
  readCommand?: OutputReader
  runBuildCommand?: CommandRunner
  runMigration?: MigrationRunner
  migrationRecovery?: "retry"
}

async function pushProjectUnlocked(loaded: LoadedConfig, {
  environment = process.env,
  runCommand = spawnCommand,
  readCommand = readCommandOutput,
  runBuildCommand,
}: PushOptions = {}) {
  const packages = join(loaded.infraDirectory, ".packages");
  await mkdir(packages, { recursive: true });
  const deployment = await mkdtemp(join(packages, "deployment-"));
  const artifacts = join(deployment, "dist");
  const releaseId = `r-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const configPath = await writeTerraformInputs(loaded, { directory: deployment, artifactDirectory: artifacts, releaseId });
  const built = await buildProject({ ...loaded, configPath }, { runCommand: runBuildCommand, environment, outputDirectory: artifacts });
  const tf = await terraform(loaded, { environment, readCommand, runCommand });
  await assertCloudFolderActive(loaded, tf.environment, readCommand);
  await tf.init();
  const state = await tf.state();
  const movesPath = join(loaded.infraDirectory, "moves.auto.tf");
  const originalMoves = await readFile(movesPath, "utf8");
  const moves = await reconcileTerraformMoves(loaded.infraDirectory, originalMoves, [], loaded.config, readCommand, tf.environment);
  if (moves !== originalMoves) await atomicWrite(movesPath, moves, originalMoves);
  if (state.resources?.length || /\bmoved\s*\{/.test(moves)) await tf.refresh(configPath);
  const selected = JSON.parse(await readFile(configPath, "utf8"));

  const planPath = join(deployment, "publication.tfplan");
  for (let attempt = 0; ; attempt++) {
    const state = await tf.state();
    const live = await readLivePublication(state, tf.environment, readCommand);
    const manifest = join(deployment, "legacy-publication.json");
    if (hasLegacyInvokers(live)) await writeJsonAtomic(manifest, live);
    await writeJsonAtomic(configPath, {
      ...selected,
      retained_assets: retainedAssets(live, loaded.config, true),
      publication_record: nextRelease(live, releaseId),
      cloud_action: {
        interpreter: [process.execPath, fileURLToPath(new URL("../dist/cloud-action.js", import.meta.url))],
        project: loaded.rootDirectory,
        legacy_manifest: hasLegacyInvokers(live) ? manifest : null,
      },
    });
    await tf.plan(configPath, planPath);
    // Input artifact history and the native saved plan must describe the same snapshot.
    if (JSON.stringify(await tf.state()) === JSON.stringify(state)) break;
    if (attempt >= 2) throw new Error("Deployment state kept changing. Retry pnpm push after the other deployment finishes.");
  }
  // Database migrations and one-time pins execute as dependencies inside this apply.
  // Terraform alone schedules resources, locks state and rejects stale plans.
  try {
    await tf.apply(planPath);
  } catch (cause) {
    throw new Error(`Publication ${releaseId} did not complete: ${cause instanceof Error ? cause.message : String(cause)}. Terraform retains partial progress; inspect the error and retry pnpm push. Database migrations are not rolled back.`, { cause });
  }
  await writeJsonAtomic(join(packages, "current-deployment.json"), { inputs: configPath, artifacts, releaseId });
  const [url, monitoringDashboardUrl] = await Promise.all([
    tf.output("url").then((value) => value.trim()),
    tf.output("monitoring_dashboard_url").then((value) => value.trim()),
  ]);
  await pruneDeploymentBuilds(packages, deployment).catch((error) => console.warn("Could not prune old deployment artifacts:", error));
  return {
    built,
    artifacts,
    directory: loaded.infraDirectory,
    path: join(loaded.infraDirectory, "main.tf"),
    url,
    monitoringDashboardUrl,
  };
}

async function migrateProjectDatabasesUnlocked(loaded: LoadedConfig, {
  environment = process.env,
  readCommand = readCommandOutput,
  runMigration = runProjectMigration,
  migrationRecovery,
}: Pick<PushOptions, "environment" | "readCommand" | "runMigration" | "migrationRecovery"> = {}): Promise<string[]> {
  const terraformEnvironment = await terraformEnvironmentFor(loaded, environment, readCommand);
  await assertCloudFolderActive(loaded, terraformEnvironment, readCommand);
  return runMigrations(loaded, terraformEnvironment, readCommand, runMigration, join(loaded.rootDirectory, "src"), migrationRecovery);
}

export async function migrateProjectDatabases(loaded: LoadedConfig, options: Pick<PushOptions, "environment" | "readCommand" | "runMigration" | "migrationRecovery"> = {}): Promise<string[]> {
  return withCloudOperation(loaded, "migrate", (current) => migrateProjectDatabasesUnlocked(current, options));
}

async function runMigrations(
  loaded: LoadedConfig,
  environment: NodeJS.ProcessEnv,
  readCommand: OutputReader,
  runMigration: MigrationRunner,
  sourceDirectory: string,
  recovery?: "retry",
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
      join(sourceDirectory, "databases", database, "migrations"),
      token,
      ...(recovery ? [{ recovery }] : []),
    );
  }
  return migrations;
}

async function runProjectMigration(
  projectRoot: string,
  connectionString: string,
  migrationsFolder: string,
  accessToken: string | undefined,
  options: { recovery?: "retry" } = {},
): Promise<void> {
  const module = await loadProjectMigrator(projectRoot);
  await module.migrateYdbFolder(connectionString, migrationsFolder, { accessToken, ...options });
}

export async function pushProject(loaded: LoadedConfig, options: PushOptions = {}) {
  return withCloudOperation(loaded, "publish", (current) => pushProjectUnlocked(current, options));
}

/** Only prune prior CLI-owned builds after a successful activation. */
async function pruneDeploymentBuilds(packages: string, current: string): Promise<void> {
  const candidates = await Promise.all((await readdir(packages, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("deployment-") && join(packages, entry.name) !== current)
    .map(async (entry) => {
      const path = join(packages, entry.name);
      try {
        return { path, modified: (await stat(join(path, "selected.tfvars.json"))).mtimeMs };
      } catch {
        return undefined;
      }
    }));
  for (const entry of candidates.filter((entry) => entry !== undefined).sort((a, b) => b.modified - a.modified).slice(2)) {
    await rm(entry.path, { recursive: true, force: true });
  }
}
