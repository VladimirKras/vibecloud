import {
  bigint,
  boolean,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  ydbTable,
} from "@ydbjs/drizzle-adapter/schema";
import { buildCreateTableSql } from "@ydbjs/drizzle-adapter/migrator";
import type { DBAdapterSchemaCreation } from "better-auth/adapters";
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";

type ColumnBuilder
  = | ReturnType<typeof bigint>
    | ReturnType<typeof boolean>
    | ReturnType<typeof integer>
    | ReturnType<typeof text>
    | ReturnType<typeof timestamp>;

export type BetterAuthYdbTable = ReturnType<typeof ydbTable>;

export function buildBetterAuthTables(schema: BetterAuthDBSchema): Map<string, BetterAuthYdbTable> {
  const tables = new Map<string, BetterAuthYdbTable>();
  for (const [schemaName, definition] of Object.entries(schema)) {
    const physicalFields = new Map<string, DBFieldAttribute>();
    for (const [schemaFieldName, attribute] of Object.entries(definition.fields)) {
      physicalFields.set(attribute.fieldName ?? schemaFieldName, attribute);
    }
    const columns: Record<string, ColumnBuilder> = {};
    columns.id = columnBuilder("id", physicalFields.get("id") ?? { type: "string", required: true });
    for (const [name, attribute] of physicalFields) {
      if (name !== "id") columns[name] = columnBuilder(name, attribute);
    }
    const table = ydbTable(definition.modelName, columns, (self) => [
      primaryKey(self.id),
      ...Array.from(physicalFields, ([name, attribute]) => {
        if (name === "id") return undefined;
        if (attribute.unique) return uniqueIndex(`idx_${definition.modelName}_${name}`).on(self[name]).global().sync();
        if (attribute.index) return index(`idx_${definition.modelName}_${name}`).on(self[name]).global();
        return undefined;
      }).filter((value) => value !== undefined),
    ]);
    tables.set(schemaName, table);
    tables.set(definition.modelName, table);
  }
  return tables;
}

export function tableForModel(
  tables: Map<string, BetterAuthYdbTable>,
  model: string,
): BetterAuthYdbTable {
  const table = tables.get(model);
  if (!table) throw new Error(`[@vibecloud/db] Better Auth model "${model}" is missing from its schema`);
  return table;
}

export function buildSchemaDdl(defaultOutputPath: string) {
  return async ({
    file,
    tables,
  }: {
    file?: string
    tables: BetterAuthDBSchema
  }): Promise<DBAdapterSchemaCreation> => ({
    code: `${Array.from(new Set(buildBetterAuthTables(tables).values()))
      .map((table) => `${buildCreateTableSql(table, { ifNotExists: true })};`)
      .join("\n\n")}\n`,
    path: file ?? defaultOutputPath,
    overwrite: false,
    append: true,
  });
}

function columnBuilder(name: string, attribute: DBFieldAttribute): ColumnBuilder {
  const builder = (() => {
    switch (attribute.type) {
      case "number": return attribute.bigint ? bigint(name) : integer(name);
      case "boolean": return boolean(name);
      case "date": return timestamp(name);
      case "json": return text(name);
      default: return text(name);
    }
  })();
  return attribute.required === false ? builder : builder.notNull();
}
