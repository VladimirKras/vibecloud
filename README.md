# Vibecloud workspace

This private pnpm workspace contains the publishable Vibecloud packages:

- `packages/cli`: `@vibecloud/cli`
- `packages/core`: `@vibecloud/core`
- `packages/ai`: `@vibecloud/ai` for Yandex AI Studio and SpeechKit
  authentication, Responses, multimodal turns, and server-side Realtime
  connections
- `packages/storage`: `@vibecloud/storage` for raw-byte uploads and public media URLs
- `packages/function-api`: `@vibecloud/function-api`
- `packages/db`: `@vibecloud/db` with `better-auth` and `migrator` subpaths
- `packages/function-trigger-cron`: `@vibecloud/function-trigger-cron`
- `packages/function-trigger-datastream`: `@vibecloud/function-trigger-datastream`
- `packages/function-ws`: `@vibecloud/function-ws`
- `packages/telemetry`: `@vibecloud/telemetry`
- `packages/codex-skill-init`: `@vibecloud/codex-skill-init`, which installs
  the global Codex bootstrap skill for starting new applications with Vibecloud

See [the CLI README](packages/cli/README.md) for project authoring and deployment
documentation, the packaged [architecture reference](packages/cli/ARCHITECTURE.md)
for implemented ownership and support boundaries, and [CHANGELOG.md](CHANGELOG.md)
for release and adoption notes.
[CONTRIBUTING.md](CONTRIBUTING.md) defines the commit types and scopes
used by the project history, including names such as `feat(ai)` and
`chore(release)`.

## Local Verdaccio releases

Use Verdaccio or another npm-compatible registry hosting the complete Vibecloud
package set. Do not assume `@vibecloud/*` is available on public npm. Verdaccio
is this workspace's active distribution path while Vibecloud remains an
internal prototype. SourceCraft continues to host Git and run verification, but
its CI does not publish packages or require an npm registry token.

The workspace scripts use the sibling development Verdaccio service:

```bash
pnpm local:registry
pnpm local:publish
pnpm local:init -- "$PWD/.tmp/vibecloud-smoke"
```

Set `VIBECLOUD_LOCAL_REGISTRY` to use another loopback or
`registry.verdaccio.orb.local` endpoint. Every local publication receives a
unique prerelease version and the `dev` distribution tag.

`local:init` resolves the registry's `dev` tag, writes `.npmrc`, and records
exact-version exclusions for that local Vibecloud release in
`pnpm-workspace.yaml` before bootstrapping from the target directory. The CLI
bootstrap and separate local app container therefore install the same release;
third-party dependencies retain the normal release-age policy. There is no
need to disable the check globally or for the whole bootstrap process.

The helper is specific to the approved local HTTP endpoints above. For another
npm-compatible registry, configure that registry in the target project's
`.npmrc` for both `registry` and `@vibecloud:registry`, then run
`pnpm dlx @vibecloud/cli@<published-version> init` from that directory. Use the
same registry during bootstrap and subsequent installs; `PNPM_CONFIG_REGISTRY`
or `NPM_CONFIG_REGISTRY` overrides are also forwarded to the app container.
Keep registry credentials in the package manager's credential configuration.
Resolve a missing package/version in the selected registry instead of switching
to public npm, workspace links, or tarball overrides.

`pnpm local:publish` runs `pnpm release:check` before publishing. The release
check executes the complete test suite, verifies every package tarball, and
uses a packed CLI to initialize and build a clean project plus run Terraform
init, provider-schema loading, and validation. Run it before publishing or tagging a
stable workspace release:

```bash
pnpm release:check
```

To smoke-test a deployed WebSocket route through its real gateway lifecycle:

```bash
pnpm acceptance:websocket -- wss://example.apigw.yandexcloud.net/ws
```

The default release check is credential-free. To opt into billable live YC
acceptance, including an authenticated zero-drift Terraform plan, HTTP,
WebSocket CONNECT/MESSAGE/DISCONNECT logs, cron delivery, and asynchronous
folder deletion, use an authenticated `yc` profile and run:

```bash
VIBECLOUD_LIVE_YC=1 pnpm acceptance:live <exact-published-version>
```

Failed diagnostics are retained under ignored `.tmp/`. Non-cloud acceptance
workspaces older than seven days are removed on the next matching run. Live
acceptance deletes through `vibecloud delete --delete-after 0s` and waits up to
three minutes for confirmation. Unconfirmed cleanup fails acceptance and preserves
the workspace and operation receipt without age-based deletion.

The release check does not modify the registry or Git history. Commit the
version and changelog with the exact subject `chore(release): release <version>`
and leave the worktree clean. Then publish the stable workspace version to the
approved local Verdaccio registry under `latest`:

```bash
pnpm release:publish
```

The publisher builds deterministic tarballs, refuses conflicting existing
artifacts, safely skips byte-identical packages after an interrupted release,
verifies the complete release’s `latest` tags, and creates the annotated `v<version>` tag at
the release commit. It refuses dirty or uncommitted release state. Push the
verified branch and tag atomically to SourceCraft with:

```bash
pnpm release:push
```

Publish the same committed source to GitHub as a signed, single-commit snapshot
without rewriting the local branch or exposing its parents and release tags:

