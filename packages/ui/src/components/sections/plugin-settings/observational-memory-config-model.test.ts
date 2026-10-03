import { describe, expect, test } from 'vitest';
import { observationalMemoryDraftIssue } from './observational-memory-config-model';

describe('observational memory config model', () => {
  test('accepts absent fields and a complete configured worker model', () => {
    expect(observationalMemoryDraftIssue({})).toBeNull();
    expect(observationalMemoryDraftIssue({
      futureOption: true,
      model: { id: 'gpt-5.6', provider: 'openai-codex', thinking: 'high' },
    })).toBeNull();
  });

  test('validates positive integers, ratios, and pool relationships', () => {
    expect(observationalMemoryDraftIssue({ observeAfterTokens: 1.5 })).toEqual({
      code: 'invalid-number',
      field: 'observeAfterTokens',
    });
    expect(observationalMemoryDraftIssue({ compactAfterTokensRatio: 1 })).toEqual({
      code: 'invalid-number',
      field: 'compactAfterTokensRatio',
    });
    expect(observationalMemoryDraftIssue({
      observationsPoolMaxTokens: 10000,
      observationsPoolTargetTokens: 10000,
    })).toEqual({
      code: 'invalid-value',
      field: 'observationsPoolTargetTokens',
    });
  });

  test('does not allow a partial or malformed worker model', () => {
    expect(observationalMemoryDraftIssue({ model: { provider: 'openai-codex' } })).toEqual({
      code: 'required',
      field: 'model.id',
    });
    expect(observationalMemoryDraftIssue({
      model: { id: 'gpt-5.6', provider: 'openai-codex', thinking: 'turbo' },
    })).toEqual({
      code: 'invalid-value',
      field: 'model.thinking',
    });
  });
});
