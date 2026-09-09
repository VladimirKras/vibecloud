import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { deleteProject } from "../src/project-delete.ts";
import { doctorProject } from "../src/project-lifecycle.ts";
import { readProjectMetadata, writeProjectMetadata } from "../src/project-metadata.ts";
import type { OutputReader } from "../src/commands.ts";
import { emptyProject, fixtureDeletionOperation } from "./helpers.ts";

const environment = { YC_TOKEN: "mock", YC_CLOUD_ID: "mock" };

async function project() {
  const loaded = await loadConfig((await emptyProject("tracked-delete-app")).configPath);
  const metadata = loaded.projectMetadata!;
  const operation = fixtureDeletionOperation(metadata.yc_folder_id!);
  const folder = (status = "ACTIVE") => JSON.stringify({ id: metadata.yc_folder_id, status, labels: { vibecloud_project_id: metadata.project_id } });
  const options = { environment, confirmation: "delete:tracked-delete-app" };
  return { loaded, metadata, operation, folder, options };
}

test("deletion saves its operation and repeat calls observe progress without submitting again", async () => {
  const { loaded, operation, folder, options } = await project();
  let submissions = 0;
  let done = false;
  const readCommand: OutputReader = async (_command, args) => {
    if (args.includes("list-operations")) return JSON.stringify(submissions ? [operation] : []);
    if (args.includes("delete")) {
      submissions++;
      return JSON.stringify(operation);
    }
    if (args[0] === "operation") return JSON.stringify({ ...operation, done });
    assert.equal(done, false, "completed operations must not require a deleted folder to exist");
    return folder(submissions ? "DELETING" : "ACTIVE");
  };
  const first = await deleteProject(loaded, { ...options, deleteAfter: "0s", readCommand });
  assert.equal(first.folderDeletionSubmitted, true);
  assert.equal(first.operationId, operation.id);
  assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion?.operation_id, operation.id);
  const repeated = await deleteProject(loaded, { ...options, deleteAfter: "24h", readCommand });
  assert.equal(repeated.folderDeletionSubmitted, false);
  assert.equal(repeated.deletionStatus, "deleting");
  assert.equal(repeated.deleteAfter, "0s");
  done = true;
  const status = await deleteProject(loaded, { environment, statusOnly: true, readCommand });
  assert.equal(status.deletionStatus, "deleted");
  assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion?.status, "deleted");
  assert.equal(submissions, 1);
});

test("an accepted deletion with a lost response is recovered from folder operations", async () => {
  const { loaded, operation, folder, options } = await project();
  let submissions = 0;
  const readCommand: OutputReader = async (_command, args) => {
    if (args.includes("delete")) {
      submissions++;
      operation.created_at = new Date().toISOString();
      assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion?.status, "submitting");
      throw new Error("response connection lost");
    }
    if (args.includes("list-operations")) return JSON.stringify(submissions ? [operation] : []);
    return folder(submissions ? "PENDING_DELETION" : "ACTIVE");
  };
  await assert.rejects(deleteProject(loaded, { ...options, readCommand }), /connection lost/);
  const recovered = await deleteProject(loaded, { ...options, readCommand });
  assert.equal(recovered.operationId, operation.id);
  assert.equal(recovered.deletionStatus, "pending");
  assert.equal(recovered.folderDeletionSubmitted, false);
  assert.equal(submissions, 1);
});

test("unresolved submissions stay durable and cannot trigger a blind second delete", async () => {
  const { loaded, folder, options } = await project();
  let submissions = 0;
  const readCommand: OutputReader = async (_command, args) => {
    if (args.includes("delete")) {
      submissions++;
      throw new Error("request outcome unknown");
    }
    if (args.includes("list-operations")) return "[]";
    return folder();
  };
  await assert.rejects(deleteProject(loaded, { ...options, readCommand }), /outcome unknown/);
  await assert.rejects(deleteProject(loaded, { ...options, readCommand }), /submission is unresolved/);
  assert.equal((await deleteProject(loaded, { environment, statusOnly: true, readCommand })).deletionStatus, "submitting");
  assert.equal(submissions, 1);
});

