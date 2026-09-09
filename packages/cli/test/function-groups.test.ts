import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { buildFunctionGroups } from "../dist/function-build.js";
import { functionGroups, type FunctionDeclaration } from "../src/function-groups.ts";
import { createFunctionRouter } from "../src/function-router.ts";
import { addFunction, addResource, removeResource, removeRoute, renameResource } from "../src/config-edit.ts";
import { loadConfig } from "../src/config.ts";
import { disposeLocalFunctions, invokeLocalFunction } from "../src/dev.ts";
import { readCommandOutput } from "../src/commands.ts";
import { emptyProject, readJson } from "./helpers.ts";

const eventType = "yandex.cloud.events.serverless.triggers.TimerMessage";
const timer = (name: string) => ({ event_metadata: { event_type: eventType }, details: { trigger_id: "trigger", payload: name } });

test("synchronous image generation has sufficient defaults and respects explicit limits", () => {
  const declaration: FunctionDeclaration = { gateway: { routes: [] }, functions: {
    image: { handler: "index.handler", template: "ai-image" },
  } };
  const defaults = functionGroups(declaration)["http-nodejs22"];
  assert.equal(defaults.timeout_seconds, 120);
  assert.equal(defaults.memory_mb, 256);
  declaration.functions!.image.timeout_seconds = 45;
  declaration.functions!.image.memory_mb = 512;
  const customized = functionGroups(declaration)["http-nodejs22"];
  assert.equal(customized.timeout_seconds, 45);
  assert.equal(customized.memory_mb, 512);
});

test("deployment groups depend on type and runtime, not handler names or resource settings", () => {
  const groups = functionGroups({ gateway: { routes: [] }, functions: {
    first: { handler: "index.handler" }, second: { handler: "index.handler", memory_mb: 512, timeout_seconds: 60 },
    python: { handler: "index.handler", runtime: "python312" }, socket: { handler: "index.handler", template: "websocket" },
    cleanup: { handler: "index.handler", cron: { expression: "* * * * ? *" } },
    stream: { handler: "index.handler", template: "datastream-trigger" },
  } });
  assert.deepEqual(Object.keys(groups).sort(), ["http-nodejs22", "http-python312", "stream-stream", "timer-nodejs22", "websocket-nodejs22"]);
  assert.equal(groups["http-nodejs22"].memory_mb, 512);
  assert.equal(groups["http-nodejs22"].timeout_seconds, 60);
  assert.deepEqual(Object.keys(groups["http-nodejs22"].functions), ["first", "second"]);
});

test("timer router validates the complete batch, restores payloads, preserves context, and propagates failures", async () => {
  const seen: unknown[] = [];
  const handler = createFunctionRouter("timer", [], {
    one: async () => (event, context) => { seen.push({ event, context }); },
    two: async () => () => { throw new Error("retry this batch"); },
  }, { one: { payload: "x".repeat(4096) }, two: {} });
  await assert.rejects(handler({ messages: [timer("one"), timer("unknown")] }, {}), /Unknown timer/);
  assert.deepEqual(seen, []);
  const context = { logicalFunctionName: undefined, requestId: "request", getPayload: () => "context" };
  await handler({ messages: [timer("one")] }, context);
  const invocation = seen[0] as { event: { messages: { details: { payload: string, trigger_id: string } }[] }, context: typeof context };
  assert.equal(invocation.event.messages[0].details.payload.length, 4096);
  assert.equal(invocation.event.messages[0].details.trigger_id, "trigger");
  assert.equal(invocation.context.getPayload(), "context");
  assert.equal(invocation.context.requestId, "request");
  assert.equal(invocation.context.logicalFunctionName, "one");
  assert.equal(context.logicalFunctionName, undefined);
  await assert.rejects(handler({ messages: [timer("two")] }, context), /retry this batch/);
});

