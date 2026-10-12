/** The existing material store can use a logical Thread-family namespace without
 * registering a file source, opening a Pi session, or granting maintenance. */
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
        capabilities: purpose === 'web-snapshot-put' ? ['storage.read', 'storage.write'] : ['storage.read'],
      });
      try {
        const context = await options.storage.contextFromBranchGrant({ grant,
          owningWorkspaceId: scopeId, executionWorkspaceId: scopeId });
        // The original record/blob owner retains each real request until it settles.
        return await consume(new KernelWorkingStateRootStore(context), context);
      } finally {
        await options.kernel.revokeGrant(grant.grantId);
      }
    },
  };
}
