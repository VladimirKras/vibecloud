import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceWorkspace, removeSuccessfulAcceptanceWorkspace } from "./acceptance-workspace.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = createAcceptanceWorkspace(join(root, ".tmp"), "vibecloud-release-acceptance-");
const packed = join(temporary, "packed");
const driver = join(temporary, "driver");
const project = join(temporary, "acceptance-app");
const fakeBin = join(temporary, "bin");
let passed = false;

try {
  for (const directory of [packed, driver, fakeBin]) mkdirSync(directory, { recursive: true });
  const packResult = capture("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", packed, "--json"], join(root, "packages", "cli"));
  const tarball = resolve(join(root, "packages", "cli"), JSON.parse(packResult).filename);

  writeFileSync(join(driver, "package.json"), `${JSON.stringify({
    private: true,
    packageManager: "pnpm@11.15.1",
    dependencies: { "@vibecloud/cli": `file:${tarball}` },
  }, null, 2)}\n`);
  writeFileSync(join(driver, "pnpm-workspace.yaml"), "packages: []\n");
  run("pnpm", ["install", "--ignore-scripts"], driver);

  const yc = join(fakeBin, "yc");
  writeFileSync(yc, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") process.stdout.write("Yandex Cloud CLI 0.170.0\\n");
else if (args.includes("get")) process.stdout.write(JSON.stringify({ id: "acceptance-folder-id", status: "ACTIVE" }));
else { process.stderr.write("unexpected yc invocation: " + args.join(" ")); process.exitCode = 1; }
`);
  chmodSync(yc, 0o755);
  const cli = join(driver, "node_modules", "@vibecloud", "cli", "dist", "vibecloud.js");
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    YC_TOKEN: "acceptance-token",
  };
  run(process.execPath, [
    cli,
    "init",
    "--folder-id",
    "acceptance-folder-id",
    "--no-install",
    project,
  ], driver, environment);
  run(process.execPath, [cli, "add", "asset", "website", "--template", "vite", "--route", "/*"], project, environment);

  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.devDependencies["@vibecloud/cli"] = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(project, "vite.config.ts"), `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), {
    name: "vibecloud-release-acceptance",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "vite-config-loaded.txt", source: "loaded\\n" });
    },
  }],
});
`);
  run("pnpm", ["install"], project);
  run("pnpm", ["lint"], project);
  run("pnpm", ["build"], project);
  readFileSync(join(project, "dist", "assets", "website", "vite-config-loaded.txt"), "utf8");

  const terraformEnvironment = { ...process.env, TF_CLI_CONFIG_FILE: join(project, "infra", "terraform.rc") };
  run("terraform", ["-chdir=infra", "init", "-input=false", "-lockfile=readonly"], project, terraformEnvironment);
  run("terraform", ["-chdir=infra", "validate"], project, terraformEnvironment);
  const schemas = JSON.parse(capture("terraform", ["-chdir=infra", "providers", "schema", "-json"], project, terraformEnvironment));
  if (!schemas.provider_schemas?.["registry.terraform.io/yandex-cloud/yandex"]) throw new Error("Yandex provider schema is missing");
  console.log("clean CLI tarball init/build/Terraform schema acceptance passed");
  passed = true;
} catch (error) {
  console.error(`acceptance workspace retained at ${temporary}`);
  throw error;
} finally {
  if (passed) removeSuccessfulAcceptanceWorkspace(temporary, { keep: Boolean(process.env.VIBECLOUD_KEEP_ACCEPTANCE) });
}

function run(command: string, arguments_: string[], cwd = root, env = process.env) {
  const result = spawnSync(command, arguments_, { cwd, env, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} failed with exit code ${result.status}`);
}

function capture(command: string, arguments_: string[], cwd = root, env = process.env) {
  const result = spawnSync(command, arguments_, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed with exit code ${result.status}`);
  return result.stdout;
}
