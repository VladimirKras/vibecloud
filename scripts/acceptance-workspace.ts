import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ACCEPTANCE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function createAcceptanceWorkspace(root: string, prefix: string, {
  now = Date.now(),
  ttlMs = DEFAULT_ACCEPTANCE_TTL_MS,
} = {}) {
  mkdirSync(root, { recursive: true });
  cleanupStaleAcceptanceWorkspaces(root, prefix, { now, ttlMs });
  return mkdtempSync(join(root, prefix));
}

export function cleanupStaleAcceptanceWorkspaces(root: string, prefix: string, {
  now = Date.now(),
  ttlMs = DEFAULT_ACCEPTANCE_TTL_MS,
} = {}) {
  const removed = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = join(root, entry.name);
    if (now - statSync(path).mtimeMs < ttlMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export function removeSuccessfulAcceptanceWorkspace(path: string, { keep = false } = {}) {
  if (!keep) rmSync(path, { recursive: true, force: true });
}
