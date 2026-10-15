import { RuntimeEventSource } from '@varin/application-client';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { parseComputerAutomationInvalidation, parseComputerAutomationState, parseComputerActivity } from '@varin/protocol';
import type { ComputerActivityEntry, ComputerAutomationInvalidation, ComputerAutomationState } from '@varin/protocol';
import { bindClientSurfaceThread, selectedClientThread, clientSurfaceQuery, handleClientSettingsRequest } from '@/lib/client-settings-bridge';
import { useThreadStore } from '@/stores/useThreadStore';

type StreamReadyEvent = {
  type: 'stream-ready';
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
  owner: 'app' | 'agent-settings' | 'client';
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

export type VarinEvent = StreamReadyEvent | ScheduledTaskRanEvent | HarnessKnowledgeChangedEvent | HarnessExperimentChangedEvent | SettingsChangedEvent
  | { type: 'plan-changed'; threadId: string; branchId: string; ref: string }
  | { type: 'agent-personalization-changed' }
  | { type: 'scheduled-task-changed' }
  | { type: 'ssh-instance-status'; status: unknown }
  | { type: 'bot-changed'; botId: string }
  | ({ type: 'computer-activity' } & ComputerActivityEntry)
  | ({ type: 'computer-automation-invalidated' } & ComputerAutomationInvalidation)
  | { type: 'computer-automation'; state: ComputerAutomationState };
type Listener = (event: VarinEvent) => void;

let eventSource: RuntimeEventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
let threadChangeUnsubscribe: (() => void) | null = null;
let threadBindingPromise: Promise<void> | null = null;
let threadBindingTarget: string | null = null;
let boundThreadKey: string | null = null;
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
    boundThreadKey = null;
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

  if (envelope.type === 'varin:plan-changed') {
    const properties = getEventProperties(envelope.properties);
    if (typeof properties?.threadId === 'string' && properties.threadId
      && typeof properties.branchId === 'string' && properties.branchId
      && typeof properties.ref === 'string' && properties.ref) {
      for (const listener of listeners) listener({ type: 'plan-changed', threadId: properties.threadId, branchId: properties.branchId, ref: properties.ref });
    }
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



  if (envelope.type === 'varin:computer-automation-invalidated') {
    try {
      const invalidation = parseComputerAutomationInvalidation(envelope.properties);
      for (const listener of listeners) listener({ type: 'computer-automation-invalidated', ...invalidation });
    } catch { /* Ignore malformed owner identities. */ }
    return;
  }
  if (envelope.type === 'varin:computer-automation') {
    try {
      const state = parseComputerAutomationState(envelope.properties);
      for (const listener of listeners) listener({ type: 'computer-automation', state });
    } catch { /* Ignore malformed owner projections. */ }
    return;
  }
  if (envelope.type === 'varin:computer-activity') {
    const properties = getEventProperties(envelope.properties);
    if (typeof properties?.desktopId === 'string' && properties.desktopId) {
      try {
        const activity = parseComputerActivity(properties.activity);
        for (const listener of listeners) listener({ type: 'computer-activity', desktopId: properties.desktopId, activity });
      } catch { /* Ignore malformed activity projections. */ }
    }
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
    if ((owner === 'app' || owner === 'agent-settings' || owner === 'client')
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

  if (envelope.type === 'varin:scheduled-task-changed') { for (const listener of listeners) listener({ type: 'scheduled-task-changed' }); return; }

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

  const identity = selectedClientThread();
  const identityKey = identity ? JSON.stringify([identity.threadId, identity.branchId]) : null;
  if (identity && boundThreadKey !== identityKey) {
    if (!threadBindingPromise) {
      const bindingTarget = identityKey;
      const bindingGeneration = surfaceBindingGeneration;
      threadBindingTarget = bindingTarget;
      let bound = false;
      threadBindingPromise = bindClientSurfaceThread(identity)
        .then(() => {
          bound = surfaceBindingGeneration === bindingGeneration
            && JSON.stringify([selectedClientThread()?.threadId, selectedClientThread()?.branchId]) === bindingTarget;
          if (bound) boundThreadKey = bindingTarget;
        })
        .catch(() => undefined)
        .finally(() => {
          threadBindingPromise = null;
          if (threadBindingTarget === bindingTarget) threadBindingTarget = null;
          if (listeners.size === 0) return;
          if (bound) { cleanupSource(); connect(); }
          else scheduleReconnect();
        });
    }
  }

  if (eventSource && eventSource.readyState !== RuntimeEventSource.CLOSED) return;

  cleanupSource();

  // The surface query makes this connection individually addressable for
  // client-owned settings requests (Stage S).
  // Shared settings and activity do not depend on a conversation's client-control permit.
  // Until binding succeeds, subscribe to broadcasts without claiming a Thread identity.
  const boundIdentity = boundThreadKey === identityKey ? identity : null;
  const source = new RuntimeEventSource('/api/varin/events', { query: clientSurfaceQuery(boundIdentity), reconnect: false });
  source.onopen = () => {
    if (eventSource !== source) return;
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    if (eventSource !== source) return;
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    if (eventSource !== source) return;
    cleanupSource();
    boundThreadKey = null;
    surfaceBindingGeneration += 1;
    scheduleReconnect();
  };

  eventSource = source;
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || typeof window === 'undefined') return;
  runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
    cleanupSource();
    boundThreadKey = null;
    surfaceBindingGeneration += 1;
    reconnectAttempt = 0;
    connect();
  });
};

const ensureThreadChangeSubscription = () => {
  if (threadChangeUnsubscribe || typeof window === 'undefined') return;
  threadChangeUnsubscribe = useThreadStore.subscribe((state, previous) => {
    if ((state.selectedIdentity === previous.selectedIdentity && state.hostKey === previous.hostKey) || listeners.size === 0) return;
    cleanupSource();
    boundThreadKey = null;
    surfaceBindingGeneration += 1;
    reconnectAttempt = 0;
    connect();
  });
};

const cleanupRuntimeChangeSubscription = () => {
  runtimeChangeUnsubscribe?.();
  runtimeChangeUnsubscribe = null;
};

const cleanupThreadChangeSubscription = () => {
  threadChangeUnsubscribe?.();
  threadChangeUnsubscribe = null;
};

export const subscribeVarinEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  ensureThreadChangeSubscription();
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
      boundThreadKey = null;
      surfaceBindingGeneration += 1;
      cleanupRuntimeChangeSubscription();
      cleanupThreadChangeSubscription();
    }
  };
};
