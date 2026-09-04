import { StatsMode } from "@ydbjs/api/query";
import type { Query, QueryClient, SQL, TX } from "@ydbjs/query";
import { createStructuredLogger, traceOperation } from "@vibecloud/telemetry";

export interface YdbQueryObservation {
  name: string
  attributes: Record<string, string | number | boolean>
  durationMs: number
  retries: number
  success: boolean
  returnedRows?: number
  consumedUnits?: number
  requestId?: string
  databaseDurationMs?: number
  databaseCpuMs?: number
  compilationMs?: number
  compilationFromCache?: boolean
  affectedShards?: number
  readRows?: number
  readBytes?: number
  partitions?: number
}

interface YdbQueryDetails {
  name: string
  attributes: Record<string, string | number | boolean>
  observe?: (observation: YdbQueryObservation) => void
}

const queryDetails = new WeakMap<Query<unknown[]>, YdbQueryDetails>();
const logDatabase = createStructuredLogger("database");

export function ydbQueryObservationAttributes(observation: YdbQueryObservation) {
  return {
    ...observation.attributes,
    "event.name": "ydb.client.query",
    "db.system.name": "ydb",
    "db.query.summary": observation.name,
    "ydb.client.duration_ms": Number(observation.durationMs.toFixed(1)),
    "ydb.retry.count": observation.retries,
    ...(observation.returnedRows === undefined
      ? {}
      : {
        "db.response.returned_rows": observation.returnedRows,
      }),
    ...(observation.consumedUnits === undefined
      ? {}
      : {
        "ydb.consumed_units": observation.consumedUnits,
      }),
    ...(observation.requestId === undefined ? {} : { "ydb.request.id": observation.requestId }),
    ...(observation.databaseDurationMs === undefined
      ? {}
      : {
        "ydb.server.duration_ms": Number(observation.databaseDurationMs.toFixed(1)),
      }),
    ...(observation.databaseCpuMs === undefined
      ? {}
      : {
        "ydb.server.cpu_time_ms": Number(observation.databaseCpuMs.toFixed(1)),
      }),
    ...(observation.compilationMs === undefined
      ? {}
      : {
        "ydb.query.compilation.duration_ms": Number(observation.compilationMs.toFixed(1)),
      }),
    ...(observation.compilationFromCache === undefined
      ? {}
      : {
        "ydb.query.compilation.cache_hit": observation.compilationFromCache,
      }),
    ...(observation.affectedShards === undefined
      ? {}
      : {
        "ydb.affected_shards": observation.affectedShards,
      }),
    ...(observation.readRows === undefined ? {} : { "ydb.read.rows": observation.readRows }),
    ...(observation.readBytes === undefined ? {} : { "ydb.read.bytes": observation.readBytes }),
    ...(observation.partitions === undefined ? {} : { "ydb.partitions": observation.partitions }),
    ...(!observation.success ? { "error.type": "ydb.query.error" } : {}),
  };
}

function logQueryObservation(observation: YdbQueryObservation): void {
  const missingOperation = observation.name === "missing";
  const summary = missingOperation
    ? `YDB query missing operation name (${observation.durationMs.toFixed(1)} ms)`
    : observation.success
      ? `${observation.name} → ${observation.consumedUnits ?? "?"} RU, ${observation.returnedRows ?? "?"} rows (${observation.durationMs.toFixed(1)} ms)`
      : `${observation.name} failed (${observation.durationMs.toFixed(1)} ms)`;
  logDatabase(
    observation.success && !missingOperation ? "INFO" : "ERROR",
    summary,
    {
      ...ydbQueryObservationAttributes(observation),
      ...(missingOperation ? { "error.type": "vibecloud.missing_query_name" } : {}),
    },
  );
}

function metadataNumber(value: string | Uint8Array | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const numbers = value.split(",").map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : undefined;
}

