import { createHash } from 'node:crypto';
import type { NativeThreadPrepareSource, NativeThreadPreparedSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';

interface SourcePreparationOwners {
  documents: {
    resolveWorkspace(input: { path: string }): Promise<{ workspaceId: string }>;
    inspectWorkspace(workspaceId: string): Promise<{ root: string }>;
  };
  workingStates: WorkspaceWorkingStateRootAccess;
}

/** Preparation uses the existing Documents admission and native immutable WorkingState owner.
 * The map only joins concurrent requests; the branch's fixed base is the durable receipt.
 */
export function createNativeThreadSourcePreparer({ documents, workingStates }: SourcePreparationOwners) {
  const preparing = new Map<string, Promise<NativeThreadPreparedSource>>();
  return async (input: NativeThreadPrepareSource): Promise<NativeThreadPreparedSource> => {
    const workspace = await documents.resolveWorkspace({ path: input.path });
    const { root } = await documents.inspectWorkspace(workspace.workspaceId);
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, workspace.workspaceId, input.key, input.mode])).digest('hex');
    const current = preparing.get(key);
    if (current) return current;
    const preparation = workingStates.withBranchStore(workspace.workspaceId, 'native-source-prepare', async store => {
      const branchId = `native-source:${key}`;
      let branch = await store.getBranchRoot(branchId);
      if (!branch) {
        const captured = await store.captureDirectory(root);
        branch = await store.createBranch(workspace.workspaceId, branchId, captured);
      }
      // Branch creation durably publishes its immutable baseline at revision zero. Later retries
      // do not recapture a changed directory or substitute the branch's mutable write root.
      return { path: root, source: { workspaceId: workspace.workspaceId, executionWorkspaceId: workspace.workspaceId,
        branchId: branch.branchId, revision: 0, mode: input.mode,
        tools: input.mode === 'fixed_branch' ? ['file_read', 'file_list', 'file_search'] : ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn'],
      } } satisfies NativeThreadPreparedSource;
    }, 'shared', { threadId: input.threadId });
    preparing.set(key, preparation);
    try { return await preparation; }
    finally { if (preparing.get(key) === preparation) preparing.delete(key); }
  };
}
