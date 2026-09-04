# Vibecloud

Vibecloud scaffolds and deploys serverless Yandex Cloud applications through
checked-in Terraform. The CLI edits Terraform inputs, creates source templates,
builds deployable artifacts, applies Terraform, and runs optional YDB migrations.

Published packages share one version:

- `@vibecloud/cli`: CLI, Terraform, source templates, and agent skill.
- `@vibecloud/function-api`: HTTP payload-format-1.0 types.
- `@vibecloud/function-ws`: WebSocket lifecycle types.
- `@vibecloud/function-trigger-cron`: timer event types.
- `@vibecloud/function-trigger-datastream`: Data Streams event types.
- `@vibecloud/ai`: authenticated typed Yandex AI Studio resources, SpeechKit,
  and server-side Realtime helpers.
- `@vibecloud/db`: invocation-scoped YDB Drizzle access, Better Auth adapter,
  and migration runner.
- `@vibecloud/telemetry`: application OpenTelemetry helpers.

Generated projects pin every `@vibecloud/*` dependency to the exact CLI
version that created them.

## Requirements

- Node.js 26 or newer
- pnpm 11.15.1
- Terraform 1.6.3 or newer, below 2.0
- An authenticated Yandex Cloud CLI (`yc`) for `init`, `push`, `db up`, and `delete`

Generated Cloud Functions default to Yandex Cloud's `nodejs22` runtime. The
Node.js 26 requirement applies to local tooling, not the deployed runtime.

## Initialize

```bash
mkdir my-app
cd my-app
pnpm dlx @vibecloud/cli init
```

The directory name becomes the application name. Initialization creates the
managed YC folder through the authenticated `yc` CLI, then creates an empty
Terraform application, build tooling, `AGENTS.md`, and project-local Vibecloud
and Gravity UI skills under `.agents/skills/`, and runs `pnpm install`. It
creates no application resources or `src/` tree until they are requested.

Commit `.vibecloud/project.json`. It records a stable project UUID, resolved YC
folder ID, managed or external lifecycle, metadata/scaffold versions, and the
current `scaffolded`, `folder_created`, or `ready` phase.
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
pnpm dlx @vibecloud/cli init --folder-id <folder-id>
```

An adopted folder is never created, renamed, or deleted by the generated
project. Initialization verifies that it exists and is active before writing
the project configuration. Terraform always receives the resolved folder ID
and never creates or deletes a YC folder itself.

Generated infrastructure uses one runtime service account for functions,
triggers, and API Gateway integrations. It includes the
`ai.languageModels.user` role so functions can call Yandex Cloud language
models; additional roles are enabled from the declared resources.

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

Resource edits are local and do not contact Yandex Cloud. Each configuration
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

For YandexART, add a public asynchronous endpoint without Better Auth or YDB:

```bash
pnpm vibecloud add function illustrator --template ai-image --route /api/images
```

POST starts generation and returns an operation ID. GET with that ID returns
progress or the completed base64 JPEG. The template uses YandexART's native
asynchronous API and grants `ai.imageGeneration.user` automatically.

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
│   └── container-only node_modules and pnpm store
└── ydb
    └── persistent database and certificates
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

All runtime processes and data services run in Docker Compose. Vibecloud works
with Docker Desktop, Colima, Linux Docker, CI daemons, and OrbStack. Ordinary
Docker publishes localhost ports:

| Address | Purpose |
| --- | --- |
| `http://localhost:5173` | Primary Vite application |
| `http://localhost:8787` | Declared local HTTP function routes |
| `grpc://localhost:2136/local` | YDB endpoint for host tools |
| `http://localhost:8765` | YDB monitoring UI |

When OrbStack is the active Docker context, Vibecloud also retains the
`<project>.orb.local`, `app.<project>.orb.local`, and
`ydb.<project>.orb.local` convenience domains. OrbStack terminates TLS, so both
`http://<project>.orb.local` and `https://<project>.orb.local` reach the app.
Vibecloud services bind to the IPv4/IPv6 dual-stack address, and generated
Better Auth handlers honor OrbStack's `X-Forwarded-Proto` header so secure
origins and cookies remain correct over HTTPS.

