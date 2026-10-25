import React from 'react';
import { navigableThreadCount, switchRelativeThread } from '@/lib/agent-runtime/threadNavigation';
import { tapHaptic } from '@/lib/motion/haptics';
import { documentMotionLevel } from '@/lib/motion/preference';
import { EASE_OUT, springTiming, TWEENS } from '@/lib/motion/tokens';
import { useThreadStore } from '@/stores/useThreadStore';
import {
  SWIPE_DECIDE_PX,
  SWIPE_MAX_OFF_AXIS_RATIO,
  shouldCommitSwipe,
  swipeOffset,
  swipeOpacity,
  swipeVelocity,
  type SwipeSample,
} from './edgeSwipe';

/**
 * Edge swipe to switch sessions in the mobile chat (docs/design/motion-and-interaction.md §3.14).
 * Start at the very left or right edge and drag toward the centre:
 *
 * - Left edge → centre  = previous session (the more-recent one in the list)
 * - Right edge → centre = next session (the older one)
 *
 * The `surface` follows the finger (edgeSwipe.ts). Released fast enough or far enough, it leaves the
 * way it was thrown, a light haptic marks the commit and the session switches; otherwise it springs
 * home on glide. Reduced and off motion keep the switch and drop the following.
 *
 * Navigation walks the same ranked list the rest of the mobile UI uses: top-level sessions
 * (no subtasks) across all projects, lifecycle-ranked with timestamp fallback. The order is computed at
 * gesture time from the store (not subscribed) so it's always fresh and never re-attaches.
 *
 * Every listener is passive, so vertical chat scrolling and the horizontal scroll inside code blocks
 * are never held up. A gesture that starts vertical is let go at once, and the edge zone keeps it clear
 * of in-content horizontal scroll, which lives away from the screen edges.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
const ANDROID_EDGE_ZONE = 80; // stay outside Android's system Back gesture strip
const SAMPLES_KEPT = 12;

const switchByStep = async (step: number): Promise<boolean> => {
  const before = useThreadStore.getState().selectedIdentity;
  await switchRelativeThread(step);
  const after = useThreadStore.getState().selectedIdentity;
  return before?.threadId !== after?.threadId || before?.branchId !== after?.branchId;
};

export type EdgeSwipeDirection = 'prev' | 'next';

export interface EdgeSwipeSessionSwitchOptions {
  /** The content that follows the finger and leaves toward the side it was thrown. */
  surface?: React.RefObject<HTMLElement | null>;
  /**
   * Called as a swipe commits, before the switch starts, so the caller can bring the next session in
   * from the side the finger came from once it renders.
   */
  onCommit?: (direction: EdgeSwipeDirection) => void;
  /** Called when a committed swipe could not switch; the content has been brought back. */
  onAbort?: () => void;
}

interface Gesture {
  dragging: boolean;
  toward: 1 | -1;
  startX: number;
  startY: number;
  width: number;
  canSwitch: boolean;
  offset: number;
  samples: SwipeSample[];
}

const place = (node: HTMLElement, offset: number, width: number): void => {
  node.style.transform = offset ? `translateX(${offset}px)` : '';
  node.style.opacity = offset ? String(swipeOpacity(offset, width)) : '';
};

