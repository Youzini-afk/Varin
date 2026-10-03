import { describe, expect, test } from 'vitest';

import {
  REASONING_VARIANT_KEYS,
  getModelVariantKeys,
  modelSupportsVariant,
} from './modelVariants';

describe('model variant helpers', () => {
  test('keeps configured variants and expands reasoning-capable models to every thinking effort', () => {
    const model = {
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
      capabilities: {
        reasoning: true,
      },
    };

    expect(getModelVariantKeys(model)).toEqual(REASONING_VARIANT_KEYS);
    expect(modelSupportsVariant(model, 'xhigh')).toBe(true);
    expect(modelSupportsVariant(model, 'max')).toBe(true);
  });

  test('reads a configured reasoning effort even when OpenCode did not expose variants', () => {
    const model = {
      reasoning: true,
      options: {
        reasoningEffort: 'xhigh',
      },
    };

    expect(getModelVariantKeys(model)).toEqual(REASONING_VARIANT_KEYS);
    expect(modelSupportsVariant(model, 'xhigh')).toBe(true);
  });

  test('does not invent thinking variants for non-reasoning models', () => {
    expect(getModelVariantKeys({ variants: { fast: {} } })).toEqual(['fast']);
    expect(getModelVariantKeys({})).toEqual([]);
  });
});
