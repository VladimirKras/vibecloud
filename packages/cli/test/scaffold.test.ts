import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build as buildWithEsbuild } from "esbuild";
import { buildProject } from "../src/build.ts";
import { listConfig } from "../src/config-edit.ts";
import { loadConfig, validateConfig } from "../src/config.ts";
import { initProject } from "../src/init.ts";
import { doctorProject } from "../src/project-lifecycle.ts";
import { createResourceScaffold } from "../src/scaffold.ts";
import {
  cliPackage,
  cliRoot,
  emptyProject,
  freshProject,
  offlineInitOptions,
  readJson,
  runCli,
} from "./helpers.ts";

test("bundled Terraform input example matches the current schema", async () => {
  const source = await readFile(
    join(cliRoot, "skills", "vibecloud", "references", "vibecloud.example.tfvars.json"),
    "utf8",
  );
  assert.equal(validateConfig(JSON.parse(source)).name, "full-stack-app");
});

test("init creates an empty pnpm and Terraform project", async () => {
  const { directory, configPath } = await emptyProject();
  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded.config, {
    name: "empty-app",
    folder_id: "empty-app-folder-id",
    gateway: { routes: [] },
  });
  assert.equal(loaded.projectMetadata?.yc_folder_lifecycle, "managed");
  assert.deepEqual(listConfig(loaded.config), []);

  for (const path of [
    "infra/main.tf",
    "infra/monitoring.tf",
    "infra/variables.tf",
    "infra/outputs.tf",
    "infra/moves.auto.tf",
    "infra/terraform.rc",
    "infra/.terraform.lock.hcl",
    ".vibecloud/project.json",
    "AGENTS.md",
    ".agents/skills/vibecloud/SKILL.md",
    ".agents/skills/gravity-ui/SKILL.md",
    ".agents/skills/gravity-ui/scripts/icon-image-search.sh",
    "build.ts",
    "eslint.config.ts",
    "vite.config.ts",
    "infra/local.compose.yaml",
    "infra/local.orbstack.compose.yaml",
    "infra/local.Dockerfile",
    "package.json",
    "pnpm-workspace.yaml",
  ]) await stat(join(directory, path));
  await assert.rejects(() => stat(join(directory, "src")), /ENOENT/);
  await typecheckProject(directory);
  const build = spawnSync(process.execPath, ["build.ts"], { cwd: directory, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

test("init installs dependencies before committing the ready phase", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "installed-app");
  const commands: { command: string, arguments_?: string[], environment?: NodeJS.ProcessEnv, cwd?: string }[] = [];
  const result = await initProject(directory, {
    ...offlineInitOptions("installed-folder-id"),
    install: true,
    runCommand: async (command, arguments_, environment, cwd) => {
      commands.push({ command, arguments_, environment, cwd });
      assert.equal((await readJson(join(directory, ".vibecloud", "project.json"))).phase, "folder_created");
      await stat(join(directory, "package.json"));
    },
  });

  assert.deepEqual(commands.map(({ command, arguments_, cwd }) => ({ command, arguments_, cwd })), [{
    command: "pnpm",
    arguments_: ["install"],
    cwd: directory,
  }]);
  assert.equal((await readJson(result.metadataPath)).phase, "ready");
});

test("init retries dependency installation without creating another YC folder", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "retry-install-app");
  await assert.rejects(() => initProject(directory, {
    ...offlineInitOptions("retry-install-folder-id"),
    install: true,
    runCommand: async () => { throw new Error("simulated install failure"); },
  }), /simulated install failure/);
  assert.equal((await readJson(join(directory, ".vibecloud", "project.json"))).phase, "folder_created");

  let installs = 0;
  const result = await initProject(directory, {
    install: true,
    readCommand: async () => { throw new Error("resume must not call YC"); },
    runCommand: async () => { installs += 1; },
  });
  assert.equal(installs, 1);
  assert.equal((await readJson(result.metadataPath)).phase, "ready");
});

