import { captureStableSourceBaseline, type StableSourcePreparationOwners, type SourceCaptureDocuments } from '../harness/working-state/source-preparation.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LiveSourceOwner } from './live-source.js';
import { createHash } from 'node:crypto';
import type { ThreadIdentity, ThreadSource, ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';

interface SourcePreparationOwners {
  documents: SourceCaptureDocuments;
  prepareResources?: StableSourcePreparationOwners['prepareResources'];
  workingStates: WorkspaceWorkingStateRootAccess;
  liveSources?: LiveSourceOwner;
}

/** Preparation uses the existing Documents admission and immutable WorkingState owner.
 * The map only joins concurrent requests; the branch's fixed base is the durable receipt.
 */
export function createThreadSourcePreparer({ documents, workingStates, liveSources, prepareResources }: SourcePreparationOwners) {
  const preparing = new Map<string, Promise<ThreadPreparedSource>>();
  return async (input: ThreadPrepareSource): Promise<ThreadPreparedSource> => {
    const workspace = await documents.resolveWorkspace({ path: input.path });
    const { root } = await documents.inspectWorkspace(workspace.workspaceId);
    if (input.mode === 'live_root') {
      if (!liveSources) throw new Error('Live workspace access is unavailable');
      const liveRoot = await liveSources.prepare(workspace.workspaceId, workspace.workspaceId, input.threadId);
      return { path: root, source: { workspaceId: workspace.workspaceId, executionWorkspaceId: workspace.workspaceId,
        mode: 'live_root', liveRoot, tools: ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn', 'language_definition', 'language_references', 'language_diagnostics', 'code_retrieval'] } };
    }
    const mode = input.mode;
    const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, workspace.workspaceId, input.key, input.mode])).digest('hex');
    const current = preparing.get(key);
    if (current) return current;
    const preparation = workingStates.withBranchStore(workspace.workspaceId, 'source-prepare', async store => {
      const branchId = `source:${key}`;
      let branch = await store.getBranchRoot(branchId);
      if (!branch) {
        const captured = await captureStableSourceBaseline({ store, directory: root, workspaceId: workspace.workspaceId,
          captureWorkspaceId: workspace.workspaceId, branchId, captureScopes: [], content: { mode: 'saved-files' } },
        { documents, inspectInventory: async () => ({ kind: 'directory' }), ...(prepareResources ? { prepareResources } : {}) });
        branch = captured.branch;
      }
      // Branch creation durably publishes its immutable baseline at revision zero. Later retries
      // do not recapture a changed directory or substitute the branch's mutable write root.
      return { path: root, source: { workspaceId: workspace.workspaceId, executionWorkspaceId: workspace.workspaceId,
        branchId: branch.branchId, revision: 0, mode,
        tools: mode === 'fixed_branch' ? ['file_read', 'file_list', 'file_search'] : ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn'],
      } } satisfies ThreadPreparedSource;
    }, 'shared', { threadId: input.threadId });
    preparing.set(key, preparation);
    try { return await preparation; }
    finally { if (preparing.get(key) === preparation) preparing.delete(key); }
  };
}

/** Submission and every continuation re-admit the same Host source authority. */
export function createThreadSourceAdmission({ documents, workingStates, liveSources, runtime }: SourcePreparationOwners & { runtime: AgentRuntimeClient }) {
  return async (source: ThreadSource, identity: ThreadIdentity): Promise<void> => {
    if (source.mode === 'live_root') {
      if (!liveSources) throw new Error('Live workspace access is unavailable');
      await liveSources.admit(source, identity.threadId);
      return;
    }
    await documents.inspectWorkspace(source.workspaceId);
    await documents.inspectWorkspace(source.executionWorkspaceId);
    const child = await runtime.childForThread(identity.threadId);
    if (child) {
      if (child.source.kind !== 'ready' || child.source.selection.branch_id !== source.branchId
        || child.source.selection.revision !== source.revision || child.source.selection.mode !== source.mode) throw new Error('Child source differs from its admitted private baseline');
      const admittedPin = child.source.pin;
      await workingStates.withBranchStore(source.workspaceId, 'child-source-check', async store => {
        const pin = await store.pinBranch(source.branchId, { revision: source.revision });
        try { if (pin.root !== admittedPin.root) throw new Error('Child fixed source no longer matches its admitted root'); }
        finally { await pin.release(); }
      }, 'shared', { threadId: identity.threadId });
    }
  };
}
