import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IntegrationCoordinator, IntegrationOperationReceipt, IntegrationPlanInput } from '../harness/working-state/integration-coordinator.js';
import type { ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { integrationCompletion, openScopedIntegrationTarget, type IntegrationTargetOwners, type IntegrationToolOwnerOptions } from './integration-tool-owner.js';
import { toolOperationId, validToolOrigin } from './protocol.generated.js';

/** Only the target executes the original merge. A transport failure preserves unknown
 * until its original journal can answer; the coordinator never repeats a local merge. */
export function createManagedIntegrationOwner(options: Pick<IntegrationTargetOwners, 'kernel' | 'runtime' | 'resolveLiveSource'> & {
  onCleanupError(operationId: string, error: unknown): void;
}): NonNullable<IntegrationToolOwnerOptions['mergeManaged']> {
  return async (invocation, launch, child, signal) => {
    if (!launch.selection.source) throw new Error('Original Integration source is unavailable');
    const selected = savedSourceLaunch(invocation.runId, launch.selection.source, sourceToolSchemas(launch.selection).map(tool => tool.name));
    const authority = await admitRunSourceAuthority(options.kernel, options.runtime, selected,
      { signal, resolveLiveSource: options.resolveLiveSource, purpose: 'integration', operationId: invocation.operationId, retention: 'caller' });
    let entered = false;
    try {
      if (authority.kind !== 'managed') throw new Error('Integration is not on a managed resource Host');
      const journal = await options.runtime.journalAnchor(invocation.operationId, signal);
      const address = { coordinatorHostId: options.runtime.coordinatorHostId,
        authorityId: authority.binding.authorityId, resourceEpoch: authority.binding.resourceEpoch };
      signal.throwIfAborted();
      entered = true;
      try {
        const result = await authority.service.service({ ...address, requestId: randomUUID(),
          operation: { kind: 'integration', invocation, child, journal } }, signal) as IntegrationOperationReceipt;
        return integrationCompletion(result);
      } catch (error) {
        // The original Host-tool reconciler reads the target's Storage journal. Do not
        // build a second TypeScript effect projection just to classify a lost reply.
        return { completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
          content: { data: { status: 'needs-attention', operationId: `integration:${invocation.operationId}`,
            error: error instanceof Error ? error.message : String(error) }, parts: [] } }, executor_stopped: false };
      }
    } finally {
      try { await authority.release(); }
      catch (error) {
        options.onCleanupError(invocation.operationId, error);
        if (!entered) throw error;
      }
    }
  };
}

export function createManagedIntegrationService(options: Pick<IntegrationTargetOwners,
  'kernel' | 'storage' | 'documents' | 'recovery' | 'metadataReader'> & {
  coordinator: Pick<IntegrationCoordinator, 'mergeResult' | 'inspectIntegration'>;
}): ManagedSourceServiceHandler {
  return async (scope, operation, suppliedSignal) => {
    if (operation.kind !== 'integration') throw new Error(`Unsupported Integration service: ${operation.kind}`);
    if (!scope.principal.capabilities.includes('filesystem:write')) throw new Error('The target Host has not granted file writes to this client');
    const { invocation, child, journal } = operation;
    if (scope.scope.kind !== 'run' || scope.scope.runId !== invocation.runId || scope.scope.threadId !== invocation.threadId
      || !isDeepStrictEqual(scope.source, invocation.source) || !scope.physicalRoot || scope.source.mode === 'fixed_branch'
      || invocation.toolName !== 'integrate_child' || invocation.operation !== 'effect'
      || !validToolOrigin(invocation.origin) || toolOperationId(invocation.origin, invocation.callId) !== invocation.operationId
      || child.code_result.kind !== 'published' || child.source?.kind !== 'ready'
      || !isDeepStrictEqual(child.source.selection.resource_owner, scope.source.resource_owner)
      || child.parent_thread_id !== invocation.threadId || child.code_result.result.workspace_id !== scope.source.workspace_id
      || journal.runId !== invocation.runId || journal.threadId !== invocation.threadId || journal.branchId !== child.parent_branch_id) {
      throw new Error('Integration differs from its original source, invocation or published child');
    }
    const signal = suppliedSignal ?? new AbortController().signal;
    const selected = savedSourceLaunch(invocation.runId, scope.source, []);
    const target = await openScopedIntegrationTarget(options, invocation, selected, {
      grant: scope.grant, rootId: scope.physicalRoot.rootId, canonicalRoot: scope.physicalRoot.canonicalRoot,
    }, journal, async () => {}, signal);
    const result = child.code_result.result;
    const input: IntegrationPlanInput & { operationId: string } = {
      operationId: `integration:${invocation.operationId}`, workspaceId: result.workspace_id,
      threadId: child.child_thread_id, branchId: result.branch_id, resultRevision: result.result_revision,
      operationBinding: { kind: 'runtime_operation', operationId: invocation.operationId,
        parentRunId: invocation.runId, parentThreadId: invocation.threadId, parentBranchId: journal.branchId,
        origin: invocation.origin, callId: invocation.callId, childOperationId: child.child_operation_id,
        childExecutionId: child.execution_id, childThreadId: child.child_thread_id,
        result: { workspaceId: result.workspace_id, branchId: result.branch_id,
          resultRevision: result.result_revision, root: result.root, publicationId: result.publication_id }, target: scope.source },
      executionId: target.executionId, requireTurnBinding: true, scopedWorkingStates: target.workingStates,
      signal, parentAuthority: { kind: 'directory', directory: target.directory, workspaceId: target.documentWorkspaceId },
    };
    try { return await options.coordinator.mergeResult(input); }
    catch (error) {
      const { signal: _signal, ...read } = input;
      const receipt = await options.coordinator.inspectIntegration(read);
      if (receipt) return receipt;
      throw error;
    }
  };
}
