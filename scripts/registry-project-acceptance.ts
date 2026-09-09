import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceWorkspace, removeSuccessfulAcceptanceWorkspace } from "./acceptance-workspace.ts";
import { releasePackageDirectories } from "./release-workflow.ts";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Exact release version is required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = process.env.VIBECLOUD_LOCAL_REGISTRY ?? "http://registry.verdaccio.orb.local/";
const temporary = createAcceptanceWorkspace(join(root, ".tmp"), "vibecloud-registry-acceptance-");
const driver = join(temporary, "driver");
const project = join(temporary, "app");
const bin = join(temporary, "bin");
const environment = { ...process.env, PNPM_CONFIG_REGISTRY: registry, PNPM_CONFIG_PREFER_ONLINE: "true", YC_TOKEN: "offline-acceptance", PATH: `${bin}:${process.env.PATH}` };
let passed = false;
try {
  for (const path of [driver, project, bin]) {
    mkdirSync(path);
    writeFileSync(join(path, ".npmrc"), `registry=${registry}\n@vibecloud:registry=${registry}\n`);
    writeFileSync(join(path, "pnpm-workspace.yaml"), `packages: []\n${readFileSync(join(root, "packages/cli/templates/project/pnpm-workspace.yaml"), "utf8")}\nminimumReleaseAgeExclude:\n${releasePackageDirectories.map((name) => `  - "@vibecloud/${name}@${version}"`).join("\n")}\n`);
  }
  writeFileSync(join(driver, "package.json"), JSON.stringify({ private: true, dependencies: { "@vibecloud/cli": version } }));
  run("pnpm", ["install"], driver);
  const cli = join(driver, "node_modules/@vibecloud/cli/dist/vibecloud.js");
  writeFileSync(join(bin, "yc"), `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='version') console.log('offline'); else if(args.includes('get')) console.log(JSON.stringify({id:'acceptance-folder',status:'ACTIVE'})); else throw Error('Unexpected cloud write '+args.join(' '));\n`);
  chmodSync(join(bin, "yc"), 0o755);
  const invoke = (args: string[]) => run(process.execPath, [cli, ...args], project);
  invoke(["init", project, "--folder-id", "acceptance-folder", "--no-install"]);
  invoke(["add", "asset", "website", "--template", "vite", "--route", "/*"]);
  invoke(["add", "function", "ping", "--template", "api", "--route", "/api/ping"]);
  invoke(["add", "function", "image", "--template", "ai-image", "--route", "/api/image"]);
  invoke(["add", "database", "primary", "--migrations"]);
  invoke(["add", "auth", "--database", "primary"]);
  invoke(["add", "function", "timer", "--cron", "* * ? * * *"]);
  run("pnpm", ["install"], project);
  run("pnpm", ["build"], project);
  run("pnpm", ["typecheck"], project);
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  for (const [name, selected] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) if (name.startsWith("@vibecloud/")) assert.equal(selected, version, name);
  writeFileSync(join(project, "runtime-smoke.mjs"), readFileSync(join(root, "scripts/fixtures/runtime-smoke.mjs")));
  run(process.execPath, ["runtime-smoke.mjs"], project);
  // A real deployed-runtime family, separate from the Node 26 CLI/toolchain.
  run("pnpm", ["dlx", "node@22.22.0", "runtime-smoke.mjs"], project);
  passed = true;
  console.log(`Registry application and Node 22/26 runtime acceptance passed for ${version}`);
} finally {
  if (passed) removeSuccessfulAcceptanceWorkspace(temporary, { keep: Boolean(process.env.VIBECLOUD_KEEP_ACCEPTANCE) });
  else console.error(`Registry acceptance retained at ${temporary}`);
}
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
