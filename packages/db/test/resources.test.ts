import assert from "node:assert/strict";
import test from "node:test";
import { withResources } from "../dist/resources.js";

test("all resources close after application and pool-disposal failures", async () => {
  const closed: string[] = [];
  const primary = new Error("application");
  const cleanup = new Error("pool disposal");
  await assert.rejects(() => withResources(async (defer) => {
    defer(() => {
      closed.push("driver");
    });
    defer(() => {
      closed.push("pool");
      throw cleanup;
    });
    throw primary;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.equal(error.cause, primary);
    return true;
  });
  assert.deepEqual(closed, ["pool", "driver"]);
});

test("construction failure closes resources already acquired", async () => {
  let closed = false;
  await assert.rejects(() => withResources(async (defer) => {
    defer(() => {
      closed = true;
    });
    throw new Error("pool construction failed");
  }), /pool construction/);
  assert.equal(closed, true);
});
