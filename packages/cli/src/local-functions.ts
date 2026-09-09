import { Worker } from "node:worker_threads";
import { sep } from "node:path";
import type { HttpEvent, HttpResponse } from "@vibecloud/function-api";
import type { InvocationContext } from "@vibecloud/core";

// One worker owns each bundled function's module state, timers and SDK providers.
interface PendingInvocation {
  resolve(value: HttpResponse): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}
const workers = new Map<string, { worker: Worker, pending: Map<number, PendingInvocation> }>();
let requestId = 0;

export class LocalFunctionTimeoutError extends Error {
  constructor() {
    super("Local function exceeded its configured timeout; its worker was terminated");
    this.name = "LocalFunctionTimeoutError";
  }
}
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const exports = require(workerData);
parentPort.on("message", async ({ id, exportName, event, context, deadline }) => {
  context.getRemainingTimeInMillis = () => Math.max(0, deadline - Date.now());
  context.getPayload = () => undefined;
  try {
    if (typeof exports[exportName] !== "function") throw new Error("Missing handler export: " + exportName);
    parentPort.postMessage({ id, result: await exports[exportName](event, context) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export function invokeFunctionWorker(path: string, exportName: string, event: HttpEvent, context: InvocationContext): Promise<HttpResponse> {
  let instance = workers.get(path);
  if (!instance) {
    const worker = new Worker(workerSource, { eval: true, workerData: path });
    const pending = new Map<number, PendingInvocation>();
    instance = { worker, pending };
    workers.set(path, instance);
    const fail = (error: Error) => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      if (workers.get(path)?.worker === worker) workers.delete(path);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Function worker stopped (${code})`)));
    worker.on("message", (message: { id: number, result: HttpResponse, error?: string }) => {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request) clearTimeout(request.timer);
      if (message.error !== undefined) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
      if (!pending.size) worker.unref();
    });
    worker.unref();
  }
  const current = instance;
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, Math.min(2_147_483_647, Math.floor(context.getRemainingTimeInMillis())));
    const timer = setTimeout(() => {
      // Terminate the worker even for synchronous loops or handlers ignoring abort
      // signals. Other requests on this worker fail too; the next call starts fresh.
      if (workers.get(path) === current) workers.delete(path);
      for (const request of current.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new LocalFunctionTimeoutError());
      }
      current.pending.clear();
      void current.worker.terminate().catch(() => undefined);
    }, remaining);
    current.pending.set(id, { resolve, reject, timer });
    current.worker.ref();
    const serializable = { ...context, getRemainingTimeInMillis: undefined, getPayload: undefined };
    try {
      current.worker.postMessage({ id, exportName, event, context: serializable, deadline: Date.now() + remaining });
    } catch (error) {
      current.pending.delete(id);
      clearTimeout(timer);
      if (!current.pending.size) current.worker.unref();
      reject(error);
    }
  });
}

export async function disposeFunctionWorkers(directory: string): Promise<void> {
  await Promise.all([...workers].filter(([path]) => path.startsWith(directory + sep)).map(async ([path, instance]) => {
    workers.delete(path);
    await instance.worker.terminate();
  }));
}
