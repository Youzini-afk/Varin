import type {
  ImageAttachment,
  ModelDescriptor,
  PiAgentEvent,
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionFeatureMutation,
  PiSessionFeatureState,
  RecoveryMode,
  RecoveryOperationResult,
  RuntimeEventEnvelope,
  RuntimeMethod,
  RuntimeMethodParams,
  RuntimeMethodResult,
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  SessionTreeResult,
  SessionWorkspaceBinding,
  ThinkingLevel,
  JsonValue,
  PiUserMessage,
  AgentInputContext,
  WorkFocusId,
} from '@varin/protocol';
import type { PiRuntimeClient, RuntimeSequenceGap } from '@varin/runtime-client';
import { PiRuntimeAmbiguousRequestError, PiRuntimeRequestTimeoutError } from '@varin/runtime-client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import {
  getPiRuntimeConnection,
  subscribePiRuntimeConnectionPhase,
  subscribePiRuntimeReconnected,
  subscribePiRuntimeProtocolError,
  subscribePiRuntimeSequenceGap,
  type PiRuntimeConnection,
  type PiRuntimeConnectionPhase,
} from '@/lib/pi-runtime/client';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import {
  captureSurfaceAgentInputContext,
  releaseSurfaceAgentInputContext,
} from '@/lib/pi-runtime/agent-input-context';
import {
  armPiTimelineTurn,
  cancelPiTimelineAutomation,
  clearPiTimelineSubmissionAnchor,
  completePiTimelineReturn,
  DEFAULT_PI_TIMELINE_VIEW,
  liveUserTurnId,
  persistedUserTurnId,
  preparePiTimelineEnd,
  preparePiTimelineEntry,
  remapPiTimelineAnchor,
  requestPiTimelineReturn,
  savePiTimelineCheckpoint,
  type PiTimelineViewportAnchor,
  type PiTimelineViewState,
} from '@/lib/pi-runtime/piTimelineScrollState';
import { assistantMessageKey } from '@/lib/pi-runtime/usagePresentation';
import { isPiAbortError } from '@/lib/pi-runtime/abort';

export interface PiToolExecutionState {
  args: JsonValue;
  isError?: boolean;
  name: string;
  partialResult?: JsonValue;
  result?: JsonValue;
  status: 'running' | 'success' | 'error';
  toolCallId: string;
}

export type PiSessionSubmissionMode = 'followUp' | 'prompt' | 'steer';
export type PiSessionSubmissionStatus =
  | 'preparing'
  | 'dispatching'
  | 'accepted'
  | 'uncertain'
  | 'failed';

export interface PiSessionSubmissionState {
  dispatchedText?: string;
  entryIdsAtSubmit: ReadonlySet<string>;
  error?: string;
  id: string;
  message: PiUserMessage;
  mode: PiSessionSubmissionMode;
  status: PiSessionSubmissionStatus;
}

export interface PiSessionViewState {
  activityStartedAt?: number;
  assistantOutputDurationsMs?: Record<string, number>;
  assistantOutputStartedAt?: Record<string, number>;
  allEntries?: SessionEntriesResult;
  branchEntries?: SessionEntriesResult;
  branchEntriesSource?: 'live' | 'preview';
  /** Live read-only view of auxiliary compaction workers; completed traces also live in Pi entries. */
  compactionTraces?: Record<string, import('@varin/protocol').CompactionTrace & {
    status: 'running' | 'finished' | 'failed';
    error?: string;
    partial?: { text: string; thinking: string };
  }>;
  extensionStates: Record<string, JsonValue>;
  lastAgentEvent?: PiAgentEvent;
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  open: boolean;
  previewError?: string;
  previewLoading?: boolean;
  sessionId: string;
  settledActivityDurationMs?: number;
  snapshot?: SessionSnapshot;
  stats?: SessionStats;
  /**
   * Frozen copy of the live assistant at the moment a stop was requested.
   * Authoritative events keep updating liveAssistant underneath; the frozen
   * copy is what the timeline renders until the stop settles, so late provider
   * chunks are preserved in state without appearing to continue streaming.
   */
  stoppedAssistant?: PiAssistantMessage;
  /**
   * A pending stop request whose transport outcome is unknown, or that has
   * been accepted by the host but not yet observed to settle.
   */
  stopState?: 'requested' | 'accepted' | 'unknown';
  submission?: PiSessionSubmissionState;
  /** Last authoritative resync outcome for this record. */
  syncState?: 'synced' | 'catchingUp' | 'stale';
  toolExecutions: Record<string, PiToolExecutionState>;
  view?: PiTimelineViewState;
}

export type PiSessionAttentionKind = 'complete' | 'error';

export interface PiSessionAttentionState {
  kind: PiSessionAttentionKind;
  updatedAt: number;
}

export type PiSessionRuntimeClient = Pick<PiRuntimeClient, 'request' | 'subscribe'>;

export interface PiSessionRuntimeConnection {
  client: PiSessionRuntimeClient;
  runtimeKey: string;
}

export interface PiSessionStoreRuntime {
  connect(): Promise<PiSessionRuntimeConnection>;
  currentKey(): string;
  subscribeChanged(listener: () => void): () => void;
  /** Connection lifecycle notifications for connection-state presentation. */
  subscribeConnectionPhase?(listener: (phase: PiRuntimeConnectionPhase) => void): () => void;
  /** Fires after a lost connection is replaced by a live one; triggers resync. */
  subscribeReconnected?(listener: (connection: PiRuntimeConnection) => void): () => void;
  /** Per-worker event sequence gaps detected by the client. */
  subscribeSequenceGap?(listener: (gap: RuntimeSequenceGap) => void): () => void;
  /** A decoded frame or subscriber failed while the transport stayed connected. */
  subscribeProtocolError?(listener: (error: Error) => void): () => void;
}

export interface PiSessionStoreState {
  attentionBySession: Record<string, PiSessionAttentionState>;
  catalogCwd: string | null;
  catalogLoaded: boolean;
  catalogLoading: boolean;
  /** Transport lifecycle; distinct from per-record syncState (catch-up progress). */
  connectionPhase: PiRuntimeConnectionPhase;
  currentSessionId: string | null;
  lastError: string | null;
  openingSessionId: string | null;
  records: Record<string, PiSessionViewState>;
  runtimeKey: string;
  summaries: SessionSummary[];

