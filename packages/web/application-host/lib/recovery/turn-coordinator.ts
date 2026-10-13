import { createWorkspaceRecoveryAPI } from '@varin/extension-contract';
import { toolMutation } from '@varin/protocol';
import type {
  PiSessionExecutionAdmissionRequest,
} from '@varin/runtime-broker';

interface WriterOwner {
  kind?: string;
  id?: string;
  generation?: number;
}

interface Writer {
  writerId: string;
  mode?: string;
  owner?: WriterOwner;
}

interface MutationState {
  activeWriters: Writer[];
  [key: string]: unknown;
}

interface SessionSnapshot {
  workspace?: { kind: string; id?: string; authorityId?: string };
  [key: string]: unknown;
}

interface TurnRecord {
  activeWriterScopes: string[];
  agentStarted: boolean;
  bindingIds: string[];
  eventTail: Promise<unknown>;
  executionId: string;
  finalizing: Promise<void> | null;
  lastAssistantEntryId: string | undefined;
  provenance: 'observed-during' | 'overlapped';
  recordedMutation: boolean;
  runtimeGeneration: number;
  sessionId: string;
  userEntryCount: number;
  unjournalledTool: boolean;
  workerId: string;
  workspaceId: string;
}

export type AdmitRequest = PiSessionExecutionAdmissionRequest;

export interface MutationRequest {
  sessionId: string;
  requestId: string;
  path: string;
  toolCallId: string;
  toolName: string;
  phase: string;
  succeeded?: boolean;
  [key: string]: unknown;
}

export interface HostEvent {
  envelope?: {
    data?: unknown;
    event?: string | undefined;
    kind?: string | undefined;
  } | undefined;
  executionId?: string | undefined;
  kind: string;
  sessionId?: string | undefined;
  workerId?: string | undefined;
}

export interface WriterLease {
  close: () => Promise<void>;
}

export interface WriterTracker {
  admit(request: AdmitRequest): Promise<WriterLease | null>;
  waitForIdle(workerId: string): Promise<{
    mutationObserved?: boolean;
    coverageComplete?: boolean;
    changedResourceIds?: string[];
  } | null>;
}

export interface RecoveryServiceRequest extends Record<string, unknown> {
  args: unknown[];
  method: string;
}

export interface TurnCoordinatorOptions {
  documents: {
    inspectMutation(workspaceId: string): Promise<MutationState>;
  };
  getSessionSnapshot: (sessionId: string) => SessionSnapshot | null;
  invokeService: (request: RecoveryServiceRequest) => Promise<unknown>;
  respondMutation: (request: MutationRequest, accepted: boolean) => Promise<void>;
  /**
   * Report a completed native tool write. It is awaited before the tool is
   * acknowledged, so the next read in the same turn cannot still be answered
   * from a draft captured before the write (D-088).
   */
  observeToolWrite?: (workspaceId: string, absolutePath: string) => Promise<void> | void;
  writerTracker: WriterTracker;
}

export interface TurnCoordinator {
  admit(request: AdmitRequest): Promise<WriterLease | null>;
  processEvent(event: HostEvent): Promise<unknown>;
  dispose(): Promise<void>;
}

const writerScope = (writer: Writer): string => {
  const generation = writer.owner?.generation === undefined ? '' : `@${writer.owner.generation}`;
  const mode = writer.mode || 'controlled';
  return `${mode}/${writer.owner?.kind || 'writer'}:${writer.owner?.id || writer.writerId}${generation}`;
};

const incompleteFailure = (message: string) => ({
  code: 'checkpoint-incomplete',
  message,
  retryable: false,
});

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const isBoundWorkspace = (workspace: unknown): workspace is { kind: string; id: string; authorityId?: string } => (
  (workspace as { kind?: string })?.kind === 'workspace'
  && typeof (workspace as { id?: string }).id === 'string'
  && !!(workspace as { id?: string }).id
);

const reportFailure = (turn: TurnRecord, stage: string, failure: unknown): void => {
  console.warn(
    `[WorkspaceRecovery] ${stage} failed for session ${turn.sessionId} `
    + `(execution ${turn.executionId}, workspace ${turn.workspaceId}): `
    + ((failure as Error)?.message || String(failure || 'unknown failure')),
  );
};

