import { identifier } from "@ydbjs/query";
import type { CleanedWhere } from "better-auth/adapters";
import type { DBFieldAttribute } from "better-auth/db";
import type { AnyQuery, ParameterMap } from "./adapter-types.js";
import { toYdbValue } from "./values.js";

const escapeLike = (value: string): string => value.replace(/([%_\\])/g, "\\$1");

export function bind(query: AnyQuery, parameters: ParameterMap): void {
  for (const [name, value] of parameters) query.parameter(name, value);
}

export async function rows<T>(query: AnyQuery): Promise<T[]> {
  const resultSets = await query as unknown as T[][];
  return resultSets[0] ?? [];
}

export function buildWhere(options: {
  where: readonly CleanedWhere[] | undefined
  attribute: (field: string) => DBFieldAttribute
  assertField: (field: string) => void
  prefix?: string
}): { sql: string, parameters: Map<string, ReturnType<typeof toYdbValue>> } {
  const { where, attribute, assertField, prefix = "w" } = options;
  if (!where?.length) return { sql: "", parameters: new Map() };

  const parameters = new Map<string, ReturnType<typeof toYdbValue>>();
  const clauses: string[] = [];
  for (const [index, clause] of where.entries()) {
    assertField(clause.field);
    const field = identifier(clause.field).toString();
    const connector = index === 0 ? "" : ` ${clause.connector ?? "AND"} `;
    const fieldAttribute = attribute(clause.field);
    const insensitive = clause.mode === "insensitive" && fieldAttribute.type === "string";
    const normalize = (expression: string): string =>
      insensitive ? `Unicode::ToLower(${expression})` : expression;

    if (clause.value === null) {
      clauses.push(`${connector}${field} ${clause.operator === "ne" ? "IS NOT NULL" : "IS NULL"}`);
      continue;
    }

    if (clause.operator === "in" || clause.operator === "not_in") {
      const values = Array.isArray(clause.value) ? clause.value : [clause.value];
      if (values.length === 0) {
        clauses.push(`${connector}${clause.operator === "in" ? "FALSE" : "TRUE"}`);
        continue;
      }
      const placeholders = values.map((value, itemIndex) => {
        const name = `${prefix}${index}_${itemIndex}`;
        parameters.set(name, toYdbValue(value, fieldAttribute));
        return normalize(`$${name}`);
      });
      clauses.push(
        `${connector}${normalize(field)} ${clause.operator === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`,
      );
      continue;
    }

    if (clause.operator === "contains" || clause.operator === "starts_with" || clause.operator === "ends_with") {
      const escaped = escapeLike(String(clause.value));
      const pattern = clause.operator === "contains"
        ? `%${escaped}%`
        : clause.operator === "starts_with" ? `${escaped}%` : `%${escaped}`;
      const name = `${prefix}${index}`;
      parameters.set(name, toYdbValue(pattern, fieldAttribute));
      clauses.push(`${connector}${normalize(field)} LIKE ${normalize(`$${name}`)} ESCAPE '\\\\'`);
      continue;
    }

    const operator = {
      eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=",
    }[clause.operator] ?? "=";
    const name = `${prefix}${index}`;
    parameters.set(name, toYdbValue(clause.value, fieldAttribute));
    clauses.push(`${connector}${normalize(field)} ${operator} ${normalize(`$${name}`)}`);
  }
  return { sql: ` WHERE ${clauses.join("")}`, parameters };
}
