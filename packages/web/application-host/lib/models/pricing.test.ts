import { expect, test } from 'vitest';
import { directoryPricing, validModelPricing } from './pricing.js';
import { ModelMetadataIndex } from './metadata-match.js';
import { ChannelTypes } from './channel-types.js';

test('directory prices preserve explicit zero, cache rates and every context tier', () => {
  const value = directoryPricing({ input: 1, output: 0, cache_read: 0.1, reasoning: 3, tiers: [
    { input: 2, tier: { type: 'context', size: 32000 } }, { input: 4, output: 8, tier: { type: 'context', size: 128000 } },
  ] });
  expect(value).toEqual({ inputPerMillion: 1, outputPerMillion: 0, cacheReadPerMillion: 0.1, reasoningPerMillion: 3,
    contextTiers: [{ aboveInputTokens: 32000, inputPerMillion: 2 }, { aboveInputTokens: 128000, inputPerMillion: 4, outputPerMillion: 8 }] });
  expect(validModelPricing(value)).toBe(true);
  expect(directoryPricing({ input: -1, output: 'unknown' })).toBeUndefined();
  expect(validModelPricing({ inputPerMillion: Number.POSITIVE_INFINITY })).toBe(false);
  expect(validModelPricing({ inputPerMillion: 0, contextTiers: [{ aboveInputTokens: 1 }, { aboveInputTokens: 1 }] })).toBe(false);
});
test('custom channels receive owner prices through decorated IDs while ambiguous model names stay unpriced', () => {
  const types = new ChannelTypes();
  const index = new ModelMetadataIndex({ openai: { npm: '@ai-sdk/openai', models: {
    'gpt-4.1': { modalities: { output: ['text'] }, cost: { input: 2, output: 8 } },
    'gpt-4.1-mini': { modalities: { output: ['text'] }, cost: { input: 0.4, output: 1.6 } },
  } } }, types);
  expect(index.lookup(types.get('openai-compatible')!, { id: '[CM]GPT-4.1-mini-fast' })?.pricing).toEqual({ inputPerMillion: 0.4, outputPerMillion: 1.6 });
  expect(index.lookup(types.get('openai-compatible')!, { id: 'unknown-model' })).toBeUndefined();
});
