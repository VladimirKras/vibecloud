import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withExclusive } from "./exclusive.ts";

/** Host and VM kernels cannot coordinate file locks: never share build ownership. */
export function buildRoot(project: string, environment = process.env): string {
  return environment.VIBECLOUD_DEV_CONTAINER === "1" ? "/vibecloud-runtime" : project;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Only complete builds become visible; a failed build leaves warm and cold groups intact. */
export async function withBuildOutput(project: string, selected: string | undefined, build: (stage: string) => Promise<void>): Promise<void> {
  let output = resolve(project, selected ?? "dist");
  // Accept alternate spellings of the project root (not symlinks below it),
  // including macOS /var -> /private/var temporary directories.
  for (let ancestor = output; dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) {
    if (await canonicalPath(ancestor) === project) {
      output = resolve(project, relative(ancestor, output));
      break;
    }
  }
  const local = relative(project, output);
  if (local !== "dist" && !/^infra\/\.packages\/deployment-[A-Za-z0-9]+\/dist$/.test(local)) {
    throw new Error("VIBECLOUD_BUILD_OUTPUT must be dist or a CLI-owned infra/.packages/deployment-*/dist directory");
  }
  // Do not follow aliases into source, state, or outside the workspace.
  if (await canonicalPath(dirname(output)) !== dirname(output)) throw new Error("Build output parent must not be a symlink");
  if (local !== "dist") {
    if (await lstat(output).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    })) throw new Error("Deployment output already exists; create a new deployment snapshot");
    await mkdir(dirname(output), { recursive: true });
    const stage = await mkdtemp(join(dirname(output), ".build-"));
    try {
      await build(stage);
      await rename(stage, output);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    return;
  }

  const builds = join(project, ".vibecloud", "builds");
  if (await canonicalPath(builds) !== builds) throw new Error("Build storage must not be a symlink");
  await mkdir(builds, { recursive: true });
  return withExclusive(project, "build", async () => {
    let stage: string | undefined;
    let link: string | undefined;
    let previous: string | undefined;
    let legacy: string | undefined;
    try {
      const current = await lstat(output).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (current?.isSymbolicLink()) {
        previous = resolve(project, await readlink(output));
        if (dirname(previous) !== builds || !basename(previous).startsWith("build-")) throw new Error("dist points outside CLI-owned build storage");
      } else if (current && !current.isDirectory()) throw new Error("dist must be a build directory");
      stage = await mkdtemp(join(builds, "build-"));
      await build(stage);
      link = join(builds, `link-${basename(stage)}`);
      // This relative target is interpreted after the link is moved to project/dist.
      await symlink(relative(project, stage), link, "dir");
      if (current?.isDirectory()) {
        legacy = join(builds, `legacy-${basename(stage)}`);
        await rename(output, legacy);
        previous = legacy;
      }
      try {
        await rename(link, output);
      } catch (error) {
        if (legacy) await rename(legacy, output);
        throw error;
      }
      const active = stage;
      stage = undefined;
      // Keep the previous complete generation as well as the active one.
      for (const entry of await readdir(builds, { withFileTypes: true })) {
        const path = join(builds, entry.name);
        if (entry.isDirectory() && /^(build-|legacy-build-)/.test(entry.name) && path !== active && path !== previous) {
          await rm(path, { recursive: true, force: true }).catch((error) => console.warn("Could not prune old local build:", error));
        }
      }
    } finally {
      if (link) await rm(link, { force: true });
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  });
}
