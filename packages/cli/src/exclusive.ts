import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const owners = new AsyncLocalStorage<ReadonlySet<string>>();
// A pending Promise alone does not keep its continuation reachable. Retain the
// native handle explicitly until finally, even if authored work stalls forever.
const handles = new Set<DatabaseSync>();
export type LocalLock = "project" | "build";

/** SQLite holds the OS file lock; process death releases it without a TTL or PID guessing.
 * These empty databases are local coordination handles, never application state.
 * Never unlink a handle: every process must open the same inode.
 */
export async function withExclusive<T>(root: string, kind: LocalLock, work: (nested: boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true });
  root = await realpath(root);
  const key = `${root}\0${kind}`;
  if (owners.getStore()?.has(key)) return work(true);
  const legacy = join(root, ".vibecloud", kind === "project" ? "mutation.lock" : "build.lock");
  if (await lstat(legacy).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  })) {
    throw new Error(`An older CLI left ${legacy}. Stop older Vibecloud commands and remove that obsolete lock before retrying.`);
  }
  const directory = join(root, ".vibecloud", "locks");
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error("Local lock storage must not be a symlink");
  const path = join(directory, `${kind}.sqlite`);
  if ((await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  }))?.isSymbolicLink()) {
    throw new Error("Local lock handles must not be symlinks");
  }
  const database = new DatabaseSync(path, { timeout: 0 });
  handles.add(database);
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        // Commit a real header before reserving the handle. Empty SQLite files
        // can be reinitialized by another connection, invalidating their locks.
        database.exec("CREATE TABLE IF NOT EXISTS lock_handle (id INTEGER PRIMARY KEY)");
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        if (Date.now() >= deadline) throw new Error(`Another ${kind} operation is still running. Wait for it to finish and retry.`, { cause: error });
        await delay(25, undefined, { signal });
      }
    }
    return await owners.run(new Set([...(owners.getStore() ?? []), key]), () => work(false));
  } finally {
    database.close();
    handles.delete(database);
  }
}