test("built HTTP, WebSocket, and timer groups dispatch to isolated lazy handlers", async () => {
  const { directory } = await emptyProject("router-app");
  const declaration: FunctionDeclaration = { gateway: { routes: [
    { pattern: "/*", function: "fallback" }, { pattern: "/api/*", function: "api" },
    { pattern: "/api/item", method: "POST", function: "create" }, { pattern: "/one", method: "WS", function: "socket" },
    { pattern: "/two", method: "WS", function: "other-socket" },
  ] }, functions: {
    "fallback": { handler: "index.handler" }, "api": { handler: "nested/module.handle" }, "create": { handler: "index.handler" },
    "broken": { handler: "index.handler" }, "socket": { handler: "index.handler", template: "websocket" },
    "other-socket": { handler: "index.handler", template: "websocket" },
    "first": { handler: "index.handler", cron: { expression: "* * * * ? *", payload: "original" } },
    "second": { handler: "index.handler", cron: { expression: "* * * * ? *" } },
  } };
  for (const [name, definition] of Object.entries(declaration.functions!)) {
    const module = definition.handler.slice(0, definition.handler.lastIndexOf("."));
    const path = join(directory, "src", "functions", name, module + ".ts");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, name === "broken"
      ? 'throw new Error("must stay lazy"); export const handler = () => {};'
      : `let calls = 0; export const ${definition.handler.split(".").at(-1)} = (event, context) => ({ name: ${JSON.stringify(name)}, calls: ++calls, event, logicalName: context.logicalFunctionName });`);
  }
  await buildFunctionGroups(directory, declaration, build);
  const require = createRequire(import.meta.url);
  const http = require(join(directory, "dist/functions/http-nodejs22/router.js")).handler;
  assert.equal((await http({ path: "/api/item", httpMethod: "POST" }, {})).name, "create");
  const response = await http({ path: "/api/item", httpMethod: "GET", body: "raw", isBase64Encoded: true }, {});
  assert.equal(response.name, "api");
  assert.deepEqual(response.event.pathParameters, { path: "item" });
  assert.equal(response.event.resource, "/api/{path+}");
  assert.equal(response.event.isBase64Encoded, true);
  assert.equal(response.logicalName, "api");
  assert.equal((await http({ path: "/api/item", httpMethod: "GET" }, {})).calls, 2);
  assert.equal((await http({ path: "/", httpMethod: "GET" }, {})).name, "fallback");
  const ws = require(join(directory, "dist/functions/websocket-nodejs22/router.js")).handler;
  for (const eventType of ["CONNECT", "MESSAGE", "DISCONNECT"]) {
    assert.equal((await ws({ path: "/two", requestContext: { eventType, connectionId: "id" } }, {})).name, "other-socket");
  }
  assert.equal((await ws({ path: "/missing" }, {})).statusCode, 404);
  const cron = require(join(directory, "dist/functions/timer-nodejs22/router.js")).handler;
  assert.equal((await cron({ messages: [timer("first")] }, {})).event.messages[0].details.payload, "original");
  assert.equal(Object.hasOwn((await cron({ messages: [timer("second")] }, {})).event.messages[0].details, "payload"), false);
});

