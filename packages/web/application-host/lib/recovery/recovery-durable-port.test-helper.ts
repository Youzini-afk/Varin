import path from "node:path";
import type { WorkspaceRecoveryTurnProvenance } from "@varin/extension-contract";
import type { DurableRecoveryChangeSelection, RecoveryDurableMetadataPort } from "./journal-engine.js";
import { sameState } from "./journal-files.js";
import type { RecoveryState } from "./journal-files.js";

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

type MemoryTurn = DurableRecoveryChangeSelection["turns"][number] & {
  workspaceId: string;
  assistantEntryId?: string;
  provenance?: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration?: number;
  runtimeKey?: string;
  sessionId?: string;
  settledAt?: string;
  startedAt?: string;
  userEntryId?: string;
  workerId?: string;
};

type MemoryChange = DurableRecoveryChangeSelection["changes"][number] & {
  workspaceId: string;
  sessionId?: string;
};

export interface InMemoryRecoveryDurablePort extends RecoveryDurableMetadataPort {
  snapshot(workspaceId: string, operationId: string): MemoryOperation | null;
  /** Test-only escape hatch: force an operation file's phase (e.g. needs-attention). */
  debugSetFilePhase(workspaceId: string, operationId: string, path: string, phase: string): void;
  /** Test-only escape hatch: force an operation's state (e.g. simulating a host crash before the terminal persist). */
  debugSetOperationState(workspaceId: string, operationId: string, state: string): void;
}

export interface InMemoryRecoveryDurablePortOptions {
  /**
   * File-state capture used by recordMutationBefore/After, mirroring the
   * kernel store's `content.captureState`. Tests wire this to a real
   * RecoveryFileStore over the workspace root.
   */
  captureState?: (input: { path: string; workspaceId: string }) => Promise<RecoveryState>;
  /**
   * Workspace-relative path resolution, mirroring the kernel store's
   * `paths.resolve`. Tests wire this to RecoveryFileStore.relativePathFor.
   */
  relativePathFor?: (input: { path: string; workspaceId: string }) => Promise<string>;
}

/**
 * Process-local recovery port for tests. It mirrors the kernel store's
 * observable contract — turn checkpoints surface in listCheckpoints, mutation
 * before/after states are captured per path, and turn settlement computes the
 * same coverage status — while keeping operation/file revisions independent.
 */
