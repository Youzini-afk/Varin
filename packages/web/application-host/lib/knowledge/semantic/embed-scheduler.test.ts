import { describe, expect, it, vi } from 'vitest';
import { createEmbedScheduler, embedInScheduledBatches } from './embed-scheduler.js';
import { createHashEmbedder } from './embedder.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('embedding scheduler', () => {
  it('keeps local inference independent of busy HTTP slots and preserves varying adaptive grains', async () => {
    const scheduler = createEmbedScheduler();
    const gate = deferred();
    const remote = scheduler.enqueue('background', () => gate.promise);
    const embedder = createHashEmbedder();
    embedder.ownsScheduling = true;
    embedder.inferenceBatchSize = 4;
    embedder.batchByLength = true;
    embedder.countTokens = text => text.length;
    embedder.selectBatchSize = lengths => lengths[0]! > 20 ? 1 : Math.min(3, lengths.length);
    const texts = ['tiny', 'a much longer document that must remain whole', 'x', 'medium'];
    const original = await embedder.embed(texts);
    try {
      expect(await embedInScheduledBatches({ embedder, texts, scheduler, priority: 'foreground', purpose: 'query' })).toEqual(original);
    } finally { gate.resolve(); await remote; }
  });

  it('admits an interactive query during a large local index request and preserves every result', async () => {
    const scheduler = createEmbedScheduler();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[][] = [];
    const embedder = createHashEmbedder();
    embedder.inferenceBatchSize = 2;
    embedder.batchByLength = true;
    embedder.countTokens = text => text.length;
    const originalEmbed = embedder.embed;
    embedder.embed = async (texts) => {
      calls.push([...texts]);
      if (calls.length === 1) { firstStarted.resolve(); await releaseFirst.promise; }
      return originalEmbed(texts);
    };
    const documents = ['first document', 'second document', 'third document', 'fourth document', 'fifth document'];
    const background = embedInScheduledBatches({ embedder, texts: documents, scheduler,
      priority: 'background', purpose: 'document' });
    await firstStarted.promise;
    const query = embedInScheduledBatches({ embedder, texts: ['interactive query'], scheduler,
      priority: 'foreground', purpose: 'query' });
    releaseFirst.resolve();
    await query;
    expect(calls[1]).toEqual(['interactive query']);
    expect(await background).toEqual(await originalEmbed(documents));
    expect(calls.flat().filter(text => text !== 'interactive query').sort()).toEqual([...documents].sort());
  });

  it('stops cancelled local work between inference calls and releases the shared slot', async () => {
    const scheduler = createEmbedScheduler();
    const controller = new AbortController();
    const embedder = createHashEmbedder();
    embedder.inferenceBatchSize = 2;
    const originalEmbed = embedder.embed;
    const calls: string[][] = [];
    embedder.embed = async texts => {
      calls.push([...texts]);
      controller.abort(new Error('index cancelled'));
      return originalEmbed(texts);
    };
    await expect(embedInScheduledBatches({ embedder, texts: ['a', 'b', 'c', 'd'], scheduler,
      priority: 'background', purpose: 'document', signal: controller.signal })).rejects.toThrow('index cancelled');
    expect(calls).toEqual([['a', 'b']]);
    await expect(scheduler.enqueue('foreground', () => originalEmbed(['query']))).resolves.toHaveLength(1);
  });

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
