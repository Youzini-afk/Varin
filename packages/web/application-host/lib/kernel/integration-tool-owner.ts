/** Ordinary tool entry into the existing Integration authority. No Pi session or second journal. */
import type { JsonValue } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchIntent, LaunchSource } from './protocol.generated.js';
import type { IntegrationCoordinator, IntegrationPlanInput, IntegrationOperationReceipt } from '../harness/working-state/integration-coordinator.js';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import { runToolDomainEffect, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { admitRunSourceAuthority, sourceToolSchemas, type SourceLaunch } from './source-launch.js';
import { KernelWorkingStateRootStore } from './storage-adapter.js';
import { createScopedKernelRecoveryBindings } from './kernel-recovery-store.js';
import { UnconfirmedIntegrationCommitError } from '../recovery/durable-file-operation.js';

export const CHILD_INTEGRATION_CAPABILITY = 'collaboration.integrations';
export interface IntegrationTargetScope {
  directory: string;
  documentWorkspaceId: string;
  workingStates: WorkspaceWorkingStateRootAccess;
  release(): Promise<void>;
}
export interface IntegrationToolOwnerOptions {
  runtime: Pick<AgentRuntimeClient, 'run' | 'launch' | 'child'>;
  coordinator: Pick<IntegrationCoordinator, 'mergeResult' | 'inspectIntegration'>;
  onCleanupError(operationId: string, error: unknown): void;
  /** Re-admit the original physical source and bind actual file/journal ports to its fresh grant. */
  openTarget(authority: ToolInvocationAuthority, launch: LaunchIntent, signal: AbortSignal): Promise<IntegrationTargetScope>;
}
function readInput(value: JsonValue): { childOperationId: string; publicationId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['childOperationId', 'publicationId'].includes(key))
    || typeof value.childOperationId !== 'string' || !value.childOperationId.trim()
    || typeof value.publicationId !== 'string' || !value.publicationId.trim()) {
    throw new Error('Child integration requires its original child and fixed publication identities');
  }
  return { childOperationId: value.childOperationId, publicationId: value.publicationId };
}
const completion = (result: IntegrationOperationReceipt): ToolExecutionReceipt => {
  if (!result.receipt || !result.effect || typeof result.executorStopped !== 'boolean' || result.recoveryCoverage !== 'files-only') {
    throw new Error('Integration did not return its original journal evidence');
  }
  return { completion: { kind: 'result',
    outcome: result.effect === 'unknown' || result.status === 'needs-attention' ? 'indeterminate' : result.status === 'applied' ? 'succeeded' : 'failed',
    effect: result.effect, content: result }, executor_stopped: result.executorStopped };
};
export function createIntegrationToolOwner(options: IntegrationToolOwnerOptions): HostCapabilityHandler {
  return async (method, params, context) => {
    if (method !== 'apply') throw new Error(`Unknown child integration method: ${method}`);
    const input = readInput(params);
    return runToolDomainEffect(context, { domain: CHILD_INTEGRATION_CAPABILITY, toolName: 'integrate_child', arguments: params }, async authority => {
      let target: IntegrationTargetScope | undefined;
      let admitted: IntegrationPlanInput & { operationId: string } | undefined;
      let enteredCoordinator = false;
      try {
        const [run, launch, child] = await Promise.all([
          options.runtime.run(authority.runId, context.signal),
          options.runtime.launch(authority.runId, context.signal),
          options.runtime.child(input.childOperationId, context.signal),
        ]);
        if (run.thread_id !== authority.threadId || !launch || !authority.source
          || !launch.selection.source || authority.source.mode === 'fixed_branch'
          || child.parent_thread_id !== authority.threadId || child.parent_branch_id !== run.branch_id
          || child.code_result.kind !== 'published' || child.code_result.result.publication_id !== input.publicationId
          || child.code_result.result.workspace_id !== authority.source.workspace_id) {
          throw new Error('Fixed child result is unavailable for this parent source');
        }
        context.signal.throwIfAborted();
        target = await options.openTarget(authority, launch, context.signal);
        const result = child.code_result.result;
        const operationBinding = { kind: 'runtime_operation' as const, operationId: authority.operationId,
          parentRunId: authority.runId, parentThreadId: authority.threadId, parentBranchId: run.branch_id,
          origin: authority.origin, callId: authority.origin.kind === 'policy_action' ? authority.origin.node_id : authority.operationId.slice(`${authority.origin.request_id}:tool:`.length),
          childOperationId: child.operation_id, childThreadId: child.child_thread_id,
          result: { workspaceId: result.workspace_id, branchId: result.branch_id, resultRevision: result.result_revision,
            root: result.root, publicationId: result.publication_id }, target: authority.source as LaunchSource };
        admitted = { operationId: `integration:${authority.operationId}`, workspaceId: result.workspace_id,
          threadId: child.child_thread_id, branchId: result.branch_id, resultRevision: result.result_revision,
          operationBinding, scopedWorkingStates: target.workingStates, signal: context.signal,
          parentAuthority: { kind: 'directory', directory: target.directory, workspaceId: target.documentWorkspaceId } };
        context.signal.throwIfAborted();
        enteredCoordinator = true;
        return completion(await options.coordinator.mergeResult(admitted));
      } catch (error) {
        if (enteredCoordinator && admitted) {
          // A failed response may have followed the original journal's successful terminal commit.
          try {
            const inspection = { ...admitted };
            delete inspection.signal;
            const original = await options.coordinator.inspectIntegration(inspection);
            if (original) return completion(original);
          } catch { /* Preserve unknown rather than inventing rollback or replay. */ }
          return { completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
            content: { status: 'needs-attention', operationId: admitted.operationId, error: error instanceof Error ? error.message : String(error) } }, executor_stopped: error instanceof UnconfirmedIntegrationCommitError && error.executorStopped };
        }
        return { completion: { kind: 'result', outcome: 'failed', effect: 'none',
          content: { status: 'rejected', error: error instanceof Error ? error.message : String(error) } }, executor_stopped: true };
      } finally {
        try { await target?.release(); }
        catch (error) {
          // The original Run still retains a failed grant cleanup. Cleanup transport failure
          // cannot replace an already obtained domain effect receipt with fabricated uncertainty.
          options.onCleanupError(authority.operationId, error);
        }
      }
    });
  };
}