test("Python and Go grouped routers execute authored handlers", async () => {
  const { directory, configPath } = await emptyProject("language-router-app");
  const declaration: FunctionDeclaration = { gateway: { routes: [] }, functions: {} };
  for (const runtime of ["python312", "golang123"]) {
    for (const name of ["one", "two"]) {
      const key = `${runtime}-${name}`;
      declaration.functions![key] = { runtime, handler: runtime.startsWith("python") ? "index.handler" : "index.Handle" };
      declaration.gateway.routes!.push({ pattern: `/${key}`, function: key });
      const source = join(directory, "src", "functions", key);
      await mkdir(source, { recursive: true });
      if (runtime.startsWith("python")) await writeFile(join(source, "index.py"), `${name === "two" ? "async " : ""}def handler(event, context): return {"name": "${name}", "path": event["path"]}\n`);
      else {
        await writeFile(join(source, "go.mod"), `module example.local/${key}\n\ngo 1.23\n`);
        await writeFile(join(source, "index.go"), `package main\nimport "context"\ntype Event struct { Path string }\nfunc Handle(ctx context.Context, event Event) (string, error) { return "${name}:" + event.Path, ctx.Err() }\n`);
      }
    }
  }
  for (const runtime of ["python312", "golang123"]) {
    declaration.gateway.routes!.push(
      { pattern: `/${runtime}/*`, function: `${runtime}-one` },
      { pattern: `/${runtime}/item`, function: `${runtime}-one` },
      { pattern: `/${runtime}/item`, method: "post", function: `${runtime}-two` },
      { pattern: `/${runtime}/nested/*`, function: `${runtime}-two` },
    );
  }
  declaration.functions!["golang123-standard"] = { runtime: "golang123", handler: "index.Handle" };
  declaration.gateway.routes!.push({ pattern: "/standard", function: "golang123-standard" });
  const standard = join(directory, "src/functions/golang123-standard");
  await mkdir(standard, { recursive: true });
  await writeFile(join(standard, "go.mod"), "module example.local/standard\n\ngo 1.23\n");
  await writeFile(join(standard, "index.go"), 'package main\nimport ("net/http"; "io")\nfunc Handle(w http.ResponseWriter, r *http.Request) { w.Header().Add("Set-Cookie", "one=1"); w.Header().Add("Set-Cookie", "two=2"); io.Copy(w, r.Body) }\n');
  const rebuild = async () => {
    await writeFile(configPath, JSON.stringify({ ...await readJson(configPath), ...declaration }));
    await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  };
  const verify = async () => {
    const python = spawnSync("python3", ["-c", 'import router; assert router.handler({"httpMethod":"GET","path":"/python312-two"}, None)["name"] == "two"; assert router.handler({"path":"/missing"},None)["statusCode"] == 404; assert router.handler({"httpMethod":"POST","path":"/python312/item"},None)["name"] == "two"; assert router.handler({"httpMethod":"GET","path":"/python312/nested/item"},None)["name"] == "two"'], { cwd: join(directory, "dist/functions/http-python312"), encoding: "utf8" });
    assert.equal(python.status, 0, python.stdout + python.stderr);
    const goOutput = join(directory, "dist/functions/http-golang123");
    await writeFile(join(goOutput, "router_test.go"), "package main\nimport (\"testing\"; \"context\")\nfunc TestRouter(t *testing.T) { result, err := Handler(context.Background(), map[string]any{\"httpMethod\":\"GET\", \"path\":\"/golang123-two\"}); if err != nil || result != \"two:/golang123-two\" { t.Fatalf(\"%v %v\", result, err) } }\n");
    await writeFile(join(goOutput, "standard_test.go"), `package main
import ("testing"; "context"; "net/http"; "strings")
func TestStandard(t *testing.T) {
 for _, request := range []map[string]any{{"httpMethod":"POST","path":"/golang123/item"}, {"httpMethod":"GET","path":"/golang123/nested/item"}} {
   result, err := Handler(context.Background(), request)
   if err != nil || result != "two:" + request["path"].(string) { t.Fatalf("%v %v",result,err) }
 }
 result, err := Handler(context.Background(), map[string]any{"httpMethod":"POST", "path":"/standard", "body":"aGVsbG8=", "isBase64Encoded":true})
 if err != nil { t.Fatal(err) }; value := result.(map[string]any)
 if value["body"] != "aGVsbG8=" || len(value["multiValueHeaders"].(http.Header).Values("Set-Cookie")) != 2 { t.Fatal(value) }
 input := map[string]any{
   "headers": map[string]any{"X-Input":"old","Host":"example.test"},
   "multiValueHeaders": map[string]any{"x-input":[]any{"one","two"}},
   "queryStringParameters": map[string]any{"tag":"old"},
   "multiValueQueryStringParameters": map[string]any{"tag":[]any{"a","b"}},
 }
 headers := http.Header(gatewayValues(input, "headers"))
 if strings.Join(headers.Values("X-Input"), ",") != "one,two" || headers.Get("Host") != "example.test" || gatewayValues(input, "queryStringParameters").Encode() != "tag=a&tag=b" { t.Fatal(headers) }
 input["multiValueHeaders"] = map[string]any{"X-Input":[]any{}}
 if len(gatewayValues(input, "headers")["X-Input"]) != 0 { t.Fatal("empty multi-value header did not clear the single value") }
 handlers["raw"] = func(input []byte) (string, error) { return string(input), nil }
 raw, err := invoke(context.Background(), "raw", map[string]any{"hello":"world"})
 if err != nil || !strings.Contains(raw.(string), "world") { t.Fatalf("%v %v",raw,err) }
 handlers["noargs"] = func() error { return nil }
 if _, err := invoke(context.Background(), "noargs", nil); err != nil { t.Fatal(err) }
}
`);
    const go = spawnSync("go", ["test", "-mod=mod", "./..."], { cwd: goOutput, encoding: "utf8", env: { ...process.env, GOCACHE: join(tmpdir(), "vibecloud-go-build-cache"), GOMODCACHE: join(tmpdir(), "vibecloud-go-module-cache") } });
    assert.equal(go.status, 0, go.stdout + go.stderr);
  };
  await rebuild();
  await verify();
  for (const runtime of ["python312", "golang123"]) delete declaration.functions![`${runtime}-one`];
  declaration.gateway.routes = declaration.gateway.routes!.filter((route) => !route.function?.endsWith("-one"));
  await rebuild();
  await verify();
  assert.match(await readFile(join(directory, "src/functions/golang123-one/index.go"), "utf8"), /package main/);
});

