import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupStaleAcceptanceWorkspaces,
  createAcceptanceWorkspace,
  removeSuccessfulAcceptanceWorkspace,
} from "./acceptance-workspace.ts";

test("acceptance cleanup removes only stale owned workspaces", () => {
  const root = mkdtempSync(join(tmpdir(), "vibecloud-workspace-test-"));
  const oldOwned = join(root, "owned-old");
  const freshOwned = join(root, "owned-fresh");
  const unrelated = join(root, "other-old");
  for (const path of [oldOwned, freshOwned, unrelated]) mkdirSync(path);
  utimesSync(oldOwned, new Date(0), new Date(0));
  utimesSync(unrelated, new Date(0), new Date(0));

  assert.deepEqual(cleanupStaleAcceptanceWorkspaces(root, "owned-", { now: 10_000, ttlMs: 1_000 }), [oldOwned]);
  assert.doesNotThrow(() => statSync(freshOwned));
  assert.doesNotThrow(() => statSync(unrelated));
  removeSuccessfulAcceptanceWorkspace(root);
});

test("acceptance workspaces are retained only when requested", () => {
  const root = mkdtempSync(join(tmpdir(), "vibecloud-workspace-test-"));
  const first = createAcceptanceWorkspace(root, "owned-");
  removeSuccessfulAcceptanceWorkspace(first, { keep: true });
  assert.doesNotThrow(() => statSync(first));
  removeSuccessfulAcceptanceWorkspace(first);
  assert.throws(() => statSync(first), /ENOENT/);
  removeSuccessfulAcceptanceWorkspace(root);
});
