import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { migrate } from "@ydbjs/drizzle-adapter/migrator";
import type { YdbInlineMigration } from "@ydbjs/drizzle-adapter/migrator";
import { withYdb, type WithYdbOptions } from "./index.js";

const breakpoint = "--> statement-breakpoint";
const migrationName = /^(\d+)[_-][A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

/** Applies ordered SQL files using YDB Drizzle history and distributed locking. */
export async function migrateYdbFolder(
  connectionString: string,
  migrationsFolder: string,
  options: WithYdbOptions = {},
): Promise<void> {
  const migrations = await readYdbMigrationsFolder(migrationsFolder);
  if (!migrations.length) return;

  await withYdb(connectionString, (db) => migrate(db, {
    migrations,
    migrationLock: { key: "vibecloud" },
  }), options);
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