  abort(sessionId: string): Promise<boolean>;
  beginSubmission(
    sessionId: string,
    message: PiUserMessage,
    mode: PiSessionSubmissionMode,
  ): string;
  archiveSession(sessionId: string): Promise<SessionSummary>;
  closeSession(sessionId: string): Promise<boolean>;
  clearQueue(sessionId: string): Promise<boolean>;
  clearSubmission(sessionId: string, submissionId: string): void;
  cancelTimelineAutomation(sessionId: string): void;
  compactSession(
    sessionId: string,
    customInstructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<RuntimeMethodResult<'agent.compact'>>;
  completeTimelineReturn(sessionId: string, token: number): void;
  clearSessionAttention(sessionId: string): void;
  createSession(
    cwd: string,
    name?: string,
    parentSession?: string,
    workspace?: SessionWorkspaceBinding,
    workFocus?: WorkFocusId,
  ): Promise<SessionSnapshot>;
  deleteSession(sessionId: string): Promise<boolean>;
  executeCommand(sessionId: string, command: string): Promise<JsonValue>;
  followUp(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  forkSession(
    sessionId: string,
    entryId: string,
    position?: 'before' | 'at',
  ): Promise<RuntimeMethodResult<'session.fork'>>;
  getSessionTree(sessionId: string): Promise<SessionTreeResult>;
  loadCatalog(cwd?: string): Promise<SessionSummary[]>;
  mutateFeatures(
    sessionId: string,
    mutation: PiSessionFeatureMutation,
    expectedRuntimeKey?: string,
  ): Promise<PiSessionFeatureState>;
  navigateSession(
    sessionId: string,
    targetId: string,
    summarize?: boolean,
  ): Promise<RuntimeMethodResult<'session.navigate'>>;
  openSession(params: RuntimeMethodParams<'session.open'>): Promise<SessionSnapshot>;
  prefetchSession(sessionId: string, cwd?: string): Promise<SessionEntriesResult>;
  prompt(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  recoverTo(
    sessionId: string,
    targetId: string,
    mode: Extract<RecoveryMode, 'conversation'>,
    summarize?: boolean,
  ): Promise<RecoveryOperationResult>;
  refreshEntries(
    sessionId: string,
    scope?: 'branch' | 'all',
  ): Promise<SessionEntriesResult>;
  refreshStats(sessionId: string): Promise<SessionStats>;
  /**
   * Read-only authoritative catch-up: re-reads the catalog plus per-session
   * an atomic session cut after a reconnect or detected event gap. Never
   * resubmits prompts, tools, or other side-effecting operations.
   */
  resyncSessions(): Promise<void>;
  /** Cheap authority probe for a visible busy session; reconciles only on divergence. */
  probeBusySession(sessionId: string): Promise<void>;
  requestTimelineReturn(sessionId: string): number;
  renameSession(sessionId: string, name: string): Promise<void>;
  reset(): void;
  selectModel(sessionId: string, model: Pick<ModelDescriptor, 'id' | 'provider'>): Promise<SessionSnapshot>;
  selectThinking(sessionId: string, level: ThinkingLevel): Promise<SessionSnapshot>;
  selectWorkFocus(sessionId: string, workFocus: WorkFocusId): Promise<SessionSnapshot>;
  saveTimelineCheckpoint(
    sessionId: string,
    entryEpoch: number,
    observedLeafId: string | null,
    viewport?: PiTimelineViewportAnchor,
  ): void;
  setCurrentSession(sessionId: string | null): void;
  steer(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
    expectedRuntimeKey?: string,
  ): Promise<boolean>;
  unarchiveSession(sessionId: string): Promise<SessionSummary>;
  updateSubmission(
    sessionId: string,
    submissionId: string,
    update: Pick<PiSessionSubmissionState, 'status'>
      & Partial<Pick<PiSessionSubmissionState, 'dispatchedText' | 'error'>>,
  ): void;
}

export type PiSessionStore = UseBoundStore<StoreApi<PiSessionStoreState>>;

const DEFAULT_RUNTIME: PiSessionStoreRuntime = {
  connect: getPiRuntimeConnection,
  currentKey: getRuntimeKey,
  subscribeChanged: subscribeRuntimeEndpointChanged,
  subscribeConnectionPhase: subscribePiRuntimeConnectionPhase,
  subscribeReconnected: subscribePiRuntimeReconnected,
  subscribeProtocolError: subscribePiRuntimeProtocolError,
  subscribeSequenceGap: subscribePiRuntimeSequenceGap,
};

const canonicalWorkspaceBinding = async (
  cwd: string,
  workspace: SessionWorkspaceBinding | undefined,
): Promise<SessionWorkspaceBinding | undefined> => {
  if (workspace?.kind !== 'workspace') return workspace;
  const documents = getRegisteredRuntimeAPIs()?.documents;
  if (!documents) return workspace;
  try {
    const identity = await documents.resolveWorkspace({ path: cwd });
    return { ...workspace, authorityId: identity.workspaceId };
  } catch {
    return workspace;
  }
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const markAssistantAborted = (message: PiAssistantMessage): PiAssistantMessage => {
  const { errorMessage: _errorMessage, ...rest } = message;
  return { ...rest, stopReason: 'aborted' };
};

const sortSummaries = (summaries: SessionSummary[]): SessionSummary[] => (
  [...summaries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
);

type PiSessionCatalogPartitions = {
  active: readonly SessionSummary[];
  archived: readonly SessionSummary[];
};

// Zustand 5 requires selector outputs to keep the same identity while their
// source snapshot is unchanged. The readonly contract protects that cache.
const catalogPartitionsBySummaries = new WeakMap<SessionSummary[], PiSessionCatalogPartitions>();

const partitionPiSessionCatalog = (summaries: SessionSummary[]): PiSessionCatalogPartitions => {
  const cached = catalogPartitionsBySummaries.get(summaries);
  if (cached) return cached;

  const partitions = {
    active: [] as SessionSummary[],
    archived: [] as SessionSummary[],
  };
  for (const summary of summaries) {
    if (summary.archivedAt === undefined) partitions.active.push(summary);
    else partitions.archived.push(summary);
  }
  catalogPartitionsBySummaries.set(summaries, partitions);
  return partitions;
};

export const selectActivePiSessions = (state: PiSessionStoreState): readonly SessionSummary[] => (
  partitionPiSessionCatalog(state.summaries).active
);

export const selectArchivedPiSessions = (state: PiSessionStoreState): readonly SessionSummary[] => (
  partitionPiSessionCatalog(state.summaries).archived
);

export const selectCurrentPiSession = (
  state: PiSessionStoreState,
): PiSessionViewState | undefined => (
  state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
);

export const isPiSessionWorkerReady = (
  record: PiSessionViewState | undefined,
): record is PiSessionViewState & { snapshot: SessionSnapshot } => (
  record?.open === true && record.snapshot !== undefined
);

const piAgentEventAttentionKind = (
  event: PiAgentEvent,
): PiSessionAttentionKind | null => {
  if (event.type === 'auto_retry_end' && !event.success && event.finalError) return 'error';
  if (event.type !== 'agent_end' || event.willRetry) return null;
  const lastAssistant = [...event.messages]
    .reverse()
    .find((message): message is PiAssistantMessage => message.role === 'assistant');
  if (!lastAssistant || lastAssistant.stopReason === 'aborted') return null;
  return lastAssistant.stopReason === 'error' ? 'error' : 'complete';
};

const clearAttention = (
  attentionBySession: Record<string, PiSessionAttentionState>,
  sessionId: string,
): Record<string, PiSessionAttentionState> => {
  if (!(sessionId in attentionBySession)) return attentionBySession;
  const next = { ...attentionBySession };
  delete next[sessionId];
  return next;
};

const isPiSessionActivelyVisible = (
  sessionId: string,
  currentSessionId: string | null,
): boolean => (
  currentSessionId === sessionId
  && (typeof document === 'undefined' || (
    document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus())
  ))
);

const emptySession = (sessionId: string): PiSessionViewState => ({
  extensionStates: {},
  open: false,
  sessionId,
  toolExecutions: {},
  view: { ...DEFAULT_PI_TIMELINE_VIEW },
});

let submissionSequence = 0;

const nextSubmissionId = (): string => {
  submissionSequence += 1;
  return `submission-${Date.now().toString(36)}-${submissionSequence.toString(36)}`;
};

const updateSnapshot = (
  snapshot: SessionSnapshot | undefined,
  patch: Partial<SessionSnapshot>,
): SessionSnapshot | undefined => (
  snapshot === undefined ? undefined : { ...snapshot, ...patch }
);

const snapshotIsWorking = (snapshot: SessionSnapshot | undefined): boolean => (
  snapshot?.busy === true
  || snapshot?.isStreaming === true
  || snapshot?.isCompacting === true
  || (snapshot?.retryAttempt ?? 0) > 0
);

const preserveSnapshotWorkspace = (
  incoming: SessionSnapshot,
  current: SessionSnapshot | undefined,
): SessionSnapshot => (
  incoming.workspace !== undefined || current?.workspace === undefined
    ? incoming
    : {
        ...incoming,
        workspace: current.workspace,
        ...(current.workspacePersistence === undefined
          ? {}
          : { workspacePersistence: current.workspacePersistence }),
      }
);

const settleInterruptedSession = (
  current: PiSessionViewState,
  now = Date.now(),
): PiSessionViewState => {
  const next: PiSessionViewState = {
    ...current,
    liveAssistant: current.liveAssistant?.stopReason === 'pending'
      ? { ...current.liveAssistant, errorMessage: 'Pi session worker exited', stopReason: 'error' }
      : current.liveAssistant,
    open: false,
    snapshot: updateSnapshot(current.snapshot, {
      busy: false,
      isCompacting: false,
      isStreaming: false,
      retryAttempt: 0,
    }),
    toolExecutions: Object.fromEntries(Object.entries(current.toolExecutions).map(([id, execution]) => [
      id,
      execution.status === 'running'
        ? { ...execution, isError: true, status: 'error' as const }
        : execution,
    ])),
  };
  delete next.liveUser;
  if (current.activityStartedAt !== undefined) {
    next.settledActivityDurationMs = Math.max(0, now - current.activityStartedAt);
    delete next.activityStartedAt;
  } else if (current.snapshot?.busy) {
    delete next.settledActivityDurationMs;
  }
  return next;
};

const appendEntry = (
  result: SessionEntriesResult | undefined,
  entry: PiSessionEntry,
  fallback?: Pick<SessionEntriesResult, 'scope' | 'sessionId'>,
): SessionEntriesResult | undefined => {
  if (result === undefined) {
    if (fallback === undefined) return undefined;
    return {
      entries: [entry],
      leafId: entry.id,
      scope: fallback.scope,
      sessionId: fallback.sessionId,
    };
  }
  const index = result.entries.findIndex((candidate) => candidate.id === entry.id);
  const entries = index === -1
    ? [...result.entries, entry]
    : result.entries.map((candidate, candidateIndex) => (
        candidateIndex === index ? entry : candidate
      ));
  return { ...result, entries, leafId: entry.id };
};

const mergeEntriesArrivingDuringRequest = (
  incoming: SessionEntriesResult,
  current: SessionEntriesResult | undefined,
  appendedEntryIds: ReadonlySet<string>,
): SessionEntriesResult => {
  if (current === undefined || appendedEntryIds.size === 0) return incoming;
  const currentAppended = new Map(current.entries
    .filter((entry) => appendedEntryIds.has(entry.id))
    .map((entry) => [entry.id, entry]));
  if (currentAppended.size === 0) return incoming;
  const entries = incoming.entries.map((entry) => currentAppended.get(entry.id) ?? entry);
  const incomingIds = new Set(entries.map((entry) => entry.id));
  for (const entry of currentAppended.values()) {
    if (!incomingIds.has(entry.id)) entries.push(entry);
  }
  return {
    ...incoming,
    entries,
    leafId: current.leafId ?? incoming.leafId,
  };
};

export const reducePiAgentEvent = (
  current: PiSessionViewState,
  event: PiAgentEvent,
  now = Date.now(),
): PiSessionViewState => {
  const next: PiSessionViewState = { ...current, lastAgentEvent: event };

  switch (event.type) {
    case 'agent_start':
      next.activityStartedAt = current.activityStartedAt ?? now;
      delete next.settledActivityDurationMs;
      next.snapshot = updateSnapshot(current.snapshot, {
        busy: true,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
      });
      if (
        current.submission?.mode === 'prompt'
        && (current.submission.status === 'preparing' || current.submission.status === 'dispatching')
      ) {
        next.submission = { ...current.submission, status: 'accepted' };
      }
      return next;
    case 'agent_settled':
      if (current.activityStartedAt !== undefined) {
        next.settledActivityDurationMs = Math.max(0, now - current.activityStartedAt);
        delete next.activityStartedAt;
      } else if (current.snapshot?.busy) {
        delete next.settledActivityDurationMs;
      }
      next.snapshot = updateSnapshot(current.snapshot, {
        busy: false,
        isCompacting: false,
        isStreaming: false,
        retryAttempt: 0,
      });
      if (current.assistantOutputStartedAt && Object.keys(current.assistantOutputStartedAt).length > 0) {
        next.assistantOutputDurationsMs = {
          ...(current.assistantOutputDurationsMs ?? {}),
          ...Object.fromEntries(Object.entries(current.assistantOutputStartedAt).map(([key, startedAt]) => [
            key,
            Math.max(0, now - startedAt),
          ])),
        };
        delete next.assistantOutputStartedAt;
      }
      delete next.liveUser;
      return next;
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const message = event.message;
      if (message.role === 'user') {
        next.liveUser = message;
        if (current.submission && current.view?.newTurn) {
          next.view = remapPiTimelineAnchor(current.view, liveUserTurnId(message.timestamp));
        }
        delete next.submission;
        return next;
      }
      if (message.role === 'assistant') {
        const key = assistantMessageKey(message);
        if (event.type === 'message_start') {
          if (current.assistantOutputStartedAt?.[key] === undefined) {
            next.assistantOutputStartedAt = {
              ...(current.assistantOutputStartedAt ?? {}),
              [key]: now,
            };
          }
        } else if (event.type === 'message_end') {
          const startedEntries = Object.entries(current.assistantOutputStartedAt ?? {});
          const startedAt = current.assistantOutputStartedAt?.[key] ?? startedEntries[0]?.[1];
          if (startedAt !== undefined) {
            const started = { ...(current.assistantOutputStartedAt ?? {}) };
            delete started[current.assistantOutputStartedAt?.[key] !== undefined ? key : startedEntries[0]?.[0] ?? key];
            next.assistantOutputStartedAt = started;
            next.assistantOutputDurationsMs = {
              ...(current.assistantOutputDurationsMs ?? {}),
              [key]: Math.max(0, now - startedAt),
            };
          }
        }
      }
      if (
        message.role === 'assistant'
        && ![current.branchEntries, current.allEntries].some((result) => (
          result?.entries.some((entry) => (
            entry.type === 'message'
            && entry.message.role === 'assistant'
            && entry.message.timestamp === message.timestamp
            && entry.message.provider === message.provider
            && entry.message.model === message.model
          ))
        ))
      ) next.liveAssistant = message;
      return next;
    }
    case 'entry_appended':
      next.branchEntries = appendEntry(current.branchEntries, event.entry);
      next.allEntries = appendEntry(current.allEntries, event.entry);
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'assistant'
        && current.liveAssistant?.timestamp === event.entry.message.timestamp
        && current.liveAssistant.provider === event.entry.message.provider
        && current.liveAssistant.model === event.entry.message.model
      ) {
        delete next.liveAssistant;
      }
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'user'
        && current.liveUser?.timestamp === event.entry.message.timestamp
      ) {
        delete next.liveUser;
      }
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'user'
        && current.submission
        && !current.submission.entryIdsAtSubmit.has(event.entry.id)
      ) {
        delete next.submission;
      }
      if (
        event.entry.type === 'message'
        && event.entry.message.role === 'user'
        && current.view?.newTurn
        && (
          current.submission !== undefined
          || current.liveUser?.timestamp === event.entry.message.timestamp
        )
      ) {
        next.view = remapPiTimelineAnchor(current.view, persistedUserTurnId(event.entry.id));
      }
      return next;
    case 'tool_execution_start':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          args: event.args,
          name: event.toolName,
          status: 'running',
          toolCallId: event.toolCallId,
        },
      };
      return next;
    case 'tool_execution_update':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          ...(current.toolExecutions[event.toolCallId] ?? {
            args: event.args,
            name: event.toolName,
            status: 'running' as const,
            toolCallId: event.toolCallId,
          }),
          args: event.args,
          name: event.toolName,
          partialResult: event.partialResult,
          status: 'running',
        },
      };
      return next;
    case 'tool_execution_end':
      next.toolExecutions = {
        ...current.toolExecutions,
        [event.toolCallId]: {
          ...(current.toolExecutions[event.toolCallId] ?? {
            args: null,
            name: event.toolName,
            toolCallId: event.toolCallId,
          }),
          isError: event.isError,
          name: event.toolName,
          result: event.result,
          status: event.isError ? 'error' : 'success',
        },
      };
      return next;
    case 'queue_update':
      next.snapshot = updateSnapshot(current.snapshot, {
        followUp: [...event.followUp],
        steering: [...event.steering],
      });
      return next;
    case 'thinking_level_changed':
      next.snapshot = updateSnapshot(current.snapshot, { thinkingLevel: event.level });
      return next;
    case 'session_info_changed':
      next.snapshot = updateSnapshot(current.snapshot, { name: event.name });
      return next;
    case 'compaction_start':
      next.snapshot = updateSnapshot(current.snapshot, { isCompacting: true });
      return next;
    case 'compaction_end':
      next.snapshot = updateSnapshot(current.snapshot, { isCompacting: false });
      return next;
    case 'auto_retry_start':
      next.snapshot = updateSnapshot(current.snapshot, { retryAttempt: event.attempt });
      return next;
    case 'auto_retry_end':
      next.snapshot = updateSnapshot(current.snapshot, {
        retryAttempt: event.success ? 0 : event.attempt,
      });
      return next;
    default:
      return next;
  }
};

