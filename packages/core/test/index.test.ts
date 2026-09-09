import assert from "node:assert/strict";
import test from "node:test";
import { errorFrom } from "../dist/index.js";

test("exposes nested cause messages without discarding the original error", () => {
  const ydb = new Error("BAD_REQUEST: column type mismatch");
  const transaction = new Error("Transaction failed.", { cause: ydb });
  const error = errorFrom(transaction);

  assert.equal(error.message, "Transaction failed.\nCaused by: BAD_REQUEST: column type mismatch");
  assert.equal(error.cause, transaction);
});

test("preserves errors without causes and normalizes other thrown values", () => {
  const error = new Error("application failure");
  assert.equal(errorFrom(error), error);
  assert.equal(errorFrom("string failure").message, "string failure");
});

test("does not loop on cyclic cause chains", () => {
  const error = new Error("cyclic");
  error.cause = error;
  const normalized = errorFrom(error);
  assert.equal(normalized.message, "cyclic");
  assert.equal(normalized.cause, error);
});
