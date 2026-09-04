# YDB application patterns

Read this reference when implementing database queries, migrations, streams,
or authentication backed by a declared Vibecloud database.

## Use generated bindings

A database key such as `primary` is exposed to every function as
`PRIMARY_ENDPOINT`. A nested stream such as `primary.events` is exposed as
`PRIMARY_EVENTS_NAME` and `PRIMARY_EVENTS_DATABASE`. Do not hard-code cloud
endpoints, database paths, or provider IDs.

Define application tables in TypeScript with the YDB Drizzle schema helpers.
Drizzle Kit can generate schema diffs for its supported SQL dialects, but it
does not currently include YDB; `@ydbjs/drizzle-adapter` supplies the ORM,
YDB DDL builders, and migration runner rather than a Drizzle Kit dialect.

Author and review the corresponding YDB SQL under
`src/databases/<name>/migrations/`, using ordered names such as
`001_create_todos.sql`. Use the adapter's `build*Sql` helpers when generating
DDL from schema objects. Separate statements with `--> statement-breakpoint`.
The build copies migrations into `dist/`, and `push` applies that exact built
snapshot after provisioning the database but before activating application
code. `pnpm vibecloud db up` skips build and Terraform and applies source
migrations to every enabled, already-provisioned database found in current
Terraform state.

The YDB Drizzle migrator records file hashes and coordinates concurrent runs
with a distributed lock. An applied migration is immutable: never edit,
renumber, or reorder it. For a schema change, update the TypeScript schema and
add the matching reviewed forward migration. Do not invent tables before an
application feature or library defines the required schema.

## Use YDB Drizzle

Define tables with `@ydbjs/drizzle-adapter/schema` and use Drizzle query
builders for reads and writes. Wrap the complete invocation in
`withYdb(process.env.PRIMARY_ENDPOINT!, work)` from `@vibecloud/db`; nested
application code can call `getYdb()`. The helper selects metadata, access-token,
static, or anonymous credentials through the official YDB environment
conventions and always closes the driver.

```ts
import { boolean, primaryKey, text, ydbTable } from "@ydbjs/drizzle-adapter/schema";
import { getYdb, withYdb } from "@vibecloud/db";

export const todos = ydbTable("todos", {
  id: text().notNull(),
  title: text().notNull(),
  completed: boolean().notNull(),
}, (table) => [primaryKey(table.id)]);

await withYdb(process.env.PRIMARY_ENDPOINT!, () =>
  getYdb().insert(todos).values({
    id: crypto.randomUUID(),
    title: "Ship it",
    completed: false,
  }),
);
```

Do not construct a second low-level YDB driver or credential stack. When a
query cannot be expressed through Drizzle, use `getYdbQueryClient()` and
`ydbQuery()` from `@vibecloud/db`; they reuse the invocation's existing driver
and pool and require a stable operation name for YDB cost telemetry. Vibecloud
enables metadata credentials for functions attached to a declared YDB.

## Publish to a declared stream

Add `@ydbjs/topic` when application code writes to a stream. Reuse the driver
owned by `withYdb`; do not create a second driver or credential stack. Join the
generated database and stream bindings defensively because either side may
contain the separating slash. Write JSON bytes so a Vibecloud Data Streams
trigger receives the decoded value directly in `event.messages`.

```bash
pnpm add --save-exact @ydbjs/topic
```

```ts
import { getYdb, withYdb } from "@vibecloud/db";
import { YdbDriver } from "@ydbjs/drizzle-adapter";
import { topic } from "@ydbjs/topic";

async function publish(message: unknown): Promise<void> {
  await withYdb(requiredEnv("PRIMARY_ENDPOINT"), async () => {
    const client = getYdb().$client;
    if (!(client instanceof YdbDriver)) throw new Error("expected YdbDriver");

    const database = requiredEnv("PRIMARY_EVENTS_DATABASE").replace(/\/$/, "");
    const name = requiredEnv("PRIMARY_EVENTS_NAME").replace(/^\//, "");
    const writer = topic(client.driver).createWriter({
      topic: `${database}/${name}`,
      producer: "event-producer",
    });

    try {
      writer.write(new TextEncoder().encode(JSON.stringify(message)));
      await writer.flush();
    } finally {
      await writer.close();
    }
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
```

Use a stable record ID, such as the timer event ID, rather than generating a
new ID during each retry. In the consumer, validate each typed message and
atomically record that ID with its application-side changes. Returning normally
acknowledges work; throw when processing must be retried.

## Parameterize raw YQL

Prefer query builders. If a YDB-specific statement requires raw YQL, compose it
with `sql` from `drizzle-orm` and interpolate every application value:

```ts
import { sql } from "drizzle-orm";

await getYdb().execute(sql`UPSERT INTO pulse_state (id) VALUES (${"global"})`);
```

JavaScript strings bind as non-null `Utf8`. An untyped YQL literal such as
`"global"` is `String` (bytes), not `Utf8`. If a literal is unavoidable, use
YQL's typed `"global"u` form. Do not use `CAST("global" AS Utf8)` for a
`NOT NULL` value: a fallible YQL cast produces `Optional<Utf8>`.

Keep migration column types and Drizzle schema types aligned. Test every
non-trivial write against YDB before deployment, including aggregate
`UPSERT ... SELECT` statements.

## Managed secrets

Declare generated entries in the application Lockbox:

```json
"secrets": {
  "entries": {
    "BETTER_AUTH_SECRET": {},
    "WEBHOOK_SIGNING_KEY": {}
  }
}
```

The empty objects mean “generate this value”; they are not plaintext
placeholders. Terraform stores generated entries independently so adding one
does not rotate the others, and injects each value under its entry key. Never
put provider IDs or generated values into tfvars.

## Better Auth

Use `ydbAdapter` from `@vibecloud/db/better-auth` with `better-auth`. Configure
`ydbAdapter({getDb: getYdb})`. It remains a custom Better Auth adapter because
Better Auth's official Drizzle adapter supports SQLite, PostgreSQL, and MySQL,
not YDB. It reuses the query client beneath the invocation's Drizzle database,
including its driver, credentials, and session pool.

Prefer `pnpm vibecloud add auth --database <name>` for the default
email/password feature. It generates the adapter-derived default DDL into the
declared migration directory along with the function, route, secret, and client
surface. Review it before deployment. Keep later auth schema changes in ordered migrations. The adapter
uses microsecond-capable `Timestamp`, Unicode case folding, strict
schema-derived identifiers, real cross-method YDB transactions, and atomic
`consumeOne`/`incrementOne` operations. JSON and arrays use `Utf8`. Declare
secondary index views in the adapter configuration when an auth lookup depends
on them. Do not invent auth tables independently of the Better Auth schema.
