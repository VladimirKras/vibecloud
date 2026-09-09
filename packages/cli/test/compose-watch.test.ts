import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { devProject } from "../src/dev.ts";
import { emptyProject } from "./helpers.ts";
import { stopLocalProject } from "../src/local-runtime.ts";

test("running dev recreates service topology and credentials after valid atomic configuration edits", { timeout: 15_000 }, async (t) => {
  const { directory, configPath } = await emptyProject("compose-reload-app");
  const loaded = await loadConfig(configPath);
  const bin = join(directory, "bin");
  const log = join(directory, "compose.jsonl");
  await mkdir(bin);
  // Exercise real devProject orchestration; only the external Docker/YC
  // processes are recording stand-ins. No containers or cloud writes are used.
  await writeFile(join(bin, "docker"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "info") console.log('{"OperatingSystem":"OrbStack"}');
else if (args[0] === "context") console.log("default");
else if (args[0] === "ps" || args[1] === "ls") {}
else if (args[1] === "version") console.log("2.40.0");
else if (args.includes("up")) {
  const model = JSON.parse(fs.readFileSync(args.find(arg => arg.endsWith(".local.services.compose.json"))));
  process.on("SIGINT", () => process.exit(0));
  fs.appendFileSync("compose.jsonl", JSON.stringify({ args, model, token: process.env.YANDEX_CLOUD_IAM_TOKEN, pid: process.pid }) + "\\n");
  const timer = setInterval(() => { if (fs.existsSync("finish")) process.exit(0); }, 20);
  setTimeout(() => { clearInterval(timer); process.exit(2); }, 10000).unref();
} else process.exit(2);
`, { mode: 0o755 });
  await writeFile(join(bin, "yc"), `#!${process.execPath}\nconsole.log("mock-profile-token");\n`, { mode: 0o755 });
  const keys = ["PATH", "YANDEX_CLOUD_API_KEY", "YANDEX_CLOUD_IAM_TOKEN", "VIBECLOUD_LOCAL_AI", "VIBECLOUD_DEV_CONTAINER"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.PATH = `${bin}:${original.PATH}`;
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const running = devProject(loaded);
  const failure = running.then(() => undefined, (error: unknown) => error);
  const observations = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const waitFor = async (count: number) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const rows = await observations();
      if (rows.length >= count) return rows;
      await delay(20);
    }
    assert.fail(`Compose did not start ${count} times`);
  };
  const save = async (config: object) => {
    await writeFile(`${configPath}.next`, JSON.stringify(config));
    await rename(`${configPath}.next`, configPath);
  };
  try {
    const [initial] = await waitFor(1);
    assert.deepEqual(Object.keys(initial.model.services), ["app"]);
    assert.equal(initial.token, undefined);
    await writeFile(configPath, "{invalid");
    await delay(350);
    assert.equal((await observations()).length, 1);
    assert.ok(errors.length);
    await save({ ...loaded.config, databases: { primary: {} } });
    const second = (await waitFor(2))[1];
    assert.deepEqual(Object.keys(second.model.services), ["ydb-primary", "app"]);
    assert.deepEqual(second.model.services.app.depends_on, { "ydb-primary": { condition: "service_healthy" } });
    await save({ ...loaded.config, databases: { primary: {}, secondary: {} }, ai: { responses: true } });
    const third = (await waitFor(3))[2];
    assert.equal(third.token, "mock-profile-token");
    assert.deepEqual(Object.keys(third.model.services), ["ydb-primary", "ydb-secondary", "app"]);
    assert.deepEqual(third.model.services["ydb-primary"].volumes, second.model.services["ydb-primary"].volumes);
    await save(loaded.config);
    const fourth = (await waitFor(4))[3];
    assert.deepEqual(Object.keys(fourth.model.services), ["app"]);
    assert.equal(fourth.token, undefined);
    for (const row of await observations()) assert.ok(row.args.includes("--remove-orphans"));
    await writeFile(join(directory, "finish"), "");
    assert.equal(await failure, undefined);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
    await save({ ...loaded.config, databases: { primary: {} } });
    await delay(200);
    assert.equal((await observations()).length, 4, "watcher must close when dev exits");
  } finally {
    await writeFile(join(directory, "finish"), "");
    await failure;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

for (const phase of ["inspection", "running"]) {
  test(`down cancels a separate dev controller during ${phase} before Docker teardown`, { timeout: 15_000 }, async () => {
    const { directory, configPath } = await emptyProject(`down-${phase}-app`);
    const loaded = await loadConfig(configPath);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "info") console.log('{"OperatingSystem":"OrbStack"}');
else if (args[0] === "context") console.log("default");
else if (args[1] === "version") console.log("2.40.0");
else if (args[0] === "ps" && ${JSON.stringify(phase)} === "inspection") {
  fs.writeFileSync("ready", "");
  setInterval(() => { if (fs.existsSync("resume")) process.exit(0); }, 20);
} else if (args[0] === "ps" || args[1] === "ls") {}
else if (args.includes("up")) {
  fs.appendFileSync("starts", "up\\n");
  process.on("SIGINT", () => setTimeout(() => { fs.writeFileSync("closed", ""); process.exit(0); }, 100));
  fs.writeFileSync("ready", "");
  setInterval(() => {}, 1000);
} else process.exit(2);
`, { mode: 0o755 });
    const code = `import { loadConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
import { devProject } from ${JSON.stringify(new URL("../src/dev.ts", import.meta.url).href)};
await devProject(await loadConfig(${JSON.stringify(configPath)}));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBECLOUD_DEV_CONTAINER: "0", VIBECLOUD_LOCAL_AI: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      for (let attempt = 0; ; attempt++) {
        if (await readFile(join(directory, "ready")).then(() => true, () => false)) break;
        assert.ok(attempt < 200 && child.exitCode === null, output || "dev did not reach the blocked startup phase");
        await delay(20);
      }
      await assert.rejects(devProject(loaded), /already running/);
      const resources = await stopLocalProject(loaded, {
        readCommand: async () => {
          if (phase === "running") await readFile(join(directory, "closed"));
          return "";
        },
        runCommand: async () => assert.fail("empty Docker inventory should not run teardown commands"),
      });
      assert.deepEqual(resources.containers, []);
      await writeFile(join(directory, "resume"), "");
      assert.equal(await completed, 0, output);
      await writeFile(configPath, JSON.stringify({ ...loaded.config, databases: { late: {} } }));
      await delay(200);
      const starts = await readFile(join(directory, "starts"), "utf8").catch(() => "");
      assert.equal(starts, phase === "running" ? "up\n" : "", "down must cancel both pending startup and future config restarts");
      await assert.rejects(readFile(join(directory, ".vibecloud/local-session.json")), { code: "ENOENT" });
    } finally {
      child.kill("SIGTERM");
      await completed;
    }
  });
}