```bash
pnpm release:github
```

`release:github` requires a clean worktree, creates a new signed root commit
from the tree at `HEAD`, and publishes only that commit to GitHub `main` with an explicit force-with-lease
against the observed remote commit. A concurrent publication makes the push fail
instead of overwriting newer work.
The command creates the commit in a temporary repository carrying the GitHub
remote, so a GitHub-specific `includeIf hasconfig:remote.*.url` signing config
applies there without changing the local repository. It never moves a local ref
and never pushes tags. Set `VIBECLOUD_GITHUB_BRANCH` to target a branch other
than `main`; a configured remote name is also accepted instead of a URL. The
signing key must support `git commit-tree -S`; the explicit signature flag does
not rely on `commit.gpgSign` being inherited by Git plumbing commands.
The destination defaults to the root `package.json` repository URL and can be
overridden with `VIBECLOUD_GITHUB_REPOSITORY`.

`pnpm local:publish` remains the unique `-dev.*` publication path and permits
ordinary development worktrees. It publishes the complete shared-version
package set under a temporary staging tag and verifies every tarball. It tests an
application installed from that exact registry release on Node 22 and 26 before
promoting consumer tags, then promotes runtime packages first and the CLI's `dev`
tag last. A prerelease CLI is
therefore never advertised before its exact-version runtime packages exist.

## Codex bootstrap skill

For source development, install the workspace's bootstrap guidance before
asking Codex to create a new application:

```bash
node packages/codex-skill-init/bin/install.ts install
```

The global `vibecloud-init` skill selects Vibecloud for compatible new
application requests and runs project initialization. The generated project
then supplies its exact-version `vibecloud` skill for resource authoring,
implementation, verification, and deployment.

Consumers can install the published skill with
`pnpm dlx @vibecloud/codex-skill-init@<published-version> install` using the
same configured registry as the CLI. The source installer updates guidance
locally; it does not publish a package release.

Vibecloud provides serialized, recoverable project edits, authoritative configuration
snapshots, isolated local function/database lifetimes, migration checksum guards and
explicit application capabilities. `pnpm vibecloud orphans` reports cleanup candidates inside
generated applications.

`pnpm acceptance:ydb grpc://<ydb-service>.<project>.orb.local:2136/local` checks migration compatibility and
immutability against an isolated local YDB database. Use a disposable database: this
acceptance creates test tables and migration history. Generated-project acceptance also
runs fifteen Terraform scenarios with mocked providers, without cloud API calls.

Application builders and Vite defaults live in the installed CLI, with thin project
entrypoints. Unchanged managed Terraform and Compose files refresh from that release;
keep app-specific infrastructure in separate `.tf` files and `infra/local.override.yaml`.
Resource scaffolding preserves custom package scripts. Event types remain in their
separate type-only packages (`function-api`, `function-ws`, and trigger packages).

## Architecture boundaries

The [architecture reference](packages/cli/ARCHITECTURE.md) describes the current
state owners, deployment graph, failure recovery, runtime support and verification
limits. It ships as `node_modules/@vibecloud/cli/ARCHITECTURE.md` in applications.

| Owner | Responsibility |
| --- | --- |
| Application declaration | Explicit function kinds and capabilities; templates expand defaults during scaffolding/upgrade |
| CLI | Edit sources, build immutable artifacts, invoke Terraform, and report provider results |
| Terraform | Plan and apply the cloud graph, hold backend locks, persist partial progress, order migration hooks before functions |
| YC | Managed folder lifecycle; the CLI retains deletion receipts and checks current folder status |
| OrbStack | Local `.orb.local` routing and container networking; no published host ports |
| Local session | Own children, watchers and cleanup from startup through shutdown; OS file locks release on process death |
| Runtime SDKs | Own consumed response bodies, invocation deadlines and best-effort telemetry; raw/streaming responses transfer ownership to callers |

Terraform stores a small completed-release record for asset retention, not a second
resource model. Release order comes from successful applies rather than build timestamps.
Source journals cover local edits only. A failed deployment leaves Terraform progress
and external receipts intact. Whole-folder deletion must be serialized with other
checkouts because it is a YC operation outside Terraform's graph.

Project management runs on the host. Dev builds live in the private `app-runtime`
volume, independent of host `dist` and deployment snapshots, because host and VM
kernels do not share file locks.

CLI/build tooling requires Node 26; deployed SDKs support Node 22. Event contracts stay
in separate type-only packages. Authentication, YDB and signed/private image access
remain opt-in. Local execution supports Node HTTP handlers, Vite, media and YDB;
other invocation types are reported as cloud-only instead of silently emulated.

## Scope

Vibecloud is an internal serverless prototyping platform. It intentionally uses
one capability-scoped runtime service account per project, one function per invocation
type and runtime (with isolated Data Streams consumers), one native Terraform
resource-changing plan/apply with local state by default. Unsupported old scaffold
versions require fresh initialization; supported managed files and normalized
application declarations refresh from the installed CLI. It does not provide deployment promotion, managed remote state, a browser Realtime
relay, production SLOs, multi-region architecture, or compliance controls.

## License

Vibecloud is licensed under the [GNU Affero General Public License v3.0](LICENSE).
