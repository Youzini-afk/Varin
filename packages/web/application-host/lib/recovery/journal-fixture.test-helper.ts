import type { RecoveryDurableMetadataPort } from "./journal-engine.js";

interface MemoryOperation extends Record<string, unknown> {
  operationId: string;
  workspaceId: string;
  kind: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
  result?: Record<string, unknown>;
  files: Array<Record<string, unknown> & { path: string; phase: string; revision: number }>;
}

export interface RecoveryJournalFixture extends RecoveryDurableMetadataPort {
  snapshot(workspaceId: string, operationId: string): MemoryOperation | null;
  debugSetFilePhase(workspaceId: string, operationId: string, path: string, phase: string): void;
  debugSetOperationState(workspaceId: string, operationId: string, state: string): void;
}

/** Records the Host's journal commands so coordination can be interrupted/reopened.
 * No checkpoint, mutation, coverage, GC or resource-overlap algorithm lives here:
 * each test supplies the original owner's facts at the metadata port. Real storage
 * and first-before/last-after behavior are covered by Rust and native recovery tests.
 */
export const createRecoveryJournalFixture = (
  metadata: Partial<RecoveryDurableMetadataPort> = {},
): RecoveryJournalFixture => {
  const operations = new Map<string, MemoryOperation>();
  const key = (workspaceId: string, operationId: string) => `${workspaceId}\0${operationId}`;
  const clone = <T>(value: T): T => structuredClone(value);
  const get = (workspaceId: string, operationId: string): MemoryOperation | null => {
    const operation = operations.get(key(workspaceId, operationId));
    return operation ? clone(operation) : null;
  };
  const unexpected = async (): Promise<never> => { throw new Error("Supply the recovery owner's result explicitly"); };
  return {
    snapshot: get,
    debugSetFilePhase(workspaceId, operationId, path, phase) {
      const operation = operations.get(key(workspaceId, operationId));
      const file = operation?.files.find((value) => value.path === path);
      if (!operation || !file) throw new Error("operation file is missing");
      file.phase = phase;
      file.revision += 1;
    },
    debugSetOperationState(workspaceId, operationId, state) {
      const operation = operations.get(key(workspaceId, operationId));
      if (!operation) throw new Error("operation is missing");
      operation.state = state;
      operation.revision += 1;
    },
    async createOperation(input) {
      const id = key(input.workspaceId, input.operationId);
      const existing = operations.get(id);
      if (existing) return clone(existing);
      const surface = new Set(input.surfacePaths ?? []);
      const createdAt = new Date().toISOString();
      const operation: MemoryOperation = {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        state: input.state,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        data: structuredClone(input.data),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        files: Object.entries(input.targets).sort(([left], [right]) => left.localeCompare(right)).map(([path, states]) => ({
          path,
          phase: "pending",
          revision: 1,
          ...(surface.has(path) || !states.expected ? {} : { expectedJson: JSON.stringify(states.expected) }),
          ...(surface.has(path) || !states.target ? {} : { targetJson: JSON.stringify(states.target) }),
          ...(surface.has(path) || !states.safety ? {} : { safetyJson: JSON.stringify(states.safety) }),
        })),
      };
      operations.set(id, operation);
      return clone(operation);
    },
    async updateOperationFile(input) {
      const operation = operations.get(key(input.workspaceId, input.operationId));
      const file = operation?.files.find((value) => value.path === input.path);
      if (!operation || !file || file.revision !== input.expectedRevision || file.phase !== input.expectedPhase) {
        throw new Error("operation file phase conflict");
      }
      file.phase = input.phase;
      file.revision += 1;
      operation.updatedAt = new Date().toISOString();
      if (input.observedFingerprint) file.observedFingerprint = input.observedFingerprint;
      if (input.expected) file.expectedJson = JSON.stringify(input.expected);
      if (input.target) file.targetJson = JSON.stringify(input.target);
      if (input.safety) file.safetyJson = JSON.stringify(input.safety);
      return { operationId: input.operationId, workspaceId: input.workspaceId, path: input.path, phase: file.phase, revision: file.revision };
    },
    async completeOperation(input) {
      const operation = operations.get(key(input.workspaceId, input.operationId));
      if (!operation || operation.revision !== input.expectedRevision) throw new Error("operation state conflict");
      operation.state = input.state;
      operation.revision += 1;
      operation.updatedAt = new Date().toISOString();
      if (input.result) operation.result = structuredClone(input.result);
      if (input.failure) operation.failure = structuredClone(input.failure);
      return { operationId: input.operationId, workspaceId: input.workspaceId, state: operation.state, revision: operation.revision };
    },
    async getOperation(workspaceId, operationId) { return get(workspaceId, operationId); },
    async listOperations(workspaceId, kind) {
      return [...operations.values()].filter((operation) => operation.workspaceId === workspaceId && (!kind || operation.kind === kind)).map(clone);
    },
    async listOperationConflicts() { return []; },
    async releaseOperation(workspaceId, operationId) {
      const id = key(workspaceId, operationId);
      const operation = operations.get(id);
      if (!operation) return { operationId, released: false };
      if (!["complete", "aborted", "compensated", "undone"].includes(operation.state)) {
        return { operationId, released: false };
      }
      operations.delete(id);
      return { operationId, released: true };
    },
    listChanges: async () => ({ changes: [], turns: [] }),
    listCheckpoints: async () => [],
    createNamedCheckpoint: unexpected,
    recordMutationBefore: unexpected,
    recordMutationAfter: unexpected,
    recordTurnStart: unexpected,
    recordTurnSettled: unexpected,
    resolveEntry: unexpected,
    ...metadata,
  };
};
