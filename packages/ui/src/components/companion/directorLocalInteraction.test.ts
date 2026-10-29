import { describe, expect, it } from 'vitest';
import { directorLocalResponse } from './directorLocalInteraction';
const base = { event: 'tap' as const, current: true, visible: true, interacting: false, blockedUI: false, finiteHandover: false, closed: false };
describe('director local attention', () => {
  it('allows gentle attention without treating pending requests as approval', () => {
    expect(directorLocalResponse(base)).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, closed: true })).toBe('tap-response');
    expect(directorLocalResponse({ ...base, event: 'hover' })).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, event: 'hover', closed: true })).toBe('hover-response');
  });
  it('does not interrupt or queue a finite handover, hidden/dragging, or unknown state', () => {
    for (const override of [{ finiteHandover: true }, { visible: false }, { interacting: true }, { current: false }, { blockedUI: true }]) {
      expect(directorLocalResponse({ ...base, ...override })).toBeNull();
    }
  });
});
