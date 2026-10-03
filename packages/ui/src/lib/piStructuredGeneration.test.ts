import { describe, expect, test } from 'vitest';
import { parseStructuredGenerationText } from './piStructuredGeneration';

describe('parseStructuredGenerationText', () => {
  test('parses a plain JSON object', () => {
    expect(parseStructuredGenerationText('{"subject":"feat: native Pi","highlights":[]}')).toEqual({
      subject: 'feat: native Pi',
      highlights: [],
    });
  });

  test('recovers a fenced or explained JSON object without accepting arrays', () => {
    expect(parseStructuredGenerationText('Result:\n```json\n{"title":"Review","body":"Ready"}\n```')).toEqual({
      title: 'Review',
      body: 'Ready',
    });
    expect(() => parseStructuredGenerationText('[1,2,3]')).toThrow('JSON object');
  });
});
