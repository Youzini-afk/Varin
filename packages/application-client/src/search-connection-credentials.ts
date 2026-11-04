import { runtimeFetch } from './transport/runtime-fetch.js';

/** User-facing credential entry metadata. Secret text is never part of a returned state. */
export interface SearchCredentialRequest {
  id: string;
  connectionId: string;
  name: string;
  provider: string;
  endpoint?: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  message?: string;
}
export async function searchCredentialRequest(id: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', apiKey?: string, signal?: AbortSignal): Promise<SearchCredentialRequest> {
  const response = await runtimeFetch(`/api/harness/web-search/credential-requests/${encodeURIComponent(id)}`, {
    method, cache: 'no-store', ...(signal ? { signal } : {}),
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) } : {}),
  });
  if (!response.ok) throw new Error('Credential entry could not complete. Check the connection and start a new entry request.');
  return response.json() as Promise<SearchCredentialRequest>;
}
