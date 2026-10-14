import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RecoveryPrimitiveError } from './errors.js';
import { parseWorkspaceCombinedRecoveryOperationResult, parseWorkspaceCombinedRecoveryPrepareResult } from '@varin/extension-contract';
import type {
  RecoveryConversation, RecoveryFileTarget, WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryOperationResult,
  WorkspaceCombinedRecoveryPlan, WorkspaceCombinedRecoveryPrepareInput,
  WorkspaceCombinedRecoveryPrepareResult,
} from '@varin/extension-contract';
import type { RecoveryRangeTurn, SourceResourceOwner } from '../kernel/protocol.generated.js';

/** These are references to the original file owner's journal, never local content objects. */
export interface RecoveryNavigationSelection {
  expectedLeafId: string | null;
  targetLeafId: string | null;
  removedEntryIds: string[];
}
export interface RecoveryJournalTurn { workspaceId: string; executionId: string; restore: boolean }
export interface RecoveryFileParticipantAccess {
  operationId: string;
  /** Stable, authenticated original-source attribution, checked again on every entry. */
  binding: Record<string, unknown>;
}
export interface RecoveryFileParticipantPrepare extends RecoveryFileParticipantAccess {
  workspaceId: string;
  conversation: RecoveryConversation;
  entryId: string;
  navigation: RecoveryNavigationSelection;
  journalTurns: RecoveryJournalTurn[];
  allowedFileTargets: RecoveryFileTarget[];
}
export interface RecoveryFileParticipantUndo extends RecoveryFileParticipantAccess {
  undoOf: string;
  navigation: RecoveryNavigationSelection;
}
export type RecoveryFileParticipantApply = RecoveryFileParticipantAccess & WorkspaceCombinedRecoveryApplyInput;
export interface RecoveryFileParticipantEngine {
  prepareFileRecovery(input: RecoveryFileParticipantPrepare): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  prepareFileUndo(input: RecoveryFileParticipantUndo): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  applyFileRecovery(input: RecoveryFileParticipantApply): Promise<WorkspaceCombinedRecoveryOperationResult>;
  readFileRecovery(input: RecoveryFileParticipantAccess): Promise<WorkspaceCombinedRecoveryOperationResult>;
  completeFileRecovery(input: RecoveryFileParticipantAccess): Promise<WorkspaceCombinedRecoveryOperationResult>;
  compensateFileRecovery(input: RecoveryFileParticipantAccess): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancelFileRecovery(input: RecoveryFileParticipantAccess): Promise<WorkspaceCombinedRecoveryOperationResult>;
}
export interface ManagedRecoveryTurn { turn: RecoveryRangeTurn; restore: boolean }
export interface ManagedRecoveryParticipant {
  id: string;
  workspaceId: string;
  owner: Extract<SourceResourceOwner, { kind: 'managed_host' }>;
  turns: ManagedRecoveryTurn[];
  plan: WorkspaceCombinedRecoveryPlan;
  /** Last actual observation; an unanswered request does not change this into a terminal result. */
  operation?: WorkspaceCombinedRecoveryOperation;
  requested?: 'apply' | 'complete' | 'compensate' | 'cancel';
}
export interface ManagedRecoveryPort {
  prepare(operationId: string, input: WorkspaceCombinedRecoveryPrepareInput, navigation: RecoveryNavigationSelection,
    turns: ManagedRecoveryTurn[]): Promise<ManagedRecoveryParticipant[]>;
  prepareUndo(participant: ManagedRecoveryParticipant, operationId: string, navigation: RecoveryNavigationSelection): Promise<ManagedRecoveryParticipant>;
  apply(participant: ManagedRecoveryParticipant, input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
  read(participant: ManagedRecoveryParticipant): Promise<WorkspaceCombinedRecoveryOperationResult>;
  complete(participant: ManagedRecoveryParticipant): Promise<WorkspaceCombinedRecoveryOperationResult>;
  compensate(participant: ManagedRecoveryParticipant): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancel(participant: ManagedRecoveryParticipant): Promise<WorkspaceCombinedRecoveryOperationResult>;
}

export const managedRecoveryPath = (participant: Pick<ManagedRecoveryParticipant, 'id'>, path: string): string =>
  `managed/${encodeURIComponent(participant.id)}/${path}`;
const ownerKey = (owner: ManagedRecoveryParticipant['owner']) => JSON.stringify([owner.hostId, owner.connectionId, owner.endpointIdentity]);

/** The authenticated target resolves every action through its original recovery journal. */
export function createManagedRecoveryCoordinator(options: {
  coordinatorHostId: string;
  registry: Pick<import('../harness/managed-remote-client.js').ManagedRemoteTargetRegistry, 'source'>;
}): ManagedRecoveryPort {
  const request = async (participant: ManagedRecoveryParticipant, action: import('../harness/managed-recovery-contract.js').ManagedRecoveryAction) => {
    if (participant.plan.conversation.kind !== 'thread') throw new Error('Managed file recovery requires its original Thread');
    const client = await options.registry.source(participant.owner);
    return client.recovery({ coordinatorHostId: options.coordinatorHostId,
      binding: { operationId: participant.id, workspaceId: participant.workspaceId,
        conversation: participant.plan.conversation, turns: participant.turns }, action });
  };
  const operation = async (participant: ManagedRecoveryParticipant, action: import('../harness/managed-recovery-contract.js').ManagedRecoveryAction): Promise<WorkspaceCombinedRecoveryOperationResult> => {
    return parseWorkspaceCombinedRecoveryOperationResult(await request(participant, action));
  };
  return {
    async prepare(operationId, input, navigation, turns) {
      if (input.conversation.kind !== 'thread') throw new Error('Managed file recovery requires its original Thread');
      const groups = new Map<string, ManagedRecoveryTurn[]>();
      for (const selected of turns) {
        const owner = selected.turn.source?.resource_owner;
        if (!owner || owner.kind !== 'managed_host') throw new Error('Managed recovery turn has no original managed owner');
        const key = ownerKey(owner);
        groups.set(key, [...groups.get(key) ?? [], selected]);
      }
      const participants: ManagedRecoveryParticipant[] = [];
      for (const [key, selected] of groups) {
        const source = selected[0]!.turn.source!;
        const owner = source.resource_owner as ManagedRecoveryParticipant['owner'];
        const id = `${operationId}:managed:${createHash('sha256').update(key).digest('hex')}`;
        const client = await options.registry.source(owner);
        const result = parseWorkspaceCombinedRecoveryPrepareResult(await client.recovery({ coordinatorHostId: options.coordinatorHostId,
          binding: { operationId: id, workspaceId: source.workspace_id, conversation: input.conversation, turns: selected },
          action: { kind: 'prepare', entryId: input.entryId, navigation } }));
        if (result.status !== 'ready') throw new RecoveryPrimitiveError(result.failure.code, result.failure.message, result.failure);
        if (result.plan.id !== id || result.plan.workspaceId !== source.workspace_id || !isDeepStrictEqual(result.plan.conversation, input.conversation)
          || result.plan.entryId !== input.entryId || result.plan.expectedLeafId !== navigation.expectedLeafId || result.plan.targetLeafId !== navigation.targetLeafId)
          throw new Error('Managed recovery preparation changed its original identity');
        participants.push({ id, workspaceId: source.workspace_id, owner, turns: selected, plan: result.plan });
      }
      return participants;
    },
    async prepareUndo(participant, operationId, navigation) {
      const id = `${operationId}:managed:${createHash('sha256').update(ownerKey(participant.owner)).digest('hex')}`;
      const next = { ...participant, id };
      const result = parseWorkspaceCombinedRecoveryPrepareResult(await request(next, { kind: 'prepare_undo', undoOf: participant.id, navigation }));
      if (result.status !== 'ready') throw new RecoveryPrimitiveError(result.failure.code, result.failure.message, result.failure);
      if (result.plan.id !== id || result.plan.workspaceId !== participant.workspaceId || !isDeepStrictEqual(result.plan.conversation, participant.plan.conversation)
        || result.plan.undoOf !== participant.id || result.plan.expectedLeafId !== navigation.expectedLeafId || result.plan.targetLeafId !== navigation.targetLeafId)
        throw new Error('Managed recovery undo changed its original identity');
      return { id, workspaceId: participant.workspaceId, owner: participant.owner, turns: participant.turns, plan: result.plan };
    },
    apply: (participant, input) => operation(participant, { kind: 'apply', input }),
    read: participant => operation(participant, { kind: 'read' }),
    complete: participant => operation(participant, { kind: 'complete' }),
    compensate: participant => operation(participant, { kind: 'compensate' }),
    cancel: participant => operation(participant, { kind: 'cancel' }),
  };
}
