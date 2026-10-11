import { AgentProfilesError, type AgentProfilesAPI } from './agent-profiles.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export function createAgentProfilesHttpAPI(): AgentProfilesAPI {
  const post = async <T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const generation = getRuntimeEndpointGeneration();
    const assertCurrent = () => {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (generation !== getRuntimeEndpointGeneration()) {
        throw new AgentProfilesError(409, 'host-changed', 'Application Host changed. Reload agent settings.');
      }
    };
    assertCurrent();
    const response = await runtimeFetch(`/api/agent-profiles/${method}`, {
      method: 'POST', ...(signal ? { signal } : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    assertCurrent();
    const result: unknown = response.ok ? await response.json() : await response.json().catch(() => ({}));
    assertCurrent();
    if (!response.ok) {
      const failure = result && typeof result === 'object' ? result as { code?: unknown; message?: unknown } : {};
      throw new AgentProfilesError(response.status,
        typeof failure.code === 'string' ? failure.code : 'agent-profiles-request-failed',
        typeof failure.message === 'string' ? failure.message : `Agent settings request failed (${response.status}).`);
    }
    return result as T;
  };
  return {
    read: (input, signal) => post('read', input, signal),
    save: (input, signal) => post('save', input, signal),
    remove: (input, signal) => post('remove', input, signal),
  };
}