test("lost responses can be recovered after an immediate deletion has removed the folder", async () => {
  const { loaded, metadata, operation } = await project();
  await writeProjectMetadata(loaded.rootDirectory, {
    ...metadata, deletion: { requested_at: operation.created_at, requested_delay: "0s", status: "submitting" },
  });
  const status = await deleteProject(loaded, {
    environment, statusOnly: true,
    readCommand: async (_command, args) => {
      assert.ok(args.includes("list-operations"), "recovery must not require the deleted folder to exist");
      return JSON.stringify([{ ...operation, done: true }]);
    },
  });
  assert.equal(status.deletionStatus, "deleted");
  assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion?.operation_id, operation.id);
});

test("status adopts an existing pending deletion from an older CLI", async () => {
  const { loaded, operation, folder } = await project();
  const status = await deleteProject(loaded, {
    environment, statusOnly: true,
    readCommand: async (_command, args) => {
      assert.ok(!args.includes("delete"));
      return args.includes("list-operations") ? JSON.stringify([operation]) : folder("PENDING_DELETION");
    },
  });
  assert.equal(status.operationId, operation.id);
  assert.equal(status.deletionStatus, "pending");
});

test("status on an active project never requests deletion or creates a receipt", async () => {
  const { loaded, folder } = await project();
  const status = await deleteProject(loaded, {
    environment, statusOnly: true,
    readCommand: async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ["resource-manager", "folder", "get"]);
      return folder();
    },
  });
  assert.equal(status.deletionStatus, "not-requested");
  assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion, undefined);
  await assert.rejects(deleteProject(loaded, { statusOnly: true, deleteAfter: "0s" }), /cannot be combined/);
});

test("cancelled and failed requests are reported, and a new confirmed delete can retry", async () => {
  for (const code of [1, 13]) {
    const { loaded, metadata, operation, folder, options } = await project();
    await writeProjectMetadata(loaded.rootDirectory, {
      ...metadata, deletion: { requested_at: operation.created_at, operation_id: operation.id, status: "pending" },
    });
    let submissions = 0;
    const readCommand: OutputReader = async (_command, args) => {
      if (args.includes("list-operations")) return JSON.stringify([{ ...operation, done: true, error: { code, message: "old request ended" } }]);
      if (args[0] === "operation") return JSON.stringify({ ...operation, done: true, error: { code, message: "old request ended" } });
      if (args.includes("delete")) {
        submissions++;
        return JSON.stringify(fixtureDeletionOperation(metadata.yc_folder_id!, "new-operation"));
      }
      return folder();
    };
    assert.equal((await deleteProject(loaded, { environment, statusOnly: true, readCommand })).deletionStatus, code === 1 ? "cancelled" : "failed");
    assert.equal(submissions, 0);
    assert.equal((await deleteProject(loaded, { ...options, deleteAfter: "0s", readCommand })).operationId, "new-operation");
    assert.equal(submissions, 1);
  }
});

test("an operation for another folder cannot overwrite the saved deletion identity", async () => {
  const { loaded, metadata, operation } = await project();
  const deletion = { requested_at: operation.created_at, operation_id: operation.id, status: "pending" as const };
  await writeProjectMetadata(loaded.rootDirectory, { ...metadata, deletion });
  await assert.rejects(deleteProject(loaded, {
    environment, statusOnly: true,
    readCommand: async () => JSON.stringify(fixtureDeletionOperation("another-folder")),
  }), /different YC folder/);
  assert.deepEqual((await readProjectMetadata(loaded.rootDirectory))?.deletion, deletion);
});

test("doctor distinguishes completed initialization from a recorded deletion", async () => {
  const { loaded, metadata, operation, folder } = await project();
  await writeProjectMetadata(loaded.rootDirectory, {
    ...metadata, deletion: { requested_at: operation.created_at, operation_id: operation.id, status: "pending" },
  });
  const result = await doctorProject(loaded.rootDirectory, {
    environment,
    readCommand: async (command) => command === "yc" ? folder("PENDING_DELETION") : "available",
  });
  assert.equal(result.healthy, false);
  assert.match(result.checks.find((check) => check.name === "metadata")!.message, /initialization phase ready/);
  assert.match(result.checks.find((check) => check.name === "deletion")!.message, /pending.*delete --status/);
});

