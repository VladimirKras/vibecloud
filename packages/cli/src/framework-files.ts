import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig, type LoadedConfig } from "./config.ts";
import { commitProjectEdit } from "./project-edit.ts";
import { refreshGuidance } from "./guidance.ts";
import { withProjectMutation } from "./project-lock.ts";

export const frameworkFiles = new Set([
  "main.tf", "variables.tf", "outputs.tf", "monitoring.tf", ".terraform.lock.hcl",
  "local.compose.yaml", "local.orbstack.compose.yaml", "local.Dockerfile",
]);
const digest = (source: string) => createHash("sha256").update(source).digest("hex");

export function managedFrameworkFile(source: string): string {
  return `# Vibecloud managed: ${digest(source)}; customize in separate override files.\n${source}`;
}

/** Materialize the installed release in the existing Terraform root, preserving state addresses. */
export async function refreshFrameworkFiles(loaded: LoadedConfig): Promise<void> {
  return withProjectMutation(loaded.rootDirectory, () => refreshUnlocked(loaded));
}

async function refreshUnlocked(loaded: LoadedConfig): Promise<void> {
  const writes = [];
  const originalConfig = await readFile(loaded.configPath, "utf8");
  const parsed = JSON.parse(originalConfig);
  const normalized = validateConfig(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) writes.push({ path: loaded.configPath, original: originalConfig, updated: `${JSON.stringify(normalized, null, 2)}\n` });
  for (const name of frameworkFiles) {
    const path = join(loaded.infraDirectory, name);
    const original = await readFile(path, "utf8");
    const source = await readFile(new URL(`../templates/project/infra/${name}`, import.meta.url), "utf8");
    const marker = /^# Vibecloud managed: ([a-f0-9]{64});[^\n]*\n/.exec(original);
    // Unmarked, authored infrastructure remains app-owned. Exact current
    // templates can adopt managed updates without guessing at custom content.
    if (!marker && original !== source) continue;
    if (marker && digest(original.slice(marker[0].length)) !== marker[1]) {
      throw new Error(`${path} has edits to managed framework code. Move customizations to separate override files, or remove its first-line marker to maintain this file yourself.`);
    }
    const updated = managedFrameworkFile(source);
    if (updated !== original) writes.push({ path, original, updated });
  }
  if (writes.length) await commitProjectEdit(loaded.rootDirectory, { writes, moves: [] });
  await ensureProjectGitignore(loaded.rootDirectory);
  await refreshGuidance(loaded.rootDirectory);
}

export async function ensureProjectGitignore(rootDirectory: string): Promise<boolean> {
  const path = join(rootDirectory, ".gitignore");
  const required = (await readFile(new URL("../templates/project/gitignore", import.meta.url), "utf8")).trim().split("\n");
  const current = await readFile(path, "utf8");
  const existing = new Set(current.split("\n"));
  const missing = required.filter((line) => !existing.has(line));
  if (!missing.length) return false;
  const separator = current.length && !current.endsWith("\n") ? "\n" : "";
  await commitProjectEdit(rootDirectory, { writes: [{ path, original: current, updated: `${current}${separator}${missing.join("\n")}\n` }], moves: [] });
  return true;
}
