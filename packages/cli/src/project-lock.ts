import { recoverProjectEdit, withProjectEdit } from "./project-edit.ts";
import { withExclusive } from "./exclusive.ts";
import { realpath } from "node:fs/promises";

/** Ownership is independent of rollback. Cloud receipts must survive failed commands. */
export async function withProjectLock<T>(root: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (process.env.VIBECLOUD_DEV_CONTAINER === "1") throw new Error("Run Vibecloud project management commands on the host. The development container owns runtime processes and its private build volume only.");
  return withExclusive(root, "project", async (nested) => {
    if (!nested) await recoverProjectEdit(await realpath(root));
    return work();
  }, signal);
}

/** Only reversible source/scaffold changes participate in the file journal. */
export async function withProjectMutation<T>(root: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withProjectLock(root, async () => withProjectEdit(await realpath(root), work), signal);
}
