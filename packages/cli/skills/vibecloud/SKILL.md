---
name: vibecloud
description: Initialize, author, validate, deploy, and destroy pnpm-based Vibecloud applications backed by checked-in Terraform under infra/. Use for assets, buckets, YDB databases and streams, Cloud Functions, HTTP or WebSocket routes, timer or Data Streams triggers, generated secrets, builds, and deployments.
---

# Work with Vibecloud

Treat `infra/vibecloud.auto.tfvars.json` as Terraform input and the remaining
`infra/*.tf` files as the infrastructure implementation. Do not invent a
parallel configuration format or provider-ID file.

## Inspect first

Before changing a project, read:

1. `infra/vibecloud.auto.tfvars.json`
2. the relevant `infra/*.tf`
3. `package.json`
4. [references/resources.md](references/resources.md)
5. [references/ydb.md](references/ydb.md) when YDB or Better Auth is involved
6. [references/ai.md](references/ai.md) when AI Studio, SpeechKit, image
   generation, agents, or realtime audio is involved

Use the installed CLI through `pnpm vibecloud`. Use `pnpm dlx` only to
initialize a project that does not yet have the CLI installed.

## Initialize

```bash
pnpm dlx @vibecloud/cli init
```

Initialization creates Terraform, build tooling, this skill, package metadata,
the managed YC folder, and an installed pnpm workspace, but no application
resources or `src/` tree. Pass
`--folder-id <id>` to adopt an existing YC folder instead; otherwise Vibecloud
creates and owns a dedicated folder named after the application. Commit
`.vibecloud/project.json`; its stable project UUID and YC label make interrupted
initialization safely resumable without creating duplicate folders. Terraform
always consumes the resolved folder ID and never owns the folder resource.
Rerun `init` to resume incomplete phases. Use `pnpm vibecloud doctor` for
identity, folder, state, and Docker diagnostics, and `doctor --repair` for
resumable repairs. Pre-release scaffolds are not migrated; initialize a new
directory when adopting a newer scaffold contract.

## Author through logical resources

Prefer the CLI for supported edits:

```bash
pnpm vibecloud add --help
pnpm vibecloud add function --help
pnpm vibecloud add asset --help
```

The root help lists every template and ready feature with a copyable command.
The function and asset help pages add aliases, runtime support, and safety
constraints. Then use the appropriate resource command:

```bash
pnpm vibecloud add asset website --template vite --route '/*'
pnpm vibecloud add function api --template api --route '/api/*'
pnpm vibecloud add database primary --migrations
pnpm vibecloud add auth --database primary
pnpm vibecloud add function agent --template ai-agent --route /api/agent
pnpm vibecloud add function assistant --template ai-turn --route /api/turn
pnpm vibecloud add function illustrator --template ai-image --route /api/images
pnpm vibecloud add function game --template websocket --route /ws
pnpm vibecloud add function cleanup --cron '0 * ? * * *'
pnpm vibecloud add stream primary.events
pnpm vibecloud add function worker --template datastream-trigger
pnpm vibecloud add trigger worker --stream primary.events
pnpm vibecloud add bucket uploads
pnpm vibecloud add secret WEBHOOK_SIGNING_KEY
pnpm vibecloud list
```

Use `--route` while creating an asset or function whenever its first route is
already known. Reserve `add route` for additional routes. Create other
dependencies before consumers: database before stream, and stream plus function
before trigger. Remove them in the opposite order.

Commands are local and do not contact Yandex Cloud. Configuration mutations
validate the whole input and are written atomically; repeating the same
addition is a no-op. When a command prints `updated: package.json`, run
`pnpm install` before building.

Keep authored code lint-clean as it is produced. Run `pnpm lint` after each
substantial source edit instead of postponing all formatting until deployment.
For fixable lint failures, the generated package exposes the exact command
`pnpm lint:fix`; do not improvise argument forwarding with
`pnpm lint -- --fix` or bypass the package script with `pnpm exec eslint`.

## Implement generated source

- Vite assets start with a minimal themed Gravity UI page. `add auth` adds a
  ready Better Auth function, schema migration, generated secret, React client,
  and account panel; it mounts the panel only when the starter page is still
  untouched. For interface
  work, use the project-local Gravity UI skill at
  `.agents/skills/gravity-ui/SKILL.md`; it routes to the installed package's
  exact documentation and owns Gravity UI component, layout, and theme rules.
- HTTP templates return a small JSON response.
- `ai-agent` and `ai-turn` reuse Better Auth sessions for text and voice.
  `ai-image` exposes a public asynchronous YandexART endpoint: POST starts a
  generation and GET polls its operation ID. These templates use the
  function's short-lived service-account
  token. Custom server functions can use AI Studio, YandexART, and SpeechKit
  through `@vibecloud/ai` from the first version without provisioning a
  separate production API key. Local development can use credentials from the
  active `yc` profile. Better Auth controls application users and is separate
  from the function's authorization to call Yandex Cloud AI. Keep AI
  credentials and Realtime connection headers in trusted server code; read
  [references/ai.md](references/ai.md) before adding browser audio.
- WebSocket templates implement lifecycle handling and message echo.
- Cron and Data Streams templates deliberately throw until implemented. Never
  deploy them unchanged: a no-op stream consumer would silently discard data.
- Read [references/ydb.md](references/ydb.md) before publishing to a declared
  stream or persisting triggered work.
- Function handlers keep both `event` and `context` parameters visible.
- Infrastructure owns request and invocation logs. Do not add duplicate
  request-received, request-completed, or invocation-received logs.
- Use `structuredLog` from `@vibecloud/telemetry` for business operations and
  handled errors. Never pass an object as a second argument to `console.log`:
  Node may format it across lines and YC stores each line as a separate entry.
