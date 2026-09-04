import type { PackageManifest, PackedPackage } from "./package-types.ts";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { releasePackageDirectories } from "./release-workflow.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = manifest(join(root, "packages", "cli")).version;
assert(/^\d+\.\d+\.\d+$/.test(expectedVersion), `release version must be stable, received ${expectedVersion}`);
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
assert(
  new RegExp(`^## \\[${escapeRegex(expectedVersion)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog),
  `CHANGELOG.md must contain a dated ${expectedVersion} release`,
);

for (const packageName of releasePackageDirectories) {
  const directory = join(root, "packages", packageName);
  const value = manifest(directory);
  assert(value.version === expectedVersion, `${value.name}: version must be ${expectedVersion}`);
  assert(value.license === "AGPL-3.0-only", `${value.name}: license must be AGPL-3.0-only`);
  assert(typeof value.description === "string" && value.description.length > 0, `${value.name}: description is required`);
  assert(value.repository?.url, `${value.name}: repository URL is required`);
  assert(value.repository?.directory === `packages/${packageName}`, `${value.name}: repository directory is incorrect`);
  assert(value.engines?.node === ">=26.0.0", `${value.name}: Node.js 26 engine is required`);

  const packed = pack(directory);
  const files = new Set(packed.files.map(({ path }) => path));
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    ...entryPoints(value),
    ...packageSpecificFiles(value.name),
  ]) {
    assert(files.has(required), `${value.name}: tarball is missing ${required}`);
  }
  for (const path of files) {
    assert(!path.startsWith("src/"), `${value.name}: tarball unexpectedly contains ${path}`);
    assert(!path.startsWith("test/"), `${value.name}: tarball unexpectedly contains ${path}`);
  }
  console.log(`checked ${value.name}@${value.version} (${files.size} files)`);
}

function packageSpecificFiles(packageName: string) {
  if (packageName !== "@vibecloud/codex-skill-init") return [];
  return [
    "skill/vibecloud-init/SKILL.md",
    "skill/vibecloud-init/agents/openai.yaml",
  ];
}

function manifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function pack(directory: string): PackedPackage {
  const result = spawnSync("pnpm", [
    "--config.ignore-scripts=true",
    "pack",
    "--dry-run",
    "--json",
  ], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function entryPoints(value: PackageManifest) {
  const entries: unknown[] = [value.main, value.types, ...Object.values(value.bin ?? {})];
  collectExportPaths(value.exports, entries);
  return [...new Set(entries.filter((entry) => typeof entry === "string").map(cleanPath))];
}

function collectExportPaths(value: unknown, entries: unknown[]) {
  if (typeof value === "string") {
    entries.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) collectExportPaths(nested, entries);
}

function cleanPath(path: string) {
  return path.startsWith("./") ? path.slice(2) : path;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
