import { runtimeFetch } from '@varin/application-client';

export async function hostConnectionRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await runtimeFetch(`/api/connections${path}`, {
    method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result ? String(result.error) : `Connection request failed (${response.status})`);
  return result as T;
}
