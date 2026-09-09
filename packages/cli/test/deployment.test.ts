import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCommandOutput } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { deleteProject } from "../src/project-delete.ts";
import { pushProject } from "../src/push.ts";
import { terraformEnvironmentFor } from "../src/terraform-environment.ts";
import { emptyProject, freshProject, fixtureDeletionOperation, activeFolder } from "./helpers.ts";

interface RecordedCommand {
  command: string
  arguments: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  build?: boolean
}

test("push submits one saved Terraform plan with migration inputs", async () => {
  const { configPath } = await freshProject();
  const loaded = await loadConfig(configPath);
  const commands: RecordedCommand[] = [];
  const reads: RecordedCommand[] = [];
  const timeline: string[] = [];
  const result = await pushProject(loaded, {
    environment: {},
    runBuildCommand: async (command, arguments_, environment, cwd) => {
      commands.push({ command, arguments: arguments_, environment, cwd, build: true });
      await fakeBuild(command, arguments_, environment);
    },
    runCommand: async (command, arguments_, environment, cwd) => {
      commands.push({ command, arguments: arguments_, environment, cwd });
      if (command === "terraform" && arguments_.includes("apply")) {
        timeline.push(arguments_.some((argument) => argument.startsWith("-target=")) ? "database-apply" : "application-apply");
      }
    },
    readCommand: async (command, arguments_) => {
      if (arguments_[0] === "resource-manager") return activeFolder(loaded);
      if (arguments_.includes("pull")) return "";
      reads.push({ command, arguments: arguments_ });
      if (command === "yc" && arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
      if (command === "yc" && arguments_.join(" ") === "iam create-token") return "token-one\n";
      if (command === "yc" && arguments_.join(" ") === "iam whoami") return "user-one\n";
      if (command === "yc" && arguments_[1] === "service-account") throw new Error("not a service account");
      if (command === "yc" && arguments_[1] === "user-account") return JSON.stringify({ id: "user-one" });
      if (command === "yc" && arguments_.at(-1) === "cloud-id") return "cloud-one\n";
      if (arguments_[0] === "resource-manager") return activeFolder(loaded);
      if (arguments_.includes("pull")) return "";
      if (arguments_.includes("database_connection_strings")) {
        return JSON.stringify({ primary: "grpcs://database.test/?database=/primary" });
      }
      if (arguments_[0] === "resource-manager") return activeFolder(loaded);
      if (arguments_.includes("pull")) return "";
      if (arguments_.includes("url")) return "https://app.test\n";
      if (arguments_.includes("monitoring_dashboard_url")) return "https://monium.test/dashboard\n";
      throw new Error(`unexpected read: ${command} ${arguments_.join(" ")}`);
    },
  });

  assert.equal(result.url, "https://app.test");
  assert.equal(result.monitoringDashboardUrl, "https://monium.test/dashboard");
  assert.equal(result.directory, loaded.infraDirectory);
  const initialize = commands.find((entry) => entry.command === "terraform" && entry.arguments.includes("init"));
  assert.ok(initialize);
  assert.ok(initialize.arguments.includes("-lockfile=readonly"));
  const applies = commands.filter((entry) => entry.command === "terraform" && entry.arguments.includes("apply"));
  assert.equal(applies.length, 1);
  assert.ok(!applies[0].arguments.some((argument) => argument.startsWith("-target=")));
  assert.deepEqual(timeline, ["application-apply"]);
  const selected = JSON.parse(await readFile(join(result.artifacts, "..", "selected.tfvars.json"), "utf8"));
  assert.equal(selected.cloud_action.project, loaded.rootDirectory);
  assert.ok(selected.cloud_action.interpreter[1].endsWith("/dist/cloud-action.js"));
  assert.equal(selected.publication_record.previous, null);
  assert.deepEqual(reads.filter((entry) => entry.command === "yc").map((entry) => entry.arguments), [
    ["version"],
    ["iam", "create-token"],
    ["config", "get", "cloud-id"],
    ["iam", "whoami"],
    ["iam", "service-account", "get", "--id", "user-one", "--format", "json"],
    ["iam", "user-account", "get", "--id", "user-one", "--format", "json"],
  ]);
  const apply = applies[0];
  assert.equal(apply.environment?.YC_CLOUD_ID, "cloud-one");
  assert.equal(apply.environment?.YC_FOLDER_ID, "fresh-app-folder-id");
  assert.equal(apply.environment?.TF_VAR_deployer_subject, "userAccount:user-one");
});

test("push with no migrations also uses one native apply", async () => {
  const loaded = await emptyLoadedProject("no-migrations-app");
  const applies: string[][] = [];
  await pushProject(loaded, {
    environment: {
      YC_TOKEN: "token-one",
      YC_CLOUD_ID: "cloud-one",
      YC_FOLDER_ID: "folder-one",
      YC_SUBJECT: "serviceAccount:deployer-one",
    },
    runBuildCommand: fakeBuild,
    runCommand: async (command, arguments_) => {
      if (command === "terraform" && arguments_.includes("apply")) applies.push(arguments_);
    },
    readCommand: async (_command, arguments_) => {
      if (arguments_[0] === "resource-manager") return activeFolder(loaded);
      if (arguments_.includes("pull")) return "";
      if (arguments_.includes("url")) return "https://app.test\n";
      if (arguments_.includes("monitoring_dashboard_url")) return "https://monium.test/dashboard\n";
      throw new Error(`unexpected read: ${arguments_.join(" ")}`);
    },
  });
  assert.equal(applies.length, 1);
  assert.ok(!applies[0].some((argument) => argument.startsWith("-target=")));
});

test("push builds migration-only projects before provisioning databases", async () => {
  const { directory, configPath } = await emptyProject("migration-only-app");
  const config = (await loadConfig(configPath)).config;
  config.databases = { primary: { migrations: true } };
  await writeFile(configPath, JSON.stringify(config));
  const folder = join(directory, "src", "databases", "primary", "migrations");
  await mkdir(folder, { recursive: true });
  const migration = "CREATE TABLE example (id Utf8, PRIMARY KEY (id));\n";
  await writeFile(join(folder, "001_initial.sql"), migration);
  const timeline: string[] = [];
  const result = await pushProject(await loadConfig(configPath), {
    environment: { YC_TOKEN: "token", YC_CLOUD_ID: "cloud", YC_SUBJECT: "serviceAccount:deployer" },
    runBuildCommand: async (_command, _arguments, environment, cwd) => {
      await readCommandOutput(process.execPath, ["build.ts"], { ...process.env, ...environment }, cwd);
      timeline.push("build");
    },
    runCommand: async (_command, arguments_) => { timeline.push(arguments_[1]); },
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(await loadConfig(configPath)) : "",

  });
  assert.equal(result.built, true);
  assert.equal(await readFile(join(result.artifacts, "databases/primary/migrations/001_initial.sql"), "utf8"), migration);
  assert.deepEqual(timeline, ["build", "init", "plan", "apply"]);
});

test("a failed Terraform apply retains source upgrades and does not mark the deployment complete", async () => {
  const loaded = await loadConfig((await freshProject()).configPath);
  await assert.rejects(pushProject(loaded, {
    environment: { YC_TOKEN: "token", YC_CLOUD_ID: "cloud", YC_SUBJECT: "serviceAccount:deployer" },
    runBuildCommand: fakeBuild,
    readCommand: async (_command, args) => args[0] === "resource-manager" ? activeFolder(loaded) : "",
    runCommand: async (_command, args) => { if (args.includes("apply")) throw new Error("migration failed"); },
  }), /migration failed.*partial progress/);
  await assert.rejects(readFile(join(loaded.infraDirectory, ".packages/current-deployment.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(loaded.configPath, "utf8")).functions.api.kind, "http");
});

test("deployment authentication explains how to install yc", async () => {
  const loaded = await emptyLoadedProject("missing-yc-app");
  await assert.rejects(
    () => terraformEnvironmentFor(loaded, {}, async () => { throw new Error("spawn yc ENOENT"); }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Yandex Cloud CLI \(yc\) was not found/);
      assert.match(error.message, /yandex\.cloud\/en\/docs\/cli\/quickstart#install/);
      assert.match(error.message, /yc init/);
      return true;
    },
  );
});

test("deployment authentication explains how to log in to yc", async () => {
  const loaded = await emptyLoadedProject("logged-out-app");
  await assert.rejects(
    () => terraformEnvironmentFor(loaded, {}, async (_command, arguments_) => {
      if (arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
      throw new Error("not authenticated");
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not obtain an IAM token/);
      assert.match(error.message, /yc init/);
      return true;
    },
  );
});

test("complete YC environment bypasses yc profile reads", async () => {
  const loaded = await emptyLoadedProject("configured-app");
  const result = await terraformEnvironmentFor(loaded, {
    YC_TOKEN: "token-one",
    YC_CLOUD_ID: "cloud-one",
    YC_FOLDER_ID: "folder-one",
    YC_SUBJECT: "serviceAccount:deployer-one",
  }, async () => {
    throw new Error("yc should not run");
  });
  assert.equal(result.YC_TOKEN, "token-one");
  assert.equal(result.TF_VAR_deployer_subject, "serviceAccount:deployer-one");
});

test("YC_TOKEN resolves the cloud ID and uses the folder recorded by the project", async () => {
  const loaded = await emptyLoadedProject("profile-app");
  const reads: string[][] = [];
  const result = await terraformEnvironmentFor(loaded, {
    YC_TOKEN: "token-one",
    YC_SUBJECT: "userAccount:user-one",
  }, async (_command, arguments_) => {
    reads.push(arguments_);
    if (arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
    if (arguments_.at(-1) === "cloud-id") return "cloud-one\n";
    throw new Error(`unexpected yc call: ${arguments_.join(" ")}`);
  });

  assert.equal(result.YC_TOKEN, "token-one");
  assert.equal(result.YC_CLOUD_ID, "cloud-one");
  assert.equal(result.YC_FOLDER_ID, "profile-app-folder-id");
  assert.deepEqual(reads, [
    ["version"],
    ["config", "get", "cloud-id"],
  ]);
});

test("deployment authentication rejects a profile without a cloud ID", async () => {
  const loaded = await emptyLoadedProject("missing-cloud-app");
  await assert.rejects(
    () => terraformEnvironmentFor(loaded, { YC_TOKEN: "token-one" }, async (_command, arguments_) => {
      if (arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
      if (arguments_.at(-1) === "cloud-id") return "\n";
      throw new Error("unexpected call");
    }),
    /empty cloud ID[\s\S]*yc init[\s\S]*YC_CLOUD_ID/,
  );
});

test("delete requires confirmation and submits managed folder deletion asynchronously", async () => {
  const loaded = await emptyLoadedProject("delete-app");
  await assert.rejects(() => deleteProject(loaded, { confirmation: "wrong" }), /--confirm delete:delete-app/);

  const commands: RecordedCommand[] = [];
  const result = await deleteProject(loaded, {
    confirmation: "delete:delete-app",
    environment: { YC_TOKEN: "token-one", YC_CLOUD_ID: "cloud-one", YC_FOLDER_ID: "folder-one", YC_SUBJECT: "serviceAccount:deployer-one" },
    runCommand: async (command, arguments_) => { commands.push({ command, arguments: arguments_ }); },
    readCommand: async (command, arguments_) => {
      assert.equal(command, "yc");
      if (arguments_.includes("list-operations")) return "[]";
      if (arguments_.includes("delete")) {
        commands.push({ command, arguments: arguments_ });
        return JSON.stringify(fixtureDeletionOperation(loaded.projectMetadata!.yc_folder_id!));
      }
      assert.deepEqual(arguments_, ["resource-manager", "folder", "get", "--id", loaded.projectMetadata!.yc_folder_id, "--format", "json"]);
      return JSON.stringify({
        id: loaded.projectMetadata!.yc_folder_id,
        status: "ACTIVE",
        labels: { vibecloud_project_id: loaded.projectMetadata!.project_id },
      });
    },
  });
  assert.equal(result.destroyed, false);
  assert.equal(result.folderDeletionSubmitted, true);
  assert.equal(result.folderId, "delete-app-folder-id");
  assert.deepEqual(commands, [{
    command: "yc",
    arguments: ["resource-manager", "folder", "delete", "--id", "delete-app-folder-id", "--async", "--format", "json", "--retry", "0"],
  }]);
});

test("delete forwards immediate and delayed deletion requests to YC", async () => {
  for (const deleteAfter of ["0s", "24h", "30m", "22h30m50s"]) {
    const loaded = await emptyLoadedProject("delete-delay-app");
    const commands: RecordedCommand[] = [];
    const result = await deleteProject(loaded, {
      confirmation: "delete:delete-delay-app",
      deleteAfter,
      environment: { YC_TOKEN: "token", YC_CLOUD_ID: "cloud" },
      readCommand: async (command, arguments_) => {
        if (arguments_.includes("list-operations")) return "[]";
        if (arguments_.includes("delete")) {
          commands.push({ command, arguments: arguments_ });
          return JSON.stringify(fixtureDeletionOperation(loaded.projectMetadata!.yc_folder_id!));
        }
        return JSON.stringify({
          id: loaded.projectMetadata!.yc_folder_id,
          status: "ACTIVE",
          labels: { vibecloud_project_id: loaded.projectMetadata!.project_id },
        });
      },
      runCommand: async (command, arguments_) => { commands.push({ command, arguments: arguments_ }); },
    });
    assert.equal(result.deleteAfter, deleteAfter);
    assert.equal(result.folderDeletionSubmitted, true);
    assert.deepEqual(commands, [{
      command: "yc",
      arguments: ["resource-manager", "folder", "delete", "--id", "delete-delay-app-folder-id", "--delete-after", deleteAfter, "--async", "--format", "json", "--retry", "0"],
    }]);
  }
});

test("delete rejects invalid delays before invoking YC", async () => {
  const loaded = await emptyLoadedProject("invalid-delay-app");
  const commands: string[] = [];
  for (const deleteAfter of ["", "-1s", "1d", "0", "now", "1s2h", "1h --async", " 0s"]) {
    await assert.rejects(deleteProject(loaded, {
      confirmation: "delete:invalid-delay-app",
      deleteAfter,
      readCommand: async (command) => {
        commands.push(command);
        return "";
      },
      runCommand: async (command) => { commands.push(command); },
    }), /--delete-after must be a non-negative duration/);
  }
  assert.deepEqual(commands, []);
});

test("immediate deletion still requires the exact project confirmation", async () => {
  const loaded = await emptyLoadedProject("confirm-delay-app");
  const commands: string[] = [];
  await assert.rejects(deleteProject(loaded, {
    confirmation: "wrong",
    deleteAfter: "0s",
    readCommand: async (command) => {
      commands.push(command);
      return "";
    },
    runCommand: async (command) => { commands.push(command); },
  }), /--confirm delete:confirm-delay-app/);
  assert.deepEqual(commands, []);
});

test("immediate deletion rejects missing or conflicting remote ownership before any write", async () => {
  const loaded = await emptyLoadedProject("ownership-app");
  const metadata = loaded.projectMetadata!;
  for (const folder of [
    null,
    [],
    "invalid",
    { id: metadata.yc_folder_id, status: "ACTIVE" },
    { id: metadata.yc_folder_id, status: "ACTIVE", labels: { vibecloud_project_id: "another-project" } },
    { id: "another-folder", status: "ACTIVE", labels: { vibecloud_project_id: metadata.project_id } },
    { id: metadata.yc_folder_id, status: "DELETED", labels: { vibecloud_project_id: metadata.project_id } },
  ]) {
    const writes: string[] = [];
    await assert.rejects(deleteProject(loaded, {
      confirmation: "delete:ownership-app",
      deleteAfter: "0s",
      environment: { YC_TOKEN: "token", YC_CLOUD_ID: "cloud" },
      readCommand: async () => JSON.stringify(folder),
      runCommand: async (command) => { writes.push(command); },
    }), /folder|label/i);
    assert.deepEqual(writes, []);
  }
});

test("managed deletion requires project metadata instead of guessing from Terraform output", async () => {
  const loaded = await emptyLoadedProject("missing-identity-app");
  delete loaded.projectMetadata;
  delete loaded.config.folder_id;
  await unlink(join(loaded.rootDirectory, ".vibecloud", "project.json"));
  await writeFile(loaded.configPath, JSON.stringify(loaded.config));
  const commands: string[] = [];
  await assert.rejects(deleteProject(loaded, {
    confirmation: "delete:missing-identity-app",
    environment: { YC_TOKEN: "token", YC_CLOUD_ID: "cloud" },
    readCommand: async (command) => {
      commands.push(command);
      return "unverified-folder";
    },
    runCommand: async (command) => { commands.push(command); },
  }), /metadata/i);
  assert.deepEqual(commands, []);
});

test("deployment resolves service-account and federated-user subjects from yc", async () => {
  const loaded = await emptyLoadedProject("subject-app");
  for (const [account, expected] of [
    [{ service: true, federated: false }, "serviceAccount:subject-one"],
    [{ service: false, federated: true }, "federatedUser:subject-one"],
  ] as const) {
    const result = await terraformEnvironmentFor(loaded, {}, async (_command, arguments_) => {
      const invocation = arguments_.join(" ");
      if (invocation === "version") return "Yandex Cloud CLI 0.0.0\n";
      if (invocation === "iam create-token") return "token-one\n";
      if (invocation === "config get cloud-id") return "cloud-one\n";
      if (invocation === "iam whoami") return "subject-one\n";
      if (arguments_[1] === "service-account") {
        if (account.service) return JSON.stringify({ id: "subject-one" });
        throw new Error("not a service account");
      }
      if (arguments_[1] === "user-account") {
        return JSON.stringify({ id: "subject-one", ...(account.federated ? { federated_user_account: {} } : {}) });
      }
      throw new Error(`unexpected yc call: ${invocation}`);
    });
    assert.equal(result.TF_VAR_deployer_subject, expected);
  }
});

test("token-only deployment requires a valid explicit YC_SUBJECT", async () => {
  const loaded = await emptyLoadedProject("token-subject-app");
  await assert.rejects(
    () => terraformEnvironmentFor(loaded, {
      YC_TOKEN: "token-one",
      YC_CLOUD_ID: "cloud-one",
    }, async () => { throw new Error("yc unavailable"); }),
    /Could not identify[\s\S]*YC_SUBJECT/,
  );
  await assert.rejects(
    () => terraformEnvironmentFor(loaded, {
      YC_TOKEN: "token-one",
      YC_CLOUD_ID: "cloud-one",
      YC_SUBJECT: "folder:invalid",
    }, async () => { throw new Error("yc should not run"); }),
    /YC_SUBJECT must use/,
  );
});

test("delete destroys resources without deleting an adopted folder", async () => {
  const loaded = await emptyLoadedProject("adopted-delete-app", "adopted-folder-id");
  const commands: RecordedCommand[] = [];
  const result = await deleteProject(loaded, {
    confirmation: "delete:adopted-delete-app",
    environment: { YC_TOKEN: "token-one", YC_CLOUD_ID: "cloud-one", YC_FOLDER_ID: "folder-one", YC_SUBJECT: "serviceAccount:deployer-one" },
    runCommand: async (command, arguments_) => { commands.push({ command, arguments: arguments_ }); },
    readCommand: async () => { throw new Error("token read should not run"); },
  });
  assert.equal(result.destroyed, true);
  assert.equal(result.folderDeletionSubmitted, false);
  assert.equal(result.folderId, "adopted-folder-id");
  assert.deepEqual(commands.map((entry) => entry.command), ["terraform"]);
  assert.ok(commands[0].arguments.includes("destroy"));
});

test("delete rejects a deletion delay for adopted folders before Terraform or YC runs", async () => {
  const loaded = await emptyLoadedProject("adopted-delay-app", "adopted-folder-id");
  const commands: string[] = [];
  await assert.rejects(deleteProject(loaded, {
    confirmation: "delete:adopted-delay-app",
    deleteAfter: "0s",
    readCommand: async (command) => {
      commands.push(command);
      return "";
    },
    runCommand: async (command) => { commands.push(command); },
  }), /--delete-after applies only to managed YC folders/);
  assert.deepEqual(commands, []);
});

async function emptyLoadedProject(name: string, adoptedFolderId?: string) {
  return loadConfig((await emptyProject(name, adoptedFolderId)).configPath);
}

async function fakeBuild(_command: string, _args: string[], environment: NodeJS.ProcessEnv) {
  const selected = JSON.parse(await readFile(environment.VIBECLOUD_CONFIG_PATH!, "utf8"));
  await mkdir(environment.VIBECLOUD_BUILD_OUTPUT!, { recursive: true });
  await writeFile(join(environment.VIBECLOUD_BUILD_OUTPUT!, "deployment-plan.json"), JSON.stringify(selected.deployment_plan));
}
