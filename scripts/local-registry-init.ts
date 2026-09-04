import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const directoryArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (!directoryArgument) {
  console.error("usage: pnpm local:init -- <empty-project-directory>");
  process.exit(64);
}

const registry = localRegistry();
const directory = resolve(directoryArgument);
const environment = {
  ...process.env,
  PNPM_CONFIG_REGISTRY: registry,
  PNPM_CONFIG_PREFER_ONLINE: "true",
};
const developmentVersion = read("pnpm", [
  "view",
  "@vibecloud/cli@dev",
  "version",
  "--json",
  "--registry",
  registry,
], dirname(directory));
const packageVersion = JSON.parse(developmentVersion);
if (typeof packageVersion !== "string" || !packageVersion.length) {
  throw new Error(`invalid @vibecloud/cli@dev version from ${registry}: ${developmentVersion}`);
}

mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, ".npmrc"), `registry=${registry}\n@vibecloud:registry=${registry}\n`, { flag: "wx" });
const packageNames = [
  "core",
  "ai",
  "function-api",
  "function-trigger-cron",
  "function-trigger-datastream",
  "function-ws",
  "db",
  "telemetry",
  "cli",
];
const localReleaseExclusions = packageNames
  .map((name) => `  - "@vibecloud/${name}@${packageVersion}"`)
  .join("\n");
writeFileSync(
  join(directory, "pnpm-workspace.yaml"),
  `packages: []\n\n# Trust only this exact locally published Vibecloud release.\nminimumReleaseAgeExclude:\n${localReleaseExclusions}\n`,
  { flag: "wx" },
);
run("pnpm", ["dlx", `@vibecloud/cli@${packageVersion}`, "init", directory], dirname(directory));
console.log(`ready: ${directory}`);

function localRegistry() {
  const value = process.env.VIBECLOUD_LOCAL_REGISTRY ?? "http://registry.verdaccio.orb.local/";
  const url = new URL(value);
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]", "registry.verdaccio.orb.local"];
  if (url.protocol !== "http:" || !allowedHosts.includes(url.hostname)) {
    throw new Error(`local registry must be an approved local HTTP URL: ${value}`);
  }
  return url.href;
}

function run(command: string, arguments_: string[], cwd: string) {
  const result = spawnSync(command, arguments_, { cwd, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function read(command: string, arguments_: string[], cwd: string) {
  const result = spawnSync(command, arguments_, { cwd, env: environment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}
