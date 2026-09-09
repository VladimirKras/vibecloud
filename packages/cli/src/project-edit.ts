import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { atomicWrite, exists } from "./files.ts";

const journalSchema = z.strictObject({
  writes: z.array(z.strictObject({ path: z.string(), original: z.string().nullable(), updated: z.string().nullable(), mode: z.number().optional() })),
  moves: z.array(z.strictObject({ from: z.string(), to: z.string() })),
  directories: z.array(z.string()).default([]),
});
type ProjectEdit = z.input<typeof journalSchema>;
type Journal = z.output<typeof journalSchema>;
const journalPath = (root: string) => join(root, ".vibecloud", "pending-edit.json");
const transactions = new AsyncLocalStorage<{ root: string, journal: Journal }>();

async function fileContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertProjectPath(root: string, path: string): Promise<void> {
  path = resolve(path);
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(await realpath(ancestor), relative(ancestor, path));
  const local = relative(await realpath(root), physical);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error(`Invalid project journal path: ${path}`);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Project edits cannot replace a symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Called while holding the project lock. Interrupted edits roll back before new work. */
export async function recoverProjectEdit(root: string): Promise<void> {
  const path = journalPath(root);
  if (!await exists(path)) return;
  const edit = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  for (const file of [...edit.writes.map(({ path }) => path), ...edit.moves.flatMap(({ from, to }) => [from, to]), ...edit.directories]) {
    await assertProjectPath(root, file);
  }
  // Multiple phases may write the same file. Any journaled intermediate version
  // is recoverable, including a crash between extending the journal and writing.
  const files = new Map<string, { original: string | null, mode?: number, versions: Set<string | null> }>();
  for (const write of edit.writes) {
    const file = files.get(write.path) ?? { original: write.original, mode: write.mode, versions: new Set() };
    file.versions.add(write.original).add(write.updated);
    files.set(write.path, file);
  }
  for (const [file, snapshot] of files) {
    if (!snapshot.versions.has(await fileContent(file))) throw new Error(`Cannot recover changed file ${file}; inspect ${path}`);
  }
  for (const move of edit.moves) {
    if (await exists(move.from) === await exists(move.to)) throw new Error(`Cannot recover source move; inspect ${path}`);
  }
  for (const [file, snapshot] of [...files].reverse()) {
    const source = await fileContent(file);
    if (source === snapshot.original) continue;
    if (snapshot.original === null) await unlink(file);
    else await atomicWrite(file, snapshot.original, source ?? undefined, snapshot.mode);
  }
  for (const move of [...edit.moves].reverse()) {
    if (await exists(move.to)) await rename(move.to, move.from);
  }
  for (const directory of [...edit.directories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      // Preserve anything authored inside a newly created directory.
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  await unlink(path);
}

/** The owning project lock keeps this journal until every CLI phase completes. */
export async function withProjectEdit<T>(root: string, work: () => Promise<T>): Promise<T> {
  if (transactions.getStore()?.root === root) return work();
  const transaction = { root, journal: { writes: [], moves: [], directories: [] } as Journal };
  try {
    const result = await transactions.run(transaction, work);
    if (await exists(journalPath(root))) await unlink(journalPath(root));
    return result;
  } catch (error) {
    try {
      await recoverProjectEdit(root);
    } catch (recovery) {
      throw new AggregateError([error, recovery], `Project edit needs recovery: ${journalPath(root)}`, { cause: recovery });
    }
    throw error;
  }
}

export async function commitProjectEdit(root: string, edit: ProjectEdit): Promise<void> {
  root = await realpath(root);
  if (transactions.getStore()?.root !== root) return withProjectEdit(root, () => commitProjectEdit(root, edit));
  const transaction = transactions.getStore()!;
  const moves = [];
  const directories = new Set<string>();
  for (const move of edit.moves) {
    if (!await exists(move.from)) continue;
    if (await exists(move.to)) throw new Error(`source path already exists: ${move.to}`);
    await assertProjectPath(root, move.from);
    await assertProjectPath(root, move.to);
    moves.push(move);
  }
  for (const directory of [...(edit.directories ?? []), ...edit.writes.filter(({ updated }) => updated !== null).map(({ path }) => dirname(path))]) {
    let current = directory;
    const missing = [];
    while (!await exists(current)) {
      missing.push(current);
      current = dirname(current);
    }
    for (const path of missing.reverse()) directories.add(path);
  }
  for (const path of directories) await assertProjectPath(root, path);
  for (const write of edit.writes) {
    await assertProjectPath(root, write.path);
    if (await fileContent(write.path) !== write.original) throw new Error(`File changed outside the project mutation: ${write.path}`);
    if (write.original !== null) write.mode = (await lstat(write.path)).mode & 0o777;
  }
  const journal = {
    writes: [...transaction.journal.writes, ...edit.writes],
    moves: [...transaction.journal.moves, ...moves],
    directories: [...new Set([...transaction.journal.directories, ...directories])],
  };
  await atomicWrite(journalPath(root), JSON.stringify(journal), undefined, 0o600);
  transaction.journal = journal;
  for (const directory of directories) await mkdir(directory, { recursive: true });
  for (const move of moves) await rename(move.from, move.to);
  for (const write of edit.writes) {
    if (write.updated === null) {
      if (write.original !== null) await unlink(write.path);
    } else if (write.original === null) await writeFile(write.path, write.updated, { flag: "wx", mode: write.mode });
    else await atomicWrite(write.path, write.updated, write.original);
  }
}
