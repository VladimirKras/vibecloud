import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "./files.ts";
import { withProjectLock } from "./project-lock.ts";

const sessionSchema = z.strictObject({ port: z.number().int().min(1).max(65535), token: z.string().uuid() });
type Session = z.infer<typeof sessionSchema>;
const sessionPath = (root: string) => join(root, ".vibecloud", "local-session.json");

async function readSession(root: string) {
  const source = await readFile(sessionPath(root), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  return source === null ? undefined : sessionSchema.parse(JSON.parse(source));
}

/** Tokens identify the controller, avoiding signals to potentially reused PIDs. */
async function contact(session: Session, action: "status" | "stop"): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: session.port, method: "POST", path: `/${session.token}/${action}`, agent: false }, (res) => {
      res.resume();
      res.once("end", () => {
        if (res.statusCode === 200 && res.headers["x-vibecloud-session"] === session.token) resolve(true);
        else reject(new Error("Local development controller identity does not match; inspect .vibecloud/local-session.json"));
      });
      res.once("error", reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Local development did not stop within 30 seconds; no Docker resources were removed")));
    req.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    req.end();
  });
}

/** Called under the project lock, before enumerating or removing Docker resources. */
export async function stopLocalSession(root: string): Promise<void> {
  const session = await readSession(root);
  if (session) await contact(session, "stop");
}

/** Register before any asynchronous startup, and acknowledge down only after it ends. */
export async function withLocalSession(root: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  const { promise: stopped, resolve: finish } = Promise.withResolvers<void>();
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || ![`/${token}/status`, `/${token}/stop`].includes(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("x-vibecloud-session", token);
    if (req.url === `/${token}/stop`) {
      shutdown();
      void stopped.then(() => res.end());
    } else res.end();
  });
  let registered = false;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await withProjectLock(root, async () => {
      const existing = await readSession(root);
      if (existing && await contact(existing, "status")) throw new Error("Local development is already running for this checkout. Use pnpm vibecloud down before starting it again.");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local controller did not bind a port");
      await atomicWrite(sessionPath(root), JSON.stringify({ token, port: address.port }), undefined, 0o600);
      registered = true;
    }, controller.signal);
    await work(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    // Release down before reacquiring its project lock to remove our registration.
    finish();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    if (registered) await withProjectLock(root, async () => {
      if ((await readSession(root))?.token === token) await unlink(sessionPath(root));
    });
  }
}