test("explicit rejection permits a repaired retry, while disabling hidden CLI retries", async () => {
  const { loaded, folder, operation, options } = await project();
  let submissions = 0;
  const readCommand: OutputReader = async (_command, args) => {
    if (args.includes("list-operations")) return "[]";
    if (args.includes("delete")) {
      assert.deepEqual(args.slice(-2), ["--retry", "0"]);
      submissions++;
      if (submissions === 1) throw new Error("ERROR: rpc error: code = PermissionDenied desc = missing permission");
      return JSON.stringify(operation);
    }
    return folder();
  };
  await assert.rejects(deleteProject(loaded, { ...options, readCommand }), /PermissionDenied/);
  assert.equal((await readProjectMetadata(loaded.rootDirectory))?.deletion?.status, "rejected");
  assert.equal((await deleteProject(loaded, { environment, statusOnly: true, readCommand })).deletionStatus, "rejected");
  assert.equal((await deleteProject(loaded, { ...options, readCommand })).folderDeletionSubmitted, true);
  assert.equal(submissions, 2);
});

test("recovery excludes old cancelled operations and requires an exact choice when ambiguous", async () => {
  const { loaded, operation, folder, options } = await project();
  const old = { ...operation, id: "old-cancelled", created_at: new Date(Date.now() - 30_000).toISOString(), done: true, error: { code: 1 } };
  let submitted = false;
  let ambiguous = false;
  const current = { ...operation, id: "current" };
  const readCommand: OutputReader = async (_command, args) => {
    if (args.includes("delete")) {
      submitted = true;
      current.created_at = new Date().toISOString();
      throw new Error("connection lost");
    }
    if (args.includes("list-operations")) return JSON.stringify([old, ...(submitted && ambiguous ? [current, { ...current, id: "other" }] : [])]);
    if (args[0] === "operation") return JSON.stringify(current);
    return folder();
  };
  await assert.rejects(deleteProject(loaded, { ...options, readCommand }), /connection lost/);
  assert.deepEqual((await readProjectMetadata(loaded.rootDirectory))?.deletion?.previous_operation_ids, [old.id]);
  assert.equal((await deleteProject(loaded, { environment, statusOnly: true, readCommand })).deletionStatus, "submitting");
  await assert.rejects(deleteProject(loaded, { environment, statusOnly: true, operationId: old.id, readCommand }), /predates/);
  ambiguous = true;
  await assert.rejects(deleteProject(loaded, { environment, statusOnly: true, readCommand }), /Multiple YC deletion operations/);
  const status = await deleteProject(loaded, { environment, statusOnly: true, operationId: current.id, readCommand });
  assert.equal(status.operationId, current.id);
  assert.deepEqual((await readProjectMetadata(loaded.rootDirectory))?.deletion?.previous_operation_ids, [old.id]);
});

test("legacy uncertain receipts do not adopt an old operation; exact recovery handles clock skew", async () => {
  const { loaded, metadata, operation, folder } = await project();
  await writeProjectMetadata(loaded.rootDirectory, { ...metadata, deletion: { requested_at: new Date(Date.now() + 30_000).toISOString(), status: "submitting" } });
  const readCommand: OutputReader = async (_command, args) => args.includes("list-operations") ? JSON.stringify([operation]) : args[0] === "operation" ? JSON.stringify(operation) : folder();
  assert.equal((await deleteProject(loaded, { environment, statusOnly: true, readCommand })).deletionStatus, "submitting");
  assert.equal((await deleteProject(loaded, { environment, statusOnly: true, operationId: operation.id, readCommand })).operationId, operation.id);
});

test("an active operation is adopted before submission even while the folder still reports ACTIVE", async () => {
  const { loaded, operation, folder, options } = await project();
  const result = await deleteProject(loaded, { ...options, readCommand: async (_command, args) => {
    assert.ok(!args.includes("delete"));
    return args.includes("list-operations") ? JSON.stringify([operation]) : folder();
  } });
  assert.equal(result.folderDeletionSubmitted, false);
  assert.equal(result.operationId, operation.id);
});