const upsertRecord = (
  records: Record<string, PiSessionViewState>,
  sessionId: string,
  update: (current: PiSessionViewState) => PiSessionViewState,
): Record<string, PiSessionViewState> => ({
  ...records,
  [sessionId]: update(records[sessionId] ?? emptySession(sessionId)),
});

const upsertSummary = (
  summaries: SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] => sortSummaries([
  summary,
  ...summaries.filter((candidate) => candidate.id !== summary.id),
]);

const initialFields = (runtimeKey: string): Pick<
  PiSessionStoreState,
  | 'attentionBySession'
  | 'catalogCwd'
  | 'catalogLoaded'
  | 'catalogLoading'
  | 'connectionPhase'
  | 'currentSessionId'
  | 'lastError'
  | 'openingSessionId'
  | 'records'
  | 'runtimeKey'
  | 'summaries'
> => ({
  attentionBySession: {},
  catalogCwd: null,
  catalogLoaded: false,
  catalogLoading: false,
  connectionPhase: 'disconnected',
  currentSessionId: null,
  lastError: null,
  openingSessionId: null,
  records: {},
  runtimeKey,
  summaries: [],
});

export const createPiSessionStore = (
  runtime: PiSessionStoreRuntime = DEFAULT_RUNTIME,
  options: { healthProbeIntervalMs?: number } = {},
): PiSessionStore => {
  let activeClient: PiSessionRuntimeClient | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let catalogGeneration = 0;
  let selectionGeneration = 0;
  let storeGeneration = 0;
  const entriesGeneration = new Map<string, number>();
  const entriesAppendedDuringRequest = new Map<string, Set<string>>();
  const previewGeneration = new Map<string, number>();
  const previewAppendedDuringRequest = new Map<string, Set<string>>();
  const previewRequests = new Map<string, Promise<SessionEntriesResult>>();
  const deletingSessionIds = new Set<string>();
  const deletedSessionIds = new Set<string>();
  /** sessionId → stop request lifecycle (requested → accepted → settles, or unknown after a lost reply). */
  type StopRequest = { requestedAt: number; runId?: string; state: 'requested' | 'accepted' | 'unknown' };
  const stopRequests = new Map<string, StopRequest>();
  type SyncFlight = {
    buffer: RuntimeEventEnvelope[];
    generation: number;
    retryRequested: boolean;
    stopRequestAtStart: StopRequest | undefined;
  };
  /** Each flight owns its buffer and may commit only while it remains current. */
  const syncFlights = new Map<string, SyncFlight>();
  const lastAppliedSequences = new Map<string, number>();
  const supersededWorkers = new Map<string, Set<string>>();
  const statsGeneration = new Map<string, number>();

  const store = create<PiSessionStoreState>((set, get) => {
    const contextIsCurrent = (runtimeKey: string): boolean => (
      runtime.currentKey() === runtimeKey && get().runtimeKey === runtimeKey
    );

    const captureInputContext = async (sessionId: string): Promise<AgentInputContext> => {
      return captureSurfaceAgentInputContext(sessionId);
    };

    const commitError = (runtimeKey: string, error: unknown): void => {
      if (contextIsCurrent(runtimeKey)) set({ lastError: errorMessage(error) });
    };

    const beginSelectionIntent = (): number => {
      selectionGeneration += 1;
      set({ openingSessionId: null });
      return selectionGeneration;
    };

    const selectionIntentIsCurrent = (generation: number, runtimeKey: string): boolean => (
      generation === selectionGeneration && contextIsCurrent(runtimeKey)
    );

    const entriesRequestKey = (sessionId: string, scope: 'branch' | 'all'): string => (
      `${sessionId}\u0000${scope}`
    );

    const invalidateSessionHydration = (sessionId: string): void => {
      previewGeneration.set(sessionId, (previewGeneration.get(sessionId) ?? 0) + 1);
      for (const scope of ['branch', 'all'] as const) {
        const requestKey = entriesRequestKey(sessionId, scope);
        entriesGeneration.set(requestKey, (entriesGeneration.get(requestKey) ?? 0) + 1);
      }
    };

    const prepareSessionTimeline = (
      state: PiSessionStoreState,
      sessionId: string,
    ): Record<string, PiSessionViewState> => upsertRecord(
      state.records,
      sessionId,
      (current) => {
        const snapshot = current.snapshot;
        return {
          ...current,
          view: preparePiTimelineEntry(current.view, {
            hasAttention: state.attentionBySession[sessionId] !== undefined,
            hasLiveOverlay: current.liveAssistant !== undefined
              || current.liveUser !== undefined
              || current.submission !== undefined,
            leafId: current.branchEntries?.leafId ?? snapshot?.leafId ?? null,
            working: snapshotIsWorking(snapshot),
          }),
        };
      },
    );

    const reconcileSessionTimelineSnapshot = (
      current: PiSessionViewState,
      snapshot: SessionSnapshot,
      selected: boolean,
    ): PiTimelineViewState | undefined => {
      const view = current.view;
      if (
        !selected
        || !view
        || view.newTurn
        || view.entry.target.kind !== 'turn'
        || view.generation !== view.entry.generation
      ) return view;
      const authoritativeLeafChanged = view.observedLeafId !== undefined
        && view.observedLeafId !== snapshot.leafId;
      const previewLeafChanged = current.branchEntries !== undefined
        && current.branchEntries.leafId !== snapshot.leafId;
      if (!snapshotIsWorking(snapshot) && !authoritativeLeafChanged && !previewLeafChanged) {
        return view;
      }
      return preparePiTimelineEntry(view, {
        hasAttention: false,
        hasLiveOverlay: current.liveAssistant !== undefined
          || current.liveUser !== undefined
          || current.submission !== undefined,
        leafId: snapshot.leafId,
        working: snapshotIsWorking(snapshot),
      });
    };

    /** Session a runtime event belongs to, when it is session-scoped. */
    const envelopeSessionId = (envelope: RuntimeEventEnvelope): string | undefined => {
      if (envelope.source.sessionId !== undefined) return envelope.source.sessionId;
      const data = envelope.data as { sessionId?: unknown };
      return typeof data.sessionId === 'string' ? data.sessionId : undefined;
    };

    const settleStopRequest = (sessionId: string, expected?: StopRequest, observedRunId?: string): void => {
      if (expected !== undefined && stopRequests.get(sessionId) !== expected) return;
      const pending = stopRequests.get(sessionId);
      if (pending?.runId !== undefined && observedRunId !== undefined && pending.runId !== observedRunId) return;
      if (!stopRequests.delete(sessionId)) return;
      set((state) => ({
        records: upsertRecord(state.records, sessionId, (current) => {
          if (current.stoppedAssistant === undefined && current.stopState === undefined) return current;
          const next = { ...current };
          delete next.stoppedAssistant;
          delete next.stopState;
          return next;
        }),
      }));
    };

    const applyRuntimeEvent = (runtimeKey: string, envelope: RuntimeEventEnvelope): void => {
      if (!contextIsCurrent(runtimeKey)) return;
      if (envelope.source.role === 'compaction' && envelope.event === 'compaction.trace') {
        const { sessionId, taskId } = envelope.data;
        if (envelope.source.sessionId !== sessionId) return;
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => {
            const previous = current.compactionTraces?.[taskId];
            const trace = previous ?? { taskId, entries: [], status: 'running' as const };
            const updated = envelope.data.type === 'entry'
              ? { ...trace, entries: [...trace.entries, envelope.data.entry], partial: { text: '', thinking: '' } }
              : envelope.data.type === 'delta'
                ? { ...trace, partial: {
                  text: `${trace.partial?.text ?? ''}${envelope.data.channel === 'text' ? envelope.data.delta : ''}`,
                  thinking: `${trace.partial?.thinking ?? ''}${envelope.data.channel === 'thinking' ? envelope.data.delta : ''}`,
                } }
              : envelope.data.type === 'failed'
                ? { ...trace, status: 'failed' as const, error: envelope.data.message }
                : envelope.data.type === 'finished'
                  ? { ...trace, status: 'finished' as const }
                  : trace;
            return { ...current, compactionTraces: { ...current.compactionTraces, [taskId]: updated } };
          }),
        }));
        return;
      }
      // Catalog workers open short-lived workspace contexts for provider/model
      // operations. Their snapshots are not user sessions and must never enter
      // the session catalog or current-session state.
      if (envelope.source.role !== 'session') return;
      const sessionIdForSource = envelopeSessionId(envelope);
      if (sessionIdForSource !== undefined
        && supersededWorkers.get(sessionIdForSource)?.has(envelope.source.workerId)) return;
      const lastApplied = lastAppliedSequences.get(envelope.source.workerId);
      if (lastApplied !== undefined && envelope.seq <= lastApplied) return;
      lastAppliedSequences.set(envelope.source.workerId, envelope.seq);
      switch (envelope.event) {
        case 'session.snapshot': {
          const snapshot = {
            ...envelope.data,
            eventWorkerId: envelope.source.workerId,
          };
          const previousWorkerId = get().records[snapshot.sessionId]?.snapshot?.eventWorkerId;
          if (previousWorkerId !== undefined && previousWorkerId !== envelope.source.workerId) {
            const stale = supersededWorkers.get(snapshot.sessionId) ?? new Set<string>();
            stale.add(previousWorkerId);
            supersededWorkers.set(snapshot.sessionId, stale);
          }
          set((state) => ({
            records: upsertRecord(state.records, snapshot.sessionId, (current) => {
              const view = reconcileSessionTimelineSnapshot(
                current,
                snapshot,
                state.currentSessionId === snapshot.sessionId,
              );
              return {
                ...current,
                open: true,
                snapshot: preserveSnapshotWorkspace(snapshot, current.snapshot),
                ...(view ? { view } : {}),
              };
            }),
          }));
          // An authoritative idle snapshot settles a pending stop even when the
          // agent_settled event itself was lost.
          if (!snapshot.busy) settleStopRequest(snapshot.sessionId, undefined, snapshot.runId);
          return;
        }
        case 'session.closed': {
          const { sessionId } = envelope.data;
          settleStopRequest(sessionId);
          if (get().currentSessionId === sessionId) beginSelectionIntent();
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, sessionId),
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
          }));
          return;
        }
        case 'session.worker.exited': {
          const { expected, sessionId } = envelope.data;
          settleStopRequest(sessionId);
          set((state) => ({
            attentionBySession: expected || isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? state.attentionBySession
              : {
                  ...state.attentionBySession,
                  [sessionId]: { kind: 'error', updatedAt: Date.now() },
                },
            lastError: expected ? state.lastError : 'Pi session worker exited unexpectedly',
            records: upsertRecord(state.records, sessionId, settleInterruptedSession),
          }));
          return;
        }
        case 'agent.event': {
          const { sessionId, event } = envelope.data;
          const currentRunId = get().records[sessionId]?.snapshot?.runId;
          if (event.type !== 'agent_start' && event.runId !== undefined
            && currentRunId !== undefined && event.runId !== currentRunId) return;
          // agent_start belongs to a new run; a stale stop request must never
          // mark or cancel it. agent_settled is the authoritative stop outcome.
          if (event.type === 'agent_start') {
            const pending = stopRequests.get(sessionId);
            if (pending?.runId === undefined || pending.runId !== event.runId) settleStopRequest(sessionId);
          } else if (event.type === 'agent_settled') {
            settleStopRequest(sessionId, undefined, event.runId);
          }
          const attentionKind = piAgentEventAttentionKind(event);
          if (event.type === 'entry_appended') {
            entriesAppendedDuringRequest.get(entriesRequestKey(sessionId, 'branch'))?.add(event.entry.id);
            entriesAppendedDuringRequest.get(entriesRequestKey(sessionId, 'all'))?.add(event.entry.id);
            previewAppendedDuringRequest.get(sessionId)?.add(event.entry.id);
          }
          set((state) => {
            const records = upsertRecord(state.records, sessionId, (current) => {
              const reduced = reducePiAgentEvent(current, event);
              if (event.type !== 'entry_appended') return reduced;
              const branchKey = entriesRequestKey(sessionId, 'branch');
              const allKey = entriesRequestKey(sessionId, 'all');
              return {
                ...reduced,
                branchEntries: appendEntry(
                  reduced.branchEntries,
                  event.entry,
                  entriesGeneration.has(branchKey)
                    ? { scope: 'branch', sessionId }
                    : undefined,
                ),
                allEntries: appendEntry(
                  reduced.allEntries,
                  event.entry,
                  entriesGeneration.has(allKey)
                    ? { scope: 'all', sessionId }
                    : undefined,
                ),
              };
            });
            if (attentionKind === null) return { records };
            const attentionBySession = isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? clearAttention(state.attentionBySession, sessionId)
              : {
                  ...state.attentionBySession,
                  [sessionId]: { kind: attentionKind, updatedAt: Date.now() },
                };
            return { attentionBySession, records };
          });
          if (event.type === 'agent_settled') {
            void get().refreshEntries(sessionId).catch(() => undefined);
            void get().loadCatalog(get().catalogCwd ?? undefined).catch(() => undefined);
          }
          return;
        }
        case 'recovery.changed': {
          const { sessionId } = envelope.data;
          void get().refreshEntries(sessionId).catch(() => undefined);
          return;
        }
        case 'extension.state': {
          const { channel, sessionId, value } = envelope.data;
          set((state) => ({
            records: upsertRecord(state.records, sessionId, (current) => {
              const extensionStates = { ...current.extensionStates };
              if (value === null) delete extensionStates[channel];
              else extensionStates[channel] = value;
              return { ...current, extensionStates };
            }),
          }));
          return;
        }
        case 'host.error': {
          const sessionId = envelope.source.sessionId;
          set((state) => ({
            attentionBySession: sessionId && !isPiSessionActivelyVisible(sessionId, state.currentSessionId)
              ? {
                  ...state.attentionBySession,
                  [sessionId]: { kind: 'error', updatedAt: Date.now() },
                }
              : state.attentionBySession,
            lastError: envelope.data.message,
          }));
          return;
        }
        default:
          return;
      }
    };

    /**
     * Runtime events for a session are buffered while its authoritative
     * snapshot/entries resync is in flight, then replayed through the normal
     * path once the snapshot lands. This keeps the snapshot and the live
     * stream on one ordering instead of letting a stale read overwrite newer
     * events.
     */
    const handleRuntimeEvent = (runtimeKey: string, envelope: RuntimeEventEnvelope): void => {
      if (!contextIsCurrent(runtimeKey)) return;
      const sessionId = envelopeSessionId(envelope);
      const flight = sessionId === undefined ? undefined : syncFlights.get(sessionId);
      if (flight !== undefined && envelope.source.role === 'session') {
        flight.buffer.push(envelope);
        return;
      }
      applyRuntimeEvent(runtimeKey, envelope);
    };

    const flushCatchUpBuffer = (
      runtimeKey: string,
      sessionId: string,
      flight: SyncFlight,
      watermark: number | undefined,
      watermarkWorkerId: string | undefined,
    ): void => {
      if (syncFlights.get(sessionId) !== flight || flight.generation !== storeGeneration) return;
      syncFlights.delete(sessionId);
      if (watermark !== undefined && watermarkWorkerId !== undefined) {
        lastAppliedSequences.set(watermarkWorkerId,
          Math.max(lastAppliedSequences.get(watermarkWorkerId) ?? -1, watermark - 1));
      }
      for (const bufferedEnvelope of flight.buffer) {
        if (
          watermark !== undefined
          && watermarkWorkerId !== undefined
          && bufferedEnvelope.seq < watermark
          && bufferedEnvelope.source.workerId === watermarkWorkerId
        ) {
          // Already reflected in the authoritative snapshot read.
          continue;
        }
        applyRuntimeEvent(runtimeKey, bufferedEnvelope);
      }
    };

    const collectToolResults = (
      results: Iterable<SessionEntriesResult>,
    ): Map<string, { isError: boolean; result: JsonValue | undefined }> => {
      const toolResults = new Map<string, { isError: boolean; result: JsonValue | undefined }>();
      for (const entries of results) {
        for (const entry of entries.entries) {
          if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
          const message = entry.message;
          toolResults.set(message.toolCallId, {
            isError: message.isError,
            result: (message.details ?? message.content) as JsonValue | undefined,
          });
        }
      }
      return toolResults;
    };

    /** Apply an authoritative snapshot + entries read and settle stale in-flight UI state. */
    const applyResyncSnapshot = (
      runtimeKey: string,
      sessionId: string,
      flight: SyncFlight,
      snapshot: SessionSnapshot,
      entriesByScope: ReadonlyMap<'branch' | 'all', SessionEntriesResult>,
      stats: SessionStats,
    ): void => {
      if (syncFlights.get(sessionId) !== flight || flight.generation !== storeGeneration) return;
      const previousWorkerId = get().records[sessionId]?.snapshot?.eventWorkerId;
      if (snapshot.eventWorkerId !== undefined && previousWorkerId !== undefined
        && snapshot.eventWorkerId !== previousWorkerId) {
        const stale = supersededWorkers.get(sessionId) ?? new Set<string>();
        stale.add(previousWorkerId);
        supersededWorkers.set(sessionId, stale);
      }
      const persistedToolResults = collectToolResults(entriesByScope.values());
      set((state) => ({
        records: upsertRecord(state.records, sessionId, (current) => {
          const next: PiSessionViewState = {
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(snapshot, current.snapshot),
            stats,
            syncState: 'synced',
          };
          for (const [scope, result] of entriesByScope) {
            if (scope === 'all') next.allEntries = result;
            else {
              next.branchEntries = result;
              next.branchEntriesSource = 'live';
              next.previewLoading = false;
              delete next.previewError;
            }
          }
          const persistedMessages = [...entriesByScope.values()].flatMap((result) => result.entries);
          const assistantPersisted = (message: PiAssistantMessage): boolean => (
            persistedMessages.some((entry) => (
              entry.type === 'message'
              && entry.message.role === 'assistant'
              && entry.message.timestamp === message.timestamp
              && entry.message.provider === message.provider
              && entry.message.model === message.model
            ))
          );
          if (snapshot.liveAssistant !== undefined) {
            if (assistantPersisted(snapshot.liveAssistant)) delete next.liveAssistant;
            else next.liveAssistant = snapshot.liveAssistant;
          } else if (current.liveAssistant !== undefined && assistantPersisted(current.liveAssistant)) {
            delete next.liveAssistant;
          } else if (!snapshot.busy) {
            // Settled sessions keep no ghost overlay; persisted truth lives in entries.
            delete next.liveAssistant;
          }
          const pendingToolCallIds = new Set(snapshot.pendingToolCallIds ?? []);
          next.toolExecutions = Object.fromEntries(Object.entries(current.toolExecutions).flatMap(
            ([toolCallId, execution]) => {
              if (pendingToolCallIds.has(toolCallId)) return [[toolCallId, execution]];
              const persisted = persistedToolResults.get(toolCallId);
              if (persisted !== undefined) {
                return [[toolCallId, {
                  ...execution,
                  isError: persisted.isError,
                  ...(persisted.result === undefined ? {} : { result: persisted.result }),
                  status: persisted.isError ? 'error' as const : 'success' as const,
                }]];
              }
              // Once the run is idle, tool chips resolve from entries; a
              // still-busy session keeps chips whose end event may arrive next.
              if (!snapshot.busy) return [];
              return [[toolCallId, execution]];
            },
          ));
          const messagePersisted = (timestamp: number, provider?: string, model?: string) => (
            persistedMessages.some((entry) => (
              entry.type === 'message'
              && entry.message.timestamp === timestamp
              && (provider === undefined || ('provider' in entry.message && entry.message.provider === provider))
              && (model === undefined || ('model' in entry.message && entry.message.model === model))
            ))
          );
          if (current.liveUser !== undefined && messagePersisted(current.liveUser.timestamp)) {
            delete next.liveUser;
          }
          if (current.submission !== undefined) {
            if (messagePersisted(current.submission.message.timestamp)) delete next.submission;
            else if (snapshot.busy && current.submission.status !== 'accepted') {
              next.submission = { ...current.submission, status: 'accepted' };
            }
          }
          return next;
        }),
      }));
      const watermark = snapshot.eventWatermark;
      flushCatchUpBuffer(runtimeKey, sessionId, flight, watermark, snapshot.eventWorkerId);
      if (!snapshot.busy && flight.stopRequestAtStart !== undefined) {
        settleStopRequest(sessionId, flight.stopRequestAtStart, snapshot.runId);
      }
    };

    const syncSessionRecord = async (sessionId: string): Promise<void> => {
      const runtimeKey = runtime.currentKey();
      const existing = syncFlights.get(sessionId);
      if (existing !== undefined) {
        existing.retryRequested = true;
        return;
      }
      try {
        await connect();
      } catch {
        return;
      }
      if (!contextIsCurrent(runtimeKey)) return;
      const concurrent = syncFlights.get(sessionId);
      if (concurrent !== undefined) {
        concurrent.retryRequested = true;
        return;
      }
      const flight: SyncFlight = {
        buffer: [], generation: storeGeneration, retryRequested: false,
        stopRequestAtStart: stopRequests.get(sessionId),
      };
      syncFlights.set(sessionId, flight);
      set((state) => ({
        records: upsertRecord(state.records, sessionId, (current) => ({
          ...current,
          syncState: 'catchingUp' as const,
        })),
      }));
      try {
        const record = get().records[sessionId];
        const scopes: Array<'branch' | 'all'> = [];
        if (record?.branchEntries !== undefined || record?.branchEntriesSource === 'live') scopes.push('branch');
        if (record?.allEntries !== undefined) scopes.push('all');
        const { result } = await request('session.reconcile', { scopes, sessionId }, undefined, false);
        if (!contextIsCurrent(runtimeKey) || syncFlights.get(sessionId) !== flight) return;
        const entriesByScope = new Map<'branch' | 'all', SessionEntriesResult>(
          Object.entries(result.entries) as Array<['branch' | 'all', SessionEntriesResult]>,
        );
        applyResyncSnapshot(runtimeKey, sessionId, flight, result.snapshot, entriesByScope, result.stats);
      } catch {
        // A failed resync must not discard real events that arrived meanwhile;
        // flush them live and mark the record stale rather than guessing state.
        const isCurrentFlight = syncFlights.get(sessionId) === flight
          && flight.generation === storeGeneration;
        flushCatchUpBuffer(runtimeKey, sessionId, flight, undefined, undefined);
        if (isCurrentFlight && contextIsCurrent(runtimeKey)) {
          set((state) => ({
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              syncState: 'stale' as const,
            })),
          }));
        }
      } finally {
        if (syncFlights.get(sessionId) === flight) syncFlights.delete(sessionId);
        if (flight.retryRequested && flight.generation === storeGeneration
          && contextIsCurrent(runtimeKey) && !syncFlights.has(sessionId)) {
          void syncSessionRecord(sessionId);
        }
      }
    };

    const resyncSessionsNow = async (): Promise<void> => {
      const runtimeKey = runtime.currentKey();
      try {
        await connect();
      } catch {
        return;
      }
      if (!contextIsCurrent(runtimeKey)) return;
      void get().loadCatalog(get().catalogCwd ?? undefined).catch(() => undefined);
      const sessionIds = Object.keys(get().records).filter((sessionId) => {
        const record = get().records[sessionId];
        return record !== undefined && (
          record.open
          || record.snapshot !== undefined
          || sessionId === get().currentSessionId
        );
      });
      await Promise.allSettled(sessionIds.map((sessionId) => syncSessionRecord(sessionId)));
    };

    const connect = async (): Promise<PiSessionRuntimeConnection> => {
      const expectedRuntimeKey = runtime.currentKey();
      const connection = await runtime.connect();
      if (
        connection.runtimeKey !== expectedRuntimeKey
        || !contextIsCurrent(expectedRuntimeKey)
      ) {
        throw new Error('Pi runtime changed while connecting');
      }
      if (activeClient !== connection.client) {
        const replacedClient = activeClient !== null;
        unsubscribeEvents?.();
        activeClient = connection.client;
        unsubscribeEvents = connection.client.subscribe((envelope) => {
          handleRuntimeEvent(connection.runtimeKey, envelope);
        });
        if (replacedClient) {
          // The old connection's in-flight reads and buffers belong to the old
          // worker stream. A fresh resync will establish the new cut.
          syncFlights.clear();
          // A swapped client means events may have been missed between the old
          // transport's death and this subscription; reconcile every tracked
          // session from authoritative snapshots before trusting live deltas.
          void resyncSessionsNow();
        }
      }
      return connection;
    };

    const request = async <M extends RuntimeMethod>(
      method: M,
      params: RuntimeMethodParams<M>,
      requestedRuntimeKey?: string,
      reportError = true,
      timeoutMs?: number,
    ): Promise<{ result: RuntimeMethodResult<M>; runtimeKey: string }> => {
      const expectedRuntimeKey = requestedRuntimeKey ?? runtime.currentKey();
      try {
        if (!contextIsCurrent(expectedRuntimeKey)) {
          throw new Error(`Pi runtime changed before ${method}`);
        }
        const connection = await connect();
        if (
          connection.runtimeKey !== expectedRuntimeKey
          || !contextIsCurrent(expectedRuntimeKey)
        ) {
          throw new Error(`Pi runtime changed before ${method}`);
        }
        const result = await connection.client.request(method, params, timeoutMs);
        if (!contextIsCurrent(connection.runtimeKey)) {
          throw new Error(`Pi runtime changed during ${method}`);
        }
        return { result, runtimeKey: connection.runtimeKey };
      } catch (error) {
        if (reportError) commitError(expectedRuntimeKey, error);
        throw error;
      }
    };

    const refreshCatalogAfterMutation = async (): Promise<void> => {
      const cwd = get().catalogCwd ?? undefined;
      await get().loadCatalog(cwd).catch(() => undefined);
    };

    const applyRecoveryResult = async (
      sessionId: string,
      result: RecoveryOperationResult,
    ): Promise<RecoveryOperationResult> => {
      set((state) => ({
        lastError: null,
        records: upsertRecord(state.records, sessionId, (current) => ({
          ...current,
          open: true,
          snapshot: preserveSnapshotWorkspace(result.snapshot, current.snapshot),
          view: state.currentSessionId === sessionId
            ? preparePiTimelineEnd(current.view)
            : current.view,
        })),
      }));
      await get().refreshEntries(sessionId);
      return result;
    };

    return {
      ...initialFields(runtime.currentKey()),

      abort: async (sessionId) => {
        const runId = get().records[sessionId]?.snapshot?.runId;
        if (runId === undefined) {
          // No causal target is known yet. An unconditional RPC could arrive
          // after this run settles and cancel a newer one. Refresh authority so
          // the next explicit click can name the run it observed.
          void syncSessionRecord(sessionId);
          return false;
        }
        const stopRequest: StopRequest = {
          requestedAt: Date.now(),
          runId,
          state: 'requested',
        };
        stopRequests.set(sessionId, stopRequest);
        set((state) => ({
          lastError: null,
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            ...(current.liveAssistant
              ? { stoppedAssistant: markAssistantAborted(current.liveAssistant) }
              : {}),
            stopState: 'requested' as const,
            snapshot: updateSnapshot(current.snapshot, {
              isCompacting: false,
              isStreaming: false,
              retryAttempt: 0,
            }),
          })),
        }));
        try {
          const { result } = await request('agent.abort', {
            sessionId,
            expectedRunId: runId,
          }, undefined, false, 10_000);
          if (stopRequests.get(sessionId) !== stopRequest) return result.aborted;
          if (!result.aborted) {
            // The host saw no in-flight run; nothing was cancelled.
            settleStopRequest(sessionId, stopRequest);
            return false;
          }
          if (stopRequest.state === 'requested') stopRequest.state = 'accepted';
          set((state) => ({
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              stopState: 'accepted' as const,
            })),
          }));
          return true;
        } catch (error) {
          if (stopRequests.get(sessionId) !== stopRequest) return false;
          // A transport-level AbortError/timeout/lost connection only proves the
          // reply never arrived, not that the host declined the stop. Keep the
          // request marked and resolve it through the authoritative snapshot.
          if (
            isPiAbortError(error)
            || error instanceof PiRuntimeAmbiguousRequestError
            || error instanceof PiRuntimeRequestTimeoutError
          ) {
            stopRequest.state = 'unknown';
            set((state) => ({
              records: upsertRecord(state.records, sessionId, (current) => ({
                ...current,
                stopState: 'unknown' as const,
              })),
            }));
            void syncSessionRecord(sessionId);
            return false;
          }
          settleStopRequest(sessionId, stopRequest);
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      compactSession: async (sessionId, customInstructions, expectedRuntimeKey) => {
        const { result } = await request('agent.compact', {
          ...(customInstructions === undefined ? {} : { customInstructions }),
          sessionId,
        }, expectedRuntimeKey);
        return result;
      },

      beginSubmission: (sessionId, message, mode) => {
        const id = nextSubmissionId();
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => {
            const baseView = current.submission
              && current.view?.newTurn?.submissionId === current.submission.id
              ? clearPiTimelineSubmissionAnchor(current.view, current.submission.id)
              : current.view;
            return {
              ...current,
              submission: {
                entryIdsAtSubmit: new Set(
                  current.branchEntries?.entries.map((entry) => entry.id) ?? [],
                ),
                id,
                message,
                mode,
                status: 'preparing',
              },
              ...(mode === 'prompt'
                ? { view: armPiTimelineTurn(baseView, id, liveUserTurnId(message.timestamp)) }
                : baseView === current.view ? {} : { view: baseView }),
            };
          }),
        }));
        return id;
      },

      archiveSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        try {
          const wasOpen = get().records[sessionId]?.open === true;
          const { result, runtimeKey } = await request('session.archive', { sessionId });
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, sessionId),
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
            summaries: upsertSummary(state.summaries, result),
          }));
          if (wasOpen && contextIsCurrent(runtimeKey)) {
            await request('session.close', { sessionId }).catch((error: unknown) => {
              commitError(runtimeKey, error);
              return undefined;
            });
          }
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      closeSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        try {
          const { result } = await request('session.close', { sessionId });
          set((state) => ({
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              open: false,
            })),
          }));
          return result.closed;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      clearQueue: async (sessionId) => {
        const { result } = await request('agent.queue.clear', { sessionId });
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            snapshot: updateSnapshot(current.snapshot, {
              followUp: [],
              pendingMessageCount: 0,
              steering: [],
            }),
          })),
        }));
        return result.cleared;
      },

      clearSubmission: (sessionId, submissionId) => {
        set((state) => {
          const current = state.records[sessionId];
          if (current?.submission?.id !== submissionId) return state;
          const next = { ...current };
          if (next.view?.newTurn?.submissionId === submissionId) {
            next.view = clearPiTimelineSubmissionAnchor(next.view, submissionId);
          }
          delete next.submission;
          return { records: { ...state.records, [sessionId]: next } };
        });
      },

      clearSessionAttention: (sessionId) => {
        set((state) => ({
          attentionBySession: clearAttention(state.attentionBySession, sessionId),
        }));
      },

      createSession: async (cwd, name, parentSession, workspace, workFocus) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const resolvedWorkspace = await canonicalWorkspaceBinding(cwd, workspace);
          const { result, runtimeKey } = await request('session.create', {
            cwd,
            ...(name === undefined ? {} : { name }),
            ...(parentSession === undefined ? {} : { parentSession }),
            ...(resolvedWorkspace === undefined ? {} : { workspace: resolvedWorkspace }),
            ...(workFocus === undefined ? {} : { workFocus }),
          });
          deletedSessionIds.delete(result.sessionId);
          set((state) => ({
            attentionBySession: clearAttention(state.attentionBySession, result.sessionId),
            currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? result.sessionId
              : state.currentSessionId,
            lastError: null,
            records: upsertRecord(state.records, result.sessionId, (current) => ({
              ...current,
              open: true,
              snapshot: preserveSnapshotWorkspace(result, current.snapshot),
              view: preparePiTimelineEnd(current.view),
            })),
          }));
          await get().refreshEntries(result.sessionId);
          await refreshCatalogAfterMutation();
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      deleteSession: async (sessionId) => {
        const clearsCurrentSelection = get().currentSessionId === sessionId;
        if (clearsCurrentSelection) beginSelectionIntent();
        catalogGeneration += 1;
        deletingSessionIds.add(sessionId);
        invalidateSessionHydration(sessionId);
        set({ catalogLoading: false });
        try {
          const { result } = await request('session.delete', { sessionId });
          if (!result.deleted) return false;
          catalogGeneration += 1;
          deletedSessionIds.add(sessionId);
          invalidateSessionHydration(sessionId);
          set((state) => {
            const records = { ...state.records };
            delete records[sessionId];
            return {
              attentionBySession: clearAttention(state.attentionBySession, sessionId),
              catalogLoading: false,
              currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
              lastError: null,
              records,
              summaries: state.summaries.filter((summary) => summary.id !== sessionId),
            };
          });
          return true;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        } finally {
          deletingSessionIds.delete(sessionId);
        }
      },

      executeCommand: async (sessionId, command) => {
        const { result } = await request('command.execute', { command, sessionId });
        if (command.trim() === '/reload') {
          notifyPiRuntimeCatalogChanged('reload');
        }
        return result;
      },

      getSessionTree: async (sessionId) => {
        // The dialog owns its retry/error UI; a tree read failure must not
        // replace the entire active conversation with the store-level error.
        const { result } = await request('session.tree', { sessionId }, undefined, false);
        return result;
      },

      followUp: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const inputContext = await captureInputContext(sessionId);
        try {
          const { result } = await request('agent.followUp', {
            ...(images === undefined ? {} : { images }),
            inputContext,
            ...(instructions === undefined ? {} : { instructions }),
            sessionId,
            text,
          }, expectedRuntimeKey);
          if (!result.accepted) await releaseSurfaceAgentInputContext(sessionId, inputContext);
          return result.accepted;
        } catch (error) {
          await releaseSurfaceAgentInputContext(sessionId, inputContext);
          throw error;
        }
      },

      forkSession: async (sessionId, entryId, position) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const { result, runtimeKey } = await request('session.fork', {
            entryId,
            ...(position === undefined ? {} : { position }),
            sessionId,
          });
          if (result.cancelled) return result;
          const previousId = sessionId;
          const nextId = result.snapshot.sessionId;
          set((state) => ({
            attentionBySession: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? clearAttention(state.attentionBySession, nextId)
              : state.attentionBySession,
            currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
              ? nextId
              : state.currentSessionId,
            lastError: null,
            records: {
              ...upsertRecord(state.records, previousId, (current) => ({
                ...current,
                open: previousId === nextId,
              })),
              [nextId]: {
                ...(state.records[nextId] ?? emptySession(nextId)),
                open: true,
                snapshot: preserveSnapshotWorkspace(
                  result.snapshot,
                  state.records[nextId]?.snapshot ?? state.records[previousId]?.snapshot,
                ),
                view: preparePiTimelineEnd(state.records[nextId]?.view),
              },
            },
          }));
          await get().refreshEntries(nextId);
          await refreshCatalogAfterMutation();
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      loadCatalog: async (cwd) => {
        const generation = ++catalogGeneration;
        const requestedCwd = cwd ?? null;
        set({ catalogCwd: requestedCwd, catalogLoading: true, lastError: null });
        try {
          const { result, runtimeKey } = await request('session.list', {
            ...(cwd === undefined ? {} : { cwd }),
          });
          if (generation !== catalogGeneration || !contextIsCurrent(runtimeKey)) return result;
          const summaries = sortSummaries(result);
          for (const summary of summaries) deletedSessionIds.delete(summary.id);
          set({
            catalogCwd: requestedCwd,
            catalogLoaded: true,
            catalogLoading: false,
            summaries,
          });
          return summaries;
        } catch (error) {
          if (generation === catalogGeneration) {
            set({ catalogLoading: false });
            commitError(runtime.currentKey(), error);
          }
          throw error;
        }
      },

      mutateFeatures: async (sessionId, mutation, expectedRuntimeKey) => {
        const { result } = await request(
          'session.features.mutate',
          { mutation, sessionId },
          expectedRuntimeKey,
        );
        set((state) => ({
          lastError: null,
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            snapshot: updateSnapshot(current.snapshot, { features: result }),
          })),
        }));
        return result;
      },

      navigateSession: async (sessionId, targetId, summarize) => {
        const selectionIntent = beginSelectionIntent();
        try {
          const { result, runtimeKey } = await request('session.navigate', {
            sessionId,
            targetId,
            ...(summarize === undefined ? {} : { summarize }),
          });
          if (!result.cancelled) {
            set((state) => ({
              attentionBySession: selectionIntentIsCurrent(selectionIntent, runtimeKey)
                ? clearAttention(state.attentionBySession, result.snapshot.sessionId)
                : state.attentionBySession,
              currentSessionId: selectionIntentIsCurrent(selectionIntent, runtimeKey)
                ? result.snapshot.sessionId
                : state.currentSessionId,
              lastError: null,
              records: upsertRecord(state.records, result.snapshot.sessionId, (current) => ({
                ...current,
                open: true,
                snapshot: preserveSnapshotWorkspace(result.snapshot, current.snapshot),
                view: selectionIntentIsCurrent(selectionIntent, runtimeKey)
                  ? preparePiTimelineEnd(current.view)
                  : current.view,
              })),
            }));
            await get().refreshEntries(result.snapshot.sessionId);
          }
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      openSession: async (params) => {
        const previousSessionId = get().currentSessionId;
        const selectionIntent = beginSelectionIntent();
        const openingSessionId = params.sessionId ?? null;
        set((state) => ({
          currentSessionId: openingSessionId ?? state.currentSessionId,
          openingSessionId,
          lastError: null,
          records: openingSessionId === null
            ? state.records
            : prepareSessionTimeline(state, openingSessionId),
        }));
        if (openingSessionId) {
          void get().prefetchSession(openingSessionId, params.cwd).catch(() => undefined);
        }
        try {
          const knownSummary = params.sessionId
            ? get().summaries.find((summary) => summary.id === params.sessionId)
            : undefined;
          const workspaceCwd = params.cwd ?? knownSummary?.cwd;
          const requestedWorkspace = params.workspace ?? knownSummary?.workspace;
          const resolvedWorkspace = workspaceCwd
            ? await canonicalWorkspaceBinding(workspaceCwd, requestedWorkspace)
            : requestedWorkspace;
          const openParams = resolvedWorkspace === undefined
            ? params
            : { ...params, workspace: resolvedWorkspace };
          const { result, runtimeKey } = await request('session.open', openParams);
          deletedSessionIds.delete(result.sessionId);
          set((state) => {
            const selectionCurrent = selectionIntentIsCurrent(selectionIntent, runtimeKey);
            return {
              attentionBySession: selectionCurrent
                ? clearAttention(state.attentionBySession, result.sessionId)
                : state.attentionBySession,
              currentSessionId: selectionCurrent
                ? result.sessionId
                : state.currentSessionId,
              records: upsertRecord(state.records, result.sessionId, (current) => {
                const view = reconcileSessionTimelineSnapshot(current, result, selectionCurrent);
                return {
                  ...current,
                  open: true,
                  snapshot: preserveSnapshotWorkspace(result, current.snapshot),
                  ...(view ? { view } : {}),
                };
              }),
            };
          });
          void get().refreshEntries(result.sessionId)
            .catch(() => undefined)
            .finally(() => {
              if (!selectionIntentIsCurrent(selectionIntent, runtimeKey)) return;
              set((state) => ({
                openingSessionId: state.openingSessionId === result.sessionId
                  ? null
                  : state.openingSessionId,
              }));
            });
          void refreshCatalogAfterMutation();
          return result;
        } catch (error) {
          if (selectionIntent === selectionGeneration) {
            set((state) => ({
              currentSessionId: state.currentSessionId === openingSessionId
                ? previousSessionId
                : state.currentSessionId,
              openingSessionId: null,
              records: previousSessionId === null
                ? state.records
                : prepareSessionTimeline(state, previousSessionId),
            }));
          }
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      prompt: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const inputContext = await captureInputContext(sessionId);
        try {
          const { result } = await request('agent.prompt', {
            ...(images === undefined ? {} : { images }),
            inputContext,
            ...(instructions === undefined ? {} : { instructions }),
            sessionId,
            text,
          }, expectedRuntimeKey);
          if (!result.accepted) await releaseSurfaceAgentInputContext(sessionId, inputContext);
          return result.accepted;
        } catch (error) {
          await releaseSurfaceAgentInputContext(sessionId, inputContext);
          throw error;
        }
      },

      prefetchSession: async (sessionId, cwd) => {
        if (deletingSessionIds.has(sessionId) || deletedSessionIds.has(sessionId)) {
          throw new Error('Pi session is being deleted or was deleted');
        }
        const existing = get().records[sessionId]?.branchEntries;
        if (existing) return existing;
        const expectedRuntimeKey = runtime.currentKey();
        const previewKey = `${expectedRuntimeKey}\u0000${sessionId}`;
        const pending = previewRequests.get(previewKey);
        if (pending) return pending;

        const generation = (previewGeneration.get(sessionId) ?? 0) + 1;
        previewGeneration.set(sessionId, generation);
        const appendedEntryIds = new Set<string>();
        previewAppendedDuringRequest.set(sessionId, appendedEntryIds);
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => {
            const next = { ...current, previewLoading: true };
            delete next.previewError;
            return next;
          }),
        }));

        const preview = (async () => {
          try {
            const { result, runtimeKey } = await request('session.entries.preview', {
              ...(cwd === undefined ? {} : { cwd }),
              scope: 'branch',
              sessionId,
            }, expectedRuntimeKey, false);
            if (
              previewGeneration.get(sessionId) !== generation
              || !contextIsCurrent(runtimeKey)
            ) return result;
            set((state) => ({
              records: upsertRecord(state.records, sessionId, (current) => {
                if (current.branchEntriesSource === 'live') {
                  const next = { ...current, previewLoading: false };
                  delete next.previewError;
                  return next;
                }
                const next: PiSessionViewState = {
                  ...current,
                  branchEntries: mergeEntriesArrivingDuringRequest(
                    result,
                    current.branchEntries,
                    appendedEntryIds,
                  ),
                  branchEntriesSource: 'preview',
                  previewLoading: false,
                };
                delete next.previewError;
                return next;
              }),
            }));
            return result;
          } catch (error) {
            if (
              previewGeneration.get(sessionId) === generation
              && contextIsCurrent(expectedRuntimeKey)
            ) {
              set((state) => ({
                records: upsertRecord(state.records, sessionId, (current) => {
                  if (current.branchEntriesSource === 'live') {
                    const next = { ...current, previewLoading: false };
                    delete next.previewError;
                    return next;
                  }
                  return {
                    ...current,
                    previewError: errorMessage(error),
                    previewLoading: false,
                  };
                }),
              }));
            }
            throw error;
          }
        })();
        previewRequests.set(previewKey, preview);
        void preview.finally(() => {
          if (previewRequests.get(previewKey) === preview) previewRequests.delete(previewKey);
          if (previewAppendedDuringRequest.get(sessionId) === appendedEntryIds) {
            previewAppendedDuringRequest.delete(sessionId);
          }
        }).catch(() => undefined);
        return preview;
      },

      recoverTo: async (sessionId, targetId, mode, summarize) => {
        const { result } = await request('recovery.navigate', {
          mode,
          sessionId,
          targetId,
          ...(summarize === undefined ? {} : { summarize }),
        });
        return applyRecoveryResult(sessionId, result);
      },

      refreshEntries: async (sessionId, scope = 'branch') => {
        if (deletingSessionIds.has(sessionId) || deletedSessionIds.has(sessionId)) {
          throw new Error('Pi session is being deleted or was deleted');
        }
        const requestKey = entriesRequestKey(sessionId, scope);
        const generation = (entriesGeneration.get(requestKey) ?? 0) + 1;
        entriesGeneration.set(requestKey, generation);
        const appendedEntryIds = new Set<string>();
        entriesAppendedDuringRequest.set(requestKey, appendedEntryIds);
        try {
          const { result, runtimeKey } = await request('session.entries', { scope, sessionId });
          if (
            entriesGeneration.get(requestKey) !== generation
            || !contextIsCurrent(runtimeKey)
          ) {
            return result;
          }
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => {
              const currentEntries = scope === 'all'
                ? current.allEntries
                : current.branchEntries;
              const merged = mergeEntriesArrivingDuringRequest(
                result,
                currentEntries,
                appendedEntryIds,
              );
              const next: PiSessionViewState = {
                ...current,
                ...(scope === 'all'
                  ? { allEntries: merged }
                  : {
                      branchEntries: merged,
                      branchEntriesSource: 'live' as const,
                      previewLoading: false,
                    }),
              };
              if (scope === 'branch') delete next.previewError;
              return next;
            }),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        } finally {
          if (entriesAppendedDuringRequest.get(requestKey) === appendedEntryIds) {
            entriesAppendedDuringRequest.delete(requestKey);
          }
        }
      },

      refreshStats: async (sessionId) => {
        const generation = (statsGeneration.get(sessionId) ?? 0) + 1;
        statsGeneration.set(sessionId, generation);
        try {
          const { result, runtimeKey } = await request('session.stats', { sessionId });
          if (
            statsGeneration.get(sessionId) !== generation
            || !contextIsCurrent(runtimeKey)
          ) {
            return result;
          }
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              stats: result,
            })),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      renameSession: async (sessionId, name) => {
        try {
          const { result } = await request('session.rename', { name, sessionId });
          set((state) => ({
            lastError: null,
            records: upsertRecord(state.records, sessionId, (current) => ({
              ...current,
              snapshot: updateSnapshot(current.snapshot, { name: result.name }),
            })),
            summaries: state.summaries.map((summary) => {
              if (summary.id !== sessionId) return summary;
              const updated = { ...summary };
              if (result.name === undefined) delete updated.name;
              else updated.name = result.name;
              return updated;
            }),
          }));
          await refreshCatalogAfterMutation();
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      reset: () => {
        storeGeneration += 1;
        catalogGeneration += 1;
        selectionGeneration += 1;
        entriesGeneration.clear();
        entriesAppendedDuringRequest.clear();
        previewGeneration.clear();
        previewAppendedDuringRequest.clear();
        previewRequests.clear();
        deletingSessionIds.clear();
        deletedSessionIds.clear();
        stopRequests.clear();
        syncFlights.clear();
        lastAppliedSequences.clear();
        supersededWorkers.clear();
        statsGeneration.clear();
        unsubscribeEvents?.();
        unsubscribeEvents = null;
        activeClient = null;
        set(initialFields(runtime.currentKey()));
      },

      resyncSessions: resyncSessionsNow,

      probeBusySession: async (sessionId) => {
        const initial = get().records[sessionId];
        if (!initial?.snapshot?.busy || syncFlights.has(sessionId)) return;
        try {
          const { result: authority, runtimeKey } = await request(
            'session.snapshot', { sessionId }, undefined, false,
          );
          if (!contextIsCurrent(runtimeKey) || syncFlights.has(sessionId)) return;
          const current = get().records[sessionId];
          const known = current?.snapshot;
          if (!known?.busy) return;
          // A live event applied after the probe's cut is newer than this read.
          const applied = authority.eventWorkerId === undefined
            ? undefined : lastAppliedSequences.get(authority.eventWorkerId);
          if (applied !== undefined && authority.eventWatermark !== undefined
            && applied >= authority.eventWatermark) return;
          const runningToolIds = Object.values(current.toolExecutions)
            .filter((tool) => tool.status === 'running').map((tool) => tool.toolCallId).sort();
          const authoritativeToolIds = [...(authority.pendingToolCallIds ?? [])].sort();
          const diverged = authority.eventWorkerId !== known.eventWorkerId
            || authority.runId !== known.runId
            || authority.busy !== known.busy
            || authority.isStreaming !== known.isStreaming
            || authority.leafId !== known.leafId
            || JSON.stringify(authority.liveAssistant ?? null) !== JSON.stringify(current.liveAssistant ?? null)
            || JSON.stringify(authoritativeToolIds) !== JSON.stringify(runningToolIds)
            || JSON.stringify(authority.followUp) !== JSON.stringify(known.followUp)
            || JSON.stringify(authority.steering) !== JSON.stringify(known.steering);
          if (diverged) await syncSessionRecord(sessionId);
        } catch {
          // A failed read is unknown. Keep the last displayed state until the
          // next probe or connection recovery; never manufacture idle.
          if (get().records[sessionId]?.snapshot?.busy) {
            set((state) => ({
              records: upsertRecord(state.records, sessionId, (current) => ({
                ...current, syncState: 'stale' as const,
              })),
            }));
          }
        }
      },

      selectModel: async (sessionId, model) => {
        const { result } = await request('model.select', {
          modelId: model.id,
          provider: model.provider,
          sessionId,
        });
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(result, current.snapshot),
          })),
        }));
        return result;
      },

      selectWorkFocus: async (sessionId, workFocus) => {
        const { result } = await request('session.workFocus.set', { sessionId, workFocus }, undefined, false);
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(result, current.snapshot),
          })),
        }));
        return result;
      },

      selectThinking: async (sessionId, level) => {
        const { result } = await request('thinking.select', { level, sessionId });
        set((state) => ({
          records: upsertRecord(state.records, sessionId, (current) => ({
            ...current,
            open: true,
            snapshot: preserveSnapshotWorkspace(result, current.snapshot),
          })),
        }));
        return result;
      },

      setCurrentSession: (sessionId) => {
        if (get().currentSessionId === sessionId) {
          if (sessionId !== null) {
            set((state) => ({
              attentionBySession: clearAttention(state.attentionBySession, sessionId),
            }));
          }
          return;
        }
        beginSelectionIntent();
        set((state) => ({
          attentionBySession: sessionId === null
            ? state.attentionBySession
            : clearAttention(state.attentionBySession, sessionId),
          currentSessionId: sessionId,
          records: sessionId === null ? state.records : prepareSessionTimeline(state, sessionId),
        }));
      },

      steer: async (sessionId, text, images, instructions, expectedRuntimeKey) => {
        const inputContext = await captureInputContext(sessionId);
        try {
          const { result } = await request('agent.steer', {
            ...(images === undefined ? {} : { images }),
            inputContext,
            ...(instructions === undefined ? {} : { instructions }),
            sessionId,
            text,
          }, expectedRuntimeKey);
          if (!result.accepted) await releaseSurfaceAgentInputContext(sessionId, inputContext);
          return result.accepted;
        } catch (error) {
          await releaseSurfaceAgentInputContext(sessionId, inputContext);
          throw error;
        }
      },

      unarchiveSession: async (sessionId) => {
        try {
          const { result } = await request('session.unarchive', { sessionId });
          set((state) => ({
            lastError: null,
            summaries: upsertSummary(state.summaries, result),
          }));
          return result;
        } catch (error) {
          commitError(runtime.currentKey(), error);
          throw error;
        }
      },

      cancelTimelineAutomation: (sessionId) => {
        set((state) => {
          const current = state.records[sessionId];
          if (!current) return state;
          return {
            records: {
              ...state.records,
              [sessionId]: {
                ...current,
                view: cancelPiTimelineAutomation(current.view),
              },
            },
          };
        });
      },

      completeTimelineReturn: (sessionId, token) => {
        set((state) => {
          const current = state.records[sessionId];
          if (!current) return state;
          const view = completePiTimelineReturn(current.view, token);
          if (!view || view === current.view) return state;
          return {
            records: {
              ...state.records,
              [sessionId]: { ...current, view },
            },
          };
        });
      },

      requestTimelineReturn: (sessionId) => {
        let token = 0;
        set((state) => {
          const current = state.records[sessionId];
          if (!current) return state;
          const requested = requestPiTimelineReturn(current.view);
          token = requested.token;
          return {
            records: {
              ...state.records,
              [sessionId]: { ...current, view: requested.view },
            },
          };
        });
        return token;
      },

      saveTimelineCheckpoint: (sessionId, entryEpoch, observedLeafId, viewport) => {
        set((state) => {
          const current = state.records[sessionId];
          if (!current) return state;
          const view = savePiTimelineCheckpoint(
            current.view,
            entryEpoch,
            observedLeafId,
            viewport,
          );
          if (!view || view === current.view) return state;
          return {
            records: {
              ...state.records,
              [sessionId]: { ...current, view },
            },
          };
        });
      },

      updateSubmission: (sessionId, submissionId, update) => {
        set((state) => {
          const current = state.records[sessionId];
          if (current?.submission?.id !== submissionId) return state;
          if (update.status === 'accepted' && current.submission.mode !== 'prompt') {
            const next = { ...current };
            delete next.submission;
            return { records: { ...state.records, [sessionId]: next } };
          }
          return {
            records: {
              ...state.records,
              [sessionId]: {
                ...current,
                submission: { ...current.submission, ...update },
              },
            },
          };
        });
      },
    };
  });

  runtime.subscribeChanged(() => {
    store.getState().reset();
  });

  // A quiet provider may legitimately compute for a long time. Check only a
  // visible, selected busy session with a cheap read; silence never means idle.
  const probeIntervalMs = options.healthProbeIntervalMs ?? 30_000;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probeSessionId: string | null = null;
  const visibleBusySession = (): string | null => {
    const state = store.getState();
    const sessionId = state.currentSessionId;
    if (state.connectionPhase !== 'connected' || sessionId === null
      || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return null;
    const record = state.records[sessionId];
    return record?.open && record.snapshot?.busy ? sessionId : null;
  };
  const scheduleBusyProbe = (): void => {
    const sessionId = visibleBusySession();
    if (probeTimer !== null && probeSessionId === sessionId) return;
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
    probeSessionId = sessionId;
    if (sessionId === null) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (visibleBusySession() !== sessionId) {
        scheduleBusyProbe();
        return;
      }
      void store.getState().probeBusySession(sessionId).finally(scheduleBusyProbe);
    }, probeIntervalMs);
  };
  store.subscribe(scheduleBusyProbe);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      scheduleBusyProbe();
      const sessionId = visibleBusySession();
      if (sessionId !== null) void store.getState().probeBusySession(sessionId);
    });
  }

  runtime.subscribeConnectionPhase?.((phase) => {
    store.setState({ connectionPhase: phase });
  });

  runtime.subscribeReconnected?.(() => {
    void store.getState().resyncSessions().catch(() => undefined);
  });

  let protocolRecoveryInFlight = false;
  runtime.subscribeProtocolError?.(() => {
    store.setState((state) => ({
      lastError: 'Pi runtime protocol error; refreshing session state',
      records: Object.fromEntries(Object.entries(state.records).map(([sessionId, record]) => [
        sessionId,
        record.open ? { ...record, syncState: 'stale' as const } : record,
      ])),
    }));
    if (protocolRecoveryInFlight) return;
    protocolRecoveryInFlight = true;
    void store.getState().resyncSessions().finally(() => { protocolRecoveryInFlight = false; });
  });

  runtime.subscribeSequenceGap?.((_gap) => {
    // A gap proves events were missed; catch up through the authoritative
    // snapshot path. The missing event may belong to any session, regardless
    // of which source emitted the frame that exposed the surface gap.
    void store.getState().resyncSessions().catch(() => undefined);
  });

  return store;
};

export const usePiSessionStore = createPiSessionStore();