test("doctor treats a created YC folder without Terraform state as local-AI ready", async () => {
  const { directory } = await emptyProject("local-ai-ready");
  const metadata = await readJson(join(directory, ".vibecloud", "project.json"));
  const result = await doctorProject(directory, {
    environment: { YC_TOKEN: "test-token", YC_CLOUD_ID: "test-cloud-id" },
    readCommand: async (command, arguments_) => {
      if (command === "yc" && arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
      if (command === "yc" && arguments_.includes("get")) {
        return JSON.stringify({
          id: metadata.yc_folder_id,
          status: "ACTIVE",
          labels: { vibecloud_project_id: metadata.project_id },
        });
      }
      if (command === "docker" && arguments_[0] === "info") return '"26.0.0"\n';
      if (command === "docker" && arguments_[0] === "compose") return "5.1.2\n";
      throw new Error(`unexpected doctor command: ${command} ${arguments_.join(" ")}`);
    },
  });

  assert.deepEqual(result.checks.find((check) => check.name === "terraform-state"), {
    name: "terraform-state",
    status: "ok",
    message: "application is not deployed yet; the YC folder is ready for local AI",
  });
});

test("bundled Terraform lock matches pinned providers and common host platforms", async () => {
  const [main, lock] = await Promise.all([
    readFile(join(cliRoot, "templates", "project", "infra", "main.tf"), "utf8"),
    readFile(join(cliRoot, "templates", "project", "infra", ".terraform.lock.hcl"), "utf8"),
  ]);
  for (const [source, version] of [
    ["hashicorp/archive", "2.7.1"],
    ["yandex-cloud/yandex", "0.218.0"],
  ]) {
    assert.match(main, new RegExp(`source\\s+=\\s+"${source.replace("/", "\\/")}"[\\s\\S]*?version\\s+=\\s+"${version.replaceAll(".", "\\.")}"`));
    const block = new RegExp(`provider "registry\\.terraform\\.io/${source.replace("/", "\\/")}" \\{([\\s\\S]*?)\\n\\}`).exec(lock)?.[1];
    assert.ok(block, `missing ${source} lock entry`);
    assert.match(block, new RegExp(`version\\s+=\\s+"${version.replaceAll(".", "\\.")}"`));
    assert.equal(block.match(/"h1:/g)?.length, 5);
  }
});

test("init creates the managed YC folder and returns its ID", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "managed-folder-app");
  const commands: { command: string, arguments_?: string[], environment?: NodeJS.ProcessEnv, cwd?: string }[] = [];
  const environment = {
    YC_TOKEN: "token-one",
    YC_CLOUD_ID: "cloud-one",
    YC_FOLDER_ID: "profile-folder",
  };
  const result = await initProject(directory, {
    install: false,
    environment,
    readCommand: async (command, arguments_, commandEnvironment) => {
      commands.push({ command, arguments_, environment: commandEnvironment });
      assert.equal(command, "yc");
      if (arguments_.includes("list")) return "[]";
      if (arguments_.includes("create")) return `${JSON.stringify({ id: "managed-folder-id", status: "ACTIVE" })}\n`;
      throw new Error(`unexpected command: ${arguments_.join(" ")}`);
    },
  });

  assert.equal(result.folderId, "managed-folder-id");
  assert.equal(result.folderLifecycle, "managed");
  assert.deepEqual(commands.map(({ command, arguments_ }) => [command, arguments_]), [
    ["yc", ["resource-manager", "folder", "list", "--cloud-id", "cloud-one", "--format", "json"]],
    ["yc", [
      "resource-manager", "folder", "create",
      "--name", "managed-folder-app",
      "--description", "Project managed by Vibecloud for managed-folder-app",
      "--labels", commands[1].arguments_?.[(commands[1].arguments_?.indexOf("--labels") ?? -1) + 1],
      "--cloud-id", "cloud-one",
      "--format", "json",
    ]],
  ]);
  assert.equal(commands[0].environment?.YC_TOKEN, "token-one");
  assert.equal((await readJson(result.configPath)).folder_id, "managed-folder-id");
  const metadata = await readJson(result.metadataPath);
  assert.equal(metadata.schema_version, 2);
  assert.equal(metadata.scaffold_version, 2);
  assert.equal(metadata.phase, "ready");
  assert.match(metadata.project_id, /^[0-9a-f-]{36}$/);
  assert.equal(metadata.yc_folder_id, "managed-folder-id");
  assert.equal(metadata.yc_folder_lifecycle, "managed");
  assert.equal(
    commands[1].arguments_?.[(commands[1].arguments_?.indexOf("--labels") ?? -1) + 1],
    `vibecloud_project_id=${metadata.project_id}`,
  );

  const repeated = await initProject(directory, {
    install: false,
    readCommand: async () => { throw new Error("completed init should not call YC"); },
  });
  assert.equal(repeated.folderId, "managed-folder-id");
});

test("init adopts an explicit YC folder without provisioning another", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "adopted-folder-app");
  const result = await initProject(directory, {
    install: false,
    folderId: "adopted-folder-id",
    environment: { YC_TOKEN: "token-one", YC_CLOUD_ID: "cloud-one", YC_FOLDER_ID: "profile-folder" },
    readCommand: async (command, arguments_) => {
      assert.equal(command, "yc");
      assert.deepEqual(arguments_, [
        "resource-manager", "folder", "get", "--id", "adopted-folder-id", "--format", "json",
      ]);
      return `${JSON.stringify({ id: "adopted-folder-id", status: "ACTIVE" })}\n`;
    },
  });

  assert.equal(result.folderId, "adopted-folder-id");
  assert.equal(result.folderLifecycle, "external");
  assert.equal((await readJson(result.configPath)).folder_id, "adopted-folder-id");
  assert.equal((await readJson(result.metadataPath)).yc_folder_lifecycle, "external");
});

