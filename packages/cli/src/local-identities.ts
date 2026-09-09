import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

type Kind = "buckets" | "databases";
const prefixes = { buckets: "vc-", databases: "ydb-" };

async function readIdentities(root: string, kind: Kind) {
  const path = join(root, ".vibecloud", `local-${kind}.json`);
  const original = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const identities = z.record(z.string(), z.string().regex(new RegExp(`^${prefixes[kind]}[a-z][a-z0-9-]{0,62}$`)));
  return { path, original, names: identities.parse(original === null ? {} : JSON.parse(original)) };
}

/** Logical names may change; stored bytes and public URLs keep their original identity. */
export async function localResourceNames(root: string, kind: Kind, resources: Record<string, unknown> = {}) {
  const { names } = await readIdentities(root, kind);
  const selected = Object.fromEntries(Object.keys(resources).map((name) => [name, names[name] ?? `${prefixes[kind]}${name}`]));
  if (new Set(Object.values(selected)).size !== Object.keys(selected).length) throw new Error(`Local ${kind} must have distinct storage identities`);
  return selected;
}

/** Commit together with the configuration rename, using the existing project edit journal. */
export async function localResourceRenameEdit(root: string, kind: Kind, oldName: string, newName: string) {
  const { path, original, names } = await readIdentities(root, kind);
  names[newName] = names[oldName] ?? `${prefixes[kind]}${oldName}`;
  delete names[oldName];
  return { path, original, updated: JSON.stringify(names, null, 2) + "\n" };
}
