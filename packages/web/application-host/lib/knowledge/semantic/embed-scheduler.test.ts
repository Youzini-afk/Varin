import { describe, expect, it, vi } from 'vitest';
import { createEmbedScheduler } from './embed-scheduler.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('embedding scheduler', () => {
  it('spaces background starts without delaying foreground work', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createEmbedScheduler({ concurrency: 2, backgroundIntervalMs: 100 });
      const started: string[] = [];
      const first = scheduler.enqueue('background', async () => { started.push('background-1'); });
      const second = scheduler.enqueue('background', async () => { started.push('background-2'); });
      const foreground = scheduler.enqueue('foreground', async () => { started.push('foreground'); });
      await Promise.all([first, foreground]);
      expect(started).toEqual(['background-1', 'foreground']);
      await vi.advanceTimersByTimeAsync(99);
      expect(started).toEqual(['background-1', 'foreground']);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(started).toEqual(['background-1', 'foreground', 'background-2']);
    } finally { vi.useRealTimers(); }
  });

  it('honors configured parallelism without starting another batch before a slot frees', async () => {
    const scheduler = createEmbedScheduler({ concurrency: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const work = gates.map((gate, index) => scheduler.enqueue('background', async () => {
      started.push(index);
      await gate.promise;
      return index;
    }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[0]!.resolve();
    await work[0];
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.resolve();
    gates[2]!.resolve();
    expect(await Promise.all(work)).toEqual([0, 1, 2]);
  });
});
