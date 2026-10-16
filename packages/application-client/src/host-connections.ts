import type { DesktopHost, DesktopHostsConfig, DesktopHostsConfigInput, DesktopSshImportCandidate, DesktopSshInstancesConfig, DesktopSshInstanceStatus } from './desktop.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export interface HostConnectionProbe { status: 'ok' | 'auth' | 'wrong-service' | 'unreachable'; latencyMs: number }
/** Connections owned by the selected Agent Host, including in the Electron renderer.
 * Never routes to native IPC: localhost, SSH config, secrets and probes belong to that Host.
 */
export function createHostConnectionsHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const assertOwner = () => { if (generation !== getRuntimeEndpointGeneration()) throw new Error('Connection owner changed. Reopen this Host’s connections.'); };
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    assertOwner();
    const response = await runtimeFetch(`/api/connections${path}`, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    assertOwner();
    const result: unknown = await response.json();
    assertOwner();
    if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result ? String(result.error) : `Connection request failed (${response.status})`);
    return result as T;
  };
  return {
    assertOwner,
    hosts: {
      get: () => request<DesktopHostsConfig>('/hosts'),
      set: async (config: DesktopHostsConfigInput) => { await request('/hosts', 'PUT', config); },
      probe: (host: DesktopHost) => request<HostConnectionProbe>('/hosts/probe', 'POST', { url: host.apiUrl || host.url, clientToken: host.clientToken, requestHeaders: host.requestHeaders, expectedServerId: host.relay?.serverId }),
    },
    ssh: {
      get: () => request<DesktopSshInstancesConfig>('/ssh'),
      set: async (config: DesktopSshInstancesConfig) => { await request('/ssh', 'PUT', config); },
      imports: () => request<DesktopSshImportCandidate[]>('/ssh/import'),
      status: () => request<DesktopSshInstanceStatus[]>('/ssh/status'),
      connect: async (id: string) => { await request(`/ssh/${encodeURIComponent(id)}/connect`, 'POST'); },
      disconnect: async (id: string) => { await request(`/ssh/${encodeURIComponent(id)}/disconnect`, 'POST'); },
      logs: (id: string, limit = 600) => request<string[]>(`/ssh/${encodeURIComponent(id)}/logs?limit=${limit}`),
      clearLogs: async (id: string) => { await request(`/ssh/${encodeURIComponent(id)}/logs`, 'DELETE'); },
    },
  };
}