test("init recovers a managed folder by project label after interruption", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "recovered-folder-app");
  const environment = { YC_TOKEN: "token-one", YC_CLOUD_ID: "cloud-one", YC_FOLDER_ID: "profile-folder" };
  await assert.rejects(() => initProject(directory, {
    install: false,
    environment,
    readCommand: async (_command, arguments_) => {
      if (arguments_.includes("list")) return "[]";
      throw new Error("simulated interruption after YC folder creation");
    },
  }), /simulated interruption/);
  const pendingMetadata = await readJson(join(directory, ".vibecloud", "project.json"));
  assert.equal(pendingMetadata.yc_folder_id, null);

  const result = await initProject(directory, {
    install: false,
    environment,
    readCommand: async (_command, arguments_) => {
      if (!arguments_.includes("list")) throw new Error("recovery should not create another folder");
      return `${JSON.stringify([{
        id: "recovered-folder-id",
        status: "ACTIVE",
        labels: { vibecloud_project_id: pendingMetadata.project_id },
      }])}\n`;
    },
  });
  assert.equal(result.folderId, "recovered-folder-id");
  assert.equal((await readJson(result.configPath)).folder_id, "recovered-folder-id");
});

test("init resumes after every committed lifecycle phase", async () => {
  for (const interruptedPhase of ["scaffolded", "folder_created", "ready"]) {
    const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
    const directory = join(parent, `resume-${interruptedPhase.replaceAll("_", "-")}`);
    const environment = { YC_TOKEN: "token-one", YC_CLOUD_ID: "cloud-one" };
    await assert.rejects(() => initProject(directory, {
      install: false,
      environment,
      readCommand: async (_command, arguments_) => {
        if (arguments_.includes("list")) return "[]";
        if (arguments_.includes("create")) return JSON.stringify({ id: `${interruptedPhase}-folder`, status: "ACTIVE" });
        throw new Error(`unexpected command: ${arguments_.join(" ")}`);
      },
      afterPhase: async (phase) => {
        if (phase === interruptedPhase) throw new Error(`interrupt after ${phase}`);
      },
    }), new RegExp(`interrupt after ${interruptedPhase}`));

    const metadata = await readJson(join(directory, ".vibecloud", "project.json"));
    assert.equal(metadata.phase, interruptedPhase);
    const resumed = await initProject(directory, {
      install: false,
      environment,
      readCommand: async (_command, arguments_) => {
        if (interruptedPhase !== "scaffolded") throw new Error("completed folder phase must not call YC");
        if (arguments_.includes("list")) return "[]";
        if (arguments_.includes("create")) return JSON.stringify({ id: `${interruptedPhase}-folder`, status: "ACTIVE" });
        throw new Error(`unexpected command: ${arguments_.join(" ")}`);
      },
    });
    assert.equal((await readJson(resumed.metadataPath)).phase, "ready");
    assert.equal((await readJson(resumed.configPath)).folder_id, `${interruptedPhase}-folder`);
  }
});

test("init preserves gitignore entries and adds Terraform state rules", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vibecloud-test-"));
  const directory = join(parent, "ignore-app");
  await mkdir(directory);
  await writeFile(join(directory, ".gitignore"), "custom-output\n");
  await initProject(directory, offlineInitOptions());

  const gitignore = await readFile(join(directory, ".gitignore"), "utf8");
  assert.match(gitignore, /^custom-output$/m);
  assert.match(gitignore, /^infra\/\.terraform\/$/m);
  assert.match(gitignore, /^\*\.tfstate\.\*$/m);
});

