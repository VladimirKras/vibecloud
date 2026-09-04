# Contributing to Vibecloud

## Commit vocabulary

Use an imperative Conventional Commit subject:

```text
<type>(<scope>): <what changed>
```

The short prefix makes release history searchable; it is not a substitute for
a specific subject or an explanatory commit body when several behaviors move
together.

### Change types

| Type | Meaning |
| --- | --- |
| `feat` | Adds a capability visible to a package consumer, generated project, or CLI user. |
| `fix` | Corrects behavior that was wrong or unreliable. |
| `docs` | Changes documentation without changing runtime behavior. |
| `test` | Adds or corrects verification without changing supported behavior. |
| `refactor` | Changes implementation structure without intentionally changing behavior. |
| `perf` | Improves measured runtime or build performance. |
| `build` | Changes compilation, packaging, or dependency assembly. |
| `ci` | Changes automated verification or delivery outside the product runtime. |
| `chore` | Maintains the workspace or release record without adding a product capability. |

Use `feat` and `fix` according to user-visible impact, not diff size. For
example, `feat(ai)` means “a consumer-facing capability in `@vibecloud/ai`,”
while `chore(workspace)` means “repository-wide maintenance with no new product
capability.”

### Scopes

| Scope | Area |
| --- | --- |
| `ai` | `@vibecloud/ai`, including AI Studio and SpeechKit runtime primitives. |
| `cli` | `@vibecloud/cli`, generated projects, templates, and lifecycle commands. |
| `db` | `@vibecloud/db`, YDB access, migrations, and the Better Auth adapter. |
| `core` | Shared `@vibecloud/core` runtime helpers. |
| `telemetry` | OpenTelemetry and structured runtime telemetry. |
| `skill` | The globally installed `vibecloud-init` Codex bootstrap skill. |
| `functions` | Shared function event/type packages. Name one package in the body when needed. |
| `workspace` | Cross-package development configuration and repository maintenance. |
| `release` | Shared versions, changelog, publishing, registry metadata, and Git tags. |
| `docs` | Repository-wide documentation when no product package is the natural scope. |

Omit the scope only when no listed area makes the subject clearer. Introduce a
new scope only when it represents a stable area that future commits will search
for; do not abbreviate one-off task names.

### Release-history examples

- `feat(ai): expand AI Studio and SpeechKit clients` isolates the reusable AI
  runtime SDK.
- `feat(cli): make projects resumable and portable` records the CLI and
  generated-project lifecycle that consumes those runtime capabilities.
- `chore(workspace): enforce unused-code checks` records cross-package build
  hygiene without claiming a new product feature.
- `chore(release): release 0.1.0` records shared versions, notes, and the
  publishing state associated with the release tag.

Keep a release commit focused on provenance. Product implementation should be
committed before the release version, changelog, and tag. The stable workflow
is:

1. Run `pnpm release:check`; it includes clean packed-CLI project creation,
   production build, and Terraform validation and planning.
2. Update every package version and the dated changelog entry.
3. Commit that state as `chore(release): release <version>` with a clean
   worktree.
4. Run `pnpm release:publish`; it verifies and publishes the tarballs, resumes
   only byte-identical partial publications, and creates `v<version>`.
5. Run `pnpm release:push` to atomically push the branch and annotated tag.
6. Run `pnpm release:github` to publish a signed one-commit snapshot to GitHub
   without publishing the local commit graph or tags.

The publisher rejects repeated provenance commits for the same version.

Use `pnpm local:publish` for prereleases. Generated projects pin
`@vibecloud/*` runtime dependencies to the exact CLI version, so publishing an
individual CLI tarball is unsupported. The command stages and verifies the
complete package set and exposes the CLI's `dev` tag only after every runtime
package at that version is available.
