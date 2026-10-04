import { getRuntimeUrlResolver } from '@varin/application-client';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { Thread, ThreadParent, ThreadRun } from '@varin/protocol';
import { bindClientSurfaceSession, clientSurfaceQuery, handleClientSettingsRequest } from '@/lib/client-settings-bridge';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

type StreamReadyEvent = {
  type: 'stream-ready';
};

export type HarnessThreadChangedEvent = {
  type: 'harness-thread-changed';
  workspaceId: string;
  parent: ThreadParent;
  thread: Thread;
  activeRun: ThreadRun | null;
};

export type HarnessBlocksChangedEvent = {
  type: 'harness-blocks-changed';
  workspaceId: string;
  sessionId: string;
};

export type HarnessKnowledgeChangedEvent = {
  type: 'harness-knowledge-changed';
  sessionId?: string;
  /** Owner address — workspace id for `workspace`, bot id for `bot`. */
  workspaceId?: string;
  scope: 'workspace' | 'user' | 'session' | 'bot';
};

export type HarnessExperimentChangedEvent = {
  type: 'harness-experiment-changed';
  workspaceId: string;
  fact: 'attempt' | 'machine' | 'source' | 'followup';
};

/** Agent-origin settings write landed on a shared authority (D-306 / D-309). */
export type SettingsChangedEvent = {
  type: 'settings-changed';
  owner: 'app' | 'pi-settings' | 'client';
  ids: string[];
  scope: 'host' | 'global' | 'project' | 'client';
  revision: string;
};

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

type SessionCreatedEvent = {
  type: 'session-created';
  sessionId: string;
  directory: string;
  projectId?: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
};

export type VarinEvent = StreamReadyEvent | ScheduledTaskRanEvent | SessionCreatedEvent | HarnessThreadChangedEvent | HarnessBlocksChangedEvent | HarnessKnowledgeChangedEvent | HarnessExperimentChangedEvent | SettingsChangedEvent
  | { type: 'agent-personalization-changed' }
  | { type: 'ssh-instance-status'; status: unknown }
  | { type: 'bot-changed'; botId: string };
