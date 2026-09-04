# Resource reference

Vibecloud stores declarations in
`infra/vibecloud.auto.tfvars.json`. Logical resource names use lowercase
kebab-case; environment names use uppercase snake case.

`name` identifies the application and prefixes physical resource names.
`folder_id` is resolved by `vibecloud init` and passed to Terraform for every
project. Ownership is recorded separately in `.vibecloud/project.json`:
managed folders are created and deleted by Vibecloud, while folders adopted
with `init --folder-id` remain external. Commit the metadata file; do not edit
its project UUID, lifecycle, phase, or folder ID by hand. Rerun `init` to resume
an incomplete phase and use `vibecloud doctor` to diagnose or repair current
project state. Pre-release scaffold formats are not migrated.

## Assets

`assets.<name>` uploads `dist/assets/<name>` to Object Storage.

- `template`: currently `vite`.
- `build.command`: required for a custom asset; the Vite template supplies it.
- `build.cwd`: optional working directory.
- `fallback`: optional error-object key, typically `index.html`.
- `cloud_name`: optional initial physical bucket name.

```bash
pnpm vibecloud add asset website --template vite --route '/*'
```

`--route` atomically creates the asset and its `ANY` route and is the preferred
form for the initial route. Use `add route` only for additional routes. An asset
route accepts only `GET` or `ANY`; both generate a GET gateway operation. Remove
routes before removing their asset.

## Buckets

`buckets.<name>` creates a general-purpose Object Storage bucket. Functions
receive its physical name as `<NAME>_BUCKET`. `cloud_name` optionally fixes the
initial globally unique bucket name.

```bash
pnpm vibecloud add bucket uploads
```

## Databases and streams

`databases.<name>` creates serverless YDB. Functions receive
`<NAME>_ENDPOINT`; metadata credentials are enabled automatically.

- `migrations`: when true, the build copies numbered SQL migrations from
  `src/databases/<name>/migrations` to `dist/databases/<name>/migrations`, and
  `push` provisions the database, applies that built snapshot, and only then
  activates application code. `db up` instead applies the source files directly
  to an already-provisioned database.
- `streams.<name>`: creates a YDB topic addressed by the CLI as
  `database.stream`.

Streams expose `<DATABASE>_<STREAM>_NAME` and
`<DATABASE>_<STREAM>_DATABASE` to functions.

```bash
pnpm vibecloud add database primary --migrations
pnpm vibecloud add stream primary.events
```

Create the database before streams. Remove stream triggers, then streams, then
the database. A stream rename cannot move it between databases.

## Functions

`functions.<name>` creates a Cloud Function.

- `handler`: module and exported handler, such as `index.handler`.
- `runtime`: defaults to `nodejs22`.
- `template`: `api`, `ai-agent`, `ai-image`, `ai-turn`, `better-auth`, `websocket`,
  `cron-trigger`, or `datastream-trigger`.
- `database`: the migrated YDB binding used by Better Auth and authenticated AI functions.
- `memory_mb`: defaults to 128; `ai-turn` defaults to 256.
- `timeout_seconds`: defaults to 10; `ai-agent` and `ai-turn` default to 30.
- `build.command` and `build.cwd`: optional custom build.
- `cron`: timer settings.
- `triggers`: Data Streams trigger settings.

Built-in runtime families are `nodejs*`, `python*`, and `golang*`. Other
runtimes require `build.command`, which receives
`VIBECLOUD_FUNCTION_NAME`, `VIBECLOUD_FUNCTION_SOURCE`, and
`VIBECLOUD_FUNCTION_OUTPUT` and must create `dist/functions/<name>`.

```bash
pnpm vibecloud add function api --template api --runtime nodejs22
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
pnpm vibecloud add function agent --template ai-agent --route /api/agent
pnpm vibecloud add function assistant --template ai-turn --route /api/turn
pnpm vibecloud add function illustrator --template ai-image --route /api/images
pnpm vibecloud add function game --template websocket --route /ws
pnpm vibecloud add function analyzer --template api --runtime python312
pnpm vibecloud add function events --template datastream-trigger --runtime golang123
pnpm vibecloud add function cleanup --cron '0 * ? * * *' --payload compact
```

HTTP and WebSocket templates are runnable examples. Cron and Data Streams
templates fail closed until their business logic is implemented, preventing
silent acknowledgement of unprocessed trigger messages.

`ai-agent` is a Better Auth-protected Node.js HTTP template backed by the AI
Studio Responses API. `ai-turn` accepts text or bounded SpeechKit audio and
returns text, independently playable synthesized-audio chunks, or both. Create
Better Auth first; both templates reuse its database and session cookie, add
`@vibecloud/ai`, and infer their required IAM roles. See
[ai.md](ai.md) for authentication, additional AI capabilities, and the
Realtime relay boundary.

`ai-image` is a public Node.js YandexART endpoint. POST starts native
asynchronous generation and returns an operation ID; GET with `operationId`
returns progress or the completed base64 JPEG. It adds `@vibecloud/ai` and
infers `ai.imageGeneration.user` without requiring Better Auth or YDB.

A function cannot mix HTTP/WebSocket routing with timer or Data Streams
consumption.

## Better Auth

```bash
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
```

`add auth` is the supported atomic authoring surface. It adds a Node.js
`better-auth` function bound to the database, `ANY /api/auth/*`, the generated
`BETTER_AUTH_SECRET`, the default Better Auth YDB migration, and auth client/UI
files for every Vite asset. The database must already exist; the command enables
migrations if needed. A Better Auth function must retain its database binding,
route, and secret for the complete declaration to validate.

## Routes

