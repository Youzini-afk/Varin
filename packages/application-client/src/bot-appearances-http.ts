import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
import { parseBotAppearanceAsset, type BotAppearancesAPI } from './bot-appearance.js';

export function createBotAppearancesHttpAPI(): BotAppearancesAPI {
  const base = '/api/harness/bot-appearances';
  const request = async (path: string, init?: RequestInit, binary = false) => {
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(`${base}${path}`, init);
    const body = binary && response.ok ? await response.blob() : await response.json();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed. Reopen the appearance library.');
    if (!response.ok) throw new Error(body?.error || `Appearance request failed (${response.status})`);
    return body;
  };
  return {
    list: async signal => { const result = await request('', { signal: signal ?? null }); if (!Array.isArray(result.assets)) throw new Error('Invalid appearance library'); return result.assets.map(parseBotAppearanceAsset); },
    get: async (id, signal) => parseBotAppearanceAsset((await request(`/${encodeURIComponent(id)}`, { signal: signal ?? null })).asset),
    import: async (file, signal) => { const body = new FormData(); body.append('file', file); return parseBotAppearanceAsset((await request('', { method: 'POST', body, signal: signal ?? null })).asset); },
    remove: async id => { await request(`/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    media: (id, hash, signal) => request(`/${encodeURIComponent(id)}/media/${encodeURIComponent(hash)}`, { signal: signal ?? null }, true),
  };
}
