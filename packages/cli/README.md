# Vibecloud

Vibecloud scaffolds and deploys serverless Yandex Cloud applications through
checked-in Terraform. The CLI edits Terraform inputs, creates source templates,
builds deployable artifacts, and invokes Terraform, whose graph orders optional
YDB migrations before application publication. The packaged [architecture
reference](ARCHITECTURE.md) explains state ownership, recovery and support limits.

Published packages share one version:

- `@vibecloud/cli`: CLI, Terraform, source templates, architecture reference and agent skill.
- `@vibecloud/core`: shared invocation contracts and error normalization.
- `@vibecloud/codex-skill-init`: installer for the application bootstrap skill.
- `@vibecloud/function-api`: HTTP payload-format-1.0 types.
- `@vibecloud/function-ws`: WebSocket lifecycle types.
- `@vibecloud/function-trigger-cron`: timer event types.
- `@vibecloud/function-trigger-datastream`: Data Streams event types.
- `@vibecloud/ai`: authenticated typed Yandex AI Studio resources, SpeechKit,
  and server-side Realtime helpers.
- `@vibecloud/storage`: raw-byte Object Storage uploads with ordinary URLs.
- `@vibecloud/db`: invocation-scoped YDB Drizzle access, Better Auth adapter,
  and migration runner.
- `@vibecloud/telemetry`: application OpenTelemetry helpers.

Generated projects pin every `@vibecloud/*` dependency to the exact CLI
version that created them.

## Requirements

- Node.js 26 or newer
- pnpm 11.15.1
- OrbStack for `pnpm dev`
- Terraform 1.6.3 or newer, below 2.0
- An authenticated Yandex Cloud CLI (`yc`) for `init`, `push`, `db up`, and `delete`

Generated Cloud Functions default to Yandex Cloud's `nodejs22` runtime. The
Node.js 26 requirement applies to local tooling, not the deployed runtime.

## Initialize

Use Verdaccio or another configured npm-compatible registry containing the
Vibecloud release. Public npm availability is not assumed. Select the registry
in the target directory's `.npmrc` for both `registry` and `@vibecloud:registry`
before bootstrapping, and keep it configured for later host and container
installs. Resolve `<published-version>` in that registry:

```bash
mkdir my-app
cd my-app
# Configure .npmrc for your registry here.
pnpm dlx @vibecloud/cli@<published-version> init
```

From the Vibecloud source workspace, use `pnpm local:init --
<absolute-empty-project-directory>` for local Verdaccio instead; the helper
selects the `dev` release and prepares registry settings and exact-version
release-age exclusions. If installation returns 404, check the registry and
published version before treating it as a package failure. Keep application
dependencies on registry releases rather than tarball or workspace overrides.

The directory name becomes the application name. Initialization creates the
managed YC folder through the authenticated `yc` CLI, then creates an empty
Terraform application, build tooling, `AGENTS.md`, and project-local Vibecloud
and Gravity UI skills under `.agents/skills/`, and runs `pnpm install`. It
creates no application resources or `src/` tree until they are requested.

Commit `.vibecloud/project.json`. It records a stable project UUID, resolved YC
folder ID, managed or external lifecycle, metadata/scaffold versions, and the
current `scaffolded`, `folder_created`, or `ready` initialization phase. Managed
folder deletion has a separate durable receipt under `deletion`; `ready` does
not mean a folder with pending deletion is still available.
Managed folders carry the project UUID as a YC label, so rerunning `init` after
an interruption recovers the existing folder instead of creating another one.
Once initialization is complete, repeated `init` calls preserve project and
folder identity and refresh the installed dependency state. Automation that
must defer dependency installation can pass `--no-install`.

Use `pnpm vibecloud doctor` to validate metadata, folder identity and label,
Terraform state, and the local container runtime. `doctor --repair` resumes an
incomplete current-version initialization and repairs authoritative folder
metadata. Pre-release scaffolds are not migrated; initialize a new directory.

By default, Vibecloud creates a dedicated YC folder named after the
application and owns its lifecycle. To deploy into a folder you already keep,
initialize with its ID instead:

```bash
pnpm dlx @vibecloud/cli@<published-version> init --folder-id <folder-id>
```

An adopted folder is never created, renamed, or deleted by the generated
project. Initialization verifies that it exists and is active before writing
the project configuration. Terraform always receives the resolved folder ID
and never creates or deletes a YC folder itself.

Generated infrastructure uses one runtime service account for functions,
triggers, and API Gateway integrations. Its roles are the union of declared
capabilities and resource needs. For example, Responses features grant
`ai.languageModels.user` and `ai.assistants.editor`; image generation grants
`ai.models.user`. An ordinary HTTP application receives no AI role by default.
This is project-level permission scoping, not isolation between logical handlers.

