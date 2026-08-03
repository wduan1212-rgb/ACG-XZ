export interface ConcurrentQueueOptions {
  limit?: number;
  onStart?: (index: number, active: number) => void;
  onSettled?: (index: number, active: number) => void;
}

/**
 * Run independent jobs with a hard client-side concurrency ceiling.
 *
 * Results retain the input order while each worker can progressively update
 * its own placeholder as soon as it finishes. A rejected job is isolated and
 * never prevents the remaining queue from draining.
 */
export async function runConcurrentQueue<T>(
  jobs: Array<() => Promise<T>>,
  options: ConcurrentQueueOptions = {},
): Promise<PromiseSettledResult<T>[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? 3));
  const results: PromiseSettledResult<T>[] = new Array(jobs.length);
  let cursor = 0;
  let active = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      active += 1;
      options.onStart?.(index, active);
      try {
        results[index] = { status: "fulfilled", value: await jobs[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        active -= 1;
        options.onSettled?.(index, active);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
  );
  return results;
}
