/** Original model catalog/configuration/credential owner with a fixture-only registered transport.
 * No external provider is contacted; the Rust fixture replaces only that adapter's HTTP stream. */
import { createModelAuthority } from './model-authority.js';
import type { ThreadModelAuthority } from './thread-adapter.js';

export const samplingModel = { providerId: 'sampling-fixture', modelId: 'reviewed-model' };
export function createSamplingModelAuthority(): ThreadModelAuthority {
  const selected = { ...samplingModel, name: 'Reviewed fixture model', api: 'openai-responses',
    baseUrl: 'https://sampling-model.invalid/v1', maxTokens: 500, input: ['text', 'image'], contextWindow: 8192 };
  const authority = createModelAuthority({
    async selectedModel(providerId, modelId) {
      if (providerId !== selected.providerId || modelId !== selected.modelId) throw new Error('Selected model is unavailable');
      return selected;
    },
    async listModels() { return [selected]; },
    async getAuth() { return { auth: { apiKey: 'fixture-only-sampling-credential' } }; },
    async currentScope() { return { reference: 'fixture:sampling', authority: 'fixture', account: 'reviewer', generation: 1 }; },
    async currentProviderAccount() { return 'reviewer'; },
    async routingEnvironment() { return {}; },
  });
  return {
    listModels: () => authority.listModels(),
    async resolveModel(selection) {
      const resolved = await authority.resolveModel(selection);
      return { ...resolved, configuration: { ...resolved.configuration, adapterId: 'openai-responses', adapterVersion: '1' } };
    },
    rebindModel: (configuration, scope) => authority.rebindModel(configuration, scope),
  };
}