/** Compose existing source, Storage, Documents and journal owners without minting maintenance authority. */
export function createIntegrationTargetOpener(options: {
  kernel: import('./kernel-client.js').KernelClient;
  runtime: AgentRuntimeClient;
  storage: import('./storage-adapter.js').KernelStorageAdapter;
  recovery: Pick<import('../recovery/journal-engine.js').WorkspaceRecoveryEngine, 'coordinateWorkspaceStorage'>;
  metadataReader: Pick<import('../recovery/journal-engine.js').RecoveryDurableOperationPort, 'listOperations'>;
  resolveLiveSource: import('./live-source.js').LiveSourceResolver;
  documents: { resolveWorkspace(input: { path: string }): Promise<{ workspaceId: string }>;
    inspectWorkspace(workspaceId: string): Promise<{ root: string }> };
}): IntegrationToolOwnerOptions['openTarget'] {
  return async (invocation, launch, signal) => {
    const selected = physicalSourceLaunch(invocation.runId, launch);
    const admitted = await admitRunSourceAuthority(options.kernel, options.runtime, selected,
      { signal, resolveLiveSource: options.resolveLiveSource, purpose: 'integration', operationId: invocation.operationId });
    try {
      if (!admitted.rootId || !admitted.canonicalRoot) throw new Error('Physical source was not admitted');
      const documentWorkspace = await options.documents.resolveWorkspace({ path: admitted.canonicalRoot });
      if ((await options.documents.inspectWorkspace(documentWorkspace.workspaceId)).root !== admitted.canonicalRoot) {
        throw new Error('Integration Documents root changed');
      }
      const authority = await options.storage.fileAuthorityContextFromGrant({ grant: admitted.grant,
        owningWorkspaceId: selected.workspaceId, executionWorkspaceId: selected.executionWorkspaceId,
        canonicalRoot: admitted.canonicalRoot });
      if (authority.rootId !== admitted.rootId) throw new Error('Integration file root changed');
      const bindings = createScopedKernelRecoveryBindings(options.storage, { authority, threadId: invocation.threadId,
        runId: invocation.runId, storageRoot: options.kernel.handshake!.storageRoot, metadataReader: options.metadataReader });
      const context = await options.storage.contextFromGrant({ grant: admitted.grant,
        owningWorkspaceId: selected.workspaceId, executionWorkspaceId: selected.executionWorkspaceId,
        rootId: admitted.rootId, canonicalRoot: admitted.canonicalRoot, ...bindings });
      const store = new KernelWorkingStateRootStore(context);
      const workingStates: WorkspaceWorkingStateRootAccess = {
        withBranchStore: (workspaceId, purpose, operation, mode = 'shared', actor) => {
          if (workspaceId !== selected.workspaceId || actor?.sessionId
            || (actor?.threadId && actor.threadId !== invocation.threadId)
            || (actor?.runId && actor.runId !== invocation.runId)) throw new Error('Integration scope belongs to a different actor');
          return options.recovery.coordinateWorkspaceStorage(workspaceId, { mode, purpose }, () => operation(store, context));
        },
      };
      signal.throwIfAborted();
      return { directory: admitted.canonicalRoot, documentWorkspaceId: documentWorkspace.workspaceId,
        workingStates, release: admitted.release };
    } catch (error) { await admitted.release(); throw error; }
  };
}

