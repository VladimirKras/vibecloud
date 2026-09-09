import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ydbjs/drizzle-adapter/migrator";
import { immutableYdbMigrations, migrateYdbFolder, readYdbMigrationsFolder } from "../dist/migrator.js";
import { withYdb } from "../dist/index.js";

const endpoint = process.argv[2];
const url = new URL(endpoint);
assert.ok(url.protocol === "grpc:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Use an isolated local YDB test database");
process.env.YDB_ANONYMOUS_CREDENTIALS = "1";
process.env.VIBECLOUD_YDB_DISCOVERY = "0";
const folder = await mkdtemp(join(tmpdir(), "vibecloud-migration-acceptance-"));
const id = Date.now();
const name = `${id}_initial.sql`;
try {
  const file = join(folder, name);
  const original = `CREATE TABLE audit_${id} (id Utf8 NOT NULL, PRIMARY KEY (id));`;
  const other = `CREATE TABLE audit_other_${id} (id Utf8 NOT NULL, PRIMARY KEY (id));`;
  await writeFile(file, original);
  await writeFile(join(folder, `${id + 1}_second.sql`), other);
  // Seed history with the old adapter to prove upgrading does not replay applied DDL.
  await withYdb(endpoint, (db) => readYdbMigrationsFolder(folder).then((migrations) => migrate(db, { migrations, migrationLock: { key: "vibecloud" } })));
  await migrateYdbFolder(endpoint, folder);
  await writeFile(file, `CREATE TABLE audit_forbidden_${id} (id Utf8 NOT NULL, PRIMARY KEY (id));`);
  await assert.rejects(() => migrateYdbFolder(endpoint, folder), /immutable/);
  await assert.rejects(() => withYdb(endpoint, (db) => db.execute(sql.raw(`SELECT * FROM audit_forbidden_${id};`))));
  await writeFile(file, original);
  await migrateYdbFolder(endpoint, folder);
  await writeFile(file, other);
  await assert.rejects(() => migrateYdbFolder(endpoint, folder), /identical SQL/);
  await writeFile(file, original);
  const interruptedFile = join(folder, `${id + 2}_interrupted.sql`);
  const interrupted = `CREATE TABLE audit_interrupted_${id} (id Utf8 NOT NULL, PRIMARY KEY (id));`;
  await writeFile(interruptedFile, interrupted);
  // Stop immediately after the validation checkpoint, before authored SQL.
  await withYdb(endpoint, async (db) => migrate(db, {
    migrations: immutableYdbMigrations(await readYdbMigrationsFolder(folder)).slice(0, 1),
    migrationLock: { key: "vibecloud" },
  }));
  await writeFile(interruptedFile, `CREATE TABLE audit_replacement_${id} (id Utf8 NOT NULL, PRIMARY KEY (id));`);
  await migrateYdbFolder(endpoint, folder);
  await migrateYdbFolder(endpoint, folder);
  await writeFile(interruptedFile, interrupted);
  await assert.rejects(() => migrateYdbFolder(endpoint, folder), /immutable/);
  await assert.rejects(() => migrateYdbFolder(endpoint, folder), /immutable/);
  await assert.rejects(() => withYdb(endpoint, (db) => db.execute(sql.raw(`SELECT * FROM audit_interrupted_${id};`))));
  console.log("Local YDB migration acceptance passed: legacy history preserved; changed SQL rejected, including repeated retries after an interrupted checkpoint.");
} finally {
  await rm(folder, { recursive: true, force: true });
}
