import type { BrowserObservation, BrowserPage, BrowserPageUsage, BrowserResource, BrowserResourceBinding } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export type BrowserPageBinding = BrowserResourceBinding & { pageId: string };
export interface BrowserPageSnapshot { observation: BrowserObservation; usage: BrowserPageUsage }

export class BrowserResourceRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message); this.name = 'BrowserResourceRequestError';
  }
}
const segment = (value: string) => {
  if (!value.trim()) throw new Error('Browser resource identity is required');
  return encodeURIComponent(value);
};
const pagesPath = (binding: BrowserResourceBinding) => `/api/browser-resources/${segment(binding.browserId)}/${segment(binding.instanceId)}/pages`;
const pagePath = (binding: BrowserPageBinding) => `${pagesPath(binding)}/${segment(binding.pageId)}`;
async function request<T>(path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, { method, ...(signal ? { signal } : {}), headers: { accept: 'application/json' } });
  const result = await response.json();
  if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during browser request');
  if (!response.ok) throw new BrowserResourceRequestError(response.status,
    typeof result?.error === 'string' ? result.error : `Browser request failed (${response.status})`,
    typeof result?.code === 'string' ? result.code : undefined);
  return result as T;
}
/** Uses only the selected resource owner. No local-window or URL-opening fallback. */
export const browserResources = {
  async list(signal?: AbortSignal): Promise<BrowserResource[]> {
    return (await request<{ resources: BrowserResource[] }>('/api/browser-resources', 'GET', signal)).resources;
  },
  async pages(binding: BrowserResourceBinding, signal?: AbortSignal): Promise<BrowserPage[]> {
    return (await request<{ pages: BrowserPage[] }>(pagesPath(binding), 'GET', signal)).pages;
  },
  observe(binding: BrowserPageBinding, view: 'overview' | 'structure' | 'screenshot' = 'structure', signal?: AbortSignal): Promise<BrowserPageSnapshot> {
    return request(`${pagePath(binding)}?view=${view}`, 'GET', signal);
  },
  control(binding: BrowserPageBinding, action: 'takeover' | 'resume' | 'activate', signal?: AbortSignal): Promise<{ usage: BrowserPageUsage }> {
    // Do not retry a mutation whose receipt may have been lost.
    return request(`${pagePath(binding)}/${action}`, 'POST', signal);
  },
};
