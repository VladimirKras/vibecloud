import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { emptyProject } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { createLocalGateway, disposeLocalFunctions, watchFunctions } from "../src/dev.ts";
import { localRuntimeIdentity, stopLocalProject, LOCAL_OWNER_LABEL } from "../src/local-runtime.ts";
import { refreshGuidance } from "../src/guidance.ts";
import { createObjectStorage } from "../../storage/src/index.ts";
import { addResource, renameResource } from "../src/config-edit.ts";
import { localResourceNames } from "../src/local-identities.ts";
import { localDatabases, localServicesCompose } from "../src/local-services.ts";
import { withProjectMutation } from "../src/project-lock.ts";

test("bucket renames preserve bytes and URLs across chained renames, rename-back, and privacy changes", async (t) => {
  const { directory, configPath } = await emptyProject("media-rename-app");
  await addResource(configPath, "bucket", "images", { public: true });
  const loaded = await loadConfig(configPath);
  const server = createLocalGateway(loaded);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const bytes = Buffer.from([0, 255, 128, 5]);
  const environment = { VIBECLOUD_DEV_CONTAINER: "1", VIBECLOUD_STORAGE_DIRECTORY: join(directory, ".vibecloud/media"), VIBECLOUD_STORAGE_URL: "/_vibecloud/media" };
  const original = await createObjectStorage({}, { bucket: "vc-images", environment }).put("original.png", bytes, { contentType: "image/png" });
  for (const [oldName, newName] of [["images", "pictures"], ["pictures", "scenes"], ["scenes", "images"]]) {
    await renameResource(configPath, "bucket", oldName, newName);
    loaded.config = (await loadConfig(configPath)).config;
    const names = await localResourceNames(directory, "buckets", loaded.config.buckets);
    assert.deepEqual(names, { [newName]: "vc-images" });
    const response = await fetch(origin + original.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const stored = await createObjectStorage({}, { bucket: names[newName], environment }).put(`${newName}.png`, bytes, { contentType: "image/png" });
    const next = await fetch(origin + stored.url);
    assert.equal(next.status, 200);
    await next.arrayBuffer();
  }
  loaded.config.buckets!.images.public = false;
  const privateResponse = await fetch(origin + original.url);
  assert.equal(privateResponse.status, 404);
  await privateResponse.text();
  delete loaded.config.buckets!.images;
  const removed = await fetch(origin + original.url);
  assert.equal(removed.status, 404);
  await removed.text();
});

test("local gateway preserves binary bytes, limits envelopes, and serves public media directly", async (t) => {
  const { directory, configPath } = await emptyProject("binary-app");
  const loaded = await loadConfig(configPath);
  loaded.config.functions = { api: { handler: "index.handler" } };
  loaded.config.gateway.routes = [{ pattern: "/*", function: "api" }];
  loaded.config.buckets = { images: { public: true }, private: {} };
  const output = join(directory, "dist/functions/http-nodejs22");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "package.json"), '{"type":"commonjs"}');
  await writeFile(join(output, "router.js"), "exports.handler = async e => ({statusCode:200,body:e.body,isBase64Encoded:e.isBase64Encoded});");
  const server = createLocalGateway(loaded);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeLocalFunctions(loaded);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const bytes = Buffer.from([0, 255, 128, 195, 40, 13, 10]);
  const echo = await fetch(origin, { method: "POST", body: bytes });
  assert.deepEqual(Buffer.from(await echo.arrayBuffer()), bytes);
  for (const oversized of [Buffer.alloc(3_500_001, 65), Buffer.alloc(2_700_000, 255)]) {
    const response = await fetch(origin, { method: "POST", body: oversized });
    assert.equal(response.status, 413);
    await response.text();
  }
  const environment = { VIBECLOUD_DEV_CONTAINER: "1", VIBECLOUD_STORAGE_DIRECTORY: join(directory, ".vibecloud/media"), VIBECLOUD_STORAGE_URL: "/_vibecloud/media" };
  for (const bucket of ["vc-images", "vc-private"]) {
    const storage = createObjectStorage({}, { bucket, environment });
    const object = await storage.put("scene.png", bytes, { contentType: "image/png" });
    const response = await fetch(origin + object.url);
    assert.equal(response.status, bucket === "vc-images" ? 200 : 404);
    if (response.ok) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    else await response.text();
  }
});

