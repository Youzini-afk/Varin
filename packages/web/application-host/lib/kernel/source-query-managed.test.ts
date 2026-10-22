import { expect, it, vi } from 'vitest';
import { createSourceQueryOwner, type ManagedSourceQueryTransport, type SourceQueryAccess } from './source-query.js';
import { createManagedSourceConsumers } from './managed-source-consumers.js';
import { createLanguageOwner } from './language-owner.js';
import { resourceSource, resourceThreadSource } from './thread-context.js';
import type { LaunchSource } from './protocol.generated.js';

const resourceOwner = { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'configured-b', endpointIdentity: 'sha256-b' };
const source: LaunchSource = { resource_owner: resourceOwner, mode: 'fixed_branch', workspace_id: 'same-workspace', execution_workspace_id: 'same-workspace',
  branch_id: 'source-b', revision: 3, live_root: null };
const query: SourceQueryAccess = { runId: 'actual-run-a', threadId: 'thread-a', grantId: 'coordinator-binding', source, physicalRoot: null };
const local = new Proxy({}, { get(_value, key) { throw new Error(`The coordinator must not consult local ${String(key)}`); } });

it('routes the fixed target read, listing, path checks and original scope to B without opening same-named A resources', async () => {
  const calls: unknown[] = [];
  const service = vi.fn(async (selected: SourceQueryAccess, operation: { kind: string }) => {
    calls.push({ selected, operation });
    if (operation.kind === 'validate') return { pathScopes: ['allowed'] };
    if (operation.kind === 'routing_workspace') return '/same-folder';
    if (operation.kind === 'read') return { status: 'ready', content: 'ONLY B BYTES', revision: 'b-revision', source: 'working-branch' };
    if (operation.kind === 'compute') return { status: 'ready', records: [{ kind: 'entry', path: 'allowed/b.txt', revision: 'b-revision', data: { kind: 'file' } }] };
    return undefined;
  });
  const owner = createSourceQueryOwner({ kernel: local as never, documents: local as never, validateLiveSource: async () => { throw new Error('No A live source'); },
    remote: { service } as ManagedSourceQueryTransport });
  const active = new AbortController().signal;
  await owner.validate(query, active);
  expect(await owner.pathScopes(query, active)).toEqual(['allowed']);
  expect(await owner.read(query, 'allowed/b.txt', active)).toMatchObject({ content: 'ONLY B BYTES', revision: 'b-revision' });
  const onRecords = vi.fn();
  const result = await owner.compute(query, { operation: 'list', lane: 'foreground', paths: ['allowed'] }, { signal: active, collect: false, onRecords });
  expect(result.records).toEqual([]); expect(onRecords).toHaveBeenCalledWith([expect.objectContaining({ path: 'allowed/b.txt' })]);
  await owner.checkPath(query, 'allowed/b.txt', active);
  expect(await owner.routingWorkspace(query, active)).toBe('/same-folder');
  expect(calls).toHaveLength(6);
  expect(service.mock.calls.every(([selected]) => selected === query)).toBe(true);
  await expect(owner.prepareLanguageView(query, 'view', active)).rejects.toThrow('original target language owner');
});

it('dispatches language to the target owner and preserves its unavailable diagnosis without spawning A language processes', async () => {
  const service = vi.fn(async () => ({ status: 'unavailable' as const, items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, message: 'B has no configured provider' }));
  const owner = createLanguageOwner({ documents: local as never, supervisor: local as never, sources: local as never,
    remote: { service } as ManagedSourceQueryTransport });
  const result = await owner({ ...query, runId: 'actual-run-a', threadId: 'thread-a', grantId: 'coordinator-binding', method: 'definition', path: 'allowed/b.ts', line: 0, character: 1 }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'unavailable', message: 'B has no configured provider' });
  expect(service).toHaveBeenCalledWith(expect.objectContaining({ source }), { kind: 'language', query: { method: 'definition', path: 'allowed/b.ts', line: 0, character: 1 } }, expect.any(AbortSignal));
});

it('keeps a materialized source’s original execution owner through Context serialization', () => {
  const original: LaunchSource = { ...source, mode: 'materialized', environment_run_id: 'original-environment-run' };
  const restored = resourceThreadSource(original);
  expect(restored).toMatchObject({ resourceOwner, environmentRunId: 'original-environment-run' });
  expect(resourceSource(restored)).toEqual(original);
});

it('admits a prelaunch source with a readonly lifecycle before the actual Run binding exists', async () => {
  const bind = vi.fn(async (_input: unknown) => ({ authorityId: 'read-authority', resourceEpoch: 'b-epoch', source, physicalRoot: null }));
  const release = vi.fn(async () => ({}));
  const client = { bind, release, service: vi.fn(async () => ({ pathScopes: [''] })) };
  const withRunAuthority = vi.fn(async () => { throw new Error('No main Run binding exists yet'); });
  const consumers = createManagedSourceConsumers({ coordinatorHostId: () => 'host-a',
    registry: { source: async () => client } as never, withRunAuthority });
  await consumers.threads.admit(resourceThreadSource(source)!, { runtime: 'agent', threadId: 'thread-a', branchId: 'branch-a' }, 'new-run-a');
  expect(withRunAuthority).not.toHaveBeenCalled();
  expect(bind).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ kind: 'source_read', threadId: 'thread-a', branchId: 'branch-a' }), purpose: 'read', retention: 'caller' }));
  expect(bind.mock.calls[0]?.[0]).not.toHaveProperty('operationId');
  expect(release).toHaveBeenCalledWith({ coordinatorHostId: 'host-a', authorityId: 'read-authority', resourceEpoch: 'b-epoch', mode: 'retire' });
});
