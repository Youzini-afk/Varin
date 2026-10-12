import { captureStableSourceBaseline, type StableSourcePreparationOwners, type SourceCaptureDocuments } from '../harness/working-state/source-preparation.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { ThreadResourceScopeOwners } from './thread-resource-scope.js';
import { SourceAdmissionError } from './source-admission-error.js';
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
        mode: 'live_root', liveRoot, tools: ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn', 'process_write', 'process_resize', 'language_definition', 'language_references', 'language_diagnostics', 'code_retrieval'] } };
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
        tools: mode === 'fixed_branch' ? ['file_read', 'file_list', 'file_search', 'code_retrieval'] : ['file_read', 'file_list', 'file_search', 'code_retrieval', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn', 'process_write', 'process_resize'],
      } } satisfies ThreadPreparedSource;
    }, 'shared', { threadId: input.threadId });
    preparing.set(key, preparation);
    try { return await preparation; }
    finally { if (preparing.get(key) === preparation) preparing.delete(key); }
  };
}

/** Submission and every continuation re-admit the same Host source authority. */
export function createThreadSourceAdmission({ documents, withSourceRead, liveSources, runtime }: {
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'>;
  withSourceRead: ThreadResourceScopeOwners['withSourceRead'];
  liveSources?: LiveSourceOwner;
  runtime: AgentRuntimeClient;
}) {
  return async (source: ThreadSource, identity: ThreadIdentity, runId?: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (source.mode === 'live_root') {
      if (!liveSources) throw new SourceAdmissionError('source_unavailable');
      await liveSources.admit(source, identity.threadId, signal);
      return;
    }
    const admitRegistrations = async () => {
      await documents.admitWorkspaceRegistration(source.workspaceId, signal);
      if (source.executionWorkspaceId !== source.workspaceId) await documents.admitWorkspaceRegistration(source.executionWorkspaceId, signal);
    };
    await admitRegistrations();
    const relation = await runtime.childForThread(identity.threadId, signal);
    const child = relation && runId ? await runtime.childExecutionForRun(runId, signal) : null;
    if (relation && (!runId || !child || child.child_thread_id !== identity.threadId || child.child_branch_id !== identity.branchId
      || child.source?.kind !== 'ready' || child.source.selection.workspace_id !== source.workspaceId
      || child.source.selection.execution_workspace_id !== source.executionWorkspaceId
      || child.source.selection.branch_id !== source.branchId || child.source.selection.revision !== source.revision
      || child.source.selection.mode !== source.mode)) throw new SourceAdmissionError('source_changed');
    await withSourceRead({ identity, source, paths: [''], ...(runId ? { runId } : {}), ...(signal ? { signal } : {}) }, async ({ pin }) => {
      if (pin.workspaceId !== source.workspaceId || pin.branchId !== source.branchId || pin.view !== 'revision'
        || pin.revision !== source.revision || child?.source?.kind === 'ready' && pin.root !== child.source.pin.root) {
        throw new SourceAdmissionError('source_changed');
      }
      await admitRegistrations();
    });
  };
}