test("loaded projects reject folder IDs that diverge from committed metadata", async () => {
  const { configPath } = await emptyProject("metadata-mismatch-app");
  const declaration = await readJson(configPath);
  declaration.folder_id = "different-folder-id";
  await writeFile(configPath, `${JSON.stringify(declaration, null, 2)}\n`);
  await assert.rejects(() => loadConfig(configPath), /folder_id does not match \.vibecloud\/project\.json/);
});

test("resource scaffolds materialize the current source and package contract", async () => {
  const { directory, configPath } = await freshProject();
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.rootDirectory, directory);
  assert.equal(loaded.infraDirectory, join(directory, "infra"));
  assert.equal(loaded.config.name, "fresh-app");

  for (const path of [
    "src/assets/website/App.tsx",
    "src/assets/website/vite-env.d.ts",
    "src/assets/website/hooks/useTheme.ts",
    "src/assets/website/themes/common.css",
    "src/functions/api/index.ts",
    "src/databases/primary/migrations",
    ".agents/skills/vibecloud/agents/openai.yaml",
    ".agents/skills/vibecloud/references/vibecloud.example.tfvars.json",
  ]) await stat(join(directory, path));

  const manifest = await cliPackage();
  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.packageManager, "pnpm@11.15.1");
  assert.equal(packageJson.engines.node, ">=26.0.0");
  assert.equal(packageJson.devDependencies["@vibecloud/cli"], manifest.version);
  assert.equal(packageJson.devDependencies["@vibecloud/function-api"], manifest.version);
  assert.equal(packageJson.dependencies["@vibecloud/db"], manifest.version);
  assert.equal(packageJson.dependencies["@ydbjs/drizzle-adapter"], "^0.1.1");
  assert.equal(packageJson.dependencies["drizzle-orm"], "^0.45.2");
  assert.deepEqual(packageJson.scripts, {
    "vibecloud": "vibecloud",
    "dev": "vibecloud dev",
    "build": "pnpm typecheck && node build.ts",
    "lint": "eslint --flag unstable_native_nodejs_ts_config .",
    "lint:fix": "eslint --flag unstable_native_nodejs_ts_config . --fix",
    "typecheck": "tsc --noEmit",
    "push": "vibecloud push",
    "delete": "vibecloud delete",
  });

  assert.deepEqual(
    new Set(listConfig(loaded.config).map((row) => row.split("\t", 1)[0])),
    new Set(["asset", "bucket", "database", "stream", "function", "route", "secret"]),
  );
  assert.match(
    await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"),
    /allowBuilds:\n {2}esbuild: true\n {2}protobufjs: true[\s\S]*verifyDepsBeforeRun: false/,
  );
  assert.match(
    await readFile(join(directory, ".agents", "skills", "vibecloud", "SKILL.md"), "utf8"),
    /checked-in Terraform/,
  );
  assert.match(
    await readFile(join(directory, "infra", "monitoring.tf"), "utf8"),
    /resource "yandex_monitoring_dashboard" "serverless_red"/,
  );
  assert.match(
    await readFile(join(directory, "infra", "monitoring.tf"), "utf8"),
    /text\s+= "Cloud Functions"/,
  );
  const localCompose = await readFile(join(directory, "infra", "local.compose.yaml"), "utf8");
  assert.match(localCompose, /image: ydbplatform\/local-ydb:latest/);
  assert.match(localCompose, /dockerfile: local\.Dockerfile/);
  assert.match(localCompose, /dev\.orbstack\.domains/);
  assert.match(localCompose, /YANDEX_CLOUD_API_KEY/);
  assert.match(localCompose, /YANDEX_CLOUD_FOLDER_ID/);
  assert.match(localCompose, /YANDEX_CLOUD_IAM_TOKEN/);
  assert.match(localCompose, /PNPM_CONFIG_REGISTRY/);
  assert.match(localCompose, /NPM_CONFIG_REGISTRY/);
  assert.match(localCompose, /action: restart/);
  assert.match(localCompose, /action: rebuild/);
  assert.match(localCompose, /"2136:2136"/);
  assert.match(localCompose, /"5173-5199:5173-5199"/);
  assert.match(localCompose, /"8787:8787"/);
  assert.match(
    await readFile(join(directory, "infra", "local.orbstack.compose.yaml"), "utf8"),
    /ports: !reset \[\]/,
  );
  const assetMain = await readFile(join(directory, "src", "assets", "website", "main.tsx"), "utf8");
  assert.match(assetMain, /getRootClassName/);
  assert.ok(assetMain.indexOf("applyDocumentTheme(initialTheme.resolved)") < assetMain.indexOf("createRoot(root).render"));
  const themeHook = await readFile(
    join(directory, "src", "assets", "website", "hooks", "useTheme.ts"),
    "utf8",
  );
  assert.match(themeHook, /useLayoutEffect/);
  assert.match(themeHook, /getInitialTheme/);
  const terraformVariables = await readFile(join(directory, "infra", "variables.tf"), "utf8");
  assert.match(terraformVariables, /variable "ai"/);
  assert.match(terraformVariables, /speechkit_stt/);
});

