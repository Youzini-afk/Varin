import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export interface EmbeddingRequestConfiguration { concurrentRequests: number; requestIntervalMs: number }
export interface EmbeddingRequestSettings {
  config: EmbeddingRequestConfiguration;
  activeConfig: EmbeddingRequestConfiguration;
  revision: string;
  restartRequired: boolean;
  error?: string;
}

const isConfiguration = (value: unknown): value is EmbeddingRequestConfiguration => {
  if (!value || typeof value !== 'object') return false;
  const config = value as EmbeddingRequestConfiguration;
  return Number.isSafeInteger(config.concurrentRequests) && config.concurrentRequests > 0
    && Number.isSafeInteger(config.requestIntervalMs) && config.requestIntervalMs >= 0 && config.requestIntervalMs <= 2_147_483_647;
};

/** A settings revision belongs to the Host on which it was read. */
export function createEmbeddingRequestsHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const request = async (config?: EmbeddingRequestConfiguration, revision?: string, signal?: AbortSignal): Promise<EmbeddingRequestSettings> => {
    const check = () => {
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed; reload embedding request settings');
    };
    check();
    const response = await runtimeFetch('/api/harness/embedding-requests', { ...(config ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, revision }) } : { cache: 'no-store' }), ...(signal ? { signal } : {}) });
    check();
    const body = await response.json();
    check();
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Embedding request settings failed (${response.status})`);
    if (!body || !isConfiguration(body.config) || !isConfiguration(body.activeConfig) || typeof body.revision !== 'string'
      || typeof body.restartRequired !== 'boolean' || (body.error !== undefined && typeof body.error !== 'string')) {
      throw new Error('Invalid embedding request settings response');
    }
    return body as EmbeddingRequestSettings;
  };
  return { read: (signal?: AbortSignal) => request(undefined, undefined, signal), save: (config: EmbeddingRequestConfiguration, revision: string) => request(config, revision) };
}
