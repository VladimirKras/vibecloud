import { spawn } from "node:child_process";

export type CommandRunner = (
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => Promise<void>;
export type OutputReader = (
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => Promise<string>;

/** A command owns its process group until close, including cancellation. */
export async function spawnCommand(command: string, arguments_: string[], environment: NodeJS.ProcessEnv, cwd?: string, signal?: AbortSignal): Promise<void> {
  await commandResult(command, arguments_, environment, cwd, signal, false);
}

export function readCommandOutput(command: string, arguments_: string[], environment: NodeJS.ProcessEnv, cwd?: string, signal?: AbortSignal): Promise<string> {
  return commandResult(command, arguments_, environment, cwd, signal, true);
}

function commandResult(command: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string | undefined, signal: AbortSignal | undefined, capture: boolean): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const group = !!signal && process.platform !== "win32";
    const child = spawn(command, args, { cwd, env: environment, detached: group, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    let errorOutput = "";
    let failure: Error | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const kill = (value: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const stop = () => {
      kill("SIGTERM");
      deadline ??= setTimeout(() => kill("SIGKILL"), 5_000);
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, termination) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted && group) kill("SIGKILL");
      if (deadline) clearTimeout(deadline);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve(output);
      else reject(new Error(errorOutput.trim() || `${command} failed${termination ? ` with signal ${termination}` : ` with exit code ${code}`}`));
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}
