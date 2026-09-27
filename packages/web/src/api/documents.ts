import type {
  DocumentsAPI,
  VarinDirtyBufferPublication,
  VarinDocumentDeleteRequest,
  VarinDocumentDeleteResult,
  VarinDocumentWatchEvent,
  VarinDocumentMoveRequest,
  VarinDocumentMoveResult,
  VarinDocumentReadResult,
  VarinDocumentRecoveryJournalSummary,
  VarinDocumentRecoveryReadResult,
  VarinDocumentRecoveryWriteRequest,
  VarinDocumentRecoveryWriteResult,
  VarinDocumentWriteRequest,
  VarinDocumentWriteResult,
  VarinResourceReference,
  VarinWorkspaceFileEvent,
  VarinWorkspaceIdentity,
  Subscription,
} from '@varin/application-client';
import type { AgentInputContext } from '@varin/protocol';
import { DocumentsError, parseDocumentsFailureReason } from '@varin/application-client';
import { createDocumentWatchEventTracker } from '@varin/ui/lib/documents/watch-events';
import { runtimeFetch } from '@varin/application-client';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@varin/application-client';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new DocumentsError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const postJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new DocumentsError(error.error || 'Document request failed', {
      reason: parseDocumentsFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

const isResource = (value: unknown): value is VarinResourceReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.workspaceId === 'string' && typeof candidate.resourceId === 'string';
};

const parseWorkspaceFileEvent = (value: unknown): VarinWorkspaceFileEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentsError('Document watch returned an invalid event', { reason: 'failed' });
  }
  const event = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(event.sequence)
    || Number(event.sequence) < 1
    || !Number.isSafeInteger(event.generation)
    || Number(event.generation) < 1
    || typeof event.sourceId !== 'string'
    || !event.sourceId
    || typeof event.kind !== 'string'
    || Object.hasOwn(event, 'content')
  ) {
    throw new DocumentsError('Document watch returned an invalid event', { reason: 'failed' });
  }
  if (event.kind === 'reset') {
    if (!['overflow', 'reconnected', 'authority-changed', 'gap'].includes(String(event.reason))) {
      throw new DocumentsError('Document watch returned an invalid reset event', { reason: 'failed' });
    }
    return event as VarinWorkspaceFileEvent;
  }
  if (!isResource(event.resource)) {
    throw new DocumentsError('Document watch returned an invalid resource event', { reason: 'failed' });
  }
  if (event.revision !== undefined && typeof event.revision !== 'string') {
    throw new DocumentsError('Document watch returned an invalid revision', { reason: 'failed' });
  }
  if (event.kind === 'moved') {
    if (!isResource(event.from)) {
      throw new DocumentsError('Document watch returned an invalid move event', { reason: 'failed' });
    }
    return event as VarinWorkspaceFileEvent;
  }
  if (!['created', 'changed', 'deleted'].includes(event.kind)) {
    throw new DocumentsError('Document watch returned an unknown event', { reason: 'failed' });
  }
  return event as VarinWorkspaceFileEvent;
};

export const parseDocumentWatchEvent = (value: unknown): VarinDocumentWatchEvent => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const event = value as Record<string, unknown>;
    if (event.kind === 'surface-operation') {
      if (!['capture', 'apply', 'undo'].includes(String(event.action))
        || typeof event.requestId !== 'string' || !event.requestId
        || typeof event.operationId !== 'string' || !event.operationId
        || typeof event.workspaceId !== 'string' || !event.workspaceId
        || Object.hasOwn(event, 'content') || Object.hasOwn(event, 'targets')) {
        throw new DocumentsError('Document watch returned an invalid surface operation', { reason: 'failed' });
      }
      return event as VarinDocumentWatchEvent;
    }
    if (event.kind === 'dirty-state-barrier') {
      if (!['acquire', 'release'].includes(String(event.action))
        || typeof event.barrierId !== 'string' || !event.barrierId
        || typeof event.caseSensitive !== 'boolean'
        || typeof event.workspaceId !== 'string' || !event.workspaceId
        || !Array.isArray(event.paths) || event.paths.some((entry) => typeof entry !== 'string' || !entry)) {
        throw new DocumentsError('Document watch returned an invalid dirty-state barrier', { reason: 'failed' });
      }
      return event as VarinDocumentWatchEvent;
    }
  }
  return parseWorkspaceFileEvent(value);
};

const waitForReconnect = (signal: AbortSignal, delayMs: number): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, delayMs);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

const readSseEvents = async (
  response: Response,
  listener: (event: VarinDocumentWatchEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new DocumentsError('Document watch stream is unavailable', { reason: 'failed' });
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = parseDocumentWatchEvent(JSON.parse(line.slice(6)));
      listener(event);
    }
  }
};

/**
 * Hosted Web, Electron, and mobile clients talk to the remote/in-process Web
 * Application Host. This module never uses a Capacitor filesystem plugin.
 */