export const createRecoveryTurnCoordinator = ({
  documents,
  getSessionSnapshot,
  invokeService,
  respondMutation,
  observeToolWrite,
  writerTracker,
}: TurnCoordinatorOptions): TurnCoordinator => {
  const pending = new Map<string, TurnRecord>();
  let disposed = false;

  const apiFor = (turn: TurnRecord) => createWorkspaceRecoveryAPI(((request: RecoveryServiceRequest) => invokeService({
    ...request,
    routing: {
      invocationId: turn.executionId,
      runtimeId: String(turn.runtimeGeneration),
      sessionId: turn.sessionId,
      workspaceId: turn.workspaceId,
    },
  })) as never);

  const inspectScopes = async (workspaceId: string): Promise<{ scopes: string[]; state: MutationState }> => {
    const state = await documents.inspectMutation(workspaceId);
    return {
      scopes: state.activeWriters.map(writerScope),
      state,
    };
  };

  const recordStart = async (
    turn: TurnRecord,
    executionId: string,
    userEntryId: string,
    failure: { code: string; message: string; retryable: boolean } | undefined,
  ): Promise<void> => {
    try {
      const result = await apiFor(turn).recordTurnStart({
        activeWriterScopes: [...turn.activeWriterScopes],
        executionId,
        ...(failure ? { failure } : {}),
        provenance: turn.provenance,
        runtimeGeneration: turn.runtimeGeneration,
        conversation: { kind: 'pi', sessionId: turn.sessionId },
        userEntryId,
        workerId: turn.workerId,
        workspaceId: turn.workspaceId,
      } as never) as { status: string; failure?: unknown };
      if (result.status === 'ready') turn.bindingIds.push(executionId);
      else reportFailure(turn, 'turn binding start', result.failure);
    } catch (error) {
      reportFailure(turn, 'turn binding start', error);
    }
  };

  const settleBinding = async (
    turn: TurnRecord,
    executionId: string,
    input: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const result = await apiFor(turn).recordTurnSettled({
        activeWriterScopes: [...turn.activeWriterScopes],
        executionId,
        provenance: turn.provenance,
        workspaceId: turn.workspaceId,
        ...input,
      } as never) as { status: string; failure?: unknown };
      if (result.status === 'failed') reportFailure(turn, 'turn binding settlement', result.failure);
    } catch (error) {
      reportFailure(turn, 'turn binding settlement', error);
    }
  };

  const finalize = async (turn: TurnRecord, failureOverride?: { code: string; message: string; retryable: boolean }): Promise<void> => {
    if (turn.finalizing) return turn.finalizing;
    turn.finalizing = (async () => {
      const mutationSummary = await writerTracker.waitForIdle(turn.workerId);
      const afterMutation = await inspectScopes(turn.workspaceId).catch(() => null);
      if (afterMutation) {
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...afterMutation.scopes,
        ])].sort();
        if (afterMutation.state.activeWriters.length > 0) turn.provenance = 'overlapped';
      }
      const lastBindingId = turn.bindingIds.at(-1);
      for (const executionId of turn.bindingIds) {
        if (executionId !== lastBindingId) {
          await settleBinding(turn, executionId, {
            failure: incompleteFailure('A queued user turn did not receive an independent mutation journal'),
            mutationObserved: true,
            observationComplete: false,
            observedResourceIds: [],
          });
          continue;
        }
        await settleBinding(turn, executionId, {
          ...(turn.lastAssistantEntryId ? { assistantEntryId: turn.lastAssistantEntryId } : {}),
          ...(failureOverride ? { failure: failureOverride } : {}),
          mutationObserved: mutationSummary?.mutationObserved === true
            || turn.recordedMutation
            || (turn.unjournalledTool && mutationSummary?.coverageComplete !== true),
          observationComplete: mutationSummary?.coverageComplete === true,
          observedResourceIds: mutationSummary?.changedResourceIds ?? [],
        });
      }
      pending.delete(turn.executionId);
    })();
    return turn.finalizing;
  };

  const handleMutationRequest = async (turn: TurnRecord | null, request: MutationRequest): Promise<void> => {
    let accepted = false;
    try {
      if (!turn || request.sessionId !== turn.sessionId) return;
      const api = apiFor(turn);
      const input = {
        executionId: turn.executionId,
        mutationId: request.requestId,
        path: request.path,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        workspaceId: turn.workspaceId,
      };
      const result = request.phase === 'before'
        ? await api.recordMutationBefore(input as never) as { status: string; recorded?: boolean; failure?: unknown }
        : await api.recordMutationAfter({ ...input, succeeded: request.succeeded === true } as never) as { status: string; recorded?: boolean; failure?: unknown };
      accepted = result.status === 'ready' && result.recorded === true;
      if (accepted && request.phase === 'after') turn.recordedMutation = true;
      else if (result.status === 'failed') reportFailure(turn, `mutation ${request.phase}`, result.failure);
    } catch (error) {
      if (turn) reportFailure(turn, `mutation ${request.phase}`, error);
    } finally {
      // Journal coverage can fail without changing the fact that the file was
      // written, so this follows the tool outcome rather than `accepted`.
      if (turn && request.phase === 'after' && request.succeeded === true && observeToolWrite) {
        try {
          await observeToolWrite(turn.workspaceId, request.path);
        } catch (error) {
          reportFailure(turn, 'mutation source invalidation', error);
        }
      }
      await respondMutation(request, accepted).catch((error) => {
        if (turn) reportFailure(turn, 'mutation response', error);
      });
    }
  };

  return {
    async admit(request: AdmitRequest): Promise<WriterLease | null> {
      if (disposed) throw new Error('Recovery turn coordinator is disposed');
      if (request.phase !== 'agent-run' || !request.sessionId) return writerTracker.admit(request);
      const workspace = request.workspace ?? getSessionSnapshot(request.sessionId)?.workspace;
      if (!isBoundWorkspace(workspace)) return writerTracker.admit(request);
      const workspaceId = workspace.authorityId ?? workspace.id;
      const turn: TurnRecord = {
        activeWriterScopes: [],
        agentStarted: false,
        bindingIds: [],
        eventTail: Promise.resolve(),
        executionId: request.executionId,
        finalizing: null,
        lastAssistantEntryId: undefined,
        provenance: 'observed-during',
        recordedMutation: false,
        runtimeGeneration: request.runtimeGeneration,
        sessionId: request.sessionId,
        userEntryCount: 0,
        unjournalledTool: false,
        workerId: request.workerId,
        workspaceId,
      };
      const before = await inspectScopes(workspaceId).catch(() => null);
      if (before) turn.activeWriterScopes = before.scopes;
      const writerLease = await writerTracker.admit(request);
      const admitted = await inspectScopes(workspaceId).catch(() => null);
      if (admitted) {
        turn.activeWriterScopes = [...new Set([
          ...turn.activeWriterScopes,
          ...admitted.scopes,
        ])].sort();
        const foreignWriters = admitted.state.activeWriters.filter((writer: Writer) => (
          writer.owner?.kind !== 'pi-worker' || writer.owner?.id !== request.workerId
        ));
        if (foreignWriters.length > 0) turn.provenance = 'overlapped';
      }
      pending.set(request.executionId, turn);
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          await writerLease?.close();
        },
      };
    },

    processEvent(event: HostEvent): Promise<unknown> {
      const executionId = event?.executionId;
      const turn = executionId ? pending.get(executionId) ?? null : null;
      if (event?.kind === 'host' && event.envelope?.event === 'workspace.mutation.request') {
        const request = event.envelope.data as MutationRequest;
        const handle = (): Promise<void> => handleMutationRequest(turn, request);
        if (!turn) return handle();
        turn.eventTail = turn.eventTail.then(handle, handle);
        return turn.eventTail;
      }
      if (!turn) return Promise.resolve();
      const handle = async (): Promise<void> => {
        if (event.kind === 'worker.exit') {
          return finalize(turn, incompleteFailure('Pi worker exited before the turn settled'));
        }
        if (event.kind !== 'host' || event.envelope?.event !== 'agent.event') return;
        const agentEvent = recordOf(recordOf(event.envelope.data).event);
        if (agentEvent?.type === 'agent_start') turn.agentStarted = true;
        if (agentEvent?.type === 'tool_execution_start') {
          const mutation = toolMutation(agentEvent.toolName as string);
          if (mutation === 'process' || mutation === 'unknown') turn.unjournalledTool = true;
        }
        if (agentEvent?.type === 'entry_appended' && (agentEvent.entry as Record<string, unknown>)?.type === 'message') {
          const entry = agentEvent.entry as Record<string, unknown>;
          const message = entry.message as Record<string, unknown> | undefined;
          if (message?.role === 'user') {
            turn.userEntryCount += 1;
            const bindingId = turn.userEntryCount === 1
              ? turn.executionId
              : `${turn.executionId}:${entry.id as string}`;
            await recordStart(
              turn,
              bindingId,
              entry.id as string,
              turn.userEntryCount === 1
                ? undefined
                : incompleteFailure('Queued user turn has no independently paused mutation journal'),
            );
          } else if (message?.role === 'assistant') {
            turn.lastAssistantEntryId = entry.id as string;
          }
        }
        if (agentEvent?.type === 'agent_settled') await finalize(turn);
      };
      turn.eventTail = turn.eventTail.then(handle, handle);
      return turn.eventTail;
    },

    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...pending.values()].map((turn) => (
        finalize(turn, incompleteFailure('Application Host stopped before the turn settled'))
      )));
      pending.clear();
    },
  };
};
