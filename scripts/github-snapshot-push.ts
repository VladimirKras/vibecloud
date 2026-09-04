import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCleanGitStatus,
  assertGitHubRepositoryUrl,
  githubSnapshotRefspec,
} from "./release-workflow.ts";

interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  quiet?: boolean
  inheritStderr?: boolean
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const configuredRepository = typeof workspace.repository === "string"
  ? workspace.repository
  : workspace.repository?.url;
const destination = process.argv[2]
  ?? process.env.VIBECLOUD_GITHUB_REPOSITORY
  ?? process.env.VIBECLOUD_GITHUB_REMOTE
  ?? configuredRepository
  ?? "github";
const branch = process.argv[3] ?? process.env.VIBECLOUD_GITHUB_BRANCH ?? "main";

assertCleanGitStatus(readCommand("git", ["status", "--porcelain", "--untracked-files=all"]));

const repositoryUrl = resolveRepositoryUrl(destination);
assertGitHubRepositoryUrl(repositoryUrl);
run("git", ["check-ref-format", "--branch", branch], { quiet: true });

const head = readCommand("git", ["rev-parse", "HEAD"]);
const tree = readCommand("git", ["rev-parse", "HEAD^{tree}"]);
const message = readCommand("git", ["log", "-1", "--format=%B"]);
const sourceObjects = readCommand("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
const temporaryRepository = mkdtempSync(join(tmpdir(), "vibecloud-github-snapshot-"));
const alternateObjects = [sourceObjects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
  .filter(Boolean)
  .join(delimiter);
const temporaryEnvironment = {
  ...process.env,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
};
let snapshot;

try {
  run("git", ["init", "--quiet"], { cwd: temporaryRepository, quiet: true });
  run("git", ["remote", "add", "origin", repositoryUrl], { cwd: temporaryRepository, quiet: true });

  snapshot = readCommand("git", ["commit-tree", "-S", tree, "-m", message], {
    cwd: temporaryRepository,
    env: temporaryEnvironment,
    inheritStderr: true,
  });
  const commitLine = readCommand("git", ["rev-list", "--parents", "-n", "1", snapshot], {
    cwd: temporaryRepository,
    env: temporaryEnvironment,
  });
  if (commitLine.split(/\s+/).length !== 1) {
    throw new Error("GitHub snapshot must be a root commit without parents");
  }
  const commitObject = readCommand("git", ["cat-file", "commit", snapshot], {
    cwd: temporaryRepository,
    env: temporaryEnvironment,
  });
  if (!/^gpgsig /mu.test(commitObject)) {
    throw new Error("GitHub snapshot commit was created without a signature");
  }

  run("git", ["push", "--force", "origin", githubSnapshotRefspec(snapshot, branch)], {
    cwd: temporaryRepository,
    env: temporaryEnvironment,
  });
} finally {
  rmSync(temporaryRepository, { recursive: true, force: true });
}
process.stdout.write(`Published signed GitHub snapshot ${snapshot.slice(0, 12)} from local ${head.slice(0, 12)}.\n`);

function resolveRepositoryUrl(remoteOrUrl: string) {
  const result = spawnSync("git", ["remote", "get-url", "--push", remoteOrUrl], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  if (assertGitHubRepositoryUrl(remoteOrUrl, { throwOnError: false })) return remoteOrUrl;
  throw new Error(
    `GitHub remote ${JSON.stringify(remoteOrUrl)} is not configured; add it or pass a GitHub repository URL`,
  );
}

function readCommand(command: string, arguments_: string[], options: CommandOptions = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env,
    stdio: ["inherit", "pipe", options.inheritStderr ? "inherit" : "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function run(command: string, arguments_: string[], options: CommandOptions = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? root,
    env: options.env,
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}
