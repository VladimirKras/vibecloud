import { AsyncLocalStorage } from "node:async_hooks";
import type { TX } from "@ydbjs/query";
import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type DBAdapter,
  type DBTransactionAdapter,
} from "better-auth/adapters";
import { buildAdapterMethods } from "./adapter-methods.js";
import type { YdbAdapterConfig } from "./adapter-types.js";
import { queryClientForYdb } from "./index.js";
import { describeYdbQuery } from "./query.js";
import { buildSchemaDdl } from "./schema.js";

export type { YdbAdapterConfig, YdbSecondaryIndex } from "./adapter-types.js";

const defaultSchemaOutputPath = "./migrations/001_better_auth.sql";

/**
 * Creates a Better Auth adapter on the query client already owned by the
 * invocation's YDB Drizzle database.
 */
export function ydbAdapter(config: YdbAdapterConfig) {
  return <Options extends BetterAuthOptions>(options: Options): DBAdapter<Options> => {
    const transactionContext = new AsyncLocalStorage<TX>();
    const getClient = config.getClient
      ?? (() => queryClientForYdb(config.getDb()));
    const describeQuery = config.describeQuery ?? describeYdbQuery;
    const factory = createAdapterFactory<Options>({
      config: {
        adapterId: "vibecloud-ydb",
        adapterName: "Vibecloud YDB Adapter",
        usePlural: config.usePlural ?? false,
        debugLogs: config.debugLogs ?? false,
        supportsJSON: false,
        supportsArrays: false,
        supportsDates: true,
        supportsBooleans: true,
        supportsNumericIds: true,
        supportsUUIDs: false,
        transaction: async (callback) => {
          const existing = transactionContext.getStore();
          if (existing) return callback(transactionAdapter);
          return getClient().begin(
            { isolation: "serializableReadWrite" },
            async (tx) => transactionContext.run(tx, () => callback(transactionAdapter)),
          );
        },
      },
      adapter: ({ schema, getModelName, getFieldName, getFieldAttributes }) => {
        const models = new Map<string, { fields: ReadonlySet<string> }>();
        for (const [defaultModel, definition] of Object.entries(schema)) {
          const model = getModelName(defaultModel);
          const fields = new Set<string>(["id"]);
          for (const field of Object.keys(definition.fields)) {
            fields.add(getFieldName({ model: defaultModel, field }));
          }
          models.set(model, { fields });
        }
        return {
          ...buildAdapterMethods({
            executor: () => transactionContext.getStore() ?? getClient(),
            describeQuery,
            models,
            getFieldAttributes,
            secondaryIndexes: config.secondaryIndexes,
          }),
          createSchema: buildSchemaDdl(config.schemaOutputPath ?? defaultSchemaOutputPath),
        };
      },
    });

    const adapter = factory(options);
    const transactionAdapter = adapter as unknown as DBTransactionAdapter;
    return adapter;
  };
}
