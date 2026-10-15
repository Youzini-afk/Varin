import { beforeEach, expect, it, vi } from 'vitest';
import type { VarinEvent } from './varinEvents';
const fixture = vi.hoisted(() => ({ host: 1, fetch: vi.fn(), events: undefined as ((event: VarinEvent) => void) | undefined }));
vi.mock('@varin/application-client', () => ({ runtimeFetch: fixture.fetch, getRuntimeEndpointGeneration: () => fixture.host }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => { fixture.events = listener; return () => { fixture.events = undefined; }; } }));
import { changeProjectTrust, getProjectTrustGeneration, readProjectTrust, subscribeProjectTrustChanges, type ProjectTrust } from './projectTrust';
const snapshot: ProjectTrust = { workspaceId: 'workspace:one', path: '/project/one', decision: null, directDecision: null, revision: 'original' };
const reply = (value = snapshot, ok = true) => ({ ok, json: async () => value });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { fixture.host += 1; fixture.fetch.mockReset().mockResolvedValue(reply()); });

it('awaits real confirmation and sends only the reviewed owner, root and revision', async () => {
  const confirmation = deferred<boolean>();
  const updating = changeProjectTrust(snapshot, true, { confirm: () => confirmation.promise, isCurrent: () => true });
  expect(fixture.fetch).not.toHaveBeenCalled();
  confirmation.resolve(true); await updating;
  expect(fixture.fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ workspaceId: snapshot.workspaceId, expectedPath: snapshot.path, expectedRevision: snapshot.revision, decision: true });
});

it.each(['cancel', 'project', 'host', 'invalidation'] as const)('retires an asynchronous confirmation after %s without any write', async reason => {
  const stop = subscribeProjectTrustChanges(() => {});
  const confirmation = deferred<boolean>(); let selected = true;
  const updating = changeProjectTrust(snapshot, true, { confirm: () => confirmation.promise, isCurrent: () => selected });
  if (reason === 'project') selected = false;
  if (reason === 'host') fixture.host += 1;
  if (reason === 'invalidation') fixture.events?.({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'revoked', ids: ['project-trust'] });
  confirmation.resolve(reason !== 'cancel');
  expect(await updating).toBeNull(); expect(fixture.fetch).not.toHaveBeenCalled(); stop();
});

it('invalidates cached grants after an uncertain save instead of assuming a failed response rolled back', async () => {
  const observer = vi.fn(); const stop = subscribeProjectTrustChanges(observer);
  fixture.fetch.mockRejectedValueOnce(new Error('response lost'));
  await expect(changeProjectTrust(snapshot, false, { confirm: async () => true, isCurrent: () => true })).rejects.toThrow('response lost');
  expect(observer).toHaveBeenCalledOnce(); stop();
});

it('rejects an in-flight read when trust changes or the Host is replaced', async () => {
  const stop = subscribeProjectTrustChanges(() => {});
  const response = deferred<ReturnType<typeof reply>>(); fixture.fetch.mockReturnValueOnce(response.promise);
  const reading = readProjectTrust(snapshot.workspaceId);
  fixture.events?.({ type: 'stream-ready' }); response.resolve(reply({ ...snapshot, decision: true }));
  await expect(reading).rejects.toThrow('changed while reading');
  const other = deferred<ReturnType<typeof reply>>(); fixture.fetch.mockReturnValueOnce(other.promise);
  const oldHost = readProjectTrust(snapshot.workspaceId); fixture.host += 1; other.resolve(reply());
  await expect(oldHost).rejects.toThrow('Application Host changed'); stop();
});

it('fails closed on a malformed or wrong-workspace response', async () => {
  fixture.fetch.mockResolvedValueOnce(reply({ ...snapshot, workspaceId: 'another' }));
  await expect(readProjectTrust(snapshot.workspaceId)).rejects.toThrow('Invalid project trust response');
  fixture.fetch.mockResolvedValueOnce(reply({ ...snapshot, decision: undefined } as unknown as ProjectTrust));
  await expect(readProjectTrust(snapshot.workspaceId)).rejects.toThrow('Invalid project trust response');
});

it('ignores unrelated configuration changes but invalidates after a stream reconnect', () => {
  const before = getProjectTrustGeneration(); const listener = vi.fn(); const stop = subscribeProjectTrustChanges(listener);
  fixture.events?.({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'models', ids: ['model-channels'] });
  expect(getProjectTrustGeneration()).toBe(before);
  fixture.events?.({ type: 'stream-ready' }); expect(listener).toHaveBeenCalledOnce(); stop();
});
