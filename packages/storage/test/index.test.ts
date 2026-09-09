import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObjectStorage } from "../src/index.ts";

test("cloud uploads raw bytes with IAM authorization and returns an unsigned URL", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 195, 40]);
  const storage = createObjectStorage({ token: { access_token: "function-token" } }, {
    bucket: "images-bucket", environment: {},
    fetch: async (url, request) => {
      assert.equal(url, "https://storage.yandexcloud.net/images-bucket/images/space%20here.png");
      assert.equal(request?.method, "PUT");
      const headers = new Headers(request?.headers);
      assert.equal(headers.get("authorization"), "Bearer function-token");
      assert.equal(headers.get("if-none-match"), "*");
      assert.deepEqual(request?.body, bytes);
      return new Response(null, { status: 200 });
    },
  });
  const result = await storage.put("images/space here.png", bytes, { contentType: "image/png" });
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(new URL(result.url).search, "");
});

test("local writes publish complete immutable bytes and clean failed attempts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibecloud-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createObjectStorage({}, {
    bucket: "vc-images", environment: { VIBECLOUD_DEV_CONTAINER: "1", VIBECLOUD_STORAGE_DIRECTORY: root, VIBECLOUD_STORAGE_URL: "/_vibecloud/media" },
  });
  const bytes = Buffer.from([0, 255, 128, 195, 40]);
  const object = await storage.put("images/scene.png", bytes, { contentType: "image/png" });
  assert.equal(object.url, "/_vibecloud/media/vc-images/images/scene.png");
  await assert.rejects(storage.put("images/scene.png", Buffer.from("replacement"), { contentType: "image/png" }));
  const files = await readdir(join(root, "vc-images"));
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(root, "vc-images", files[0], "body")), bytes);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(storage.put("cancelled", bytes, { contentType: "image/png", signal: controller.signal }), /abort/i);
  assert.equal((await readdir(join(root, "vc-images"))).length, 1);
});

test("invalid keys and unauthorized uploads fail without publishing", async () => {
  const storage = createObjectStorage({}, { bucket: "vc-images", environment: {} });
  for (const key of ["../escape", "a/../b", "a//b", "a\\b", "a\u0000b", "x".repeat(1025)]) {
    await assert.rejects(storage.put(key, Uint8Array.of(1), { contentType: "image/png" }), /Invalid object key/);
  }
  await assert.rejects(storage.put("ok", Uint8Array.of(1), { contentType: "image/png" }), /IAM token/);
});

test("local bucket symlinks cannot redirect writes outside storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vibecloud-storage-root-"));
  const outside = await mkdtemp(join(tmpdir(), "vibecloud-storage-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, join(root, "vc-images"));
  const storage = createObjectStorage({}, { bucket: "vc-images", environment: { VIBECLOUD_DEV_CONTAINER: "1", VIBECLOUD_STORAGE_DIRECTORY: root, VIBECLOUD_STORAGE_URL: "/media" } });
  await assert.rejects(storage.put("image", Uint8Array.of(1), { contentType: "image/png" }), /symlink/);
  assert.deepEqual(await readdir(outside), []);
});