- Query correlated application logs by the logical function service name.
  Treat YC `START`, `END`, `REPORT`, and gateway records under service
  `default` as a separate platform stream; those records cannot carry the
  handler's application trace or span IDs.

Node templates use the exact-version contracts in
`@vibecloud/function-api`, `@vibecloud/function-ws`,
`@vibecloud/function-trigger-cron`, and
`@vibecloud/function-trigger-datastream`.

YDB-backed Node functions must wrap the complete invocation with
`withYdb(endpoint, work)` from `@vibecloud/db`; nested application code can use
`getYdb()`. This creates and closes the `@ydbjs/drizzle-adapter` database at the
invocation boundary. Define application tables through
`@ydbjs/drizzle-adapter/schema` and prefer Drizzle query builders. Use
`@vibecloud/db/better-auth` for Better Auth; it is the YDB-specific Better Auth
adapter implemented on the same driver and query pool. For YDB operations that
Drizzle cannot express, reuse that pool through `getYdbQueryClient()` and name
the operation with `ydbQuery()`.

## Preserve source and identity

`src/` is authored source; `dist/` is build output. Never edit `dist/` as
source.

Rename commands update references and source directories and append Terraform
`moved` blocks. Preserve those blocks in version control:

```bash
pnpm vibecloud rename function api backend
pnpm vibecloud rename stream primary.events primary.changes
```

Remove commands change infrastructure declarations only. They deliberately
keep authored source and package dependencies; remove those separately after
review.

Do not put provider-issued IDs or plaintext secret values in tfvars. Generated
secrets use empty declaration objects and are stored in Lockbox.

## Verify

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm vibecloud doctor
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra init -lockfile=readonly
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra validate
```

The committed provider lock covers Intel and ARM macOS, Intel and ARM Linux,
and Windows AMD64. When Vibecloud's pinned provider versions change, regenerate
it explicitly with `terraform providers lock -net-mirror=https://terraform-mirror.yandexcloud.net/`
and all five `-platform` values before committing the update.

Review the tfvars, authored source, Terraform, and `moves.auto.tf` diff before
deployment. Build before `terraform plan` because Terraform hashes `dist/`.

After deployment, verify the application rather than only the infrastructure:

1. Exercise static and API routes independently.
2. For scheduled pipelines, poll with a bounded timeout until at least two
   distinct events reach durable state. A new Data Streams trigger can take a
   few minutes to become active.
3. Inspect the newest producer and consumer logs by timestamp and function
   version. Older retry errors remain visible after a corrected deployment.

Seeing records in a stream proves publication, not consumption. Do not report
the pipeline as working until its intended state or side effect advances.

## Deploy and destroy

```bash
pnpm push
pnpm vibecloud db up
pnpm vibecloud delete --confirm delete:application-name
```

Managed projects submit asynchronous deletion of their entire YC folder using
YC's default grace period. Projects initialized with `--folder-id` destroy only
their Terraform resources and never delete the adopted folder.

`push` builds, applies the declared YDB databases first, runs pending YDB
Drizzle migrations from the built `dist/` snapshot, and performs the complete
application apply only after migration success. It also creates or
updates the app's Monium **Serverless RED** dashboard and prints both the
gateway and dashboard URLs. The dashboard separates API Gateway and Cloud
Functions charts; use its single Function selector to inspect one function's
rate, errors, and p95 duration without combining histograms. `db up` is a
migration-only command for already-provisioned databases; it skips build and
Terraform and reads migration files directly from `src/`.

Vibecloud uses the YDB adapter's Drizzle migration runner, but Drizzle Kit does
not currently provide a YDB dialect for schema-diff generation. Keep the
TypeScript Drizzle schema authoritative for application queries, author and
review the corresponding YDB SQL migration, and use a new ordered file for each
change. Applied files are immutable because the runner records their hashes.

Use an authenticated `yc` CLI; `push`, `db up`, and `delete` obtain the IAM
token, cloud ID, and folder ID from its active profile. Explicit `YC_TOKEN`,
`YC_CLOUD_ID`, and `YC_FOLDER_ID` values take precedence. Never print or commit
credentials. Browser authorization may open during `yc iam create-token`.

The default backend is local. Configure protected remote state before
multi-machine or concurrent CI deployment. Destruction requires the exact
confirmation and never deletes the checkout.

For local full-stack work, use the single `pnpm dev` entrypoint (`npm run dev`
invokes the same package script). It bind-mounts the host project at
`app:/workspace` and runs Vite, built-in Node.js HTTP functions, migrations,
and YDB in one watched Docker Compose project. Docker Desktop, Colima, Linux
Docker, CI, and OrbStack are supported; OrbStack domains are optional aliases.
There is no source-copy step or separate watcher container. Vite watches assets,
Vibecloud rebuilds functions and applies migrations, and Compose Watch restarts
or rebuilds `app` when its configuration changes. Ordinary Docker publishes the
app on `localhost:5173`, function routes on `localhost:8787`, and YDB monitoring
on `localhost:8765`. OrbStack serves its `.orb.local` aliases over both HTTP and
HTTPS on IPv4 and IPv6; generated auth handlers preserve its forwarded HTTPS
origin. `pnpm dev` prefers an explicit API key, then an explicit IAM token, then
obtains a temporary IAM token from the active `yc` profile.
Do not replace this flow with an ad hoc Vite command: Vibecloud starts Vite
with the generated config and connects its API proxy, functions, credentials,
and YDB. Use `pnpm vibecloud doctor` for container diagnostics when startup
fails. A project initialized but not yet deployed legitimately has no
Terraform state; its managed YC folder and `folder_id` are already sufficient
for local AI calls.
Keep cloud-only trigger, WebSocket, and custom-runtime behavior covered separately.
