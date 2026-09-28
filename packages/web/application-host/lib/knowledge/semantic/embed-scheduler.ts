/**
 * Foreground query embeddings take the next free request slot ahead of queued
 * background batches. Work is not pre-queued for the whole repo.
 */

export type EmbedPriority = "foreground" | "background";

export function createEmbedScheduler(options: { concurrency?: number; backgroundIntervalMs?: number } = {}) {
  const maxConcurrent = options.concurrency ?? 1;
  const backgroundIntervalMs = options.backgroundIntervalMs ?? 0;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(backgroundIntervalMs) || backgroundIntervalMs < 0 || backgroundIntervalMs > 2_147_483_647) {
    throw new RangeError("Invalid embedding scheduler configuration");
  }
  let active = 0;
  let nextBackgroundAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const foreground: Array<() => void> = [];
  const background: Array<() => void> = [];

  const pump = (): void => {
    if (timer && foreground.length > 0) { clearTimeout(timer); timer = null; }
    while (active < maxConcurrent) {
      const foregroundTask = foreground.shift();
      let next = foregroundTask;
      if (!next && background.length > 0) {
        const waitMs = nextBackgroundAt - Date.now();
        if (waitMs > 0) {
          timer ??= setTimeout(() => { timer = null; pump(); }, waitMs);
          timer.unref();
          return;
        }
        next = background.shift();
        nextBackgroundAt = Date.now() + backgroundIntervalMs;
      }
      if (!next) return;
      active += 1;
      void Promise.resolve().then(next).catch(() => undefined).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  const enqueue = <T>(priority: EmbedPriority, work: () => Promise<T>): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      const run = (): Promise<void> => work().then(resolve, reject);
      (priority === "foreground" ? foreground : background).push(run);
      pump();
    })
  );

  return {
    enqueue,
    get foregroundQueued() { return foreground.length; },
    get backgroundQueued() { return background.length; },
    get busy() { return active > 0; },
    get maxConcurrent() { return maxConcurrent; },
  };
}

export type EmbedScheduler = ReturnType<typeof createEmbedScheduler>;
