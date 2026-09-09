import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { migrate } from "@ydbjs/drizzle-adapter/migrator";
import type { YdbInlineMigration } from "@ydbjs/drizzle-adapter/migrator";
import { withYdb, type WithYdbOptions } from "./index.js";

const breakpoint = "--> statement-breakpoint";
const migrationName = /^(\d+)[_-][A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

export interface MigrationOptions extends WithYdbOptions {
  /** Replays failed or stale migrations from the beginning; inspect partial effects first. */
  recovery?: "retry"
}

/** Applies ordered SQL files using YDB Drizzle history and distributed locking. */
export async function migrateYdbFolder(
  connectionString: string,
  migrationsFolder: string,
  options: MigrationOptions = {},
): Promise<void> {
  const migrations = await readYdbMigrationsFolder(migrationsFolder);
  if (!migrations.length) return;

  const config = ydbMigrationConfig(migrations, options);
  await withYdb(connectionString, (db) => migrate(db, config), options);
}

/** Keeps the same locking and immutable-history checks for explicit recovery. */
export function ydbMigrationConfig(migrations: readonly YdbInlineMigration[], options: Pick<MigrationOptions, "recovery"> = {}) {
  return {
    migrations: immutableYdbMigrations(migrations),
    migrationLock: { key: "vibecloud" },
    ...(options.recovery === "retry" ? { migrationRecovery: { mode: "retry" as const } } : {}),
  };
}

export async function readYdbMigrationsFolder(migrationsFolder: string): Promise<YdbInlineMigration[]> {
  const entries = await readdir(migrationsFolder, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!files.length) return [];

  const order = new Set<number>();
  return Promise.all(files.map(async (file) => {
    const match = migrationName.exec(file);
    if (!match) {
      throw new Error(`YDB migration must be named <number>_<name>.sql: ${file}`);
    }
    const folderMillis = Number(match[1]);
    if (!Number.isSafeInteger(folderMillis)) throw new Error(`YDB migration order is not a safe integer: ${file}`);
    if (order.has(folderMillis)) throw new Error(`YDB migration order is duplicated: ${match[1]}`);
    order.add(folderMillis);
    const source = await readFile(join(migrationsFolder, file), "utf8");
    if (/^--\s*\+goose\s+(?:up|down|statementbegin|statementend)/imu.test(source)) {
      throw new Error(`Goose directives are not supported by YDB Drizzle migrations: ${file}`);
    }
    const sql = source.split(breakpoint).map((statement) => statement.trim()).filter(Boolean);
    if (!sql.length) throw new Error(`YDB migration is empty: ${file}`);
    return { name: basename(file, ".sql"), folderMillis, sql };
  }));
}

/**
 * The adapter skips migrations by SQL hash, so validation must run before that
 * decision, including when an edited file now matches another applied hash.
 * A fresh validation checkpoint runs under its distributed lock on every attempt.
 * Checkpoints use the reserved negative order and replace previous checkpoints;
 * authored migration hashes retain compatibility with existing adapter history.
 */
export function immutableYdbMigrations(migrations: readonly YdbInlineMigration[]): YdbInlineMigration[] {
  if (!migrations.length) return [];
  const hashes = new Map<string, string>();
  const identities = new Set<string>();
  const orders = new Set<number>();
  const prepared = migrations.map((migration) => {
    const statements = migration.sql;
    if (!statements?.length || !migration.name || !Number.isSafeInteger(migration.folderMillis) || migration.folderMillis! < 0) {
      throw new Error("Immutable migrations require a name, nonnegative safe integer order and SQL statements");
    }
    const hash = createHash("sha256").update(statements.join("\n--> statement-breakpoint\n")).digest("hex");
    if (hashes.has(hash)) throw new Error(`Migrations ${hashes.get(hash)} and ${migration.name} contain identical SQL; the adapter cannot track them as separate migrations`);
    if (identities.has(migration.name) || orders.has(migration.folderMillis!)) throw new Error(`Duplicate migration identity or order: ${migration.name}`);
    hashes.set(hash, migration.name);
    identities.add(migration.name);
    orders.add(migration.folderMillis!);
    return { ...migration, hash };
  }).sort((left, right) => left.folderMillis! - right.folderMillis!);
  const checkpointHash = `vibecloud-validation-${randomUUID()}`;
  const conflicts = prepared.map(({ name, folderMillis, hash }) =>
    `((name = ${JSON.stringify(name)} OR created_at = ${folderMillis} OR hash = "${hash}") AND (hash != "${hash}" OR name != ${JSON.stringify(name)} OR created_at != ${folderMillis}))`);
  // https://ydb.tech/docs/en/yql/reference/builtins/basic#ensure
  const guard = `SELECT Ensure(COUNT(*), COUNT(*) = 0, "Applied YDB migration is immutable") FROM __drizzle_migrations WHERE ${conflicts.join(" OR ")};`;
  return [{
    name: "__vibecloud_validation",
    folderMillis: -1,
    hash: checkpointHash,
    sql: [
      // Negative orders are reserved for Vibecloud checkpoints, including legacy ones.
      `DELETE FROM __drizzle_migrations WHERE created_at = -1 AND hash != "${checkpointHash}";`,
      guard,
    ],
  }, ...prepared];
}