The authoritative Terraform input is
`infra/vibecloud.auto.tfvars.json`. The other files under `infra/` are ordinary
checked-in Terraform and may be reviewed or extended directly.

## Add resources

Discover every resource and ready-to-copy recipe directly in the CLI. Function
and asset help include the complete template catalog, aliases, runtime support,
and safety constraints:

```bash
pnpm vibecloud add --help
pnpm vibecloud add function --help
pnpm vibecloud add asset --help
```

```bash
pnpm vibecloud add asset website --template vite --route '/*'

pnpm vibecloud add function api --template api --route '/api/*'
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
pnpm vibecloud add function agent --template ai-agent --route /api/agent
pnpm vibecloud add function assistant --template ai-turn --route /api/turn
pnpm vibecloud add function illustrator --template ai-image --route /api/images
pnpm vibecloud add function game --template websocket --route /ws
pnpm vibecloud add function cleanup --cron '0 * ? * * *' --payload compact

pnpm vibecloud add stream primary.events
pnpm vibecloud add function worker --template datastream-trigger
pnpm vibecloud add trigger worker --stream primary.events

pnpm vibecloud add bucket uploads
pnpm vibecloud add secret WEBHOOK_SIGNING_KEY
pnpm vibecloud list
```

Resource edits change local declarations. Rename reconciliation also reads the
configured Terraform backend, which may require network authentication. Each configuration
mutation validates the complete input and is written atomically; repeating the
same addition is a no-op. When a command prints
`updated: package.json`, run `pnpm install` before building.

`--route` creates the resource and its first route together. Assets and API
functions receive an `ANY` route; WebSocket functions receive a `WS` route. Use
`add route` only when an existing resource needs another route. `--cron` creates
a timer function and schedule together. Cron expressions use UTC.

Cron and Data Streams templates fail closed until their handler body is
implemented. This prevents an untouched stream consumer from acknowledging and
discarding messages. Implement those handlers before deployment.

The Vite template is a minimal Gravity UI page with an Action Bar and visible
light, system, and dark theme choices. `add auth` turns an existing migrated
YDB database into a complete email/password Better Auth feature: it adds the
function and `/api/auth/*` route, generates `BETTER_AUTH_SECRET`, creates the
reviewed default-table migration, and scaffolds a React auth client and account
panel. If the Vite starter page is still untouched, the command mounts that
panel automatically; authored pages are preserved. Initialized projects
include the upstream Gravity UI skill, which routes agents to documentation
matching the installed package version.

## Yandex AI Studio