type Listener = (event: VarinEvent) => void;

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
let sessionChangeUnsubscribe: (() => void) | null = null;
let sessionBindingPromise: Promise<void> | null = null;
let sessionBindingTarget: string | null = null;
let boundSessionId: string | null = null;
let surfaceBindingGeneration = 0;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupSource = () => {
  clearHeartbeatTimer();
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) {
    return;
  }
  heartbeatTimer = setTimeout(() => {
    cleanupSource();
    boundSessionId = null;
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const parseEnvelope = (raw: string): { type: string; properties: unknown } | null => {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const type = typeof parsed?.type === 'string' ? parsed.type : '';
    const properties = parsed?.properties;
    if (!type) {
      return null;
    }
    return { type, properties };
  } catch {
    return null;
  }
};

const getEventProperties = (properties: unknown): Record<string, unknown> | null => {
  if (!properties || typeof properties !== 'object') {
    return null;
  }
  return properties as Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseHarnessThreadChanged = (properties: unknown): HarnessThreadChangedEvent | null => {
  const record = getEventProperties(properties);
  const parent = record?.parent;
  const thread = record?.thread;
  const activeRun = record?.activeRun;
  if (
    typeof record?.workspaceId !== 'string'
    || !isRecord(parent)
    || (parent.kind !== 'session' && parent.kind !== 'thread')
    || typeof parent.id !== 'string'
    || !isRecord(thread)
    || typeof thread.id !== 'string'
    || typeof thread.workspaceId !== 'string'
    || typeof thread.eventSeq !== 'number'
    || (activeRun !== null && !isRecord(activeRun))
  ) return null;
  return {
    type: 'harness-thread-changed',
    workspaceId: record.workspaceId,
    parent: parent as ThreadParent,
    thread: thread as unknown as Thread,
    activeRun: activeRun as ThreadRun | null,
  };
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  if (envelope.type === 'varin:ssh-instance-status') {
    for (const listener of listeners) listener({ type: 'ssh-instance-status', status: envelope.properties });
    return;
  }
  if (envelope.type === 'varin:event-stream-ready') {
    reconnectAttempt = 0;
    for (const listener of listeners) listener({ type: 'stream-ready' });
    return;
  }

  if (envelope.type === 'varin:heartbeat') {
    return;
  }

  if (envelope.type === 'varin:client-settings-request') {
    const properties = getEventProperties(envelope.properties);
    if (properties) void handleClientSettingsRequest(properties);
    return;
  }

  if (envelope.type === 'varin:session-created') {
    const properties = getEventProperties(envelope.properties);
    const sessionId = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    const directory = typeof properties?.directory === 'string' ? properties.directory : '';
    if (!sessionId || !directory) {
      return;
    }

    const nextEvent: SessionCreatedEvent = {
      type: 'session-created',
      sessionId,
      directory,
      createdAt: typeof properties?.createdAt === 'number' ? properties.createdAt : Date.now(),
      promptDispatched: properties?.promptDispatched === true,
      dispatchedAsCommand: properties?.dispatchedAsCommand === true,
      ...(typeof properties?.projectId === 'string' && properties.projectId.length > 0
        ? { projectId: properties.projectId }
        : {}),
    };
    for (const listener of listeners) {
      listener(nextEvent);
    }
    return;
  }

  if (envelope.type === 'varin:harness-thread-changed') {
    const nextEvent = parseHarnessThreadChanged(envelope.properties);
    if (nextEvent) for (const listener of listeners) listener(nextEvent);
    return;
  }

  if (envelope.type === 'varin:bot-changed') {
    const properties = getEventProperties(envelope.properties);
    if (typeof properties?.botId === 'string') for (const listener of listeners) listener({ type: 'bot-changed', botId: properties.botId });
    return;
  }

  if (envelope.type === 'varin:agent-personalization-changed') {
    for (const listener of listeners) listener({ type: 'agent-personalization-changed' });
    return;
  }

  if (envelope.type === 'varin:session-deleted') {
    const properties = getEventProperties(envelope.properties);
    if (typeof properties?.sessionId === 'string' && properties.sessionId) {
      usePiSessionStore.getState().forgetDeletedSessions([properties.sessionId]);
    }
    return;
  }

  if (envelope.type === 'varin:harness-blocks-changed') {
    const properties = getEventProperties(envelope.properties);
    const workspaceId = typeof properties?.workspaceId === 'string' ? properties.workspaceId : '';
    const sessionId = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    if (workspaceId && sessionId) {
      for (const listener of listeners) listener({ type: 'harness-blocks-changed', workspaceId, sessionId });
    }
    return;
  }

  if (envelope.type === 'varin:harness-experiment-changed') {
    const properties = getEventProperties(envelope.properties);
    const workspaceId = typeof properties?.workspaceId === 'string' ? properties.workspaceId : '';
    const fact = properties?.fact;
    if (workspaceId && (fact === 'attempt' || fact === 'machine' || fact === 'source' || fact === 'followup')) {
      for (const listener of listeners) listener({ type: 'harness-experiment-changed', workspaceId, fact });
    }
    return;
  }

  if (envelope.type === 'varin:settings-changed') {
    const properties = getEventProperties(envelope.properties);
    const owner = properties?.owner;
    const scope = properties?.scope;
    const revision = typeof properties?.revision === 'string' ? properties.revision : '';
    const ids = Array.isArray(properties?.ids)
      ? properties.ids.filter((id): id is string => typeof id === 'string')
      : [];
    if ((owner === 'app' || owner === 'pi-settings' || owner === 'client')
      && (scope === 'host' || scope === 'global' || scope === 'project' || scope === 'client')
      && revision) {
      for (const listener of listeners) listener({
        type: 'settings-changed', owner, ids, scope, revision,
      });
    }
    return;
  }

  if (envelope.type === 'varin:harness-knowledge-changed') {
    const properties = getEventProperties(envelope.properties);
    const sessionId = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    const workspaceId = typeof properties?.workspaceId === 'string' ? properties.workspaceId : '';
    const scope = properties?.scope;
    if (scope === 'workspace' || scope === 'user' || scope === 'session' || scope === 'bot') {
      for (const listener of listeners) listener({
        type: 'harness-knowledge-changed',
        scope,
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
    }
    return;
  }

  if (envelope.type !== 'varin:scheduled-task-ran') {
    return;
  }

  const properties = getEventProperties(envelope.properties);
  const projectId = typeof properties?.projectId === 'string' ? properties.projectId : '';
  const taskId = typeof properties?.taskId === 'string' ? properties.taskId : '';
  const ranAt = typeof properties?.ranAt === 'number' ? properties.ranAt : Date.now();
  const rawStatus = properties?.status;
  const status = rawStatus === 'running' || rawStatus === 'error' ? rawStatus : 'success';
  if (!projectId || !taskId) {
    return;
  }

  const nextEvent: ScheduledTaskRanEvent = {
    type: 'scheduled-task-ran',
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof properties?.sessionId === 'string' && properties.sessionId.length > 0
      ? { sessionId: properties.sessionId }
      : {}),
  };
  for (const listener of listeners) {
    listener(nextEvent);
  }
};

const connect = () => {
  if (typeof window === 'undefined' || listeners.size === 0) {
    return;
  }
  if (typeof EventSource !== 'function') {
    return;
  }

  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return;
  }

  const currentSessionId = usePiSessionStore.getState().currentSessionId;
  if (currentSessionId && boundSessionId !== currentSessionId) {
    if (!sessionBindingPromise) {
      const bindingTarget = currentSessionId;
      const bindingGeneration = surfaceBindingGeneration;
      sessionBindingTarget = bindingTarget;
      let bound = false;
      sessionBindingPromise = bindClientSurfaceSession(bindingTarget)
        .then(() => {
          bound = surfaceBindingGeneration === bindingGeneration
            && usePiSessionStore.getState().currentSessionId === bindingTarget;
          if (bound) boundSessionId = bindingTarget;
        })
        .catch(() => undefined)
        .finally(() => {
          sessionBindingPromise = null;
          if (sessionBindingTarget === bindingTarget) sessionBindingTarget = null;
          if (listeners.size === 0) return;
          if (bound) connect();
          else scheduleReconnect();
        });
    }
    return;
  }

  cleanupSource();

  // The surface query makes this connection individually addressable for
  // client-owned settings requests (Stage S).
  const source = new EventSource(getRuntimeUrlResolver().sse('/api/varin/events', clientSurfaceQuery()));
  source.onopen = () => {
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    cleanupSource();
    boundSessionId = null;
    surfaceBindingGeneration += 1;
    scheduleReconnect();
  };

  eventSource = source;
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || typeof window === 'undefined') return;
  runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
    cleanupSource();
    boundSessionId = null;
    surfaceBindingGeneration += 1;
    reconnectAttempt = 0;
    connect();
  });
};

const ensureSessionChangeSubscription = () => {
  if (sessionChangeUnsubscribe || typeof window === 'undefined') return;
  sessionChangeUnsubscribe = usePiSessionStore.subscribe((state, previous) => {
    if (state.currentSessionId === previous.currentSessionId || listeners.size === 0) return;
    cleanupSource();
    boundSessionId = null;
    surfaceBindingGeneration += 1;
    reconnectAttempt = 0;
    connect();
  });
};

const cleanupRuntimeChangeSubscription = () => {
  runtimeChangeUnsubscribe?.();
  runtimeChangeUnsubscribe = null;
};

const cleanupSessionChangeSubscription = () => {
  sessionChangeUnsubscribe?.();
  sessionChangeUnsubscribe = null;
};

export const subscribeVarinEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  ensureSessionChangeSubscription();
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupSource();
      boundSessionId = null;
      surfaceBindingGeneration += 1;
      cleanupRuntimeChangeSubscription();
      cleanupSessionChangeSubscription();
    }
  };
};
