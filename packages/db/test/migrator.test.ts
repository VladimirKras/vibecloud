import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readYdbMigrationsFolder } from "../dist/migrator.js";

test("loads ordered YDB Drizzle SQL migrations and statement breakpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibecloud-migrations-"));
  await writeFile(join(directory, "002_second.sql"), "ALTER TABLE `todos` ADD COLUMN `done` Bool;\n");
  await writeFile(join(directory, "001_first.sql"), [
    "CREATE TABLE `todos` (`id` Utf8 NOT NULL, PRIMARY KEY (`id`));",
    "--> statement-breakpoint",
    "CREATE INDEX `by_id` GLOBAL ON `todos` (`id`);",
  ].join("\n"));

  const migrations = await readYdbMigrationsFolder(directory);
  assert.deepEqual(migrations.map(({ name, folderMillis }) => ({ name, folderMillis })), [
    { name: "001_first", folderMillis: 1 },
    { name: "002_second", folderMillis: 2 },
  ]);
  assert.equal(migrations[0].sql?.length, 2);
});

test("rejects ambiguous names, duplicate ordering, and legacy Goose directives", async () => {
  const invalid = await mkdtemp(join(tmpdir(), "vibecloud-migrations-invalid-"));
  await writeFile(join(invalid, "create.sql"), "SELECT 1;");
  await assert.rejects(() => readYdbMigrationsFolder(invalid), /must be named/);

  const duplicate = await mkdtemp(join(tmpdir(), "vibecloud-migrations-duplicate-"));
  await writeFile(join(duplicate, "001_first.sql"), "SELECT 1;");
  await writeFile(join(duplicate, "001_second.sql"), "SELECT 2;");
  await assert.rejects(() => readYdbMigrationsFolder(duplicate), /order is duplicated/);

  const goose = await mkdtemp(join(tmpdir(), "vibecloud-migrations-goose-"));
  await writeFile(join(goose, "001_legacy.sql"), "-- +goose Up\nSELECT 1;");
  await assert.rejects(() => readYdbMigrationsFolder(goose), /Goose directives are not supported/);
});

test("every migration attempt validates identities after interruption and prunes old checkpoints", async () => {
  const { migrate } = await import("@ydbjs/drizzle-adapter/migrator");
  const { immutableYdbMigrations } = await import("../dist/migrator.js");
  const history = new Map<string, unknown[]>();
  const executed: string[] = [];
  let prepared: ReturnType<typeof immutableYdbMigrations> = [];
  let interrupt = true;
  let guards = 0;
  const statementText = (query: { queryChunks: unknown[] }): string => query.queryChunks.map((chunk) => (chunk as { value: string[] }).value.join("")).join("");
  const session = {
    async values(query: { queryChunks: unknown[] }) {
      return statementText(query).includes("ORDER BY") ? [...history.values()] : [];
    },
    async execute(query: { queryChunks: unknown[] }) {
      const text = statementText(query);
      if (text.startsWith("UPSERT INTO `__drizzle_migrations`")) {
        const values = text.slice(text.indexOf("VALUES (") + 8, -1).match(/'(?:[^']|'')*'|NULL|-?\d+/g)!
          .map((value) => value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value === "NULL" ? null : Number(value));
        if (interrupt && values[1] !== -1) {
          interrupt = false;
          throw new Error("interrupted before authored migration starts");
        }
        history.set(String(values[0]), values);
      } else if (text.startsWith("DELETE FROM __drizzle_migrations")) {
        for (const [hash, row] of history) if (row[1] === -1 && hash !== prepared[0].hash) history.delete(hash);
      } else if (text.startsWith("SELECT Ensure(")) {
        guards += 1;
        const conflict = prepared.slice(1).some((migration) => [...history.values()].some((row) =>
          (row[2] === migration.name || row[1] === migration.folderMillis)
          && (row[0] !== migration.hash || row[2] !== migration.name || row[1] !== migration.folderMillis)));
        if (conflict) throw new Error("Applied YDB migration is immutable");
      } else if (!text.startsWith("CREATE TABLE")) executed.push(text);
    },
  };
  const run = async (sql: string) => {
    prepared = immutableYdbMigrations([{ name: "001_initial", folderMillis: 1, sql: [sql] }]);
    // The real adapter owns history/skip ordering; this sequential fake SQL
    // session omits only the distributed lock and actual database execution.
    await migrate({ _: { session } } as unknown as Parameters<typeof migrate>[0], { migrations: prepared, migrationLock: false });
  };
  await assert.rejects(() => run("SELECT 111;"), /interrupted/);
  await run("SELECT 222;");
  await assert.rejects(() => run("SELECT 111;"), /immutable/);
  await assert.rejects(() => run("SELECT 111;"), /immutable/);
  await run("SELECT 222;");
  assert.deepEqual(executed, ["SELECT 222;"]);
  assert.equal(guards, 5);
  assert.equal([...history.values()].filter((row) => row[1] === -1).length, 1);
});
