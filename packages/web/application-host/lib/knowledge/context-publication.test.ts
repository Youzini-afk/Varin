import { expect, it, vi } from 'vitest';
import { createContextObservationPublication } from './context-publication.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ContextObservationImport, ContextObservationSource } from '../kernel/protocol.generated.js';
import type { KnowledgeStore, StoredEvent } from './store.js';
const owner = (id = 'original'): ContextObservationSource => ({ threadId: `thread:${id}`, branchId: `branch:${id}`, runId: id, anchorId: `input:${id}`, epoch: 1,
  source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: id, execution_workspace_id: id, branch_id: null, revision: null,
    live_root: { hostId: 'host', rootId: id, canonicalRoot: `/workspace/${id}` } } });
const event = (id: number, source = owner()): StoredEvent => ({ id, kind: 'edit', at: id, text: `old exact rendered text ${id}`, source: 'user', sessionId: source.runId });
const imported = (page: ContextObservationImport) => ({ throughId: page.throughId,
  receipts: page.events.map(item => ({ id: `observation:${page.owner.runId}:${item.id}`, cursor: item.id, state: 'queued' })) });
const kernel = (request: unknown) => ({ agentRuntimeRequest: request } as Pick<KernelClient, 'agentRuntimeRequest'>);
const store = (events: StoredEvent[]) => ({ listEvents: vi.fn(async (query: Parameters<KnowledgeStore['listEvents']>[0]) =>
  events.filter(item => item.sessionId === query.sessionId && item.id > (query.afterId ?? 0)).slice(0, query.limit)) });

it('imports bounded original journal pages and resumes from the durable native prefix after restart', async () => {
  const original = owner(), rows = Array.from({ length: 70 }, (_, index) => event(index + 1)), legacy = store(rows);
  rows[1]!.source = 'agent'; rows[2]!.kind = 'command'; rows[2]!.text = 'original old command renderer'; rows[2]!.data = { command: 'raw old command', extra: 'unchanged' };
  let throughId = 0;
  const request = vi.fn(async (method: string, page: ContextObservationImport) => {
    if (method.endsWith('importSources')) return [original];
    if (method.endsWith('importPosition')) return { throughId };
    throughId = page.throughId; return imported(page);
  });
  let publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await publication.close();
  const pages = request.mock.calls.filter(([method]) => method.endsWith('.import')).map(([, page]) => page);
  expect(pages.map(page => [page.afterId, page.throughId])).toEqual([[0, 32], [32, 64], [64, 70]]);
  expect(pages[0]?.events.find(item => item.id === 3)).toEqual({ id: 3, kind: 'command', at: 3, source: 'user', text: 'original old command renderer', data: { command: 'raw old command', extra: 'unchanged' } });
  expect(pages[0]?.events.some(item => item.id === 2)).toBe(false);
  expect(legacy.listEvents.mock.calls.map(([query]) => [query.afterId, query.limit])).toEqual([[0, 32], [32, 32], [64, 32], [70, 32]]);
  publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await publication.close();
  expect(legacy.listEvents.mock.lastCall?.[0]).toMatchObject({ afterId: 70, limit: 32 });
  expect(request.mock.calls.filter(([method]) => method.endsWith('.import'))).toHaveLength(3);
});

it('coalesces recovery wakes into one source query and one source-owned in-flight page', async () => {
  const legacy = store([event(1)]); let release!: (value: unknown) => void;
  const held = new Promise(resolve => { release = resolve; });
  const request = vi.fn(async (method: string) => method.endsWith('importSources') ? [owner()] : method.endsWith('importPosition') ? { throughId: 0 } : held);
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await Promise.all(Array.from({ length: 20 }, () => publication.recover()));
  await vi.waitFor(() => expect(legacy.listEvents).toHaveBeenCalledOnce());
  expect(request.mock.calls.filter(([method]) => method.endsWith('importSources'))).toHaveLength(1);
  let closed = false; const closing = publication.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  release({ throughId: 1, receipts: [{ id: 'observation:original:1', cursor: 1, state: 'queued' }] });
  await closing; expect(publication.inspect()[0]).toMatchObject({ throughId: 1, state: 'ready' });
});

it('recovers a lost import acknowledgement from the durable original position without republishing', async () => {
  const legacy = store([event(1)]); let committed = 0;
  const request = vi.fn(async (method: string, page: ContextObservationImport) => {
    if (method.endsWith('importSources')) return [owner()]; if (method.endsWith('importPosition')) return { throughId: committed };
    committed = page.throughId; throw new Error('lost acknowledgement');
  });
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await vi.waitFor(() => expect(publication.inspect()[0]?.state).toBe('unknown'));
  await publication.recover(); await publication.close();
  expect(publication.inspect()[0]).toMatchObject({ throughId: 1, state: 'ready' });
  expect(request.mock.calls.filter(([method]) => method.endsWith('.import'))).toHaveLength(1);
});

