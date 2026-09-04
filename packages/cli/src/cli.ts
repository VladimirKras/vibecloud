#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import {
  addAuth,
  addAsset,
  addResource,
  addFunction,
  addRoute,
  addSecret,
  addStream,
  addTrigger,
  listConfig,
  renameResource,
  renameSecret,
  renameStream,
  removeResource,
  removeRoute,
  removeSecret,
  removeStream,
  removeTrigger,
  type EditResult,
} from "./config-edit.ts";
import { initProject } from "./init.ts";
import { doctorProject } from "./project-lifecycle.ts";
import { deleteProject } from "./project-delete.ts";
import { devProject } from "./dev.ts";
import { migrateProjectDatabases, pushProject } from "./push.ts";
import { createResourceScaffold, synchronizeProjectPackage } from "./scaffold.ts";

const defaultConfig = "infra/vibecloud.auto.tfvars.json";
const addCatalog = `
Templates and ready features:
  asset --template vite
    Gravity UI React/Vite frontend with local hot reload.
    pnpm vibecloud add asset website --template vite --route '/*'

  function --template api
    Runnable HTTP JSON endpoint for Node.js, Python, or Go.
    pnpm vibecloud add function api --template api --route '/api/*'

  function --template ai-agent
    Better Auth-protected Node.js text agent using AI Studio Responses.
    pnpm vibecloud add function agent --template ai-agent --route /api/agent

  function --template ai-turn
    Better Auth-protected AI turn: text/audio in, text/audio chunks out.
    pnpm vibecloud add function assistant --template ai-turn --route /api/turn

  function --template ai-image
    Public asynchronous YandexART image generation endpoint.
    pnpm vibecloud add function illustrator --template ai-image --route /api/images

  function --template websocket
    API Gateway WebSocket lifecycle and message-echo handler.
    pnpm vibecloud add function game --template websocket --route /ws

  function --template cron-trigger
    Scheduled handler that fails closed until its business logic is implemented.
    pnpm vibecloud add function cleanup --cron '0 * ? * * *'

  function --template datastream-trigger
    YDB Data Streams consumer that fails closed until implemented.
    pnpm vibecloud add function worker --template datastream-trigger

  auth
    Ready email/password Better Auth service, YDB schema, secret, and web client.
    pnpm vibecloud add auth --database primary

Other resources:
  pnpm vibecloud add database primary --migrations
  pnpm vibecloud add stream primary.events
  pnpm vibecloud add trigger worker --stream primary.events
  pnpm vibecloud add bucket uploads
  pnpm vibecloud add secret WEBHOOK_SIGNING_KEY

Run 'pnpm vibecloud add function --help' or 'pnpm vibecloud add asset --help'
for template options and constraints.
`;

const functionTemplateCatalog = `
Function templates:
  api
    Runnable HTTP JSON handler. Supports Node.js, Python, and Go.

  ai-agent (aliases: ai, agent)
    Better Auth-protected Responses agent with signed continuation. Node.js only.

  ai-turn (alias: turn)
    Better Auth-protected text/audio turn with chunked speech output. Node.js only.
    Input is limited to a 30-second, 1 MB synchronous SpeechKit utterance.

  ai-image (aliases: image, illustrator)
    Public YandexART endpoint. POST starts generation; GET retrieves its result.

  websocket (alias: ws)
    API Gateway WebSocket connect, disconnect, and message-echo handler.

  cron-trigger (alias: cron)
    Timer handler. Requires --cron and fails closed until implemented.

  datastream-trigger (alias: trigger)
    YDB Data Streams batch consumer. Fails closed until implemented.

Notes:
  --route creates the first ANY route, or a WS route for websocket.
  --cron selects cron-trigger automatically when --template is omitted.
  The default runtime is nodejs22; use --runtime for Python or Go templates.
  Add Better Auth before ai-agent or ai-turn. AI templates infer their IAM roles.

Examples:
  pnpm vibecloud add function api --template api --route '/api/*'
  pnpm vibecloud add function agent --template ai-agent --route /api/agent
  pnpm vibecloud add function assistant --template ai-turn --route /api/turn
  pnpm vibecloud add function illustrator --template ai-image --route /api/images
  pnpm vibecloud add function game --template websocket --route /ws
  pnpm vibecloud add function cleanup --cron '0 * ? * * *' --payload compact
  pnpm vibecloud add function worker --template datastream-trigger
`;

const assetTemplateCatalog = `
Asset templates:
  vite
    Gravity UI React/Vite frontend with light, system, and dark themes.
    Vite watches frontend source when the project runs through pnpm dev.

Example:
  pnpm vibecloud add asset website --template vite --route '/*'
`;

