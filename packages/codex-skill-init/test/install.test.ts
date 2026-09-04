import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(packageRoot, "dist", "install.js");
const packageVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;

test("installer creates an idempotent global skill", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vibecloud-skill-init-"));
  try {
    const first = run(["install", "--codex-home", codexHome]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes(`installed vibecloud-init ${packageVersion}`));

    const skill = join(codexHome, "skills", "vibecloud-init");
    assert.match(await readFile(join(skill, "SKILL.md"), "utf8"), /name: vibecloud-init/);
    assert.equal(JSON.parse(await readFile(join(skill, ".vibecloud-skill.json"), "utf8")).managed_by, "@vibecloud/codex-skill-init");

    const repeated = run(["--codex-home", codexHome]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /already installed/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installer preserves edited skills unless replacement is explicit", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vibecloud-skill-init-conflict-"));
  try {
    assert.equal(run(["--codex-home", codexHome]).status, 0);
    const skill = join(codexHome, "skills", "vibecloud-init");
    await writeFile(join(skill, "SKILL.md"), "user-authored skill\n");

    const refused = run(["--codex-home", codexHome]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unmanaged or edited skill/);
    assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), "user-authored skill\n");

    const replaced = run(["--codex-home", codexHome, "--force"]);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /previous entry preserved/);
    assert.match(await readFile(join(skill, "SKILL.md"), "utf8"), /name: vibecloud-init/);
    const backups = (await readdir(join(codexHome, "skills"))).filter((name) => name.startsWith("vibecloud-init.backup-"));
    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(join(codexHome, "skills", backups[0], "SKILL.md"), "utf8"),
      "user-authored skill\n",
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installer reports help and rejects filesystem roots", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: vibecloud-skill-init/);

  const refused = run(["--codex-home", "/"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /cannot be a filesystem root/);
});

test("compiled installer runs from node_modules with only published files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibecloud-packaged-skill-"));
  try {
    const installedPackage = join(directory, "node_modules", "@vibecloud", "codex-skill-init");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    for (const file of ["package.json", ...manifest.files]) {
      const target = join(installedPackage, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(packageRoot, file), target, { recursive: true });
    }
    const codexHome = join(directory, "codex-home");
    const result = spawnSync(process.execPath, [
      join(installedPackage, manifest.bin["vibecloud-skill-init"]),
      "--codex-home", codexHome,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(await readFile(join(codexHome, "skills", "vibecloud-init", "SKILL.md"), "utf8"), /name: vibecloud-init/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(arguments_: string[]) {
  return spawnSync(process.execPath, [installer, ...arguments_], { encoding: "utf8" });
}
