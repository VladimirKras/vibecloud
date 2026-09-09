#!/usr/bin/env node

import type { Hash } from "node:crypto";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface InstallOptions {
  codexHome?: string
  force: boolean
  help: boolean
  version: boolean
}

interface InstallMarker {
  managed_by: string
  package_version: string
  content_sha256: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest: { name: string, version: string } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const skillName = "vibecloud-init";
const markerName = ".vibecloud-skill.json";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (options.version) {
  console.log(manifest.version);
  process.exit(0);
}

const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
if (codexHome === parse(codexHome).root) throw new Error("Codex home cannot be a filesystem root");

const source = join(packageRoot, "skill", skillName);
const skillsRoot = join(codexHome, "skills");
const target = join(skillsRoot, skillName);
const staged = join(skillsRoot, `.${skillName}.${process.pid}.${randomUUID()}.tmp`);
const sourceHash = await directoryHash(source);
const marker = {
  managed_by: manifest.name,
  package_version: manifest.version,
  content_sha256: sourceHash,
};

await mkdir(skillsRoot, { recursive: true });

try {
  const existing = await pathKind(target);
  if (existing === "directory") {
    const installedHash = await directoryHash(target, new Set([markerName]));
    if (installedHash === sourceHash) {
      await ensureMarker(target, marker);
      console.log(`${skillName} ${manifest.version} is already installed at ${target}`);
      process.exit(0);
    }

    const installedMarker = await readMarker(target);
    const managedAndUnmodified = installedMarker?.managed_by === manifest.name
      && installedMarker.content_sha256 === installedHash;
    if (!managedAndUnmodified && !options.force) {
      throw new Error(
        `${target} contains an unmanaged or edited skill; rerun with --force to preserve it as a backup`,
      );
    }
  } else if (existing !== "missing" && !options.force) {
    throw new Error(`${target} is not a directory; rerun with --force to preserve it as a backup`);
  }

  await cp(source, staged, { recursive: true, errorOnExist: true });
  await writeFile(join(staged, markerName), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });

  if (existing === "missing") {
    await rename(staged, target);
    console.log(`installed ${skillName} ${manifest.version} at ${target}`);
    process.exit(0);
  }

  const backup = join(skillsRoot, `${skillName}.backup-${backupTimestamp()}`);
  await rename(target, backup);
  try {
    await rename(staged, target);
  } catch (error) {
    await rename(backup, target);
    throw error;
  }

  const previousMarker = existing === "directory" ? await readMarker(backup) : undefined;
  if (previousMarker?.managed_by === manifest.name && !options.force) {
    await rm(backup, { recursive: true, force: true });
    console.log(`upgraded ${skillName} to ${manifest.version} at ${target}`);
  } else {
    console.log(`installed ${skillName} ${manifest.version} at ${target}`);
    console.log(`previous entry preserved at ${backup}`);
  }
} finally {
  await rm(staged, { recursive: true, force: true });
}

function parseArguments(arguments_: string[]) {
  const result: InstallOptions = { codexHome: undefined, force: false, help: false, version: false };
  const values = [...arguments_];
  if (values[0] === "install") values.shift();
  while (values.length) {
    const value = values.shift();
    if (value === "--codex-home") {
      const directory = values.shift();
      if (!directory) throw new Error("--codex-home requires a directory");
      result.codexHome = directory;
    } else if (value === "--force") {
      result.force = true;
    } else if (value === "--help" || value === "-h") {
      result.help = true;
    } else if (value === "--version" || value === "-v") {
      result.version = true;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return result;
}

function printHelp() {
  console.log(`Usage: vibecloud-skill-init [install] [options]

Install the global Codex skill that bootstraps new Vibecloud applications.

Options:
  --codex-home <directory>  Override the Codex home directory
  --force                   Back up and replace an edited or unmanaged copy
  -h, --help                Show this help
  -v, --version             Show the package version`);
}

async function pathKind(path: string) {
  try {
    const value = await lstat(path);
    return value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function directoryHash(directory: string, excludedNames = new Set<string>()) {
  const hash = createHash("sha256");
  await hashEntry(directory, "", hash, excludedNames);
  return hash.digest("hex");
}

async function hashEntry(absolutePath: string, relativePath: string, hash: Hash, excludedNames: Set<string>): Promise<void> {
  const value = await lstat(absolutePath);
  if (value.isSymbolicLink()) {
    hash.update(`link\0${relativePath}\0${await readlink(absolutePath)}\0`);
    return;
  }
  if (value.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(await readFile(absolutePath));
    hash.update("\0");
    return;
  }
  if (!value.isDirectory()) throw new Error(`unsupported entry in skill package: ${absolutePath}`);
  hash.update(`directory\0${relativePath}\0`);
  const entries = (await readdir(absolutePath)).filter((name) => !excludedNames.has(name)).sort();
  for (const name of entries) {
    await hashEntry(join(absolutePath, name), join(relativePath, name), hash, excludedNames);
  }
}

async function readMarker(directory: string): Promise<InstallMarker | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, markerName), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function ensureMarker(directory: string, expected: InstallMarker) {
  const current = await readMarker(directory);
  if (current?.managed_by === expected.managed_by
    && current.package_version === expected.package_version
    && current.content_sha256 === expected.content_sha256) return;
  await writeFile(join(directory, markerName), `${JSON.stringify(expected, null, 2)}\n`);
}

function backupTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
