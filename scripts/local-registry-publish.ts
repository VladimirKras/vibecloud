import type { PackageManifest, PackedPackage, RegistryMetadata, ReleaseArtifact } from "./package-types.ts";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDigests,
  assertCleanGitStatus,
  assertCompleteReleaseArtifacts,
  assertMatchingDistTag,
  assertMatchingLatest,
  assertPackedFiles,
  assertReleaseCommit,
  assertReleaseCommitHistory,
  assertTagTarget,
  packageMetadataUrl,
  packedTarballPath,
  publishedArtifactStatus,
  releasePackageDirectories,
  releaseTag,
} from "./release-workflow.ts";

const registry = localRegistry();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPackage = manifest(join(root, "packages", "cli"));
const stable = process.argv.slice(2).includes("--stable");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--stable");
if (unknownArguments.length) throw new Error(`unknown arguments: ${unknownArguments.join(", ")}`);
const publishVersion = stable ? cliPackage.version : `${cliPackage.version}-dev.${Date.now()}`;
const publishTag = stable ? "latest" : "dev";
const provenance = stable ? stableReleaseProvenance() : undefined;

run("pnpm", ["release:check"], root);
const staging = mkdtempSync(join(tmpdir(), "vibecloud-local-publish-"));

try {
  const artifacts = releasePackageDirectories.map((name) => stagePackage(join(root, "packages", name)));
  assertCompleteReleaseArtifacts(artifacts);
  if (stable) await publishStableArtifacts(artifacts);
  else await publishPrereleaseArtifacts(artifacts);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (stable && provenance && !provenance.tagCommit) {
  run("git", [
    "tag",
    "-a",
    provenance.tag,
    "-m",
    `Vibecloud ${publishVersion}`,
    "-m",
    `Verified ten-package Verdaccio release ${publishVersion}.`,
  ], root);
  console.log(`tagged ${provenance.headCommit} as ${provenance.tag}`);
}

function stableReleaseProvenance() {
  assertCleanGitStatus(readCommand("git", ["status", "--porcelain", "--untracked-files=all"], root));
  assertReleaseCommit(readCommand("git", ["log", "-1", "--format=%s"], root), publishVersion);
  assertReleaseCommitHistory(readCommand("git", ["log", "--format=%s"], root), publishVersion);
  const headCommit = readCommand("git", ["rev-parse", "HEAD"], root);
  const tag = releaseTag(publishVersion);
  const tagCommit = readOptionalCommand("git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${tag}^{commit}`,
  ], root);
  assertTagTarget(tag, tagCommit, headCommit);
  return { headCommit, tag, tagCommit };
}

function stagePackage(source: string): ReleaseArtifact {
  const value = manifest(source);
  const target = join(staging, value.name.replaceAll("/", "__"));
  mkdirSync(target, { recursive: true });
  for (const path of value.files ?? []) {
    const destination = join(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, path), destination, { recursive: true });
  }
  cpSync(join(root, "LICENSE"), join(target, "LICENSE"));
  value.version = publishVersion;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const dependencies = value[section] ?? {};
    for (const dependency of Object.keys(dependencies)) {
      if (dependency.startsWith("@vibecloud/") && String(dependencies[dependency]).startsWith("workspace:")) {
        dependencies[dependency] = publishVersion;
      }
    }
  }
  delete value.scripts?.prepack;
  writeFileSync(join(target, "package.json"), `${JSON.stringify(value, null, 2)}\n`);

  const tarballDirectory = join(staging, "tarballs");
  mkdirSync(tarballDirectory, { recursive: true });
  const packed: PackedPackage = JSON.parse(readCommand("pnpm", [
    "--config.ignore-scripts=true",
    "pack",
    "--pack-destination",
    tarballDirectory,
    "--json",
  ], target));
  assertPackedFiles(value.name, packed.files);
  const tarball = packedTarballPath(tarballDirectory, packed.filename);
  return {
    name: value.name,
    tarball,
    ...artifactDigests(readFileSync(tarball)),
  };
}

