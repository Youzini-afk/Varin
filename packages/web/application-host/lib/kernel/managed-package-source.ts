/** Package capture recovery belongs to the original Source authority and Storage.
 * These records own cleanup addresses only, never an installation result or retry job. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseVarinExtensionPackagePath } from '@varin/extension-contract';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope } from '../harness/managed-remote-types.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelRecordResult, LaunchSource } from './protocol.generated.js';

const recordType = 'extension.package-capture';
const identityOf = (scope: ManagedSourceCleanupScope) => {
  if (!scope.operationId || scope.scope.kind !== 'run') throw new Error('Package capture requires its original source Operation');
  return { principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
    authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, scope: scope.scope,
    source: scope.source, operationId: scope.operationId };
};
const addresses = (identity: ReturnType<typeof identityOf>, captureId: string) => {
  const id = createHash('sha256').update(JSON.stringify([identity, captureId])).digest('hex');
  return { id, recordId: `${recordType}:${id}`, pinId: `extension-package-pin:${id}` };
};
interface CaptureOwner {
  id: string;
  workspaceId: string;
  identity: ReturnType<typeof identityOf>;
  captureId: string;
  packagePath: string;
}
const captureOwner = (record: KernelRecordResult): CaptureOwner => {
  const value = JSON.parse(record.payloadJson) as CaptureOwner;
  if (record.recordType !== recordType || !value?.identity || !value.captureId
    || value.workspaceId !== record.workspaceId || value.identity.source.workspace_id !== record.workspaceId
    || value.id !== addresses(value.identity, value.captureId).id || record.recordId !== `${recordType}:${value.id}`
    || parseVarinExtensionPackagePath(value.packagePath) !== value.packagePath) throw new Error('Original package capture identity changed');
  return value;
};

export function createManagedPackageSource(kernel: KernelClient) {
  return {
    /** Save before dispatching the deterministic pin, including a lost acquisition reply. */
    async capture(scope: ManagedSourceLocalScope, captureId: string, packagePath: string): Promise<{ pinId: string }> {
      if (!captureId) throw new Error('Package capture identity is required');
      const identity = identityOf({ ...scope, operationId: scope.grant.operationId ?? null });
      const original = addresses(identity, captureId);
      const scoped = kernel.scoped(scope.grant);
      if (await scoped.getRecord(scope.source.workspace_id, original.recordId)) {
        // Recovery releases the original capture; it never rereads a mutable package.
        throw new Error('Original package capture already exists');
      }
      const payload: CaptureOwner = { id: original.id, workspaceId: scope.source.workspace_id,
        identity, captureId, packagePath: parseVarinExtensionPackagePath(packagePath) };
      // Fixed source grants stay read-only. Persisting this Host-owned cleanup
      // address needs a separate record writer, with no source path authority.
      const writer = await kernel.issueGrant({ grantId: `extension-package-record:${randomUUID()}`,
        owningWorkspace: scope.source.workspace_id, executionWorkspace: scope.source.execution_workspace_id,
        threadId: identity.scope.threadId, runId: identity.scope.runId, operationId: identity.operationId,
        capabilities: ['storage.write'], pathScopes: [] });
      try {
        await kernel.scoped(writer).putRecord({ operationId: `extension-package-capture:${original.id}`, recordId: original.recordId,
          workspaceId: scope.source.workspace_id, recordType, state: 'capturing',
          threadId: identity.scope.threadId, runId: identity.scope.runId,
          payloadJson: JSON.stringify(payload), ownerIds: [], references: [] });
      } finally { await kernel.retireGrant(writer.grantId); }
      return { pinId: original.pinId };
    },
    async release(scope: ManagedSourceCleanupScope): Promise<void> {
      if (!scope.operationId || scope.scope.kind !== 'run') return;
      if (!kernel.isReady) throw new Error('Original package source storage is unavailable');
      const identity = identityOf(scope);
      // Maintenance of original addresses never re-admits the project or its cwd.
      const grant = await kernel.issueGrant({ grantId: `extension-package-cleanup:${randomUUID()}`,
        owningWorkspace: scope.source.workspace_id, executionWorkspace: scope.source.execution_workspace_id,
        threadId: scope.scope.threadId, runId: scope.scope.runId, operationId: scope.operationId,
        capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] });
      const scoped = kernel.scoped(grant);
      try {
        const owned: KernelRecordResult[] = [];
        let cursor: number | undefined;
        do {
          const page = await scoped.listRecords({ workspaceId: scope.source.workspace_id, recordType,
            threadId: scope.scope.threadId, runId: scope.scope.runId, ...(cursor === undefined ? {} : { cursor }) });
          // Finish enumeration before deletion, since cursors address the original list.
          owned.push(...page.records.filter(record => isDeepStrictEqual(captureOwner(record).identity, identity)));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        for (const record of owned) {
          const captured = captureOwner(record), original = addresses(identity, captured.captureId);
          if (scope.source.mode === 'fixed_branch') {
            const receipt = await scoped.unpinBranch({ operationId: `extension-package-unpin:${randomUUID()}`,
              branchId: scope.source.branch_id!, pinId: original.pinId });
            if (receipt.pinId !== original.pinId || receipt.branchId !== scope.source.branch_id || receipt.pinned !== false)
              throw new Error('Original package pin cleanup is unconfirmed');
          }
          await scoped.releaseRecord(`extension-package-capture-release:${randomUUID()}`, scope.source.workspace_id, original.recordId);
        }
        // The caller then retires the same source authority's grant. Storage
        // releases its temporary object owners, including undelivered captures.
      } finally { await kernel.retireGrant(grant.grantId); }
    },
  };
}

export interface ManagedPackageCleanup {
  kind: 'package_cleanup';
  operationId: string;
  runId: string;
  threadId: string;
  source: LaunchSource;
}
/** Called only by the private kernel bridge after original delivery/stop evidence. */
export async function releaseManagedPackageSource(client: ManagedSourceClient, coordinatorHostId: string,
  query: ManagedPackageCleanup): Promise<{ operationId: string; released: true }> {
  if (query.kind !== 'package_cleanup' || !query.operationId || !query.runId || !query.threadId
    || query.source.resource_owner.kind !== 'managed_host') throw new Error('Original package cleanup identity is incomplete');
  const authorities = await client.inspectScope({ coordinatorHostId, threadId: query.threadId, runId: query.runId });
  for (const authority of authorities) {
    if (authority.operationId !== query.operationId || authority.purpose !== 'source') continue;
    if (authority.scope.kind !== 'run' || authority.scope.threadId !== query.threadId || authority.scope.runId !== query.runId
      || !isDeepStrictEqual(authority.binding.source, query.source)) throw new Error('Original package source authority changed');
    if (authority.phase === 'retired' || authority.phase === 'revoked') continue;
    const result = await client.release({ coordinatorHostId, authorityId: authority.binding.authorityId,
      resourceEpoch: authority.binding.resourceEpoch, mode: 'retire' }) as { authorityId?: string; phase?: string };
    if (result?.authorityId !== authority.binding.authorityId || !['retired', 'revoked'].includes(result.phase ?? ''))
      throw new Error('Original package source cleanup remains pending');
  }
  return { operationId: query.operationId, released: true };
}