export const useEdgeSwipeSessionSwitch = (
  ref: React.RefObject<HTMLElement | null>,
  options?: EdgeSwipeSessionSwitchOptions,
): void => {
  // Kept in refs so changing callback identities don't re-attach the listeners.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;

    let gesture: Gesture | null = null;
    let settling: Animation | null = null;

    const surface = (): HTMLElement | null => {
      const node = optionsRef.current?.surface?.current ?? null;
      return node && typeof node.animate === 'function' ? node : null;
    };
    const follows = (): boolean => documentMotionLevel() === 'full';

    /** Hand the surface from inline styles to an animation in one task, so no frame shows neither. */
    const settle = (node: HTMLElement, keyframes: Keyframe[], timing: KeyframeAnimationOptions): Animation => {
      settling?.cancel();
      const animation = node.animate(keyframes, timing);
      place(node, 0, 0);
      settling = animation;
      return animation;
    };

    const springHome = (node: HTMLElement | null, from: { offset: number; opacity: number }): void => {
      if (!node || !from.offset) {
        if (node) place(node, 0, 0);
        return;
      }
      settle(node, [
        { transform: `translateX(${from.offset}px)`, opacity: from.opacity },
        { transform: 'none', opacity: 1 },
      ], springTiming('glide'));
    };

    /** A drag given up midway (a second finger) must not leave the content where it was. */
    const abandon = (): void => {
      const current = gesture;
      gesture = null;
      if (current?.dragging) springHome(surface(), { offset: current.offset, opacity: swipeOpacity(current.offset, current.width) });
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        abandon();
        return;
      }
      if (gesture?.dragging) abandon();
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      if (!nearLeft && !nearRight) {
        gesture = null;
        return;
      }
      gesture = {
        dragging: false,
        toward: nearLeft ? 1 : -1,
        startX: touch.clientX,
        startY: touch.clientY,
        width,
        canSwitch: navigableThreadCount() > 1,
        offset: 0,
        samples: [{ t: event.timeStamp, x: touch.clientX }],
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) {
        abandon();
        return;
      }
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      gesture.samples.push({ t: event.timeStamp, x: touch.clientX });
      if (gesture.samples.length > SAMPLES_KEPT) gesture.samples.shift();
      if (!gesture.dragging) {
        if (Math.abs(dx) < SWIPE_DECIDE_PX && Math.abs(dy) < SWIPE_DECIDE_PX) return;
        // Vertical first, or away from the centre: this is not a session swipe.
        if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_OFF_AXIS_RATIO || dx * gesture.toward <= 0) {
          gesture = null;
          return;
        }
        gesture.dragging = true;
        settling?.cancel();
        settling = null;
      }
      const node = surface();
      if (!node || !follows()) return;
      gesture.offset = swipeOffset(dx, gesture.width, gesture.toward, gesture.canSwitch);
      place(node, gesture.offset, gesture.width);
    };

    const release = (event: TouchEvent, cancelled: boolean) => {
      const current = gesture;
      gesture = null;
      if (!current?.dragging) return;
      const node = surface();
      const touch = event.changedTouches[0];
      if (touch) current.samples.push({ t: event.timeStamp, x: touch.clientX });
      const dx = (touch?.clientX ?? current.samples.at(-1)!.x) - current.startX;
      const velocity = swipeVelocity(current.samples);
      const from = { offset: current.offset, opacity: swipeOpacity(current.offset, current.width) };
      const commit = !cancelled && shouldCommitSwipe({ dx, velocity, width: current.width, toward: current.toward, canSwitch: current.canSwitch });
      if (!commit) {
        springHome(node, from);
        return;
      }
      const direction: EdgeSwipeDirection = current.toward > 0 ? 'prev' : 'next';
      tapHaptic();
      let left: Promise<unknown> = Promise.resolve();
      let leaving: Animation | null = null;
      if (node && follows()) {
        // Carry on the way it was thrown: faster throws leave sooner.
        const target = current.toward * current.width * 0.6;
        const remaining = Math.abs(target - from.offset);
        const duration = Math.min(220, Math.max(120, remaining / Math.max(Math.abs(velocity), 1.2)));
        leaving = settle(node, [
          { transform: `translateX(${from.offset}px)`, opacity: from.opacity },
          { transform: `translateX(${target}px)`, opacity: 0 },
        ], { duration, easing: `cubic-bezier(${EASE_OUT.join(', ')})`, fill: 'forwards' });
        // The same element shows the next session, so it switches only once the old one has gone;
        // otherwise the new content would be the one seen leaving. A timer covers a hidden page,
        // where animations may not finish.
        left = Promise.race([
          leaving.finished.catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, duration + 80)),
        ]);
      }
      const away = { offset: current.toward * current.width * 0.6, opacity: 0 };
      const abort = (): void => {
        optionsRef.current?.onAbort?.();
        // Only content that left has to come back.
        if (leaving) springHome(node, away);
      };
      optionsRef.current?.onCommit?.(direction);
      void left.then(() => switchByStep(current.toward > 0 ? -1 : 1)).then((switched) => {
        if (!switched) {
          abort();
          return;
        }
        // The caller brings the next session in and drops this animation as it does. If it never
        // does (the switch did not change what this surface shows), the content must not stay away.
        setTimeout(() => {
          if (leaving && settling === leaving && leaving.playState !== 'idle') springHome(node, away);
        }, 600);
      }, abort);
    };
    const onTouchEnd = (event: TouchEvent) => release(event, false);
    const onTouchCancel = (event: TouchEvent) => release(event, true);

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
      settling?.cancel();
      const node = optionsRef.current?.surface?.current;
      if (node) place(node, 0, 0);
    };
  }, [ref]);
};

/**
 * The mobile chat's whole swipe: `surface` follows the finger inside `main`, and when `sessionKey`
 * changes because of a committed swipe, the next session comes in from the side the finger started
 * on, on glide (a 160ms fade under reduced motion; at once when off).
 *
 * The direction is recorded as the swipe commits and the entrance runs in a layout effect, once the
 * new session's content has committed; running it inline in the swipe callback raced the re-render
 * and dropped the animation on roughly every other switch.
 */
export const useEdgeSwipeSessionChat = (
  main: React.RefObject<HTMLElement | null>,
  surface: React.RefObject<HTMLElement | null>,
  sessionKey: string | null | undefined,
): void => {
  const direction = React.useRef<EdgeSwipeDirection | null>(null);
  const options = React.useMemo<EdgeSwipeSessionSwitchOptions>(() => ({
    surface,
    onCommit: (next) => { direction.current = next; },
    onAbort: () => { direction.current = null; },
  }), [surface]);
  useEdgeSwipeSessionSwitch(main, options);

  React.useLayoutEffect(() => {
    const from = direction.current;
    direction.current = null;
    if (!from) return; // only swipe-driven switches arrive from a side
    const element = surface.current;
    if (!element || typeof element.animate !== 'function') return;
    // Drops the leaving content's animation too.
    element.getAnimations().forEach((animation) => animation.cancel());
    const level = documentMotionLevel();
    if (level === 'off') return;
    const fromX = level === 'full' ? (from === 'prev' ? -1 : 1) * Math.min(96, element.clientWidth * 0.25) : 0;
    element.animate(
      [
        { opacity: 0, transform: fromX ? `translateX(${fromX}px)` : 'none' },
        { opacity: 1, transform: 'none' },
      ],
      level === 'full'
        ? springTiming('glide')
        : { duration: TWEENS.fade.duration * 1000, easing: `cubic-bezier(${EASE_OUT.join(', ')})` },
    );
  }, [sessionKey, surface]);
};