`gateway.routes[]` maps a method and pattern to exactly one function or asset.

- Methods: `ANY`, `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`,
  or `WS`.
- Patterns contain URL-safe literal segments and may end with one HTTP
  wildcard, such as `/api/*`.
- `WS` routes target functions and cannot contain wildcards.
- Asset routes use `GET` or `ANY`.
- Multiple HTTP methods may share one path; duplicate method/path operations
  are rejected.

Route declaration order does not affect request handling. Vibecloud converts a
trailing `*` into a Yandex API Gateway greedy path parameter, and the gateway
selects routes by specificity:

1. A fixed route such as `/api/health` wins over a matching wildcard route.
2. Between matching wildcard routes, the longer prefix wins, so `/api/*` wins
   over `/*` for `/api/items`.
3. On the selected path, an explicitly declared HTTP method wins; `ANY` handles
   methods that have no explicit operation.

Do not reorder routes to express priority. Use the most specific path that
describes each target and let API Gateway apply its matching rules.

```bash
pnpm vibecloud add route GET /api/items --function api
pnpm vibecloud add route POST /api/items --function api
pnpm vibecloud add route WS /ws --function game
pnpm vibecloud remove route GET /api/items
```

Routes have no rename command; remove the old identity and add the new one.

## Timer triggers

`functions.<name>.cron` contains:

- `expression`: UTC cron fields in the order
  `Minutes Hours Day-of-month Month Day-of-week [Year]`.
- `payload`: optional string, at most 4,096 characters.

```bash
pnpm vibecloud add function cleanup --cron '0 * ? * * *' --payload compact
```

The CLI creates the function and timer atomically. Timer functions cannot also
be routed or consume Data Streams.

## Data Streams triggers

`functions.<name>.triggers[]` connects a stream to one function.

Data Streams records must contain JSON. The trigger parses each record and
places its value directly in `event.messages`; do not decode a Base64
`details.data` envelope. Type the handler as `DataStreamsEvent<YourMessage>` and
validate untrusted fields before using them.

Assume delivery can be retried. Give each record a stable business or event ID,
and make the consumer idempotent. When a record both marks an ID as processed
and changes application state, perform those writes in one serializable
transaction.

- `stream`: required `database.stream` reference.
- `batch_size_bytes`: 1–65,536; default 1.
- `batch_cutoff_seconds`: 1–60; default 1.
- `retry_attempts`: 1–5; default 1.
- `retry_interval_seconds`: 10–60; default 10.
- `dead_letter_queue`: optional Yandex Message Queue ID.

```bash
pnpm vibecloud add trigger events --stream primary.events \
  --batch-size-bytes 65536 --retry-attempts 3 \
  --dead-letter-queue <queue-id>
pnpm vibecloud remove trigger events --stream primary.events
```

Create database, stream, and function first. Function, database, and stream
renames update trigger references; triggers themselves have no rename command.

## Secrets

`secrets.entries.<ENV_NAME>` generates a random value in the application
Lockbox and injects it into every function. Each entry has an independent
secret version so adding one does not rotate existing values.

```bash
pnpm vibecloud add secret WEBHOOK_SIGNING_KEY
pnpm vibecloud rename secret WEBHOOK_SIGNING_KEY WEBHOOK_SECRET
pnpm vibecloud remove secret WEBHOOK_SECRET
```

The declaration value is `{}`. Never store plaintext or provider IDs in tfvars.

## Adjacent inputs

- `vars`: non-secret values injected into every function.
- `observability.logs`: correlated application OTLP logs emitted through
  `structuredLog`; accepts `min_level` and `cluster`.
- `observability.platform_logs`: YC function runtime and gateway logging;
  accepts `enabled` and `min_level` and is independent of application OTLP.
- `observability.metrics` and `observability.traces`: direct Monium exporters.
- Enabled Monium signals share one scoped Lockbox-backed API key and cluster.
- `observability.source_maps`: enables Node.js source maps.

## Automatic RED dashboard

Every `push` creates or updates one Terraform-managed Monium dashboard for the
application. It uses YC's built-in API Gateway and Cloud Functions metrics, so
it is present even when `observability.metrics` is disabled. `push` prints its
URL next to the deployed gateway URL.

The dashboard is deliberately split into two sections:

- **API Gateway**: request rate by route and method, errors by route/method/code,
  and aggregate p95 response latency.
- **Cloud Functions**: invocation rate, errors, and p95 execution duration for
  the function chosen in the Function selector.

The Function selector contains the deployed cloud function names and is
recomputed from the declaration on every apply. It is single-select because a
percentile over histograms from several functions would lose the function
boundary and produce a misleading duration series. Projects with no functions
omit the Function selector and section.

Application telemetry uses Monium project `folder__<project-folder-id>`, the
shared configured cluster (default `default`), and the logical function key as
its service, for example `consumer`. Query it with a selector such as
`{project="folder__<project-folder-id>", cluster="default", service="consumer"}`.

YC-owned gateway `GET` and function `START`, `END`, and `REPORT` records appear
under platform service `default` and expose `request_id`, but YC cannot add the
handler's application trace or span IDs to them. `traceInvocation` records the
function invocation ID on the span; traced HTTP and WebSocket templates also
record the API Gateway request ID. Application logs emitted with
`structuredLog` carry request, trace, and span correlation.

Enabling telemetry does not rewrite existing handlers. Newly scaffolded
Node.js functions use traced templates when metrics or traces are already
enabled.

Use `pnpm vibecloud list [kind]` with `asset`, `bucket`, `database`, `stream`,
`function`, `route`, `trigger`, `cron`, or `secret`.
