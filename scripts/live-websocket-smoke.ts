import assert from "node:assert/strict";
import { websocketMessageText } from "./websocket-message.ts";

const source = process.argv[2] ?? process.env.VIBECLOUD_WEBSOCKET_URL;
if (!source) throw new Error("usage: pnpm acceptance:websocket -- <wss-url> (or set VIBECLOUD_WEBSOCKET_URL)");

const url = new URL(source);
if (url.protocol === "https:") url.protocol = "wss:";
if (url.protocol === "http:") url.protocol = "ws:";
assert.ok(["ws:", "wss:"].includes(url.protocol), "WebSocket URL must use ws, wss, http, or https");

const marker = `vibecloud-websocket-smoke-${crypto.randomUUID()}`;
const timeoutMilliseconds = Number(process.env.VIBECLOUD_WEBSOCKET_TIMEOUT_MS ?? 30_000);
const socket = new WebSocket(url);

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`WebSocket smoke timed out after ${timeoutMilliseconds} ms`)), timeoutMilliseconds);
  let matched = false;
  socket.addEventListener("open", () => socket.send(marker));
  socket.addEventListener("message", async (event) => {
    try {
      const response = JSON.parse(await websocketMessageText(event.data));
      assert.equal(response.ok, true);
      assert.equal(response.body, marker);
      assert.equal(typeof response.connectionId, "string");
      matched = true;
      socket.close(1000, "smoke-complete");
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error(`WebSocket connection failed: ${url}`));
  });
  socket.addEventListener("close", (event) => {
    clearTimeout(timeout);
    if (!matched) reject(new Error(`WebSocket closed before echo (${event.code}: ${event.reason})`));
    else resolve();
  });
});

console.log(`WebSocket lifecycle smoke passed: ${url}`);
