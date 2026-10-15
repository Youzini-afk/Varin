import type { WorkspaceCombinedRecoveryApplyInput, WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryPlan, WorkspaceRecoveryAPI } from '@varin/extension-contract';
import { requireWorkspaceRecoveryResult } from '@/lib/recovery/workspaceRecovery';
import { getRuntimeEndpointGeneration } from '@varin/application-client';

/** A lost transport response is not evidence that either commit failed. */
export async function applyCombinedRecoveryAndRead(
  api: WorkspaceRecoveryAPI,
  input: WorkspaceCombinedRecoveryApplyInput,
): Promise<WorkspaceCombinedRecoveryOperation> {
  const host = getRuntimeEndpointGeneration();
  try {
    return requireWorkspaceRecoveryResult(await api.applyCombinedRecovery(input)).operation;
  } catch (failure) {
    if (host !== getRuntimeEndpointGeneration()) throw failure;
    try { return requireWorkspaceRecoveryResult(await api.getCombinedOperation(input.operationId)).operation; }
    catch { throw failure; }
  }
}

export function combinedRecoveryStatus(operation: WorkspaceCombinedRecoveryOperation): string {
  return `${operation.state} · files: ${operation.fileState} · conversation: ${operation.conversationState}${operation.failure ? ` · ${operation.failure.message}` : ''}`;
}

export function isCombinedRecoverySettled(operation: WorkspaceCombinedRecoveryOperation): boolean {
  return operation.state === 'complete' || operation.state === 'compensated'
    || operation.state === 'aborted' || operation.state === 'needs-attention';
}

export function assertCombinedRecoveryIdentity(operation: WorkspaceCombinedRecoveryOperation, expected: Pick<WorkspaceCombinedRecoveryPlan, 'id' | 'conversation'>): void {
  const left = operation.conversation, right = expected.conversation;
  const matches = left.kind === 'thread' && right.kind === 'thread'
    && left.threadId === right.threadId && left.branchId === right.branchId;
  if (operation.id !== expected.id || !matches) throw new Error('The recovery response belongs to a different operation or conversation. Refresh its original conversation.');
}