const program = new Command()
  .name("vibecloud")
  .description("Deploy declarative serverless applications")
  .showHelpAfterError();

program
  .command("init")
  .description("create or resume an empty project and its YC folder")
  .argument("[directory]", "target directory", ".")
  .option("--folder-id <id>", "deploy into an existing YC folder instead of creating one")
  .option("--no-install", "create the scaffold without installing pnpm dependencies")
  .action(async (directory, options) => {
    const result = await initProject(directory, {
      folderId: options.folderId,
      install: options.install,
    });
    console.log(`initialized: ${result.directory}`);
    console.log(`${result.folderLifecycle === "external" ? "using external" : "managed"} YC folder: ${result.folderId}`);
    console.log(`metadata: ${result.metadataPath}`);
    console.log(`config: ${result.configPath}`);
    for (const path of result.scaffold.created) console.log(`created: ${path}`);
    if (options.install) console.log("installed: pnpm dependencies");
  });

program
  .command("doctor")
  .description("diagnose project identity, cloud folder, Terraform state, and local runtime")
  .argument("[directory]", "project directory", ".")
  .option("--repair", "resume interrupted initialization and repair project metadata")
  .action(async (directory, options) => {
    const result = await doctorProject(directory, { repair: options.repair });
    for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    if (result.repaired) console.log("repair complete");
    if (!result.healthy) process.exitCode = 1;
  });

const add = program
  .command("add")
  .description("add a resource to Terraform inputs")
  .addHelpText("after", addCatalog);

const database = program
  .command("db")
  .description("manage declared YDB databases");

add
  .command("auth")
  .description("add a ready Better Auth service backed by an existing YDB database")
  .requiredOption("--database <name>", "existing YDB database")
  .option("--function <name>", "function resource name", "auth")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (options) => {
    const configPath = resolve(options.config);
    const result = await addAuth(configPath, options.database, options.function);
    await scaffoldSourceResource(configPath, "function", options.function, result);
  });

database
  .command("up")
  .description("apply pending YDB Drizzle migrations")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (options) => {
    const loaded = await loadConfig(resolve(options.config));
    const migrated = await migrateProjectDatabases(loaded);
    if (!migrated.length) console.log("no databases have migrations enabled");
    for (const name of migrated) console.log(`migrated: database ${name}`);
  });

add
  .command("bucket")
  .description("add an object-storage bucket")
  .argument("<name>", "lowercase resource name")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (name, options) => printEdit(await addResource(resolve(options.config), "bucket", name)));

add
  .command("function")
  .description("add a Cloud Function")
  .argument("<name>", "lowercase resource name")
  .option("--template <template>", "source template: api, ai-agent, ai-image, ai-turn, websocket, datastream-trigger, or cron-trigger")
  .option("--cron <expression>", "invoke on a Yandex timer schedule (UTC)")
  .option("--payload <value>", "timer payload; requires --cron")
  .option("--route <pattern>", "also add an ANY HTTP route, or a WS route for websocket templates")
  .option("--handler <handler>", "handler export")
  .option("--runtime <runtime>", "function runtime")
  .option("--build-command <command>", "custom build command; must create dist/functions/<name>")
  .option("--build-cwd <path>", "custom build working directory")
  .option("--memory-mb <number>", "memory limit in MB")
  .option("--timeout-seconds <number>", "invocation timeout")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .addHelpText("after", functionTemplateCatalog)
  .action(async (name, options) => {
    const configPath = resolve(options.config);
    const result = await addFunction(configPath, name, {
      template: resolvedFunctionTemplate(options.template, options.cron),
      cronExpression: options.cron,
      cronPayload: options.payload,
      handler: options.handler,
      runtime: options.runtime,
      buildCommand: options.buildCommand,
      buildCwd: options.buildCwd,
      memoryMb: optionalNumber(options.memoryMb, "memory"),
      timeoutSeconds: optionalNumber(options.timeoutSeconds, "timeout"),
    }, options.route);
    await scaffoldSourceResource(configPath, "function", name, result);
  });

add
  .command("database")
  .description("add a serverless YDB database")
  .argument("<name>", "lowercase resource name")
  .option("--migrations", "enable YDB Drizzle migrations")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (name, options) => {
    const configPath = resolve(options.config);
    const result = await addResource(configPath, "database", name, { migrations: options.migrations });
    await scaffoldSourceResource(configPath, "database", name, result);
  });

