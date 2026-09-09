import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactDigests,
  assertCleanGitStatus,
  assertCompleteReleaseArtifacts,
  assertGitHubRepositoryUrl,
  assertMatchingDistTag,
  assertMatchingLatest,
  assertPackedFiles,
  assertReleaseCommit,
  assertReleaseCommitHistory,
  assertTagTarget,
  githubSnapshotRefspec,
  packageMetadataUrl,
  packedTarballPath,
  publishedArtifactStatus,
  releaseTag,
  releasePackageNames,
} from "./release-workflow.ts";

test("release artifacts require the complete package set with CLI last", () => {
  const artifacts = releasePackageNames.map((name) => ({ name }));
  assert.doesNotThrow(() => assertCompleteReleaseArtifacts(artifacts));
  const cli = artifacts.at(-1);
  assert.ok(cli);
  assert.equal(cli.name, "@vibecloud/cli");
  assert.throws(
    () => assertCompleteReleaseArtifacts(artifacts.filter(({ name }) => name !== "@vibecloud/function-api")),
    /complete ordered package set/,
  );
  assert.throws(
    () => assertCompleteReleaseArtifacts([cli, ...artifacts.slice(0, -1)]),
    /complete ordered package set/,
  );
});

test("stable releases require committed source and a release commit", () => {
  assert.doesNotThrow(() => assertCleanGitStatus(""));
  assert.throws(() => assertCleanGitStatus(" M package.json\n"), /clean Git worktree/);
  assert.doesNotThrow(() => assertReleaseCommit("chore(release): release 1.2.3", "1.2.3"));
  assert.throws(() => assertReleaseCommit("feat: ship", "1.2.3"), /chore\(release\)/);
  assert.equal(releaseTag("1.2.3"), "v1.2.3");
  assert.throws(() => releaseTag("1.2.3-dev.1"), /must be stable/);
});

test("GitHub snapshots accept only GitHub repositories and safe snapshot refspecs", () => {
  for (const repository of [
    "git@github.com:example/vibecloud.git",
    "https://github.com/example/vibecloud.git",
    "ssh://git@github.com/example/vibecloud.git",
  ]) {
    assert.equal(assertGitHubRepositoryUrl(repository), true);
  }
  for (const repository of [
    "https://git.sourcecraft.dev/example/vibecloud.git",
    "https://github.example.com/example/vibecloud.git",
    "github",
  ]) {
    assert.throws(() => assertGitHubRepositoryUrl(repository), /only be force-pushed/);
  }

  const commit = "a".repeat(40);
  assert.equal(githubSnapshotRefspec(commit, "main"), `${commit}:refs/heads/main`);
  assert.throws(() => githubSnapshotRefspec("HEAD", "main"), /full Git object ID/);
  assert.throws(() => githubSnapshotRefspec(commit, "../main"), /invalid GitHub snapshot branch/);
});

test("release provenance rejects duplicate release commits", () => {
  assert.doesNotThrow(() => assertReleaseCommitHistory("fix: one\nchore(release): release 1.2.3", "1.2.3"));
  assert.throws(
    () => assertReleaseCommitHistory("chore(release): release 1.2.3\nchore(release): release 1.2.3", "1.2.3"),
    /exactly once/,
  );
  assert.throws(() => assertReleaseCommitHistory("fix: one", "1.2.3"), /exactly once/);
});

test("release tags may be absent or point only to the release commit", () => {
  assert.doesNotThrow(() => assertTagTarget("v1.2.3", undefined, "abc"));
  assert.doesNotThrow(() => assertTagTarget("v1.2.3", "abc", "abc"));
  assert.throws(() => assertTagTarget("v1.2.3", "old", "abc"), /points to old/);
});

test("registry metadata URLs preserve scoped package routing", () => {
  assert.equal(
    packageMetadataUrl("http://registry.example/", "@vibecloud/cli").href,
    "http://registry.example/@vibecloud%2fcli",
  );
});

test("packed tarballs accept relative and absolute pnpm filenames", () => {
  assert.equal(packedTarballPath("/tmp/tarballs", "package.tgz"), "/tmp/tarballs/package.tgz");
  assert.equal(packedTarballPath("/tmp/tarballs", "/tmp/output/package.tgz"), "/tmp/output/package.tgz");
});

test("partial publications resume only for byte-identical artifacts", () => {
  const expected = artifactDigests(Buffer.from("release tarball"));
  const metadata = {
    "dist-tags": { latest: "1.2.3" },
    "versions": { "1.2.3": { dist: expected } },
  };
  assert.deepEqual(publishedArtifactStatus(metadata, "1.2.4", expected), { kind: "missing" });
  assert.deepEqual(publishedArtifactStatus(metadata, "1.2.3", expected), { kind: "matching" });
  assert.equal(
    publishedArtifactStatus(metadata, "1.2.3", artifactDigests(Buffer.from("different"))).kind,
    "mismatched",
  );
  assert.doesNotThrow(() => assertMatchingLatest(metadata, "@vibecloud/cli", "1.2.3"));
  assert.doesNotThrow(() => assertMatchingDistTag(metadata, "@vibecloud/cli", "1.2.3", "latest"));
  assert.throws(
    () => assertMatchingDistTag(metadata, "@vibecloud/cli", "1.2.3", "dev"),
    /dev tag resolves to nothing/,
  );
  assert.throws(
    () => assertMatchingLatest(metadata, "@vibecloud/cli", "1.2.4"),
    /latest tag resolves to 1.2.3/,
  );
});

test("staged tarballs include mandatory metadata and exclude source", () => {
  const valid = ["LICENSE", "README.md", "package.json", "dist/index.js"].map((path) => ({ path }));
  assert.doesNotThrow(() => assertPackedFiles("@vibecloud/core", valid));
  assert.throws(
    () => assertPackedFiles("@vibecloud/core", valid.filter(({ path }) => path !== "LICENSE")),
    /missing LICENSE/,
  );
  assert.throws(
    () => assertPackedFiles("@vibecloud/core", [...valid, { path: "src/index.ts" }]),
    /unexpectedly contains src\/index\.ts/,
  );
});