test("trigger templates expose their inputs and fail closed", async () => {
  for (const file of ["function-cron-trigger.ts", "function-stream-trigger.ts"]) {
    const source = await readFile(join(cliRoot, "templates", "project", file), "utf8");
    assert.match(source, /event:/, file);
    assert.match(source, /context:/, file);
    assert.match(source, /throw new Error/, file);
  }
});

test("resource scaffolding updates pnpm package metadata", async () => {
  const { directory, configPath } = await freshProject();
  const legacyPackage = await readJson(join(directory, "package.json"));
  legacyPackage.scripts["dev:website"] = "vite --config vite.config.ts --host 127.0.0.1 src/assets/website";
  legacyPackage.scripts["dev:custom"] = "storybook dev";
  await writeFile(join(directory, "package.json"), `${JSON.stringify(legacyPackage, null, 2)}\n`);

  const assetResult = runCli(["add", "asset", "admin", "--template", "vite"], directory);
  assert.equal(assetResult.status, 0, assetResult.stderr);
  assert.match(assetResult.stdout, /next: pnpm install/);

  const functionResult = runCli([
    "add", "function", "worker", "--template", "datastream-trigger",
  ], directory);
  assert.equal(functionResult.status, 0, functionResult.stderr);

  const packageJson = await readJson(join(directory, "package.json"));
  assert.equal(packageJson.scripts["dev:admin"], undefined);
  assert.equal(packageJson.scripts["dev:website"], undefined);
  assert.equal(packageJson.scripts["dev:custom"], "storybook dev");
  assert.equal(
    packageJson.devDependencies["@vibecloud/function-trigger-datastream"],
    (await cliPackage()).version,
  );
  assert.match(
    await readFile(join(directory, "src", "functions", "worker", "index.ts"), "utf8"),
    /from "@vibecloud\/function-trigger-datastream"/,
  );
  assert.equal((await loadConfig(configPath)).config.assets?.admin.build.command, "pnpm build");
});

test("Better Auth migration follows existing database migrations", async () => {
  const { directory } = await emptyProject("auth-migration-app");
  assert.equal(runCli(["add", "database", "primary", "--migrations"], directory).status, 0);
  await writeFile(
    join(directory, "src", "databases", "primary", "migrations", "001_todos.sql"),
    "CREATE TABLE todos (id Utf8 NOT NULL, PRIMARY KEY (id));\n",
  );
  const result = runCli(["add", "auth", "--database", "primary"], directory);
  assert.equal(result.status, 0, result.stderr);
  await stat(join(directory, "src", "databases", "primary", "migrations", "002_better_auth.sql"));
});

test("build orchestration invokes the configured project build once", async () => {
  const { configPath } = await freshProject();
  const loaded = await loadConfig(configPath);
  const commands: { command: string, arguments_?: string[], environment?: NodeJS.ProcessEnv, cwd?: string }[] = [];
  assert.equal(await buildProject(loaded, {
    runCommand: async (command, cwd) => { commands.push({ command, cwd }); },
  }), true);
  assert.deepEqual(commands, [{ command: "pnpm build", cwd: loaded.rootDirectory }]);
});