test("shared backend edits trigger rebuilds and closing the watcher stops subsequent rebuilds", async (t) => {
  const { directory, configPath } = await emptyProject("shared-watch-app");
  const loaded = await loadConfig(configPath);
  loaded.config.functions = { api: { handler: "index.handler" } };
  const shared = join(directory, "src/shared");
  await mkdir(shared, { recursive: true });
  const source = join(shared, "value.ts");
  await writeFile(source, "first");
  await writeFile(join(directory, "build.ts"), 'import {readFile,writeFile} from "node:fs/promises"; await writeFile("observed", await readFile("src/shared/value.ts"));');
  const watcher = watchFunctions(loaded);
  assert.ok(watcher, "source watcher must be available");
  t.after(() => watcher.close());
  await writeFile(source, "second");
  let observed = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await readFile(join(directory, "observed"), "utf8").catch(() => "");
    if (observed === "second") break;
    await delay(25);
  }
  assert.equal(observed, "second");
  watcher.close();
  await delay(20);
  await writeFile(source, "third");
  await delay(250);
  assert.equal(await readFile(join(directory, "observed"), "utf8"), "second");
});

test("same-named checkouts have separate Docker identities and teardown verifies every owner", async () => {
  const first = await emptyProject("same-name");
  const second = await emptyProject("same-name");
  const identity = await localRuntimeIdentity(first.directory);
  assert.notEqual(identity.project, (await localRuntimeIdentity(second.directory)).project);
  const loaded = await loadConfig(first.configPath);
  const commands: string[][] = [];
  let foreign = true;
  const readCommand = async (_command: string, args: string[]) => {
    if (args.includes("inspect")) return JSON.stringify({ [LOCAL_OWNER_LABEL]: foreign && args.at(-1) === "data" ? "another-owner" : identity.owner });
    return args[0] === "ps" ? "container" : args[0] === "volume" ? "data" : "network";
  };
  const runCommand = async (_command: string, args: string[]) => {
    commands.push(args);
  };
  await assert.rejects(stopLocalProject(loaded, { readCommand, runCommand }), /not owned/);
  assert.deepEqual(commands, []);
  foreign = false;
  await stopLocalProject(loaded, { readCommand, runCommand });
  assert.deepEqual(commands, [["stop", "container"], ["rm", "container"], ["network", "rm", "network"]]);
  commands.length = 0;
  await assert.rejects(stopLocalProject(loaded, { volumes: true, readCommand, runCommand }), /--confirm delete-local:same-name/);
  assert.deepEqual(commands, []);
  await stopLocalProject(loaded, { volumes: true, confirmation: "delete-local:same-name", readCommand, runCommand });
  assert.deepEqual(commands.at(-1), ["volume", "rm", "data"]);
});

