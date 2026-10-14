import type {
  RecoveryConversation, WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryOperationResult, WorkspaceCombinedRecoveryPrepareResult,
} from '@varin/extension-contract';
import type { RecoveryRangeTurn } from '../kernel/protocol.generated.js';

/** A reference to the target's original journal. No target object hashes confer local access. */
export interface ManagedRecoveryBinding {
  operationId: string;
  workspaceId: string;
  conversation: Extract<RecoveryConversation, { kind: 'thread' }>;
  turns: Array<{ turn: RecoveryRangeTurn; restore: boolean }>;
}
export interface ManagedRecoveryNavigation {
  expectedLeafId: string | null;
  targetLeafId: string | null;
  removedEntryIds: string[];
}
export type ManagedRecoveryAction =
  | { kind: 'prepare'; entryId: string; navigation: ManagedRecoveryNavigation }
  | { kind: 'prepare_undo'; undoOf: string; navigation: ManagedRecoveryNavigation }
  | { kind: 'apply'; input: WorkspaceCombinedRecoveryApplyInput }
  | { kind: 'read' | 'complete' | 'compensate' | 'cancel' };
export interface ManagedRecoveryRequest {
  coordinatorHostId: string;
  binding: ManagedRecoveryBinding;
  action: ManagedRecoveryAction;
}
export type ManagedRecoveryReply = WorkspaceCombinedRecoveryPrepareResult | WorkspaceCombinedRecoveryOperationResult;