test("generated production builds load the project Vite configuration", async () => {
  const source = await readFile(join(cliRoot, "templates", "project", "build.ts"), "utf8");
  assert.match(source, /loadConfigFromFile/);
  assert.match(source, /vite\.config\.ts/);
  assert.match(source, /mergeConfig\(loadedViteConfig\.config/);
  assert.doesNotMatch(source, /plugins: \[react\(\)\]/);
});

test("generated WebSocket handler completes connect, message, and disconnect lifecycle", async () => {
  const { directory, configPath } = await emptyProject("websocket-lifecycle-app");
  const declaration = await readJson(configPath);
  declaration.functions = { socket: { template: "websocket", handler: "index.handler" } };
  declaration.gateway.routes = [{ pattern: "/ws", method: "WS", function: "socket" }];
  await writeFile(configPath, `${JSON.stringify(declaration, null, 2)}\n`);
  await createResourceScaffold(await loadConfig(configPath), { kind: "function", name: "socket" });

  const output = join(directory, "handler.mjs");
  await buildWithEsbuild({
    entryPoints: [join(directory, "src", "functions", "socket", "index.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { handler } = await import(`${pathToFileURL(output)}?test=${Date.now()}`);
  const context = { requestId: "function-request" };
  const event = (eventType: "CONNECT" | "MESSAGE" | "DISCONNECT", body = "") => ({
    version: "1.0",
    resource: "/ws",
    path: "/ws",
    httpMethod: "GET",
    body,
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    isBase64Encoded: false,
    requestContext: {
      identity: { sourceIp: "127.0.0.1", userAgent: "vibecloud-test" },
      httpMethod: "GET",
      requestId: `gateway-${eventType.toLowerCase()}`,
      requestTime: "31/Aug/2026:12:00:00 +0000",
      requestTimeEpoch: 1_788_177_600_000,
      connectionId: "connection-one",
      eventType,
      messageId: eventType === "MESSAGE" ? "message-one" : undefined,
    },
  });

  assert.deepEqual(await handler(event("CONNECT"), context), { statusCode: 200, body: "" });
  assert.deepEqual(JSON.parse((await handler(event("MESSAGE", "hello"), context)).body), {
    ok: true,
    connectionId: "connection-one",
    messageId: "message-one",
    requestId: "function-request",
    body: "hello",
  });
  assert.deepEqual(await handler(event("DISCONNECT"), context), { statusCode: 200, body: "" });
});

test("Python and Go functions scaffold and build into artifact directories", async () => {
  const { directory, configPath } = await emptyProject("polyglot-app");
  const initialized = await readJson(configPath);
  await writeFile(configPath, `${JSON.stringify({
    ...initialized,
    name: "polyglot-app",
    gateway: { routes: [] },
    functions: {
      analyzer: {
        template: "api",
        handler: "index.handler",
        runtime: "python312",
      },
      ingester: {
        template: "datastream-trigger",
        handler: "index.Consume",
        runtime: "golang123",
      },
    },
  }, null, 2)}\n`);

  for (const name of ["analyzer", "ingester"]) {
    await createResourceScaffold(await loadConfig(configPath), { kind: "function", name });
  }

  await stat(join(directory, "src", "functions", "analyzer", "index.py"));
  await stat(join(directory, "src", "functions", "analyzer", "requirements.txt"));
  const goDirectory = join(directory, "src", "functions", "ingester");
  const goSource = join(goDirectory, "index.go");
  await stat(goSource);
  assert.match(
    await readFile(join(goDirectory, "go.mod"), "utf8"),
    /^module vibecloud\.local\/polyglot-app\/functions\/ingester$/m,
  );

  const goFormat = spawnSync("gofmt", ["-d", goSource], { encoding: "utf8" });
  assert.equal(goFormat.status, 0, goFormat.stderr);
  assert.equal(goFormat.stdout, "");
  const goTest = spawnSync("go", ["test", "-mod=readonly", "./..."], {
    cwd: goDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      GOCACHE: join(tmpdir(), "vibecloud-go-build-cache"),
      GOMODCACHE: join(tmpdir(), "vibecloud-go-module-cache"),
    },
  });
  assert.equal(goTest.status, 0, goTest.stdout + goTest.stderr);

  await typecheckProject(directory);
  const build = spawnSync(process.execPath, ["build.ts"], { cwd: directory, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  await stat(join(directory, "dist", "functions", "analyzer", "index.py"));
  await stat(join(directory, "dist", "functions", "ingester", "index.go"));
  assert.equal((await readJson(join(directory, "package.json"))).scripts.build, "pnpm typecheck && node build.ts");
});

async function typecheckProject(directory: string) {
  // Use the CLI's installed build dependencies; these projects have no Vite
  // dependency or TypeScript application source.
  for (const [dependency, owner] of [
    ...["@types/node", "esbuild", "typescript"].map((name) => [name, cliRoot]),
    ...["@eslint/js", "@stylistic/eslint-plugin", "eslint", "globals", "typescript-eslint"]
      .map((name) => [name, join(cliRoot, "..", "..")]),
  ]) {
    const target = join(directory, "node_modules", dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(owner, "node_modules", dependency), target, "dir");
  }
  const result = spawnSync(process.execPath, [
    join(cliRoot, "node_modules", "typescript", "bin", "tsc"),
    "--project", join(directory, "tsconfig.json"),
  ], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
