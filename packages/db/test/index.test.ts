import assert from "node:assert/strict";
import type { YdbDrizzleDatabase } from "../dist/index.js";
import test from "node:test";
import {
  getYdb,
  getYdbQueryClient,
  queryClientForYdb,
  runWithYdb,
  tryGetYdb,
  tryGetYdbQueryClient,
} from "../dist/index.js";

test("requires an invocation scope", () => {
  assert.equal(tryGetYdb(), undefined);
  assert.equal(tryGetYdbQueryClient(), undefined);
  assert.throws(() => getYdb(), /runWithYdb/);
  assert.throws(() => getYdbQueryClient(), /withYdb/);
  assert.throws(() => queryClientForYdb({ $client: {} } as unknown as YdbDrizzleDatabase), /official YdbDriver/);
});

test("binds synchronous and asynchronous work to its Drizzle database", async () => {
  const first = databaseStub("first");
  const second = databaseStub("second");

  assert.equal(runWithYdb(first, getYdb), first);
  const databases = await Promise.all([
    runWithYdb(first, async () => {
      await Promise.resolve();
      return getYdb();
    }),
    runWithYdb(second, async () => {
      await Promise.resolve();
      return getYdb();
    }),
  ]);
  assert.deepEqual(databases, [first, second]);
  assert.equal(tryGetYdb(), undefined);
});

test("nested scopes restore their parent database", () => {
  const outer = databaseStub("outer");
  const inner = databaseStub("inner");

  runWithYdb(outer, () => {
    assert.equal(getYdb(), outer);
    runWithYdb(inner, () => assert.equal(getYdb(), inner));
    assert.equal(getYdb(), outer);
  });
});

test("exposes nested database error messages without discarding the cause chain", async () => {
  const ydb = new Error("BAD_REQUEST: column type mismatch");
  const transaction = new Error("Transaction failed.", { cause: ydb });

  assert.throws(
    () => runWithYdb(databaseStub(), () => { throw transaction; }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Transaction failed.\nCaused by: BAD_REQUEST: column type mismatch");
      assert.equal(error.cause, transaction);
      return true;
    },
  );
  await assert.rejects(
    runWithYdb(databaseStub(), async () => { throw transaction; }),
    /Transaction failed\.\nCaused by: BAD_REQUEST: column type mismatch/,
  );
});

test("leaves errors without causes unchanged", () => {
  const error = new Error("application failure");
  assert.throws(() => runWithYdb(databaseStub(), () => {
    throw error;
  }), (caught) => caught === error);
});

function databaseStub(name = "stub"): YdbDrizzleDatabase {
  // Invocation-scoping tests need identity only; no database methods are called.
  return { name } as unknown as YdbDrizzleDatabase;
}
