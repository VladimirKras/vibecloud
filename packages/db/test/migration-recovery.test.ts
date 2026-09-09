import assert from "node:assert/strict";
import test from "node:test";
import { migrate } from "@ydbjs/drizzle-adapter/migrator";
import { immutableYdbMigrations, ydbMigrationConfig } from "../dist/migrator.js";

const migration = (name = "001_initial", order = 1, sql = ["SELECT 111;", "SELECT 222;"]) => ({ name, folderMillis: order, sql });

test("identical SQL with distinct identities is rejected before opening a database", () => {
  assert.throws(() => ydbMigrationConfig([migration(), migration("002_repeat", 2)]), /001_initial and 002_repeat contain identical SQL/);
});

test("identical SQL cannot silently adopt the identity of an omitted applied migration", async () => {
  const runner = database();
  await runner.run([migration()]);
  await assert.rejects(runner.run([migration("002_repeat", 2)]), /immutable/);
  assert.deepEqual(runner.executed, ["SELECT 111;", "SELECT 222;"]);
});

test("explicit recovery retries failed migrations from the beginning and retains identity checks", async () => {
  for (const failingStatement of ["SELECT 111;", "SELECT 222;"]) {
    const runner = database();
    runner.failOn = failingStatement;
    await assert.rejects(runner.run([migration()]), /backend unavailable/);
    const before = [...runner.executed];
    runner.failOn = undefined;
    await assert.rejects(runner.run([migration()]), /marked as failed/);
    assert.deepEqual(runner.executed, before);
    await assert.rejects(runner.run([migration("001_initial", 1, ["SELECT 333;"])], "retry"), /immutable/);
    await runner.run([migration()], "retry");
    assert.deepEqual(runner.executed, [...before, "SELECT 111;", "SELECT 222;"]);
    await runner.run([migration()]);
    assert.deepEqual(runner.executed, [...before, "SELECT 111;", "SELECT 222;"]);
  }
});

test("recovery refuses active runs and requires opt-in for stale running history", async () => {
  const runner = database();
  const [prepared] = immutableYdbMigrations([migration()]).slice(1);
  runner.history.set(prepared.hash!, [prepared.hash, 1, prepared.name, "running", Date.now(), null, null, "old-owner", 2, 0]);
  await assert.rejects(runner.run([migration()], "retry"), /still marked as running/);
  runner.history.get(prepared.hash!)![4] = Date.now() - 2 * 60 * 60 * 1000;
  await assert.rejects(runner.run([migration()]), /still marked as running/);
  await runner.run([migration()], "retry");
  assert.deepEqual(runner.executed, ["SELECT 111;", "SELECT 222;"]);
});

function database() {
  const history = new Map<string, unknown[]>();
  const executed: string[] = [];
  let prepared: ReturnType<typeof immutableYdbMigrations> = [];
  const statementText = (query: { queryChunks: unknown[] }): string => query.queryChunks.map((chunk) => (chunk as { value: string[] }).value.join("")).join("");
  const session = {
    async values(query: { queryChunks: unknown[] }) { return statementText(query).includes("ORDER BY") ? [...history.values()] : []; },
    async execute(query: { queryChunks: unknown[] }) {
      const text = statementText(query);
      if (text.startsWith("UPSERT INTO `__drizzle_migrations`")) {
        const values = text.slice(text.indexOf("VALUES (") + 8, -1).match(/'(?:[^']|'')*'|NULL|-?\d+/g)!
          .map((value) => value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value === "NULL" ? null : Number(value));
        history.set(String(values[0]), values);
      } else if (text.startsWith("DELETE FROM __drizzle_migrations")) {
        for (const [hash, row] of history) if (row[1] === -1 && hash !== prepared[0].hash) history.delete(hash);
      } else if (text.startsWith("SELECT Ensure(")) {
        // Emulate only the SQL guard. The real adapter controls history,
        // skip/retry decisions and per-statement progress writes below.
        for (const migration of prepared.slice(1)) {
          assert.ok(text.includes(`OR hash = "${migration.hash}"`));
          if ([...history.values()].some((row) => (row[2] === migration.name || row[1] === migration.folderMillis || row[0] === migration.hash)
            && (row[0] !== migration.hash || row[2] !== migration.name || row[1] !== migration.folderMillis))) throw new Error("Applied YDB migration is immutable");
        }
      } else if (!text.startsWith("CREATE TABLE")) {
        if (runner.failOn === text) throw new Error("backend unavailable before statement execution");
        executed.push(text);
      }
    },
  };
  const runner = {
    history, executed, failOn: undefined as string | undefined,
    async run(migrations: ReturnType<typeof migration>[], recovery?: "retry") {
      const config = ydbMigrationConfig(migrations, { recovery });
      assert.deepEqual(config.migrationLock, { key: "vibecloud" });
      prepared = config.migrations;
      await migrate({ _: { session } } as unknown as Parameters<typeof migrate>[0], { ...config, migrationLock: false });
    },
  };
  return runner;
}
