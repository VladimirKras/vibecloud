import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { deleteProject } from "../src/project-delete.ts";
import { pushProject, terraformEnvironmentFor } from "../src/push.ts";
import { emptyProject, freshProject } from "./helpers.ts";

interface RecordedCommand {
  command: string
  arguments: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  build?: boolean
}

test("push provisions databases, migrates, and only then activates application code", async () => {
  const { configPath } = await freshProject();
  const loaded = await loadConfig(configPath);
  const commands: RecordedCommand[] = [];
  const reads: RecordedCommand[] = [];
  const migrations: [string, string, string, string | undefined][] = [];
  const timeline: string[] = [];
  const result = await pushProject(loaded, {
    retryDelayMs: 0,
    environment: {},
    runBuildCommand: async (command, cwd) => { commands.push({ command, arguments: [], cwd, build: true }); },
    runCommand: async (command, arguments_, environment, cwd) => {
      commands.push({ command, arguments: arguments_, environment, cwd });
      if (command === "terraform" && arguments_.includes("apply")) {
        timeline.push(arguments_.some((argument) => argument.startsWith("-target=")) ? "database-apply" : "application-apply");
      }
    },
    runMigration: async (...arguments_) => {
      migrations.push(arguments_);
      timeline.push("migration");
    },
    readCommand: async (command, arguments_) => {
      reads.push({ command, arguments: arguments_ });
      if (command === "yc" && arguments_[0] === "version") return "Yandex Cloud CLI 0.0.0\n";
      if (command === "yc" && arguments_.join(" ") === "iam create-token") return "token-one\n";
      if (command === "yc" && arguments_.join(" ") === "iam whoami") return "user-one\n";
      if (command === "yc" && arguments_[1] === "service-account") throw new Error("not a service account");
      if (command === "yc" && arguments_[1] === "user-account") return JSON.stringify({ id: "user-one" });
      if (command === "yc" && arguments_.at(-1) === "cloud-id") return "cloud-one\n";
      if (arguments_.includes("database_connection_strings")) {
        return JSON.stringify({ primary: "grpcs://database.test/?database=/primary" });
      }
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
  assert.equal(applies.length, 2);
  assert.ok(applies[0].arguments.includes("-target=yandex_ydb_database_serverless.databases"));
  assert.ok(!applies[1].arguments.some((argument) => argument.startsWith("-target=")));
  assert.deepEqual(timeline, ["database-apply", "migration", "application-apply"]);
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0][0], loaded.rootDirectory);
  assert.equal(migrations[0][1], "grpcs://database.test/?database=/primary");
  assert.match(migrations[0][2], /dist\/databases\/primary\/migrations$/);
  assert.equal(migrations[0][3], "token-one");
  assert.deepEqual(reads.filter((entry) => entry.command === "yc").map((entry) => entry.arguments), [
    ["version"],
    ["iam", "create-token"],
    ["config", "get", "cloud-id"],
    ["iam", "whoami"],
    ["iam", "service-account", "get", "--id", "user-one", "--format", "json"],
    ["iam", "user-account", "get", "--id", "user-one", "--format", "json"],
  ]);
  const apply = applies[1];
  assert.equal(apply.environment?.YC_CLOUD_ID, "cloud-one");
  assert.equal(apply.environment?.YC_FOLDER_ID, "fresh-app-folder-id");
  assert.equal(apply.environment?.TF_VAR_deployer_subject, "userAccount:user-one");
});

test("push skips the database pre-apply when no migrations are enabled", async () => {
  const loaded = await emptyLoadedProject("no-migrations-app");
  const applies: string[][] = [];
  await pushProject(loaded, {
    retryDelayMs: 0,
    environment: {
      YC_TOKEN: "token-one",
      YC_CLOUD_ID: "cloud-one",
      YC_FOLDER_ID: "folder-one",
      YC_SUBJECT: "serviceAccount:deployer-one",
    },
    runBuildCommand: async () => undefined,
    runCommand: async (command, arguments_) => {
      if (command === "terraform" && arguments_.includes("apply")) applies.push(arguments_);
    },
    readCommand: async (_command, arguments_) => {
      if (arguments_.includes("url")) return "https://app.test\n";
      if (arguments_.includes("monitoring_dashboard_url")) return "https://monium.test/dashboard\n";
      throw new Error(`unexpected read: ${arguments_.join(" ")}`);
    },
  });
  assert.equal(applies.length, 1);
  assert.ok(!applies[0].some((argument) => argument.startsWith("-target=")));
});

test("push never activates application code when a migration fails", async () => {
  const loaded = await loadConfig((await freshProject()).configPath);
  const applies: string[][] = [];
  await assert.rejects(() => pushProject(loaded, {
    retryDelayMs: 0,
    environment: {
      YC_TOKEN: "token-one",
      YC_CLOUD_ID: "cloud-one",
      YC_FOLDER_ID: "folder-one",
      YC_SUBJECT: "serviceAccount:deployer-one",
    },
    runBuildCommand: async () => undefined,
    runCommand: async (command, arguments_) => {
      if (command === "terraform" && arguments_.includes("apply")) applies.push(arguments_);
    },
    readCommand: async (_command, arguments_) => {
      if (arguments_.includes("database_connection_strings")) {
        return JSON.stringify({ primary: "grpcs://database.test/?database=/primary" });
      }
      throw new Error(`unexpected read: ${arguments_.join(" ")}`);
    },
    runMigration: async () => { throw new Error("migration failed"); },
  }), /migration failed/);

  assert.equal(applies.length, 1);
  assert.ok(applies[0].includes("-target=yandex_ydb_database_serverless.databases"));
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
    readCommand: async () => { throw new Error("managed folder ID should come from project metadata"); },
  });
  assert.equal(result.destroyed, false);
  assert.equal(result.folderDeletionSubmitted, true);
  assert.equal(result.folderId, "delete-app-folder-id");
  assert.deepEqual(commands, [{
    command: "yc",
    arguments: ["resource-manager", "folder", "delete", "--id", "delete-app-folder-id", "--async"],
  }]);
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

async function emptyLoadedProject(name: string, adoptedFolderId?: string) {
  return loadConfig((await emptyProject(name, adoptedFolderId)).configPath);
}
