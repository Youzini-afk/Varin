/**
 * Foreground query embeddings take the next free request slot ahead of queued
 * background batches. Work is not pre-queued for the whole repo.
 */

import type { SemanticEmbedder, SemanticEmbedPurpose } from './embedder.js';

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

/** Schedule actual local inference calls rather than holding a request slot
 * across a whole repository. The next batch is admitted only after the current
 * one finishes, leaving queued foreground work a chance to take the slot. */
export async function embedInScheduledBatches(options: {
  embedder: SemanticEmbedder;
  texts: readonly string[];
  scheduler?: EmbedScheduler;
  priority: EmbedPriority;
  purpose: SemanticEmbedPurpose;
  signal?: AbortSignal;
}): Promise<number[][]> {
  const { embedder, texts, signal } = options;
  signal?.throwIfAborted();
  if (texts.length === 0) return [];
  const grain = embedder.inferenceBatchSize ?? texts.length;
  if (!Number.isSafeInteger(grain) || grain < 1) throw new RangeError('Invalid embedding inference grain');
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += grain) {
    signal?.throwIfAborted();
    const batch = texts.slice(offset, offset + grain);
    const work = async () => {
      signal?.throwIfAborted();
      return embedder.embed(batch, { purpose: options.purpose, ...(signal ? { signal } : {}) });
    };
    const rows = options.scheduler ? await options.scheduler.enqueue(options.priority, work) : await work();
    signal?.throwIfAborted();
    if (rows.length !== batch.length) throw new Error(`Semantic embedder returned ${rows.length} vectors for ${batch.length} chunks`);
    vectors.push(...rows);
  }
  return vectors;
}
