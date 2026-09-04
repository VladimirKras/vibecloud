# Vibecloud workspace

This private pnpm workspace contains the publishable Vibecloud packages:

- `packages/cli`: `@vibecloud/cli`
- `packages/core`: `@vibecloud/core`
- `packages/ai`: `@vibecloud/ai` for Yandex AI Studio and SpeechKit
  authentication, Responses, multimodal turns, and server-side Realtime
  connections
- `packages/function-api`: `@vibecloud/function-api`
- `packages/db`: `@vibecloud/db` with `better-auth` and `migrator` subpaths
- `packages/function-trigger-cron`: `@vibecloud/function-trigger-cron`
- `packages/function-trigger-datastream`: `@vibecloud/function-trigger-datastream`
- `packages/function-ws`: `@vibecloud/function-ws`
- `packages/telemetry`: `@vibecloud/telemetry`
- `packages/codex-skill-init`: `@vibecloud/codex-skill-init`, which installs
  the global Codex bootstrap skill for starting new applications with Vibecloud

See [the CLI README](packages/cli/README.md) for project authoring and deployment
documentation and [CHANGELOG.md](CHANGELOG.md) for release and adoption notes.
[CONTRIBUTING.md](CONTRIBUTING.md) defines the commit types and scopes
used by the project history, including names such as `feat(ai)` and
`chore(release)`.

## Local Verdaccio releases

Verdaccio is the active package distribution path while Vibecloud remains an
internal prototype. SourceCraft continues to host Git and run verification, but
its CI does not publish packages or require an npm registry token.

The workspace scripts use the sibling development Verdaccio service:

```bash
pnpm local:registry
pnpm local:publish
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm local:init -- /tmp/vibecloud-smoke
```

Set `VIBECLOUD_LOCAL_REGISTRY` to use another loopback or
`registry.verdaccio.orb.local` endpoint. Every local publication receives a
unique prerelease version and the `dev` distribution tag.

Disable pnpm's minimum-release-age check only while running `local:init` itself:
freshly published Verdaccio packages have not aged past pnpm's safety window yet.
The initialized project records exact-version exclusions for that one local
Vibecloud release in `pnpm-workspace.yaml`. This lets the separate local app
container install the same trusted release while subsequent third-party
dependencies continue to use the normal release-age policy.

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
VIBECLOUD_LIVE_YC=1 pnpm acceptance:live
```

Failed diagnostics are retained under ignored `.tmp/`. Non-cloud acceptance
workspaces older than seven days and live workspaces older than fourteen days
are removed on the next matching run. Live acceptance always submits deletion
of its managed folder with `--async` and never waits for the folder's
grace-period deletion to finish.

The release check does not modify the registry or Git history. Commit the
version and changelog with the exact subject `chore(release): release <version>`
and leave the worktree clean. Then publish the stable workspace version to the
approved local Verdaccio registry under `latest`:

```bash
pnpm release:publish
```

The publisher builds deterministic tarballs, refuses conflicting existing
artifacts, safely skips byte-identical packages after an interrupted release,
verifies all ten `latest` tags, and creates the annotated `v<version>` tag at
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
from the tree at `HEAD`, and force-pushes only that commit to GitHub `main`.
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
package set under a temporary staging tag, verifies every tarball, promotes
runtime packages first, and moves the CLI's `dev` tag last. A prerelease CLI is
therefore never advertised before its exact-version runtime packages exist.

## Codex bootstrap skill

Install the independently published bootstrap skill before asking Codex to
create a new application:

```bash
pnpm dlx @vibecloud/codex-skill-init install
```

The global `vibecloud-init` skill selects Vibecloud for compatible new
application requests and runs project initialization. The generated project
then supplies its exact-version `vibecloud` skill for resource authoring,
implementation, verification, and deployment.

## Scope

Vibecloud is an internal serverless prototyping platform. It intentionally uses
one capability-scoped runtime service account per project, immediate Terraform
apply with local state, and replace-not-migrate pre-release scaffolds. It does
not provide deployment promotion, managed remote state, a browser Realtime
relay, production SLOs, multi-region architecture, or compliance controls.

## License

Vibecloud is licensed under the [GNU Affero General Public License v3.0](LICENSE).
