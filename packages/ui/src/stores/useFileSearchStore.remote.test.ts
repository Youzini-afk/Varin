import { beforeEach, expect, it, vi } from 'vitest';
import type { ResourceFileLocation } from '@varin/application-client';
const mocks = vi.hoisted(() => ({ request: vi.fn(), local: vi.fn() }));
vi.mock('@varin/application-client', async importOriginal => ({ ...await importOriginal<typeof import('@varin/application-client')>(), createResourceFilesHttpAPI: () => ({ request: mocks.request }) }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ files: { search: mocks.local } }) }));
import { useFileSearchStore } from './useFileSearchStore';
const location = (hostId: string): ResourceFileLocation => ({ resourceOwner: { kind: 'managed_host', hostId, connectionId: `pair-${hostId}`, endpointIdentity: `endpoint-${hostId}` }, workspaceId: 'same-documents-id', root: '/same/path' });
beforeEach(() => { mocks.request.mockReset(); mocks.local.mockReset(); useFileSearchStore.getState().resetForRuntimeSwitch(); });
it('recurses through the target owner, isolates identical paths and retains incomplete status', async () => {
  mocks.request.mockImplementation(async input => ({ kind: 'filename-search', enumerationStatus: input.resourceOwner.hostId === 'a' ? 'incomplete' : 'complete', results: [{ path: `deep/${input.resourceOwner.hostId}.ts` }] }));
  const a = await useFileSearchStore.getState().searchFiles('/same/path', 'ts', Infinity, { location: location('a') });
  const b = await useFileSearchStore.getState().searchFiles('/same/path', 'ts', Infinity, { location: location('b') });
  expect(a[0].path).toBe('/same/path/deep/a.ts'); expect(a.incomplete).toBe(true);
  expect(b[0].path).toBe('/same/path/deep/b.ts'); expect(b.incomplete).toBeUndefined();
  expect(mocks.request.mock.calls[0][0].command).not.toHaveProperty('maxResults');
  await useFileSearchStore.getState().searchFiles('/same/path', 'ts', Infinity, { location: location('a') });
  expect(mocks.request).toHaveBeenCalledTimes(2); expect(mocks.local).not.toHaveBeenCalled();
});
it('does not share a caller cancellation or cache a late aborted response', async () => {
  const pending: Array<(value: unknown) => void> = [];
  mocks.request.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const first = new AbortController(), second = new AbortController();
  const a = useFileSearchStore.getState().searchFiles('/same/path', 'ts', 60, { location: location('a'), signal: first.signal });
  const failed = expect(a).rejects.toMatchObject({ name: 'AbortError' });
  first.abort();
  const b = useFileSearchStore.getState().searchFiles('/same/path', 'ts', 60, { location: location('a'), signal: second.signal });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  pending[0]({ kind: 'filename-search', enumerationStatus: 'complete', results: [{ path: 'old.ts' }] });
  pending[1]({ kind: 'filename-search', enumerationStatus: 'complete', results: [{ path: 'new.ts' }] });
  await failed; expect((await b)[0].name).toBe('new.ts');
  expect(Object.values(useFileSearchStore.getState().cache)[0].files[0].name).toBe('new.ts');
});
it('never falls back to coordinator search on target failure', async () => {
  mocks.request.mockRejectedValue(new Error('Target offline'));
  await expect(useFileSearchStore.getState().searchFiles('/same/path', 'ts', 60, { location: location('a') })).rejects.toThrow('Target offline');
  expect(mocks.local).not.toHaveBeenCalled(); expect(useFileSearchStore.getState().cache).toEqual({});
});

it.each(['failed', 'cancelled'])('does not publish a %s enumeration as cached success', async status => {
  mocks.request.mockResolvedValue({ kind: 'filename-search', enumerationStatus: status, results: [{ path: 'partial.ts' }] });
  await expect(useFileSearchStore.getState().searchFiles('/same/path', 'ts', Infinity, { location: location('a') })).rejects.toThrow();
  expect(useFileSearchStore.getState().cache).toEqual({});
});