### What watches what

| Host change | Watch owner | Result inside Compose |
| --- | --- | --- |
| `src/assets/**` | Vite polling watcher | Frontend hot reload |
| `src/functions/**` | Vibecloud function watcher | Rebuild; the next request loads the new handler |
| `src/databases/**/migrations/**` | Vibecloud migration watcher | Apply pending YDB migrations |
| Terraform input, `package.json`, `build.ts`, or `vite.config.ts` | Compose Watch | Restart `app` |
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
- functions: `dist/functions/<name>`
- migrations: `dist/databases/<name>/migrations`

The built-in builder bundles TypeScript for `nodejs*`, and copies Python or Go
source for Yandex Cloud's builders. A custom runtime requires `build.command`,
which must create `dist/functions/<name>`.

HTTP functions return the Yandex API Gateway payload-format-1.0 response shape.
This API Gateway integration buffers responses; it does not provide HTTP
response streaming. WebSocket functions use API Gateway WebSocket operations.

Function and gateway infrastructure owns request and invocation logging.
Application code should emit only business telemetry and handled-error details
through `structuredLog`, which sends one correlated OTLP record to Monium and
preserves the same one-line JSON record in container output.
Enabling Monium observability injects credentials and exporter settings; newly
scaffolded Node.js functions receive traced templates, while existing source is
never overwritten.

`observability.logs` controls correlated application OTLP logs.
`observability.platform_logs` separately controls YC gateway and function
runtime logs. Each app uses Monium project `folder__<project-folder-id>`, its
configured cluster, and the logical function key (`api`, `worker`, and so on)
as the application service. YC-owned `START`, `END`, `REPORT`, and gateway
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

`push` builds the application and initializes Terraform. When migrations are
enabled, it first applies only the declared YDB database resources and their
dependencies, runs pending YDB Drizzle migrations from the built `dist/`
snapshot, and only then applies the complete configuration and activates new
function code. A failed migration therefore leaves the previous application
revision active. Projects without migrations go directly to the complete
apply. The command then prints the gateway and Monium dashboard URLs.

`pnpm vibecloud db up` skips the build and Terraform apply. It applies pending
migrations directly from `src/databases/<name>/migrations` to every enabled,
already-provisioned database found in the current Terraform state. Use it for
migration-only updates after the initial `push`.

The YDB adapter uses TypeScript Drizzle schemas and a Drizzle migration runner,
but Drizzle Kit does not currently have a YDB dialect for generating schema
diffs. Keep each schema change with reviewed, ordered YDB SQL such as
`001_create_users.sql`; separate multiple statements with
`--> statement-breakpoint`. The runner records hashes and uses a YDB-backed
distributed lock, so applied files remain immutable.

Vibecloud preserves `YC_TOKEN`, `YC_CLOUD_ID`, and `YC_FOLDER_ID` when set. It
fills any missing values from the active `yc` profile using `yc iam
create-token`, `yc config get cloud-id`, and `yc config get folder-id`; browser
authorization may open as part of the configured CLI login flow.
For deployment, it also resolves the authenticated principal with `yc iam
whoami` and grants that principal only `iam.serviceAccounts.user` on the
generated runtime service account. Token-only CI must set `YC_SUBJECT` to the
full `userAccount:<id>`, `serviceAccount:<id>`, or `federatedUser:<id>` subject.

Initialized projects use local Terraform state under `infra/`. Configure a
protected remote backend before multi-machine or concurrent CI deployment.

Direct Terraform inspection remains available after building:

```bash
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra init -lockfile=readonly
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra validate
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra plan
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

The exact confirmation is required. For a managed project, Vibecloud submits
asynchronous deletion of the entire YC folder using YC's default grace period
and returns immediately. For a project initialized with `--folder-id`, it runs
`terraform destroy` for the application resources and leaves the adopted
folder intact. Neither path deletes the local checkout.

Detailed fields and limits are in the bundled
[resource reference](skills/vibecloud/references/resources.md), and YDB
patterns are in the [YDB reference](skills/vibecloud/references/ydb.md).
Initialized projects also include the vendored upstream
[Gravity UI skill](skills/gravity-ui/SKILL.md).
