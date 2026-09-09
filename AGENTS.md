# Vibecloud workspace

Vibecloud is an internal serverless prototyping platform. Keep the application
workflow centered on logical resources, `pnpm dev`, and `pnpm push`.

## Package distribution

Use Verdaccio or another configured npm-compatible registry that hosts the
complete Vibecloud package set. Do not assume `@vibecloud/*` exists on public
npm. Resolve the registry from the user's instructions, project `.npmrc`,
registry environment variables, and the workspace README before bootstrapping.
Preserve the selected registry for both the CLI bootstrap and app/container
dependency installation.

For this workspace's local Verdaccio workflow, use `pnpm local:init --
<absolute-empty-project-directory>`. It selects the published `dev` release,
writes the project's registry configuration, and pins the matching packages.
Use `pnpm local:registry` if the local registry needs starting and
`pnpm local:publish` when testing changes that need a new package release.
The publisher verifies the complete release; do not publish the CLI alone.
See README.md for endpoint overrides and other registry setups.

If a package is missing, check the selected registry and published version.
Do not substitute workspace links, tarball overrides, or public npm for a
registry-based application test. Isolated package-archive acceptance tests
remain part of the release checks. Keep scratch applications under `.tmp/`.

## Guidance ownership

Edit the bootstrap skill in `packages/codex-skill-init/skill/vibecloud-init/`,
the project skill in `packages/cli/skills/vibecloud/`, and generated project
instructions in `packages/cli/templates/project/AGENTS.md`. Keep their READMEs
consistent. Installed copies are not the source of truth; update them after
validating the packaged instructions when the task includes active guidance.

Build and Vite behavior belongs in `packages/cli/src/application-build.ts` and
`packages/cli/src/vite.ts`; generated entrypoints should stay thin. Terraform and
Compose implementations live in the packaged templates. Update those sources,
not generated managed copies in scratch apps. Keep app customizations in separate
Terraform files and `infra/local.override.yaml`. Event types intentionally remain
in separate type-only packages.

## Architecture constraints

Maintain the implemented design in [packages/cli/ARCHITECTURE.md](packages/cli/ARCHITECTURE.md).
It is included in the CLI package. Keep the architecture, package READMEs and
generated guidance consistent; distinguish verified behavior from proposed work.

Terraform owns the cloud resource graph, plans, state, locking and partial-apply
recovery. Keep CLI responsibilities to app declarations, artifacts and command
adapters; do not add a parallel resource planner or reconciliation engine.

Local development relies on OrbStack's `.orb.local` routing, without published
host ports. Project edits and deployment run on the host. Dev builds belong in
the container's private `app-runtime` volume; host and VM kernels do not share
file locks. Keep source-edit journals separate from durable cloud receipts.