async function publishStableArtifacts(artifacts: ReleaseArtifact[]) {
  const states = [];
  for (const artifact of artifacts) {
    const metadata = await registryMetadata(artifact.name);
    const status = publishedArtifactStatus(metadata, publishVersion, artifact);
    if (status.kind === "mismatched") {
      throw new Error(
        `${artifact.name}@${publishVersion} already exists with different contents (${status.actual})`,
      );
    }
    if (status.kind === "matching") {
      assertMatchingLatest(metadata, artifact.name, publishVersion);
    }
    states.push({ artifact, status });
  }

  for (const { artifact, status } of states) {
    if (status.kind === "matching") {
      console.log(`verified existing ${artifact.name}@${publishVersion}; continuing partial release`);
    } else {
      publishArtifact(artifact);
    }
  }

  for (const artifact of artifacts) {
    const metadata = await registryMetadata(artifact.name);
    const status = publishedArtifactStatus(metadata, publishVersion, artifact);
    if (status.kind !== "matching") {
      throw new Error(`registry verification failed for ${artifact.name}@${publishVersion}`);
    }
    assertMatchingLatest(metadata, artifact.name, publishVersion);
  }
}

async function publishPrereleaseArtifacts(artifacts: ReleaseArtifact[]) {
  const stagingTag = `vibecloud-staging-${publishVersion.replaceAll(".", "-")}`;

  // Runtime packages are ordered before the CLI. Publishing the CLI last keeps
  // an exact-version scaffold from becoming installable before its runtimes.
  for (const artifact of artifacts) publishArtifact(artifact, stagingTag);

  for (const artifact of artifacts) {
    const metadata = await registryMetadata(artifact.name);
    const status = publishedArtifactStatus(metadata, publishVersion, artifact);
    if (status.kind !== "matching") {
      throw new Error(`registry verification failed for ${artifact.name}@${publishVersion}`);
    }
    assertMatchingDistTag(metadata, artifact.name, publishVersion, stagingTag);
  }

  // Promote runtimes first and the CLI last. `@vibecloud/cli@dev` therefore
  // always points to a version whose complete exact-version dependency set is
  // already present in the registry.
  for (const artifact of artifacts) setDistTag(artifact, publishTag);

  for (const artifact of artifacts) {
    const metadata = await registryMetadata(artifact.name);
    assertMatchingDistTag(metadata, artifact.name, publishVersion, publishTag);
  }

  for (const artifact of artifacts) removeDistTag(artifact, stagingTag);
  console.log(`verified complete ${artifacts.length}-package prerelease ${publishVersion}`);
}

function publishArtifact(artifact: ReleaseArtifact, tag = publishTag) {
  run("pnpm", [
    "publish",
    artifact.tarball,
    "--registry",
    registry,
    "--tag",
    tag,
    "--no-git-checks",
  ], root);
  console.log(`published ${artifact.name}@${publishVersion} to ${registry} with tag ${tag}`);
}

function setDistTag(artifact: ReleaseArtifact, tag: string) {
  run("pnpm", [
    "dist-tag",
    "add",
    `${artifact.name}@${publishVersion}`,
    tag,
    "--registry",
    registry,
  ], root);
}

function removeDistTag(artifact: ReleaseArtifact, tag: string) {
  run("pnpm", ["dist-tag", "rm", artifact.name, tag, "--registry", registry], root);
}

async function registryMetadata(packageName: string): Promise<RegistryMetadata> {
  const response = await fetch(packageMetadataUrl(registry, packageName), { cache: "no-store" });
  if (response.status === 404) return { "versions": {}, "dist-tags": {} };
  if (!response.ok) throw new Error(`registry request failed for ${packageName}: HTTP ${response.status}`);
  return await response.json() as RegistryMetadata;
}

function manifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function localRegistry() {
  const value = process.env.VIBECLOUD_LOCAL_REGISTRY ?? "http://registry.verdaccio.orb.local/";
  const url = new URL(value);
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]", "registry.verdaccio.orb.local"];
  if (url.protocol !== "http:" || !allowedHosts.includes(url.hostname)) {
    throw new Error(`local registry must be an approved local HTTP URL: ${value}`);
  }
  return url.href;
}

function readCommand(command: string, arguments_: string[], cwd: string) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function readOptionalCommand(command: string, arguments_: string[], cwd: string) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return undefined;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim() || undefined;
}

function run(command: string, arguments_: string[], cwd: string) {
  const result = spawnSync(command, arguments_, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} exited with status ${result.status}`);
}
