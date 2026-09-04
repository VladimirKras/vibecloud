import { identifier } from "@ydbjs/query";
import { Int32 } from "@ydbjs/value/primitive";
import type { CleanedWhere, CustomAdapter, JoinConfig } from "better-auth/adapters";
import type { DBFieldAttribute } from "better-auth/db";
import type { AnyQuery, DescribeQuery, Executor, YdbSecondaryIndex } from "./adapter-types.js";
import { isTransaction } from "./adapter-types.js";
import { toYdbValue } from "./values.js";
import { bind, buildWhere, rows } from "./where.js";

export interface AdapterModelDefinition {
  fields: ReadonlySet<string>
}

interface MethodOptions {
  executor: () => Executor
  describeQuery: DescribeQuery
  models: ReadonlyMap<string, AdapterModelDefinition>
  getFieldAttributes: (input: { model: string, field: string }) => DBFieldAttribute
  secondaryIndexes?: Readonly<Record<string, readonly YdbSecondaryIndex[]>>
}

const quote = (value: string): string => identifier(value).toString();

export function buildAdapterMethods(options: MethodOptions): CustomAdapter {
  const { executor, describeQuery, models, getFieldAttributes, secondaryIndexes } = options;

  const named = <T extends AnyQuery>(name: string, model: string, query: T): T => (
    describeQuery(query, name, { "db.collection.name": model }) as T
  );

  const modelDefinition = (model: string): AdapterModelDefinition => {
    const definition = models.get(model);
    if (!definition) throw new Error(`[@vibecloud/db] Unknown Better Auth model: ${model}`);
    return definition;
  };
  const assertField = (model: string, field: string): void => {
    if (!modelDefinition(model).fields.has(field)) {
      throw new Error(`[@vibecloud/db] Unknown Better Auth field: ${model}.${field}`);
    }
  };
  const attribute = (model: string, field: string): DBFieldAttribute => {
    assertField(model, field);
    return getFieldAttributes({ model, field });
  };
  const whereFor = (model: string, where: readonly CleanedWhere[] | undefined, prefix = "w") =>
    buildWhere({
      where,
      prefix,
      attribute: (field) => attribute(model, field),
      assertField: (field) => assertField(model, field),
    });
  const selectList = (model: string, select: string[] | undefined): string => {
    if (!select?.length) return "*";
    for (const field of select) assertField(model, field);
    return select.map(quote).join(", ");
  };
  const indexView = (model: string, where: readonly CleanedWhere[] | undefined): string => {
    if (!where?.length || where.some((clause) => (
      clause.connector?.toUpperCase() === "OR" || clause.mode === "insensitive"
    ))) return "";
    const equalityFields = new Set(where.filter((clause) => (
      !clause.operator || clause.operator === "eq"
    )).map((clause) => clause.field));
    const index = [...(secondaryIndexes?.[model] ?? [])]
      .sort((left, right) => right.fields.length - left.fields.length)
      .find((candidate) => candidate.fields.every((field) => equalityFields.has(field)));
    return index ? ` VIEW ${quote(index.name)}` : "";
  };
  const selectSource = (model: string, where: readonly CleanedWhere[] | undefined): string => (
    `${quote(model)}${indexView(model, where)}`
  );
  const inTransaction = async <T>(callback: (tx: Executor) => Promise<T>): Promise<T> => {
    const current = executor();
    if (isTransaction(current)) return callback(current);
    return current.begin({ isolation: "serializableReadWrite" }, callback);
  };

  const create: CustomAdapter["create"] = async ({ model, data }) => {
    modelDefinition(model);
    const fields = Object.keys(data);
    if (!fields.length) throw new Error(`[@vibecloud/db] Cannot insert an empty ${model}`);
    for (const field of fields) assertField(model, field);
    const statement = `INSERT INTO ${quote(model)} (${fields.map(quote).join(", ")}) VALUES (${fields.map((_, index) => `$v${index}`).join(", ")})`;
    const query = named("auth.create", model, executor()(statement));
    fields.forEach((field, index) => {
      query.parameter(`v${index}`, toYdbValue(data[field], attribute(model, field)));
    });
    await query;
    return data;
  };

  const findOne = async <T>({ model, where, select }: {
    model: string
    where: CleanedWhere[]
    select?: string[]
    join?: JoinConfig
  }): Promise<T | null> => {
    modelDefinition(model);
    const built = whereFor(model, where);
    const query = named("auth.find-one", model, executor()(
      `SELECT ${selectList(model, select)} FROM ${selectSource(model, where)}${built.sql} LIMIT 1`,
    ));
    bind(query, built.parameters);
    const result = await rows<T>(query);
    return result[0] ?? null;
  };

  const findMany: CustomAdapter["findMany"] = async ({
    model,
    where,
    limit,
    offset,
    sortBy,
    select,
  }) => {
    modelDefinition(model);
    const built = whereFor(model, where);
    let statement = `SELECT ${selectList(model, select)} FROM ${selectSource(model, where)}${built.sql}`;
    if (sortBy) {
      assertField(model, sortBy.field);
      statement += ` ORDER BY ${quote(sortBy.field)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
    }
    if (limit !== undefined) statement += ` LIMIT ${nonNegativeInteger(limit, "limit")}`;
    if (offset !== undefined && offset > 0) statement += ` OFFSET ${nonNegativeInteger(offset, "offset")}`;
    const query = named("auth.find-many", model, executor()(statement));
    bind(query, built.parameters);
    return rows(query);
  };

  const count: CustomAdapter["count"] = async ({ model, where }) => {
    modelDefinition(model);
    const built = whereFor(model, where);
    const query = named("auth.count", model, executor()(
      `SELECT COUNT(*) AS count FROM ${selectSource(model, where)}${built.sql}`,
    ));
    bind(query, built.parameters);
    const result = await rows<{ count: number | bigint }>(query);
    return Number(result[0]?.count ?? 0);
  };

  const update = async <T>({ model, where, update: data }: {
    model: string
    where: CleanedWhere[]
    update: T
  }): Promise<T | null> => {
    modelDefinition(model);
    const fields = Object.keys(data as Record<string, unknown>);
    if (!where.length) return null;
    if (!fields.length) return findOne({ model, where });
    for (const field of fields) assertField(model, field);
    const built = whereFor(model, where);
    const statement = `UPDATE ${quote(model)} SET ${fields.map((field, index) => `${quote(field)} = $u${index}`).join(", ")}${built.sql} RETURNING *`;
    const query = named("auth.update", model, executor()(statement));
    fields.forEach((field, index) => {
      query.parameter(`u${index}`, toYdbValue((data as Record<string, unknown>)[field], attribute(model, field)));
    });
    bind(query, built.parameters);
    const result = await rows<T>(query);
    return result[0] ?? null;
  };

  const updateMany: CustomAdapter["updateMany"] = async ({ model, where, update: data }) =>
    inTransaction(async (tx) => {
      modelDefinition(model);
      const built = whereFor(model, where);
      const countQuery = named("auth.update-many.count", model, tx(
        `SELECT COUNT(*) AS count FROM ${selectSource(model, where)}${built.sql}`,
      ));
      bind(countQuery, built.parameters);
      const matched = Number((await rows<{ count: number | bigint }>(countQuery))[0]?.count ?? 0);
      const fields = Object.keys(data);
      if (!matched || !fields.length) return matched;
      for (const field of fields) assertField(model, field);
      const query = named("auth.update-many", model, tx(
        `UPDATE ${quote(model)} SET ${fields.map((field, index) => `${quote(field)} = $u${index}`).join(", ")}${built.sql}`,
      ));
      fields.forEach((field, index) => {
        query.parameter(`u${index}`, toYdbValue(data[field], attribute(model, field)));
      });
      bind(query, built.parameters);
      await query;
      return matched;
    });

  const deleteOne: CustomAdapter["delete"] = async ({ model, where }) => {
    modelDefinition(model);
    if (!where.length) return;
    const built = whereFor(model, where);
    const query = named("auth.delete", model, executor()(`DELETE FROM ${quote(model)}${built.sql}`));
    bind(query, built.parameters);
    await query;
  };

  const deleteMany: CustomAdapter["deleteMany"] = async ({ model, where }) =>
    inTransaction(async (tx) => {
      modelDefinition(model);
      const built = whereFor(model, where);
      const countQuery = named("auth.delete-many.count", model, tx(
        `SELECT COUNT(*) AS count FROM ${selectSource(model, where)}${built.sql}`,
      ));
      bind(countQuery, built.parameters);
      const matched = Number((await rows<{ count: number | bigint }>(countQuery))[0]?.count ?? 0);
      if (!matched) return 0;
      const query = named("auth.delete-many", model, tx(`DELETE FROM ${quote(model)}${built.sql}`));
      bind(query, built.parameters);
      await query;
      return matched;
    });

  const consumeOne = async <T>({ model, where }: {
    model: string
    where: CleanedWhere[]
  }): Promise<T | null> =>
    inTransaction(async (tx) => {
      assertField(model, "id");
      const built = whereFor(model, where);
      const selectQuery = named("auth.consume-one.select", model, tx(
        `SELECT * FROM ${selectSource(model, where)}${built.sql} LIMIT 1`,
      ));
      bind(selectQuery, built.parameters);
      const selected = (await rows<T & Record<string, unknown>>(selectQuery))[0];
      if (!selected) return null;
      const deleteQuery = named("auth.consume-one.delete", model, tx(
        `DELETE FROM ${quote(model)} WHERE ${quote("id")} = $id`,
      ));
      deleteQuery.parameter("id", toYdbValue(selected.id, attribute(model, "id")));
      await deleteQuery;
      return selected;
    });

  const incrementOne = async <T>({
    model,
    where,
    increment,
    set = {},
  }: {
    model: string
    where: CleanedWhere[]
    increment: Record<string, number>
    set?: Record<string, unknown>
  }): Promise<T | null> => inTransaction(async (tx) => {
    assertField(model, "id");
    const built = whereFor(model, where);
    const selectQuery = named("auth.increment-one.select", model, tx(
      `SELECT ${quote("id")} FROM ${selectSource(model, where)}${built.sql} LIMIT 1`,
    ));
    bind(selectQuery, built.parameters);
    const selected = (await rows<{ id: unknown }>(selectQuery))[0];
    if (!selected) return null;

    const incrementFields = Object.keys(increment);
    const setFields = Object.keys(set);
    for (const field of [...incrementFields, ...setFields]) assertField(model, field);
    const assignments = [
      ...incrementFields.map((field, index) => `${quote(field)} = ${quote(field)} + $i${index}`),
      ...setFields.map((field, index) => `${quote(field)} = $s${index}`),
    ];
    if (!assignments.length) {
      const rowQuery = named("auth.increment-one.read", model, tx(
        `SELECT * FROM ${quote(model)} WHERE ${quote("id")} = $id`,
      ));
      rowQuery.parameter("id", toYdbValue(selected.id, attribute(model, "id")));
      return (await rows<T>(rowQuery))[0] ?? null;
    }
    const updateQuery = named("auth.increment-one.update", model, tx(
      `UPDATE ${quote(model)} SET ${assignments.join(", ")} WHERE ${quote("id")} = $id RETURNING *`,
    ));
    updateQuery.parameter("id", toYdbValue(selected.id, attribute(model, "id")));
    incrementFields.forEach((field, index) => {
      const fieldAttribute = attribute(model, field);
      const delta = increment[field] ?? 0;
      updateQuery.parameter(
        `i${index}`,
        fieldAttribute.bigint ? toYdbValue(delta, fieldAttribute) : new Int32(delta),
      );
    });
    setFields.forEach((field, index) => {
      updateQuery.parameter(`s${index}`, toYdbValue(set[field], attribute(model, field)));
    });
    return (await rows<T>(updateQuery))[0] ?? null;
  });

  return {
    create,
    findOne,
    findMany,
    count,
    update,
    updateMany,
    delete: deleteOne,
    deleteMany,
    consumeOne,
    incrementOne,
  };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[@vibecloud/db] ${name} must be a non-negative number`);
  }
  return Math.floor(value);
}
