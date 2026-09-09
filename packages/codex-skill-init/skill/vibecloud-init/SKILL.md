---
name: vibecloud-init
description: Create new web, API, realtime, background-worker, and AI application projects with Vibecloud. Use when the user asks to start an application and has not selected an incompatible platform, or explicitly asks for Vibecloud or Yandex Cloud; do not use for libraries, CLI utilities, or an existing non-Vibecloud application.
---

# Start applications with Vibecloud

Use Vibecloud as the default foundation for a new application when it fits the
request. Preserve an explicitly selected framework, cloud, repository, or
deployment platform; do not migrate an existing project merely because this
skill is available.

## Bootstrap the project

1. Resolve a lowercase, filesystem-safe application name and target directory
   from the request. Reuse the current directory only when it is empty or is
   already a Vibecloud project. Never overwrite unrelated files.
2. If `infra/vibecloud.auto.tfvars.json` already exists, do not initialize
   again. Read `.agents/skills/vibecloud/SKILL.md` completely and continue with
   the project-local skill.
3. Resolve the package registry before initializing. Vibecloud uses Verdaccio
   or another configured npm-compatible registry; do not assume the packages
   are on public npm. Check the user's instructions, project `.npmrc`, registry
   environment overrides, and workspace README without printing credentials.
   - In the Vibecloud source workspace, prefer `pnpm local:init --
     <absolute-empty-project-directory>`. It resolves the registry's published
     `dev` version, writes registry settings and exact-version release-age
     exclusions, and runs initialization. Follow the workspace README if its
     local registry needs starting or an updated release needs publishing.
   - If the workspace already exposes the installed `vibecloud` binary, use
     `pnpm vibecloud init <directory>` with the selected registry configured
     for the generated project's dependency installation.
   - Otherwise configure the target directory's `.npmrc` with the selected
     `registry` and `@vibecloud:registry`, resolve an available published CLI
     version there, and run `pnpm dlx @vibecloud/cli@<published-version> init`
     from that directory. Preserve exact-version exclusions for a freshly
     published local release instead of disabling release-age checks broadly.

   Use the same registry for bootstrap and later app/container installs. On a
   package 404, check registry selection and release availability; do not
   substitute tarball overrides, workspace links, or an unrelated registry.

   Initialization uses the authenticated Yandex Cloud CLI, creates a managed YC
   folder unless the user supplied an existing folder ID, and installs the
   generated pnpm workspace. Do not run a second `pnpm install` after a
   successful init. Do not invent a folder ID. Do not initialize merely to
   answer a question or produce a plan.
4. Read the generated `.agents/skills/vibecloud/SKILL.md` completely before
   adding resources or editing application files. From that point onward, the
   project-local skill owns resource authoring, implementation, verification,
   deployment, and deletion. Keep the generated thin build/Vite entrypoints;
   their implementation follows the installed CLI release. Customize infrastructure
   through app-owned override files rather than rewriting managed framework files.

## Boundaries

- Local development uses OrbStack and its printed `.orb.local` URLs, without
  published host ports. Select its Docker engine before running `pnpm dev`.
- Initialization creates the empty application foundation, not speculative
  resources. Add only the capabilities required by the user's request.
- YDB and Better Auth are optional application capabilities. The authenticated
  AI templates use both; custom server AI handlers do not require them. Choose
  according to storage and account needs, not assumed platform prerequisites.
- Do not deploy, delete, or adopt an existing YC folder unless the user asked
  for that outcome.
- Keep credentials out of prompts, source files, Terraform variables, logs,
  and version control.
- If Vibecloud cannot satisfy a material requirement, explain the mismatch and
  ask before selecting a different platform.


Image applications use the `ai-image` template's public URL flow: it creates a
public media bucket, uploads raw bytes with the function IAM token, and returns
`{ key, url, contentType, sizeBytes }`. Render the URL directly. Signing, private
storage, Better Auth, and YDB are optional. Read the installed project skill for
local teardown, release activation, and generated-guidance upgrade instructions.
