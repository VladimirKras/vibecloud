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