test("guidance upgrades refresh recorded generated content while preserving authored changes", async () => {
  const { directory } = await emptyProject("guidance-app");
  const agents = join(directory, "AGENTS.md");
  const current = await readFile(agents, "utf8");
  const manifestPath = join(directory, ".vibecloud/generated-guidance.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const old = "Previous generated guidance\n";
  await writeFile(agents, old);
  manifest["AGENTS.md"] = createHash("sha256").update(old).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await refreshGuidance(directory);
  assert.equal(await readFile(agents, "utf8"), current);
  await writeFile(agents, current + "\nAuthored instruction\n");
  await refreshGuidance(directory);
  assert.equal(await readFile(agents, "utf8"), current + "\nAuthored instruction\n");
});

test("database renames retain persistent volumes, hostnames and migration endpoints", async () => {
  const { directory, configPath } = await emptyProject("database-rename-app");
  await addResource(configPath, "database", "primary", { migrations: true });
  const initial = await loadConfig(configPath);
  const identity = await localRuntimeIdentity(directory);
  const before = await localServicesCompose(initial, identity);
  const endpoint = (await localDatabases(initial)).primary.endpoint;
  for (const [from, to] of [["primary", "renamed"], ["renamed", "archive"], ["archive", "primary"]]) {
    await renameResource(configPath, "database", from, to);
    const loaded = await loadConfig(configPath);
    const model = await localServicesCompose(loaded, identity);
    assert.deepEqual(model, before, "renaming must reattach the same Docker services and volumes");
    assert.deepEqual(Object.keys(await localDatabases(loaded)), [to]);
    assert.equal((await localDatabases(loaded))[to].endpoint, endpoint);
  }
  const path = join(directory, ".vibecloud/local-databases.json");
  const original = await readFile(path, "utf8");
  await assert.rejects(withProjectMutation(directory, async () => {
    await renameResource(configPath, "database", "primary", "failed");
    throw new Error("later failure");
  }), /later failure/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await localServicesCompose(await loadConfig(configPath), identity), before);
  await writeFile(path, JSON.stringify({ primary: "ydb-shared", second: "ydb-shared" }));
  initial.config.databases!.second = {};
  await assert.rejects(localDatabases(initial), /distinct storage identities/);
});

test("guidance retires only recorded generated files and rolls deletions back on failure", async (t) => {
  const { directory } = await emptyProject("retired-guidance-app");
  const manifestPath = join(directory, ".vibecloud/generated-guidance.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const retiredKey = ".agents/skills/vibecloud/references/retired.md";
  const authoredKey = ".agents/skills/vibecloud/references/customized.md";
  const missingKey = ".agents/skills/vibecloud/references/missing.md";
  const bytes = "Retired generated flow\n";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const retired = join(directory, retiredKey);
  await writeFile(retired, bytes, { mode: 0o755 });
  await writeFile(join(directory, authoredKey), bytes + "User changes\n");
  await writeFile(join(directory, "source.ts"), bytes);
  for (const key of [retiredKey, authoredKey, missingKey, "source.ts", ".agents/skills/vibecloud/../../../source.ts"]) manifest[key] = hash;
  const originalManifest = JSON.stringify(manifest);
  await writeFile(manifestPath, originalManifest);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  await assert.rejects(withProjectMutation(directory, async () => {
    await refreshGuidance(directory);
    await assert.rejects(readFile(retired), { code: "ENOENT" });
    throw new Error("later failure");
  }), /later failure/);
  assert.equal(await readFile(retired, "utf8"), bytes);
  assert.equal((await stat(retired)).mode & 0o777, 0o755);
  assert.equal(await readFile(manifestPath, "utf8"), originalManifest);
  await refreshGuidance(directory);
  await assert.rejects(readFile(retired), { code: "ENOENT" });
  assert.equal(await readFile(join(directory, authoredKey), "utf8"), bytes + "User changes\n");
  assert.equal(await readFile(join(directory, "source.ts"), "utf8"), bytes);
  const next = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const key of [retiredKey, authoredKey, missingKey, "source.ts"]) assert.equal(next[key], undefined);
  assert.ok(warnings.some((warning) => warning.includes("authored retired guidance")));
});

test("retired guidance cannot delete symlink targets", async () => {
  const { directory } = await emptyProject("retired-symlink-app");
  const target = join(directory, "source.ts");
  const bytes = "authored application source";
  await writeFile(target, bytes);
  const key = ".agents/skills/vibecloud/references/retired.md";
  await symlink(target, join(directory, key));
  const manifest = join(directory, ".vibecloud/generated-guidance.json");
  await writeFile(manifest, JSON.stringify({ [key]: createHash("sha256").update(bytes).digest("hex") }));
  await assert.rejects(refreshGuidance(directory), /symbolic link/);
  assert.equal(await readFile(target, "utf8"), bytes);
});
