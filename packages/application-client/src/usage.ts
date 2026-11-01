import type { UsageDay, UsageSummary } from '@varin/protocol';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export interface UsageQuery { fromMs: number; toMs: number; utcOffsetMinutes: number; days: UsageDay[] }
/** This transport is pinned to the Host selected when the page opens. */
export function createUsageHttpAPI(generation = getRuntimeEndpointGeneration()) {
  return {
    async summary(query: UsageQuery, signal?: AbortSignal): Promise<UsageSummary> {
      const current = () => { signal?.throwIfAborted(); if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed'); };
      current();
      const response = await runtimeFetch('/api/usage/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), ...(signal ? { signal } : {}) });
      current();
      const body = await response.json(); current();
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Usage could not be read');
      return body as UsageSummary;
    },
  };
}
