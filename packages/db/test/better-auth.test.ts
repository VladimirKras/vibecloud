import assert from "node:assert/strict";
import type { QueryClient } from "@ydbjs/query";
import type { Value } from "@ydbjs/value";
import { Timestamp } from "@ydbjs/value/primitive";
import type { DBFieldAttribute } from "better-auth/db";
import test from "node:test";
import { buildAdapterMethods } from "../dist/adapter-methods.js";
import { ydbAdapter } from "../dist/better-auth.js";
import { buildSchemaDdl } from "../dist/schema.js";

const stringField: DBFieldAttribute = { type: "string", required: true };
const fields: Record<string, DBFieldAttribute> = {
  id: stringField,
  email: stringField,
  name: stringField,
  deletedAt: { type: "date", required: false },
  active: { type: "boolean", required: true },
  signInCount: { type: "number", required: true },
};
const models = new Map([
  ["user", { fields: new Set(Object.keys(fields)) }],
  ["jwks", { fields: new Set(["id"]) }],
]);

test("exports the Better Auth adapter from its optional subpath", () => {
  assert.equal(typeof ydbAdapter, "function");
});

test("resolves the invocation query client lazily and exposes top-level transactions", async () => {
  const fake = fakeQueryClient([[], [{ count: 0 }], []]);
  let resolutions = 0;
  const adapter = ydbAdapter({
    getClient() {
      resolutions += 1;
      return fake.client;
    },
    describeQuery: (statement) => statement,
  })({});

  assert.equal(resolutions, 0);
  await adapter.findOne({
    model: "user",
    where: [{ field: "id", operator: "eq", value: "one" }],
  });
  await adapter.count({ model: "user" });
  assert.equal(resolutions, 2);

  await adapter.transaction(async (transaction) => {
    await transaction.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: "transaction-user",
        name: "Transaction",
        email: "transaction@example.test",
        emailVerified: false,
        createdAt: new Date("2026-08-10T00:00:00.123Z"),
        updatedAt: new Date("2026-08-10T00:00:00.123Z"),
      },
    });
  });
  assert.equal(fake.beginCalls, 1);
  assert.equal(fake.calls.at(-1)?.transaction, true);
});

test("builds named, parameterized predicates and selects declared indexes", async () => {
  const fake = fakeQueryClient([[]]);
  const names: { name: string, attributes?: Record<string, string | number | boolean> }[] = [];
  const methods = methodsFor(fake, {
    describeQuery(statement, name, attributes) {
      names.push({ name, attributes });
      return statement;
    },
    secondaryIndexes: {
      user: [{ name: "idx_user_email", fields: ["email"] }],
    },
  });
  await methods.findMany({
    model: "user",
    where: [
      { field: "email", operator: "eq", value: "user@example.com" },
      { field: "name", operator: "contains", value: "50%_off\\today", connector: "AND" },
      { field: "deletedAt", operator: "eq", value: null, connector: "AND" },
    ],
  } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]);

  assert.match(fake.calls[0].sql, /FROM `user` VIEW `idx_user_email`/);
  assert.match(fake.calls[0].sql, /`name` LIKE \$w1 ESCAPE '\\\\'/);
  assert.match(fake.calls[0].sql, /`deletedAt` IS NULL/);
  assert.equal(fake.calls[0].params.size, 2);
  assert.deepEqual(names, [{
    name: "auth.find-many",
    attributes: { "db.collection.name": "user" },
  }]);
});

test("uses Unicode case folding and handles empty membership predicates", async () => {
  const fake = fakeQueryClient([[], [], []]);
  const methods = methodsFor(fake);
  await methods.findMany({
    model: "user",
    where: [{ field: "email", operator: "eq", value: "USER@example.com", mode: "insensitive" }],
  } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]);
  await methods.findMany({ model: "user", where: [{ field: "id", operator: "in", value: [] }] } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]);
  await methods.findMany({ model: "user", where: [{ field: "id", operator: "not_in", value: [] }] } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]);
  assert.match(fake.calls[0].sql, /Unicode::ToLower\(`email`\) = Unicode::ToLower\(\$w0\)/);
  assert.match(fake.calls[1].sql, /WHERE FALSE$/);
  assert.match(fake.calls[2].sql, /WHERE TRUE$/);
});

test("generates Timestamp and Utf8 Better Auth schema", async () => {
  const createSchema = buildSchemaDdl("migrations/auth.yql");
  const result = await createSchema({
    tables: {
      user: {
        modelName: "user",
        fields: {
          email: { type: "string", required: true, unique: true },
          createdAt: { type: "date", required: true },
          metadata: { type: "json", required: false },
          internalId: { type: "string", fieldName: "id", required: true },
        },
      },
    },
  });

  assert.equal(result.path, "migrations/auth.yql");
  assert.match(result.code, /CREATE TABLE IF NOT EXISTS `user`/);
  assert.match(result.code, /`createdAt` Timestamp NOT NULL/);
  assert.match(result.code, /`metadata` Utf8,/);
  assert.match(result.code, /INDEX `idx_user_email` GLOBAL UNIQUE SYNC ON \(`email`\)/);
  assert.equal(result.code.match(/`id` Utf8 NOT NULL/g)?.length, 1);
});

