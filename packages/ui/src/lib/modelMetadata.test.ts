import { describe, expect, test } from 'vitest';

import { mergeModelMetadataWithLiveModel } from './modelMetadata';

describe('mergeModelMetadataWithLiveModel', () => {
  test('normalizes live model context and output limit aliases', () => {
    expect(mergeModelMetadataWithLiveModel('custom', {
      id: 'alias-model',
      name: 'Alias Model',
      contextWindow: '256,000',
      max_output_tokens: '16,384',
    })).toEqual({
      id: 'alias-model',
      providerId: 'custom',
      name: 'Alias Model',
      limit: {
        context: 256000,
        output: 16384,
      },
    });
  });

  test('normalizes nested live model limit aliases over cached metadata', () => {
    expect(mergeModelMetadataWithLiveModel('custom', {
      id: 'nested-model',
      limit: {
        input_token_limit: 128000,
      },
    }, {
      id: 'nested-model',
      providerId: 'custom',
      limit: {
        output: 4096,
      },
    })).toEqual({
      id: 'nested-model',
      providerId: 'custom',
      limit: {
        context: 128000,
        output: 4096,
      },
    });
  });
});
