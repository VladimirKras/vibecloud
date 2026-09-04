import type { Value } from "@ydbjs/value";
import { Optional } from "@ydbjs/value/optional";
import {
  Bool,
  BoolType,
  Int32,
  Int32Type,
  Int64,
  Int64Type,
  Timestamp,
  TimestampType,
  Utf8,
  Utf8Type,
  type PrimitiveType,
} from "@ydbjs/value/primitive";
import type { DBFieldAttribute } from "better-auth/db";

export function ydbType(attribute: DBFieldAttribute): {
  sql: string
  type: PrimitiveType
} {
  switch (attribute.type) {
    case "boolean":
      return { sql: "Bool", type: new BoolType() };
    case "number":
      return attribute.bigint
        ? { sql: "Int64", type: new Int64Type() }
        : { sql: "Int32", type: new Int32Type() };
    case "date":
      return { sql: "Timestamp", type: new TimestampType() };
    default:
      return { sql: "Utf8", type: new Utf8Type() };
  }
}

export function toYdbValue(value: unknown, attribute: DBFieldAttribute): Value {
  const { type } = ydbType(attribute);
  if (value === null || value === undefined) return new Optional(null, type);

  switch (attribute.type) {
    case "boolean":
      return new Bool(Boolean(value));
    case "number":
      return attribute.bigint
        ? new Int64(typeof value === "bigint" ? value : BigInt(value as number))
        : new Int32(Number(value));
    case "date":
      return new Timestamp(value instanceof Date ? value : new Date(String(value)));
    case "json":
      return new Utf8(typeof value === "string" ? value : JSON.stringify(value));
    default:
      return new Utf8(Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
}