add
  .command("stream")
  .description("add a stream beneath an existing database")
  .argument("<database.stream>", "stream reference")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (reference, options) => printEdit(await addStream(resolve(options.config), reference)));

add
  .command("asset")
  .alias("assets")
  .description("add a static-assets bundle")
  .argument("<name>", "lowercase resource name")
  .option("--template <template>", "source template: vite")
  .option("--build-command <command>", "custom command that creates dist/assets/<name>")
  .option("--build-cwd <path>", "build working directory")
  .option("--fallback <key>", "fallback object key")
  .option("--route <pattern>", "also add an ANY route")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .addHelpText("after", assetTemplateCatalog)
  .action(async (name, options) => {
    const configPath = resolve(options.config);
    const result = await addAsset(configPath, name, {
      template: optionalAssetTemplate(options.template),
      buildCommand: options.buildCommand,
      buildCwd: options.buildCwd,
      fallback: options.fallback,
    }, options.route);
    await scaffoldSourceResource(configPath, "asset", name, result);
  });

add
  .command("secret")
  .description("add a generated Lockbox entry")
  .argument("<ENV_NAME>", "uppercase environment variable name")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (name, options) => printEdit(await addSecret(resolve(options.config), name)));

add
  .command("route")
  .description("add an API Gateway route")
  .argument("<method>", "HTTP method, ANY, or WS")
  .argument("<pattern>", "route pattern beginning with /")
  .option("--function <name>", "target function")
  .option("--assets <name>", "target assets bundle")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (method, pattern, options) => printEdit(await addRoute(
    resolve(options.config), method, pattern, { function: options.function, assets: options.assets },
  )));

add
  .command("trigger")
  .description("add a stream trigger to a function")
  .argument("<function>", "consumer function")
  .requiredOption("--stream <database.stream>", "source stream")
  .option("--batch-size-bytes <number>", "maximum batch size")
  .option("--batch-cutoff-seconds <number>", "maximum batch wait")
  .option("--retry-attempts <number>", "retry attempts")
  .option("--retry-interval-seconds <number>", "retry delay")
  .option("--dead-letter-queue <id>", "dead-letter queue ID")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (functionName, options) => printEdit(await addTrigger(resolve(options.config), functionName, {
    stream: options.stream,
    batchSizeBytes: optionalNumber(options.batchSizeBytes, "batch size"),
    batchCutoffSeconds: optionalNumber(options.batchCutoffSeconds, "batch cutoff"),
    retryAttempts: optionalNumber(options.retryAttempts, "retry attempts"),
    retryIntervalSeconds: optionalNumber(options.retryIntervalSeconds, "retry interval"),
    deadLetterQueue: options.deadLetterQueue,
  })));

const remove = program
  .command("remove")
  .alias("rm")
  .description("remove a resource from Terraform inputs");

for (const kind of ["bucket", "function", "database", "asset"] as const) {
  remove
    .command(kind)
    .description(`remove a declared ${kind}`)
    .argument("<name>", "resource name")
    .option("-c, --config <path>", "configuration file", defaultConfig)
    .action(async (name, options) => printEdit(await removeResource(resolve(options.config), kind, name)));
}

remove
  .command("stream")
  .description("remove a database stream")
  .argument("<database.stream>", "stream reference")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (reference, options) => printEdit(await removeStream(resolve(options.config), reference)));

remove
  .command("secret")
  .description("remove a generated Lockbox entry")
  .argument("<ENV_NAME>", "secret entry name")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (name, options) => printEdit(await removeSecret(resolve(options.config), name)));

remove
  .command("route")
  .description("remove an API Gateway route")
  .argument("<method>", "HTTP method, ANY, or WS")
  .argument("<pattern>", "route pattern")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (method, pattern, options) => printEdit(await removeRoute(resolve(options.config), method, pattern)));

remove
  .command("trigger")
  .description("remove a function stream trigger")
  .argument("<function>", "consumer function")
  .requiredOption("--stream <database.stream>", "source stream")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (functionName, options) => printEdit(await removeTrigger(
    resolve(options.config), functionName, options.stream,
  )));

const rename = program
  .command("rename")
  .alias("mv")
  .description("rename a logical resource and update its references");

for (const kind of ["bucket", "function", "database", "asset"] as const) {
  rename
    .command(kind)
    .description(`rename a declared ${kind}`)
    .argument("<old-name>", "current resource name")
    .argument("<new-name>", "new resource name")
    .option("-c, --config <path>", "configuration file", defaultConfig)
    .action(async (oldName, newName, options) => {
      const configPath = resolve(options.config);
      const result = await renameResource(configPath, kind, oldName, newName);
      printEdit(result);
      if (result.action === "renamed") {
        const loaded = await loadConfig(configPath);
        const updated = await synchronizeProjectPackage(loaded);
        if (updated) console.log("updated: package.json");
      }
    });
}

