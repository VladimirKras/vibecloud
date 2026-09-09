import type { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { withProjectLock } from "./project-lock.ts";

/** Recreate the Compose model when declarations change, retaining named volumes. */
export async function runWatchedCompose(initial: LoadedConfig, start: (loaded: LoadedConfig) => Promise<ChildProcess>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let next = initial;
  let child: ChildProcess | undefined;
  let restart = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let reload = Promise.resolve();
  const stopTimers = new Set<NodeJS.Timeout>();
  const stop = () => {
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    current.kill("SIGINT");
    const deadline = setTimeout(() => current.kill("SIGKILL"), 15_000);
    stopTimers.add(deadline);
    current.once("close", () => {
      clearTimeout(deadline);
      stopTimers.delete(deadline);
    });
  };
  const shutdown = () => {
    stopping = true;
    stop();
  };
  const watcher = watch(dirname(initial.configPath), (_event, filename) => {
    if (filename?.toString() !== basename(initial.configPath) || stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      reload = reload.then(async () => {
        try {
          const loaded = await withProjectLock(initial.rootDirectory, () => loadConfig(initial.configPath), signal);
          if (stopping || JSON.stringify(loaded.config) === JSON.stringify(next.config)) return;
          next = loaded;
          restart = true;
          console.log("Configuration changed; recreating local services…");
          stop();
        } catch (error) {
          if (!stopping) console.error("Configuration reload failed; correct the declaration and save it again:", error);
        }
      });
    }, 150);
  });
  signal.addEventListener("abort", shutdown, { once: true });
  try {
    do {
      restart = false;
      child = await start(next);
      const current = child;
      const completion = new Promise<void>((resolve, reject) => {
        current.once("error", reject);
        const closed = (code: number | null, signal: NodeJS.Signals | null) => {
          if (stopping || restart || code === 0) resolve();
          else reject(new Error(`Docker Compose stopped: ${signal ?? code}`));
        };
        current.once("close", closed);
        if (current.exitCode !== null || current.signalCode !== null) closed(current.exitCode, current.signalCode);
      });
      if (restart || stopping) stop();
      await completion;
      child = undefined;
    } while (restart && !stopping);
  } finally {
    stopping = true;
    watcher.close();
    if (timer) clearTimeout(timer);
    await reload;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      stop();
      await closed;
    }
    for (const deadline of stopTimers) clearTimeout(deadline);
    signal.removeEventListener("abort", shutdown);
  }
}