it('looks up an uncommitted prefix then retries only the frozen original page, not a new legacy render', async () => {
  const rows = [event(1)], legacy = store(rows); let currentOwner = owner(), first = true;
  const request = vi.fn(async (method: string, page: ContextObservationImport) => {
    if (method.endsWith('importSources')) return [currentOwner]; if (method.endsWith('importPosition')) return { throughId: 0 };
    if (first) { first = false; throw new Error('lost before commit'); } return imported(page);
  });
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await vi.waitFor(() => expect(publication.inspect()[0]?.state).toBe('unknown'));
  rows[0]!.text = 'changed afterwards'; currentOwner = { ...owner(), epoch: 2 };
  await publication.recover(); await publication.close();
  const pages = request.mock.calls.filter(([method]) => method.endsWith('.import')).map(([, page]) => page);
  expect(pages).toHaveLength(2); expect(pages[1]?.events[0]?.text).toBe('old exact rendered text 1');
  expect(pages[1]?.owner).toEqual(currentOwner);
  expect(request.mock.calls.filter(([method]) => method.endsWith('importPosition'))).toHaveLength(2);
  expect(legacy.listEvents.mock.calls.map(([query]) => query.afterId)).toEqual([0, 1]);
});

it('isolates a corrupt old workspace journal and retries it without blocking a healthy source', async () => {
  const bad = owner('bad'), healthy = owner('healthy'), failure = Object.assign(new Error('checkpoint unavailable'), { code: 'TDB_CORRUPTED_FILE' });
  const healthyStore = store([event(1, healthy)]), oldStore = store([event(1, bad)]), warning = vi.fn(); let corrupt = true;
  const positions = new Map<string, number>();
  const request = vi.fn(async (method: string, page: ContextObservationImport) => {
    if (method.endsWith('importSources')) return [bad, healthy]; if (method.endsWith('importPosition')) return { throughId: positions.get(page.owner.runId) ?? 0 };
    positions.set(page.owner.runId, page.throughId); return imported(page);
  });
  const publication = createContextObservationPublication(kernel(request), {
    getLegacyStore: async workspace => { if (workspace === 'bad') { if (corrupt) throw failure; return oldStore; } return healthyStore; }, onUnavailable: warning,
  });
  await publication.recover(); await vi.waitFor(() => expect(publication.inspect().map(source => source.state)).toContain('unavailable'));
  await publication.recover(); await vi.waitFor(() => expect(publication.inspect().find(source => source.owner.runId === 'healthy')?.state).toBe('ready'));
  expect(warning).toHaveBeenCalledOnce(); expect(warning.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'bad', reason: 'corrupt', cause: failure });
  corrupt = false; await publication.recover(); await publication.close();
  expect(publication.inspect().every(source => source.state === 'ready')).toBe(true);
});

it('does not create a missing legacy journal or admit an empty replacement', async () => {
  const request = vi.fn(async (method: string) => method.endsWith('importSources') ? [owner()] : { throughId: 0 });
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => null });
  await publication.recover(); await publication.close();
  expect(request.mock.calls.map(([method]) => method)).toEqual(['runtime.context.observations.importSources', 'runtime.context.observations.importPosition']);
  expect(publication.inspect()[0]?.state).toBe('ready');
});

it('discovers an unimported ancestor Run A after same-source successor B without treating A as a live capture target', async () => {
  const a = owner('run:a'), b = { ...owner('run:b'), threadId: a.threadId, branchId: a.branchId, source: a.source };
  const legacy = store([event(1, a)]), requests: string[] = [];
  const request = async (method: string, page: ContextObservationImport) => {
    requests.push(method);
    if (method.endsWith('sources')) return [b];
    if (method.endsWith('importSources')) return [b, a];
    if (method.endsWith('importPosition')) return { throughId: 0 };
    return imported(page);
  };
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await publication.close();
  expect(publication.inspect().find(source => source.owner.runId === a.runId)).toMatchObject({ throughId: 1, state: 'ready' });
  expect(requests).not.toContain('runtime.context.observations.sources');
});

it('does not reread a completed read-only legacy prefix on subsequent model-boundary wakes', async () => {
  const legacy = store([event(1)]);
  const request = async (method: string, page: ContextObservationImport) => method.endsWith('importSources') ? [owner()]
    : method.endsWith('importPosition') ? { throughId: 0 } : imported(page);
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  await publication.recover(); await vi.waitFor(() => expect(publication.inspect()[0]?.state).toBe('ready'));
  expect(legacy.listEvents).toHaveBeenCalledTimes(2);
  await publication.recover(); await publication.recover(); await publication.close();
  expect(legacy.listEvents).toHaveBeenCalledTimes(2);
});

it('uses already trusted preparation owners for a bounded wake without another all-branch source scan', async () => {
  const legacy = store([event(1)]);
  const request = vi.fn(async (method: string, page: ContextObservationImport) => method.endsWith('importPosition') ? { throughId: 0 } : imported(page));
  const publication = createContextObservationPublication(kernel(request), { getLegacyStore: async () => legacy });
  publication.wake([owner()]); await publication.close();
  expect(request.mock.calls.map(([method]) => method)).toEqual(['runtime.context.observations.importPosition', 'runtime.context.observations.import']);
});
