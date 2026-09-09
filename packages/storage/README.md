# @vibecloud/storage

Server-side Object Storage uploads using the function's IAM token. Public media
uses ordinary URLs; this package does not create static keys, signed URLs,
database records, upload reservations, or checksum protocols.

```ts
import { createObjectStorage } from "@vibecloud/storage";

const storage = createObjectStorage(context, { bucket: process.env.IMAGES_BUCKET! });
const object = await storage.put(`images/${crypto.randomUUID()}.png`, imageBytes, {
  contentType: "image/png",
  signal,
});
// Return object.url and metadata through the application API.
```

Keys are immutable: an existing key is rejected. A public URL is an address,
not an access grant. Declare `buckets.images.public: true` for public media;
private buckets remain inaccessible anonymously and require an application-owned
authorized download flow. Signing is opt-in application behavior.

`pnpm dev` supplies persistent local storage and serves only declared public
buckets through the same URL contract. Local data is kept under `.vibecloud/media`.

[Yandex IAM-token uploads](https://yandex.cloud/en/docs/storage/api-ref/authentication)