test("custom Node build artifacts keep their relative files inside grouped and isolated functions", async () => {
  const { directory, configPath } = await emptyProject("custom-router-app");
  await writeFile(join(directory, "builder.cjs"), `
const fs = require("node:fs"), path = require("node:path");
const output = process.env.VIBECLOUD_FUNCTION_OUTPUT;
fs.mkdirSync(path.join(output, "nested"), { recursive: true });
fs.writeFileSync(path.join(output, "nested", "asset.txt"), process.env.VIBECLOUD_FUNCTION_NAME);
fs.writeFileSync(path.join(output, "nested", "index.js"), 'exports.handler = () => require("node:fs").readFileSync(require("node:path").join(__dirname, "asset.txt"), "utf8");');
`);
  const custom = { handler: "nested/index.handler", build: { command: "node builder.cjs" } };
  await buildFunctionGroups(directory, { gateway: { routes: [{ pattern: "/custom", function: "api" }] }, functions: {
    api: custom, consumer: { ...custom, template: "datastream-trigger" },
  } }, build);
  const require = createRequire(import.meta.url);
  assert.equal(await require(join(directory, "dist/functions/http-nodejs22/router.js")).handler({ path: "/custom", httpMethod: "GET" }, {}), "api");
  assert.equal(await require(join(directory, "dist/functions/stream-consumer/nested/index.js")).handler({}, {}), "consumer");
  await writeFile(join(directory, "asset-builder.cjs"), `
const fs = require("node:fs"), path = require("node:path");
fs.mkdirSync(process.env.VIBECLOUD_ASSET_OUTPUT, { recursive: true });
fs.writeFileSync(path.join(process.env.VIBECLOUD_ASSET_OUTPUT, "manifest.json"), JSON.stringify({
  name: process.env.VIBECLOUD_ASSET_NAME, source: process.env.VIBECLOUD_ASSET_SOURCE,
}));
`);
  await writeFile(configPath, JSON.stringify({ ...await readJson(configPath), assets: { website: { build: { command: "node asset-builder.cjs" } } } }));
  await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  assert.deepEqual(await readJson(join(directory, "dist/assets/website/manifest.json")), { name: "website", source: join(await realpath(directory), "src/assets/website") });
  assert.deepEqual(await readdir(join(directory, "dist")), ["assets", "deployment-plan.json"]);
  await writeFile(join(directory, "asset-builder.cjs"), 'require("node:fs").mkdirSync(process.env.VIBECLOUD_ASSET_OUTPUT, { recursive: true });');
  await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
  assert.deepEqual(await readdir(join(directory, "dist/assets/website")), []);
});

