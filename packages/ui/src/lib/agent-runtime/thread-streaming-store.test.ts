import { afterEach, expect, it, vi } from 'vitest';
import { ThreadStreamingStore } from './thread-streaming-store';
import { shareSnapshot } from './structural-sharing';

afterEach(() => vi.unstubAllGlobals());
it('publishes losslessly once per frame, preserves unchanged tools and discards a retired frame', () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const store = new ThreadStreamingStore(), listener = vi.fn(), stop = store.subscribe(listener);
  store.publishTools([{ id: 'call', name: 'read_file', rawArguments: '{}', sequence: 1 }]);
  for (let i = 1; i <= 100; i++) store.publishProgress([{ type: 'text', text: 'x'.repeat(i) }]);
  expect(frames.size).toBe(1); expect(listener).not.toHaveBeenCalled();
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  flush(); expect(listener).toHaveBeenCalledOnce();
  const first = store.getSnapshot(); expect(first.progress).toEqual([{ type: 'text', text: 'x'.repeat(100) }]);
  store.publishProgress([{ type: 'text', text: 'x'.repeat(101) }]); flush();
  expect(store.getSnapshot().streamingTools).toBe(first.streamingTools);
  store.publishProgress([{ type: 'text', text: 'retired thread' }]); store.reset();
  expect(frames.size).toBe(0); expect(store.getSnapshot().progress).toEqual([]);
  stop();
});
it('retains child execution identities through directory reordering', () => {
  const old = { children: [{ operation_id: 'a', child_thread_id: 'child-a', state: 'running' }, { operation_id: 'b', child_thread_id: 'child-b', state: 'running' }] };
  const next = shareSnapshot(old, { children: [structuredClone(old.children[1]!), structuredClone(old.children[0]!)] });
  expect(next.children[0]).toBe(old.children[1]); expect(next.children[1]).toBe(old.children[0]);
});
