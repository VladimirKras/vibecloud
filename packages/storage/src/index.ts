import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredObject {
  key: string
  url: string
  contentType: string
  sizeBytes: number
}

export interface ObjectStorageOptions {
  bucket: string
  iamToken?: string
  environment?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}

/** Ordinary object URLs. Bucket access policy is declared separately in infrastructure. */
export function createObjectStorage(context: { token?: { access_token?: string } } = {}, options: ObjectStorageOptions) {
  const environment = options.environment ?? process.env;
  const bucket = options.bucket;
  if (!(environment.VIBECLOUD_STORAGE_DIRECTORY ? /^[a-z0-9][a-z0-9.-]{1,64}[a-z0-9]$/ : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).test(bucket)) throw new Error("Invalid Object Storage bucket name");
  return {
    async put(key: string, bytes: Uint8Array, { contentType, signal, cacheControl }: { contentType: string, signal?: AbortSignal, cacheControl?: string }): Promise<StoredObject> {
      if (!key || Buffer.byteLength(key) > 1024 || key.split("/").some((part) => !part || part === "." || part === "..") || (key.includes("\\") || [...key].some((char) => char.charCodeAt(0) < 32))) throw new Error("Invalid object key");
      if (!bytes.byteLength || !contentType || /[\r\n]/.test(contentType) || (cacheControl && /[\r\n]/.test(cacheControl))) throw new Error("Object bytes and content type are required");
      signal?.throwIfAborted();
      const path = [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
      const local = environment.VIBECLOUD_STORAGE_DIRECTORY;
      let url: string;
      if (local) {
        if (environment.VIBECLOUD_DEV_CONTAINER !== "1") throw new Error("Local object storage requires the Vibecloud development runtime");
        const base = environment.VIBECLOUD_STORAGE_URL;
        if (!base) throw new Error("Local object storage URL is missing");
        await mkdir(local, { recursive: true });
        const root = await realpath(local);
        const bucketDirectory = join(root, bucket);
        await mkdir(bucketDirectory, { recursive: true });
        if (await realpath(bucketDirectory) !== bucketDirectory) throw new Error("Local storage bucket must not be a symlink");
        const temporary = await mkdtemp(join(bucketDirectory, ".upload-"));
        try {
          await writeFile(join(temporary, "body"), bytes, { signal });
          await writeFile(join(temporary, "metadata.json"), JSON.stringify({ contentType, cacheControl }));
          signal?.throwIfAborted();
          await rename(temporary, join(bucketDirectory, createHash("sha256").update(key).digest("hex")));
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
        url = `${base.replace(/\/$/, "")}/${path}`;
      } else {
        const token = options.iamToken ?? context.token?.access_token ?? environment.YANDEX_CLOUD_IAM_TOKEN ?? environment.YC_TOKEN;
        if (!token) throw new Error("Object Storage requires the function IAM token or YANDEX_CLOUD_IAM_TOKEN");
        url = `https://storage.yandexcloud.net/${path}`;
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "PUT", redirect: "error", signal,
          headers: { "authorization": `Bearer ${token}`, "content-type": contentType, "if-none-match": "*", ...(cacheControl ? { "cache-control": cacheControl } : {}) },
          body: Uint8Array.from(bytes),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Object Storage upload failed (HTTP ${response.status})`);
      }
      return { key, url, contentType, sizeBytes: bytes.byteLength };
    },
  };
}
