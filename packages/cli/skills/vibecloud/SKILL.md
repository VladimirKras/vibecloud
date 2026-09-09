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
Install packages from Verdaccio or the configured npm-compatible registry;
preserve `.npmrc` and registry overrides for host and container installs.
Keep all `@vibecloud/*` dependencies on the project's exact CLI release. A
package 404 calls for checking that registry and version, not tarball overrides
or a switch to public npm.

## Initialize

```bash
pnpm dlx @vibecloud/cli@<published-version> init
```

Run from the target directory with its registry already configured. In the
Vibecloud source workspace, prefer the documented `pnpm local:init` helper,
which prepares Verdaccio settings and the selected release before bootstrap.

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

Resource additions and removals edit local files. Rename reconciliation reads the
configured Terraform backend and workspace, which may require network authentication.
Configuration mutations
validate the whole input and are written atomically; repeating the same
addition is a no-op. When a command prints `updated: package.json`, run
`pnpm install` before building.

Keep authored code lint-clean as it is produced. Run `pnpm lint` after each
substantial source edit instead of postponing all formatting until deployment.
For fixable lint failures, the generated package exposes the exact command
`pnpm lint:fix`; do not improvise argument forwarding with
`pnpm lint -- --fix` or bypass the package script with `pnpm exec eslint`.

## Implement generated source

YDB persistence and Better Auth accounts are optional. Choose them when the
application needs them. Only the authenticated `ai-agent` and `ai-turn`
templates require Better Auth and its YDB binding; custom `api` handlers can
use `@vibecloud/ai` directly. See [references/ai.md](references/ai.md) for both
paths and their IAM declarations.

- Vite assets start with a minimal themed Gravity UI page. `add auth` adds a
  ready Better Auth function, schema migration, generated secret, React client,
  and account panel; it mounts the panel only when the starter page is still
  untouched. For interface
  work, use the project-local Gravity UI skill at
  `.agents/skills/gravity-ui/SKILL.md`; it routes to the installed package's
  exact documentation and owns Gravity UI component, layout, and theme rules.
- HTTP templates return a small JSON response.
- `ai-agent` and `ai-turn` reuse Better Auth sessions for text and voice.
  `ai-image` exposes a public synchronous Alice AI ART endpoint: POST returns
  JSON `{ key, url, contentType, sizeBytes }` after uploading raw bytes to a public
  bucket. Render the ordinary URL directly. Signing is opt-in; no polling is needed. These templates use the
  function's short-lived service-account
  token. Custom server functions can use AI Studio, Alice AI ART, and SpeechKit
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
- Query application logs by the compiled deployment group's service name, such as
  `http-nodejs22`. Node invocation attributes include `vibecloud.function.name` for
  the logical handler.
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

Rename edits compose and validate Terraform history locally. `push` reads the selected
backend/workspace to discover asset-object moves; backend failures stop deployment,
not unrelated source edits. Keep complete rename chains for other states even after
an apply. Returning to an older name rotates the retained addresses toward the current
name. Commit `infra/moves.auto.tf`. Do not reuse a prior address for another resource
or remove its history until every affected backend/workspace has migrated.

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
```

Run application tests appropriate to the change and exercise the requested
flows through `pnpm dev`. When changing the Terraform implementation itself,
also initialize and validate it:

```bash
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra init -lockfile=readonly
TF_CLI_CONFIG_FILE="$PWD/infra/terraform.rc" terraform -chdir=infra validate
```

The committed provider lock covers Intel and ARM macOS, Intel and ARM Linux,
and Windows AMD64. When Vibecloud's pinned provider versions change, regenerate
it explicitly with `terraform providers lock -net-mirror=https://terraform-mirror.yandexcloud.net/`
and all five `-platform` values before committing the update.

