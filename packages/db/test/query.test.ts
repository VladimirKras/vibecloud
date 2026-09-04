import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { QueryClient } from "@ydbjs/query";
import type { YdbQueryObservation } from "../dist/index.js";
import test from "node:test";
import {
  describeYdbQuery,
  instrumentYdbClient,
  ydbQueryObservationAttributes,
} from "../dist/index.js";

test("observes named YDB retries, metadata, result rows, and server cost", () => {
  const observations: YdbQueryObservation[] = [];
  const statement = fakeStatement({
    totalDurationUs: 2_500n,
    totalCpuTimeUs: 1_250n,
    compilation: { durationUs: 300n, fromCache: true },
    queryPhases: [{
      affectedShards: 2n,
      tableAccess: [{ reads: { rows: 4n, bytes: 128n }, partitionsCount: 3n }],
    }],
  });
  const client = instrumentYdbClient((() => statement) as unknown as QueryClient, (observation) => observations.push(observation));
  describeYdbQuery(client("SELECT 1"), "todo.find", { "db.collection.name": "todos" });

  statement.emit("retry");
  statement.emit("metadata", new Map([
    ["x-ydb-consumed-units", "1,3"],
    ["x-request-id", "request-1"],
  ]));
  statement.emit("done", [[{ id: 1 }, { id: 2 }]]);

  assert.equal(observations.length, 1);
  assert.deepEqual({ ...observations[0], durationMs: 0 }, {
    name: "todo.find",
    attributes: { "db.collection.name": "todos" },
    durationMs: 0,
    retries: 1,
    success: true,
    returnedRows: 2,
    consumedUnits: 3,
    requestId: "request-1",
    databaseDurationMs: 2.5,
    databaseCpuMs: 1.25,
    compilationMs: 0.3,
    compilationFromCache: true,
    affectedShards: 2,
    readRows: 4,
    readBytes: 128,
    partitions: 3,
  });
  assert.deepEqual(ydbQueryObservationAttributes(observations[0]), {
    "db.collection.name": "todos",
    "event.name": "ydb.client.query",
    "db.system.name": "ydb",
    "db.query.summary": "todo.find",
    "ydb.client.duration_ms": Number(observations[0].durationMs.toFixed(1)),
    "ydb.retry.count": 1,
    "db.response.returned_rows": 2,
    "ydb.consumed_units": 3,
    "ydb.request.id": "request-1",
    "ydb.server.duration_ms": 2.5,
    "ydb.server.cpu_time_ms": 1.3,
    "ydb.query.compilation.duration_ms": 0.3,
    "ydb.query.compilation.cache_hit": true,
    "ydb.affected_shards": 2,
    "ydb.read.rows": 4,
    "ydb.read.bytes": 128,
    "ydb.partitions": 3,
  });
});

test("records an unnamed failed query once", () => {
  const observations: YdbQueryObservation[] = [];
  const statement = fakeStatement(undefined);
  const client = instrumentYdbClient((() => statement) as unknown as QueryClient, (observation) => observations.push(observation));
  client("SELECT broken");
  statement.emit("error", new Error("broken"));
  statement.emit("done", [[]]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].name, "missing");
  assert.equal(observations[0].success, false);
  assert.equal(ydbQueryObservationAttributes(observations[0])["error.type"], "ydb.query.error");
});

function fakeStatement(stats: unknown) {
  return Object.assign(new EventEmitter(), {
    statsMode: "",
    withStats(mode: string) {
      this.statsMode = mode;
      return this;
    },
    stats: () => stats,
  });
}
