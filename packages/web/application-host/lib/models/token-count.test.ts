import { expect, it, vi } from 'vitest';
import { acquireTokenCounter } from './token-count.js';

function fixture() {
  let epoch: string | null = null;
  let opens = 0;
  const native = new Map<string, string>();
  const f = {
    beforeOpen: async () => {},
    disconnect: () => { epoch = null; native.clear(); },
    request: vi.fn(async (method: string, params: { leaseId?: string; texts?: string[] }) => {
      if (method === 'runtime.tokenizers.open') {
        await f.beforeOpen();
        epoch ??= `epoch-${++opens}`;
        const leaseId = `lease-${opens}`;
        native.set(leaseId, epoch);
        return { leaseId };
      }
      expect(native.get(params.leaseId!)).toBe(epoch);
      if (method === 'runtime.tokenizers.close') { native.delete(params.leaseId!); return null; }
      return { counts: params.texts!.map(text => [...text].length), tokenizer: 'fixture' };
    }),
  };
  const kernel = { get kernelEpoch() { return epoch; }, agentRuntimeRequest: f.request } as unknown as Parameters<typeof acquireTokenCounter>[0];
  return { ...f, kernel, setBeforeOpen: (work: typeof f.beforeOpen) => { f.beforeOpen = work; } };
}

it('binds after cold startup and shares exact-configuration reopening after native loss', async () => {
  const f = fixture(); const configuration = { model: 'original-model' };
  const counter = await acquireTokenCounter(f.kernel, configuration);
  configuration.model = 'edited-model';
  expect((await counter.count(['中文😀']))?.counts).toEqual([3]);
  f.disconnect();
  const results = await Promise.all([counter.count(['alpha']), counter.count(['beta'])]);
  expect(results.map(result => result.counts)).toEqual([[5], [4]]);
  expect(f.request.mock.calls.filter(([method]) => method === 'runtime.tokenizers.open')).toEqual([
    ['runtime.tokenizers.open', { configuration: { model: 'original-model' } }],
    ['runtime.tokenizers.open', { configuration: { model: 'original-model' } }],
  ]);
  await counter.release(); await counter.release();
  expect(f.request.mock.calls.filter(([method]) => method === 'runtime.tokenizers.close')).toEqual([
    ['runtime.tokenizers.close', { leaseId: 'lease-2' }],
  ]);
  await expect(counter.count(['late'])).rejects.toMatchObject({ code: 'tokenizer-lease-released' });
});

it('permits a later count to retry a failed reopen without replaying a failed count', async () => {
  const f = fixture(); const counter = await acquireTokenCounter(f.kernel, { model: 'model' });
  f.disconnect(); f.setBeforeOpen(async () => { throw new Error('kernel startup interrupted'); });
  await expect(counter.count(['original'])).rejects.toThrow('startup interrupted');
  f.setBeforeOpen(async () => {});
  expect((await counter.count(['retry'])).counts).toEqual([5]);
  expect(f.request.mock.calls.filter(([method]) => method === 'runtime.tokenizers.count')).toEqual([
    ['runtime.tokenizers.count', { leaseId: 'lease-2', texts: ['retry'] }],
  ]);
  await counter.release();
});

it('releases a reopening resource before a cancelled consumer can dispatch counting', async () => {
  const f = fixture(); const counter = await acquireTokenCounter(f.kernel, { model: 'model' });
  let admitted!: () => void; let resume!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  f.disconnect(); f.setBeforeOpen(async () => { admitted(); await hold; });
  const count = expect(counter.count(['cancelled'])).rejects.toMatchObject({ code: 'tokenizer-lease-released' });
  await entered;
  const released = counter.release(); resume();
  await Promise.all([count, released]);
  expect(f.request.mock.calls.some(([method]) => method === 'runtime.tokenizers.count')).toBe(false);
  expect(f.request.mock.calls.filter(([method]) => method === 'runtime.tokenizers.close')).toEqual([
    ['runtime.tokenizers.close', { leaseId: 'lease-2' }],
  ]);
});
