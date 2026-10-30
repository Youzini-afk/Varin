import { describe, expect, it } from 'vitest';
import { CompanionVisualStabilizer, ORDINARY_VISUAL_SETTLE_MS } from './attentionPresentation';
const intent = (state: string | null) => ({ state, reason: 'current fact' });
describe('focused performance selection', () => {
  it('coalesces 50ms tool bursts to neutral, then presents only the latest still-current activity', () => {
    const view = new CompanionVisualStabilizer();
    expect(view.observe('A/run1', intent('T01'), 0).state).toBe('T01');
    for (let i = 1; i <= 20; i++) expect(view.observe('A/run1', intent(i % 2 ? 'T02' : 'T04'), i * 50).state).toBeNull();
    expect(view.observe('A/run1', intent('T04'), 1000 + ORDINARY_VISUAL_SETTLE_MS).state).toBe('T04');
    expect(view.remaining(2000)).toBeNull();
  });
  it('never holds an ended tool, permission, unknown, failure or completion behind cosmetic settling', () => {
    for (const urgent of ['W02', 'W03', 'E04', 'E01', 'E02', 'E06', 'C06', 'C01']) {
      const view = new CompanionVisualStabilizer();
      view.observe('A', intent('T01'), 0);
      view.observe('A', intent('T02'), 50);
      expect(view.observe('A', intent(urgent), 51).state).toBe(urgent);
      expect(view.remaining(51)).toBeNull();
    }
  });
  it('scope/new Run invalidates old candidates and repeated same-category updates do not restart the hold', () => {
    const view = new CompanionVisualStabilizer();
    view.observe('A/run1', intent('T01'), 0);
    view.observe('A/run1', intent('T02'), 50);
    expect(view.observe('B/run2', intent('E05'), 51).state).toBe('E05');
    expect(view.observe('B/run2', intent('T04'), 55).state).toBe('T04');
    view.observe('B/run2', intent('T02'), 60);
    view.observe('B/run2', intent('T02'), 100);
    expect(view.observe('B/run2', intent('T02'), 60 + ORDINARY_VISUAL_SETTLE_MS).state).toBe('T02');
  });
});