Better Auth and YDB are optional application capabilities. Add accounts or
persistence when the application needs them. A custom `api` handler can call
`@vibecloud/ai` without either; declare its AI capabilities and add the SDK at
the same exact version as the CLI. See the
[custom AI handler recipe](skills/vibecloud/references/ai.md#custom-ai-handlers).

The `ai-agent` template creates a POST endpoint backed by AI Studio's
OpenAI-compatible Responses API. It adds `@vibecloud/ai` and grants the runtime
service account the Responses-specific role automatically:

```bash
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
pnpm vibecloud add function agent --template ai-agent --route /api/agent
```

The `ai-agent` and `ai-turn` templates require an existing Better Auth service
and inherit its database binding. The handler validates the Better Auth session cookie, accepts
`{ "prompt": "..." }` and an optional signed `continuation`, and returns the
next continuation. Raw upstream response IDs are never accepted from clients.
In Yandex Cloud, `@vibecloud/ai` authenticates upstream with the short-lived IAM
token in the invocation context; no production API key is needed.

For Alice AI ART, add a public image endpoint without Better Auth or YDB:

```bash
pnpm vibecloud add function illustrator --template ai-image --route /api/images
```

POST `{ "prompt": "A paper city", "size": "1024x1024" }` and receive status 200
with JSON `{ key, url, contentType, sizeBytes }`. Render `url` directly as an image
source. The command creates a public `images` bucket and adds `@vibecloud/storage`;
`--bucket <name>` selects an existing public bucket. Bytes go straight to storage
using the function IAM token, keeping the function response below its payload limit.
Signed URLs, Better Auth, and YDB are optional. The template uses the synchronous
Images API, infers `ai.models.user`, and defaults to a 120-second timeout and
256 MB of memory. Prompts are limited to 500 Unicode characters. Supported sizes
are `auto`, `1x1`, `1024x1024`, `1024x1536`, and `1536x1024`.

YandexART's asynchronous API was retired on 7 September 2026. Existing apps must
replace start/retrieve calls and frontend polling with the new single-response
flow. The old SDK API has been removed; see the [SDK migration notes](../ai/README.md#migration-from-yandexart).
No automatic retry is made after a generation timeout or lost response.

For serverless text and voice conversations, add a multi-purpose turn endpoint:

```bash
pnpm vibecloud add function assistant --template ai-turn --route /api/turn
```

The JSON contract uses a discriminated `input` object and an explicit
`output.modalities` array. Input is either `{ "type": "text", "text": "..." }`
or `{ "type": "audio", "dataBase64": "...", "format": "oggopus" }`.
Request `text`, `audio`, or both response modalities; audio options such as
`format`, `voice`, `role`, and `speed` live under `output.audio`. Audio output
contains ordered, independently playable `{ "dataBase64" }` chunks plus
`format` and `contentType`; each SpeechKit utterance stays within 250
characters. Send the signed `continuation` back on the next turn. Audio input
is limited to a mono utterance of at most 30 seconds and 1 MB. Both AI
templates default to a 30-second timeout; `ai-turn` defaults to 256 MB.

Both templates cap prompt size and model output, apply a per-user warm-instance
rate limit, cancel upstream work before the function deadline, reject
non-completed Responses results, and emit stage/token telemetry. Configure
limits with `VIBECLOUD_AI_MAX_PROMPT_CHARS`,
`VIBECLOUD_AI_MAX_OUTPUT_TOKENS`, `VIBECLOUD_AI_MAX_SPEECH_CHARS`,
`VIBECLOUD_AI_REQUESTS_PER_MINUTE`, and
`VIBECLOUD_AI_CONTINUATION_TTL_SECONDS`.

Declare roles for other AI features in `infra/vibecloud.auto.tfvars.json`:

```json
{
  "ai": {
    "realtime": true,
    "speechkit_stt": true,
    "speechkit_tts": true,
    "image_generation": true
  }
}
```

For local use, `pnpm dev` resolves authentication in this order: an explicit
`YANDEX_CLOUD_API_KEY`, an explicit `YANDEX_CLOUD_IAM_TOKEN`, or a temporary IAM
token obtained from the active `yc` profile. Vibecloud reads the initialized
`folder_id` and passes the selected credential to Compose without printing or
persisting it. Restart `pnpm dev` to refresh a temporary token. Keep an explicit
API key for unattended local environments; when YC returns an opaque token the
CLI reports the recommended hourly refresh deadline. Do not put credentials in
tfvars.

Continuous Realtime audio is deliberately a server-side primitive, not a
browser template. AI Studio keeps each audio session on a persistent WebSocket
and its authorization header must remain secret. API Gateway's WebSocket
integration invokes a function independently for each lifecycle event, so it
cannot transparently forward the upstream session. `@vibecloud/ai` retains a
server connection helper for trusted runtimes, while `ai-turn` is the
fully serverless browser-facing path.

## Develop locally

```bash
pnpm dev
```

The `dev` script is the only local-development entrypoint. It starts the project
with `docker compose up --build --watch`; `npm run dev` invokes the same script
when npm is used as the script runner.

### Structure

```text
host project worktree
├── src, configuration, and build files ── bind mount ──► app:/workspace
└── pnpm dev ── controls ───────────────────────────────► Docker Compose

Compose project: <project>
├── app
│   ├── Vite and frontend hot reload
│   ├── local HTTP function gateway
│   ├── function builder and migration watcher
│   ├── private build output at /vibecloud-runtime
│   └── container-only node_modules and pnpm store
└── ydb-<database> (one service per declared database)
    └── independent persistent database and certificates
```

Source is not copied into a container or synchronized by Compose Watch. The
project root is bind-mounted at `/workspace`, so a host edit is immediately
visible inside `app`. Dependencies stay in named volumes instead of being
mixed with host `node_modules`. Registry overrides from `PNPM_CONFIG_REGISTRY`
or `NPM_CONFIG_REGISTRY` are forwarded into the app container; a checked-in
project `.npmrc` remains the fallback when those variables are absent.

Compose runs without its interactive menu and returns the `app` container's
exit code. Dependency-install or startup failures therefore make `pnpm dev`
fail instead of leaving YDB running behind an apparently successful command.

Local development requires OrbStack. Services run in Docker Compose and use
`.orb.local` routing, with no published host ports. Vibecloud prints checkout-specific
URLs (`<project>` is `vibecloud-<checkout-hash>`): `<project>.orb.local` for the
app, `app.<project>.orb.local:8787` for the API, and
`ydb-<database>.<project>.orb.local` for each database UI (gRPC uses port 2136
on that service hostname). Internal container ports do not compete across checkouts.
OrbStack handles HTTPS; generated auth handlers preserve its forwarded origin.
Select the OrbStack engine with `docker context use orbstack` if needed.

### What watches what

| Host change | Watch owner | Result inside Compose |
| --- | --- | --- |
| `src/assets/**` | Vite polling watcher | Frontend hot reload |
| `src/**` (including shared backend modules) | Vibecloud function watcher | Rebuild; the next request loads the new handler |
| `src/databases/**/migrations/**` | Vibecloud migration watcher | Apply pending YDB migrations |
| Selected Terraform input | Host Vibecloud watcher | Regenerate services and AI credentials; recreate Compose containers |
| `package.json`, `build.ts`, or `vite.config.ts` | Compose Watch | Restart `app` |
| `infra/local.Dockerfile` | Compose Watch | Rebuild `app` |

Press Ctrl-C to stop the Compose project. Named volumes preserve YDB data,
dependencies, and the pnpm store for the next run. Local execution covers Vite
assets and built-in Node.js HTTP functions; test cloud-only triggers,
WebSockets, and custom runtimes through their deployed environment.

## Rename and remove resources

```bash
pnpm vibecloud rename function api backend
pnpm vibecloud rename stream primary.events primary.changes
pnpm vibecloud remove route ANY '/api/*'
pnpm vibecloud remove trigger worker --stream primary.events
pnpm vibecloud remove bucket uploads
```

Renames update references and source directories and append Terraform `moved`
blocks to `infra/moves.auto.tf`. Commit those blocks so Terraform preserves
resource identity.
Database renames also update quoted endpoint environment-variable names in the
bound Better Auth and AI handler modules while preserving other authored code.

Remove consumers before dependencies. Removal changes infrastructure inputs
only; it preserves authored source and package dependencies for safe rollback.
Delete those separately after review.

## Build

```bash
pnpm lint
# If lint reports auto-fixable formatting:
pnpm lint:fix
pnpm typecheck
pnpm build
```

Artifacts are written to `dist/`:

- assets: `dist/assets/<name>`
- functions: `dist/functions/<type>-<runtime>` (for example `http-nodejs22` or `timer-python312`); Data Streams consumers use `dist/functions/stream-<name>`
- deployment manifests: `dist/deployment-plan.json` (including `function_groups`)
- migrations: `dist/databases/<name>/migrations`

Logical functions keep their names and `src/functions/<name>` source directories.
HTTP, WebSocket, and timer handlers deploy as one physical function per invocation
type and exact runtime version. AI and Better Auth handlers join the HTTP group.
The group uses the largest requested memory and timeout, including template defaults.
Handlers share process resources and dependencies within that group; compatible
library versions are required. Declare separate logical handlers for HTTP and WS.

The builder generates routers for Node.js, Python, and Go. Node handlers load lazily;
Python handlers are packages under `handlers/` and should use relative imports for
sibling modules. Python requirements are resolved together; synchronous and asynchronous handlers
use a persistent event loop. Go modules retain their
module paths under local replacements, with the copied root package made importable;
handlers use Cloud Functions signatures, with optional context and typed or raw JSON
input, returning a result and/or error. Standard `http.Handler` and
`func(http.ResponseWriter, *http.Request)` handlers are adapted from gateway events.

The gateway transports requests to the appropriate runtime group. A single HTTP
runtime without static assets uses just `/` and `/{path+}`; assets, WebSockets and
mixed runtimes retain their gateway path boundaries. Internal routers select the
logical handler by method and path, with exact paths before longest wildcard prefixes,
and explicit methods before ANY. They restore the logical `resource` and wildcard
`pathParameters`. Node context retains the platform fields and methods and adds
`logicalFunctionName`, also recorded as the `vibecloud.function.name` span attribute.

Timers send a logical dispatch key to the shared router. The router restores the
configured `cron.payload` (including an absent payload) before invoking the authored
handler. Unknown dispatch targets and handler errors fail the invocation for retry.
Data Streams consumers stay separate because Yandex delivers the original message
batch without stream or trigger identity; existing producers need no envelope changes.

Custom Node/Python/Go builds still run per logical handler using
`VIBECLOUD_FUNCTION_SOURCE` and `VIBECLOUD_FUNCTION_OUTPUT`, then join the native router.
Use the supplied output path instead of hardcoding a deployment directory. Custom
Node artifacts retain their own files and package dependencies. Other cloud runtimes
remain supported through `build.command`: a single member keeps its entrypoint;
multiple members in a group must share one build command and entrypoint. That command
runs once, receives `VIBECLOUD_FUNCTION_MANIFEST` (kind, handlers, settings and routes),
and owns the runtime-specific router. Timer dispatch keys and payload restoration
follow the same contract as the native routers.

HTTP functions return the Yandex API Gateway payload-format-1.0 response shape.
This API Gateway integration buffers responses; it does not provide HTTP
response streaming. WebSocket functions use API Gateway WebSocket operations.

Function and gateway infrastructure owns request and invocation logging.
Application code should emit only business telemetry and handled-error details
through `structuredLog`, which sends one correlated OTLP record to Monium and
preserves the same one-line JSON record in container output.
Enabling Monium observability injects credentials and exporter settings. The
builder wraps the current Node.js handler with `instrumentFunction`, so changing
observability takes effect on the next build, including for existing handlers.
Authored source remains unchanged. Native Node groups instrument custom-built handlers too; other custom runtimes own their instrumentation.

`observability.logs` controls correlated application OTLP logs.
`observability.platform_logs` separately controls YC gateway and function
runtime logs. Each app uses Monium project `folder__<project-folder-id>`, its
configured cluster, and the deployment group key (`http-nodejs22`, for example)
as the application service. Node spans additionally identify the logical handler. YC-owned `START`, `END`, `REPORT`, and gateway
request records use the platform `default` service and cannot inherit an
application span or trace ID.

Every deployment also creates a Terraform-managed Monium **Serverless RED**
dashboard from YC's built-in platform metrics; application OTLP metrics do not
need to be enabled. The dashboard has separate **API Gateway** and **Cloud
Functions** sections with rate, errors, and p95 duration charts. Its Function
selector is generated from the deployed function names and updates on each
`push`.

## Deploy

```bash
pnpm push
```

`push` checks project lifecycle, builds an immutable application snapshot, initializes
Terraform, and applies one saved plan under the backend lock. Terraform's dependency
graph provisions databases, runs changed migrations through the installed CLI adapter,
and activates functions and invokers after migration success. There is no database
pre-apply or CLI resource scheduler. A failed apply preserves Terraform's partial
progress and the built snapshot; retry after inspecting the error. Source edits and
cloud operations do not share a rollback transaction. The command prints gateway
and Monium dashboard URLs after success.

Deployment intentionally uses one command: review the source and declaration
diff, verify the application locally, then run `pnpm push`. There is no separate
plan/approval phase; `push` applies automatically. Standalone Terraform planning
is an advanced diagnostic and requires the generated inputs and matching build
artifacts described under Configuration consistency and recovery. It can reveal
resource replacements and deletions, but cannot validate migration execution or
application behavior.

`pnpm vibecloud db up` skips the build and Terraform apply. It applies pending
migrations directly from `src/databases/<name>/migrations` to every enabled,
already-provisioned database found in the current Terraform state. Use it for
migration-only updates after the initial `push`. It holds the same project lock
as edits and deployment, and reloads configuration after acquiring that lock.

The YDB adapter uses TypeScript Drizzle schemas and a Drizzle migration runner,
but Drizzle Kit does not currently have a YDB dialect for generating schema
diffs. Keep each schema change with reviewed, ordered YDB SQL such as
`001_create_users.sql`; separate multiple statements with
`--> statement-breakpoint`. The runner records hashes and checks migration
identity/checksum conflicts before user SQL under a YDB-backed distributed lock.
Changing the SQL of an applied migration is rejected; add a new numbered file.
Existing adapter history remains compatible and unchanged migrations are skipped.
Different migration identities containing identical SQL are rejected before connecting;
the same conflict against applied history is rejected under the distributed lock.
This prevents the adapter from silently skipping a second migration with the same hash.

After inspecting partial effects and verifying that the previous process stopped,
use `pnpm vibecloud db up --retry-interrupted` for deliberate recovery. It replays
failed migrations from their first statement and retries running records only after
the adapter considers them stale (one hour). It retains locking and immutable-history
checks. Normal `push`, `db up`, and local migration watchers never opt into replay.

Vibecloud preserves `YC_TOKEN` and `YC_CLOUD_ID` when set and resolves missing
values with `yc iam create-token` and `yc config get cloud-id`. Deployment always
uses the folder recorded in project metadata, including when the active profile
or `YC_FOLDER_ID` points at a different folder.
For deployment, it also resolves the authenticated principal with `yc iam
whoami` and grants that principal only `iam.serviceAccounts.user` on the
generated runtime service account. Token-only CI must set `YC_SUBJECT` to the
full `userAccount:<id>`, `serviceAccount:<id>`, or `federatedUser:<id>` subject.

Initialized projects use local Terraform state under `infra/`. Configure a
protected remote backend before multi-machine or concurrent CI deployment.

Direct Terraform validation remains available:

```bash
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra init -lockfile=readonly
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra validate
```

Initialized projects commit a provider lock containing checksums for Intel and
ARM macOS, Intel and ARM Linux, and Windows AMD64. When pinned provider versions
change, regenerate it explicitly from the YC network mirror:

```bash
terraform -chdir=infra providers lock \
  -net-mirror=https://terraform-mirror.yandexcloud.net/ \
  -platform=darwin_amd64 -platform=darwin_arm64 \
  -platform=linux_amd64 -platform=linux_arm64 -platform=windows_amd64
```

## Destroy

```bash
pnpm vibecloud delete --confirm delete:my-app
```

The exact confirmation is required. For a managed project, Vibecloud first
checks that the active YC folder matches the ID and project ownership label
recorded in `.vibecloud/project.json`. Missing metadata or mismatched ownership
stops deletion. A missing ownership label can be restored with
`pnpm vibecloud doctor --repair`; repair preserves other folder labels and
refuses to replace another project's ownership label. After verification,
Vibecloud submits asynchronous deletion of the entire YC folder using YC's
default grace period and returns immediately.

Vibecloud saves the submission intent before contacting YC, then records the
returned operation ID, scheduled deletion time, and status in project metadata.
Inspect or resume tracking without submitting another deletion:

```bash
pnpm vibecloud delete --status
```

`--status` needs no confirmation and only reads YC; it updates the local receipt.
Repeated confirmed delete calls also refresh an existing operation. They do not
submit another request or change its delay. If a submission response was lost,
the CLI searches the folder's operations and recovers the receipt. An unresolved
submission stays recorded as `submitting` and blocks another delete until its
operation can be recovered. Completed operations report `deleted`, `cancelled`,
or `failed`; after cancellation or failure, a fresh confirmed delete verifies
the folder is active and still owned by the project before retrying.
`doctor` reports the last recorded deletion status and directs you to `--status`
for a refresh.

An explicit YC rejection is recorded as `rejected`, allowing a new confirmed attempt
after the cause is fixed. Transport failures remain unresolved. Recovery excludes
operation IDs observed before submission and operations created before the attempt;
multiple matches require an exact selection. For ambiguous history or clock skew, use
`pnpm vibecloud delete --status --operation <id>` to attach a verified operation for
this folder. An ID from the pre-submission snapshot cannot replace the current intent.
The delete invocation disables YC CLI retries to keep submission outcomes distinguishable.

Use `--delete-after` to choose a non-negative delay in `HhMmSs` format, such as
`24h` or `22h30m50s`. To skip the grace period:

```bash
pnpm vibecloud delete --confirm delete:my-app --delete-after 0s
```

`0s` starts deletion without a recovery window; YC cleanup is still asynchronous
and may take up to 72 hours. If deletion is already pending, cancel it in the
YC console before submitting a different delay. See
[YC folder deletion](https://yandex.cloud/en/docs/resource-manager/operations/folder/delete).

For a project initialized with `--folder-id`, it runs
`terraform destroy` for the application resources and leaves the adopted
folder intact. `--delete-after` and `--status` are rejected for adopted folders. Neither path
deletes the local checkout.

Detailed fields and limits are in the bundled
[resource reference](skills/vibecloud/references/resources.md), and YDB
patterns are in the [YDB reference](skills/vibecloud/references/ydb.md).
Initialized projects also include the vendored upstream
[Gravity UI skill](skills/gravity-ui/SKILL.md).

## Configuration consistency and recovery

Host project operations use `.vibecloud/locks/project.sqlite`; host builds use
`.vibecloud/locks/build.sqlite`. SQLite holds an OS file lock for the owning process,
so termination releases ownership without a stale-PID reaper. Do not unlink these
stable lock handles to bypass a running command. If the CLI reports an obsolete
`mutation.lock` or `build.lock` directory from an older release, stop that older CLI
before removing only the named obsolete directory.

Reversible edits retain one recovery journal through configuration changes, source
creation/renames, dependency metadata and package synchronization. New files and
intermediate versions are recorded before writing. The next source mutation recovers
an interrupted edit only when affected files have not changed independently. Keep
`pending-edit.json` when a conflict requires resolution. Cloud receipts and Terraform
partial progress are outside this source rollback boundary.

`push [config]` builds and applies one complete snapshot of the selected config in
a unique `infra/.packages/deployment-*/selected.tfvars.json`. Its artifacts live in
that deployment's `dist/`, isolated from development rebuilds. Explicit empty values
prevent other auto-loaded Terraform files from introducing undeclared resources.
Builders receive `VIBECLOUD_CONFIG_PATH` and `VIBECLOUD_BUILD_OUTPUT`; the generated
builder accepts only `dist` or a fresh CLI-owned `infra/.packages/deployment-*/dist`
directory and records `deployment-plan.json`. Source, state, and symlink aliases
cannot be selected as output. A missing or mismatched
manifest stops deployment before Terraform runs. Custom project builders must honor
this contract; per-function builders continue using `VIBECLOUD_FUNCTION_OUTPUT`.

When migrations and retained renames coexist, a refresh-only apply records state moves
without changing cloud resources, then Terraform runs migrations before
application activation. Apply failures surface immediately; Vibecloud does not repeat
failed applies. After correcting the reported problem, rerun `pnpm push`.

The CLI compiles function grouping, runtime defaults, timer dispatch, gateway transport
routes, and AI capabilities once. The build, Terraform inputs and local tooling share
that compiler. Direct Terraform operations must select these generated inputs using
`-var-file`; the latest successful paths are recorded in
`infra/.packages/current-deployment.json`. After a successful activation the CLI keeps
the current build and two previous build directories. Failed deployments retain their
artifacts until a later successful activation prunes them.

Resource rename history is retained in `infra/moves.auto.tf` for every backend and
workspace that shares the configuration. Chained renames retain prior Terraform addresses;
renaming back rotates the chain toward the current name without forming a cycle.
Applying in one workspace never removes history needed by another workspace.
Edits compose and validate rename history locally, without backend access. At deployment,
`push` reads `terraform state pull` from the configured backend and selected workspace
(including `TF_WORKSPACE`) to discover asset-object moves. A failed state read stops
deployment. Asset renames preserve bucket and tracked object identities. Commit the
resulting moves file. Retained asset URLs keep their original release prefixes.
Bucket renames also retain local media identities in `.vibecloud/local-buckets.json`;
database renames retain local service names, endpoints and volumes in
`.vibecloud/local-databases.json`. Commit these files when generated so other checkouts
retain the same mappings.
Reusing a prior address for a different resource is rejected
while its history is retained.
Choose a new name, or deliberately retire the relevant history only after every
backend and workspace using it has migrated; applying one workspace is insufficient.

`pnpm vibecloud orphans` reports retained resource source directories and generated
dependencies no longer required by the declaration. Check authored imports before
removing dependencies. The report preserves source; resource removal never implicitly
deletes authored files. Generated dependency provenance is kept under `.vibecloud/`.

## Local capability selection

Built-in Node HTTP functions receive their compiled group's configured memory value
and remaining deadline in the invocation context. Local execution enforces the group
timeout by terminating its worker, including for synchronous loops; the gateway
returns 504. Other in-flight requests in that worker fail too, and the next request
starts a fresh worker. The memory value is context metadata, not a local process
memory cap; cloud memory enforcement still needs cloud validation.

Local development starts one isolated YDB service per declared database. Database
endpoints, volumes and migration histories are separate. With no databases, no YDB
service starts. Services and volumes use the database resource name, so adding a
database does not reuse another database's storage. Local data from older single-YDB
scaffolds remains in its old volumes; it is not copied into the new per-database layout.

AI credentials are acquired only for declared AI templates/capabilities. Custom code
can opt in with `VIBECLOUD_LOCAL_AI=1 pnpm dev`. Ordinary HTTP and static applications
do not require AI authentication. The host watches the selected configuration and regenerates the full Compose model
and AI credentials on valid changes. Added databases start automatically, removed
services stop, and named volumes survive restarts. Invalid declarations leave the
current process running until a valid save. This also works with atomic file saves.

Each local Node.js deployment group runs in its own worker and retains module state between
requests. A successful rebuild replaces workers and disposes their timers and clients;
a failed rebuild preserves the complete previous output for both running and cold workers.
Builds stage complete generations before switching the `dist` link, retaining the
previous generation. In the dev container, these paths are under `/vibecloud-runtime`
in its private volume; host builds use the checkout's `.vibecloud/builds/` and `dist`.
Deployment snapshots are separate.
Do not repurpose these generated output directories for authored files.

`build.ts` calls the versioned `@vibecloud/cli/build` implementation. `vite.config.ts`
merges `@vibecloud/cli/vite` defaults with the app's plugins and settings. Keep custom
prebuild steps and scripts: adding resources preserves authored package scripts.

Terraform and Compose framework files carry a generated-content marker. `init`,
`dev`, and deployment refresh unchanged managed files from the installed CLI release;
Terraform keeps the same root directory and resource addresses. Put Terraform additions
in separate `.tf` files and Compose customizations in `infra/local.override.yaml`.
If you deliberately maintain a framework file yourself, remove its marker. An edited
marked file stops the operation with its path instead of being overwritten.

For older applications, migrate the unmodified `build.ts` and `vite.config.ts` once
to the matching package's thin entrypoints, preserving custom hooks. Infrastructure
files that exactly match current templates adopt managed updates automatically;
reconcile older customized files once or keep them app-owned. New AI handlers use
`@vibecloud/ai/http` policy helpers instead of copying policies into every handler.


## Upgrading to grouped functions

Merge the packaged `templates/project/build.ts` and `infra/main.tf` into an existing
application and update `@vibecloud/cli` together. The builder imports the versioned
`@vibecloud/cli/function-build` implementation; its router templates ship in the CLI.
Keep authored handlers in place. Adapt custom builders to their supplied output paths
and Python sibling imports to package-relative imports before rebuilding.

Terraform replaces old per-handler function resources with the new group resources
and repoints the gateway and triggers. Review this replacement plan and use a maintenance
window if interruption is unacceptable. Do not move several old resources to one new
address. Remove obsolete per-function `moved` blocks from older rename operations when
upgrading; keep database, bucket and trigger moves. New HTTP/WS/timer handler renames
leave their physical function and invoker binding stable; isolated stream renames move
both resources. Existing schedules and stream retry/DLQ settings remain declared per
logical handler. Grouping reduces function count, not timer/stream trigger count.

## Media and local lifecycle

Use `pnpm vibecloud add bucket images --public` for public media. Anonymous access
allows object reads only; uploads still use the runtime IAM token. General buckets
stay private unless `--public` is selected. The image template selects public media
by default. For an older image handler, add its public bucket, set the function's
`bucket` binding, update the handler to use `@vibecloud/storage`, and change the
browser from `response.blob()` to `(await response.json()).url`.

`pnpm dev` stores local media under `.vibecloud/media/` and serves declared public
objects directly. Its gateway preserves binary request bytes and enforces the
3.5 MB Cloud Functions JSON-envelope limit. Shared modules anywhere under `src/`
trigger backend rebuilds. Docker resources are scoped to the checkout's physical
path and carry an ownership label, so same-named checkouts cannot share data.
Use the printed OrbStack URL; it includes the checkout identity.

`pnpm vibecloud down` first stops this checkout's host controller, cancelling pending
startup and configuration restarts, then removes its containers and network while
preserving data. Only one `pnpm dev` controller can run per checkout. To also remove
its volumes and local media, use
`pnpm vibecloud down --volumes --confirm delete-local:<application-name>`.
Legacy name-based containers are not adopted or deleted automatically; stop those
once using their exact Docker project before starting the upgraded runtime.

## Publication and guidance upgrades

`pnpm push` publishes assets at immutable release paths and pins function calls to
that release's tag. The gateway switches only after all uploads, function versions,
and invocation permissions succeed. Timers and stream triggers also wait for the
complete upload and use explicit tags. Existing `$latest` integrations are pinned
to their deployed version by a narrow Terraform-managed compatibility hook before
code changes. The CLI reads the live gateway
specification before pinning or retaining assets, because the provider does not
refresh that specification in Terraform state. Retrying a failed push preserves
the version currently serving traffic. Trigger tag changes remain Terraform-owned
in-place updates. Artifact lineage is recorded by `terraform_data.release` only
after the invokers complete. Retention follows completed publication order and live
references, never build timestamps. Current, previous, and partially active assets
survive the next upload; older unreferenced generations are pruned on subsequent
pushes. Unknown legacy history is retained until lineage has been established. Custom asset builders receive `VIBECLOUD_ASSET_BASE`; use it for generated
asset references, as the Vite builder does automatically.

Checkouts deploying to the same application must use the same backend and workspace
with state locking enabled. Push recalculates retained assets if the state changes
during planning, then applies that saved plan under the backend lock. If another
deployment changes state after planning, Terraform rejects the stale plan; rerun
`pnpm push`. Planning stays internal to the push workflow.

Release downloads follow the configured asset routes. An asset without a route has
no public gateway downloads. Wildcard asset routes expose the mounted asset set;
exact routes expose only their selected file, including for retained releases.
Removing the routes also removes their release and legacy download paths.

Database migrations and infrastructure changes are not rolled back with a failed
release. Keep migrations and API changes compatible with clients from the preceding
release. Gateway, timers, and stream triggers are separate cloud updates; they do
not share a cross-service transaction. A failed push is reported and can be retried.

Untouched `AGENTS.md` and packaged project skills refresh on init, dev, and push.
Commit `.vibecloud/generated-guidance.json` with them: it records the generated
content hashes. Files retired from the package are removed only when they still
match their recorded hash; those removals roll back if a later project edit fails.
Customized or older untracked copies are preserved with a warning;
merge the installed CLI's `templates/project/AGENTS.md` and `skills/` deliberately.
Generated source handlers remain application-owned.

Run project management commands on the host. The development container owns its
processes and a private `app-runtime` build volume at `/vibecloud-runtime`; host
`dist` and deployment snapshots remain independent. This avoids sharing build locks
between the host and OrbStack kernels.
