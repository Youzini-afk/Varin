/** The existing material store can use a logical Thread-family namespace without
 * registering a file source or opening a Pi session. This Host-private service
 * grant is injected only into the original material owners, never a tool client. */
import { randomUUID } from 'node:crypto';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { KernelClient } from './kernel-client.js';
import { KernelStorageAdapter, KernelWorkingStateRootStore } from './storage-adapter.js';

const PREFIX = 'thread-materials:';
export const threadMaterialScope = (rootThreadId: string): string => `${PREFIX}${rootThreadId}`;

export function createMaterialStorageAccess(options: {
  kernel: KernelClient;
  storage: KernelStorageAdapter;
  legacy: WorkspaceWorkingStateRootAccess;
  onCleanupError?(error: unknown): void;
}): WorkspaceWorkingStateRootAccess {
  return {
    async withBranchStore(scopeId, purpose, consume, mode, actor) {
      if (!scopeId.startsWith(PREFIX)) return options.legacy.withBranchStore(scopeId, purpose, consume, mode, actor);
      if (!actor?.threadId || actor.sessionId || actor.runId
        || actor.executionWorkspace && actor.executionWorkspace !== scopeId) {
        throw new Error('Thread material storage requires its admitted Thread identity');
      }
      const grant = await options.kernel.issueGrant({
        grantId: `material:${randomUUID()}`, threadId: actor.threadId,
        owningWorkspace: scopeId, executionWorkspace: scopeId, pathScopes: [],
        // Maintenance bypasses actor filtering so the original material ACL can
        // interpret explicit grants/persisted collections. It does not authorize
        // writes: only the original mutation entrances receive storage.write.
        capabilities: ['storage.read', 'storage.maintenance',
          ...(['web-snapshot-put', 'material-collections-write'].includes(purpose) ? ['storage.write'] : [])],
      });
      try {
        const context = await options.storage.contextFromBranchGrant({ grant,
          owningWorkspaceId: scopeId, executionWorkspaceId: scopeId });
        // The original record/blob owner retains each real request until it settles.
        return await consume(new KernelWorkingStateRootStore(context), context);
      } finally {
        try { await options.kernel.revokeGrant(grant.grantId); }
        catch (error) {
          // Cleanup cannot erase an already returned atomic mutation receipt.
          // No retry of the mutation is authorized by a failed grant retirement.
          try {
            if (options.onCleanupError) options.onCleanupError(error);
            else console.error('[Materials] Original storage grant cleanup requires attention');
          } catch { /* Diagnostics cannot change the original committed result. */ }
        }
      }
    },
  };
}
