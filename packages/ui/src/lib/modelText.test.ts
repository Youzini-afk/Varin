import { describe, expect, test } from 'vitest';
import { parseStructuredGenerationText } from './modelText';

describe('parseStructuredGenerationText', () => {
  test('parses a plain JSON object', () => {
    expect(parseStructuredGenerationText('{"subject":"feat: native runtime","highlights":[]}')).toEqual({
      subject: 'feat: native runtime',
      highlights: [],
    });
  });

  test('parses a fenced JSON object without accepting arrays', () => {
    expect(parseStructuredGenerationText('```json\n{"title":"Review","body":"Ready"}\n```')).toEqual({
      title: 'Review',
      body: 'Ready',
    });
    expect(() => parseStructuredGenerationText('[1,2,3]')).toThrow('JSON object');
  });
});
