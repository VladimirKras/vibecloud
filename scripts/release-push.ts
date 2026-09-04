import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryMetadata } from "./package-types.ts";
import {
  assertCleanGitStatus,
  assertMatchingLatest,
  assertReleaseCommit,
  assertReleaseCommitHistory,
  assertTagTarget,
  packageMetadataUrl,
  releasePackageDirectories,
  releaseTag,
} from "./release-workflow.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;
const tag = releaseTag(version);
const registry = localRegistry();

assertCleanGitStatus(readCommand("git", ["status", "--porcelain", "--untracked-files=all"]));
assertReleaseCommit(readCommand("git", ["log", "-1", "--format=%s"]), version);
assertReleaseCommitHistory(readCommand("git", ["log", "--format=%s"]), version);
const headCommit = readCommand("git", ["rev-parse", "HEAD"]);
const tagCommit = readCommand("git", ["rev-list", "-n", "1", tag]);
assertTagTarget(tag, tagCommit, headCommit);

for (const directory of releasePackageDirectories) {
  const manifest = JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8"));
  const response = await fetch(packageMetadataUrl(registry, manifest.name), { cache: "no-store" });
  if (!response.ok) throw new Error(`registry verification failed for ${manifest.name}: HTTP ${response.status}`);
  const metadata = await response.json() as RegistryMetadata;
  if (!metadata.versions?.[version]) throw new Error(`${manifest.name}@${version} is missing from ${registry}`);
  assertMatchingLatest(metadata, manifest.name, version);
}

const branch = readCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
run("git", [
  "push",
  "--atomic",
  "origin",
  `HEAD:refs/heads/${branch}`,
  `refs/tags/${tag}`,
]);

function localRegistry() {
  const value = process.env.VIBECLOUD_LOCAL_REGISTRY ?? "http://registry.verdaccio.orb.local/";
  const url = new URL(value);
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]", "registry.verdaccio.orb.local"];
  if (url.protocol !== "http:" || !allowedHosts.includes(url.hostname)) {
    throw new Error(`local registry must be an approved local HTTP URL: ${value}`);
  }
  return url.href;
}

function readCommand(command: string, arguments_: string[]) {
  const result = spawnSync(command, arguments_, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function run(command: string, arguments_: string[]) {
  const result = spawnSync(command, arguments_, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} exited with status ${result.status}`);
}
