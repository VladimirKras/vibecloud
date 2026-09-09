import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ServerResponse } from "node:http";
import type { LoadedConfig } from "./config.ts";
import { localResourceNames } from "./local-identities.ts";

export const LOCAL_MEDIA_PREFIX = "/_vibecloud/media/";

/** The browser reads bytes directly; local public/private policy matches the bucket declaration. */
export async function serveLocalMedia(loaded: LoadedConfig, pathname: string, method: string, response: ServerResponse): Promise<boolean> {
  if (!pathname.startsWith(LOCAL_MEDIA_PREFIX)) return false;
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  try {
    const parts = pathname.slice(LOCAL_MEDIA_PREFIX.length).split("/").map(decodeURIComponent);
    const [bucket, ...key] = parts;
    const names = await localResourceNames(loaded.rootDirectory, "buckets", loaded.config.buckets);
    const publicBucket = Object.entries(names).some(([name, identity]) => identity === bucket && loaded.config.buckets?.[name]?.public === true);
    if (!publicBucket || !key.length
      || parts.some((part) => !part || part === "." || part === ".." || (part.includes("/") || part.includes("\\") || [...part].some((char) => char.charCodeAt(0) < 32)))) throw new Error("Not found");
    const root = await realpath(join(loaded.rootDirectory, ".vibecloud", "media"));
    const object = join(root, bucket, createHash("sha256").update(key.join("/")).digest("hex"));
    const path = await realpath(join(object, "body"));
    if (!path.startsWith(root + sep)) throw new Error("Not found");
    const metadataPath = await realpath(join(object, "metadata.json"));
    if (!metadataPath.startsWith(root + sep)) throw new Error("Not found");
    const { contentType, cacheControl } = JSON.parse(await readFile(metadataPath, "utf8"));
    response.writeHead(200, {
      "content-type": contentType, "content-length": (await stat(path)).size,
      "cache-control": cacheControl ?? "no-store", "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") response.end();
    else {
      const stream = createReadStream(path);
      response.once("close", () => stream.destroy());
      stream.once("error", (error) => response.destroy(error));
      stream.pipe(response);
    }
  } catch {
    if (!response.headersSent) response.writeHead(404).end("Not found");
    else response.destroy();
  }
  return true;
}