Review the tfvars, authored source, Terraform, and `moves.auto.tf` diff before
deployment. Use `pnpm push` for normal deployment; it prepares the selected
Terraform inputs and builds an isolated artifact snapshot before applying.
Standalone `terraform plan` is an advanced diagnostic, not a required step.
It needs generated inputs selected with `-var-file` and their matching built
artifacts; running `pnpm build` alone does not prepare those inputs. A Terraform
plan does not validate YDB migration execution or application behavior.

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
pnpm vibecloud delete --status
```

Managed projects submit asynchronous deletion of their entire YC folder using
YC's default grace period. Set `--delete-after 24h` (or another non-negative
`HhMmSs` duration) to choose the delay. When the user requests immediate deletion,
use `pnpm vibecloud delete --confirm delete:application-name --delete-after 0s`.
This skips the recovery window; YC resource cleanup remains asynchronous. A bounded
status-check timeout is pending cleanup, not proof of deletion or a rejected request.
Preserve the receipt and report the observed state. If
deletion is already pending, cancel it in the YC console before resubmitting
with a different delay. Report the observed operation status, not completed
deletion when only submission is confirmed. Projects initialized with
`--folder-id` destroy only their Terraform resources, never delete the adopted
folder, and reject `--delete-after` and `--status`.

Deletion intent and the returned operation ID, scheduled time, and status are saved
under `deletion` in `.vibecloud/project.json`. Use `delete --status` without confirmation
to refresh that receipt; it does not submit deletion. Repeated confirmed delete calls
track the existing operation without changing its delay. A lost response is recovered
from folder operations. If submission remains unresolved, preserve the receipt and
retry status; never remove it to force another request. After a reported cancellation
or failure, a fresh confirmed delete can retry once the owned folder is active.
Explicit YC rejections are recorded as `rejected`; fix the cause and submit a new
confirmed request. Unknown transport outcomes remain `submitting`. Recovery excludes
pre-existing operation IDs and older timestamps, and refuses ambiguous matches. Use
`delete --status --operation <id>` to select the exact folder operation when timestamps
or multiple candidates prevent recovery. Never attach a pre-submission operation.
`doctor` reports the last recorded deletion status separately from initialization.

`push` checks lifecycle, builds an immutable snapshot, and applies one saved
Terraform plan. Terraform owns resource dependencies, state, locking, migrations,
and activation order. A failed migration stops dependent function publication;
Terraform retains partial progress for retry. The CLI also creates or
updates the app's Monium **Serverless RED** dashboard and prints both the
gateway and dashboard URLs. The dashboard separates API Gateway and Cloud
Functions charts; use its single Function selector to inspect one function's
rate, errors, and p95 duration without combining histograms. `db up` is a
migration-only command for already-provisioned databases; it skips build and
Terraform apply and reads migration files directly from `src/`. It holds the project
operation lock and reloads configuration after acquiring it.

Vibecloud uses the YDB adapter's Drizzle migration runner, but Drizzle Kit does
not currently provide a YDB dialect for schema-diff generation. Keep the
TypeScript Drizzle schema authoritative for application queries, author and
review the corresponding YDB SQL migration, and use a new ordered file for each
change. Applied files are immutable because the runner records their hashes.
Distinct identities with identical SQL are rejected, including against existing history.
To recover a failed or stale migration, inspect partial effects, verify the old process
stopped, then run `pnpm vibecloud db up --retry-interrupted`. This deliberately replays
from the first statement, retaining the distributed lock and immutable checks; running
history must be at least one hour old. Automatic migration paths do not opt into replay.

Use an authenticated `yc` CLI; `push`, `db up`, and `delete` obtain the IAM
token and cloud ID from its active profile when `YC_TOKEN` and `YC_CLOUD_ID` are
unset. The folder ID comes from project metadata, even when the active profile or
`YC_FOLDER_ID` names another folder. Never print or commit
credentials. Browser authorization may open during `yc iam create-token`.

The default backend is local and deployment applies immediately. Vibecloud's
normal scope is internal serverless prototyping; a separate preview, approval
workflow, or remote backend is not a prerequisite. Multiple checkouts or CI jobs
deploying to the same app must share a backend and workspace with state locking.
Push checks that its retention inputs and internal saved plan use the same state;
Terraform rejects a saved plan made stale by another deployment. Rerun `pnpm push`
after that deployment finishes. Destruction requires
the exact confirmation and never deletes the checkout.

For local full-stack work, use the single `pnpm dev` entrypoint (`npm run dev`
invokes the same package script). It bind-mounts the host project at
`app:/workspace` and runs Vite, built-in Node.js HTTP functions, migrations,
and YDB in one watched Docker Compose project on OrbStack. Local development
requires its `.orb.local` routing; no host ports are published.
There is no source-copy step or separate watcher container. Vite watches assets,
Vibecloud rebuilds functions and applies migrations. Its host watcher reloads the
selected declaration, regenerates the full Compose model and AI credentials, and
recreates services while retaining named volumes. New databases start without a manual
restart; invalid declarations keep the current process until a valid save. Compose
Watch restarts/rebuilds `app` for package, build, Vite, or Dockerfile changes.
Use the printed checkout-specific `.orb.local` URLs. OrbStack serves them over HTTP and
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

Built-in local Node HTTP functions use the compiled group's memory value and
deadline in their context. Exceeding the timeout terminates the worker, fails its
in-flight requests, and returns HTTP 504; the next request starts a fresh worker.
The memory value does not impose a local process memory cap.


### Function deployment groups

Keep logical handlers in `src/functions/<name>`. HTTP (including AI and auth),
WebSocket, and timer handlers share one physical function per type and exact runtime.
Memory and timeout are the maximum of the members. The generated build imports
`@vibecloud/cli/function-build`; do not restore per-handler deployment bundles.
Use `function_groups` in `dist/deployment-plan.json` to inspect the grouping. Data Streams consumers stay
isolated because provider batches carry no stream identity. Timers keep their original
configured payload at the handler boundary. Use relative sibling imports in grouped
Python handlers and the supplied output environment variable in custom builds.
Update both `build.ts` and `infra/main.tf` when upgrading older applications; inspect
Terraform replacements before deploying. Logical HTTP/WS/timer renames do not move
physical function resources.

## Framework upgrades and builds

Keep `build.ts` as a thin call to `@vibecloud/cli/build` and merge app-specific Vite
settings with `@vibecloud/cli/vite`. Preserve authored scripts and prebuild hooks.
Managed Terraform/Compose files refresh from the installed release when unchanged.
Use separate `.tf` files and `infra/local.override.yaml` for customizations. An edited
managed file must be reconciled or explicitly made app-owned by removing its marker;
do not overwrite it blindly. Older copied builders need a one-time migration to the
thin entrypoint. Failed builds preserve the entire last successful output. Treat
`dist`, `.vibecloud/builds/`, and `infra/.packages/` as generated directories.

`push` may use native refresh-only apply to record existing state and retained
renames, then applies one saved resource-changing plan. Terraform orders migration
hooks before function publication and holds its backend lock through those effects.
Failed applies preserve partial progress and the attempted snapshot; fix the reported
problem and rerun `pnpm push`. Whole-folder deletion remains a separate YC operation.
For architecture or recovery work, consult the installed
`node_modules/@vibecloud/cli/ARCHITECTURE.md`; ordinary application work stays on the
logical resource commands, `pnpm dev` and `pnpm push`.


Public image URLs are the default image-template flow. Use `@vibecloud/storage`
with the function IAM token for uploads; keep image bytes out of function response
JSON. `add bucket images --public` enables anonymous reads only. The generic bucket
command remains private by default. Do not add signing, reservations, checksum
handshakes, auth, or a database unless the application's requirements call for them.

During push, immutable release assets and tagged function versions are prepared
before gateway activation. Current and previous assets remain available for existing
clients. Use `VIBECLOUD_ASSET_BASE` in custom asset builders. Migrations and APIs must
remain compatible with preceding clients; infrastructure changes and separate trigger
updates are not one cloud transaction.

Only routed assets receive release download URLs; exact routes expose only their
selected file. Removing the asset routes removes those downloads too. Retained URLs
survive asset renames. Push reads the live gateway specification before migrating
legacy invokers or choosing retained assets, so failed deployment retries preserve
the version still serving traffic. Trigger tags update in place through Terraform.
Bucket renames preserve local image bytes and URLs; commit
`.vibecloud/local-buckets.json` when the CLI generates it during a rename.
Database renames preserve service names, endpoints and volumes; commit
`.vibecloud/local-databases.json` when generated too.

Local binary requests preserve bytes and observe the cloud's 3.5 MB envelope limit.
Shared modules under `src/` trigger backend rebuilds. Docker identities are scoped to
the checkout path; use the printed URL. `pnpm vibecloud down` stops this checkout's
host controller, including pending startup and restarts, before removing its
containers/network while preserving data. Only one dev controller runs per checkout.
Add `--volumes --confirm delete-local:<name>`
only when local data removal is requested; it removes local media too.

Untouched project guidance refreshes with the installed CLI on init, dev, and push.
Retired files are removed only if their content still matches the generated hash.
Commit `.vibecloud/generated-guidance.json`. Customized/untracked guidance is preserved
with a warning; reconcile it against the installed package's templates and skills.

Templates scaffold source and expand defaults into explicit `kind`, `features`,
`runtime`, memory and timeout fields. Keep those fields aligned with the authored
handler when changing its capabilities; removing a template label does not change
runtime policy. Event types remain separate type-only packages. `pnpm dev` reports
cloud-only functions: WebSockets, timers, streams and non-Node handlers require
cloud acceptance. Node.js HTTP handlers, Vite, local media and YDB run locally.

Local edit journals cover reversible source changes only. Failed cloud commands retain
operation receipts and Terraform progress. Deletion blocks push and cloud migrations;
YC folder status is checked before cloud work. Serialize whole-folder deletion with
other checkouts: YC folder deletion is outside Terraform's resource transaction.

Run project management commands on the host. The development container owns its
processes and a private `app-runtime` build volume at `/vibecloud-runtime`; host
`dist` and deployment snapshots remain independent. This avoids sharing build locks
between the host and OrbStack kernels.
