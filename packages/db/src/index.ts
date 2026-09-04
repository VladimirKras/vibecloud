import { AsyncLocalStorage } from "node:async_hooks";
import { errorFrom } from "@vibecloud/core";
import { AccessTokenCredentialsProvider } from "@ydbjs/auth/access-token";
import { EnvironCredentialsProvider } from "@ydbjs/auth/environ";
import { Driver } from "@ydbjs/core";
import { createDrizzle, YdbDriver, type YdbDrizzleDatabase } from "@ydbjs/drizzle-adapter";
import { query, type QueryClient } from "@ydbjs/query";
import { instrumentYdbClient } from "./query.js";

interface YdbContext {
  db: YdbDrizzleDatabase
  queryClient?: QueryClient
}

const ydbStorage = new AsyncLocalStorage<YdbContext>();
const databaseQueryClients = new WeakMap<YdbDrizzleDatabase, QueryClient>();

export { createDrizzle } from "@ydbjs/drizzle-adapter";
export type { YdbDrizzleDatabase, YdbTransactionScope } from "@ydbjs/drizzle-adapter";
export {
  describeYdbQuery,
  instrumentYdbClient,
  traceYdbQuery,
  ydbQuery,
  ydbQueryObservationAttributes,
} from "./query.js";
export type { YdbQueryObservation } from "./query.js";

/**
 * Makes a YDB Drizzle database available to code called during one invocation.
 * Nested scopes temporarily shadow their parent scope.
 */
export function runWithYdb<T>(db: YdbDrizzleDatabase, work: () => T): T {
  const queryClient = databaseQueryClients.get(db)
    ?? (db.$client instanceof YdbDriver ? queryClientForYdb(db) : undefined);
  return ydbStorage.run({ db, queryClient }, () => {
    try {
      const result = work();
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          throw errorFrom(error);
        }) as T;
      }
      return result;
    } catch (error) {
      throw errorFrom(error);
    }
  });
}

/** Returns the YDB Drizzle database bound to the current invocation. */
export function getYdb(): YdbDrizzleDatabase {
  const db = tryGetYdb();
  if (!db) {
    throw new Error("YDB context is unavailable. Wrap the invocation in withYdb() or runWithYdb().");
  }
  return db;
}

/** Returns the current invocation's YDB Drizzle database, if one is bound. */
export function tryGetYdb(): YdbDrizzleDatabase | undefined {
  return ydbStorage.getStore()?.db;
}

/** Returns the named-query YDB client bound to the current invocation. */
export function getYdbQueryClient(): QueryClient {
  const client = tryGetYdbQueryClient();
  if (!client) {
    throw new Error("YDB query context is unavailable. Wrap the invocation in withYdb().");
  }
  return client;
}

/** Returns the named-query YDB client bound to the current invocation, if available. */
export function tryGetYdbQueryClient(): QueryClient | undefined {
  return ydbStorage.getStore()?.queryClient;
}

/** Reuses a Vibecloud Drizzle database's driver and pool for named raw YDB queries. */
export function queryClientForYdb(db: YdbDrizzleDatabase): QueryClient {
  const cached = databaseQueryClients.get(db);
  if (cached) return cached;
  if (!(db.$client instanceof YdbDriver)) {
    throw new Error("The YDB Drizzle database is not backed by the official YdbDriver");
  }
  const client = instrumentYdbClient(db.$client.client);
  databaseQueryClients.set(db, client);
  return client;
}

export interface WithYdbOptions {
  accessToken?: string
  maximumSessions?: number
  enableDiscovery?: boolean
}

/**
 * Opens an environment-authenticated YDB Drizzle connection for one unit of
 * work, binds it as the current invocation database, and always closes it.
 */
export async function withYdb<T>(
  connectionString: string,
  work: (db: YdbDrizzleDatabase) => T | Promise<T>,
  options: WithYdbOptions = {},
): Promise<T> {
  const connectionUrl = new URL(connectionString);
  const environmentCredentials = options.accessToken ? undefined : new EnvironCredentialsProvider(connectionString);
  const credentials = options.accessToken
    ? new AccessTokenCredentialsProvider({ token: options.accessToken })
    : environmentCredentials!;
  const driver = new Driver(connectionString, {
    "credentialsProvider": credentials,
    "secureOptions": connectionUrl.protocol === "grpcs:"
      ? environmentCredentials?.secureOptions
      : undefined,
    "ydb.sdk.enable_discovery": options.enableDiscovery
      ?? (process.env.VIBECLOUD_YDB_DISCOVERY !== "0"
        && !(connectionUrl.protocol === "grpc:" && (
          ["localhost", "127.0.0.1"].includes(connectionUrl.hostname)
          || connectionUrl.hostname.endsWith(".orb.local")
        ))),
    "ydb.sdk.application": "vibecloud",
  });
  const rawQueryClient = query(driver, {
    poolOptions: { maxSize: options.maximumSessions ?? 2 },
  });
  const observedQueryClient = instrumentYdbClient(rawQueryClient);
  const ydbDriver = new YdbDriver(driver);
  ydbDriver.client = rawQueryClient;
  const db = createDrizzle({ client: ydbDriver });
  databaseQueryClients.set(db, observedQueryClient);
  try {
    await driver.ready();
    return await runWithYdb(db, () => work(db));
  } finally {
    await rawQueryClient[Symbol.asyncDispose]();
    driver.close();
  }
}
