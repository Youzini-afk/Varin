import type { BrowserConnection, BrowserManagementSnapshot, BrowserObservation, BrowserPage, BrowserPageUsage, BrowserResource, BrowserResourceBinding, BrowserSettingsDevice, BrowserSettingsSnapshot, BrowserTaskSelection } from '@varin/protocol';
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
async function request<T>(path: string, method = 'GET', signal?: AbortSignal, body?: unknown): Promise<T> {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, { method, ...(signal ? { signal } : {}), headers: { accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during browser request');
  if (!response.ok) throw new BrowserResourceRequestError(response.status,
    typeof result?.error === 'string' ? result.error : `Browser request failed (${response.status})`,
    typeof result?.code === 'string' ? result.code : undefined);
  return result as T;
}
/** Uses only the selected resource owner. No local-window or URL-opening fallback. */
export const browserResources = {
  async devices(signal?: AbortSignal): Promise<BrowserSettingsDevice[]> {
    return (await request<{ devices: BrowserSettingsDevice[] }>('/api/browser-resources/devices', 'GET', signal)).devices;
  },
  configuration(device = 'local', signal?: AbortSignal): Promise<BrowserManagementSnapshot> {
    return request(`/api/browser-resources/configuration?device=${segment(device)}`, 'GET', signal);
  },
  saveConfiguration(settings: BrowserSettingsSnapshot, device = 'local'): Promise<BrowserManagementSnapshot> {
    return request(`/api/browser-resources/configuration?device=${segment(device)}`, 'PUT', undefined, settings);
  },
  probe(connection: BrowserConnection, device = 'local'): Promise<{ pages: number }> {
    return request(`/api/browser-resources/probe?device=${segment(device)}`, 'POST', undefined, connection);
  },
  task(threadId: string, signal?: AbortSignal): Promise<BrowserTaskSelection> {
    return request(`/api/browser-resources/tasks/${segment(threadId)}`, 'GET', signal);
  },
  selectTask(threadId: string, browserId: string | null): Promise<BrowserTaskSelection> {
    return request(`/api/browser-resources/tasks/${segment(threadId)}`, 'PUT', undefined, { browserId });
  },
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
