import { createHash } from "node:crypto";
import type { ArtifactDigests, PackedPackage, RegistryMetadata } from "./package-types.ts";
import { resolve } from "node:path";

export const releasePackageDirectories = [
  "core",
  "ai",
  "function-api",
  "function-trigger-cron",
  "function-trigger-datastream",
  "function-ws",
  "telemetry",
  "db",
  "codex-skill-init",
  "cli",
];

export const releasePackageNames = releasePackageDirectories.map((directory) => `@vibecloud/${directory}`);

export function assertCompleteReleaseArtifacts(artifacts: readonly { name: string }[]) {
  const names = artifacts.map(({ name }) => name);
  if (names.length !== releasePackageNames.length || names.some((name, index) => name !== releasePackageNames[index])) {
    throw new Error(
      `release artifacts must contain the complete ordered package set: ${releasePackageNames.join(", ")}; received ${names.join(", ")}`,
    );
  }
}

export function releaseTag(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release version must be stable, received ${version}`);
  }
  return `v${version}`;
}

export function assertCleanGitStatus(status: string) {
  if (status.trim()) {
    throw new Error("stable releases require a clean Git worktree; commit every tracked and untracked file first");
  }
}

export function assertGitHubRepositoryUrl(value: string, options: { throwOnError?: boolean } = {}) {
  const valid = isGitHubRepositoryUrl(value);
  if (!valid && options.throwOnError !== false) {
    throw new Error("snapshot releases may only be force-pushed to a github.com repository");
  }
  return valid;
}

export function githubSnapshotRefspec(commit: string, branch: string) {
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("snapshot commit must be a full Git object ID");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)
    || branch.includes("..")
    || branch.endsWith("/")
    || branch.endsWith(".lock")
  ) {
    throw new Error(`invalid GitHub snapshot branch ${JSON.stringify(branch)}`);
  }
  return `${commit}:refs/heads/${branch}`;
}

export function assertReleaseCommit(subject: string, version: string) {
  const expected = `chore(release): release ${version}`;
  if (subject.trim() !== expected) {
    throw new Error(`stable releases must run from commit ${JSON.stringify(expected)}`);
  }
}

function isGitHubRepositoryUrl(value: string) {
  if (/^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      ["https:", "ssh:"].includes(url.protocol)
      && url.hostname === "github.com"
      && url.pathname.split("/").filter(Boolean).length === 2
    );
  } catch {
    return false;
  }
}

export function assertReleaseCommitHistory(subjects: string, version: string) {
  const expected = `chore(release): release ${version}`;
  const count = subjects.split(/\r?\n/).filter((subject) => subject === expected).length;
  if (count !== 1) {
    throw new Error(`${expected} must appear exactly once in history; found ${count}`);
  }
}

export function assertTagTarget(tag: string, tagCommit: string | undefined, headCommit: string) {
  if (tagCommit && tagCommit !== headCommit) {
    throw new Error(`${tag} points to ${tagCommit}, expected current release commit ${headCommit}`);
  }
}

export function packageMetadataUrl(registry: string, packageName: string) {
  return new URL(packageName.replace("/", "%2f"), registry);
}

export function packedTarballPath(directory: string, filename: string) {
  return resolve(directory, filename);
}

export function artifactDigests(contents: string | NodeJS.ArrayBufferView): ArtifactDigests {
  return {
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    shasum: createHash("sha1").update(contents).digest("hex"),
  };
}

export function publishedArtifactStatus(
  metadata: RegistryMetadata | undefined,
  version: string,
  expected: ArtifactDigests,
): { kind: "missing" | "matching" } | { kind: "mismatched", actual: string } {
  const published = metadata?.versions?.[version];
  if (!published) return { kind: "missing" };
  const dist = published.dist ?? {};
  const matches = dist.integrity
    ? dist.integrity === expected.integrity
    : dist.shasum === expected.shasum;
  return matches
    ? { kind: "matching" }
    : {
      kind: "mismatched",
      actual: dist.integrity ?? dist.shasum ?? "missing registry digest",
    };
}

export function assertMatchingLatest(metadata: RegistryMetadata | undefined, packageName: string, version: string) {
  assertMatchingDistTag(metadata, packageName, version, "latest");
}

export function assertMatchingDistTag(metadata: RegistryMetadata | undefined, packageName: string, version: string, tag: string) {
  const taggedVersion = metadata?.["dist-tags"]?.[tag];
  if (taggedVersion !== version) {
    throw new Error(`${packageName}@${version} exists but the ${tag} tag resolves to ${taggedVersion ?? "nothing"}`);
  }
}

export function assertPackedFiles(packageName: string, files: PackedPackage["files"]) {
  const paths = new Set(files.map(({ path }) => path));
  for (const required of ["LICENSE", "README.md", "package.json"]) {
    if (!paths.has(required)) throw new Error(`${packageName}: staged tarball is missing ${required}`);
  }
  for (const path of paths) {
    if (path.startsWith("src/") || path.startsWith("test/")) {
      throw new Error(`${packageName}: staged tarball unexpectedly contains ${path}`);
    }
  }
}
