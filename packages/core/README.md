# @vibecloud/core

Dependency-free runtime utilities shared by Vibecloud packages and functions.

## Errors

```ts
import { errorFrom } from "@vibecloud/core";

try {
  await operation();
} catch (error) {
  throw errorFrom(error);
}
```

`errorFrom()` normalizes any thrown value into an `Error`. When errors contain
an `Error.cause` chain, its messages are included in the top-level message while
the original error remains available as `cause`. This keeps underlying failures
visible in runtimes that serialize only the top-level error.