test("adding, renaming, and removing handlers rebuilds shared groups without stale routes or workers", async (t) => {
  const { directory, configPath } = await emptyProject("membership-app");
  t.after(async () => disposeLocalFunctions(await loadConfig(configPath)));
  const rebuild = async () => {
    await readCommandOutput(process.execPath, ["build.ts"], process.env, directory);
    await disposeLocalFunctions(await loadConfig(configPath));
  };
  const request = async (path: string) => invokeLocalFunction(await loadConfig(configPath), {
    method: "GET", url: new URL(path, "http://localhost"), headers: {}, body: Buffer.alloc(0),
  });
  const source = async (name: string) => {
    const folder = join(directory, "src/functions", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "index.ts"), `let calls = 0; export const handler = () => ({statusCode: 200, body: ${JSON.stringify(name)} + ":" + ++calls});`);
  };
  await addFunction(configPath, "zulu", { template: "api" }, "/api/*");
  await source("zulu");
  await rebuild();
  assert.equal((await request("/api/item")).body, "zulu:1");
  assert.equal((await request("/api/item")).body, "zulu:2");

  // An earlier-sorting member must not change the shared function's identity.
  await addFunction(configPath, "alpha", { template: "api", memoryMb: 512 }, "/api/item");
  await source("alpha");
  await addResource(configPath, "function", "clock", { template: "cron-trigger", cronExpression: "0 * * * ? *" });
  await source("clock");
  await rebuild();
  assert.deepEqual(Object.keys((await readJson(join(directory, "dist/deployment-plan.json"))).function_groups).sort(), ["http-nodejs22", "timer-nodejs22"]);
  assert.equal((await request("/api/item")).body, "alpha:1");
  assert.equal((await request("/api/other")).body, "zulu:1");

  const before = await readFile(configPath, "utf8");
  await assert.rejects(removeResource(configPath, "function", "alpha"), /unknown function/);
  assert.equal(await readFile(configPath, "utf8"), before);
  await renameResource(configPath, "function", "alpha", "renamed");
  await rebuild();
  assert.equal((await request("/api/item")).body, "alpha:1");
  assert.doesNotMatch(await readFile(join(directory, "infra/moves.auto.tf"), "utf8"), /yandex_function\.functions/);

  await removeRoute(configPath, "ANY", "/api/item");
  await removeResource(configPath, "function", "renamed");
  await removeResource(configPath, "function", "clock");
  await rebuild();
  assert.deepEqual(await readdir(join(directory, "dist/functions")), ["http-nodejs22"]);
  assert.equal((await request("/api/item")).body, "zulu:1");
  assert.doesNotMatch(await readFile(join(directory, "dist/functions/http-nodejs22/router.js"), "utf8"), /alpha/);
  assert.equal(((await readJson(join(directory, "dist/deployment-plan.json"))).function_groups)["http-nodejs22"].memory_mb, 128);
  await stat(join(directory, "src/functions/renamed/index.ts"));

  await removeRoute(configPath, "ANY", "/api/*");
  await removeResource(configPath, "function", "zulu");
  await rebuild();
  assert.deepEqual(await readdir(join(directory, "dist")), ["deployment-plan.json"]);
  assert.equal((await request("/api/item")).statusCode, 404);
  await addFunction(configPath, "zulu", { template: "api" }, "/api/*");
  await rebuild();
  assert.equal((await request("/api/item")).body, "zulu:1");
});
