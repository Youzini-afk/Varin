import React from 'react';
import type { SessionSummary } from '@varin/protocol';

import { comparePiSessions } from '@/components/pi-session/sessionPresentation';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { selectActivePiSessions, usePiSessionStore } from '@/stores/usePiSessionStore';
import { regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

/**
 * Native-feeling edge swipe to switch sessions in the mobile chat: start a horizontal swipe
 * from the very left/right edge and drag toward the centre to step through sessions.
 *
 * - Left edge → centre  = previous session (the more-recent one in the list)
 * - Right edge → centre = next session (the older one)
 *
 * Navigation walks the same ranked list the rest of the mobile UI uses: top-level sessions
 * (no subtasks) across all projects, lifecycle-ranked with timestamp fallback. The order is computed at
 * gesture time from the store (not subscribed) so it's always fresh and never re-attaches.
 *
 * Only `touchstart`/`touchend` are observed (both passive), so this never interferes with
 * vertical chat scrolling or the horizontal scroll inside code blocks — it just reads where the
 * gesture began and ended. The edge zone keeps it clear of in-content horizontal scroll, which
 * lives away from the screen edges.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
const ANDROID_EDGE_ZONE = 80; // stay outside Android's system Back gesture strip
const MIN_DISTANCE = 64; // px of horizontal travel required to commit a switch
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)

/** Top-level sessions across all projects in shared display order. */
const orderedTopLevelSessions = (): SessionSummary[] => {
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;
  const sessionState = usePiSessionStore.getState();
  return regularPiSessions(selectActivePiSessions(sessionState), useBotSessionIndex.getState(), sessionState.runtimeKey)
    .filter((session) => session.parentId === undefined)
    .slice()
    .sort((left, right) => comparePiSessions(
      left,
      right,
      (session) => isSessionPinned(pinnedSessionIds, session.cwd, session.id),
    ));
};

/**
 * Switch to the session `step` positions away from the current one (clamped — no wrap).
 * Returns true if a switch actually happened.
 */
const switchByStep = async (step: number): Promise<boolean> => {
  const ordered = orderedTopLevelSessions();
  if (ordered.length < 2) return false;

  const currentId = usePiSessionStore.getState().currentSessionId;
  const index = ordered.findIndex((session) => session.id === currentId);
  if (index < 0) return false;

  const targetIndex = index + step;
  if (targetIndex < 0 || targetIndex >= ordered.length) return false;

  const target = ordered[targetIndex];
  await openPiSessionFromNavigation({ directory: target.cwd, sessionId: target.id });
  return true;
};

export interface EdgeSwipeSessionSwitchOptions {
  /** Called after a successful switch, with the travel direction, so the caller can animate. */
  onSwitch?: (direction: 'prev' | 'next') => void;
}

export const useEdgeSwipeSessionSwitch = (
  ref: React.RefObject<HTMLElement | null>,
  options?: EdgeSwipeSessionSwitchOptions,
): void => {
  // Keep onSwitch in a ref so a changing callback identity doesn't re-attach the listeners.
  const onSwitchRef = React.useRef(options?.onSwitch);
  onSwitchRef.current = options?.onSwitch;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;

    let tracking = false;
    let fromLeftEdge = false;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      tracking = nearLeft || nearRight;
      fromLeftEdge = nearLeft;
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < MIN_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS_RATIO) return;
      // Must travel toward the centre: left edge → rightward, right edge → leftward.
      if (fromLeftEdge && dx <= 0) return;
      if (!fromLeftEdge && dx >= 0) return;

      const step = fromLeftEdge ? -1 : 1;
      void switchByStep(step).then((switched) => {
        if (switched) onSwitchRef.current?.(step < 0 ? 'prev' : 'next');
      }).catch(() => undefined);
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref]);
};
