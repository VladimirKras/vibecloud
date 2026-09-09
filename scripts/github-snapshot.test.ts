import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubSnapshotPushArguments } from "./release-workflow.ts";

test("a delayed snapshot publisher cannot overwrite a newer publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "vibecloud-git-lease-"));
  const repo = join(directory, "source");
  const remote = join(directory, "remote.git");
  const git = (args: string[], cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", input: "" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(["init", "--bare", remote], directory);
    git(["init", repo], directory);
    git(["remote", "add", "origin", remote]);
    const tree = git(["mktree"]);
    const commit = (message: string) => git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", message]);
    const initial = commit("initial");
    const older = commit("older publication");
    const newer = commit("newer publication");
    git(githubSnapshotPushArguments(initial, "main", ""));
    git(githubSnapshotPushArguments(newer, "main", initial));
    const delayed = spawnSync("git", githubSnapshotPushArguments(older, "main", initial), { cwd: repo, encoding: "utf8" });
    assert.notEqual(delayed.status, 0);
    assert.match(delayed.stderr, /stale info/);
    assert.equal(git(["rev-parse", "refs/heads/main"], remote), newer);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