test("keeps multi-step mutations atomic and preserves millisecond timestamps", async () => {
  const now = new Date("2026-08-10T00:00:00.123Z");
  const fake = fakeQueryClient([
    [],
    [{ count: 2 }],
    [],
    [{ id: "user-1", email: "one@example.com" }],
    [],
    [{ id: "user-1" }],
    [{ id: "user-1", signInCount: 3, active: true }],
  ]);
  const methods = methodsFor(fake);

  await methods.create({
    model: "user",
    data: { id: "user-1", email: "one@example.com", deletedAt: now },
  });
  const timestamp = fake.calls[0].params.get("v2");
  assert.ok(timestamp instanceof Timestamp);
  assert.equal(timestamp.value, 1_786_320_000_123_000n);
  assert.equal(await methods.updateMany({
    model: "user",
    where: [{ field: "id", operator: "ne", value: "missing" }],
    update: { active: true },
  } as unknown as Parameters<NonNullable<typeof methods.updateMany>>[0]), 2);
  assert.ok(methods.consumeOne);
  assert.equal((await methods.consumeOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", operator: "eq", value: "one@example.com" }],
  } as unknown as Parameters<NonNullable<typeof methods.consumeOne>>[0]))?.id, "user-1");
  assert.ok(methods.incrementOne);
  assert.equal((await methods.incrementOne<{ signInCount: number }>({
    model: "user",
    where: [{ field: "id", operator: "eq", value: "user-1" }],
    increment: { signInCount: 1 },
    set: { active: true },
  } as unknown as Parameters<NonNullable<typeof methods.incrementOne>>[0]))?.signInCount, 3);

  assert.equal(fake.calls.slice(1).every((call) => call.transaction), true);
  assert.match(fake.calls[4].sql, /^DELETE FROM `user` WHERE `id` = \$id$/);
  assert.match(fake.calls[6].sql, /`signInCount` = `signInCount` \+ \$i0/);
});

test("rejects unknown identifiers and invalid pagination before executing", async () => {
  const fake = fakeQueryClient([]);
  const methods = methodsFor(fake);
  await assert.rejects(
    () => methods.findMany({ model: "user", select: ["passwordHash"] } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]),
    /Unknown Better Auth field: user.passwordHash/,
  );
  await assert.rejects(
    () => methods.findMany({ model: "user", limit: Number.NaN } as unknown as Parameters<NonNullable<typeof methods.findMany>>[0]),
    /limit must be a non-negative number/,
  );
  await assert.rejects(
    () => methods.deleteMany({ model: "unknown", where: [] }),
    /Unknown Better Auth model: unknown/,
  );
  assert.equal(fake.calls.length, 0);
});

// These direct adapter tests deliberately omit Better Auth’s normalized defaults
// and include invalid inputs; casts at those calls preserve the runtime coverage.
function methodsFor(fake: ReturnType<typeof fakeQueryClient>, overrides: Partial<Parameters<typeof buildAdapterMethods>[0]> = {}) {
  return buildAdapterMethods({
    executor: () => fake.client,
    describeQuery: (statement) => statement,
    models,
    getFieldAttributes: ({ field }) => fields[field] ?? stringField,
    ...overrides,
  });
}

type Row = Record<string, unknown>;

interface FakeQuery extends PromiseLike<Row[][]> {
  parameter(name: string, value: Value): this
}

interface FakeExecutor {
  (sql: string): FakeQuery
  begin(optionsOrCallback: object | TransactionCallback, callback?: TransactionCallback): Promise<unknown>
  transactionId?: string
}

type TransactionCallback = (executor: FakeExecutor, signal: AbortSignal) => Promise<unknown>;

function fakeQueryClient(responses: Row[][]) {
  const calls: { sql: string, params: Map<string, Value>, transaction: boolean }[] = [];
  const state = { beginCalls: 0 };

  const makeExecutor = (transaction: boolean): FakeExecutor => {
    const executor: FakeExecutor = (sql: string) => {
      const call = { sql, params: new Map<string, Value>(), transaction };
      calls.push(call);
      const response = responses.shift() ?? [];
      const query: FakeQuery = {
        parameter(name, value) {
          call.params.set(name, value);
          return this;
        },
        then(resolve, reject) {
          return Promise.resolve([response]).then(resolve, reject);
        },
      };
      return query;
    };
    executor.begin = async (optionsOrCallback, callback) => {
      state.beginCalls += 1;
      const work = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      assert.ok(work);
      return work(makeExecutor(true), AbortSignal.timeout(10_000));
    };
    if (transaction) executor.transactionId = "transaction";
    return executor;
  };

  // The adapter exercises only queries, parameters, and transactions. Other
  // QueryClient operations intentionally have no implementation in this mock.
  return {
    calls,
    client: makeExecutor(false) as unknown as QueryClient,
    get beginCalls() { return state.beginCalls; },
  };
}
