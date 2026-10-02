import { afterEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { RuntimeAPIs } from '@varin/application-client';
import type { DocumentsAPI, VarinAgentInputSnapshotCaptureRequest } from '@varin/application-client';
import { bindDocumentRegistry, getDocumentRegistry, resetDocumentRegistry } from '@/lib/documents/session';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import {
  VARIN_PROTOCOL_VERSION,
  type PiAgentEvent,
  type PiAssistantMessage,
  type PiSessionEntry,
  type RecoveryStatus,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodParams,
  type SessionEntriesResult,
  type SessionSnapshot,
  type SessionStats,
  type SessionSummary,
} from '@varin/protocol';
import type { RuntimeSequenceGap } from '@varin/runtime-client';
import type { PiRuntimeConnection } from '@/lib/pi-runtime/client';
import {
  createPiSessionStore,
  isPiSessionWorkerReady,
  reducePiAgentEvent,
  selectActivePiSessions,
  selectArchivedPiSessions,
  type PiSessionRuntimeClient,
  type PiSessionStoreRuntime,
} from './usePiSessionStore';

const snapshot = (sessionId: string, cwd = 'D:/work'): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  runId: `${sessionId}-run`,
  sessionId,
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'medium',
});

const summary = (
  id: string,
  updatedAt: string,
  archivedAt?: string,
): SessionSummary => ({
  allMessagesText: '',
  ...(archivedAt === undefined ? {} : { archivedAt }),
  createdAt: '2026-08-02T00:00:00.000Z',
  cwd: 'D:/work',
  firstMessage: '',
  id,
  messageCount: 0,
  persisted: true,
  sessionFile: `D:/agent/sessions/${id}.jsonl`,
  updatedAt,
});

