/** Establish cleanup ownership immediately after each resource is constructed. */
export async function withResources<T>(work: (defer: (dispose: () => void | PromiseLike<void>) => void) => Promise<T>): Promise<T> {
  const cleanup: (() => void | PromiseLike<void>)[] = [];
  let primary: unknown;
  let failed = false;
  let result: T | undefined;
  try {
    result = await work((dispose) => cleanup.push(dispose));
  } catch (error) {
    failed = true;
    primary = error;
  }
  const failures: unknown[] = [];
  for (const dispose of cleanup.reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failed ? [primary, ...failures] : failures, "YDB resource cleanup failed", failed ? { cause: primary } : undefined);
  }
  if (failed) throw primary;
  return result as T;
}
