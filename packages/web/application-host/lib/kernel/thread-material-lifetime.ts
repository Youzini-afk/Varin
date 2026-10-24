import { createHash } from 'node:crypto';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { WebMaterialStore } from '../harness/web-materials.js';
import { createWorkspaceOpSerializer, kernelContext } from '../harness/kernel-records.js';
import { createMaterialLifecycle } from '../harness/material-lifecycle.js';
import { threadMaterialScope } from './material-storage.js';
import type { MaterialRetention } from './protocol.generated.js';

/** Native lineage selects references; the original material ACL admits them. The
 * recipient owns the retained grant, so deleting a parent cannot strand its child. */
export function createThreadMaterialLifetime(options: {
  runtime: Pick<AgentRuntimeClient, 'materialRetention'>;
  storage: WorkspaceWorkingStateRootAccess;
  materials: WebMaterialStore;
  releaseBrowser?(threadId: string): Promise<void>;
}) {
  const serial = createWorkspaceOpSerializer();
  const actorStorage = (threadId: string): WorkspaceWorkingStateRootAccess => ({
    withBranchStore: (scope, purpose, consume, mode) => options.storage.withBranchStore(scope, purpose, consume, mode, { threadId }),
  });
  const retain = async (plan: MaterialRetention, signal?: AbortSignal) => {
    for (const child of plan.inheritances) {
      const scope = threadMaterialScope(child.rootThreadId);
      for (const snapshotId of child.snapshotIds) {
        signal?.throwIfAborted();
        const recordId = `material.inheritance:${createHash('sha256').update(JSON.stringify([child.childThreadId, snapshotId])).digest('hex')}`;
        await kernelContext(actorStorage(child.childThreadId), scope, 'material-inheritance', async (_store, context) => {
          if ((await context.records.get(recordId))?.state === 'temporary') return;
          const source = await options.materials.read(scope, snapshotId,
            { kind: 'thread', owningWorkspaceId: scope, threadId: child.parentThreadId },
            { byteRange: { offset: 0, length: 0 }, ...(signal ? { signal } : {}) });
          if (!source) return; // A mention alone never confers access to another Thread's data.
          signal?.throwIfAborted();
          const references = [{ slot: 'body', objectHash: source.ref.contentHash },
            ...(source.ref.document?.source ? [{ slot: 'source', objectHash: source.ref.document.source.contentHash }] : [])];
          await context.records.put({ operationId: `retain:${recordId}`, recordId,
            recordType: 'material.inheritance', state: 'temporary', threadId: child.childThreadId,
            payloadJson: JSON.stringify({ fromThreadId: child.parentThreadId, toThreadId: child.childThreadId, snapshotIds: [snapshotId] }), references });
        });
      }
    }
  };
  return {
    releaseLateWrite: (scope: string, threadId: string) => serial.runSerialized('materials', () =>
      createMaterialLifecycle(actorStorage(threadId)).releaseThreadMaterials(scope, threadId)),
    prepareChild: (threadId: string, signal?: AbortSignal) => serial.runSerialized('materials', async () => {
      await retain(await options.runtime.materialRetention(threadId, signal), signal);
    }),
    releaseDeleted: (signal?: AbortSignal) => serial.runSerialized('materials', async () => {
      const plan = await options.runtime.materialRetention(undefined, signal);
      await retain(plan, signal);
      const scopes = new Map<string, string[]>();
      for (const thread of plan.threads) if (thread.release) {
        const owners = scopes.get(thread.rootThreadId) ?? [];
        owners.push(thread.threadId); scopes.set(thread.rootThreadId, owners);
      }
      for (const [root, deleted] of scopes) {
        signal?.throwIfAborted();
        await createMaterialLifecycle(actorStorage(deleted[0]!)).releaseThreadMaterials(threadMaterialScope(root), deleted);
        for (const threadId of deleted) await options.releaseBrowser?.(threadId);
      }
    }),
  };
}
