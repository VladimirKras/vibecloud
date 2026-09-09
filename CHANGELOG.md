# Changelog

All notable Vibecloud changes are documented here. The workspace packages share
one version and are released together.

## [Unreleased]

### Changed

- Ship a maintained architecture reference with the CLI and align README/agent
  guidance with Terraform-owned publication, host SQLite locks, OrbStack build
  isolation, capability-scoped IAM, grouped telemetry and asynchronous deletion.
  Document the upstream YDB adapter's selected-row type limitation and distinguish
  live deployment evidence from pending cleanup and unverified coverage.

- Normalize template defaults into explicit function kinds, capabilities and runtime
  limits. Build, IAM, generated dependencies and local support reporting share that policy.
- Let Terraform own one saved publication plan, backend locking and partial-apply
  recovery. Run database migrations and narrow legacy pin hooks inside its graph;
  retain assets using completed release lineage and observed invoker references.
- Require OrbStack for local development, using `.orb.local` without host-port
  publishing. Separate container build output from host builds and deployment snapshots.
- Use process-lifetime SQLite locks for host operations and drain owned local children
  and watchers on shutdown. Keep source edit journals separate from cloud receipts;
  block publication and cloud migrations while deletion is unresolved.
- Align deployed SDKs with Node 22, reserve invocation cleanup time and make telemetry
  initialization failure non-fatal. Verify the exact complete registry candidate with
  SDK and compiled handler checks on Node 22 and 26 before promoting consumer tags.
- Provision CI verification tools explicitly. Live acceptance installs the exact registry
  candidate, resolves physical functions from compiled state, and retains unconfirmed
  deletion receipts without expiry.

- Store generated image bytes through the new `@vibecloud/storage` package and return
  ordinary public URLs with metadata. The image template declares a public bucket;
  private access and signing stay opt-in. Local storage serves the same URL contract.
- Publish immutable release assets and tag function versions before gateway activation.
  Pin legacy invokers before updating code; retain preceding assets across failed pushes.
- Read the live gateway specification for retry-safe legacy pinning and asset retention.
  Restrict release downloads to routed assets and preserve retained URLs across renames.
  Preserve local bucket storage identities and image URLs across chained renames.
  Verify consecutive trigger tag updates with the pinned Terraform provider.
- Recompute retained assets when another checkout changes the shared deployment state
  during planning, then apply the checked saved plan under Terraform's backend lock.
- Stop the host development controller before local teardown, including pending startup
  and configuration restarts. Keep local database services and volumes across renames.
- Remove retired generated guidance only when its recorded content is unchanged;
  include removals in project edit recovery and preserve authored files.
- Preserve local binary requests, enforce cloud payload limits, and rebuild on shared
  source edits. Isolate Docker resources by checkout with verified ownership labels;
  add `down` and explicitly confirmed local-data removal.
- Refresh untouched generated instructions using committed content hashes and preserve
  customized guidance with visible upgrade instructions.

- Migrate image generation to Alice AI ART through the synchronous Images API.
  Remove the retired YandexART client, operation types and endpoint overrides.
  `ai-image` now returns a completed image in one POST, validates 500-character
  prompts and supported sizes, and uses `ai.models.user` with a 120-second default
  timeout. Existing apps must remove operation polling; upgrade SDK, CLI, handler
  and guidance together. No compatibility alias calls the retired API.

- Preserve custom project scripts and the entire previous build after compilation failures.
- Restrict build output to CLI-owned directories and reject source/state symlink aliases.
- Move build/Vite machinery into versioned CLI exports; refresh unchanged managed
  Terraform/Compose files while keeping the same resource addresses and authored overrides.
- Keep local config edits independent of Terraform backend availability; record pending
  renames with refresh-only apply before migration staging.
- Remove blanket apply retries, the redundant function-group manifest, and unused dev plumbing.
- Keep event types in their separate type-only packages.

- Add `delete --delete-after <duration>` for managed YC folders, including `0s`
  to skip the grace period. Preserve confirmation and ownership checks; reject
  deletion delays for adopted folders.

- Compile deployment grouping, runtime defaults, gateway transport and AI capabilities
  once for builders, Terraform and local tooling. Deployment artifacts use isolated
  directories; existing applications must update their build and Terraform templates.

- Trim duplicated router and build code: order routes once during the build,
  share custom function/asset execution, and consolidate Go gateway metadata parsing.
  Regression coverage now exercises handler additions/removals and stable physical
  function identities across mocked Terraform applies.
- Deploy HTTP, WebSocket and timer handlers through internal routers, with one
  Cloud Function per invocation type and exact runtime. Preserve separate Data
  Streams consumers because their events contain no source identity. Share the
  largest memory/timeout setting, local workers and platform monitoring per group.
- Generate Node, Python and Go routers from a versioned CLI build module; preserve
  logical source folders, timer payloads, HTTP path parameters and invocation
  context. Existing projects must upgrade the build and Terraform templates together.

- Consolidated AI HTTP policy, authentication setup, invocation context types,
  process execution and filesystem helpers. Telemetry declarations are generated
  from source; build-time instrumentation replaces copied traced templates.
- Local development starts only declared services and gives each database its own
  volumes and endpoint. Existing local database volumes are preserved separately.
- Added `vibecloud orphans` to report retained source and obsolete generated
  dependencies without deleting authored files.