function physicalSourceLaunch(runId: string, launch: LaunchIntent): SourceLaunch {
  const source = launch.selection.source;
  if (!source || source.mode === 'fixed_branch') throw new Error('Integration requires the parent physical source');
  const common = { runId, workspaceId: source.workspace_id,
    executionWorkspaceId: source.execution_workspace_id,
    tools: sourceToolSchemas(launch.selection).map(tool => tool.name) as SourceLaunch['tools'] };
  if (source.mode === 'live_root') {
    if (!source.live_root) throw new Error('Live source identity is unavailable');
    return { ...common, mode: 'live_root', liveRoot: source.live_root };
  }
  if (source.branch_id === null || source.revision === null) throw new Error('Materialized source identity is unavailable');
  return { ...common, mode: 'materialized', branchId: source.branch_id, revision: source.revision,
    ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}) };
}


/** Discovery is driven by the existing collaboration event/startup owner. Only original unknown
 * Integrations are inspected; this never compensates a pending journal or starts a Run. */
export function createIntegrationReceiptReconciler(options: {
  runtime: Pick<AgentRuntimeClient, 'threads' | 'activeOperations' | 'reconcileHostTool'>;
  onError(operationId: string | undefined, error: unknown): void;
}): (signal: AbortSignal) => Promise<void> {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  return async signal => {
    const threads = await options.runtime.threads(signal);
    await Promise.all(threads.map(async thread => {
      const operations = await options.runtime.activeOperations(thread.thread_id, undefined, signal);
      await Promise.all(operations.map(async operation => {
        if (operation.effect !== 'unknown' || operation.execution_owner?.kind !== 'external'
          || !object(operation.intent) || !object(operation.intent.call) || operation.intent.call.name !== 'integrate_child') return;
        try {
          signal.throwIfAborted();
          // Catalog derives the unique journal and source from this original execution identity.
          // Reading its durable receipt does not require a surviving physical workspace or grant.
          await options.runtime.reconcileHostTool({ operationId: operation.id,
            executionOwner: operation.execution_owner }, signal);
        } catch (error) { if (!signal.aborted) options.onError(operation.id, error); }
      }));
    }));
  };
}