export const createInMemoryRecoveryDurablePort = (
  options: InMemoryRecoveryDurablePortOptions = {},
): InMemoryRecoveryDurablePort => {
  const operations = new Map<string, MemoryOperation>();
  const checkpoints = new Map<string, Array<Record<string, unknown>>>();
  const turns = new Map<string, MemoryTurn>();
  const changes = new Map<string, MemoryChange>();
  let turnSequence = 0;
  const key = (workspaceId: string, operationId: string) => `${workspaceId}\0${operationId}`;
  const clone = <T>(value: T): T => structuredClone(value);
  const get = (workspaceId: string, operationId: string): MemoryOperation | null => {
    const operation = operations.get(key(workspaceId, operationId));
    return operation ? clone(operation) : null;
  };
  const checkpointSummaries = (workspaceId: string): Array<Record<string, unknown>> => {
    const values = checkpoints.get(workspaceId) ?? [];
    checkpoints.set(workspaceId, values);
    return values;
  };
  const capture = async (workspaceId: string, path: string): Promise<RecoveryState> => {
    if (!options.captureState) {
      throw new Error("in-memory durable port needs captureState for mutation recording");
    }
    return options.captureState({ path, workspaceId });
  };
  const relativize = async (workspaceId: string, path: string): Promise<string> => {
    if (!options.relativePathFor) {
      throw new Error("in-memory durable port needs relativePathFor for mutation recording");
    }
    return options.relativePathFor({ path, workspaceId });
  };
  const turnFor = (workspaceId: string, executionId: string): MemoryTurn | undefined => (
    turns.get(`${workspaceId}\0${executionId}`)
  );
  const turnBinding = (turn: MemoryTurn) => ({
    activeWriterScopes: [...turn.activeWriterScopes],
    checkpointId: turn.checkpointId,
    executionId: turn.executionId,
    provenance: turn.provenance ?? "observed-during",
    runtimeGeneration: turn.runtimeGeneration ?? 0,
    runtimeKey: turn.runtimeKey ?? "",
    sessionId: turn.sessionId ?? "",
    startedAt: turn.startedAt ?? "",
    status: turn.status,
    unrecordedResourceIds: [...turn.unrecordedResourceIds],
    userEntryId: turn.userEntryId ?? "",
    workerId: turn.workerId ?? "",
    workspaceId: turn.workspaceId,
    ...(turn.assistantEntryId ? { assistantEntryId: turn.assistantEntryId } : {}),
    ...(turn.failure ? { failure: clone(turn.failure) } : {}),
    ...(turn.settledAt ? { settledAt: turn.settledAt } : {}),
  });
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
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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
    async listOperationConflicts(input) {
      const requested = input.paths.map(file => path.resolve(input.canonicalRoot, file));
      const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
      return [...operations.values()].flatMap(operation => {
        if (operation.kind !== "integration" || ["complete", "conflict", "compensated", "aborted", "undone"].includes(operation.state)
          || (operation.workspaceId === input.workspaceId && operation.operationId === input.exceptOperationId)) return [];
        const data = { ...operation.data, ...operation.result };
        if (data.parentBranchId) return [];
        const reservation = data.reservedResources as { canonicalRoot: string; paths: string[] } | undefined;
        const canonicalRoot = reservation?.canonicalRoot ?? (typeof data.applyCanonicalRoot === "string" ? data.applyCanonicalRoot
          : operation.workspaceId === input.workspaceId ? input.canonicalRoot : undefined);
        if (!canonicalRoot) throw new Error("Unresolved integration resource metadata is unavailable");
        const paths = reservation?.paths ?? Object.keys((data.targets ?? {}) as Record<string, unknown>);
        if (!paths.some(file => requested.some(resource => overlap(resource, path.resolve(canonicalRoot, file))))) return [];
        return [{ operationId: operation.operationId, workspaceId: operation.workspaceId, state: operation.state,
          revision: operation.revision, canonicalRoot, paths }];
      });
    },
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
    async listChanges(input): Promise<DurableRecoveryChangeSelection> {
      const selectedTurns = [...turns.values()].filter((turn) => {
        if (turn.workspaceId !== input.workspaceId) return false;
        if (input.sessionId && turn.sessionId !== input.sessionId) return false;
        if (input.executionId && turn.executionId !== input.executionId) return false;
        if (input.entryIds && input.entryIds.length > 0) {
          const entries = new Set(input.entryIds);
          if (!entries.has(turn.userEntryId ?? "") && !entries.has(turn.assistantEntryId ?? "")) return false;
        }
        return true;
      });
      const executionIds = new Set(selectedTurns.map((turn) => turn.executionId));
      return {
        changes: [...changes.values()]
          .filter((change) => {
            if (change.workspaceId !== input.workspaceId) return false;
            if (input.executionId) return change.executionId === input.executionId;
            if (input.sessionId && change.sessionId !== input.sessionId) return false;
            if (input.entryIds && input.entryIds.length > 0) return executionIds.has(change.executionId);
            return true;
          })
          .map(({ workspaceId: _workspaceId, sessionId: _sessionId, ...change }) => clone(change)),
        turns: selectedTurns.map(({ workspaceId: _workspaceId, sessionId: _sessionId, userEntryId: _userEntryId, assistantEntryId: _assistantEntryId, provenance: _provenance, ...turn }) => clone(turn)),
      };
    },
    async recordIntegrationChanges(input) {
      const turn = turns.get(`${input.workspaceId}\0${input.executionId}`);
      if (!turn || (turn.status !== "pending" && turn.status !== "ready")) return false;
      if (turn.status === "ready") {
        return Object.entries(input.changes).every(([path, states]) => {
          const prior = changes.get(`${input.workspaceId}\0${turn.checkpointId}\0${path}`);
          return prior !== undefined && JSON.stringify(prior.after) === JSON.stringify(states.after);
        });
      }
      for (const [path, states] of Object.entries(input.changes).sort(([left], [right]) => left.localeCompare(right))) {
        const id = `${input.workspaceId}\0${turn.checkpointId}\0${path}`;
        const prior = changes.get(id);
        changes.set(id, {
          workspaceId: input.workspaceId,
          checkpointId: turn.checkpointId,
          executionId: input.executionId,
          mutationId: prior?.mutationId ?? `thread.merge:${input.operationId}:${path}`,
          path,
          sequence: turn.sequence,
          toolName: prior?.toolName ?? "thread.merge",
          before: prior?.before ?? clone(states.before),
          after: clone(states.after),
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        });
      }
      return true;
    },
    async createNamedCheckpoint(workspaceId, name) {
      const createdAt = new Date().toISOString();
      const values = checkpointSummaries(workspaceId);
      const checkpoint = {
        id: `checkpoint-${values.length + 1}`,
        workspaceId,
        sequence: values.length + 1,
        source: "named",
        state: "ready",
        createdAt,
        changedPathCount: 0,
        byteLength: 0,
        label: name,
      };
      values.unshift(checkpoint);
      return clone(checkpoint) as never;
    },
    async listCheckpoints(workspaceId) {
      return clone(checkpoints.get(workspaceId) ?? []) as never;
    },
    async recordMutationBefore(input) {
      const turn = turnFor(input.workspaceId, input.executionId);
      if (!turn || !turn.sessionId) return false;
      const relative = await relativize(input.workspaceId, input.path);
      const state = await capture(input.workspaceId, input.path);
      const id = `${input.workspaceId}\0${turn.checkpointId}\0${relative}`;
      if (!changes.has(id)) {
        changes.set(id, {
          workspaceId: input.workspaceId,
          checkpointId: turn.checkpointId,
          executionId: input.executionId,
          mutationId: input.mutationId,
          path: relative,
          sequence: changes.size + 1,
          sessionId: turn.sessionId,
          toolName: input.toolName,
          before: clone(state),
          after: clone(state),
        });
      }
      return true;
    },
    async recordMutationAfter(input) {
      const turn = turnFor(input.workspaceId, input.executionId);
      if (!turn || !turn.sessionId) return false;
      const relative = await relativize(input.workspaceId, input.path);
      const id = `${input.workspaceId}\0${turn.checkpointId}\0${relative}`;
      const prior = changes.get(id);
      if (!prior) return false;
      const state = await capture(input.workspaceId, input.path);
      prior.after = clone(state);
      prior.mutationId = input.mutationId;
      return !sameState(prior.before, state);
    },
    async recordTurnSettled(input) {
      const previous = turnFor(input.workspaceId, input.executionId);
      if (!previous) throw new Error("checkpoint-missing");
      const recorded = new Set(
        [...changes.values()]
          .filter((change) => change.workspaceId === input.workspaceId && change.executionId === input.executionId)
          .map((change) => change.path),
      );
      const observed = [...new Set(input.observedResourceIds
        .filter((value) => Boolean(value) && !/\.varin-(?:tmp|restore|recovery)-/u.test(value)))].sort();
      const unrecorded = observed.filter((value) => !recorded.has(value));
      const retainedFailure = previous.status === "incomplete" && previous.failure && typeof previous.failure === "object"
        ? previous.failure
        : undefined;
      const exact = !input.failure
        && !retainedFailure
        && (!input.mutationObserved || input.observationComplete)
        && unrecorded.length === 0
        && !(input.mutationObserved && recorded.size === 0 && observed.length === 0);
      const failure = input.failure ?? retainedFailure ?? (exact ? undefined : {
        code: "checkpoint-incomplete",
        message: unrecorded.length > 0
          ? `Some changed paths were not captured before mutation: ${unrecorded.join(", ")}`
          : "Workspace activity was observed outside the exact write/edit journal",
        origin: "coverage",
        retryable: false,
        ...(unrecorded.length > 0 ? { details: { paths: unrecorded } } : {}),
      });
      const next: MemoryTurn = {
        ...previous,
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        activeWriterScopes: [...input.activeWriterScopes],
        status: exact ? "ready" : "incomplete",
        settledAt: new Date().toISOString(),
        unrecordedResourceIds: unrecorded,
        ...(input.assistantEntryId ? { assistantEntryId: input.assistantEntryId } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        ...(failure ? { failure: clone(failure) as Record<string, unknown> } : {}),
      };
      if (!failure) delete next.failure;
      turns.set(`${input.workspaceId}\0${input.executionId}`, next);
      const summary = checkpointSummaries(input.workspaceId)
        .find((entry) => (entry as { id?: string }).id === next.checkpointId);
      if (summary) {
        const checkpointChanges = [...changes.values()]
          .filter((change) => change.workspaceId === input.workspaceId && change.checkpointId === next.checkpointId && !sameState(change.before, change.after));
        summary.state = next.status;
        summary.changedPathCount = checkpointChanges.length;
        summary.byteLength = checkpointChanges.reduce((total, change) => {
          const beforeBytes = Number((change.before as { byteLength?: number }).byteLength ?? 0);
          const afterBytes = Number((change.after as { byteLength?: number }).byteLength ?? 0);
          return total + Math.max(beforeBytes, afterBytes);
        }, 0);
      }
      return turnBinding(next) as never;
    },
    async recordTurnStart(input) {
      const next: MemoryTurn = {
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        checkpointId: `turn-${input.executionId}`,
        sequence: ++turnSequence,
        sessionId: input.sessionId,
        userEntryId: input.userEntryId,
        workerId: input.workerId,
        runtimeGeneration: input.runtimeGeneration,
        runtimeKey: `${input.workerId}@${input.runtimeGeneration}`,
        startedAt: new Date().toISOString(),
        provenance: input.provenance,
        activeWriterScopes: [...input.activeWriterScopes],
        status: "pending",
        unrecordedResourceIds: [],
        ...(input.failure ? { failure: clone(input.failure) as unknown as Record<string, unknown> } : {}),
      };
      turns.set(`${input.workspaceId}\0${input.executionId}`, next);
      // The kernel records a 'turn' checkpoint row at turn start; mirror that
      // so listCheckpoints surfaces turn checkpoints like the real store.
      const values = checkpointSummaries(input.workspaceId);
      if (!values.some((entry) => (entry as { id?: string }).id === next.checkpointId)) {
        values.unshift({
          id: next.checkpointId,
          workspaceId: input.workspaceId,
          sequence: values.length + 1,
          source: "turn",
          state: "pending",
          createdAt: new Date().toISOString(),
          changedPathCount: 0,
          byteLength: 0,
        });
      }
      return turnBinding(next) as never;
    },
    async resolveEntry(input) {
      const turn = [...turns.values()]
        .filter((candidate) => candidate.workspaceId === input.workspaceId && candidate.sessionId === input.sessionId)
        .find((candidate) => candidate.userEntryId === input.entryId || candidate.assistantEntryId === input.entryId);
      if (!turn) {
        return { status: "unbound", reason: "entry-unbound" } as never;
      }
      const summary = (checkpoints.get(input.workspaceId) ?? [])
        .find((entry) => (entry as { id?: string }).id === turn.checkpointId);
      if (!summary) {
        return { status: "unbound", reason: "entry-unbound" } as never;
      }
      return {
        binding: turnBinding(turn),
        checkpoint: clone(summary),
        position: "after",
        status: "ready",
      } as never;
    },
    async health() { return { blobs: 0, catalogBytes: 0, walBytes: 0 }; },
    async collectUnreachableObjects() { return { byteLengthReclaimed: 0, objectsDeleted: 0 }; },
  };
};