export const createWebDocumentsAPI = (): DocumentsAPI => ({
  ackDirtyStateBarrier: (request) => postJson('/api/documents/dirty/barrier/ack', request) as Promise<{ acknowledged: boolean }>,
  clearDirtyBuffers: (request) => postJson('/api/documents/dirty/clear', request) as Promise<{ cleared: boolean }>,
  captureAgentInputSnapshot: (request) => postJson('/api/documents/agent-input/capture', request) as Promise<AgentInputContext>,
  releaseAgentInputSnapshot: (request) => postJson('/api/documents/agent-input/release', request) as Promise<{ released: boolean }>,
  readSurfaceOperation: (request) => postJson('/api/documents/surface-operation/read', request) as ReturnType<NonNullable<DocumentsAPI['readSurfaceOperation']>>,
  completeSurfaceOperation: (request) => postJson('/api/documents/surface-operation/complete', request) as ReturnType<NonNullable<DocumentsAPI['completeSurfaceOperation']>>,
  resolveWorkspace: (input) => postJson('/api/documents/workspace/resolve', input) as Promise<VarinWorkspaceIdentity>,
  resolveResourceIdentity: (resource) => postJson('/api/documents/resource/identity', { resource }) as ReturnType<DocumentsAPI['resolveResourceIdentity']>,
  read: (resource: VarinResourceReference) => postJson('/api/documents/read', { resource }) as Promise<VarinDocumentReadResult>,
  write: (request: VarinDocumentWriteRequest) => postJson('/api/documents/write', request) as Promise<VarinDocumentWriteResult>,
  move: (request: VarinDocumentMoveRequest) => postJson('/api/documents/move', request) as Promise<VarinDocumentMoveResult>,
  publishDirtyBuffers: (request) => postJson('/api/documents/dirty/publish', request) as Promise<VarinDirtyBufferPublication>,
  delete: (request: VarinDocumentDeleteRequest) => postJson('/api/documents/delete', request) as Promise<VarinDocumentDeleteResult>,
  watch(workspaceId: string, listener: (event: VarinDocumentWatchEvent) => void, options): Subscription {
    const tracker = createDocumentWatchEventTracker(listener);
    const generation = getRuntimeEndpointGeneration();
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      tracker.transportReset('authority-changed');
      controller.abort();
    });
    void (async () => {
      let reconnectDelayMs = 250;
      let reconnecting = false;
      while (!controller.signal.aborted) {
        try {
          assertGeneration(generation);
          const response = await runtimeFetch('/api/documents/watch', {
            headers: { Accept: 'text/event-stream' },
            query: {
              workspaceId,
              ...(options?.dirtyOwner ? {
                dirtyOwnerId: options.dirtyOwner.ownerId,
                dirtyOwnerGeneration: String(options.dirtyOwner.generation),
              } : {}),
            },
            signal: controller.signal,
          });
          assertGeneration(generation);
          if (!response.ok) {
            throw new DocumentsError('Document watch failed', {
              reason: 'failed',
              status: response.status,
            });
          }
          if (reconnecting) {
            tracker.transportReset('reconnected');
            reconnecting = false;
          }
          reconnectDelayMs = 250;
          await readSseEvents(response, (event) => {
            if (event.kind === 'dirty-state-barrier' || event.kind === 'surface-operation') listener(event);
            else tracker.accept(event);
          }, controller.signal);
          if (!controller.signal.aborted) throw new DocumentsError('Document watch ended', { reason: 'failed' });
        } catch (error) {
          if (controller.signal.aborted) break;
          if (getRuntimeEndpointGeneration() !== generation) {
            tracker.transportReset('authority-changed');
            break;
          }
          const status = error instanceof DocumentsError ? error.status : undefined;
          if (typeof status === 'number' && status < 500) {
            tracker.transportReset('authority-changed');
            break;
          }
          reconnecting = true;
          await waitForReconnect(controller.signal, reconnectDelayMs);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
        }
      }
      unsubscribe();
    })();
    return {
      close() {
        unsubscribe();
        controller.abort();
      },
    };
  },
  listRecoveryJournals: async (request) => {
    const payload = await postJson('/api/documents/recovery/list', request) as { journals?: VarinDocumentRecoveryJournalSummary[] };
    if (!Array.isArray(payload.journals)) {
      throw new DocumentsError('Document recovery list returned an invalid response', { reason: 'failed' });
    }
    return payload.journals;
  },
  readRecoveryJournal: (journalId) => postJson('/api/documents/recovery/read', { journalId }) as Promise<VarinDocumentRecoveryReadResult>,
  writeRecoveryJournal: (request: VarinDocumentRecoveryWriteRequest) => (
    postJson('/api/documents/recovery/write', request) as Promise<VarinDocumentRecoveryWriteResult>
  ),
  deleteRecoveryJournal: (request) => postJson('/api/documents/recovery/delete', request) as Promise<Awaited<ReturnType<DocumentsAPI['deleteRecoveryJournal']>>>,
});