rename
  .command("stream")
  .description("rename a stream within its database")
  .argument("<old-database.stream>", "current stream reference")
  .argument("<new-database.stream>", "new stream reference")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (oldReference, newReference, options) => printEdit(await renameStream(
    resolve(options.config), oldReference, newReference,
  )));

rename
  .command("secret")
  .description("rename a generated Lockbox entry")
  .argument("<OLD_ENV_NAME>", "current secret entry name")
  .argument("<NEW_ENV_NAME>", "new secret entry name")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (oldName, newName, options) => printEdit(await renameSecret(
    resolve(options.config), oldName, newName,
  )));

program
  .command("list")
  .alias("ls")
  .description("list resources declared in Terraform inputs")
  .argument("[kind]", "optional resource kind")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (kind, options) => {
    const loaded = await loadConfig(resolve(options.config));
    const rows = listConfig(loaded.config, kind);
    console.log(rows.length ? rows.join("\n") : "no matching resources");
  });

program
  .command("dev")
  .description("watch the application with Docker Compose or OrbStack")
  .option("-c, --config <path>", "configuration file", defaultConfig)
  .action(async (options) => {
    await devProject(await loadConfig(resolve(options.config)));
  });

program
  .command("push")
  .description("build and deploy the application")
  .argument("[config]", "Terraform variable file", defaultConfig)
  .action(async (config) => {
    const configPath = resolve(config);
    const loaded = await loadConfig(configPath);
    const result = await pushProject(loaded);
    console.log(result.built ? "build complete" : "build skipped: no build command");
    console.log(`terraform: ${result.path}`);
    console.log(`deployed: ${result.url}`);
    console.log(`monitoring: ${result.monitoringDashboardUrl}`);
  });

program
  .command("delete")
  .description("delete the managed YC folder or destroy resources in an adopted folder")
  .argument("[config]", "Terraform variable file", defaultConfig)
  .requiredOption("--confirm <delete:name>", "exact full-project deletion confirmation")
  .action(async (config, options) => {
    const configPath = resolve(config);
    const loaded = await loadConfig(configPath);
    const result = await deleteProject(loaded, {
      confirmation: options.confirm,
    });
    if (result.destroyed) console.log(`destroyed: ${loaded.config.name}`);
    if (result.folderDeletionSubmitted) console.log(`YC folder deletion submitted: ${result.folderId}`);
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printEdit(result: EditResult) {
  console.log(`${result.action}: ${result.description}`);
}

function optionalNumber(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

async function scaffoldSourceResource(
  configPath: string,
  kind: "asset" | "database" | "function",
  name: string,
  result: EditResult,
) {
  printEdit(result);
  const loaded = await loadConfig(configPath);
  const scaffold = await createResourceScaffold(loaded, { kind, name });
  for (const path of scaffold.created) console.log(`created: ${path}`);
  for (const path of scaffold.updated) console.log(`updated: ${path}`);
  if (scaffold.updated.includes("package.json")) console.log("next: pnpm install");
}

function functionTemplate(value: string): "api" | "ai-agent" | "ai-image" | "ai-turn" | "cron-trigger" | "datastream-trigger" | "websocket" {
  if (value === "api") return value;
  if (value === "ai" || value === "agent" || value === "ai-agent") return "ai-agent";
  if (value === "turn" || value === "ai-turn") return "ai-turn";
  if (value === "image" || value === "illustrator" || value === "ai-image") return "ai-image";
  if (value === "cron" || value === "cron-trigger") return "cron-trigger";
  if (value === "ws" || value === "websocket") return "websocket";
  if (value === "trigger" || value === "datastream-trigger") return "datastream-trigger";
  throw new Error(`unknown function template: ${value}`);
}

function resolvedFunctionTemplate(value: string | undefined, cron: string | undefined) {
  if (value === undefined) {
    if (cron !== undefined) return "cron-trigger" as const;
    throw new Error("function requires --template or --cron");
  }
  const template = functionTemplate(value);
  if (cron !== undefined && template !== "cron-trigger") throw new Error("--cron requires the cron-trigger template");
  return template;
}

function optionalAssetTemplate(value: string | undefined): "vite" | undefined {
  if (value === undefined || value === "vite") return value;
  throw new Error(`unknown asset template: ${value}`);
}
