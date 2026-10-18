import { expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadHistoryPage, ThreadHistoryRuns, ThreadRunUsage, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { ThreadHistoryWindow } from './thread-history';

const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch' };
const items: ThreadHistoryItem[] = Array.from({ length: 10 }, (_, n) => ({ id: `${n}`, parent: n ? `${n - 1}` : null, run_id: 'run', thread_id: 'thread', source: 'assistant', content: {}, provider: null }));
const snapshot = (from: number, through: number, eventCursor = through) => ({ identity, eventCursor, history: items.slice(from, through + 1), historyPage: { head: `${through}`, previous: from ? `${from}` : null } }) as ThreadSnapshot;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

const navigationAPI: Pick<ThreadsAPI, 'historyRuns' | 'historyRunPreview'> = { historyRuns: async (_identity, { headId }) => ({ head: headId, runs: [] }), historyRunPreview: async () => '' };

it('publishes bodies before usage, coalesces pages and joins prepends to a concurrently advancing live head', async () => {
  const earlier = deferred<ThreadHistoryPage>(), usage = deferred<ThreadRunUsage[]>();
  const api = { ...navigationAPI, historyPage: vi.fn(() => earlier.promise), historyUsage: vi.fn(() => usage.promise) };
  const view = new ThreadHistoryWindow(api, identity), close = view.subscribe(() => {});
  view.accept(snapshot(4, 5));
  expect(view.getSnapshot()).toMatchObject({ ready: true, head: '5', previous: '4' });
  const pending = view.loadEarlier();
  expect(view.loadEarlier()).toBe(pending);
  view.accept(snapshot(5, 6));
  earlier.resolve({ head: '5', previous: '2', items: items.slice(2, 4) });
  await pending;
  expect(api.historyPage).toHaveBeenCalledTimes(1);
  expect(api.historyPage.mock.calls[0]).toEqual([identity, { headId: '5', beforeId: '4' }, expect.any(AbortSignal)]);
  expect(view.getSnapshot().items.map(item => item.id)).toEqual(['2', '3', '4', '5', '6']);
  expect(view.getSnapshot()).toMatchObject({ head: '6', previous: '2', reset: 0 });
  usage.resolve([]); await tick(); close();
});

it('restores cached history, bridges an unseen tail, and removes the future on an authoritative rewind', async () => {
  const bridge = deferred<ThreadHistoryPage>();
  const api = { ...navigationAPI, historyPage: vi.fn(() => bridge.promise), historyUsage: vi.fn(async () => []) };
  const view = new ThreadHistoryWindow(api, identity);
  let close = view.subscribe(() => {});
  view.accept(snapshot(0, 4)); close();
  expect(view.getSnapshot().ready).toBe(true);
  close = view.subscribe(() => {}); view.accept(snapshot(8, 9));
  expect(view.getSnapshot().items.at(-1)?.id).toBe('4');
  expect(view.getSnapshot().connecting).toBe(true);
  bridge.resolve({ head: '9', previous: '5', items: items.slice(5, 8) });
  await view.loadEarlier();
  expect(view.getSnapshot().items.map(item => item.id)).toEqual(items.map(item => item.id));
  expect(view.getSnapshot().connecting).toBe(false);
  view.accept(snapshot(2, 3));
  expect(view.getSnapshot().items.map(item => item.id)).toEqual(['0', '1', '2', '3']);
  expect(view.getSnapshot().reset).toBe(1); close();
});

it('ignores reads completing after the view owner leaves and retries a failed page only on request', async () => {
  const late = deferred<ThreadHistoryPage>();
  const api = { ...navigationAPI, historyPage: vi.fn(() => late.promise), historyUsage: vi.fn(async () => []) };
  const view = new ThreadHistoryWindow(api, identity), close = view.subscribe(() => {});
  view.accept(snapshot(4, 5)); const pending = view.loadEarlier(); close();
  late.resolve({ head: '5', previous: null, items: items.slice(0, 4) }); await pending;
  expect(view.getSnapshot().items.map(item => item.id)).toEqual(['4', '5']);
  const leave = view.subscribe(() => {});
  api.historyPage.mockRejectedValueOnce(new Error('offline'));
  await view.loadEarlier(); await view.loadEarlier();
  expect(api.historyPage).toHaveBeenCalledTimes(2);
  expect(view.getSnapshot().error).toBe('offline');
  await view.loadEarlier(true);
  expect(view.getSnapshot().previous).toBeNull(); leave();
});

it('refreshes a Run ending while its usage read is pending, without accepting an older incomplete summary', async () => {
  const first = deferred<ThreadRunUsage[]>();
  const api = { ...navigationAPI, historyPage: vi.fn(), historyUsage: vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue([{ runId: 'run', throughId: '5', requests: [] }]) };
  const view = new ThreadHistoryWindow(api, identity), close = view.subscribe(() => {});
  view.accept(snapshot(4, 5)); view.accept(snapshot(4, 5, 100));
  first.resolve([]); await tick(); await tick(); await tick();
  expect(api.historyUsage).toHaveBeenCalledTimes(2);
  expect(view.getSnapshot().usage[0]?.throughId).toBe('5'); close();
});

it('keeps the complete Run index independent of loaded bodies and loads an unloaded navigation target', async () => {
  const index: ThreadHistoryRuns = { head: '5', runs: [{ runId: 'run', firstItemId: '0', lastItemId: '5' }] };
  const api = { ...navigationAPI, historyRuns: vi.fn(async () => index), historyUsage: vi.fn(async () => []),
    historyPage: vi.fn(async () => ({ head: '5', previous: null, items: items.slice(0, 4) })) };
  const view = new ThreadHistoryWindow(api, identity), close = view.subscribe(() => {});
  view.enableNavigation(true); view.accept(snapshot(4, 5));
  await tick(); await tick();
  const runs = view.getSnapshot().runs;
  expect(runs).toEqual(index.runs);
  expect(view.getSnapshot().items.map(item => item.id)).toEqual(['4', '5']);
  await view.ensureItem('0', new AbortController().signal);
  expect(api.historyPage).toHaveBeenCalledWith(identity, { headId: '5', beforeId: '4', limit: 256 }, expect.any(AbortSignal));
  expect(view.getSnapshot().runs).toBe(runs);
  expect(api.historyRuns).toHaveBeenCalledTimes(1);
  const next = snapshot(4, 5); next.activeRun = { id: 'next' } as NonNullable<ThreadSnapshot['activeRun']>;
  view.accept(next);
  expect(view.getSnapshot().runs.map(run => run.runId)).toEqual(['run', 'next']);
  close();
});
