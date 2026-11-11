import { parseConversationOrganizationEntry, parseConversationOrganizationQuery, parseConversationOrganizationSnapshot, ConversationOrganizationError, type ConversationOrganizationAPI, type ConversationOrganizationFailureCode } from './conversation-organization.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';
import { createThreadsHttpAPI } from './threads-http.js';

/** Every request is fenced through body decoding, including writes with an uncertain outcome. */
export function createConversationOrganizationHttpAPI(): ConversationOrganizationAPI {
  const post = async <T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const generation = getRuntimeEndpointGeneration(), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    const hostChanged = () => controller.abort(new Error('Application Host changed'));
    const changed = subscribeRuntimeEndpointWillChange(hostChanged);
    const published = subscribeRuntimeEndpointChanged(hostChanged);
    signal?.addEventListener('abort', abort, { once: true });
    const fence = () => { controller.signal.throwIfAborted(); if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed'); };
    try {
      const response = await runtimeFetch(`/api/conversation-organization/${method}`, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      fence();
      const result = await response.json() as Record<string, unknown>; fence();
      if (!response.ok) throw new ConversationOrganizationError((typeof result.code === 'string' ? result.code : 'unavailable') as ConversationOrganizationFailureCode,
        typeof result.error === 'string' ? result.error : 'Conversation organization request failed', response.status, result.details);
      if (!result || typeof result !== 'object') throw new ConversationOrganizationError('invalid_response', 'Invalid organization response', 502);
      return result as T;
    } finally { controller.abort(); changed(); published(); signal?.removeEventListener('abort', abort); }
  };
  return {
    entry: async (conversation, signal) => {
      const result = parseConversationOrganizationEntry(await post('entry', { conversation }, signal));
      if (result.conversation.kind !== conversation.kind || result.conversation.id !== conversation.id)
        throw new ConversationOrganizationError('invalid_response', 'Conversation metadata belongs to another object', 502);
      return result;
    },
    read: async (query = {}, signal) => {
      const request = parseConversationOrganizationQuery(query);
      const snapshot = parseConversationOrganizationSnapshot(await post('read', request, signal));
      if (request.pageNodes && snapshot.items === undefined) throw new ConversationOrganizationError('invalid_response', 'Mixed conversation directory response is missing page items', 502);
      return snapshot;
    },
    command: (input, signal) => post('command', input, signal),
    project: (input, signal) => post('project', input, signal),
    metadata: (input, signal) => post('metadata', input, signal),
    // Reuse the existing authenticated, multiplexed durable observation channel.
    observe: (cursor, listener, options) => createThreadsHttpAPI().observe(cursor, event => {
      if ('cursor' in event && typeof event.cursor === 'number') listener(event as import('./conversation-organization.js').ConversationOrganizationEvent);
    }, options),
  };
}
