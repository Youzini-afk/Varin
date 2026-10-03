import { describe, expect, test } from 'vitest';
import { openAICodexCompatDraftIssue } from './openai-codex-compat-config-model';

describe('OpenAI Codex compatibility config model', () => {
  test('accepts absent fields, null compaction threshold, and unknown plugin fields', () => {
    expect(openAICodexCompatDraftIssue({})).toBeNull();
    expect(openAICodexCompatDraftIssue({
      autoCompactAtPercent: null,
      futureOption: { retained: true },
    })).toBeNull();
  });

  test('validates explicitly configured booleans, enum values, and threshold range', () => {
    expect(openAICodexCompatDraftIssue({ fastMode: 'true' })).toEqual({
      code: 'invalid-boolean',
      field: 'fastMode',
    });
    expect(openAICodexCompatDraftIssue({ reasoningMode: 'turbo' })).toEqual({
      code: 'invalid-value',
      field: 'reasoningMode',
    });
    expect(openAICodexCompatDraftIssue({ autoCompactAtPercent: 101 })).toEqual({
      code: 'invalid-number',
      field: 'autoCompactAtPercent',
    });
    expect(openAICodexCompatDraftIssue({ applyPatchDebug: true, autoCompactAtPercent: 80 })).toBeNull();
  });
});
