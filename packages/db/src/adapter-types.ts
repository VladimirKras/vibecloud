import type { YdbDrizzleDatabase } from "@ydbjs/drizzle-adapter";
import type { Query, QueryClient, TX } from "@ydbjs/query";
import type { Value } from "@ydbjs/value";
import type { DBAdapterDebugLogOption } from "better-auth/adapters";

interface SharedYdbAdapterConfig {
  describeQuery?: DescribeQuery
  debugLogs?: DBAdapterDebugLogOption
  usePlural?: boolean
  schemaOutputPath?: string
  secondaryIndexes?: Readonly<Record<string, readonly YdbSecondaryIndex[]>>
}

export type YdbAdapterConfig = SharedYdbAdapterConfig & (
  | { getClient: () => QueryClient, getDb?: never }
  | { getDb: () => YdbDrizzleDatabase, getClient?: never }
);

export interface YdbSecondaryIndex {
  name: string
  fields: readonly string[]
}

export type Executor = QueryClient | TX;
export type AnyQuery = Query<unknown[]>;
export type DescribeQuery = <T extends unknown[]>(
  statement: Query<T>,
  name: string,
  attributes?: Record<string, string | number | boolean>,
) => Query<T>;
export type ParameterMap = ReadonlyMap<string, Value>;

export function isTransaction(executor: Executor): executor is TX {
  return "transactionId" in executor;
}
