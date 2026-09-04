# @vibecloud/db

Invocation-scoped YDB Drizzle access for Vibecloud functions, plus a YDB
Better Auth adapter at `@vibecloud/db/better-auth` and migration runner at
`@vibecloud/db/migrator`.

## Drizzle database scope

Define application tables with `@ydbjs/drizzle-adapter/schema` and use the
Vibecloud lifecycle helper:

```ts
import { integer, primaryKey, text, ydbTable } from "@ydbjs/drizzle-adapter/schema";
import { getYdb, withYdb } from "@vibecloud/db";

export const todos = ydbTable("todos", {
  id: text().notNull(),
  title: text().notNull(),
  completed: integer().notNull(),
}, (table) => [primaryKey(table.id)]);

export async function withDatabase<T>(work: () => Promise<T>): Promise<T> {
  return withYdb(process.env.PRIMARY_ENDPOINT!, work);
}

export async function createTodo(id: string, title: string) {
  await getYdb().insert(todos).values({ id, title, completed: 0 });
}
```

`withYdb()` is the preferred invocation-boundary API. It uses the official YDB
environment credential conventions, including metadata credentials in Cloud
Functions and access-token credentials during `push`, and always closes the
driver and its bounded query-session pool. Insecure loopback and OrbStack
`.orb.local` connections use their explicit endpoint without discovery, which
supports single-node local YDB without publishing Docker ports; cloud and other
connections keep discovery enabled. Vibecloud's app container sets
`VIBECLOUD_YDB_DISCOVERY=0` for the internal `ydb` Compose service for the same
single-node behavior; explicit `enableDiscovery` options still take precedence.
`runWithYdb()` is the lower-level alternative when the caller already
owns a Drizzle database instance. `tryGetYdb()` returns `undefined` outside a
scope. Concurrent and nested async scopes remain isolated. Wrapped YDB error
causes are included in the top-level message so the useful server status
survives Cloud Functions error logging.

Drizzle and named low-level queries reuse that same driver, credentials, and
pool. Use the low-level client only for YDB behavior that Drizzle cannot
express, and name every operation so telemetry remains actionable:

```ts
import { getYdbQueryClient, ydbQuery } from "@vibecloud/db";

const rows = await ydbQuery(
  getYdbQueryClient(),
  "todo.expired",
  { "db.collection.name": "todos" },
)`SELECT * FROM todos WHERE expires_at < CurrentUtcTimestamp()`;
```

Named queries record retries, request IDs, returned rows, consumed units,
server duration and CPU time, compilation cache status, affected shards, read
rows and bytes, and partitions. `traceYdbQuery()` attaches the same normalized
attributes to an active OpenTelemetry span.

Prefer Drizzle query builders. When raw YQL is necessary, use
`drizzle-orm`'s `sql` tag and interpolate values instead of embedding literals:

```ts
import { sql } from "drizzle-orm";

await getYdb().execute(sql`UPSERT INTO pulse_state (id) VALUES (${"global"})`);
```

The interpolated JavaScript string is bound as `Utf8`; a bare YQL `"global"`
literal is `String` (bytes) and does not match an `Utf8` column.

## Better Auth

```ts
import { getYdb } from "@vibecloud/db";
import { ydbAdapter } from "@vibecloud/db/better-auth";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database: ydbAdapter({
    getDb: getYdb,
    schemaOutputPath: "src/databases/primary/migrations/001_auth.sql",
  }),
});
```

This remains a YDB-specific Better Auth adapter because Better Auth's official
Drizzle adapter does not support YDB. The adapter reuses the query client owned
by the invocation's Drizzle database rather than opening another driver or
credential stack. The database is resolved separately for each Better Auth
operation.

Auth dates use microsecond-capable YDB `Timestamp` values, identifiers are
restricted to the transformed Better Auth schema, and case-insensitive matching
uses Unicode folding. Top-level Better Auth transactions reuse their YDB
transaction across calls, while `consumeOne`, `incrementOne`, `updateMany`, and
`deleteMany` perform their multi-step work atomically. Optional secondary index
declarations select YDB index views only for matching equality predicates.
JSON and arrays are encoded into `Utf8` columns.

## Migrations

`@vibecloud/db/migrator` runs ordered SQL files through the official YDB
Drizzle migrator. Drizzle Kit does not currently expose a YDB dialect for
schema-diff generation; the YDB adapter provides Drizzle schema declarations,
DDL builders, and the migration runner. Keep the TypeScript schema and reviewed
YDB SQL change together. Name files like `001_create_users.sql` and put
`--> statement-breakpoint` between statements. Applied hashes are recorded in
YDB, and a distributed lock prevents concurrent deploy jobs from racing.
Applied files are immutable; use a new ordered migration for the next schema
change.

In a generated Vibecloud project, `pnpm push` provisions declared databases,
applies the built migration snapshot, and activates application code only after
migration success. `pnpm vibecloud db up` applies source migrations only to
databases that are already provisioned.