const assistant = (
  text: string,
  stopReason: PiAssistantMessage['stopReason'] = 'pending',
): PiAssistantMessage => ({
  api: 'messages',
  content: [{ text, type: 'text' }],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason,
  timestamp: 1,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const branch = (sessionId: string, entries: PiSessionEntry[] = []): SessionEntriesResult => ({
  entries,
  leafId: entries.at(-1)?.id ?? null,
  scope: 'branch',
  sessionId,
});

const allEntries = (sessionId: string, entries: PiSessionEntry[] = []): SessionEntriesResult => ({
  entries,
  leafId: entries.at(-1)?.id ?? null,
  scope: 'all',
  sessionId,
});

const recoveryStatus: RecoveryStatus = {
  actions: ['navigate', 'undo'],
  available: true,
  issues: [],
  modes: ['conversation'],
  providers: [],
};

const stats = (sessionId: string, tokens = 1200): SessionStats => ({
  assistantMessages: 1,
  contextUsage: { contextWindow: 200000, percent: 0.6, tokens },
  cost: 0.01,
  sessionId,
  tokens: {
    cacheRead: 0,
    cacheWrite: 0,
    input: tokens,
    output: 0,
    total: tokens,
  },
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  userMessages: 1,
});

const reconciled = (
  sessionId: string,
  current: SessionSnapshot,
  entries?: SessionEntriesResult,
) => ({
  entries: entries === undefined ? {} : { [entries.scope]: entries },
  snapshot: current,
  stats: stats(sessionId),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const positionedAgentEvent = (event: Record<string, unknown>): PiAgentEvent => ({
  leafId: null,
  turnIndex: 0,
  ...event,
} as unknown as PiAgentEvent);

class FakeRuntime implements PiSessionStoreRuntime {
  key = 'runtime-a';
  readonly calls: Array<{ method: RuntimeMethod; params: unknown }> = [];
  readonly #changedListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: RuntimeEventEnvelope) => void>();
  readonly #reconnectedListeners = new Set<(connection: PiRuntimeConnection) => void>();
  readonly #gapListeners = new Set<(gap: RuntimeSequenceGap) => void>();
  readonly #protocolErrorListeners = new Set<(error: Error) => void>();
  #nextSeq = 0;
  handler: (method: RuntimeMethod, params: unknown) => unknown | Promise<unknown> = () => {
    throw new Error('Unhandled fake runtime request');
  };

  readonly client: PiSessionRuntimeClient = {
    request: (async <M extends RuntimeMethod>(method: M, params: RuntimeMethodParams<M>) => {
      this.calls.push({ method, params });
      return this.handler(method, params) as never;
    }) as PiSessionRuntimeClient['request'],
    subscribe: (listener) => {
      this.#eventListeners.add(listener);
      return () => this.#eventListeners.delete(listener);
    },
  };

  async connect() {
    return { client: this.client, runtimeKey: this.key };
  }

  currentKey() {
    return this.key;
  }

  emit<E extends RuntimeEventEnvelope>(event: E) {
    for (const listener of this.#eventListeners) listener(event);
  }

  event(
    event: RuntimeEventEnvelope['event'],
    data: RuntimeEventEnvelope['data'],
    sessionId?: string,
    seq?: number,
  ) {
    this.#nextSeq = Math.max(this.#nextSeq, seq ?? this.#nextSeq + 1);
    this.emit({
      data,
      event,
      kind: 'event',
      seq: seq ?? this.#nextSeq,
      source: {
        role: sessionId === undefined ? 'catalog' : 'session',
        runtimeGeneration: 1,
        ...(sessionId === undefined ? {} : { sessionId }),
        workerId: sessionId ?? 'catalog',
      },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
  }

  /** Simulate a lost connection being replaced; fires the store's resync path. */
  reconnect() {
    for (const listener of this.#reconnectedListeners) {
      listener({ client: this.client, runtimeKey: this.key } as PiRuntimeConnection);
    }
  }

  sequenceGap(sessionId?: string) {
    for (const listener of this.#gapListeners) {
      listener({
        expected: 5,
        received: 9,
        source: {
          role: sessionId === undefined ? 'catalog' : 'session',
          runtimeGeneration: 1,
          ...(sessionId === undefined ? {} : { sessionId }),
          workerId: sessionId ?? 'catalog',
        },
      });
    }
  }

  protocolError() {
    for (const listener of this.#protocolErrorListeners) listener(new Error('bad event frame'));
  }

  subscribeProtocolError(listener: (error: Error) => void) {
    this.#protocolErrorListeners.add(listener);
    return () => this.#protocolErrorListeners.delete(listener);
  }

  subscribeChanged(listener: () => void) {
    this.#changedListeners.add(listener);
    return () => this.#changedListeners.delete(listener);
  }

  subscribeReconnected(listener: (connection: PiRuntimeConnection) => void) {
    this.#reconnectedListeners.add(listener);
    return () => this.#reconnectedListeners.delete(listener);
  }

  subscribeSequenceGap(listener: (gap: RuntimeSequenceGap) => void) {
    this.#gapListeners.add(listener);
    return () => this.#gapListeners.delete(listener);
  }

  switchTo(key: string) {
    this.key = key;
    for (const listener of this.#changedListeners) listener();
  }
}

describe('Pi session event state', () => {
  test('requires both an open worker and snapshot before enabling worker actions', () => {
    const stale = {
      extensionStates: {},
      open: false,
      sessionId: 'session-a',
      snapshot: snapshot('session-a'),
      toolExecutions: {},
    };
    expect(isPiSessionWorkerReady(stale)).toBe(false);
    expect(isPiSessionWorkerReady({ ...stale, open: true })).toBe(true);
  });

  test('keeps Pi entries and streaming tool state without OpenCode message IDs', () => {
    const sessionId = 'session-a';
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const streaming = reducePiAgentEvent(initial, {
      message: assistant('streaming'),
      type: 'message_update',
      update: { contentIndex: 0, delta: 'streaming', type: 'text_delta' },
    });
    expect(streaming.liveAssistant?.content[0]).toEqual({ text: 'streaming', type: 'text' });

    const running = reducePiAgentEvent(streaming, {
      args: { path: 'README.md' },
      toolCallId: 'tool-1',
      toolName: 'read',
      type: 'tool_execution_start',
    });
    const updated = reducePiAgentEvent(running, {
      args: { path: 'README.md' },
      partialResult: { text: 'partial' },
      toolCallId: 'tool-1',
      toolName: 'read',
      type: 'tool_execution_update',
    });
    expect(updated.toolExecutions['tool-1']?.partialResult).toEqual({ text: 'partial' });

    const entry: PiSessionEntry = {
      id: 'entry-a',
      message: assistant('done'),
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const persisted = reducePiAgentEvent(updated, positionedAgentEvent({ entry, type: 'entry_appended' }));
    expect(persisted.branchEntries?.entries.map((candidate) => candidate.id)).toEqual(['entry-a']);
    expect(persisted.liveAssistant).toBeUndefined();
  });

  test('applies thinking updates before answer text starts', () => {
    const sessionId = 'session-a';
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const thinkingMessage = {
      ...assistant(''),
      content: [{ thinking: 'Checking the implementation', type: 'thinking' as const }],
    };
    const thinking = reducePiAgentEvent(initial, {
      message: thinkingMessage,
      type: 'message_update',
      update: { contentIndex: 0, delta: ' implementation', type: 'thinking_delta' },
    });
    expect(thinking.liveAssistant?.content).toEqual(thinkingMessage.content);

    const answering = reducePiAgentEvent(thinking, {
      message: {
        ...thinkingMessage,
        content: [...thinkingMessage.content, { text: 'The fix is ready', type: 'text' as const }],
      },
      type: 'message_update',
      update: { contentIndex: 1, delta: 'The fix is ready', type: 'text_delta' },
    });
    expect(answering.liveAssistant?.content).toEqual([
      { thinking: 'Checking the implementation', type: 'thinking' },
      { text: 'The fix is ready', type: 'text' },
    ]);
  });

  test('does not restore a persisted assistant when message_end arrives after entry_appended', () => {
    const sessionId = 'session-a';
    const message = assistant('done', 'stop');
    const entry: PiSessionEntry = {
      id: 'entry-a',
      message,
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      toolExecutions: {},
    };
    const persisted = reducePiAgentEvent(initial, positionedAgentEvent({ entry, type: 'entry_appended' }));
    const ended = reducePiAgentEvent(persisted, { message: { ...message }, type: 'message_end' });

    expect(ended.branchEntries?.entries).toHaveLength(1);
    expect(ended.liveAssistant).toBeUndefined();
  });

  test('projects an accepted user message until its session entry is appended', () => {
    const sessionId = 'session-a';
    const initial = {
      branchEntries: branch(sessionId),
      extensionStates: {},
      open: true,
      sessionId,
      snapshot: snapshot(sessionId),
      submission: {
        entryIdsAtSubmit: new Set<string>(),
        id: 'submission-a',
        message: { content: 'hello', role: 'user' as const, timestamp: 5 },
        mode: 'prompt' as const,
        status: 'dispatching' as const,
      },
      toolExecutions: {},
      view: {
        entry: { epoch: 0, generation: 1, target: { kind: 'end' as const } },
        generation: 1,
        newTurn: {
          generation: 1,
          previousMode: 'following-end' as const,
          submissionId: 'submission-a',
          turnId: 'turn:live-user:5',
        },
        scrollMode: 'anchoring-new-turn' as const,
      },
    };
    const message = { content: 'hello', role: 'user' as const, timestamp: 7 };
    const accepted = reducePiAgentEvent(initial, positionedAgentEvent({ type: 'agent_start' }));
    expect(accepted.submission?.status).toBe('accepted');
    const started = reducePiAgentEvent(accepted, { message, type: 'message_start' });
    expect(started.liveUser).toEqual(message);
    expect(started.view?.newTurn?.turnId).toBe('turn:live-user:7');

    const entry: PiSessionEntry = {
      id: 'user-entry',
      message,
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const persisted = reducePiAgentEvent(started, positionedAgentEvent({ entry, type: 'entry_appended' }));
    expect(persisted.liveUser).toBeUndefined();
    expect(persisted.branchEntries?.entries).toEqual([entry]);
    expect(persisted.view?.newTurn?.turnId).toBe('turn:user-entry');
  });

  test('projects queue and lifecycle events into the native snapshot', () => {
    const initial = {
      extensionStates: {},
      open: true,
      sessionId: 'session-a',
      snapshot: snapshot('session-a'),
      toolExecutions: {},
    };
    const busy = reducePiAgentEvent(initial, positionedAgentEvent({ type: 'agent_start' }), 1_000);
    const repeatedStart = reducePiAgentEvent(busy, positionedAgentEvent({ type: 'agent_start' }), 2_000);
    const queued = reducePiAgentEvent(busy, {
      followUp: ['later'],
      steering: ['now'],
      queuedMessages: [
        { id: 'now', revision: 0, mode: 'steer', text: 'now', imageCount: 0 },
        { id: 'later', revision: 0, mode: 'followUp', text: 'later', imageCount: 0 },
      ],
      type: 'queue_update',
    });
    const settled = reducePiAgentEvent(queued, positionedAgentEvent({ type: 'agent_settled' }), 5_500);
    expect(repeatedStart.activityStartedAt).toBe(1_000);
    expect(queued.snapshot?.followUp).toEqual(['later']);
    expect(queued.snapshot?.steering).toEqual(['now']);
    expect(queued.snapshot?.pendingMessageCount).toBe(2);
    expect(queued.snapshot?.queuedMessages.map((message) => message.id)).toEqual(['now', 'later']);
    expect(settled.snapshot?.busy).toBe(false);
    expect(settled.activityStartedAt).toBeUndefined();
    expect(settled.settledActivityDurationMs).toBe(4_500);
  });

  test('measures each assistant output from message start to end', () => {
    const initial = {
      extensionStates: {},
      open: true,
      sessionId: 'session-a',
      snapshot: snapshot('session-a'),
      toolExecutions: {},
    };
    const assistant: PiAssistantMessage = {
      api: 'messages',
      content: [],
      model: 'model-a',
      provider: 'provider',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: 10,
      usage: { cacheRead: 0, cacheWrite: 0, cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 }, input: 0, output: 10, totalTokens: 10 },
    };
    const started = reducePiAgentEvent(initial, { message: assistant, type: 'message_start' }, 1_000);
    const ended = reducePiAgentEvent(started, { message: assistant, type: 'message_end' }, 1_250);
    expect(ended.assistantOutputDurationsMs?.['10:provider:model-a']).toBe(250);
    expect(ended.assistantOutputStartedAt).toEqual({});
  });

  test('reconciles an optimistic submission only when Pi projects its user message', () => {
    const sessionId = 'session-a';
    const existingEntry: PiSessionEntry = {
      id: 'existing-user',
      message: { content: 'older', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const initial = {
      branchEntries: branch(sessionId, [existingEntry]),
      extensionStates: {},
      open: true,
      sessionId,
      submission: {
        entryIdsAtSubmit: new Set([existingEntry.id]),
        id: 'submission-a',
        message: { content: 'new', role: 'user' as const, timestamp: 2 },
        mode: 'prompt' as const,
        status: 'dispatching' as const,
      },
      toolExecutions: {},
    };

    const repeated = reducePiAgentEvent(initial, positionedAgentEvent({ entry: existingEntry, type: 'entry_appended' }));
    expect(repeated.submission?.id).toBe('submission-a');

    const appended: PiSessionEntry = {
      id: 'new-user',
      message: { content: 'new', role: 'user', timestamp: 3 },
      parentId: existingEntry.id,
      timestamp: '2026-08-02T00:00:01.000Z',
      type: 'message',
    };
    const reconciled = reducePiAgentEvent(repeated, positionedAgentEvent({ entry: appended, type: 'entry_appended' }));
    expect(reconciled.submission).toBeUndefined();
  });
});

describe('Pi session store', () => {
  afterEach(() => {
    registerRuntimeAPIs(null);
    resetDocumentRegistry();
  });

  test('recovers a sending prompt while the last local snapshot is idle and its acceptance events were lost', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-lost-send';
    const user: PiSessionEntry = {
      id: 'accepted-user', parentId: null, type: 'message',
      timestamp: '2026-09-28T10:00:01.000Z',
      // Pi timestamps its own accepted message, not the UI's optimistic copy.
      message: { role: 'user', content: [{ type: 'text', text: 'check the project' }], timestamp: 2000 },
    };
    const reply: PiSessionEntry = {
      id: 'completed-reply', parentId: user.id, type: 'message',
      timestamp: '2026-09-28T10:00:02.000Z', message: assistant('finished'),
    };
    runtime.handler = (method) => {
      if (method === 'session.snapshot') return { ...snapshot(sessionId), leafId: reply.id };
      if (method === 'session.reconcile') return reconciled(sessionId,
        { ...snapshot(sessionId), leafId: reply.id }, branch(sessionId, [user, reply]));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ records: { [sessionId]: {
      extensionStates: {}, open: true, sessionId, snapshot: snapshot(sessionId),
      branchEntries: branch(sessionId), branchEntriesSource: 'live', toolExecutions: {},
    } } });
    const id = store.getState().beginSubmission(sessionId,
      { role: 'user', content: 'check the project', timestamp: 1000 }, 'prompt');
    store.getState().updateSubmission(sessionId, id, { dispatchedText: 'check the project', status: 'dispatching' });
    await store.getState().probeBusySession(sessionId);
    expect(runtime.calls.map((call) => call.method)).toEqual(['session.snapshot', 'session.reconcile']);
    expect(store.getState().records[sessionId]?.submission).toBeUndefined();
    expect(store.getState().records[sessionId]?.branchEntries?.entries).toEqual([user, reply]);
    expect(store.getState().records[sessionId]?.snapshot?.busy).toBe(false);
    expect(runtime.calls.some((call) => call.method === 'agent.prompt')).toBe(false);
  });

  test('a busy snapshot does not falsely acknowledge a pending message it has not received', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-unrelated-busy';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return reconciled(sessionId,
        { ...snapshot(sessionId), busy: true }, branch(sessionId));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ records: { [sessionId]: {
      extensionStates: {}, open: true, sessionId, snapshot: snapshot(sessionId),
      branchEntries: branch(sessionId), branchEntriesSource: 'live', toolExecutions: {},
    } } });
    const id = store.getState().beginSubmission(sessionId,
      { role: 'user', content: 'new message', timestamp: 1000 }, 'prompt');
    store.getState().updateSubmission(sessionId, id, { status: 'dispatching' });
    await store.getState().resyncSessions();
    expect(store.getState().records[sessionId]?.submission?.status).toBe('dispatching');
  });
  test('owns recoverable submission state per Pi session', () => {
    const store = createPiSessionStore(new FakeRuntime());
    store.setState({
      records: {
        'session-a': {
          branchEntries: branch('session-a'),
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          toolExecutions: {},
        },
      },
    });

    const id = store.getState().beginSubmission(
      'session-a',
      { content: 'hello', role: 'user', timestamp: 1 },
      'prompt',
    );
    expect(store.getState().records['session-a']?.submission?.id).toBe(id);
    expect(store.getState().records['session-a']?.submission?.mode).toBe('prompt');
    expect(store.getState().records['session-a']?.submission?.status).toBe('preparing');
    expect(store.getState().records['session-a']?.view?.newTurn).toEqual({
      generation: 1,
      previousMode: 'following-end',
      submissionId: id,
      turnId: 'turn:live-user:1',
    });
    expect(store.getState().records['session-a']?.view?.scrollMode).toBe('anchoring-new-turn');

    store.getState().updateSubmission('session-a', id, {
      dispatchedText: 'hello',
      status: 'uncertain',
    });
    expect(store.getState().records['session-a']?.submission?.dispatchedText).toBe('hello');
    expect(store.getState().records['session-a']?.submission?.status).toBe('uncertain');

    const followUpId = store.getState().beginSubmission(
      'session-a',
      { content: 'later', role: 'user', timestamp: 2 },
      'followUp',
    );
    expect(store.getState().records['session-a']?.view?.newTurn).toBeUndefined();
    expect(store.getState().records['session-a']?.view?.scrollMode).toBe('following-end');
    store.getState().updateSubmission('session-a', followUpId, { status: 'accepted' });
    expect(store.getState().records['session-a']?.submission).toBeUndefined();
  });

  test('captures attention before selection clears it and restores only an unchanged viewport', () => {
    const store = createPiSessionStore(new FakeRuntime());
    store.setState({
      attentionBySession: {
        'session-a': { kind: 'complete', updatedAt: 1 },
      },
      currentSessionId: 'session-b',
      records: {
        'session-a': {
          branchEntries: branch('session-a', [{
            id: 'leaf-1',
            message: { content: 'done', role: 'user', timestamp: 1 },
            parentId: null,
            timestamp: '1',
            type: 'message',
          }]),
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          toolExecutions: {},
          view: {
            entry: { epoch: 1, generation: 1, target: { kind: 'end' } },
            generation: 1,
            observedLeafId: 'leaf-1',
            scrollMode: 'free-scrolling',
            viewport: { itemId: 'turn:leaf-1', mode: 'free-scrolling', offset: -10 },
          },
        },
      },
    });

    store.getState().setCurrentSession('session-a');
    expect(store.getState().attentionBySession['session-a']).toBeUndefined();
    expect(store.getState().records['session-a']?.view?.entry.target).toEqual({ kind: 'end' });

    store.getState().setCurrentSession('session-b');
    store.getState().setCurrentSession('session-a');
    expect(store.getState().records['session-a']?.view?.entry.target).toEqual({
      itemId: 'turn:leaf-1',
      kind: 'turn',
      offset: -10,
    });
  });

  test('invalidates a stale return-to-latest completion after user navigation', () => {
    const store = createPiSessionStore(new FakeRuntime());
    store.setState({
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          toolExecutions: {},
          view: {
            entry: { epoch: 1, generation: 1, target: { kind: 'end' } },
            generation: 1,
            scrollMode: 'free-scrolling',
          },
        },
      },
    });

    const token = store.getState().requestTimelineReturn('session-a');
    store.getState().cancelTimelineAutomation('session-a');
    store.getState().completeTimelineReturn('session-a', token);
    expect(store.getState().records['session-a']?.view?.scrollMode).toBe('free-scrolling');
  });

  test('ignores a stale submission completion after the runtime record is reset', () => {
    const store = createPiSessionStore(new FakeRuntime());
    const id = store.getState().beginSubmission(
      'session-a',
      { content: 'hello', role: 'user', timestamp: 1 },
      'prompt',
    );

    store.getState().reset();
    store.getState().updateSubmission('session-a', id, { status: 'failed' });
    store.getState().clearSubmission('session-a', id);

    expect(store.getState().records).toEqual({});
  });

  test('clears the Pi-owned queue through the runtime and snapshot', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.queue.clear') {
        runtime.event('agent.event', { sessionId: 'session-a', event: {
          type: 'queue_update', followUp: [], steering: [], queuedMessages: [],
        } }, 'session-a');
        return { cleared: true, followUp: ['later'], steering: ['now'] };
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          snapshot: {
            ...snapshot('session-a'),
            followUp: ['later'],
            pendingMessageCount: 2,
            steering: ['now'],
          },
          toolExecutions: {},
        },
      },
    });

    expect(await store.getState().clearQueue('session-a')).toBe(true);
    expect(runtime.calls).toEqual([{
      method: 'agent.queue.clear',
      params: { sessionId: 'session-a' },
    }]);
    expect(store.getState().records['session-a']?.snapshot?.followUp).toEqual([]);
    expect(store.getState().records['session-a']?.snapshot?.pendingMessageCount).toBe(0);
    expect(store.getState().records['session-a']?.snapshot?.steering).toEqual([]);
  });

  test('a late clear acknowledgement cannot erase a newly queued message', async () => {
    const runtime = new FakeRuntime();
    const cleared = deferred<{ cleared: boolean; followUp: string[]; steering: string[] }>();
    runtime.handler = (method) => {
      if (method === 'agent.queue.clear') return cleared.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ records: { 'session-a': { extensionStates: {}, open: true, sessionId: 'session-a', snapshot: snapshot('session-a'), toolExecutions: {} } } });
    const clearing = store.getState().clearQueue('session-a', 'runtime-a');
    await flushAsync();
    runtime.event('agent.event', { sessionId: 'session-a', event: { type: 'queue_update', followUp: ['new'], steering: [],
      queuedMessages: [{ id: 'new', revision: 0, mode: 'followUp', text: 'new', imageCount: 1 }],
    } }, 'session-a');
    cleared.resolve({ cleared: true, followUp: ['old'], steering: [] });
    await clearing;
    expect(store.getState().records['session-a']?.snapshot?.queuedMessages[0]?.id).toBe('new');
    expect(store.getState().records['session-a']?.snapshot?.pendingMessageCount).toBe(1);
  });

  test('queue controls cannot submit an old surface action to a different runtime', async () => {
    const runtime = new FakeRuntime();
    const store = createPiSessionStore(runtime);
    runtime.switchTo('runtime-b');
    await expect(store.getState().updateQueue({ sessionId: 'session-a', id: 'queued-a', revision: 0, action: 'steer' }, 'runtime-a')).rejects.toThrow();
    await expect(store.getState().clearQueue('session-a', 'runtime-a')).rejects.toThrow();
    expect(runtime.calls).toEqual([]);
  });

  test('loads, sorts, and splits the native catalog', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') {
        return [
          summary('older', '2026-08-01T00:00:00.000Z'),
          summary('archived', '2026-08-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z'),
          summary('newer', '2026-08-02T00:00:00.000Z'),
        ];
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().loadCatalog();

    expect(store.getState().summaries.map((candidate) => candidate.id)).toEqual([
      'archived',
      'newer',
      'older',
    ]);
    expect(selectActivePiSessions(store.getState()).map((candidate) => candidate.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(selectArchivedPiSessions(store.getState()).map((candidate) => candidate.id)).toEqual([
      'archived',
    ]);
  });

  test('canonicalizes the workspace binding without changing the required cwd', async () => {
    registerRuntimeAPIs({
      documents: {
        resolveWorkspace: async () => ({ epoch: 1, hostId: 'host-a', workspaceId: 'canonical-workspace-a' }),
      },
    } as unknown as RuntimeAPIs);
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.create') return {
        ...snapshot('session-a', 'D:/worktree/feature'),
        workspace: { authorityId: 'canonical-workspace-a', id: 'workspace-a', kind: 'workspace' },
        workspacePersistence: 'pending',
      } satisfies SessionSnapshot;
      if (method === 'session.entries') return branch('session-a');
      if (method === 'recovery.status') return recoveryStatus;
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().createSession(
      'D:/worktree/feature',
      undefined,
      undefined,
      { id: 'workspace-a', kind: 'workspace' },
      'research',
    );

    expect(runtime.calls.find((call) => call.method === 'session.create')?.params).toEqual({
      cwd: 'D:/worktree/feature',
      workspace: { authorityId: 'canonical-workspace-a', id: 'workspace-a', kind: 'workspace' },
      workFocus: 'research',
    });
    runtime.event('session.snapshot', snapshot('session-a', 'D:/worktree/feature'), 'session-a');
    expect(store.getState().records['session-a']?.snapshot?.workspace).toEqual({
      authorityId: 'canonical-workspace-a',
      id: 'workspace-a',
      kind: 'workspace',
    });
    expect(store.getState().records['session-a']?.snapshot?.workspacePersistence).toBe('pending');
  });

  test('keeps the active focus while a new selection waits for its execution boundary', async () => {
    const runtime = new FakeRuntime();
    const active = { id: 'code', source: 'project-default', generation: 1 } as const;
    const pending: SessionSnapshot = {
      ...snapshot('session-a'),
      busy: true,
      isStreaming: true,
      workFocus: { active, selected: { id: 'research', source: 'explicit' }, status: 'pending' },
    };
    runtime.handler = (method) => {
      if (method === 'session.workFocus.set') return pending;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().selectWorkFocus('session-a', 'research');
    expect(runtime.calls).toEqual([{
      method: 'session.workFocus.set', params: { sessionId: 'session-a', workFocus: 'research' },
    }]);
    expect(store.getState().records['session-a']?.snapshot?.workFocus).toEqual(pending.workFocus);
    expect(store.getState().records['session-a']?.snapshot?.isStreaming).toBe(true);

    runtime.event('session.snapshot', {
      ...pending,
      workFocus: { ...pending.workFocus!, status: 'failed', failure: { message: 'Could not prepare tools', at: 1 } },
    }, 'session-a');
    expect(store.getState().records['session-a']?.snapshot?.workFocus?.active).toEqual(active);
    expect(store.getState().records['session-a']?.snapshot?.workFocus?.status).toBe('failed');
  });

  test('migrates an existing project workspace binding when the session opens', async () => {
    registerRuntimeAPIs({
      documents: {
        resolveWorkspace: async ({ path }: { path?: string }) => {
          expect(path).toBe('D:/work');
          return { epoch: 1, hostId: 'host-a', workspaceId: 'canonical-workspace-a' };
        },
      },
    } as unknown as RuntimeAPIs);
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      if (method === 'session.list') return [{
        ...summary('session-a', '2026-08-02T00:00:00.000Z'),
        workspace: { id: 'legacy-project-id', kind: 'workspace' },
      }];
      if (method === 'session.open') return {
        ...snapshot('session-a'),
        workspace: (params as { workspace?: SessionSummary['workspace'] }).workspace,
      };
      if (method === 'session.entries') return branch('session-a');
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    await store.getState().openSession({ sessionId: 'session-a' });

    expect(runtime.calls.find((call) => call.method === 'session.open')?.params).toEqual({
      sessionId: 'session-a',
      workspace: { authorityId: 'canonical-workspace-a', id: 'legacy-project-id', kind: 'workspace' },
    });
    expect(store.getState().records['session-a']?.snapshot?.workspace).toEqual({
      authorityId: 'canonical-workspace-a',
      id: 'legacy-project-id',
      kind: 'workspace',
    });
  });

  test('keeps derived catalog selector references stable until summaries change', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') {
        return [
          summary('active', '2026-08-02T00:00:00.000Z'),
          summary('archived', '2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
        ];
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    const active = selectActivePiSessions(store.getState());
    const archived = selectArchivedPiSessions(store.getState());
    expect(selectActivePiSessions(store.getState())).toBe(active);
    expect(selectArchivedPiSessions(store.getState())).toBe(archived);

    store.setState({ catalogLoading: true });
    expect(selectActivePiSessions(store.getState())).toBe(active);
    expect(selectArchivedPiSessions(store.getState())).toBe(archived);

    store.setState({ summaries: [...store.getState().summaries] });
    expect(selectActivePiSessions(store.getState())).not.toBe(active);
    expect(selectArchivedPiSessions(store.getState())).not.toBe(archived);
  });

  test('opens a Pi session, reads the complete branch, and consumes routed events', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    await store.getState().openSession({ cwd: 'D:/work', sessionId: 'session-a' });
    await flushAsync();
    runtime.event('agent.event', {
      event: positionedAgentEvent({ type: 'agent_start' }),
      sessionId: 'session-a',
    }, 'session-a');
    runtime.event('extension.state', {
      channel: 'pi-mcp-adapter/status/v1',
      sessionId: 'session-a',
      value: { connectedCount: 1, version: 1 },
    }, 'session-a');

    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
    expect(store.getState().records['session-a']?.snapshot?.busy).toBe(true);
    expect(store.getState().records['session-a']?.extensionStates['pi-mcp-adapter/status/v1'])
      .toEqual({ connectedCount: 1, version: 1 });

    runtime.event('extension.state', {
      channel: 'pi-mcp-adapter/status/v1',
      sessionId: 'session-a',
      value: null,
    }, 'session-a');
    expect(store.getState().records['session-a']?.extensionStates).toEqual({});
  });

  test('settles live state when the owning session worker exits', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.setState({
      records: {
        'session-crashed': {
          activityStartedAt: 0,
          extensionStates: {},
          liveAssistant: assistant('partial'),
          open: true,
          sessionId: 'session-crashed',
          snapshot: { ...snapshot('session-crashed'), busy: true, isStreaming: true },
          toolExecutions: {
            running: {
              args: null,
              name: 'bash',
              status: 'running',
              toolCallId: 'running',
            },
          },
        },
      },
    });

    runtime.event('session.worker.exited', {
      code: 1,
      expected: false,
      sessionId: 'session-crashed',
      signal: null,
    }, 'session-crashed');

    const record = store.getState().records['session-crashed'];
    expect(record?.open).toBe(false);
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.snapshot?.isStreaming).toBe(false);
    expect(record?.liveAssistant?.stopReason).toBe('error');
    expect(record?.toolExecutions.running?.status).toBe('error');
    expect(record?.activityStartedAt).toBeUndefined();
    expect(record?.settledActivityDurationMs).toBeGreaterThan(0);
    expect(store.getState().attentionBySession['session-crashed']?.kind).toBe('error');
  });

  test('tracks background completion and errors as Pi-native session attention', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.getState().setCurrentSession('session-visible');

    runtime.event('agent.event', {
      event: positionedAgentEvent({
        messages: [assistant('done', 'stop')],
        type: 'agent_end',
        willRetry: false,
      }),
      sessionId: 'session-background',
    }, 'session-background');
    runtime.event('agent.event', {
      event: positionedAgentEvent({
        messages: [{ ...assistant('failed', 'error'), errorMessage: 'failed' }],
        type: 'agent_end',
        willRetry: false,
      }),
      sessionId: 'session-error',
    }, 'session-error');
    runtime.event('agent.event', {
      event: positionedAgentEvent({
        messages: [assistant('visible', 'stop')],
        type: 'agent_end',
        willRetry: false,
      }),
      sessionId: 'session-visible',
    }, 'session-visible');

    expect(store.getState().attentionBySession['session-background']?.kind).toBe('complete');
    expect(store.getState().attentionBySession['session-error']?.kind).toBe('error');
    expect(store.getState().attentionBySession['session-visible']).toBeUndefined();

    store.getState().setCurrentSession('session-background');
    expect(store.getState().attentionBySession['session-background']).toBeUndefined();
  });

  test('does not mark retrying or aborted work as attention', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    runtime.event('agent.event', {
      event: positionedAgentEvent({
        messages: [assistant('retrying', 'error')],
        type: 'agent_end',
        willRetry: true,
      }),
      sessionId: 'session-retry',
    }, 'session-retry');
    runtime.event('agent.event', {
      event: positionedAgentEvent({
        messages: [assistant('aborted', 'aborted')],
        type: 'agent_end',
        willRetry: false,
      }),
      sessionId: 'session-aborted',
    }, 'session-aborted');

    expect(store.getState().attentionBySession).toEqual({});
  });

  test('manual abort freezes the rendered assistant while the fact stream keeps updating state', async () => {
    const runtime = new FakeRuntime();
    const abortGate = deferred<{ aborted: boolean }>();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return abortGate.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-manual-abort';

    runtime.event('session.snapshot', {
      ...snapshot(sessionId),
      busy: true,
      isStreaming: true,
    }, sessionId);
    runtime.event('agent.event', {
      event: {
        message: assistant('visible before stop', 'pending'),
        type: 'message_start',
      },
      sessionId,
    }, sessionId);

    const pendingAbort = store.getState().abort(sessionId);
    await flushAsync();

    const immediatelyStopped = store.getState().records[sessionId];
    // The rendered copy freezes at the stop point...
    expect(immediatelyStopped?.stoppedAssistant?.content).toEqual([{ text: 'visible before stop', type: 'text' }]);
    expect(immediatelyStopped?.stoppedAssistant?.stopReason).toBe('aborted');
    expect(immediatelyStopped?.stoppedAssistant?.errorMessage).toBeUndefined();
    expect(immediatelyStopped?.stopState).toBe('requested');
    // ...but authoritative events keep updating the record underneath, so the
    // real provider stream is never lost or rewritten.
    expect(immediatelyStopped?.liveAssistant?.content).toEqual([{ text: 'visible before stop', type: 'text' }]);
    expect(immediatelyStopped?.snapshot?.busy).toBe(true);
    expect(immediatelyStopped?.snapshot?.isStreaming).toBe(false);

    runtime.event('agent.event', {
      event: {
        message: {
          ...assistant('visible before stop', 'pending'),
          content: [{ text: 'visible before stop, late chunk', type: 'text' }],
        },
        type: 'message_update',
        update: { contentIndex: 0, delta: ', late chunk', type: 'text_delta' },
      },
      sessionId,
    }, sessionId);
    const lateState = store.getState().records[sessionId];
    expect(lateState?.liveAssistant?.content).toEqual([
      { text: 'visible before stop, late chunk', type: 'text' },
    ]);
    expect(lateState?.stoppedAssistant?.content).toEqual([{ text: 'visible before stop', type: 'text' }]);

    abortGate.resolve({ aborted: true });
    expect(await pendingAbort).toBe(true);
    expect(store.getState().records[sessionId]?.stopState).toBe('accepted');

    runtime.event('agent.event', {
      event: positionedAgentEvent({ type: 'agent_settled' }),
      sessionId,
    }, sessionId);
    const settled = store.getState().records[sessionId];
    expect(settled?.snapshot?.busy).toBe(false);
    expect(settled?.stopState).toBeUndefined();
    expect(settled?.stoppedAssistant).toBeUndefined();
  });

  test('a lost abort reply is reported as unknown, then settles through the authoritative snapshot', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') throw new DOMException('This operation was aborted', 'AbortError');
      if (method === 'session.reconcile') return reconciled(
        'session-abort-error', { ...snapshot('session-abort-error'), busy: false },
      );
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-abort-error';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, isStreaming: true }, sessionId);
    runtime.event('agent.event', {
      event: { message: assistant('partial', 'pending'), type: 'message_start' },
      sessionId,
    }, sessionId);

    // The transport AbortError does not prove the host cancelled anything.
    expect(await store.getState().abort(sessionId)).toBe(false);
    expect(store.getState().records[sessionId]?.stopState).toBe('unknown');
    expect(store.getState().records[sessionId]?.stoppedAssistant?.stopReason).toBe('aborted');

    // The triggered resync observes the settled run and clears the stop marker.
    await flushAsync();
    await flushAsync();
    const record = store.getState().records[sessionId];
    expect(record?.stopState).toBeUndefined();
    expect(record?.stoppedAssistant).toBeUndefined();
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.liveAssistant).toBeUndefined();
    expect(record?.syncState).toBe('synced');
  });

  test('a late stop acknowledgement cannot resurrect stopping after settlement or a new run', async () => {
    const runtime = new FakeRuntime();
    const gate = deferred<{ aborted: boolean }>();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return gate.promise;
      throw new Error('Unexpected ' + method);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-stop-late';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, isStreaming: true }, sessionId);
    const stopping = store.getState().abort(sessionId);
    await flushAsync();
    runtime.event('agent.event', { event: positionedAgentEvent({ type: 'agent_settled' }), sessionId }, sessionId);
    runtime.event('agent.event', { event: positionedAgentEvent({ type: 'agent_start' }), sessionId }, sessionId);
    runtime.event('agent.event', { event: { type: 'message_start', message: assistant('new run', 'pending') }, sessionId }, sessionId);
    gate.resolve({ aborted: true });
    await stopping;
    expect(store.getState().records[sessionId]?.stopState).toBeUndefined();
    expect(store.getState().records[sessionId]?.stoppedAssistant).toBeUndefined();
    expect(store.getState().records[sessionId]?.liveAssistant?.content).toEqual([{ text: 'new run', type: 'text' }]);
  });

  test('a late stop failure after reset cannot erase a new stop request', async () => {
    const runtime = new FakeRuntime();
    const oldGate = deferred<{ aborted: boolean }>();
    const newGate = deferred<{ aborted: boolean }>();
    let calls = 0;
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return ++calls === 1 ? oldGate.promise : newGate.promise;
      throw new Error('Unexpected ' + method);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-stop-reset-reply';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    const oldStop = store.getState().abort(sessionId).catch(() => false);
    await flushAsync();
    store.getState().reset();
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    const newStop = store.getState().abort(sessionId);
    await flushAsync();
    oldGate.reject(new Error('old transport failure'));
    await oldStop;
    expect(store.getState().records[sessionId]?.stopState).toBe('requested');
    expect(store.getState().lastError).toBeNull();
    newGate.resolve({ aborted: true }); await newStop;
  });

  test('a stop request carries the observed run identity to the host', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return { aborted: false };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-targeted-stop';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, runId: 'run-one' }, sessionId);
    expect(await store.getState().abort(sessionId)).toBe(false);
    expect(runtime.calls.find((call) => call.method === 'agent.abort')?.params).toEqual({
      expectedRunId: 'run-one', sessionId,
    });
    expect(store.getState().records[sessionId]?.stopState).toBeUndefined();
  });

  test('stop waits for a known run identity instead of cancelling whichever run is current', async () => {
    const runtime = new FakeRuntime();
    const snapshotGate = deferred<SessionSnapshot>();
    const sessionId = 'session-stop-unidentified';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return snapshotGate.promise.then((value) => reconciled(sessionId, value));
      if (method === 'agent.abort') return { aborted: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', {
      ...snapshot(sessionId), busy: true, runId: undefined,
    }, sessionId);
    expect(await store.getState().abort(sessionId)).toBe(false);
    await flushAsync();
    expect(runtime.calls.filter((call) => call.method === 'agent.abort')).toHaveLength(0);
    expect(store.getState().records[sessionId]?.syncState).toBe('catchingUp');
    snapshotGate.resolve({ ...snapshot(sessionId), busy: true, runId: 'run-confirmed' });
    await flushAsync();
    await flushAsync();
    expect(store.getState().records[sessionId]?.snapshot?.runId).toBe('run-confirmed');
    expect(await store.getState().abort(sessionId)).toBe(true);
    expect(runtime.calls.find((call) => call.method === 'agent.abort')?.params).toEqual({
      expectedRunId: 'run-confirmed', sessionId,
    });
  });

  test('a late settled event from the prior run cannot idle the current run', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-stale-settle';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, runId: 'run-old' }, sessionId);
    runtime.event('agent.event', {
      event: { ...positionedAgentEvent({ type: 'agent_start' }), runId: 'run-new' }, sessionId,
    }, sessionId);
    runtime.event('agent.event', {
      event: { message: assistant('new run'), runId: 'run-new', type: 'message_start' }, sessionId,
    }, sessionId);
    runtime.event('agent.event', {
      event: { ...positionedAgentEvent({ type: 'agent_settled' }), runId: 'run-old' }, sessionId,
    }, sessionId);
    expect(store.getState().records[sessionId]?.snapshot?.busy).toBe(true);
    expect(store.getState().records[sessionId]?.snapshot?.runId).toBe('run-new');
    expect(store.getState().records[sessionId]?.liveAssistant?.content).toEqual([{ text: 'new run', type: 'text' }]);
  });

  test('a stale stop marker never leaks into the next run', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return { aborted: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-stop-run';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, isStreaming: true }, sessionId);
    runtime.event('agent.event', {
      event: { message: assistant('run one', 'pending'), type: 'message_start' },
      sessionId,
    }, sessionId);

    expect(await store.getState().abort(sessionId)).toBe(true);
    expect(store.getState().records[sessionId]?.stopState).toBe('accepted');

    // A new run starts before the old settle event: the stop request is gone
    // and its frozen display copy must not shadow the new run's output.
    runtime.event('agent.event', {
      event: positionedAgentEvent({ type: 'agent_start' }),
      sessionId,
    }, sessionId);
    runtime.event('agent.event', {
      event: { message: assistant('run two live', 'pending'), type: 'message_start' },
      sessionId,
    }, sessionId);
    const record = store.getState().records[sessionId];
    expect(record?.stopState).toBeUndefined();
    expect(record?.stoppedAssistant).toBeUndefined();
    expect(record?.liveAssistant?.content).toEqual([{ text: 'run two live', type: 'text' }]);
  });

  test('reset clears pending stop state', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'agent.abort') return new Promise(() => undefined);
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    const sessionId = 'session-stop-reset';
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    void store.getState().abort(sessionId);
    await flushAsync();
    expect(store.getState().records[sessionId]?.stopState).toBe('requested');

    store.getState().reset();
    expect(store.getState().records[sessionId]).toBeUndefined();

    runtime.switchTo('runtime-a');
    runtime.event('agent.event', {
      event: { message: assistant('fresh', 'pending'), type: 'message_start' },
      sessionId,
    }, sessionId);
    expect(store.getState().records[sessionId]?.stoppedAssistant).toBeUndefined();
  });

  test('reconnect resync replaces state from the authoritative snapshot and replays only post-watermark events', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-resync';
    const snapshotGate = deferred<SessionSnapshot>();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return snapshotGate.promise.then((value) => reconciled(sessionId, value));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    // Live state before the transport died.
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, isStreaming: true }, sessionId, 3);
    runtime.event('agent.event', {
      event: { message: assistant('half', 'pending'), type: 'message_start' },
      sessionId,
    }, sessionId, 4);

    runtime.reconnect();
    await flushAsync();
    expect(runtime.calls.map((call) => call.method)).toContain('session.reconcile');
    expect(store.getState().records[sessionId]?.syncState).toBe('catchingUp');

    // While the snapshot RPC is in flight the socket already replays events:
    // seq 5 predates the read (must not regress it), seq 7 is genuinely newer.
    runtime.event('agent.event', {
      event: {
        message: assistant('stale delayed chunk', 'pending'),
        type: 'message_update',
        update: { contentIndex: 0, delta: ' delayed', type: 'text_delta' },
      },
      sessionId,
    }, sessionId, 5);
    runtime.event('agent.event', {
      event: positionedAgentEvent({ type: 'agent_settled' }),
      sessionId,
    }, sessionId, 7);

    snapshotGate.resolve({
      ...snapshot(sessionId),
      busy: true,
      eventWatermark: 6,
      eventWorkerId: sessionId,
      isStreaming: true,
      liveAssistant: assistant('at snapshot', 'pending'),
    });
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const record = store.getState().records[sessionId];
    // The pre-watermark event must not clobber the newer snapshot content;
    // the post-watermark settle applies on top.
    expect(record?.liveAssistant?.content).toEqual([{ text: 'at snapshot', type: 'text' }]);
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.snapshot?.isStreaming).toBe(false);
    expect(record?.syncState).toBe('synced');
    // Resync is read-only: nothing resubmits prompts or tools.
    expect(runtime.calls.every((call) => call.method !== 'agent.prompt')).toBe(true);
  });

  test('resync folds a missed persisted answer into entries and clears the stale overlay', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-completed-offline';
    let snapshotReads = 0;
    runtime.handler = (method, params) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') {
        snapshotReads += 1;
        return reconciled(sessionId,
          { ...snapshot(sessionId), busy: false, isStreaming: false, eventWatermark: 9 },
          branch(sessionId, [{
            id: 'entry-final', parentId: null, timestamp: '2026-09-26T00:00:00.000Z',
            type: 'message', message: { ...assistant('final answer', 'stop'), timestamp: 42 },
          }]));
      }
      if (method === 'session.entries') {
        const scope = (params as { scope?: string }).scope ?? 'branch';
        return {
          entries: [{
            id: 'entry-final',
            parentId: null,
            timestamp: '2026-09-26T00:00:00.000Z',
            type: 'message',
            message: { ...assistant('final answer', 'stop'), timestamp: 42 },
          }],
          leafId: 'entry-final',
          scope,
          sessionId,
        };
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true, isStreaming: true }, sessionId, 3);
    runtime.event('agent.event', {
      event: {
        message: { ...assistant('half of an answer', 'pending'), timestamp: 42 },
        type: 'message_start',
      },
      sessionId,
    }, sessionId, 4);
    // Load the branch scope so resync refreshes it.
    await store.getState().refreshEntries(sessionId);
    expect(store.getState().records[sessionId]?.branchEntries?.entries).toHaveLength(1);

    // The run finished while disconnected: final entry appended, settle missed.
    runtime.reconnect();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const record = store.getState().records[sessionId];
    expect(snapshotReads).toBeGreaterThan(0);
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.liveAssistant).toBeUndefined();
    expect(record?.branchEntries?.entries.map((entry) => entry.id)).toEqual(['entry-final']);
    expect(record?.syncState).toBe('synced');
  });

  test('entries read after a busy snapshot suppress an assistant already persisted', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-persisted-during-sync';
    const finalMessage = { ...assistant('complete answer', 'stop'), timestamp: 42 };
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return reconciled(sessionId, {
        ...snapshot(sessionId), busy: true, eventWatermark: 5, eventWorkerId: sessionId,
        liveAssistant: { ...assistant('partial'), timestamp: 42 },
      }, branch(sessionId, [{
        id: 'entry-final', parentId: null, timestamp: '2026-09-26T00:00:00.000Z',
        type: 'message', message: finalMessage,
      }]));
      if (method === 'session.entries') return branch(sessionId, [{
        id: 'entry-final', parentId: null, timestamp: '2026-09-26T00:00:00.000Z',
        type: 'message', message: finalMessage,
      }]);
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    await store.getState().refreshEntries(sessionId);
    await store.getState().resyncSessions();
    const record = store.getState().records[sessionId];
    expect(record?.branchEntries?.entries.map((entry) => entry.id)).toEqual(['entry-final']);
    expect(record?.liveAssistant).toBeUndefined();
  });

  test('a detected sequence gap triggers the same authoritative resync', async () => {
    const runtime = new FakeRuntime();
    const sessionId = 'session-gap';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return reconciled(
        sessionId, { ...snapshot(sessionId), busy: false, eventWatermark: 12 },
      );
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId, 10);

    runtime.sequenceGap(sessionId);
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const record = store.getState().records[sessionId];
    expect(record?.snapshot?.busy).toBe(false);
    expect(record?.syncState).toBe('synced');
    expect(runtime.calls.map((call) => call.method)).toContain('session.reconcile');
  });

  test('a gap detected during a resync schedules another authoritative read', async () => {
    const runtime = new FakeRuntime();
    const firstSnapshot = deferred<SessionSnapshot>();
    const sessionId = 'session-gap-during-sync';
    let reads = 0;
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return ++reads === 1
        ? firstSnapshot.promise.then((value) => reconciled(sessionId, value))
        : reconciled(sessionId,
          { ...snapshot(sessionId), busy: false, eventWatermark: 12, eventWorkerId: sessionId });
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    const first = store.getState().resyncSessions();
    await flushAsync();
    // The frame exposing a surface gap can come from the catalog; the missing
    // frame's session is unknown, so every tracked session must be re-read.
    runtime.sequenceGap();
    await flushAsync();
    firstSnapshot.resolve({ ...snapshot(sessionId), busy: true, eventWatermark: 8, eventWorkerId: sessionId });
    await first;
    await flushAsync();
    expect(reads).toBe(2);
    expect(store.getState().records[sessionId]?.snapshot?.busy).toBe(false);
    expect(store.getState().records[sessionId]?.syncState).toBe('synced');
  });

  test('protocol anomalies trigger one bounded authoritative recovery while connected', async () => {
    const runtime = new FakeRuntime();
    const cut = deferred<SessionSnapshot>();
    const sessionId = 'session-protocol-error';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return cut.promise.then((value) => reconciled(sessionId, value));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    runtime.protocolError();
    runtime.protocolError();
    await flushAsync();
    expect(runtime.calls.filter((call) => call.method === 'session.reconcile')).toHaveLength(1);
    expect(store.getState().records[sessionId]?.syncState).toBe('catchingUp');
    cut.resolve({ ...snapshot(sessionId), busy: false, eventWatermark: 5, eventWorkerId: sessionId });
    await flushAsync();
    expect(store.getState().records[sessionId]?.syncState).toBe('synced');
    expect(store.getState().records[sessionId]?.snapshot?.busy).toBe(false);
  });

  test('a superseded resync cannot flush or mark the next resync stale after reset', async () => {
    const runtime = new FakeRuntime();
    const oldSnapshot = deferred<SessionSnapshot>();
    const newSnapshot = deferred<SessionSnapshot>();
    let reads = 0;
    const sessionId = 'session-resync-reset';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return (++reads === 1 ? oldSnapshot.promise : newSnapshot.promise)
        .then((value) => reconciled(sessionId, value));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    const first = store.getState().resyncSessions();
    await flushAsync();
    store.getState().reset();
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', { ...snapshot(sessionId), busy: true }, sessionId);
    const second = store.getState().resyncSessions();
    await flushAsync();
    runtime.event('agent.event', {
      event: { message: assistant('new stream'), type: 'message_start' }, sessionId,
    }, sessionId, 8);
    oldSnapshot.resolve({ ...snapshot(sessionId), busy: false, eventWatermark: 9, eventWorkerId: sessionId });
    await first;
    expect(store.getState().records[sessionId]?.syncState).toBe('catchingUp');
    expect(store.getState().records[sessionId]?.liveAssistant).toBeUndefined();
    newSnapshot.resolve({ ...snapshot(sessionId), busy: true, eventWatermark: 7, eventWorkerId: sessionId });
    await second;
    expect(store.getState().records[sessionId]?.syncState).toBe('synced');
    expect(store.getState().records[sessionId]?.liveAssistant?.content).toEqual([{ text: 'new stream', type: 'text' }]);
  });

  test('a snapshot watermark never discards a newer worker stream with lower sequence numbers', async () => {
    const runtime = new FakeRuntime();
    const snapshotGate = deferred<SessionSnapshot>();
    const sessionId = 'session-worker-swap';
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      if (method === 'session.reconcile') return snapshotGate.promise.then((value) => reconciled(sessionId, value));
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    runtime.event('session.snapshot', {
      ...snapshot(sessionId), busy: true, runId: 'run-old',
    }, sessionId, 4);
    const syncing = store.getState().resyncSessions();
    await flushAsync();
    const emitNewWorker = (event: RuntimeEventEnvelope['event'], data: RuntimeEventEnvelope['data'], seq: number) => {
      runtime.emit({
        data, event, kind: 'event', seq,
        source: { role: 'session', runtimeGeneration: 1, sessionId, workerId: 'worker-new' },
        v: VARIN_PROTOCOL_VERSION,
      } as RuntimeEventEnvelope);
    };
    emitNewWorker('session.snapshot', {
      ...snapshot(sessionId), busy: true, runId: 'run-new',
    }, 1);
    emitNewWorker('agent.event', {
      event: { message: assistant('new worker'), runId: 'run-new', type: 'message_start' }, sessionId,
    }, 2);
    snapshotGate.resolve({
      ...snapshot(sessionId), busy: true, eventWatermark: 9,
      eventWorkerId: sessionId, runId: 'run-old',
    });
    await syncing;
    const record = store.getState().records[sessionId];
    expect(record?.snapshot?.runId).toBe('run-new');
    expect(record?.liveAssistant?.content).toEqual([{ text: 'new worker', type: 'text' }]);
  });

  test('executes extension commands through the active Pi session', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'command.execute') return { executed: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().executeCommand('session-a', '/mcp reconnect docs');
    expect(result).toEqual({ executed: true });
    expect(runtime.calls).toEqual([{
      method: 'command.execute',
      params: { command: '/mcp reconnect docs', sessionId: 'session-a' },
    }]);
  });

  test('runs explicit compaction through the session runtime with optional focus', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.compact') {
        return { taskId: 'manual-1', status: 'preparing' };
      }
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().compactSession(
      'session-a',
      'Keep the migration decision and the remaining validation step.',
    );

    expect(result).toEqual({ taskId: 'manual-1', status: 'preparing' });
    expect(store.getState().records['session-a']?.compactionTraces?.['manual-1']?.manual).toBe(true);
    expect(runtime.calls).toEqual([{
      method: 'agent.compact',
      params: {
        customInstructions: 'Keep the migration decision and the remaining validation step.',
        sessionId: 'session-a',
      },
    }]);
  });

  test('requests application of the selected summary and keeps applying until the commit arrives', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = method => {
      if (method === 'agent.compact.apply') return { accepted: true, taskId: 'task-a' };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().applyCompaction('session-a', 'task-a');
    expect(runtime.calls).toEqual([{ method: 'agent.compact.apply', params: { sessionId: 'session-a', taskId: 'task-a' } }]);
    const emit = (type: 'finished' | 'apply-requested' | 'committed', seq: number) => runtime.emit({
      kind: 'event', event: 'compaction.trace', seq,
      data: { sessionId: 'session-a', taskId: 'task-a', type },
      source: { role: 'session', runtimeGeneration: 1, sessionId: 'session-a', workerId: 'worker-session' },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
    emit('finished', 1);
    emit('apply-requested', 2);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('applying');
    emit('finished', 3);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('applying');
    emit('committed', 4);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('committed');
  });

  test('shows auxiliary compaction steps in the owning chat without merging them into its assistant turn', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.compact') return { taskId: 'task-a', status: 'preparing' };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().compactSession('session-a');
    runtime.emit({
      kind: 'event', event: 'compaction.trace', seq: 1,
      data: { sessionId: 'session-a', taskId: 'task-a', type: 'requested', manual: true, phase: 'preparing' },
      source: { role: 'session', runtimeGeneration: 1, sessionId: 'session-a', workerId: 'worker-session' },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('requested');
    const emitTrace = (type: 'started' | 'entry' | 'finished', entry?: { kind: 'assistant'; at: number; text: string }) => {
      runtime.emit({
        kind: 'event', event: 'compaction.trace', seq: type === 'started' ? 1 : type === 'entry' ? 3 : 4,
        data: { sessionId: 'session-a', taskId: 'task-a', type, ...(entry ? { entry } : {}) },
        source: { role: 'compaction', runtimeGeneration: 1, sessionId: 'session-a', workerId: 'worker-compaction' },
        v: VARIN_PROTOCOL_VERSION,
      } as RuntimeEventEnvelope);
    };
    emitTrace('started');
    runtime.emit({
      kind: 'event', event: 'compaction.trace', seq: 2,
      data: { sessionId: 'session-a', taskId: 'task-a', type: 'delta', channel: 'thinking', delta: 'Checking' },
      source: { role: 'compaction', runtimeGeneration: 1, sessionId: 'session-a', workerId: 'worker-compaction' },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.partial?.thinking).toBe('Checking');
    emitTrace('entry', { kind: 'assistant', at: 1, text: 'Checking the current task.' });
    emitTrace('finished');
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']).toEqual({
      taskId: 'task-a', status: 'ready', manual: true, partial: { text: '', thinking: '' },
      entries: [{ kind: 'assistant', at: 1, text: 'Checking the current task.' }],
    });
    runtime.emit({
      kind: 'event', event: 'compaction.trace', seq: 5,
      data: { sessionId: 'session-a', taskId: 'task-a', type: 'committed' },
      source: { role: 'session', runtimeGeneration: 1, sessionId: 'session-a', workerId: 'worker-session' },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('committed');
    emitTrace('started');
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('committed');
    expect(store.getState().records['session-a']?.liveAssistant).toBeUndefined();
  });

  test('shows a compaction retry and ignores late output from its retired worker', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.compact') return { taskId: 'task-a', status: 'preparing' };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().compactSession('session-a');
    const emitTrace = (workerId: string, seq: number, data: Record<string, unknown>) => runtime.emit({
      kind: 'event', event: 'compaction.trace', seq,
      data: { sessionId: 'session-a', taskId: 'task-a', ...data },
      source: { role: workerId === 'session-worker' ? 'session' : 'compaction',
        runtimeGeneration: 1, sessionId: 'session-a', workerId },
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope);

    emitTrace('old-worker', 1, { type: 'started', attempt: 1 });
    emitTrace('old-worker', 2, { type: 'delta', attempt: 1, channel: 'text', delta: 'old partial' });
    emitTrace('session-worker', 1, { type: 'retrying', attempt: 2, maxAttempts: 2, reason: 'stalled' });
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('retrying');
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.attempt).toBe(2);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.partial).toEqual({ text: '', thinking: '' });
    emitTrace('old-worker', 3, { type: 'delta', attempt: 1, channel: 'text', delta: 'late old output' });
    emitTrace('new-worker', 1, { type: 'started', attempt: 2 });
    emitTrace('new-worker', 2, { type: 'delta', attempt: 2, channel: 'text', delta: 'new summary' });
    emitTrace('session-worker', 2, { type: 'retrying', attempt: 2, maxAttempts: 2, reason: 'late retry notice' });
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.status).toBe('running');
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.attempt).toBe(2);
    expect(store.getState().records['session-a']?.compactionTraces?.['task-a']?.partial).toEqual({ text: 'new summary', thinking: '' });
  });

  test('loads the authoritative Pi session tree', async () => {
    const runtime = new FakeRuntime();
    const tree = {
      leafId: 'entry-a',
      sessionId: 'session-a',
      tree: [{
        children: [],
        entry: {
          id: 'entry-a',
          message: { content: 'hello', role: 'user', timestamp: 1 },
          parentId: null,
          timestamp: '2026-08-29T00:00:00.000Z',
          type: 'message',
        },
      }],
    } as const;
    runtime.handler = (method) => {
      if (method === 'session.tree') return tree;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().getSessionTree('session-a');
    expect(result).toEqual(tree);
    expect(runtime.calls).toEqual([{
      method: 'session.tree',
      params: { sessionId: 'session-a' },
    }]);
  });

  test('invalidates command metadata after a successful Pi reload', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'command.execute') return { executed: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const reasons: string[] = [];
    const unsubscribe = subscribePiRuntimeCatalogChanged((reason) => reasons.push(reason));

    try {
      await store.getState().executeCommand('session-a', '/reload');
      expect(reasons).toEqual(['reload']);
    } finally {
      unsubscribe();
    }
  });

  test('applies a Pi-native feature mutation to the live session snapshot', async () => {
    const runtime = new FakeRuntime();
    const features = {
      goal: {
        auditFailStreak: 0,
        blockedStreak: 0,
        createdAt: 1,
        id: 'goal-1',
        objective: 'Finish the native migration',
        status: 'active' as const,
        tokenBaseline: 0,
        tokensUsed: 0,
        turnsUsed: 0,
        updatedAt: 1,
      },
      revision: 1,
      schemaVersion: 1 as const,
    };
    runtime.handler = (method) => {
      if (method === 'session.features.mutate') return features;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      currentSessionId: 'session-a',
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          snapshot: snapshot('session-a'),
          toolExecutions: {},
        },
      },
    });

    await store.getState().mutateFeatures('session-a', {
      objective: 'Finish the native migration',
      type: 'goal.start',
    });

    expect(runtime.calls.at(-1)).toEqual({
      method: 'session.features.mutate',
      params: {
        mutation: { objective: 'Finish the native migration', type: 'goal.start' },
        sessionId: 'session-a',
      },
    });
    expect(store.getState().records['session-a']?.snapshot?.features).toEqual(features);
  });

  test('forks at the owning message and activates the Pi-native child session', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.fork') {
        return { cancelled: false, snapshot: snapshot('session-fork') };
      }
      if (method === 'session.entries') return branch('session-fork');
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ currentSessionId: 'session-a' });

    const result = await store.getState().forkSession('session-a', 'assistant-entry', 'at');

    expect(result.cancelled).toBe(false);
    expect(runtime.calls[0]).toEqual({
      method: 'session.fork',
      params: { entryId: 'assistant-entry', position: 'at', sessionId: 'session-a' },
    });
    expect(store.getState().currentSessionId).toBe('session-fork');
    expect(store.getState().records['session-fork']?.branchEntries?.entries).toEqual([]);
  });

  test('ignores ephemeral catalog-worker session events', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();

    runtime.event('session.snapshot', snapshot('catalog-context'));
    runtime.event('recovery.status', {
      ...recoveryStatus,
      sessionId: 'catalog-context',
    });

    expect(store.getState().records['catalog-context']).toBeUndefined();
  });

  test('does not let an older open completion replace a newer selection', async () => {
    const runtime = new FakeRuntime();
    const first = deferred<SessionSnapshot>();
    const second = deferred<SessionSnapshot>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.open') return sessionId === 'session-a' ? first.promise : second.promise;
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const openA = store.getState().openSession({ sessionId: 'session-a' });
    const openB = store.getState().openSession({ sessionId: 'session-b' });

    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().openingSessionId).toBe('session-b');

    second.resolve(snapshot('session-b'));
    await openB;
    first.resolve(snapshot('session-a'));
    await openA;

    expect(store.getState().currentSessionId).toBe('session-b');
  });

  test('returns from session open without waiting for history hydration', async () => {
    const runtime = new FakeRuntime();
    const entries = deferred<SessionEntriesResult>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return entries.promise;
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const opened = await store.getState().openSession({ sessionId: 'session-a' });
    expect(opened.sessionId).toBe('session-a');
    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().openingSessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries).toBeUndefined();

    entries.resolve(branch('session-a'));
    await flushAsync();
    expect(store.getState().openingSessionId).toBeNull();
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
  });

  test('hydrates a read-only history preview while the session worker is still opening', async () => {
    const runtime = new FakeRuntime();
    const opened = deferred<SessionSnapshot>();
    const previewEntry: PiSessionEntry = {
      id: 'preview-user',
      message: { content: 'preview', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return opened.promise;
      if (method === 'session.entries.preview') return branch(sessionId, [previewEntry]);
      if (method === 'session.entries') return branch(sessionId, [previewEntry]);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const opening = store.getState().openSession({ cwd: 'D:/work', sessionId: 'session-a' });
    expect(store.getState().currentSessionId).toBe('session-a');
    await flushAsync();
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([previewEntry]);
    expect(store.getState().openingSessionId).toBe('session-a');

    opened.resolve(snapshot('session-a'));
    await opening;
    await flushAsync();
    expect(store.getState().openingSessionId).toBeNull();
  });

  test('replaces a restored preview viewport when the runtime reports a newer idle leaf', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? 'session-a';
      if (method === 'session.open') return { ...snapshot(sessionId), leafId: 'leaf-new' };
      if (method === 'session.entries') return branch(sessionId, [{
        id: 'leaf-new',
        message: { content: 'new', role: 'user', timestamp: 2 },
        parentId: 'leaf-old',
        timestamp: '2',
        type: 'message',
      }]);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      records: {
        'session-a': {
          branchEntries: branch('session-a', [{
            id: 'leaf-old',
            message: { content: 'old', role: 'user', timestamp: 1 },
            parentId: null,
            timestamp: '1',
            type: 'message',
          }]),
          branchEntriesSource: 'preview',
          extensionStates: {},
          open: false,
          sessionId: 'session-a',
          toolExecutions: {},
          view: {
            entry: { epoch: 1, generation: 1, target: { kind: 'end' } },
            generation: 1,
            observedLeafId: 'leaf-old',
            scrollMode: 'free-scrolling',
            viewport: { itemId: 'turn:leaf-old', mode: 'free-scrolling', offset: -8 },
          },
        },
      },
    });

    await store.getState().openSession({ sessionId: 'session-a' });

    expect(store.getState().records['session-a']?.view?.entry.target).toEqual({ kind: 'end' });
    expect(store.getState().records['session-a']?.view?.scrollMode).toBe('following-end');
  });

  test('deduplicates cold preview reads without selecting or opening the session', async () => {
    const runtime = new FakeRuntime();
    const entries = deferred<SessionEntriesResult>();
    const previewEntry: PiSessionEntry = {
      id: 'preview-user',
      message: { content: 'preview', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    runtime.handler = (method) => {
      if (method === 'session.entries.preview') return entries.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const first = store.getState().prefetchSession('session-a', 'D:/work');
    const second = store.getState().prefetchSession('session-a', 'D:/work');
    await flushAsync();

    expect(store.getState().currentSessionId).toBeNull();
    expect(store.getState().records['session-a']?.previewLoading).toBe(true);
    expect(runtime.calls.filter((call) => call.method === 'session.entries.preview')).toHaveLength(1);

    entries.resolve(branch('session-a', [previewEntry]));
    await Promise.all([first, second]);

    expect(store.getState().currentSessionId).toBeNull();
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([previewEntry]);
    expect(store.getState().records['session-a']?.branchEntriesSource).toBe('preview');
    expect(runtime.calls.some((call) => call.method === 'session.open')).toBe(false);
  });

  test('lets preview and live hydration race while preserving a completed live branch', async () => {
    const runtime = new FakeRuntime();
    const previewEntries = deferred<SessionEntriesResult>();
    const liveEntries = deferred<SessionEntriesResult>();
    const previewEntry: PiSessionEntry = {
      id: 'preview-user',
      message: { content: 'preview', role: 'user', timestamp: 1 },
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    const liveEntry: PiSessionEntry = {
      ...previewEntry,
      id: 'live-user',
      message: { content: 'live', role: 'user', timestamp: 2 },
    };
    runtime.handler = (method) => {
      if (method === 'session.entries.preview') return previewEntries.promise;
      if (method === 'session.entries') return liveEntries.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const preview = store.getState().prefetchSession('session-a', 'D:/work');
    await flushAsync();
    const live = store.getState().refreshEntries('session-a');
    previewEntries.resolve(branch('session-a', [previewEntry]));
    await preview;
    expect(store.getState().records['session-a']?.branchEntriesSource).toBe('preview');

    liveEntries.resolve(branch('session-a', [liveEntry]));
    await live;
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([liveEntry]);
    expect(store.getState().records['session-a']?.branchEntriesSource).toBe('live');

    const latePreview = deferred<SessionEntriesResult>();
    const newerLive = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries.preview') return latePreview.promise;
      if (method === 'session.entries') return newerLive.promise;
      throw new Error(`Unexpected ${method}`);
    };
    store.setState({ records: {} });
    const previewSecond = store.getState().prefetchSession('session-b', 'D:/work');
    await flushAsync();
    const liveSecond = store.getState().refreshEntries('session-b');
    newerLive.resolve(branch('session-b', [liveEntry]));
    await liveSecond;
    latePreview.reject(new Error('late preview failed'));
    await expect(previewSecond).rejects.toThrow('late preview failed');

    expect(store.getState().records['session-b']?.branchEntries?.entries).toEqual([liveEntry]);
    expect(store.getState().records['session-b']?.branchEntriesSource).toBe('live');
    expect(store.getState().records['session-b']?.previewError).toBeUndefined();
  });

  test('does not resurrect a deleted session when an older preview completes', async () => {
    const runtime = new FakeRuntime();
    const entries = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries.preview') return entries.promise;
      if (method === 'session.delete') return { deleted: true, sessionId: 'session-a' };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const preview = store.getState().prefetchSession('session-a', 'D:/work');
    await flushAsync();

    expect(await store.getState().deleteSession('session-a')).toBe(true);
    entries.resolve(branch('session-a'));
    await preview;

    expect(store.getState().records['session-a']).toBeUndefined();
  });

  test('rejects hydration started while a session deletion is in flight', async () => {
    const runtime = new FakeRuntime();
    const deletion = deferred<{ deleted: boolean; sessionId: string }>();
    runtime.handler = (method) => {
      if (method === 'session.delete') return deletion.promise;
      if (method === 'session.entries.preview') return branch('session-a');
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const deleting = store.getState().deleteSession('session-a');
    await expect(
      store.getState().prefetchSession('session-a', 'D:/work'),
    ).rejects.toThrow('deleted');
    expect(runtime.calls.filter((call) => call.method === 'session.entries.preview')).toHaveLength(0);

    deletion.resolve({ deleted: true, sessionId: 'session-a' });
    expect(await deleting).toBe(true);
    await expect(
      store.getState().prefetchSession('session-a', 'D:/work'),
    ).rejects.toThrow('deleted');
  });

  test('does not let an older catalog completion undo a successful deletion', async () => {
    const runtime = new FakeRuntime();
    const catalog = deferred<SessionSummary[]>();
    runtime.handler = (method) => {
      if (method === 'session.list') return catalog.promise;
      if (method === 'session.delete') return { deleted: true, sessionId: 'session-a' };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const loading = store.getState().loadCatalog();
    await flushAsync();

    expect(await store.getState().deleteSession('session-a')).toBe(true);
    catalog.resolve([summary('session-a', '2026-08-02T00:00:00.000Z')]);
    await loading;

    expect(store.getState().summaries).toEqual([]);
    await expect(
      store.getState().prefetchSession('session-a', 'D:/work'),
    ).rejects.toThrow('deleted');
  });

  test('drops a preview completion from a previous runtime generation', async () => {
    const runtime = new FakeRuntime();
    const entries = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries.preview') return entries.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const preview = store.getState().prefetchSession('session-a', 'D:/work');
    await Promise.resolve();

    runtime.switchTo('runtime-b');
    entries.resolve(branch('session-a'));

    await expect(preview).rejects.toThrow('runtime changed');
    expect(store.getState().records).toEqual({});
  });

  test('restores the previous selection when the latest open fails', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.open') throw new Error('open failed');
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({ currentSessionId: 'session-a' });

    const opening = store.getState().openSession({ sessionId: 'session-b' });
    expect(store.getState().currentSessionId).toBe('session-b');
    await expect(opening).rejects.toThrow('open failed');
    expect(store.getState().currentSessionId).toBe('session-a');
    expect(store.getState().openingSessionId).toBeNull();
  });

  test('does not let an older navigation completion reclaim the current session', async () => {
    const runtime = new FakeRuntime();
    const navigation = deferred<{ cancelled: false; snapshot: SessionSnapshot }>();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.navigate') return navigation.promise;
      if (method === 'session.open') return snapshot(sessionId);
      if (method === 'session.entries') return branch(sessionId);
      if (method === 'recovery.status') return recoveryStatus;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const navigateA = store.getState().navigateSession('session-a', 'entry-a');

    await store.getState().openSession({ sessionId: 'session-b' });
    navigation.resolve({ cancelled: false, snapshot: snapshot('session-a') });
    await navigateA;

    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().records['session-a']?.snapshot?.sessionId).toBe('session-a');
  });

  test('loads branch and all entries independently when requests overlap', async () => {
    const runtime = new FakeRuntime();
    const branchRequest = deferred<SessionEntriesResult>();
    const allRequest = deferred<SessionEntriesResult>();
    runtime.handler = (method, params) => {
      if (method !== 'session.entries') throw new Error(`Unexpected ${method}`);
      return (params as { scope?: string }).scope === 'all'
        ? allRequest.promise
        : branchRequest.promise;
    };
    const store = createPiSessionStore(runtime);
    const loadAll = store.getState().refreshEntries('session-a', 'all');
    const loadBranch = store.getState().refreshEntries('session-a', 'branch');

    branchRequest.resolve(branch('session-a'));
    await loadBranch;
    allRequest.resolve(allEntries('session-a'));
    await loadAll;

    expect(store.getState().records['session-a']?.branchEntries?.scope).toBe('branch');
    expect(store.getState().records['session-a']?.allEntries?.scope).toBe('all');
  });

  test('loads Pi session stats into the session record', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'session.stats') return stats(sessionId);
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    const result = await store.getState().refreshStats('session-a');

    expect(result.contextUsage).toEqual({ contextWindow: 200000, percent: 0.6, tokens: 1200 });
    expect(store.getState().records['session-a']?.stats).toEqual(result);
    expect(runtime.calls).toEqual([{
      method: 'session.stats',
      params: { sessionId: 'session-a' },
    }]);
  });

  test('preserves live output and appended entries across an overlapping branch refresh', async () => {
    const runtime = new FakeRuntime();
    const request = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries') return request.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    const refresh = store.getState().refreshEntries('session-a');
    await Promise.resolve();

    runtime.event('agent.event', {
      event: {
        message: assistant('streaming'),
        type: 'message_update',
        update: { contentIndex: 0, delta: 'streaming', type: 'text_delta' },
      } satisfies PiAgentEvent,
      sessionId: 'session-a',
    }, 'session-a');
    request.resolve(branch('session-a'));
    await refresh;

    expect(store.getState().records['session-a']?.liveAssistant?.content[0]).toEqual({
      text: 'streaming',
      type: 'text',
    });

    const nextRequest = deferred<SessionEntriesResult>();
    runtime.handler = (method) => {
      if (method === 'session.entries') return nextRequest.promise;
      throw new Error(`Unexpected ${method}`);
    };
    const nextRefresh = store.getState().refreshEntries('session-a');
    await Promise.resolve();
    const appended: PiSessionEntry = {
      id: 'entry-after-request',
      message: assistant('done'),
      parentId: null,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'message',
    };
    runtime.event('agent.event', {
      event: positionedAgentEvent({ entry: appended, type: 'entry_appended' }),
      sessionId: 'session-a',
    }, 'session-a');
    nextRequest.resolve(branch('session-a'));
    await nextRefresh;

    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([appended]);
  });

  test('applies native conversation recovery without stealing a newer selection', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method, params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? '';
      if (method === 'recovery.navigate') {
        return {
          action: 'navigate',
          editorText: 'restore this prompt',
          handledBy: 'pi-native',
          mode: 'conversation',
          outcome: 'applied',
          snapshot: snapshot(sessionId),
        };
      }
      if (method === 'session.entries') return branch(sessionId);
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.getState().setCurrentSession('session-b');

    const result = await store.getState().recoverTo('session-a', 'entry-a', 'conversation');

    expect(result.editorText).toBe('restore this prompt');
    expect(store.getState().currentSessionId).toBe('session-b');
    expect(store.getState().records['session-a']?.snapshot?.sessionId).toBe('session-a');
    expect(store.getState().records['session-a']?.branchEntries?.entries).toEqual([]);
  });

  test('resets catalog, current session, and event ownership on runtime change', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'session.list') return [summary('session-a', '2026-08-02T00:00:00.000Z')];
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    await store.getState().loadCatalog();
    store.getState().setCurrentSession('session-a');

    runtime.switchTo('runtime-b');

    expect(store.getState().runtimeKey).toBe('runtime-b');
    expect(store.getState().summaries).toEqual([]);
    expect(store.getState().currentSessionId).toBeNull();
  });

  test('does not dispatch a captured prompt after the runtime changes', async () => {
    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.prompt') return { accepted: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);

    runtime.switchTo('runtime-b');

    await expect(
      store.getState().prompt('session-a', 'stay on runtime A', undefined, undefined, 'runtime-a'),
    ).rejects.toThrow('runtime changed');
    expect(runtime.calls).toEqual([]);
  });

  test('automatically captures the current dirty surface without putting document text in runtime params', async () => {
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const captures: VarinAgentInputSnapshotCaptureRequest[] = [];
    const releases: Array<{ sessionId: string; context: unknown }> = [];
    const documents = {
      resolveResourceIdentity: async (resource: { workspaceId: string; resourceId: string }) => ({ coordinationId: `host-1\0${resource.workspaceId}\0${resource.resourceId}`, aliases: [resource] }),
      captureAgentInputSnapshot: async (request: VarinAgentInputSnapshotCaptureRequest) => {
        captures.push(request);
        return {
          source: 'surface' as const,
          roots: [...new Set(request.resources.map((resource) => resource.resource.workspaceId))].map((rootId) => ({
            workspaceId: rootId,
            dirtyPaths: request.resources
              .filter((resource) => resource.resource.workspaceId === rootId)
              .map((resource) => resource.resource.resourceId),
          })),
          snapshot: { status: 'ready' as const, ref: `opaque-snapshot-ref-${captures.length}` },
        };
      },
      clearDirtyBuffers: async () => ({ cleared: true }),
      delete: async (request: { resource: { workspaceId: string; resourceId: string } }) => ({ status: 'deleted' as const, resource: request.resource }),
      deleteRecoveryJournal: async () => ({ status: 'missing' as const, journalId: 'none' }),
      listRecoveryJournals: async () => [],
      move: async (request: { from: { workspaceId: string; resourceId: string } }) => ({ status: 'missing' as const, resource: request.from }),
      publishDirtyBuffers: async (request: Parameters<DocumentsAPI['publishDirtyBuffers']>[0]) => ({ ...request, updatedAt: '2026-09-06T00:00:00.000Z' }),
      read: async (resource: { workspaceId: string; resourceId: string }) => ({
        status: 'ready' as const,
        epoch: 1,
        resource,
        revision: 'disk-revision',
        content: 'disk body',
        encoding: 'utf-8',
        bom: false,
        byteLength: 9,
      }),
      readRecoveryJournal: async (journalId: string) => ({ status: 'missing' as const, journalId }),
      releaseAgentInputSnapshot: async (request: { sessionId: string; context: unknown }) => {
        releases.push(request);
        return { released: true };
      },
      resolveWorkspace: async () => ({ workspaceId, hostId: 'host', epoch: 1 }),
      watch: () => ({ close() {} }),
      write: async () => ({ status: 'written' as const, revision: 'next', byteLength: 0 }),
      writeRecoveryJournal: async () => ({ status: 'missing' as const, journalId: 'none' }),
    } as DocumentsAPI;
    bindDocumentRegistry(documents);
    const identity = { workspaceId, resourceId: 'draft.ts' };
    await getDocumentRegistry().open(identity);
    getDocumentRegistry().applyTransaction(identity, 'private dirty-only phrase', { origin: 'test' });

    const runtime = new FakeRuntime();
    runtime.handler = (method) => {
      if (method === 'agent.prompt') return { accepted: true };
      throw new Error(`Unexpected ${method}`);
    };
    const store = createPiSessionStore(runtime);
    store.setState({
      records: {
        'session-a': {
          extensionStates: {},
          open: true,
          sessionId: 'session-a',
          snapshot: { ...snapshot('session-a'), workspace: { kind: 'workspace', id: workspaceId, authorityId: workspaceId } },
          toolExecutions: {},
        },
      },
    });

    let inputCapturedBeforeDispatch = false;
    expect(await store.getState().prompt('session-a', 'inspect my draft', undefined, undefined, undefined, () => {
      expect(captures).toHaveLength(1);
      expect(runtime.calls).toHaveLength(0);
      inputCapturedBeforeDispatch = true;
    })).toBe(true);
    expect(inputCapturedBeforeDispatch).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.resources.map(({ content, localEditRevision }) => ({ content, localEditRevision }))).toEqual([
      { content: 'private dirty-only phrase', localEditRevision: 1 },
    ]);
    const runtimeParams = runtime.calls.find((call) => call.method === 'agent.prompt')?.params as Record<string, unknown>;
    expect(runtimeParams.inputContext).toEqual({
      source: 'surface',
      roots: [{ workspaceId, dirtyPaths: ['draft.ts'] }],
      snapshot: { status: 'ready', ref: 'opaque-snapshot-ref-1' },
    });
    expect(JSON.stringify(runtimeParams)).not.toContain('private dirty-only phrase');

    getDocumentRegistry().applyTransaction(identity, 'second private draft body', { origin: 'test' });
    runtime.handler = () => { throw new Error('prompt dispatch failed'); };
    let failed = false;
    try {
      await store.getState().prompt('session-a', 'this send fails');
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toEqual({
      sessionId: 'session-a',
      context: {
        source: 'surface',
        roots: [{ workspaceId, dirtyPaths: ['draft.ts'] }],
        snapshot: { status: 'ready', ref: 'opaque-snapshot-ref-2' },
      },
    });
  });
});