- Migrated the remaining JavaScript tests, ESLint configurations, and skill
  installer source to TypeScript. Tests and lint use native Node.js TypeScript
  support; the published installer is compiled to JavaScript.

- Migrated repository scripts and the generated project build script to
  TypeScript, run directly by Node.js 26 and checked by TypeScript before tests
  and project builds.

### Fixed

- Retain complete Terraform rename chains across backends/workspaces and refresh
  asset object moves before apply, including reverse renames and lagging states.
- Reject duplicate SQL migration identities instead of silently skipping them.
  Add explicit interrupted-migration recovery through `db up --retry-interrupted`
  and the SDK, preserving immutable-history checks and distributed locking.
- Allow retry after explicit deletion rejection, exclude pre-existing operations
  from lost-response recovery, and support exact `delete --status --operation` selection.
- Watch declaration edits on the host, regenerate Compose services and AI credentials,
  and restart local services automatically without deleting named volumes.

- Reconcile renames against the configured Terraform backend and workspace, fail
  closed on unreadable state, and move tracked asset objects along with buckets.
- Serialize `db up` with other project mutations and reload configuration under
  the lock before selecting migrations.
- Apply compiled group memory/deadline values to local invocation context and
  terminate workers that exceed the configured timeout.
- Persist managed folder deletion intent and operation receipts. Add `delete
  --status`, recover lost submission responses, and track repeat requests without
  submitting another deletion.

- Make bootstrap and project guidance use Verdaccio or the configured npm-compatible
  registry, distinguish optional auth/storage from AI template requirements, and
  keep deployment on `pnpm push`. Local bootstrap now reads its exact-release
  exclusions without disabling pnpm's release-age policy for other packages,
  and preserves the generated project's build-script approvals.

- Revalidate migration identities on every attempt under the distributed lock,
  including retries after an interruption; prune old validation checkpoints.
- Keep configuration, scaffold files and package updates in one recovery journal.
- Compose Terraform rename chains without cycles when returning to an old name.
- Preserve exact frontend API proxy routes when requests include query strings.

- Serialize project mutations and recover interrupted multi-file edits. Build and
  Terraform use one complete selected configuration snapshot.
- Reject changed applied migrations under the distributed migration lock, retain
  local function state between requests, and isolate telemetry/cleanup failures.
- Protect GitHub snapshot publication with an explicit force-with-lease.
- Handle functions without templates in evaluated Terraform plans. Acceptance now
  checks configuration precedence, separate databases, invocation permissions and
  local Compose service isolation.

- Preserve trigger identities when renaming a function among multiple stream
  consumers.
- Update endpoint environment-variable names in bound Better Auth and AI
  handler modules when renaming a database, with rollback on write failures.
- Decode base64 gateway request bodies in the AI agent, image, and multimodal
  turn templates before parsing JSON.
- Reject explicit HEAD routes that conflict with generated asset HEAD routes,
  including the root route generated by `/*`.

## [0.1.0] - 2026-08-31

Vibecloud 0.1 is the first coherent release of the current workspace and
generated-project contract.

### Platform

- Added resumable, idempotent project initialization with committed project
  identity, CLI-managed YC folders, interrupted-folder recovery, diagnostics,
  adopted-folder validation, and asynchronous default-grace deletion.
- Added portable local development for OrbStack, Docker Desktop, Colima, Linux,
  and CI, including IPv4/IPv6 localhost access and automatic local AI
  credentials from an API key, IAM token, or active `yc` profile.
- Added declarative HTTP, WebSocket, cron, Data Streams, asset, YDB, bucket,
  secret, AI, Better Auth, telemetry, and monitoring resources.
- Added capability-scoped runtime roles, resource-level function invocation,
  deployer authorization for the runtime service account, and valid API Gateway
  OpenAPI generation.

### Runtime packages

- Added Yandex AI Studio Responses, embeddings, files, vector stores, image
  generation, signed continuations, server-side Realtime, and SpeechKit-backed
  multimodal turns.
- Added YDB Drizzle queries, transactions, migrations, streams, retry
  observability, and a Better Auth adapter.
- Added HTTP, WebSocket, cron, and Data Streams event contracts plus structured
  logging, metrics, and tracing helpers.

### Reliability and release

- Added portable pinned Terraform provider locks and read-only deployment
  initialization.
- Added atomic resource editing, cron validation, custom Vite configuration,
  generated WebSocket lifecycle verification, and least-privilege role tests.
- Added deterministic tarball staging, license and file-list validation,
  resumable byte-identical Verdaccio publishing, single-commit provenance, and
  atomic branch/tag pushing.
- Added hermetic packed-CLI project acceptance and opt-in live YC acceptance for
  HTTP, WebSocket CONNECT/MESSAGE/DISCONNECT, cron, structured logs, zero drift,
  and asynchronous cleanup.
- Failed non-cloud and live acceptance diagnostics expire after seven and
  fourteen days respectively.

### Adoption

- Added the independently published `@vibecloud/codex-skill-init` package. It
  installs a global bootstrap skill that selects Vibecloud for compatible new
  application requests and hands initialized projects to their bundled skill.
- Pre-0.1 generated projects are prototypes and are not migrated automatically.
  Initialize a new project and move authored application source deliberately.
- Commit `.vibecloud/project.json`; never commit IAM tokens or API keys.
