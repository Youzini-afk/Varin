import { describe, expect, test } from 'bun:test';
import {
  armPiTimelineTurn,
  cancelPiTimelineAutomation,
  clearPiTimelineSubmissionAnchor,
  completePiTimelineReturn,
  getPiAnchoredTurnCorrection,
  getPiTimelineFollowOffset,
  isPiTimelineAtEnd,
  isPiTimelineEntryCurrent,
  preparePiTimelineEntry,
  remapPiTimelineAnchor,
  requestPiTimelineReturn,
  savePiTimelineCheckpoint,
  shouldReleasePiTimelineFollow,
} from './piTimelineScrollState';

describe('Pi timeline scroll state', () => {
  test('arms, remaps, and clears a session turn anchor', () => {
    const armed = armPiTimelineTurn(undefined, 'submission-1', 'turn:live-user:1');
    expect(armed.scrollMode).toBe('anchoring-new-turn');
    expect(armed.newTurn?.turnId).toBe('turn:live-user:1');

    const remapped = remapPiTimelineAnchor(armed, 'turn:user-entry');
    expect(remapped?.newTurn?.turnId).toBe('turn:user-entry');
    expect(clearPiTimelineSubmissionAnchor(remapped, 'submission-1').scrollMode).toBe('following-end');
  });

  test('never restores an anchor mode without an anchor', () => {
    const first = armPiTimelineTurn(undefined, 'submission-1', 'turn:live-user:1');
    const second = armPiTimelineTurn(first, 'submission-2', 'turn:live-user:2');
    const cleared = clearPiTimelineSubmissionAnchor(second, 'submission-2');
    expect(cleared.scrollMode).toBe('following-end');
    expect(cleared.newTurn).toBeUndefined();
  });

  test('restores only an unchanged idle session with a saved viewport', () => {
    const saved = savePiTimelineCheckpoint(
      preparePiTimelineEntry(undefined, {
        hasAttention: false,
        hasLiveOverlay: false,
        leafId: 'leaf-1',
        working: false,
      }),
      1,
      'leaf-1',
      { itemId: 'turn:user-1', mode: 'free-scrolling', offset: -12 },
    );
    const restored = preparePiTimelineEntry(saved, {
      hasAttention: false,
      hasLiveOverlay: false,
      leafId: 'leaf-1',
      working: false,
    });
    expect(restored.entry.target).toEqual({ itemId: 'turn:user-1', kind: 'turn', offset: -12 });
    expect(restored.scrollMode).toBe('free-scrolling');

    const updated = preparePiTimelineEntry(saved, {
      hasAttention: false,
      hasLiveOverlay: false,
      leafId: 'leaf-2',
      working: false,
    });
    expect(updated.entry.target).toEqual({ kind: 'end' });
    expect(updated.scrollMode).toBe('following-end');
  });

  test('a user gesture invalidates an in-flight return-to-latest completion', () => {
    const free = cancelPiTimelineAutomation(undefined);
    expect(isPiTimelineEntryCurrent(free)).toBe(false);
    const requested = requestPiTimelineReturn(free);
    const cancelled = cancelPiTimelineAutomation(requested.view);
    expect(completePiTimelineReturn(cancelled, requested.token)).toBe(cancelled);

    const completed = completePiTimelineReturn(requested.view, requested.token);
    expect(completed?.scrollMode).toBe('following-end');
    expect(completed?.pendingReturnToken).toBeUndefined();
  });

  test('uses a device-pixel epsilon only at the live edge', () => {
    expect(isPiTimelineAtEnd(1000, 398, 600)).toBe(true);
    expect(isPiTimelineAtEnd(1000, 397, 600)).toBe(false);
  });

  test('follows content after it fills the manually revealed end space', () => {
    // 1500px of content + 300px spacer in a 600px viewport. The user
    // scrolls to the physical bottom, leaving all 300px visible below the text.
    expect(getPiTimelineFollowOffset(1800, 1200, 600, 300)).toBe(1200);
    expect(getPiTimelineFollowOffset(2000, 1200, 600, 300)).toBe(1200);
    expect(getPiTimelineFollowOffset(2100, 1200, 600, 300)).toBe(1200);
    expect(getPiTimelineFollowOffset(2150, 1200, 600, 300)).toBe(1250);
    expect(getPiTimelineFollowOffset(2250, 1250, 600, 300)).toBe(1350);
  });

  test('treats the content edge and extra end space as the same following zone', () => {
    expect(isPiTimelineAtEnd(1800, 900, 600, 300)).toBe(true);
    expect(isPiTimelineAtEnd(1800, 1200, 600, 300)).toBe(true);
    expect(isPiTimelineAtEnd(1800, 897, 600, 300)).toBe(false);
    expect(getPiTimelineFollowOffset(500, 0, 600, 300)).toBe(0);
    // A taller viewport or a collapsed block may open space; do not yank
    // the current text down just to realign its end.
    expect(getPiTimelineFollowOffset(1800, 1200, 800, 300)).toBe(1200);
  });

  test('keeps auto-follow ownership for no-op gestures toward the live edge', () => {
    expect(shouldReleasePiTimelineFollow('following-end', true, 'toward-end')).toBe(false);
    expect(shouldReleasePiTimelineFollow('following-end', true, 'away-from-end')).toBe(true);
    expect(shouldReleasePiTimelineFollow('following-end', false, 'toward-end')).toBe(true);
    expect(shouldReleasePiTimelineFollow('anchoring-new-turn', true, 'toward-end')).toBe(true);
    expect(shouldReleasePiTimelineFollow('free-scrolling', true, 'toward-end')).toBe(true);
  });

  test('reveals only the overflowing part of an anchored turn', () => {
    const correction = getPiAnchoredTurnCorrection({
      data: [{}, {}],
      positionAtIndex: (index) => index === 0 ? 100 : 680,
      scroll: 84,
      scrollLength: 600,
      sizeAtIndex: (index) => index === 0 ? 200 : 120,
    }, 0);
    expect(correction).toEqual({
      delta: 132,
      targetScroll: 216,
      turnHeight: 700,
      usableViewportHeight: 584,
    });
  });

  test('does not move while the anchored turn fits', () => {
    const correction = getPiAnchoredTurnCorrection({
      data: [{}],
      positionAtIndex: () => 100,
      scroll: 84,
      scrollLength: 600,
      sizeAtIndex: () => 300,
    }, 0);
    expect(correction?.delta).toBe(0);
  });
});
