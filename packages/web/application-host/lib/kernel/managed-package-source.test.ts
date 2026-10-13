import { expect, it, vi } from 'vitest';
import { createManagedPackageSource, releaseManagedPackageSource, type ManagedPackageCleanup } from './managed-package-source.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelRecordResult } from './protocol.generated.js';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope } from '../harness/managed-remote-types.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';

const source = { resource_owner: { kind: 'managed_host' as const, hostId: 'b', connectionId: 'connection-b', endpointIdentity: 'b-identity' },
  mode: 'fixed_branch' as const, workspace_id: 'workspace', execution_workspace_id: 'workspace',
  branch_id: 'branch', revision: 3, live_root: null };
const scope: ManagedSourceLocalScope = { principal: { principalId: 'principal-a', capabilities: ['filesystem:read'] }, coordinatorHostId: 'a',
  authorityId: 'authority', resourceEpoch: 'original-b-epoch', scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 },
  source, physicalRoot: null, grant: { grantId: 'original-grant', operationId: 'stage-operation',
    kernelEpoch: 'original-b-epoch', hostGeneration: 'original-b-generation', storageIdentity: '/b/storage',
    authorityInstanceId: null, workerId: null, workerGeneration: null, sessionId: null, threadId: 'thread', runId: 'run',
    owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] } };
const cleanup: ManagedSourceCleanupScope = { ...scope, operationId: 'stage-operation' };

function storage() {
  // Durable Storage is retained across replacement of every Host capture owner.
  const records = new Map<string, KernelRecordResult>();
  const pins = new Set<string>();
  let failUnpin = false;
  const scoped = {
    getRecord: vi.fn(async (_workspace: string, id: string) => records.get(id) ?? null),
    putRecord: vi.fn(async (input: Record<string, unknown>) => {
      const record = { ...input, recordRevision: 1 } as unknown as KernelRecordResult;
      records.set(record.recordId, record); return record;
    }),
    listRecords: vi.fn(async () => ({ records: [...records.values()], nextCursor: null })),
    unpinBranch: vi.fn(async ({ pinId, branchId }: { pinId: string; branchId: string }) => {
      if (failUnpin) { failUnpin = false; throw new Error('B temporary storage failure'); }
      return { pinId, branchId, pinned: false, released: pins.delete(pinId) };
    }),
    releaseRecord: vi.fn(async (_operation: string, _workspace: string, id: string) => { records.delete(id); }),
  };
  const kernel = { isReady: true, scoped: vi.fn(() => scoped),
    issueGrant: vi.fn(async (grant: unknown) => grant), retireGrant: vi.fn(async () => undefined) } as unknown as KernelClient;
  return { kernel, records, pins, scoped, failUnpin: () => { failUnpin = true; } };
}

it('releases only the recorded fixed capture pin after a complete Host owner replacement', async () => {
  const f = storage();
  let host = createManagedPackageSource(f.kernel);
  const first = await host.capture(scope, 'capture-one', 'package');
  const otherScope = { ...scope, authorityId: 'another-authority', grant: { ...scope.grant, operationId: 'another-operation' } };
  const other = await host.capture(otherScope, 'other-consumer', 'package');
  f.pins.add(first.pinId); f.pins.add(other.pinId); f.pins.add('unrelated-durable-handoff');
  // The original capture closure and packages map have both disappeared.
  host = createManagedPackageSource(f.kernel);
  f.failUnpin();
  await expect(host.release(cleanup)).rejects.toThrow('temporary storage failure');
  expect(f.records.size).toBe(2);
  expect(f.pins.has(first.pinId)).toBe(true);
  await host.release(cleanup);
  expect(f.pins).toEqual(new Set([other.pinId, 'unrelated-durable-handoff']));
  expect(f.records.size).toBe(1);
  await host.release(cleanup);
  expect(f.scoped.putRecord).toHaveBeenCalledTimes(2);
  expect(f.scoped.unpinBranch).toHaveBeenCalledTimes(2);
});

it('records the cleanup address before a pin reply can be lost and never recaptures it', async () => {
  const f = storage();
  const host = createManagedPackageSource(f.kernel);
  const captured = await host.capture(scope, 'lost-reply', '.');
  expect(f.records.size).toBe(1);
  f.pins.add(captured.pinId); // Native pin accepted; its acquisition reply was lost.
  await expect(createManagedPackageSource(f.kernel).capture(scope, 'lost-reply', '.')).rejects.toThrow('already exists');
  await createManagedPackageSource(f.kernel).release(cleanup);
  expect(f.pins.size).toBe(0); expect(f.records.size).toBe(0);
});

it('retries only the original stopped Operation authority after release fails before reaching B', async () => {
  const query: ManagedPackageCleanup = { kind: 'package_cleanup', operationId: 'stage-operation', runId: 'run', threadId: 'thread', source };
  const authority = { scope: scope.scope, phase: 'ready', purpose: 'source', operationId: query.operationId,
    binding: { authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, source } };
  let fail = true;
  const release = vi.fn(async () => {
    if (fail) { fail = false; throw new Error('release did not reach B'); }
    authority.phase = 'retired'; return { authorityId: scope.authorityId, phase: 'retired' };
  });
  const client = { inspectScope: vi.fn(async () => [
    { ...authority, purpose: 'integration', binding: { ...authority.binding, authorityId: 'integration' } },
    { ...authority, operationId: 'other-operation', binding: { ...authority.binding, authorityId: 'other' } }, authority,
  ]), release } as unknown as ManagedSourceClient;
  await expect(releaseManagedPackageSource(client, 'a', query)).rejects.toThrow('did not reach B');
  expect(await releaseManagedPackageSource(client, 'a', query)).toEqual({ operationId: query.operationId, released: true });
  await releaseManagedPackageSource(client, 'a', query);
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenLastCalledWith({ coordinatorHostId: 'a', authorityId: 'authority', resourceEpoch: 'original-b-epoch', mode: 'retire' });
});

it('refuses source identity drift or an unconfirmed retirement rather than declaring cleanup complete', async () => {
  const query: ManagedPackageCleanup = { kind: 'package_cleanup', operationId: 'stage-operation', runId: 'run', threadId: 'thread', source };
  const authority = { scope: scope.scope, phase: 'ready', purpose: 'source', operationId: query.operationId,
    binding: { authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, source: { ...source, revision: 4 } } };
  const release = vi.fn(async () => ({ authorityId: scope.authorityId, phase: 'ready' }));
  const client = { inspectScope: vi.fn(async () => [authority]), release } as unknown as ManagedSourceClient;
  await expect(releaseManagedPackageSource(client, 'a', query)).rejects.toThrow('authority changed');
  expect(release).not.toHaveBeenCalled();
  authority.binding.source.revision = 3;
  await expect(releaseManagedPackageSource(client, 'a', query)).rejects.toThrow('remains pending');
});
