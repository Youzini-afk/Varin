import { describe, expect, it } from 'vitest';
import { createLocalCpuPolicy } from './local-cpu-policy.js';

describe('local CPU scheduling', () => {
  it('learns faster batches, respects padded lengths and keeps a whole long input', () => {
    const policy = createLocalCpuPolicy({ parallelism: 8, maxBatchSize: 32, maxTokens: 512,
      samplePressure: () => 0 });
    const lengths = new Array<number>(32).fill(512);
    const first = policy.selectBatchSize(lengths);
    for (let i = 0; i < 8; i++) policy.record({ lengths: [512, 512], durationMs: 4,
      cpuMs: 8, threads: 4, priority: 'background' });
    expect(policy.selectBatchSize(lengths)).toBeGreaterThan(first);
    expect(policy.selectBatchSize([2, 2, 512, 512])).toBeLessThanOrEqual(policy.selectBatchSize([2, 2, 2, 2]));
    expect(policy.selectBatchSize([100_000])).toBe(1);
  });

  it('backs off for other apps, changes threads only after stable pressure and cancels waits', async () => {
    let at = 0, pressure = 0;
    const policy = createLocalCpuPolicy({ parallelism: 8, maxBatchSize: 32, maxTokens: 512,
      samplePressure: () => pressure, now: () => at });
    expect(policy.initialThreads).toBe(4);
    policy.record({ lengths: [512], durationMs: 20, cpuMs: 80, threads: 4, loadMs: 1000, priority: 'background' });
    pressure = .75;
    policy.record({ lengths: [512], durationMs: 20, cpuMs: 80, threads: 4, priority: 'background' });
    expect(policy.snapshot().backgroundWaitMs).toBe(60);
    expect(policy.nextThreads('background')).toBe(4);
    at = 6000;
    expect(policy.nextThreads('foreground')).toBe(4);
    expect(policy.nextThreads('background')).toBe(4);
    at = 21000;
    expect(policy.nextThreads('background')).toBe(1);
    policy.record({ lengths: [512], durationMs: 20, cpuMs: 80, threads: 1, priority: 'background' });
    const controller = new AbortController();
    const waiting = policy.waitForBackground(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});
