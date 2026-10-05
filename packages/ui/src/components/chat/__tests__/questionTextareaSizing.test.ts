import { describe, expect, test } from 'vitest';
import { getQuestionCustomTextareaHeight } from '../questionTextareaSizing';

describe('getQuestionCustomTextareaHeight', () => {
  test('returns null when the textarea is already at the target height', () => {
    expect(getQuestionCustomTextareaHeight({ scrollHeight: 60, currentHeight: 60 })).toBeNull();
  });
});
