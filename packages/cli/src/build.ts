import { spawn } from "node:child_process";
import type { LoadedConfig } from "./config.ts";

export type BuildCommandRunner = (command: string, cwd: string) => Promise<void>;

export async function buildProject(
  loaded: LoadedConfig,
  { runCommand = spawnCommand }: { runCommand?: BuildCommandRunner } = {},
): Promise<boolean> {
  const hasBuild = Object.keys(loaded.config.assets ?? {}).length > 0
    || Object.keys(loaded.config.functions ?? {}).length > 0;
  if (hasBuild) await runCommand("pnpm build", loaded.rootDirectory);
  return hasBuild;
}

function spawnCommand(command: string, cwd: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, { cwd, env: process.env, shell: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
