import { describe, expect, it } from 'vitest';
import { memoryReadPrompt, textBoundary } from './memory-maintenance-material.js';

describe('memory maintenance read windows', () => {
  it('keeps complete JSON structured and partial passages literal with stable offsets', () => {
    const body = JSON.stringify({ memories: [{ id: 1, content: '中文 "quote" \\ path\n🧭' }], sources: [{ status: 'unavailable' }] });
    const complete = JSON.parse(memoryReadPrompt({ reason: 'Review' }, body, 0, body.length));
    expect(complete.readResult).toEqual(JSON.parse(body));
    expect(complete.nextOffset).toBeNull();
    const cut = body.indexOf('🧭');
    expect(textBoundary(body, cut)).toBe(true);
    expect(textBoundary(body, cut + 1)).toBe(false);
    expect(textBoundary(body, cut + 2)).toBe(true);
    const first = memoryReadPrompt({ reason: 'Review' }, body, 0, cut);
    const next = memoryReadPrompt({ reason: 'Review' }, body, cut, body.length - cut);
    expect(first.split('\n').slice(2).join('\n') + next.split('\n').slice(2).join('\n')).toBe(body);
    expect(JSON.parse(first.split('\n')[0]!).nextOffset).toBe(cut);
    expect(next).toContain('🧭');
    expect(next).not.toContain('\\\\');
  });
});
