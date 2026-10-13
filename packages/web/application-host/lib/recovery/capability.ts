import {
  parseRecoveryStorageLocation,
  parseRecoveryStorageCleanupInput,
  parseRecoveryRetentionPolicyInput,
  parseSetRecoveryStorageLocationInput,
  parseWorkspaceCombinedRecoveryApplyInput,
  parseWorkspaceCombinedRecoveryPrepareInput,
  parseWorkspaceRecoveryCheckpointInput,
  parseWorkspaceRecoveryCheckpointQuery,
  parseWorkspaceRecoveryEntryTarget,
  parseWorkspaceRecoveryMutationAfterInput,
  parseWorkspaceRecoveryMutationBeforeInput,
  parseWorkspaceRecoveryTurnSettledInput,
  parseWorkspaceRecoveryTurnStartInput,
  type JsonValue,
} from '@varin/extension-contract';
import type { HostCapabilityCallContext, HostCapabilityHandler } from '@varin/extension-host';
import type { WorkspaceRecoveryEngine } from './engine.js';

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} expects an object`);
  return value as Record<string, unknown>;
};

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};

const toJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  throw new TypeError('Workspace recovery capability returned a non-JSON value');
};

export const createWorkspaceRecoveryCapabilityHandler =
  (engineOrResolver: WorkspaceRecoveryEngine | ((context: HostCapabilityCallContext) => WorkspaceRecoveryEngine | Promise<WorkspaceRecoveryEngine>)): HostCapabilityHandler =>
  async (method, params, context): Promise<JsonValue> => {
    const engine = typeof engineOrResolver === 'function'
      ? await engineOrResolver(context)
      : engineOrResolver;
    const result = await (async (): Promise<unknown> => {
    if (method === 'status') {
      const input = asRecord(params, 'workspace.recovery-primitives.status');
      return engine.status(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'createCheckpoint') return engine.createCheckpoint(parseWorkspaceRecoveryCheckpointInput(params));
    if (method === 'recordMutationBefore') {
      return engine.recordMutationBefore(parseWorkspaceRecoveryMutationBeforeInput(params));
    }
    if (method === 'recordMutationAfter') {
      return engine.recordMutationAfter(parseWorkspaceRecoveryMutationAfterInput(params));
    }
    if (method === 'recordTurnStart') { const input = parseWorkspaceRecoveryTurnStartInput(params); if (input.conversation.kind !== 'pi' || input.fileTarget || input.runId) throw new Error('Native recovery anchors are supplied only by the original runtime owner'); return engine.recordTurnStart(input); }
    if (method === 'recordTurnSettled') return engine.recordTurnSettled(parseWorkspaceRecoveryTurnSettledInput(params));
    if (method === 'resolveEntry') return engine.resolveEntry(parseWorkspaceRecoveryEntryTarget(params));
    if (method === 'prepareCombinedRecovery') {
      return engine.prepareCombinedRecovery(parseWorkspaceCombinedRecoveryPrepareInput(params));
    }
    if (method === 'prepareCombinedUndo') {
      const input = asRecord(params, 'workspace.recovery-primitives.prepareCombinedUndo');
      return engine.prepareCombinedUndo(requiredText(input.operationId, 'operationId'));
    }
    if (method === 'applyCombinedRecovery') {
      return engine.applyCombinedRecovery(parseWorkspaceCombinedRecoveryApplyInput(params));
    }
    if (method === 'getCombinedOperation') {
      const input = asRecord(params, 'workspace.recovery-primitives.getCombinedOperation');
      return engine.getCombinedOperation(requiredText(input.operationId, 'operationId'));
    }
    if (method === 'cancelCombinedOperation') {
      const input = asRecord(params, 'workspace.recovery-primitives.cancelCombinedOperation');
      return engine.cancelCombinedOperation(requiredText(input.operationId, 'operationId'));
    }
    if (method === 'listCheckpoints') return engine.listCheckpoints(parseWorkspaceRecoveryCheckpointQuery(params));
    if (method === 'listCombinedOperations') {
      const input = asRecord(params, 'workspace.recovery-primitives.listCombinedOperations');
      return engine.listCombinedOperations(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'listStorageWorkspaces') return engine.listStorageWorkspaces();
    if (method === 'storageStatus') {
      const input = asRecord(params, 'workspace.recovery-primitives.storageStatus');
      return engine.storageStatus(input.workspaceId === undefined
        ? undefined
        : requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'setStorageLocation') {
      return engine.setStorageLocation(parseSetRecoveryStorageLocationInput(params));
    }
    if (method === 'setDefaultStorageLocation') {
      return engine.setDefaultStorageLocation(parseRecoveryStorageLocation(params));
    }
    if (method === 'clearStorageLocationOverride') {
      const input = asRecord(params, 'workspace.recovery-primitives.clearStorageLocationOverride');
      return engine.clearStorageLocationOverride(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'getStorageMove') {
      const input = asRecord(params, 'workspace.recovery-primitives.getStorageMove');
      return engine.getStorageMove(requiredText(input.operationId, 'operationId'));
    }
    if (method === 'cleanupStorage') {
      return engine.cleanupStorage(parseRecoveryStorageCleanupInput(params));
    }
    if (method === 'retentionStatus') {
      const input = asRecord(params, 'workspace.recovery-primitives.retentionStatus');
      return engine.retentionStatus(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'setRetentionPolicy') {
      return engine.setRetentionPolicy(parseRecoveryRetentionPolicyInput(params));
    }
    if (method === 'deleteWorkspaceHistory') {
      const input = asRecord(params, 'workspace.recovery-primitives.deleteWorkspaceHistory');
      return engine.deleteWorkspaceHistory(requiredText(input.workspaceId, 'workspaceId'));
    }
      throw new Error(`workspace.recovery-primitives does not implement ${method}`);
    })();
    return toJsonValue(result);
  };