function instrumentStatement(
  statement: Query<unknown[]>,
  observe: (observation: YdbQueryObservation) => void,
): Query<unknown[]> {
  const startedAt = performance.now();
  let retries = 0;
  let consumedUnits: number | undefined;
  let requestId: string | undefined;
  let completed = false;
  statement.withStats(StatsMode.BASIC);
  statement.on("retry", () => {
    retries += 1;
  });
  statement.on("metadata", (metadata) => {
    consumedUnits = metadataNumber(metadata.get("x-ydb-consumed-units"));
    const value = metadata.get("x-request-id");
    requestId = typeof value === "string" ? value : undefined;
  });
  const complete = (success: boolean, returnedRows?: number) => {
    if (completed) return;
    completed = true;
    const stats = statement.stats();
    const tableAccess = stats?.queryPhases.flatMap((phase) => phase.tableAccess) ?? [];
    const details = queryDetails.get(statement);
    const observation: YdbQueryObservation = {
      name: details?.name ?? "missing",
      attributes: details?.attributes ?? {},
      durationMs: performance.now() - startedAt,
      retries,
      success,
      returnedRows,
      consumedUnits,
      requestId,
      ...(stats
        ? {
          databaseDurationMs: Number(stats.totalDurationUs) / 1_000,
          databaseCpuMs: Number(stats.totalCpuTimeUs) / 1_000,
          compilationMs: stats.compilation ? Number(stats.compilation.durationUs) / 1_000 : undefined,
          compilationFromCache: stats.compilation?.fromCache,
          affectedShards: stats.queryPhases.reduce(
            (total, phase) => total + Number(phase.affectedShards),
            0,
          ),
          readRows: tableAccess.reduce((total, table) => total + Number(table.reads?.rows ?? 0), 0),
          readBytes: tableAccess.reduce((total, table) => total + Number(table.reads?.bytes ?? 0), 0),
          partitions: tableAccess.reduce(
            (total, table) => total + Number(table.partitionsCount),
            0,
          ),
        }
        : {}),
    };
    observe(observation);
    details?.observe?.(observation);
  };
  statement.on("done", (resultSets) => {
    complete(true, resultSets.reduce((total, rows) => total + rows.length, 0));
  });
  statement.on("error", () => {
    complete(false);
  });
  return statement;
}

export function describeYdbQuery<T extends unknown[]>(
  statement: Query<T>,
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  observe?: (observation: YdbQueryObservation) => void,
): Query<T> {
  queryDetails.set(statement, { name, attributes, observe });
  return statement;
}

export function ydbQuery(
  executor: SQL | QueryClient | TX,
  name: string,
  attributes: Record<string, string | number | boolean> = {},
) {
  return <T extends unknown[] = unknown[], P extends unknown[] = unknown[]>(
    strings: string | TemplateStringsArray,
    ...values: P
  ): Query<T> => describeYdbQuery(executor<T, P>(strings, ...values), name, attributes);
}

function instrumentSql<T extends SQL | QueryClient | TX>(
  sql: T,
  observe: (observation: YdbQueryObservation) => void,
): T {
  return new Proxy(sql, {
    apply(target, _thisArgument, argumentsList) {
      const statement = Reflect.apply(target, target, argumentsList) as Query<unknown[]>;
      return instrumentStatement(statement, observe);
    },
    get(target, property) {
      if (property === "begin" || property === "transaction") {
        return (...args: unknown[]) => {
          const callbackIndex = typeof args[0] === "function" ? 0 : 1;
          const callback = args[callbackIndex] as (tx: TX, signal: AbortSignal) => Promise<unknown>;
          args[callbackIndex] = (tx: TX, signal: AbortSignal) => (
            callback(instrumentSql(tx, observe), signal)
          );
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

export function instrumentYdbClient(
  client: QueryClient,
  observe: (observation: YdbQueryObservation) => void = logQueryObservation,
): QueryClient {
  return instrumentSql(client, observe);
}

export function traceYdbQuery<T extends unknown[]>(
  name: string,
  statement: Query<T>,
  attributes: Record<string, string | number | boolean> = {},
) {
  return traceOperation("vibecloud-database", `ydb ${name}`, {
    "db.system.name": "ydb",
    "db.query.summary": name,
    ...attributes,
  }, async (span) => {
    describeYdbQuery(statement, name, attributes, (observation) => {
      span.setAttributes(ydbQueryObservationAttributes(observation));
    });
    return await statement;
  });
}
